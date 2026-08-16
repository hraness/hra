import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runInteractionRequestSchema,
  type RunInteractionRequest,
  type RunInteractionRequestPayload,
} from "@hraness/agent-tasks-protocol";

import {
  createCodexFactsAtPosition,
  pinnedCodexRequests,
  type CodexNotification,
  type PinnedCodexHistoryThreadItem,
  type PinnedCodexRequestInput,
  type PinnedCodexRequestKey,
  type PinnedCodexRequestOutput,
  type PinnedCodexThreadItem,
} from "../src/codex";
import { projectCodexNotificationFacts } from "../src/codex/fact-projector";
import { parseCodexNotification } from "../src/codex/pinned-codecs";
import type { GatewaySessionEvent, ThreadSummary } from "../src/internal-contracts";
import { ownedCodexId } from "../src/sessions/identity";
import {
  MAX_SESSION_ACTIVE_TOOL_ITEMS_PER_TURN,
  MAX_SESSION_TRACKED_TOOL_TURNS_PER_ACCOUNT,
  SessionService,
  type SessionAccountRuntimePort,
  type SessionHydrationFailure,
  type SessionInteractionDeadline,
  type SessionInteractionRequest,
  type SessionReasoningItemCompletion,
  type SessionToolItemStarted,
  type SessionTurnActivity,
  type SessionTurnLifecycle,
} from "../src/sessions/session-service";

type SessionEvent = GatewaySessionEvent;

function consumeNotification(
  service: SessionService,
  accountProfileId: string,
  notification: CodexNotification,
): boolean {
  return service.consumeCodexFacts(
    projectCodexNotificationFacts(accountProfileId, {
      ...notification,
      streamPosition: notification.streamPosition + 10_000,
    }),
  );
}

function parseRawFailedTurnCompletion(
  codexErrorInfo: unknown,
  streamPosition: number,
): CodexNotification | null {
  const parsed = parseCodexNotification("turn/completed", {
    threadId: "provider-managed-thread",
    turn: {
      ...rawTurn("provider-managed-turn", "failed"),
      error: {
        message: "Private provider failure prose",
        codexErrorInfo,
        additionalDetails: "Private provider failure details",
      },
    },
  });
  if (parsed === null) return null;
  if (parsed.method !== "turn/completed") {
    throw new Error("Expected a parsed turn completion");
  }
  return {
    ...parsed,
    generation: 1,
    streamPosition,
  };
}

type SessionCodexRequestKey = Extract<PinnedCodexRequestKey,
  | "threadList"
  | "threadStart"
  | "threadResume"
  | "threadRead"
  | "threadHistoryRead"
  | "threadTurnsList"
  | "threadItemsList"
  | "threadFork"
  | "threadGoalSet"
  | "threadGoalGet"
  | "threadGoalClear"
  | "threadSetName"
  | "threadInjectItems"
  | "modelList"
  | "turnStart"
  | "turnSteer"
  | "turnInterrupt">;

interface RecordedRequest<Key extends SessionCodexRequestKey = SessionCodexRequestKey> {
  readonly accountProfileId: string;
  readonly key: Key;
  readonly input: PinnedCodexRequestInput<Key>;
}

function bindInteractionRequest(request: RunInteractionRequestPayload): RunInteractionRequest {
  return runInteractionRequestSchema.parse({
    ...request,
    reply: {
      version: 1,
      algorithm: "P256-HKDF-SHA256-A256GCM",
      keyId: `hitlkey_${"a".repeat(32)}`,
      publicKey: "B".repeat(87),
      runnerId: "runner_session0001",
      bootId: "boot_session00001",
      bootGeneration: 1,
      claimId: "claim_session0001",
      claimFence: 1,
      requestDigest: `sha256_${"b".repeat(64)}`,
    },
  });
}

/*
 * This fake is the only place that converts test-owned fixture values into a
 * key-dependent protocol output. Production callers retain generic typing.
 */
function accountPort(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => unknown,
  responsePosition: Readonly<{
    readonly generation: number;
    readonly streamPosition: number;
  }> = { generation: 1, streamPosition: 1 },
): SessionAccountRuntimePort {
  let nextResponsePosition = responsePosition.streamPosition;
  return {
    requestSession<Key extends SessionCodexRequestKey>(accountProfileId: string, key: Key, input: PinnedCodexRequestInput<Key>) {
      const request: RecordedRequest<Key> = { accountProfileId, key, input };
      requests.push(request);
      return Promise.resolve(respond(request) as PinnedCodexRequestOutput<Key>);
    },
    requestSessionWithResponsePosition<Key extends SessionCodexRequestKey>(
      accountProfileId: string,
      key: Key,
      input: PinnedCodexRequestInput<Key>,
    ) {
      const request: RecordedRequest<Key> = { accountProfileId, key, input };
      requests.push(request);
      return Promise.resolve({
        generation: responsePosition.generation,
        output: respond(request) as PinnedCodexRequestOutput<Key>,
        streamPosition: nextResponsePosition++,
      });
    },
  };
}

class ManualInteractionDeadlines {
  readonly entries: Array<{
    cancelled: boolean;
    callback: () => void;
    fired: boolean;
  }> = [];

  after(_milliseconds: number, callback: () => void): SessionInteractionDeadline {
    const entry = { cancelled: false, callback, fired: false };
    this.entries.push(entry);
    return { cancel: () => { entry.cancelled = true; } };
  }

  fireLatest(): void {
    const entry = this.entries.at(-1);
    if (entry === undefined || entry.cancelled || entry.fired) return;
    entry.fired = true;
    entry.callback();
  }
}

function rawTurn(
  id: string,
  status: "completed" | "interrupted" | "failed" | "inProgress",
  items: readonly PinnedCodexThreadItem[] = [],
  itemsView: "notLoaded" | "summary" | "full" = "full",
) {
  return {
    id,
    items: [...items],
    itemsView,
    status,
    startedAt: 1_721_390_400,
    completedAt: status === "inProgress" ? null : 1_721_390_460,
  };
}

function rawThread(
  cwd: string,
  options: {
    readonly id?: string;
    readonly preview?: string;
    readonly turns?: readonly ReturnType<typeof rawTurn>[];
  } = {},
) {
  const turns = options.turns ?? [];
  return {
    id: options.id ?? "provider-thread",
    preview: options.preview ?? "Latest session",
    createdAt: 1_721_390_000,
    updatedAt: 1_721_390_460,
    status: { type: turns.at(-1)?.status === "inProgress" ? "active" : "idle", activeFlags: [] },
    cwd,
    name: null,
    turns,
  };
}

function parsedHistoryItems(items: readonly unknown[]): readonly PinnedCodexHistoryThreadItem[] {
  return pinnedCodexRequests.threadItemsList.outputCodec.parse({
    data: items,
    nextCursor: null,
    backwardsCursor: null,
  }).data;
}

function latestThread(events: readonly SessionEvent[]): ThreadSummary {
  const thread = events.findLast(
    (event): event is Extract<SessionEvent, { type: "thread.upserted" }> => (
      event.type === "thread.upserted"
    ),
  )?.thread;
  if (thread === undefined) throw new Error("Expected a projected thread.");
  return thread;
}

async function eventually(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(0);
  }
  throw new Error("The expected session state did not settle.");
}

test("session operations inherit closed request policy from the pinned registry", () => {
  expect(pinnedCodexRequests.threadResume).toMatchObject({
    key: "threadResume",
    method: "thread/resume",
    semantics: {
      timeoutMs: 30_000,
      effect: "non-idempotent-mutation",
      lostResponse: "ambiguous",
      concurrency: "per-thread",
      reconciliation: { kind: "unsupported", strategy: "thread-read" },
    },
  });
  expect(pinnedCodexRequests.turnInterrupt).toMatchObject({
    key: "turnInterrupt",
    method: "turn/interrupt",
    semantics: {
      timeoutMs: 15_000,
      effect: "non-idempotent-mutation",
      lostResponse: "ambiguous",
      concurrency: "per-thread",
      reconciliation: { kind: "automatic", strategy: "terminal-turn-observation" },
    },
  });
});

test("thread reconciliation performs one exact cwd query and fails closed on pagination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-session-reconcile-thread-"));
  const requests: RecordedRequest[] = [];
  const sessionCwd = await realpath(directory);
  let listResponse: {
    data: ReturnType<typeof rawThread>[];
    nextCursor: string | null;
    backwardsCursor: string | null;
  } = {
    data: [rawThread(sessionCwd, { id: "provider-exact-thread" })],
    nextCursor: null,
    backwardsCursor: null,
  };
  const service = new SessionService({
    accounts: accountPort(requests, ({ key }) => {
      if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
      return listResponse;
    }),
    emit: () => undefined,
  });

  try {
    const ready = await service.reconcileThread({
      accountProfileId: "acct_primary0001",
      workspacePath: directory,
    });
    expect(ready.kind).toBe("ready");
    expect(requests[0]).toMatchObject({
      key: "threadList",
      input: {
        archived: false,
        cursor: null,
        cwd: sessionCwd,
        limit: 2,
        sortDirection: "desc",
        sortKey: "updated_at",
        sourceKinds: ["appServer"],
      },
    });

    listResponse = {
      data: [rawThread(sessionCwd, { id: "provider-first-thread" })],
      nextCursor: "provider-more-exact-cwd-threads",
      backwardsCursor: null,
    };
    expect(await service.reconcileThread({
      accountProfileId: "acct_primary0001",
      workspacePath: directory,
    })).toEqual({ kind: "ambiguous" });

    listResponse = {
      data: [rawThread("/fixture/different-worktree", { id: "provider-wrong-thread" })],
      nextCursor: null,
      backwardsCursor: null,
    };
    expect(await service.reconcileThread({
      accountProfileId: "acct_primary0001",
      workspacePath: directory,
    })).toEqual({ kind: "ambiguous" });
    expect(requests).toHaveLength(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("initial-turn reconciliation reads at a position and matches one complete client message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-session-reconcile-turn-"));
  const requests: RecordedRequest[] = [];
  const sessionCwd = await realpath(directory);
  const expectedClientId = "message_target0001";
  let readThread = rawThread(sessionCwd, {
    id: "provider-reconciled-thread",
    turns: [rawTurn("provider-unrelated-turn", "completed", [
      { type: "userMessage", id: "provider-unrelated-message", clientId: "message_other00001" },
    ])],
  });
  const service = new SessionService({
    accounts: accountPort(requests, ({ key }) => {
      if (key === "threadList") {
        return {
          data: [rawThread(sessionCwd, { id: "provider-reconciled-thread" })],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (key === "threadRead") return { thread: readThread };
      throw new Error(`Unexpected request key: ${key}`);
    }, { generation: 7, streamPosition: 41 }),
    emit: () => undefined,
  });

  try {
    const reconciledThread = await service.reconcileThread({
      accountProfileId: "acct_primary0001",
      workspacePath: directory,
    });
    if (reconciledThread.kind !== "ready") throw new Error("Expected reconciled thread binding");

    expect(await service.reconcileInitialTurn(
      reconciledThread.thread.id,
      expectedClientId,
    )).toEqual({
      kind: "missing",
      generation: 7,
      responsePosition: 42,
    });

    readThread = rawThread(sessionCwd, {
      id: "provider-reconciled-thread",
      turns: [
        rawTurn("provider-earlier-turn", "completed"),
        rawTurn("provider-matching-turn", "completed", [
          { type: "userMessage", id: "provider-matching-message", clientId: expectedClientId },
        ]),
      ],
    });
    const ready = await service.reconcileInitialTurn(
      reconciledThread.thread.id,
      expectedClientId,
    );
    expect(ready).toMatchObject({
      kind: "ready",
      generation: 7,
      responsePosition: 43,
    });
    if (ready.kind !== "ready") throw new Error("Expected exact client-message match");
    expect(ready.turnId).toMatch(/^turn_[a-f0-9]{24}$/u);

    readThread = rawThread(sessionCwd, {
      id: "provider-reconciled-thread",
      turns: [
        rawTurn("provider-duplicate-one", "completed", [
          { type: "userMessage", id: "provider-duplicate-message-one", clientId: expectedClientId },
        ]),
        rawTurn("provider-duplicate-two", "completed", [
          { type: "userMessage", id: "provider-duplicate-message-two", clientId: expectedClientId },
        ]),
      ],
    });
    expect(await service.reconcileInitialTurn(
      reconciledThread.thread.id,
      expectedClientId,
    )).toEqual({
      kind: "ambiguous",
      reason: "duplicate_client_message_id",
      generation: 7,
      responsePosition: 44,
    });

    readThread = rawThread(sessionCwd, {
      id: "provider-reconciled-thread",
      turns: [rawTurn("provider-partial-turn", "completed", [
        { type: "userMessage", id: "provider-partial-message", clientId: expectedClientId },
      ], "summary")],
    });
    expect(await service.reconcileInitialTurn(
      reconciledThread.thread.id,
      expectedClientId,
    )).toEqual({
      kind: "incomplete",
      reason: "partial_turn_items",
      generation: 7,
      responsePosition: 45,
    });

    expect(requests.slice(1).map(({ key, input }) => ({ key, input }))).toEqual(
      Array.from({ length: 4 }, () => ({
        key: "threadRead",
        input: {
          threadId: "provider-reconciled-thread",
          includeTurns: true,
        },
      })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("initial-turn reconciliation preserves a local lane mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-session-local-reconcile-"));
  const requests: RecordedRequest[] = [];
  const events: SessionEvent[] = [];
  const sessionCwd = await realpath(directory);
  const providerThread = rawThread(sessionCwd, {
    id: "provider-local-thread",
  });
  const service = new SessionService({
    accounts: accountPort(requests, ({ key }) => {
      if (key === "threadStart") return { thread: providerThread };
      if (key === "threadRead") return { thread: providerThread };
      throw new Error(`Unexpected request key: ${key}`);
    }),
    emit: (event) => events.push(event),
  });

  try {
    const started = await service.startThread({
      accountProfileId: "acct_primary0001",
      title: "Local task",
      workspaceMode: "local",
      workspacePath: directory,
    });
    expect(await service.reconcileInitialTurn(
      started.thread.id,
      "message_local000001",
    )).toMatchObject({ kind: "missing" });
    const workspaces = events.filter(
      (event): event is Extract<SessionEvent, { type: "workspace.upserted" }> =>
        event.type === "workspace.upserted",
    );
    expect(workspaces.map(({ workspaceLane }) => workspaceLane.mode)).toEqual([
      "local",
      "local",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime restart hydration buffers live facts and gates unwatermarked active history", async () => {
  const accountProfileId = "acct_primary0001";
  const cwd = "/tmp/oprte-hydration-integration";
  const active = rawThread(cwd, {
    id: "provider-hydrated-thread",
    turns: [rawTurn("provider-hydrated-turn", "inProgress", [{
      type: "agentMessage",
      id: "provider-hydrated-item",
      text: "old display",
    }])],
  });
  const expectedGenerations: Array<number | undefined> = [];
  const port: SessionAccountRuntimePort = {
    requestSession: () =>
      Promise.reject(new Error("Unpositioned session requests are not expected.")),
    requestSessionWithResponsePosition(
      _accountProfileId,
      key,
      _input,
      expectedGeneration,
    ) {
      expectedGenerations.push(expectedGeneration);
      if (key === "threadList") {
        return Promise.resolve({
          generation: expectedGeneration ?? 1,
          output: {
            backwardsCursor: null,
            data: [active],
            nextCursor: null,
          } as unknown as PinnedCodexRequestOutput<typeof key>,
          streamPosition: expectedGeneration === undefined ? 1 : 10,
        });
      }
      if (key === "threadRead") {
        return Promise.resolve({
          generation: expectedGeneration ?? 1,
          output: { thread: active } as unknown as PinnedCodexRequestOutput<typeof key>,
          streamPosition: 20,
        });
      }
      return Promise.reject(new Error(`Unexpected hydration request key: ${key}`));
    },
  };
  const service = new SessionService({ accounts: port, emit: () => undefined });
  await service.execute({ type: "thread.list", accountProfileId });
  const beforeRestart = service.getSnapshot();

  service.handleRuntimeState(accountProfileId, { type: "starting", generation: 2 });
  expect(service.consumeCodexFacts(projectCodexNotificationFacts(accountProfileId, {
    generation: 2,
    streamPosition: 5,
    method: "item/agentMessage/delta",
    params: {
      delta: " uncertain",
      itemId: "provider-hydrated-item",
      threadId: "provider-hydrated-thread",
      turnId: "provider-hydrated-turn",
    },
  }))).toBeTrue();
  expect(service.getSnapshot()).toBe(beforeRestart);
  service.handleRuntimeState(accountProfileId, { type: "running", generation: 2 });

  await eventually(() => Object.values(service.getSnapshot().hydration)
    .some(({ status }) => status === "recovering"));
  expect(expectedGenerations).toEqual([undefined, 2, 2]);
  expect(service.getSnapshot().cursors[`${accountProfileId.length}:${accountProfileId}`])
    .toMatchObject({ generation: 2, streamPosition: 20 });

  expect(service.consumeCodexFacts(projectCodexNotificationFacts(accountProfileId, {
    generation: 2,
    streamPosition: 21,
    method: "item/agentMessage/delta",
    params: {
      delta: " still uncertain",
      itemId: "provider-hydrated-item",
      threadId: "provider-hydrated-thread",
      turnId: "provider-hydrated-turn",
    },
  }))).toBeTrue();
  expect([...service.getSnapshot().items.values()]
    .find(({ id }) => id === "provider-hydrated-item")?.status).toBe("completed");

  expect(service.consumeCodexFacts(projectCodexNotificationFacts(accountProfileId, {
    generation: 2,
    streamPosition: 22,
    method: "turn/completed",
    params: {
      threadId: "provider-hydrated-thread",
      turn: rawTurn("provider-hydrated-turn", "completed", [{
        type: "agentMessage",
        id: "provider-hydrated-item",
        text: "authoritative final display",
      }]),
    },
  }))).toBeTrue();
  const terminal = service.getSnapshot();
  expect(Object.values(terminal.turns)
    .find(({ id }) => id === "provider-hydrated-turn")?.status).toBe("completed");
  expect([...terminal.items.values()]
    .find(({ id }) => id === "provider-hydrated-item")?.status).toBe("completed");
  expect(Object.values(terminal.hydration)
    .find(({ threadKey }) => threadKey !== null)?.status).toBe("ready");
  service.handleRuntimeState(accountProfileId, { type: "stopped", generation: 2 });
});

test("exhausted hydration reports safe account recovery without fabricating a fact position", async () => {
  const accountProfileId = "acct_primary0001";
  const providerThread = rawThread("/fixture/hydration-failure", {
    id: "provider-hydration-failure-thread",
    turns: [rawTurn("provider-hydration-failure-turn", "inProgress")],
  });
  const failures: SessionHydrationFailure[] = [];
  const port: SessionAccountRuntimePort = {
    requestSession() {
      return Promise.reject(new Error("Unpositioned session requests are not expected."));
    },
    requestSessionWithResponsePosition(
      _accountProfileId,
      key,
      _input,
      expectedGeneration,
    ) {
      if (key !== "threadList") {
        return Promise.reject(new Error(`Unexpected hydration request key: ${key}`));
      }
      return Promise.resolve({
        generation: expectedGeneration === undefined ? 1 : expectedGeneration + 1,
        output: {
          backwardsCursor: null,
          data: [providerThread],
          nextCursor: null,
        } as unknown as PinnedCodexRequestOutput<typeof key>,
        streamPosition: expectedGeneration === undefined ? 1 : 10,
      });
    },
  };
  const service = new SessionService({
    accounts: port,
    emit: () => undefined,
    onHydrationFailure: (event) => {
      failures.push(event);
      throw new Error("failure observer unavailable");
    },
  });
  await service.execute({ type: "thread.list", accountProfileId });

  service.handleRuntimeState(accountProfileId, { type: "starting", generation: 2 });
  service.handleRuntimeState(accountProfileId, { type: "running", generation: 2 });
  await eventually(() => failures.length === 1);

  expect(failures).toEqual([{
    accountProfileId,
    action: "restartRuntime",
    attempts: 1,
    generation: 2,
    reason: "protocol",
    recoveringThreadCount: 1,
  }]);
  expect(JSON.stringify(failures)).not.toContain("provider-hydration-failure");
  expect(Object.values(service.getSnapshot().hydration)).toEqual([]);
  service.handleRuntimeState(accountProfileId, { type: "running", generation: 2 });
  await Bun.sleep(0);
  expect(failures).toHaveLength(1);
  service.handleRuntimeState(accountProfileId, { type: "stopped", generation: 2 });
});

test("gateway launch resumes through the owned latest-turn snapshot projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-session-"));
  const requests: RecordedRequest[] = [];
  const events: SessionEvent[] = [];
  const sessionCwd = await realpath(directory);
  try {
    const port = accountPort(requests, ({ key }) => {
      if (key === "threadStart") {
        return { thread: rawThread(sessionCwd, { id: "provider-started" }) };
      }
      if (key === "turnStart") return { turn: rawTurn("provider-turn", "inProgress") };
      if (key === "turnSteer") return { turnId: "provider-turn" };
      if (key !== "threadResume") throw new Error(`Unexpected request key: ${key}`);
      return {
        thread: rawThread(sessionCwd, {
          id: "provider-started",
          turns: [
            rawTurn("provider-old-turn", "completed", [
              { type: "agentMessage", id: "provider-old-item", text: "Older response" },
            ]),
            rawTurn("provider-turn", "completed", [
              { type: "reasoning", id: "provider-summary", summary: ["Checking tests"] },
              { type: "agentMessage", id: "provider-answer", text: "Everything is ready." },
            ]),
          ],
        }),
      };
    });
    const service = new SessionService({
      accounts: port,
      emit: (event) => events.push(event),
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    });

    const started = await service.startThread({
      accountProfileId: "acct_primary0001",
      title: "Make the session view",
      workspaceMode: "managed",
      workspacePath: directory,
    });
    await service.startInitialTurn({
      clientUserMessageId: "message_primary0001",
      prompt: "Build the compact view",
      threadId: started.thread.id,
    });
    const active = latestThread(events);
    if (active.activeTurn === null) throw new Error("Expected an active turn.");
    await service.steer({
      threadId: active.id,
      expectedTurnId: active.activeTurn.id,
      clientUserMessageId: "message_primary0002",
      prompt: "Also keep it responsive",
    });
    await service.execute({ type: "thread.resume", threadId: active.id });

    expect(requests.map(({ key }) => key)).toEqual([
      "threadStart",
      "turnStart",
      "turnSteer",
      "threadResume",
    ]);
    expect(requests[0]).toMatchObject({
      accountProfileId: "acct_primary0001",
      input: {
        cwd: started.project.displayPath,
        model: "gpt-5.6-sol",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        ephemeral: false,
        serviceTier: null,
      },
    });
    expect(requests[1]?.input).toEqual({
      threadId: "provider-started",
      clientUserMessageId: "message_primary0001",
      input: [{ type: "text", text: "Build the compact view", text_elements: [] }],
      cwd: started.project.displayPath,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [started.project.displayPath],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      model: "gpt-5.6-sol",
      effort: "max",
      serviceTier: null,
    });
    expect(requests[2]?.input).toEqual({
      threadId: "provider-started",
      expectedTurnId: "provider-turn",
      clientUserMessageId: "message_primary0002",
      input: [{ type: "text", text: "Also keep it responsive", text_elements: [] }],
    });
    expect(requests[3]?.input).toMatchObject({
      threadId: "provider-started",
      serviceTier: null,
    });
    const projectedItems = events.flatMap((event) => (
      event.type === "item.upserted" ? [event.item] : []
    ));
    expect(projectedItems.map((item) => ({
      kind: item.kind,
      revision: item.revision,
      text: "text" in item ? item.text : null,
    }))).toEqual([
      { kind: "reasoning", revision: 1, text: "Checking tests" },
      { kind: "message", revision: 2, text: "Everything is ready." },
    ]);
    expect(JSON.stringify(events)).not.toContain("Older response");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gateway-only launch inputs fail before any app-server request", async () => {
  const requests: RecordedRequest[] = [];
  const service = new SessionService({
    accounts: accountPort(requests, () => {
      throw new Error("Invalid dispatch input must not reach the app-server.");
    }),
    emit: () => undefined,
  });

  const invalidThread = await service.startThread({
    accountProfileId: "acct_primary0001",
    title: "   ",
    workspaceMode: "managed",
    workspacePath: "/fixture/worktree",
  }).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(invalidThread).toMatchObject({ code: "invalid_request" });
  const invalidTurn = await service.startInitialTurn({
    clientUserMessageId: "dispatch-run-1",
    prompt: "Do the work",
    threadId: "thread_primary0001",
  }).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(invalidTurn).toMatchObject({ code: "invalid_request" });
  expect(requests).toEqual([]);
});

test("gateway revocation can interrupt an active owned turn without renderer authority", async () => {
  const requests: RecordedRequest[] = [];
  const events: SessionEvent[] = [];
  const service = new SessionService({
    accounts: accountPort(requests, ({ key }) => {
      if (key === "threadList") {
        return {
          data: [rawThread("/fixture/managed", {
            id: "provider-managed-thread",
            turns: [rawTurn("provider-managed-turn", "inProgress")],
          })],
          nextCursor: null,
        };
      }
      if (key === "turnInterrupt") return undefined;
      throw new Error(`Unexpected request key: ${key}`);
    }),
    emit: (event) => events.push(event),
  });

  await service.execute({ type: "thread.list", accountProfileId: "acct_primary0001" });
  const active = latestThread(events);

  expect(await service.interruptGatewayThread(active.id)).toBe("interrupted");
  expect(requests.map(({ key }) => key)).toEqual(["threadList", "turnInterrupt"]);
  expect(requests[1]?.input).toEqual({
    threadId: "provider-managed-thread",
    turnId: "provider-managed-turn",
  });
});

test("owned turn lifecycle callback reports terminal status without transcript data", async () => {
  const requests: RecordedRequest[] = [];
  const lifecycle: SessionTurnLifecycle[] = [];
  const service = new SessionService({
    accounts: accountPort(requests, ({ key }) => {
      if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
      return {
        data: [rawThread("/fixture/managed", { id: "provider-managed-thread" })],
        nextCursor: null,
      };
    }),
    emit: () => undefined,
    onTurnLifecycle: (event) => lifecycle.push(event),
  });

  await service.execute({ type: "thread.list", accountProfileId: "acct_primary0001" });
  expect(consumeNotification(service, "acct_primary0001", {
    generation: 1,
    streamPosition: 1,
    method: "turn/completed",
    params: {
      threadId: "provider-managed-thread",
      turn: rawTurn("provider-managed-turn", "completed", [
        { type: "agentMessage", id: "provider-message", text: "private transcript" },
      ]),
    },
  })).toBeTrue();

  expect(lifecycle).toHaveLength(1);
  expect(lifecycle[0]?.accountProfileId).toBe("acct_primary0001");
  expect(lifecycle[0]?.threadId).toMatch(/^thread_/u);
  expect(lifecycle[0]?.turnId).toMatch(/^turn_/u);
  expect(lifecycle[0]?.status).toBe("completed");
  expect(JSON.stringify(lifecycle)).not.toContain("private transcript");
  expect(JSON.stringify(lifecycle)).not.toContain("provider-managed");
});

test("raw provider quota errors become trusted lifecycle proof only for the exact enum", async () => {
  const cases = [
    { codexErrorInfo: "usageLimitExceeded", quotaProof: "provider_usage_limit_exceeded" },
    { codexErrorInfo: "sessionBudgetExceeded", quotaProof: undefined },
    { codexErrorInfo: "serverOverloaded", quotaProof: undefined },
    { codexErrorInfo: null, quotaProof: undefined },
  ] as const;

  for (const [index, fixture] of cases.entries()) {
    const requests: RecordedRequest[] = [];
    const lifecycle: SessionTurnLifecycle[] = [];
    const service = new SessionService({
      accounts: accountPort(requests, ({ key }) => {
        if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
        return {
          data: [rawThread("/fixture/managed", { id: "provider-managed-thread" })],
          nextCursor: null,
        };
      }),
      emit: () => undefined,
      onTurnLifecycle: (event) => lifecycle.push(event),
    });

    await service.execute({ type: "thread.list", accountProfileId: "acct_primary0001" });
    const notification = parseRawFailedTurnCompletion(
      fixture.codexErrorInfo,
      10_001 + index,
    );
    if (notification === null) throw new Error("Supported provider error was rejected");
    expect(service.consumeCodexFacts(
      projectCodexNotificationFacts("acct_primary0001", notification),
    )).toBeTrue();
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]).toMatchObject({
      accountProfileId: "acct_primary0001",
      status: "failed",
    });
    if (fixture.quotaProof === undefined) {
      expect(lifecycle[0]).not.toHaveProperty("quotaProof");
    } else {
      expect(lifecycle[0]?.quotaProof).toBe(fixture.quotaProof);
    }
    expect(JSON.stringify(lifecycle)).not.toContain("Private provider failure");
  }

  expect(parseRawFailedTurnCompletion("usage_limit_exceeded", 10_100)).toBeNull();
  expect(parseRawFailedTurnCompletion({ usageLimitExceeded: true }, 10_101)).toBeNull();
});

test("unsafe interaction callbacks fail closed without projecting provider payloads", async () => {
  const requests: RecordedRequest[] = [];
  const activities: SessionTurnActivity[] = [];
  const service = new SessionService({
    accounts: accountPort(requests, ({ key }) => {
      if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
      return {
        data: [rawThread("/fixture/private-worktree", {
          id: "provider-private-thread",
          turns: [rawTurn("provider-private-turn", "inProgress")],
        })],
        nextCursor: null,
      };
    }),
    emit: () => undefined,
    onTurnActivity: (activity) => {
      activities.push(activity);
    },
    onInteractionRequest: ({ request }) => bindInteractionRequest({
      ...request,
      expiresAt: request.expiresAt - 1,
    }),
  });

  await service.execute({ type: "thread.list", accountProfileId: "acct_primary0001" });
  const semanticNotifications: CodexNotification[] = [
    {
      generation: 1,
      streamPosition: 1,
      method: "turn/plan/updated",
      params: {
        threadId: "provider-private-thread",
        turnId: "provider-private-turn",
      },
    },
    {
      generation: 1,
      streamPosition: 2,
      method: "item/started",
      params: {
        threadId: "provider-private-thread",
        turnId: "provider-private-turn",
        item: {
          type: "fileChange",
          id: "provider-secret-item",
          status: "inProgress",
          changes: [{ path: "/fixture/private-worktree/.env" }],
        },
        startedAtMs: 1_700_000_000_000,
      },
    },
    {
      generation: 1,
      streamPosition: 3,
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "provider-private-thread",
        turnId: "provider-private-turn",
        itemId: "provider-secret-command",
        delta: "TOKEN=never-publish",
      },
    },
  ];
  for (const notification of semanticNotifications) {
    consumeNotification(service, "acct_primary0001", notification);
  }

  expect(await service.handleServerRequest("acct_primary0001", {
    generation: 1,
    id: "approval-private",
    requestInstanceId: 1,
    streamPosition: 1,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "provider-private-thread",
      turnId: "provider-private-turn",
      itemId: "provider-secret-command",
      startedAtMs: 1,
    },
  })).toBeFalse();
  expect(await service.handleServerRequest("acct_primary0001", {
    generation: 1,
    id: "input-private",
    requestInstanceId: 2,
    streamPosition: 2,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "provider-private-thread",
      turnId: "provider-private-turn",
      itemId: "provider-secret-question",
      questions: [{
        id: "provider-question",
        header: "Private input",
        question: "What is the token?",
        isOther: true,
        isSecret: true,
        options: null,
      }],
      autoResolutionMs: null,
    },
  })).toBeFalse();

  expect(activities.map(({ kind }) => kind)).toEqual([
    "planning",
    "tool_activity_started",
  ]);
  expect(activities.every(({ threadId }) => threadId.startsWith("thread_"))).toBeTrue();
  expect(activities.every(({ turnId }) => turnId.startsWith("turn_"))).toBeTrue();
  const serialized = JSON.stringify(activities);
  expect(serialized).not.toContain("provider-private");
  expect(serialized).not.toContain("private-worktree");
  expect(serialized).not.toContain("TOKEN");
  expect(serialized).not.toContain("secret");
});

test("non-secret input and one-shot managed file approvals round-trip without persisting provider IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-hitl-"));
  const interactions: SessionInteractionRequest[] = [];
  const responses: unknown[] = [];
  const activities: SessionTurnActivity[] = [];
  const expirations: unknown[] = [];
  const deadlines = new ManualInteractionDeadlines();
  let releaseRacingResponse: (() => void) | undefined;
  let racingResponseStarted = false;
  const racingResponseGate = new Promise<void>((resolve) => {
    releaseRacingResponse = resolve;
  });
  let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  try {
    const sessionCwd = await realpath(directory);
    const service = new SessionService({
      accounts: accountPort([], ({ key }) => {
        if (key === "threadStart") {
          return { thread: rawThread(sessionCwd, { id: "provider-hitl-thread" }) };
        }
        if (key === "turnStart") return { turn: rawTurn("provider-hitl-turn", "inProgress") };
        throw new Error(`Unexpected request key: ${key}`);
      }),
      emit: () => undefined,
      now: () => new Date(nowMs),
      deadlines,
      onTurnActivity: (activity) => {
        activities.push(activity);
      },
      onInteractionRequest: (interaction) => {
        interactions.push(interaction);
        return bindInteractionRequest(interaction.request);
      },
      onInteractionExpired: (event) => {
        expirations.push(event);
      },
      respondToServerRequest: (_accountProfileId, request, response) => {
        responses.push({ id: request.id, response });
        if (request.id === "provider-write-failed-request") {
          return Promise.reject(new Error("provider response channel closed"));
        }
        if (request.id === "provider-expiry-race-request") {
          racingResponseStarted = true;
          return racingResponseGate;
        }
        return Promise.resolve();
      },
    });
    const { thread } = await service.startThread({
      accountProfileId: "acct_primary0001",
      title: "Safe HITL",
      workspaceMode: "managed",
      workspacePath: directory,
    });
    await service.startInitialTurn({
      clientUserMessageId: "message_primary0001",
      prompt: "Make the safe change",
      threadId: thread.id,
    });

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-input-request",
      requestInstanceId: 1,
      streamPosition: 1,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-input-item",
        questions: [{
          id: "provider-question-id",
          header: "Direction",
          question: "Which direction should we take?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Focused", description: "Keep the change narrow." },
            { label: "Broad", description: "Include the cleanup." },
          ],
        }],
        autoResolutionMs: null,
      },
    })).toBeTrue();
    const input = interactions[0]?.request;
    if (input?.kind !== "user_input") throw new Error("Expected safe user-input request");
    const question = input.questions[0];
    const option = question?.options[1];
    if (question === undefined || option === undefined) throw new Error("Expected mapped input choices");
    expect(await service.resolveInteraction(input.id, {
      kind: "user_input",
      answers: [{ questionId: question.id, selectedOptionIds: [option.id] }],
    })).toEqual({ kind: "applied" });

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-file-request",
      requestInstanceId: 2,
      streamPosition: 2,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-file-item",
        startedAtMs: 1_721_390_400_000,
        grantRoot: sessionCwd,
      },
    })).toBeTrue();
    const file = interactions[1]?.request;
    if (file?.kind !== "file_change_approval") throw new Error("Expected safe file approval");
    expect(await service.resolveInteraction(file.id, {
      kind: "file_change_approval",
      decision: "approve_once",
    })).toEqual({ kind: "applied" });

    expect(responses).toEqual([
      {
        id: "provider-input-request",
        response: {
          type: "result",
          result: { answers: { "provider-question-id": { answers: ["Broad"] } } },
        },
      },
      {
        id: "provider-file-request",
        response: { type: "result", result: { decision: "accept" } },
      },
    ]);
    expect(activities.map(({ kind }) => kind)).toEqual([
      "waiting_for_input",
      "waiting_for_approval",
    ]);
    const publicProjection = JSON.stringify(interactions);
    expect(publicProjection).not.toContain("provider-input-request");
    expect(publicProjection).not.toContain("provider-question-id");
    expect(publicProjection).not.toContain("provider-file-item");
    expect(publicProjection).not.toContain("private provider reason");

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-stale-authority-request",
      requestInstanceId: 3,
      streamPosition: 3,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-stale-authority-item",
        startedAtMs: nowMs,
        grantRoot: sessionCwd,
      },
    })).toBeTrue();
    const staleAuthority = interactions.at(-1)?.request;
    if (staleAuthority?.kind !== "file_change_approval") {
      throw new Error("Expected stale-authority interaction");
    }
    const responsesBeforeStaleAuthority = responses.length;
    expect(await service.resolveInteraction(staleAuthority.id, {
      kind: "file_change_approval",
      decision: "approve_once",
    }, () => Promise.resolve(false))).toEqual({ kind: "rejected" });
    expect(responses).toHaveLength(responsesBeforeStaleAuthority);
    expect(await service.expireInteraction(staleAuthority.id, "provider_expired"))
      .toBeTrue();

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-local-deadline-request",
      requestInstanceId: 4,
      streamPosition: 4,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-local-deadline-item",
        questions: [{
          id: "provider-local-deadline-question",
          header: "Deadline",
          question: "Continue before the local deadline?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Continue", description: "Continue once." }],
        }],
        autoResolutionMs: 1_000,
      },
    })).toBeTrue();
    const localDeadline = interactions.at(-1)?.request;
    if (localDeadline?.kind !== "user_input") throw new Error("Expected deadline interaction");
    nowMs += 1_000;
    expect(await service.resolveInteraction(localDeadline.id, {
      kind: "user_input",
      answers: [{
        questionId: localDeadline.questions[0]?.id ?? "missing",
        selectedOptionIds: [localDeadline.questions[0]?.options[0]?.id ?? "missing"],
      }],
    })).toEqual({ kind: "expired", reason: "local_deadline" });
    expect(expirations).toEqual([]);

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-write-failed-request",
      requestInstanceId: 5,
      streamPosition: 5,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-write-failed-item",
        startedAtMs: nowMs,
        grantRoot: sessionCwd,
      },
    })).toBeTrue();
    const writeFailed = interactions.at(-1)?.request;
    if (writeFailed?.kind !== "file_change_approval") throw new Error("Expected file interaction");
    expect(await service.resolveInteraction(writeFailed.id, {
      kind: "file_change_approval",
      decision: "decline",
    })).toEqual({ kind: "expired", reason: "provider_expired" });
    expect(expirations).toEqual([]);

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-timer-deadline-request",
      requestInstanceId: 6,
      streamPosition: 6,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-timer-deadline-item",
        startedAtMs: nowMs,
        grantRoot: sessionCwd,
      },
    })).toBeTrue();
    nowMs += 3_600_000;
    deadlines.fireLatest();
    await Bun.sleep(0);
    deadlines.fireLatest();
    await Bun.sleep(0);
    expect(expirations).toEqual([{
      interactionId: interactions.at(-1)?.request.id,
      reason: "local_deadline",
    }]);
    const deadlineAttempts = responses.filter((value) =>
      typeof value === "object" && value !== null &&
      "id" in value && value.id === "provider-timer-deadline-request");
    expect(deadlineAttempts).toHaveLength(1);

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-expired-request",
      requestInstanceId: 7,
      streamPosition: 7,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-expired-item",
        startedAtMs: nowMs,
        grantRoot: sessionCwd,
      },
    })).toBeTrue();
    const providerExpired = interactions.at(-1)?.request;
    if (providerExpired?.kind !== "file_change_approval") {
      throw new Error("Expected provider-expired interaction");
    }
    const providerExpiryFault = {
      type: "server_request_expired" as const,
      generation: 2,
      method: "item/fileChange/requestApproval",
      requestId: "provider-expired-request",
      reason: "resolved_elsewhere" as const,
    };
    await service.handleServerRequestExpired("acct_primary0001", providerExpiryFault);
    await service.handleServerRequestExpired("acct_primary0001", providerExpiryFault);
    expect(expirations).toEqual([
      { interactionId: interactions.at(-2)?.request.id, reason: "local_deadline" },
      { interactionId: providerExpired.id, reason: "provider_expired" },
    ]);
    expect(await service.resolveInteraction(providerExpired.id, {
      kind: "file_change_approval",
      decision: "decline",
    })).toEqual({ kind: "expired", reason: "provider_expired" });

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-expiry-race-request",
      requestInstanceId: 8,
      streamPosition: 8,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-expiry-race-item",
        startedAtMs: nowMs,
        grantRoot: sessionCwd,
      },
    })).toBeTrue();
    const racing = interactions.at(-1)?.request;
    if (racing?.kind !== "file_change_approval") throw new Error("Expected racing interaction");
    const racingResolution = service.resolveInteraction(racing.id, {
      kind: "file_change_approval",
      decision: "approve_once",
    });
    while (!racingResponseStarted) await Bun.sleep(0);
    await service.handleServerRequestExpired("acct_primary0001", {
      type: "server_request_expired",
      generation: 2,
      method: "item/fileChange/requestApproval",
      requestId: "provider-expiry-race-request",
      reason: "resolved_elsewhere",
    });
    releaseRacingResponse?.();
    expect(await racingResolution).toEqual({ kind: "applied" });
    expect(expirations).toHaveLength(2);

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-secret-request",
      requestInstanceId: 9,
      streamPosition: 9,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-secret-item",
        questions: [{
          id: "provider-secret-question",
          header: "Secret",
          question: "Enter a token",
          isOther: true,
          isSecret: true,
          options: null,
        }],
        autoResolutionMs: null,
      },
    })).toBeFalse();
    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-outside-file-request",
      requestInstanceId: 10,
      streamPosition: 10,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-file-item-two",
        startedAtMs: 1_721_390_400_000,
        grantRoot: "/tmp/outside-managed-worktree",
      },
    })).toBeFalse();
    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-unbound-file-request",
      requestInstanceId: 11,
      streamPosition: 11,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-file-item-three",
        startedAtMs: 1_721_390_400_000,
      },
    })).toBeFalse();

    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 2,
      id: "provider-input-request",
      requestInstanceId: 12,
      streamPosition: 12,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-hitl-thread",
        turnId: "provider-hitl-turn",
        itemId: "provider-reused-id-item",
        startedAtMs: nowMs,
        grantRoot: sessionCwd,
      },
    })).toBeTrue();
    const reusedProviderId = interactions.at(-1)?.request;
    if (reusedProviderId?.kind !== "file_change_approval") {
      throw new Error("Expected reused-provider-id interaction");
    }
    expect(reusedProviderId.id).not.toBe(input.id);
    expect(await service.resolveInteraction(reusedProviderId.id, {
      kind: "file_change_approval",
      decision: "decline",
    })).toEqual({ kind: "applied" });
    expect(responses.at(-1)).toEqual({
      id: "provider-input-request",
      response: { type: "result", result: { decision: "decline" } },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interaction lifecycle is folded at provider stream positions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-interaction-facts-"));
  const sessionCwd = await realpath(directory);
  let responsePosition = 4;
  let observedRequest: RunInteractionRequestPayload | undefined;
  const service = new SessionService({
    accounts: accountPort([], ({ key }) => {
      if (key === "threadStart") {
        return { thread: rawThread(sessionCwd, { id: "provider-fact-thread" }) };
      }
      if (key === "turnStart") return { turn: rawTurn("provider-fact-turn", "inProgress") };
      throw new Error(`Unexpected request key: ${key}`);
    }),
    emit: () => undefined,
    onInteractionRequest: ({ request }) => {
      observedRequest = request;
      return bindInteractionRequest(request);
    },
    respondToServerRequest: () => Promise.resolve(responsePosition++),
  });
  try {
    const { thread } = await service.startThread({
      accountProfileId: "acct_primary0001",
      title: "Fact lifecycle",
      workspaceMode: "managed",
      workspacePath: directory,
    });
    await service.startInitialTurn({
      clientUserMessageId: "message_interaction01",
      prompt: "Ask one question",
      threadId: thread.id,
    });
    const request = {
      generation: 1,
      id: "provider-fact-request",
      requestInstanceId: 1,
      streamPosition: 3,
      method: "item/tool/requestUserInput" as const,
      params: {
        threadId: "provider-fact-thread",
        turnId: "provider-fact-turn",
        itemId: "provider-fact-item",
        questions: [{
          id: "provider-fact-question",
          header: "Choice",
          question: "Continue?",
          isOther: true,
          isSecret: false,
          options: [],
        }],
        autoResolutionMs: null,
      },
    };
    expect(await service.handleServerRequest("acct_primary0001", request)).toBeTrue();
    const pending = Object.values(service.getSnapshot().interactions)[0];
    if (pending === undefined) throw new Error("Expected pending interaction fact");
    expect(pending.outcome).toBe("pending");
    if (observedRequest?.kind !== "user_input") throw new Error("Expected public input");
    const questionId = observedRequest.questions[0]?.id;
    if (questionId === undefined) throw new Error("Expected public question");
    expect(await service.resolveInteraction(pending.id, {
      kind: "user_input",
      answers: [{
        questionId,
        selectedOptionIds: [],
        otherText: "Continue",
      }],
    })).toEqual({ kind: "applied" });

    expect(Object.values(service.getSnapshot().interactions)).toEqual([]);

    const resolvedElsewhere = {
      ...request,
      id: "provider-resolved-elsewhere",
      requestInstanceId: 2,
      streamPosition: 5,
    };
    expect(await service.handleServerRequest(
      "acct_primary0001",
      resolvedElsewhere,
    )).toBeTrue();
    await service.handleServerRequestExpired("acct_primary0001", {
      type: "server_request_expired",
      generation: 1,
      method: resolvedElsewhere.method,
      requestId: resolvedElsewhere.id,
      reason: "resolved_elsewhere",
    });
    expect(service.consumeCodexFacts(projectCodexNotificationFacts("acct_primary0001", {
      generation: 1,
      streamPosition: 6,
      method: "serverRequest/resolved",
      params: {
        threadId: "provider-fact-thread",
        requestId: resolvedElsewhere.id,
      },
    }))).toBeTrue();
    expect(Object.values(service.getSnapshot().interactions)
      .map(({ outcome }) => outcome)
      .toSorted()).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replacement runtime generation releases pending interaction resources exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-interaction-generation-"));
  const deadlines = new ManualInteractionDeadlines();
  const expirations: unknown[] = [];
  const responses: unknown[] = [];
  let observedRequest: RunInteractionRequestPayload | undefined;
  try {
    const sessionCwd = await realpath(directory);
    const service = new SessionService({
      accounts: accountPort([], ({ key }) => {
        if (key === "threadStart") {
          return { thread: rawThread(sessionCwd, { id: "provider-generation-thread" }) };
        }
        if (key === "turnStart") {
          return { turn: rawTurn("provider-generation-turn", "inProgress") };
        }
        throw new Error(`Unexpected request key: ${key}`);
      }),
      deadlines,
      emit: () => undefined,
      onInteractionExpired: (event) => {
        expirations.push(event);
      },
      onInteractionRequest: ({ request }) => {
        observedRequest = request;
        return bindInteractionRequest(request);
      },
      respondToServerRequest: (_accountProfileId, request, response) => {
        responses.push({ id: request.id, response });
        return Promise.resolve(4);
      },
    });
    const { thread } = await service.startThread({
      accountProfileId: "acct_primary0001",
      title: "Generation ownership",
      workspaceMode: "managed",
      workspacePath: directory,
    });
    await service.startInitialTurn({
      clientUserMessageId: "message_generation01",
      prompt: "Wait for approval",
      threadId: thread.id,
    });
    expect(await service.handleServerRequest("acct_primary0001", {
      generation: 1,
      id: "provider-generation-request",
      requestInstanceId: 1,
      streamPosition: 3,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-generation-thread",
        turnId: "provider-generation-turn",
        itemId: "provider-generation-item",
        startedAtMs: 1_721_390_400_000,
        grantRoot: sessionCwd,
      },
    })).toBeTrue();
    if (observedRequest?.kind !== "file_change_approval") {
      throw new Error("Expected a pending file approval");
    }
    const deadline = deadlines.entries.at(-1);
    if (deadline === undefined) throw new Error("Expected an interaction deadline");
    expect(deadline.cancelled).toBeFalse();

    service.handleRuntimeState("acct_primary0001", { type: "starting", generation: 2 });
    await eventually(() => expirations.length === 1);

    expect(deadline.cancelled).toBeTrue();
    expect(expirations).toEqual([{
      interactionId: observedRequest.id,
      reason: "provider_expired",
    }]);
    expect(await service.resolveInteraction(observedRequest.id, {
      kind: "file_change_approval",
      decision: "approve_once",
    })).toEqual({ kind: "expired", reason: "provider_expired" });
    deadlines.fireLatest();
    await Bun.sleep(0);
    expect(expirations).toHaveLength(1);
    expect(responses).toEqual([]);
    service.handleRuntimeState("acct_primary0001", { type: "stopped", generation: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("activity parsing fails closed without an exact owned active turn", async () => {
  const activities: SessionTurnActivity[] = [];
  const service = new SessionService({
    accounts: accountPort([], ({ key }) => {
      if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
      return {
        data: [rawThread("/fixture/worktree", {
          id: "provider-thread",
          turns: [rawTurn("provider-turn", "inProgress")],
        })],
        nextCursor: null,
      };
    }),
    emit: () => undefined,
    onTurnActivity: (activity) => {
      activities.push(activity);
    },
  });
  await service.execute({ type: "thread.list", accountProfileId: "acct_primary0001" });

  expect(consumeNotification(service, "acct_primary0001", {
    generation: 1,
    streamPosition: 1,
    method: "item/started",
    params: {
      threadId: "provider-thread",
      turnId: "different-turn",
      item: {
        type: "fileChange",
        id: "private-item",
        status: "inProgress",
        changes: [],
      },
      startedAtMs: 1_700_000_000_000,
    },
  })).toBeFalse();
  expect(consumeNotification(service, "acct_primary0001", {
    generation: 1,
    streamPosition: 2,
    method: "item/started",
    params: {
      threadId: "provider-thread",
      turnId: "provider-turn",
      item: { type: "userMessage", id: "private-item", clientId: null },
      startedAtMs: 1_700_000_000_000,
    },
  })).toBeFalse();
  expect(await service.handleServerRequest("acct_primary0001", {
    generation: 1,
    id: "legacy-private",
    requestInstanceId: 1,
    streamPosition: 3,
    method: "execCommandApproval",
    params: undefined,
  })).toBeFalse();
  expect(activities).toEqual([]);
});

test("display streaming strips provider metadata and aggregates parallel anonymous tools", async () => {
  const activities: SessionTurnActivity[] = [];
  const reasoningCompletions: SessionReasoningItemCompletion[] = [];
  const toolStarts: SessionToolItemStarted[] = [];
  const service = new SessionService({
    accounts: accountPort([], ({ key }) => {
      if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
      return {
        data: [rawThread("/fixture/private-worktree", {
          id: "provider-stream-thread",
          turns: [rawTurn("provider-stream-turn", "inProgress")],
        })],
        nextCursor: null,
      };
    }),
    emit: () => undefined,
    onReasoningItemCompletion: (event) => { reasoningCompletions.push(event); },
    onToolItemStarted: (event) => { toolStarts.push(event); },
    onTurnActivity: (activity) => { activities.push(activity); },
  });
  await service.execute({ type: "thread.list", accountProfileId: "acct_primary0001" });

  const reference = {
    threadId: "provider-stream-thread",
    turnId: "provider-stream-turn",
  } as const;
  const notify = (notification: CodexNotification): boolean => (
    consumeNotification(service, "acct_primary0001", notification)
  );
  expect(notify({
    generation: 1,
    streamPosition: 1,
    method: "item/reasoning/summaryTextDelta",
    params: {
      ...reference,
      itemId: "provider-reasoning",
      delta: "Checking the lease",
      summaryIndex: 0,
    },
  })).toBeTrue();
  expect(notify({
    generation: 1,
    streamPosition: 2,
    method: "item/reasoning/textDelta",
    params: undefined,
  })).toBeFalse();
  expect(notify({
    generation: 1,
    streamPosition: 3,
    method: "item/agentMessage/delta",
    params: { ...reference, itemId: "provider-message", delta: "The checks pass." },
  })).toBeTrue();
  expect(notify({
    generation: 1,
    streamPosition: 4,
    method: "item/agentMessage/delta",
    params: { ...reference, itemId: "provider-message", delta: "The checks pass." },
  })).toBeTrue();
  expect(notify({
    generation: 1,
    streamPosition: 5,
    method: "item/started",
    params: {
      ...reference,
      item: {
        id: "provider-tool-a",
        type: "commandExecution",
        command: "cat .env",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      },
      startedAtMs: 1_700_000_000_000,
    },
  })).toBeTrue();
  expect(notify({
    generation: 1,
    streamPosition: 6,
    method: "item/fileChange/patchUpdated",
    params: reference,
  })).toBeTrue();
  expect(notify({
    generation: 1,
    streamPosition: 7,
    method: "item/started",
    params: {
      ...reference,
      item: { id: "provider-tool-b", type: "mcpToolCall" },
      startedAtMs: 1_700_000_000_001,
    },
  })).toBeTrue();
  expect(notify({
    generation: 1,
    streamPosition: 8,
    method: "item/completed",
    params: {
      ...reference,
      item: {
        id: "provider-tool-a",
        type: "commandExecution",
        command: "cat .env",
        status: "completed",
        aggregatedOutput: "TOKEN=secret",
        exitCode: 0,
      },
      completedAtMs: 1_700_000_000_002,
    },
  })).toBeFalse();
  expect(notify({
    generation: 1,
    streamPosition: 9,
    method: "item/completed",
    params: {
      ...reference,
      item: { id: "provider-unknown", type: "webSearch" },
      completedAtMs: 1_700_000_000_003,
    },
  })).toBeFalse();
  expect(notify({
    generation: 1,
    streamPosition: 10,
    method: "item/completed",
    params: {
      ...reference,
      item: { id: "provider-tool-b", type: "mcpToolCall" },
      completedAtMs: 1_700_000_000_004,
    },
  })).toBeTrue();
  notify({
    generation: 1,
    streamPosition: 11,
    method: "item/completed",
    params: {
      ...reference,
      item: { id: "provider-tool-b", type: "mcpToolCall" },
      completedAtMs: 1_700_000_000_005,
    },
  });
  const reasoningCompletion = {
    generation: 1,
    streamPosition: 12,
    method: "item/completed" as const,
    params: {
      ...reference,
      item: {
        id: "provider-reasoning",
        type: "reasoning" as const,
        summary: ["Checking the lease"],
        content: [],
      },
      completedAtMs: 1_700_000_000_006,
    },
  };
  expect(notify(reasoningCompletion)).toBeTrue();
  expect(notify(reasoningCompletion)).toBeFalse();

  expect(activities.map((activity) => (
    activity.kind === "reasoning_summary_delta" || activity.kind === "assistant_message_delta"
      ? { kind: activity.kind, displayText: activity.displayText }
      : { kind: activity.kind }
  ))).toEqual([
    { kind: "reasoning_summary_delta", displayText: "Checking the lease" },
    { kind: "assistant_message_delta", displayText: "The checks pass." },
    { kind: "assistant_message_delta", displayText: "The checks pass." },
    { kind: "tool_activity_started" },
    { kind: "editing" },
    { kind: "tool_activity_completed" },
  ]);
  const serialized = JSON.stringify(activities);
  for (const forbidden of [
    "provider-",
    "cat .env",
    "TOKEN=",
    "private-worktree",
  ]) expect(serialized).not.toContain(forbidden);
  expect(toolStarts).toHaveLength(2);
  expect(new Set(toolStarts.map(({ itemId }) => itemId)).size).toBe(2);
  expect(reasoningCompletions).toHaveLength(1);
  expect(JSON.stringify({ toolStarts, reasoningCompletions })).not.toContain("provider-");
});

test("unowned tool notifications cannot poison a later owned lifecycle", async () => {
  const activities: SessionTurnActivity[] = [];
  const service = new SessionService({
    accounts: accountPort([], ({ key }) => {
      if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
      return {
        data: [rawThread("/fixture/private-worktree", {
          id: "provider-late-thread",
          turns: [rawTurn("provider-late-turn", "inProgress")],
        })],
        nextCursor: null,
      };
    }, { generation: 1, streamPosition: 2 }),
    emit: () => undefined,
    onTurnActivity: (activity) => { activities.push(activity); },
  });
  const notification: CodexNotification = {
    generation: 1,
    streamPosition: 1,
    method: "item/started",
    params: {
      threadId: "provider-late-thread",
      turnId: "provider-late-turn",
      item: {
        id: "provider-late-tool",
        type: "fileChange",
        status: "inProgress",
        changes: [],
      },
      startedAtMs: 1_700_000_000_000,
    },
  };
  expect(service.consumeCodexFacts(
    projectCodexNotificationFacts("acct_primary0001", notification),
  )).toBeFalse();
  await service.execute({ type: "thread.list", accountProfileId: "acct_primary0001" });
  expect(service.consumeCodexFacts(projectCodexNotificationFacts("acct_primary0001", {
    ...notification,
    streamPosition: 3,
  }))).toBeTrue();
  expect(service.consumeCodexFacts(projectCodexNotificationFacts("acct_primary0001", {
    generation: 1,
    streamPosition: 4,
    method: "item/completed",
    params: {
      threadId: "provider-late-thread",
      turnId: "provider-late-turn",
      item: {
        id: "provider-late-tool",
        type: "fileChange",
        status: "completed",
        changes: [],
      },
      completedAtMs: 1_700_000_000_001,
    },
  }))).toBeTrue();
  expect(activities.map(({ kind }) => kind)).toEqual([
    "tool_activity_started",
    "tool_activity_completed",
  ]);
});

test("identical provider thread ids remain isolated across account stream adapters", async () => {
  const requests: RecordedRequest[] = [];
  const events: SessionEvent[] = [];
  const port = accountPort(requests, ({ accountProfileId, key }) => {
    if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
    return {
      data: [rawThread("/fixture/shared", {
        id: "same-provider-thread",
        preview: accountProfileId === "acct_first0001" ? "First" : "Second",
        turns: [rawTurn("same-provider-turn", "inProgress")],
      })],
      nextCursor: null,
    };
  });
  const service = new SessionService({ accounts: port, emit: (event) => events.push(event) });

  await service.execute({ type: "thread.list", accountProfileId: "acct_first0001" });
  await service.execute({ type: "thread.list", accountProfileId: "acct_second001" });
  const firstHandled = consumeNotification(service, "acct_first0001", {
    generation: 1,
    streamPosition: 1,
    method: "item/agentMessage/delta",
    params: {
      threadId: "same-provider-thread",
      turnId: "same-provider-turn",
      itemId: "same-provider-item",
      delta: "first account",
    },
  });
  const secondHandled = consumeNotification(service, "acct_second001", {
    generation: 1,
    streamPosition: 1,
    method: "item/agentMessage/delta",
    params: {
      threadId: "same-provider-thread",
      turnId: "same-provider-turn",
      itemId: "same-provider-item",
      delta: "second account",
    },
  });
  const beforeRawReasoning = events.length;
  consumeNotification(service, "acct_first0001", {
    generation: 1,
    streamPosition: 2,
    method: "item/reasoning/textDelta",
    params: undefined,
  });
  expect(events).toHaveLength(beforeRawReasoning);
  consumeNotification(service, "acct_first0001", {
    generation: 1,
    streamPosition: 3,
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "same-provider-thread",
      turnId: "same-provider-turn",
      itemId: "same-provider-reasoning",
      delta: "Checking the compact surface",
      summaryIndex: 0,
    },
  });

  expect(firstHandled).toBe(true);
  expect(secondHandled).toBe(true);
  const deltas = events.filter(
    (event): event is Extract<SessionEvent, { type: "item.delta" }> => event.type === "item.delta",
  );
  expect(deltas.map(({ channel, delta, revision }) => ({ channel, delta, revision }))).toEqual([
    { channel: "text", delta: "first account", revision: 1 },
    { channel: "text", delta: "second account", revision: 1 },
    { channel: "reasoning", delta: "Checking the compact surface", revision: 2 },
  ]);
  expect(deltas[0]?.threadId).not.toBe(deltas[1]?.threadId);
  expect(deltas[0]?.itemId).not.toBe(deltas[1]?.itemId);
  expect(JSON.stringify(events)).not.toContain("private raw reasoning");
});

test("replacement generations clear active tool aggregation before new facts", async () => {
  const accountProfileId = "acct_generation_tools";
  const activities: SessionTurnActivity[] = [];
  const service = new SessionService({
    accounts: accountPort([], ({ key }) => {
      if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
      return {
        data: [rawThread("/fixture/generation-tools", {
          id: "provider-generation-tools-thread",
          turns: [rawTurn("provider-generation-tools-turn", "inProgress")],
        })],
        nextCursor: null,
      };
    }),
    emit: () => undefined,
    onTurnActivity: (activity) => { activities.push(activity); },
  });
  await service.execute({ type: "thread.list", accountProfileId });
  expect(consumeNotification(service, accountProfileId, {
    generation: 1,
    streamPosition: 2,
    method: "item/started",
    params: {
      threadId: "provider-generation-tools-thread",
      turnId: "provider-generation-tools-turn",
      item: { id: "provider-tool-a", type: "webSearch" },
      startedAtMs: 1_700_000_000_000,
    },
  })).toBeTrue();

  service.handleRuntimeState(accountProfileId, { type: "starting", generation: 2 });
  expect(service.consumeCodexFacts(createCodexFactsAtPosition({
    accountProfileId,
    generation: 2,
    origin: "reconciled",
    streamPosition: 1,
  }, [{
    type: "item.started",
    activity: "search",
    itemId: "provider-tool-b",
    kind: "tool",
    threadId: "provider-generation-tools-thread",
    turnId: "provider-generation-tools-turn",
  }]))).toBeTrue();

  expect(activities.map(({ kind }) => kind)).toEqual([
    "tool_activity_started",
    "tool_activity_started",
  ]);
  service.handleRuntimeState(accountProfileId, { type: "stopped", generation: 2 });
});

test("tool item overflow waits for the positioned terminal turn before closing activity", async () => {
  const accountProfileId = "acct_tool_item_bound";
  const threadId = "provider-bounded-tool-thread";
  const turnId = "provider-bounded-tool-turn";
  const activities: SessionTurnActivity[] = [];
  const service = new SessionService({
    accounts: accountPort([], ({ key }) => {
      if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
      return {
        data: [rawThread("/fixture/bounded-tools", {
          id: threadId,
          turns: [rawTurn(turnId, "inProgress")],
        })],
        nextCursor: null,
      };
    }),
    emit: () => undefined,
    onTurnActivity: (activity) => { activities.push(activity); },
  });
  await service.execute({ type: "thread.list", accountProfileId });

  const started = Array.from(
    { length: MAX_SESSION_ACTIVE_TOOL_ITEMS_PER_TURN + 1 },
    (_, index) => ({
      type: "item.started" as const,
      activity: "command" as const,
      itemId: `provider-bounded-tool-${String(index)}`,
      kind: "tool" as const,
      threadId,
      turnId,
    }),
  );
  expect(service.consumeCodexFacts(createCodexFactsAtPosition({
    accountProfileId,
    generation: 1,
    origin: "reconciled",
    streamPosition: 2,
  }, started))).toBeTrue();
  expect(activities.map(({ kind }) => kind)).toEqual(["tool_activity_started"]);

  const completed = started.slice(0, MAX_SESSION_ACTIVE_TOOL_ITEMS_PER_TURN)
    .map(({ itemId }) => ({
      type: "item.completed" as const,
      item: {
        activity: "command" as const,
        id: itemId,
        kind: "tool" as const,
        status: "completed" as const,
      },
      threadId,
      turnId,
    }));
  expect(service.consumeCodexFacts(createCodexFactsAtPosition({
    accountProfileId,
    generation: 1,
    origin: "reconciled",
    streamPosition: 3,
  }, completed))).toBeFalse();
  expect(activities.map(({ kind }) => kind)).toEqual(["tool_activity_started"]);

  expect(service.consumeCodexFacts(createCodexFactsAtPosition({
    accountProfileId,
    generation: 1,
    origin: "reconciled",
    streamPosition: 4,
  }, [{
    type: "turn.completed",
    completedAt: "2026-07-29T12:00:00.000Z",
    status: "completed",
    threadId,
    turnId,
  }]))).toBeTrue();
  expect(activities.map(({ kind }) => kind)).toEqual([
    "tool_activity_started",
    "tool_activity_completed",
  ]);
});

test("tool-turn tracking reopens after terminal cleanup and resets at a generation boundary", async () => {
  const accountProfileId = "acct_tool_turn_bound";
  const activities: SessionTurnActivity[] = [];
  const threads = Array.from(
    { length: MAX_SESSION_TRACKED_TOOL_TURNS_PER_ACCOUNT + 2 },
    (_, index) => rawThread("/fixture/bounded-turns", {
      id: `provider-bounded-thread-${String(index)}`,
      turns: [rawTurn(`provider-bounded-turn-${String(index)}`, "inProgress")],
    }),
  );
  const service = new SessionService({
    accounts: accountPort([], ({ key }) => {
      if (key !== "threadList") throw new Error(`Unexpected request key: ${key}`);
      return { data: threads, nextCursor: null };
    }),
    emit: () => undefined,
    onTurnActivity: (activity) => { activities.push(activity); },
  });
  await service.execute({ type: "thread.list", accountProfileId });
  const completions = threads.map((thread, index) => ({
    type: "item.completed" as const,
    item: {
      activity: "command" as const,
      id: `provider-completed-tool-${String(index)}`,
      kind: "tool" as const,
      status: "completed" as const,
    },
    threadId: thread.id,
    turnId: thread.turns[0]!.id,
  }));
  expect(service.consumeCodexFacts(createCodexFactsAtPosition({
    accountProfileId,
    generation: 1,
    origin: "reconciled",
    streamPosition: 2,
  }, completions.slice(0, MAX_SESSION_TRACKED_TOOL_TURNS_PER_ACCOUNT + 1))))
    .toBeTrue();
  expect(activities).toHaveLength(MAX_SESSION_TRACKED_TOOL_TURNS_PER_ACCOUNT);

  const released = threads[0]!;
  service.consumeCodexFacts(createCodexFactsAtPosition({
    accountProfileId,
    generation: 1,
    origin: "reconciled",
    streamPosition: 3,
  }, [{
    type: "turn.completed",
    completedAt: "2026-07-29T12:00:00.000Z",
    status: "completed",
    threadId: released.id,
    turnId: released.turns[0]!.id,
  }]));
  const previouslySaturated = completions[MAX_SESSION_TRACKED_TOOL_TURNS_PER_ACCOUNT]!;
  expect(service.consumeCodexFacts(createCodexFactsAtPosition({
    accountProfileId,
    generation: 1,
    origin: "reconciled",
    streamPosition: 4,
  }, [{
    ...previouslySaturated,
    item: { ...previouslySaturated.item, id: "provider-after-terminal-cleanup" },
  }]))).toBeTrue();
  expect(activities).toHaveLength(MAX_SESSION_TRACKED_TOOL_TURNS_PER_ACCOUNT + 1);

  const generationSaturated = completions.at(-1)!;
  expect(service.consumeCodexFacts(createCodexFactsAtPosition({
    accountProfileId,
    generation: 1,
    origin: "reconciled",
    streamPosition: 5,
  }, [generationSaturated]))).toBeFalse();

  service.handleRuntimeState(accountProfileId, { type: "starting", generation: 2 });
  expect(service.consumeCodexFacts(createCodexFactsAtPosition({
    accountProfileId,
    generation: 2,
    origin: "reconciled",
    streamPosition: 1,
  }, [{
    ...generationSaturated,
    item: { ...generationSaturated.item, id: "provider-after-generation-boundary" },
  }]))).toBeTrue();
  expect(activities).toHaveLength(MAX_SESSION_TRACKED_TOOL_TURNS_PER_ACCOUNT + 2);
  service.handleRuntimeState(accountProfileId, { type: "stopped", generation: 2 });
});

test("authorized account purge releases mutable session routing", async () => {
  const accountProfileId = "acct_session_purge";
  const events: SessionEvent[] = [];
  const service = new SessionService({
    accounts: accountPort([], ({ key }) => {
      if (key === "threadList") {
        return {
          data: [rawThread("/fixture/purge", {
            id: "provider-purged-thread",
            turns: [rawTurn("provider-purged-turn", "inProgress")],
          })],
          nextCursor: null,
        };
      }
      if (key === "threadResume") {
        return { thread: rawThread("/fixture/purge", { id: "provider-purged-thread" }) };
      }
      throw new Error(`Unexpected request key: ${key}`);
    }),
    emit: (event) => events.push(event),
  });
  const listed = await service.execute({ type: "thread.list", accountProfileId });
  if (listed.type !== "threads" || listed.threads[0] === undefined) {
    throw new Error("Expected a projected thread");
  }
  const ownedThreadId = listed.threads[0].id;

  service.purgeAccount(accountProfileId);
  expect(Object.values(service.getSnapshot().threads)).toEqual([]);
  expect(service.getSnapshot().items.size).toBe(0);
  expect(service.getSnapshot().retainedDisplayTextUtf8Bytes).toBe(0);
  expect(events.some((event) => (
    event.type === "thread.removed" && event.threadId === ownedThreadId
  ))).toBeTrue();
  const resumeFailure = await service.execute({
    type: "thread.resume",
    threadId: ownedThreadId,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(resumeFailure).toMatchObject({ code: "not_found" });
});

test("harness caller resolution fences account, generation, thread, and active turn ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-caller-"));
  const sessionCwd = await realpath(directory);
  const accountProfileId = "acct_harness_caller01";
  const providerThreadId = "provider-harness-caller-thread";
  const providerTurnId = "provider-harness-caller-turn";
  const service = new SessionService({
    accounts: accountPort([], ({ key }) => {
      if (key === "threadStart") {
        return { thread: rawThread(sessionCwd, { id: providerThreadId }) };
      }
      if (key === "turnStart") return { turn: rawTurn(providerTurnId, "inProgress") };
      throw new Error(`Unexpected request key: ${key}`);
    }, { generation: 7, streamPosition: 1 }),
    emit: () => undefined,
  });
  try {
    const started = await service.startThread({
      accountProfileId,
      title: "Harness caller",
      workspaceMode: "managed",
      workspacePath: directory,
    });
    const active = await service.startInitialTurn({
      clientUserMessageId: "message_harnesscaller01",
      prompt: "Run one bounded program",
      threadId: started.thread.id,
    });
    if (active.activeTurn === null) throw new Error("Expected active harness turn");
    service.handleRuntimeState(accountProfileId, { type: "starting", generation: 7 });

    const resolved = service.resolveHarnessCaller(
      accountProfileId,
      7,
      providerThreadId,
      providerTurnId,
    );
    expect(resolved).toEqual({
      generation: 7,
      projectId: started.project.id,
      threadId: started.thread.id,
      turnId: active.activeTurn.id,
      workspaceLaneId: started.thread.workspaceLaneId,
      workspaceMode: "managed",
      workspacePath: started.project.displayPath,
    });
    expect(JSON.stringify(resolved)).not.toContain("provider-harness");
    expect(service.resolveHarnessCaller(
      "acct_harness_other01",
      7,
      providerThreadId,
      providerTurnId,
    )).toBeNull();
    expect(service.resolveHarnessCaller(
      accountProfileId,
      6,
      providerThreadId,
      providerTurnId,
    )).toBeNull();
    expect(service.resolveHarnessCaller(
      accountProfileId,
      7,
      "provider-harness-other-thread",
      providerTurnId,
    )).toBeNull();
    expect(service.resolveHarnessCaller(
      accountProfileId,
      7,
      providerThreadId,
      "provider-harness-other-turn",
    )).toBeNull();
    service.handleRuntimeState(accountProfileId, { type: "stopped", generation: 7 });
    expect(service.resolveHarnessCaller(
      accountProfileId,
      7,
      providerThreadId,
      providerTurnId,
    )).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness history proves a stable completed prefix before the active caller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oprte-harness-history-"));
  const sessionCwd = await realpath(directory);
  const accountProfileId = "acct_harness_history01";
  const providerThreadId = "provider-harness-history-thread";
  const firstProviderTurnId = "provider-harness-history-turn-1";
  const secondProviderTurnId = "provider-harness-history-turn-2";
  const currentProviderTurnId = "provider-harness-history-turn-current";
  let abortAfterResponse: AbortController | null = null;
  let turnListCalls = 0;
  let unstableSecondScan = false;
  let cyclicTurns = false;
  let omitCurrent = false;
  let olderStatusOverride: "failed" | null = null;
  let currentStatusOverride: "completed" | null = null;
  let duplicateClientIds = false;
  let duplicateItemIds = false;
  let includeContextCompaction = false;
  let mutatePrefixAttachmentBetweenScans = false;
  let nullCompletedAssistantPhase = false;
  let prefixInputVariant: "plain" | "image" | "localImage" | "skill" | "mention" |
    "textElement" = "plain";
  let currentInputVariant: "plain" | "imageOnly" | "localImage" | "skill" | "mention" |
    "textElement" = "plain";
  const userContent = (
    text: string,
    variant: typeof prefixInputVariant | typeof currentInputVariant,
    evidenceSuffix: string,
  ): readonly unknown[] => {
    if (variant === "plain") {
      return [{ type: "text", text, text_elements: [] }];
    }
    if (variant === "textElement") {
      return [{
        type: "text",
        text,
        text_elements: [{
          byteRange: { start: 0, end: Math.min(4, Buffer.byteLength(text, "utf8")) },
          placeholder: `structured-${evidenceSuffix}`,
        }],
      }];
    }
    const structured = variant === "image" || variant === "imageOnly"
      ? { type: "image", url: `https://example.test/${evidenceSuffix}.png` }
      : variant === "localImage"
        ? { type: "localImage", path: `/tmp/${evidenceSuffix}.png` }
        : variant === "skill"
          ? { type: "skill", name: "fixture-skill", path: `/tmp/${evidenceSuffix}` }
          : { type: "mention", name: "fixture-mention", path: `/tmp/${evidenceSuffix}` };
    return variant === "imageOnly"
      ? [structured]
      : [{ type: "text", text, text_elements: [] }, structured];
  };
  const historyTurns = () => {
    const first = {
      ...rawTurn(firstProviderTurnId, "completed", [], "notLoaded"),
      startedAt: 10,
      completedAt: unstableSecondScan && turnListCalls === 2 ? 12 : 11,
    };
    const second = {
      ...rawTurn(
        secondProviderTurnId,
        olderStatusOverride ?? "completed",
        [],
        "notLoaded",
      ),
      startedAt: 20,
      completedAt: 21,
    };
    const currentStatus = currentStatusOverride ?? "inProgress";
    const current = {
      ...rawTurn(currentProviderTurnId, currentStatus, [], "notLoaded"),
      startedAt: 30,
      completedAt: currentStatus === "completed" ? 31 : null,
    };
    return omitCurrent ? [first, second] : [first, second, current];
  };
  const historyItems = (turnId: string): readonly PinnedCodexHistoryThreadItem[] => {
    if (turnId === firstProviderTurnId) {
      return parsedHistoryItems([{
        type: "userMessage",
        id: "provider-user-1",
        clientId: "message_history0001",
        content: userContent(
          "First prompt",
          prefixInputVariant,
          mutatePrefixAttachmentBetweenScans && turnListCalls === 2 ? "second" : "first",
        ),
      }, {
        type: "reasoning",
        id: "provider-reasoning-1",
        summary: [],
        content: [],
      }, {
        type: "agentMessage",
        id: "provider-commentary-1",
        phase: "commentary",
        text: "Intermediate commentary",
        memoryCitation: null,
      }, {
        type: "agentMessage",
        id: "provider-agent-1",
        phase: nullCompletedAssistantPhase ? null : "final_answer",
        text: "First answer",
        memoryCitation: null,
      }]);
    }
    if (turnId === secondProviderTurnId) {
      return parsedHistoryItems([{
        type: "userMessage",
        id: duplicateItemIds ? "provider-user-1" : "provider-user-2",
        clientId: duplicateClientIds ? "message_history0001" : "message_history0002",
        content: [{ type: "text", text: "Second prompt", text_elements: [] }],
      }, {
        type: "dynamicToolCall",
        id: "provider-tool-2",
        namespace: null,
        tool: "fixture-tool",
        arguments: {},
        status: "completed",
        contentItems: null,
        success: true,
        durationMs: 1,
      }, ...(includeContextCompaction ? [{
        type: "contextCompaction" as const,
        id: "provider-compaction-2",
      }] : []), {
        type: "agentMessage",
        id: "provider-agent-2",
        phase: "final_answer",
        text: "Second answer",
        memoryCitation: null,
      }]);
    }
    if (turnId === currentProviderTurnId) {
      return parsedHistoryItems([{
        type: "userMessage",
        id: "provider-user-current",
        clientId: "message_historycurrent",
        content: userContent(
          "Current input must stay separate",
          currentInputVariant,
          "current",
        ),
      }]);
    }
    return [];
  };
  const requests: RecordedRequest[] = [];
  const service = new SessionService({
    accounts: accountPort(requests, ({ key, input }) => {
      if (key === "threadStart") {
        return {
          thread: rawThread(sessionCwd, {
            id: providerThreadId,
            turns: [
              rawTurn(firstProviderTurnId, "completed"),
              rawTurn(secondProviderTurnId, "completed"),
              rawTurn(currentProviderTurnId, "inProgress"),
            ],
          }),
        };
      }
      if (key === "threadTurnsList") {
        turnListCalls += 1;
        abortAfterResponse?.abort();
        return {
          data: historyTurns(),
          nextCursor: cyclicTurns ? "cycle" : null,
          backwardsCursor: null,
        };
      }
      if (key === "threadItemsList") {
        const turnId = "turnId" in input && typeof input.turnId === "string"
          ? input.turnId
          : null;
        return {
          data: turnId === null ? [] : historyItems(turnId),
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected request key: ${key}`);
    }, { generation: 7, streamPosition: 40 }),
    emit: () => undefined,
  });
  try {
    const { thread } = await service.startThread({
      accountProfileId,
      title: "Harness history",
      workspaceMode: "local",
      workspacePath: directory,
    });
    if (thread.activeTurn === null) throw new Error("Expected active history caller");
    service.handleRuntimeState(accountProfileId, { type: "starting", generation: 7 });
    const signal = new AbortController().signal;
    const first = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(first).toMatchObject({
      coverage: "complete",
      throughTurnId: thread.activeTurn.id,
      sourceGeneration: 7,
      sourceStreamPosition: 48,
      items: [
        { ordinal: 0, itemClass: "userMessage", text: "First prompt" },
        { ordinal: 3, itemClass: "assistantMessage", text: "First answer" },
        { ordinal: 4, itemClass: "userMessage", text: "Second prompt" },
        { ordinal: 6, itemClass: "assistantMessage", text: "Second answer" },
      ],
    });
    expect(first.coverageWitnessDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain("provider-harness");
    expect(JSON.stringify(first)).not.toContain("Intermediate commentary");
    expect(JSON.stringify(first)).not.toContain("Current input must stay separate");
    const firstHistoryRequests = requests.slice(1);
    expect(firstHistoryRequests.map(({ key }) => key)).toEqual([
      "threadTurnsList",
      "threadItemsList",
      "threadItemsList",
      "threadItemsList",
      "threadTurnsList",
      "threadItemsList",
      "threadItemsList",
      "threadItemsList",
    ]);
    expect(firstHistoryRequests[0]).toMatchObject({
      accountProfileId,
      input: {
        threadId: providerThreadId,
        cursor: null,
        limit: 128,
        sortDirection: "asc",
        itemsView: "notLoaded",
      },
    });
    const repeated = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(repeated.items).toEqual(first.items);
    expect(repeated.coverageWitnessDigest).toBe(first.coverageWitnessDigest);
    expect(repeated.sourceStreamPosition).toBe(56);
    expect(requests.some(({ key }) => key === "threadRead")).toBeFalse();

    const admission = await service.readHarnessContextAdmission(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(admission.completedHistory.items).toEqual(first.items);
    expect(admission.currentInput).toMatchObject({
      turnId: thread.activeTurn.id,
      sourceGeneration: 7,
      sourceStreamPosition: 64,
      text: "Current input must stay separate",
    });
    expect(admission.currentInput.coverageWitnessDigest)
      .toBe(admission.completedHistory.coverageWitnessDigest);
    expect(JSON.stringify(admission.completedHistory))
      .not.toContain(admission.currentInput.text);

    const requestsBeforePreAbort = requests.length;
    const preAborted = new AbortController();
    preAborted.abort();
    expect(await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      preAborted.signal,
    ).then(() => null, (reason: unknown) => reason)).toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(requestsBeforePreAbort);

    const postAborted = new AbortController();
    abortAfterResponse = postAborted;
    expect(await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      postAborted.signal,
    ).then(() => null, (reason: unknown) => reason)).toMatchObject({ name: "AbortError" });
    abortAfterResponse = null;

    turnListCalls = 0;
    unstableSecondScan = true;
    const unstable = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(unstable).toMatchObject({ coverage: "partial", items: [] });
    expect(unstable.coverageWitnessDigest).toMatch(/^[a-f0-9]{64}$/u);
    unstableSecondScan = false;

    turnListCalls = 0;
    cyclicTurns = true;
    const incomplete = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(incomplete).toMatchObject({ coverage: "partial", items: [] });
    cyclicTurns = false;

    turnListCalls = 0;
    olderStatusOverride = "failed";
    const nonCompletedPrefix = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(nonCompletedPrefix).toMatchObject({ coverage: "partial", items: [] });
    olderStatusOverride = null;

    turnListCalls = 0;
    includeContextCompaction = true;
    const compacted = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(compacted).toMatchObject({ coverage: "partial", items: [] });
    includeContextCompaction = false;

    turnListCalls = 0;
    mutatePrefixAttachmentBetweenScans = true;
    prefixInputVariant = "image";
    const attachmentMutation = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(attachmentMutation).toMatchObject({ coverage: "partial", items: [] });
    mutatePrefixAttachmentBetweenScans = false;
    prefixInputVariant = "plain";

    for (const variant of [
      "image",
      "localImage",
      "skill",
      "mention",
      "textElement",
    ] as const) {
      turnListCalls = 0;
      prefixInputVariant = variant;
      expect(await service.readHarnessCompletedHistory(
        thread.id,
        thread.activeTurn.id,
        7,
        signal,
      )).toMatchObject({ coverage: "partial", items: [] });
    }
    prefixInputVariant = "plain";

    turnListCalls = 0;
    nullCompletedAssistantPhase = true;
    expect(await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    )).toMatchObject({ coverage: "partial", items: [] });
    nullCompletedAssistantPhase = false;

    for (const variant of [
      "imageOnly",
      "localImage",
      "skill",
      "mention",
      "textElement",
    ] as const) {
      turnListCalls = 0;
      currentInputVariant = variant;
      expect(await service.readHarnessCompletedHistory(
        thread.id,
        thread.activeTurn.id,
        7,
        signal,
      )).toMatchObject({ coverage: "partial", items: [] });
      expect(await service.readHarnessContextAdmission(
        thread.id,
        thread.activeTurn.id,
        7,
        signal,
      ).then(() => null, (reason: unknown) => reason)).toMatchObject({ code: "conflict" });
    }
    currentInputVariant = "plain";

    turnListCalls = 0;
    duplicateClientIds = true;
    const duplicateClient = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(duplicateClient).toMatchObject({
      coverage: "unavailable",
      throughTurnId: null,
      items: [],
    });
    duplicateClientIds = false;

    turnListCalls = 0;
    duplicateItemIds = true;
    const duplicateItem = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(duplicateItem).toMatchObject({ coverage: "unavailable", items: [] });
    duplicateItemIds = false;

    turnListCalls = 0;
    omitCurrent = true;
    const missingCurrent = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(missingCurrent).toMatchObject({ coverage: "unavailable", items: [] });
    omitCurrent = false;

    turnListCalls = 0;
    currentStatusOverride = "completed";
    const inactiveCurrent = await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      7,
      signal,
    );
    expect(inactiveCurrent).toMatchObject({ coverage: "unavailable", items: [] });
    currentStatusOverride = null;

    const requestsBeforeMissingCaller = requests.length;
    expect(await service.readHarnessCompletedHistory(
      thread.id,
      ownedCodexId("turn", accountProfileId, "provider-missing-turn"),
      7,
      signal,
    ).then(() => null, (reason: unknown) => reason)).toMatchObject({ code: "conflict" });
    expect(requests).toHaveLength(requestsBeforeMissingCaller);

    const requestsBeforeWrongGeneration = requests.length;
    expect(await service.readHarnessCompletedHistory(
      thread.id,
      thread.activeTurn.id,
      6,
      signal,
    ).then(() => null, (reason: unknown) => reason)).toMatchObject({ code: "conflict" });
    expect(requests).toHaveLength(requestsBeforeWrongGeneration);
    expect(await service.readHarnessCompletedHistory(
      "thread_not_owned_by_runtime",
      thread.activeTurn.id,
      7,
      signal,
    ).then(() => null, (reason: unknown) => reason)).toMatchObject({ code: "not_found" });
  } finally {
    service.handleRuntimeState(accountProfileId, { type: "stopped", generation: 7 });
    await rm(directory, { recursive: true, force: true });
  }
});
