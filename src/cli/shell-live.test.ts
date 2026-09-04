import { describe, expect, test } from "bun:test";

import type { CommandResponse, LocalCommand } from "../domain/contracts";
import type { SessionEvent, SessionEventPage } from "../domain/session-events";
import {
  projectPublicProviderIdentifier,
  projectPublicSessionEventBody,
} from "../public-provider-identifier";
import { ShellLiveObserver } from "./shell-live";

const sessionOne = `sess_${"1".repeat(32)}`;
const sessionTwo = `sess_${"2".repeat(32)}`;
const account = `acct_${"a".repeat(32)}`;
const streamEpoch = "90000000-0000-4000-8000-000000000001";
const privateUserPath = ["", "Users", "person", "private"].join("/");
const privateFolderPath = ["", "Users", "person", "Folder"].join("/");
const publicProviderIdentifierKey = new Uint8Array(32).fill(17);
const publicProviderIdentifier = (value: string) =>
  projectPublicProviderIdentifier(value, publicProviderIdentifierKey);
const cursorWireSignature = "A".repeat(43);
const cursorWire = (labelOrWire: string): string => labelOrWire.startsWith("hra1.")
  ? labelOrWire
  : `hra1.${Buffer.from(`fixture:${labelOrWire}`).toString("base64url")}.${cursorWireSignature}`;

const ok = (data: unknown): CommandResponse => ({
  data,
  ok: true,
  requestId: crypto.randomUUID(),
  version: 1,
});

const event = (
  sessionId: string,
  sequence: number,
  body: SessionEvent["body"],
): SessionEvent => ({
  version: 1,
  sessionId,
  streamEpoch,
  sequence,
  recordedAt: 1_700_000_000_000 + sequence,
  accountId: account,
  providerGeneration: 1,
  providerConnectionId: null,
  body: projectPublicSessionEventBody(
    body,
    publicProviderIdentifier,
  ) as SessionEvent["body"],
});

const page = (
  sessionId: string,
  requestedCursor: string,
  nextCursor: string,
  events: readonly SessionEvent[],
): SessionEventPage => ({
  version: 1,
  sessionId,
  requestedCursor: cursorWire(requestedCursor),
  retentionFloorCursor: cursorWire("floor"),
  observedThroughCursor: cursorWire(nextCursor),
  nextCursor: cursorWire(nextCursor),
  gap: null,
  events: [...events],
});

const status = (
  sessionId: string,
  cursor: string,
  pendingInteractions: readonly unknown[] = [],
  pendingInteractionsNextCursor: string | null = null,
): unknown => ({
  version: 1,
  session: { id: sessionId },
  providerObservation: {
    connectionId: "90000000-0000-4000-8000-000000000099",
    mode: "resubscribed",
    profileGeneration: 2,
    state: "live",
  },
  eventStream: { cursor: cursorWire(cursor) },
  pendingInteractions,
  pendingInteractionsNextCursor,
});

const statusV2 = (
  sessionId: string,
  cursor: string,
  responseInFlightCount = 0,
): unknown => ({
  version: 2,
  session: {
    id: sessionId,
    accountId: account,
    projectId: null,
    title: "Observed session",
    execution: "active",
    activeTurnId: publicProviderIdentifier("turn-live"),
    revision: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
  },
  advisory: {
    execution: "active",
    attention: responseInFlightCount > 0 ? "response_in_flight" : "none",
    queueDepth: 0,
  },
  localObservation: {
    source: "sqlite",
    coverage: "complete",
    freshness: "fresh",
    observedAt: 1_700_000_000_001,
  },
  providerObservation: {
    source: "codex_app_server",
    basis: "provider_read",
    state: "live",
    coverage: "complete",
    freshness: "fresh",
    profileGeneration: 2,
    observedAt: 1_700_000_000_001,
    connectionId: "90000000-0000-4000-8000-000000000099",
    mode: "resubscribed",
  },
  eventStream: {
    streamEpoch,
    floorSequence: 1,
    observedThroughSequence: 0,
    cursor: cursorWire(cursor),
    retentionFloorCursor: cursorWire("floor"),
  },
  interactions: {
    pendingCount: 0,
    responseInFlightCount,
    pending: [],
    truncated: false,
  },
  queue: {
    depth: 0,
    dispatchingCount: 0,
    ambiguousCount: 0,
    failedCount: 0,
  },
});

const pendingInteraction = (id: string, sessionId = sessionOne): unknown => ({
  id,
  sessionId,
  kind: "command_approval",
  state: "pending",
  revision: 1,
  blocking: true,
  display: { summary: `Pending ${id}` },
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for shell live observation.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === null) throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    },
  };
};

describe("persistent shell live observation", () => {
  test("fails closed instead of downgrading malformed or unknown status versions", async () => {
    let rendered = "";
    let daemonCalls = 0;
    const observer = new ShellLiveObserver({
      callDaemon: () => {
        daemonCalls += 1;
        return new Promise<CommandResponse>(() => undefined);
      },
      write: (value) => { rendered += value; },
    });
    const legacyFields = {
      session: { id: sessionOne },
      providerObservation: {
        connectionId: "90000000-0000-4000-8000-000000000099",
        mode: "resubscribed",
        profileGeneration: 2,
        state: "live",
      },
      eventStream: { cursor: cursorWire("c0") },
      pendingInteractions: [],
      pendingInteractionsNextCursor: null,
    };

    await observer.select({
      session: sessionOne,
      statusData: { version: 2, ...legacyFields },
    });
    await observer.select({
      session: sessionOne,
      statusData: { version: 99, ...legacyFields },
    });
    await observer.stop();

    expect(rendered.match(/matching resumable event cursor/gu)).toHaveLength(2);
    expect(daemonCalls).toBe(0);
  });

  test("surfaces distinct consecutive lifecycle events with identical presentation", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c3", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-identical-presentation",
            itemId: "assistant-one",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "item_started",
            turnId: "turn-identical-presentation",
            itemId: "assistant-two",
            itemKind: "assistant",
          }),
          event(sessionOne, 3, {
            type: "turn_completed",
            turnId: "turn-identical-presentation",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered.match(/Item started: assistant\./gu)).toHaveLength(2);
  });

  test("coalesces safe assistant and reasoning display while withholding raw tool data and paths", async () => {
    let rendered = "";
    let request = 0;
    const requestedCursors: Array<string | undefined> = [];
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        requestedCursors.push(command.cursor);
        if (request === 1) {
          return Promise.resolve(ok(page(sessionOne, "c0", "c1", [
            event(sessionOne, 1, { type: "item_started", turnId: "turn-1", itemId: "assistant-1", itemKind: "assistant" }),
            event(sessionOne, 2, { type: "assistant_delta", turnId: "turn-1", itemId: "assistant-1", text: "done " }),
          ])));
        }
        if (request > 2) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, "c1", "c12", [
          event(sessionOne, 3, { type: "assistant_delta", turnId: "turn-1", itemId: "assistant-1", text: `and verified ${privateUserPath} ` }),
          event(sessionOne, 4, { type: "item_started", turnId: "turn-1", itemId: "reason-1", itemKind: "reasoning" }),
          event(sessionOne, 5, { type: "reasoning_summary_delta", turnId: "turn-1", itemId: "reason-1", text: "Checking " }),
          event(sessionOne, 6, { type: "reasoning_summary_delta", turnId: "turn-1", itemId: "reason-1", text: "the release." }),
          event(sessionOne, 7, {
            type: "tool_progress",
            turnId: "turn-1",
            itemId: "tool-1",
            toolKind: "command",
            server: "local",
            tool: "shell_exec",
            status: "completed",
            outputBytesObserved: 99_999,
          }),
          event(sessionOne, 8, {
            type: "item_started",
            turnId: "turn-1",
            itemId: "mcp-1",
            itemKind: "mcpToolCall",
            server: "github",
            tool: "create_issue",
          }),
          event(sessionOne, 9, {
            type: "item_completed",
            turnId: "turn-1",
            itemId: "mcp-1",
            itemKind: "mcpToolCall",
            server: "github",
            tool: "create_issue",
            status: "completed",
          }),
          event(sessionOne, 10, {
            type: "file_change",
            turnId: "turn-1",
            itemId: "files-1",
            status: "completed",
            paths: [{ kind: "modified", path: "/private/raw/secret.ts" }],
            omittedPaths: 0,
          }),
          event(sessionOne, 11, { type: "warning", code: "NOTICE", message: "token=abcd1234 at /tmp/private" }),
          event(sessionOne, 12, { type: "turn_completed", turnId: "turn-1", status: "completed" }),
        ])));
      },
      coalesceMs: 5,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered.match(/Codex\n/gu)).toHaveLength(1);
    expect(rendered).toContain("done and verified [local-path]");
    expect(rendered.match(/Reasoning summary\n/gu)).toHaveLength(1);
    expect(rendered).toContain("Checking the release.");
    expect(rendered).toContain("Tool: command local/shell_exec, completed.");
    expect(rendered).toContain("Item started: mcpToolCall github/create_issue.");
    expect(rendered).toContain("Item completed: mcpToolCall github/create_issue (completed).");
    expect(rendered).toContain("Files: completed, 1 visible change.");
    expect(rendered).toContain("[protected] at [local-path]");
    expect(rendered).not.toContain(privateUserPath);
    expect(rendered).not.toContain("/private/raw");
    expect(rendered).not.toContain("99999");
    expect(rendered).not.toContain("{\"version\"");
    expect(requestedCursors.slice(0, 2)).toEqual([
      cursorWire("c0"),
      cursorWire("c1"),
    ]);
  });

  test("keeps hostile reasoning-summary interleaving isolated by summary part", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c5", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-reasoning-parts",
            itemId: "reasoning-parts",
            itemKind: "reasoning",
          }),
          event(sessionOne, 2, {
            type: "reasoning_summary_delta",
            turnId: "turn-reasoning-parts",
            itemId: "reasoning-parts",
            summaryPart: 0,
            text: "Authorization: Bear",
          }),
          event(sessionOne, 3, {
            type: "reasoning_summary_delta",
            turnId: "turn-reasoning-parts",
            itemId: "reasoning-parts",
            summaryPart: 1,
            text: "independent safe summary",
          }),
          event(sessionOne, 4, {
            type: "reasoning_summary_delta",
            turnId: "turn-reasoning-parts",
            itemId: "reasoning-parts",
            summaryPart: 0,
            text: "er PART-ZERO-SECRET",
          }),
          event(sessionOne, 5, {
            type: "item_completed",
            turnId: "turn-reasoning-parts",
            itemId: "reasoning-parts",
            itemKind: "reasoning",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Item completed: reasoning"));
    await observer.stop();

    expect(rendered).toContain("independent safe summary");
    expect(rendered).toContain("[protected]");
    expect(rendered).not.toContain("PART-ZERO-SECRET");
    expect(rendered).not.toContain("Authorization: Bear");
  });

  test("shows pending interactions from the status snapshot once without protected answers", async () => {
    let rendered = "";
    const never = new Promise<CommandResponse>(() => undefined);
    const observer = new ShellLiveObserver({
      callDaemon: () => never,
      write: (value) => { rendered += value; },
    });
    const interactionId = "70000000-0000-4000-8000-000000000001";
    await observer.select({
      session: sessionOne,
      statusData: status(sessionOne, "c0", [{
        id: interactionId,
        sessionId: sessionOne,
        kind: "user_input",
        state: "pending",
        revision: 3,
        blocking: true,
        display: {
          summary: "Choose a release channel",
          questions: [{ answer: "protected-answer-must-not-render" }],
        },
        response: { answer: "protected-answer-must-not-render" },
      }]),
    });
    await observer.stop();

    expect(rendered).toContain(`Interaction required: user input ${interactionId}`);
    expect(rendered).toContain("revision 3, blocking");
    expect(rendered).toContain("Choose a release channel");
    expect(rendered).toContain(`Show: /interaction show ${interactionId}`);
    expect(rendered).toContain("does not carry complete decision authority");
    expect(rendered).not.toContain(`/answer ${interactionId} --revision 3`);
    expect(rendered).not.toContain("protected-answer-must-not-render");
  });

  test("renders exact kind-specific show, inspection, and resolution commands", async () => {
    let rendered = "";
    const never = new Promise<CommandResponse>(() => undefined);
    const observer = new ShellLiveObserver({
      callDaemon: () => never,
      write: (value) => { rendered += value; },
    });
    const interactions = [
      {
        id: "70000000-0000-4000-8000-000000000011",
        kind: "command_approval",
        display: {
          kind: "command_approval",
          summary: "Run verification",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once", "decline"],
        },
      },
      {
        id: "70000000-0000-4000-8000-000000000012",
        kind: "file_change_approval",
        display: {
          kind: "file_change_approval",
          summary: "Apply reviewed changes",
          reason: null,
          grantRoot: null,
          availableDecisions: ["decline", "cancel"],
        },
      },
      {
        id: "70000000-0000-4000-8000-000000000013",
        kind: "permission_approval",
        display: {
          kind: "permission_approval",
          summary: "Grant network access",
          reason: null,
          requested: [{ name: "network" }],
          allowsSessionScope: false,
        },
      },
      {
        id: "70000000-0000-4000-8000-000000000014",
        kind: "mcp_elicitation",
        display: {
          kind: "mcp_elicitation",
          summary: "Complete a provider form",
          serverName: "provider",
          mode: "form",
          url: null,
          mayContainSecrets: true,
          fields: [],
        },
      },
    ] as const;
    await observer.select({
      session: sessionOne,
      statusData: status(sessionOne, "c0", interactions.map((interaction, index) => ({
        ...interaction,
        sessionId: sessionOne,
        state: "pending",
        revision: index + 4,
        blocking: true,
      }))),
    });
    await observer.stop();

    for (const { id } of interactions) {
      expect(rendered).toContain(`Show: /interaction show ${id}`);
    }
    expect(rendered).toContain(`/inspect ${interactions[0].id} --revision 4`);
    expect(rendered).toContain(`/approve ${interactions[0].id} --revision 4`);
    expect(rendered).toContain(`/decline ${interactions[1].id} --revision 5`);
    expect(rendered).toContain(`/interaction decide ${interactions[1].id} --revision 5 --decision cancel`);
    expect(rendered).toContain(`/inspect ${interactions[2].id} --revision 6`);
    expect(rendered).toContain(`/grant ${interactions[2].id} --revision 6`);
    expect(rendered).toContain(`/submit ${interactions[3].id} --revision 7 --action accept`);
  });

  test("offers only decisions carried by complete current interaction displays", async () => {
    let rendered = "";
    const observer = new ShellLiveObserver({
      callDaemon: () => new Promise<CommandResponse>(() => undefined),
      write: (value) => { rendered += value; },
    });
    const commandId = "70000000-0000-4000-8000-000000000021";
    const fileId = "70000000-0000-4000-8000-000000000022";
    const permissionId = "70000000-0000-4000-8000-000000000023";
    await observer.select({
      session: sessionOne,
      statusData: status(sessionOne, "c0", [
        {
          id: commandId,
          sessionId: sessionOne,
          kind: "command_approval",
          state: "pending",
          revision: 1,
          blocking: true,
          display: {
            kind: "command_approval",
            summary: "Reject only",
            reason: null,
            commandClass: "test",
            workingDirectory: null,
            availableDecisions: ["decline"],
          },
        },
        {
          id: fileId,
          sessionId: sessionOne,
          kind: "file_change_approval",
          state: "pending",
          revision: 2,
          blocking: true,
          display: {
            kind: "file_change_approval",
            summary: "Unsafe approval choices plus cancel",
            reason: null,
            grantRoot: null,
            availableDecisions: ["once", "session", "cancel"],
          },
        },
        {
          id: permissionId,
          sessionId: sessionOne,
          kind: "permission_approval",
          state: "pending",
          revision: 3,
          blocking: true,
          display: {
            kind: "permission_approval",
            summary: "No grantable permissions",
            reason: null,
            requested: [],
            allowsSessionScope: false,
          },
        },
      ]),
    });
    await observer.stop();

    expect(rendered).toContain(`/decline ${commandId} --revision 1`);
    expect(rendered).not.toContain(`/approve ${commandId}`);
    expect(rendered).toContain(`/interaction decide ${fileId} --revision 2 --decision cancel`);
    expect(rendered).not.toContain(`/decline ${fileId}`);
    expect(rendered).not.toContain(`/approve ${fileId}`);
    expect(rendered).toContain(`/decline ${permissionId} --revision 3`);
    expect(rendered).not.toContain(`/grant ${permissionId}`);
  });

  test("drains every pending interaction page before following from the status event cursor", async () => {
    let rendered = "";
    const calls: LocalCommand[] = [];
    const ids = Array.from({ length: 101 }, (_, index) =>
      `71000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        calls.push(command);
        if (command.kind === "session.interactions") {
          return Promise.resolve(ok({
            sessionId: sessionOne,
            interactions: [pendingInteraction(ids[100] as string)],
            nextCursor: null,
          }));
        }
        if (command.kind !== "session.events") throw new Error("Expected interaction drain before events.");
        if (calls.filter((candidate) => candidate.kind === "session.events").length > 1) {
          return new Promise<CommandResponse>(() => undefined);
        }
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c1", [
          event(sessionOne, 1, { type: "turn_completed", turnId: "turn-after-drain", status: "completed" }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({
      session: sessionOne,
      statusData: status(
        sessionOne,
        "status-event-cursor",
        ids.slice(0, 100).map((id) => pendingInteraction(id)),
        "interaction-page-2",
      ),
    });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain(ids[0] as string);
    expect(rendered).toContain(ids[100] as string);
    expect(calls[0]).toEqual({
      kind: "session.interactions",
      session: sessionOne,
      pending: true,
      limit: 100,
      cursor: "interaction-page-2",
    });
    expect(calls[1]).toMatchObject({
      kind: "session.events",
      session: sessionOne,
      cursor: cursorWire("status-event-cursor"),
    });
  });

  test("does not replay an older required prompt after a v2 status drains its prepared revision", async () => {
    let rendered = "";
    const preparedId = "71100000-0000-4000-8000-000000000001";
    const calls: LocalCommand[] = [];
    let eventReads = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        calls.push(command);
        if (command.kind === "session.interactions") {
          return Promise.resolve(ok({
            sessionId: sessionOne,
            interactions: [{
              ...(pendingInteraction(preparedId) as Record<string, unknown>),
              revision: 2,
              state: "response_prepared",
            }],
            nextCursor: null,
          }));
        }
        if (command.kind !== "session.events") throw new Error("Expected event follow after drain.");
        eventReads += 1;
        if (eventReads > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "event-next", [
          event(sessionOne, 1, {
            type: "interaction_requested",
            interactionId: preparedId,
            interactionKind: "command_approval",
            revision: 1,
            blocking: true,
            summary: "Older required event",
          }),
          event(sessionOne, 2, {
            type: "interaction_state",
            interactionId: preparedId,
            state: "response_prepared",
            revision: 2,
          }),
          event(sessionOne, 3, {
            type: "turn_completed",
            turnId: "turn-after-prepared",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });
    await observer.select({
      session: sessionOne,
      statusData: statusV2(sessionOne, "status-event-cursor", 1),
    });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain(`Interaction in progress: command approval ${preparedId}`);
    expect(rendered).not.toContain(`Interaction required: command approval ${preparedId}`);
    expect(calls[0]).toEqual({
      kind: "session.interactions",
      session: sessionOne,
      pending: true,
      limit: 100,
    });
  });

  test("continues on the new epoch after an empty restored-stream gap page", async () => {
    let rendered = "";
    let eventReads = 0;
    const restoredEpoch = "90000000-0000-4000-8000-000000000099";
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") {
          throw new Error("Legacy fixture should proceed directly to event follow.");
        }
        eventReads += 1;
        if (eventReads === 1) {
          return Promise.resolve(ok(page(sessionOne, "old-0", "old-1", [
            event(sessionOne, 1, { type: "warning", code: "OLD", message: "old epoch" }),
          ])));
        }
        if (eventReads === 2) {
          return Promise.resolve(ok({
            ...page(sessionOne, "old-1", "restored-0", []),
            gap: { reason: "stream_restored", requestedSequence: 1, retainedFromSequence: 1 },
          }));
        }
        if (eventReads === 3) {
          return Promise.resolve(ok(page(sessionOne, "restored-0", "restored-1", [{
            ...event(sessionOne, 1, {
              type: "warning",
              code: "RESTORED",
              message: "new epoch accepted",
            }),
            streamEpoch: restoredEpoch,
          }])));
        }
        return new Promise<CommandResponse>(() => undefined);
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({
      session: sessionOne,
      statusData: status(sessionOne, "old-0"),
    });
    await waitUntil(() => rendered.includes("new epoch accepted"));
    await observer.stop();

    expect(rendered).not.toContain("invalid event page");
    expect(eventReads).toBeGreaterThanOrEqual(3);
  });

  test("rejects a cross-page sequence discontinuity", async () => {
    for (const secondEvent of [
      event(sessionOne, 3, { type: "warning", code: "SKIP", message: "skipped sequence" }),
    ]) {
      let rendered = "";
      let eventReads = 0;
      const observer = new ShellLiveObserver({
        callDaemon: (command) => {
          if (command.kind !== "session.events") throw new Error("Expected event follow.");
          eventReads += 1;
          if (eventReads === 1) {
            return Promise.resolve(ok(page(sessionOne, "c0", "c1", [
              event(sessionOne, 1, { type: "warning", code: "FIRST", message: "first event" }),
            ])));
          }
          if (eventReads === 2) {
            return Promise.resolve(ok(page(sessionOne, "c1", "c2", [secondEvent])));
          }
          return new Promise<CommandResponse>(() => undefined);
        },
        coalesceMs: 0,
        write: (value) => { rendered += value; },
      });

      await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
      await waitUntil(() => rendered.includes("invalid event page"));
      await observer.stop();

      expect(eventReads).toBe(2);
      expect(rendered).not.toContain(secondEvent.body.type === "warning"
        ? secondEvent.body.message
        : "unreachable");
    }
  });

  test("rejects the old epoch after an empty restored-stream gap page", async () => {
    let rendered = "";
    let eventReads = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected event follow.");
        eventReads += 1;
        if (eventReads === 1) {
          return Promise.resolve(ok(page(sessionOne, "old-0", "old-1", [
            event(sessionOne, 1, { type: "warning", code: "OLD", message: "old epoch" }),
          ])));
        }
        if (eventReads === 2) {
          return Promise.resolve(ok({
            ...page(sessionOne, "old-1", "restored-0", []),
            gap: { reason: "stream_restored", requestedSequence: 1, retainedFromSequence: 1 },
          }));
        }
        if (eventReads === 3) {
          return Promise.resolve(ok(page(sessionOne, "restored-0", "restored-1", [
            event(sessionOne, 1, { type: "warning", code: "STALE", message: "stale epoch reused" }),
          ])));
        }
        return new Promise<CommandResponse>(() => undefined);
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "old-0") });
    await waitUntil(() => rendered.includes("invalid event page"));
    await observer.stop();

    expect(eventReads).toBe(3);
    expect(rendered).not.toContain("stale epoch reused");
  });

  test("rejects an empty no-gap page that advances its checkpoint", async () => {
    let rendered = "";
    let eventReads = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected event follow.");
        eventReads += 1;
        return Promise.resolve(ok(page(sessionOne, "c0", "c1", [])));
      },
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("invalid event page"));
    await observer.stop();

    expect(eventReads).toBe(1);
  });

  test("rejects a restored page containing more than one stream epoch", async () => {
    let rendered = "";
    let eventReads = 0;
    const restoredEpoch = "90000000-0000-4000-8000-000000000098";
    const foreignEpoch = "90000000-0000-4000-8000-000000000097";
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected event follow.");
        eventReads += 1;
        return Promise.resolve(ok({
          ...page(sessionOne, command.cursor ?? "", "restored-1", [
            {
              ...event(sessionOne, 1, { type: "warning", code: "ONE", message: "first epoch" }),
              streamEpoch: restoredEpoch,
            },
            {
              ...event(sessionOne, 2, { type: "warning", code: "TWO", message: "foreign epoch" }),
              streamEpoch: foreignEpoch,
            },
          ]),
          gap: { reason: "stream_restored", requestedSequence: 1, retainedFromSequence: 1 },
        }));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({
      session: sessionOne,
      statusData: status(sessionOne, "old-0"),
    });
    await waitUntil(() => rendered.includes("invalid event page"));
    await observer.stop();

    expect(eventReads).toBe(1);
    expect(rendered).not.toContain("first epoch");
    expect(rendered).not.toContain("foreign epoch");
  });

  test("fails closed on duplicate or nonadvancing pending interaction pages", async () => {
    const interactionId = "72000000-0000-4000-8000-000000000001";
    for (const response of [
      { sessionId: sessionOne, interactions: [pendingInteraction(interactionId)], nextCursor: null },
      { sessionId: sessionOne, interactions: [], nextCursor: "same-cursor" },
    ]) {
      let rendered = "";
      const calls: LocalCommand[] = [];
      const initial = response.interactions.length === 0 ? [] : [pendingInteraction(interactionId)];
      const observer = new ShellLiveObserver({
        callDaemon: (command) => {
          calls.push(command);
          return Promise.resolve(ok(response));
        },
        write: (value) => { rendered += value; },
      });
      await observer.select({
        session: sessionOne,
        statusData: status(sessionOne, "event-cursor", initial, "same-cursor"),
      });
      await waitUntil(() => rendered.includes("could not safely enumerate every pending interaction"));
      await observer.stop();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.kind).toBe("session.interactions");
      expect(calls.some((command) => command.kind === "session.events")).toBe(false);
    }
  });

  test("fails closed when a later pending page repeats an earlier cursor", async () => {
    let rendered = "";
    const calls: LocalCommand[] = [];
    const responses = [
      {
        sessionId: sessionOne,
        interactions: [pendingInteraction("72100000-0000-4000-8000-000000000001")],
        nextCursor: "cursor-b",
      },
      {
        sessionId: sessionOne,
        interactions: [pendingInteraction("72100000-0000-4000-8000-000000000002")],
        nextCursor: "cursor-a",
      },
    ];
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        calls.push(command);
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected cursor request.");
        return Promise.resolve(ok(response));
      },
      write: (value) => { rendered += value; },
    });
    await observer.select({
      session: sessionOne,
      statusData: status(sessionOne, "event-cursor", [], "cursor-a"),
    });
    await waitUntil(() => rendered.includes("could not safely enumerate every pending interaction"));
    await observer.stop();
    expect(calls.map((command) => command.kind)).toEqual([
      "session.interactions",
      "session.interactions",
    ]);
  });

  test("fails closed when a pending page request fails or returns another session", async () => {
    for (const response of [
      null,
      { sessionId: sessionTwo, interactions: [], nextCursor: null },
    ]) {
      let rendered = "";
      const calls: LocalCommand[] = [];
      const observer = new ShellLiveObserver({
        callDaemon: (command) => {
          calls.push(command);
          return response === null
            ? Promise.reject(new Error("page unavailable"))
            : Promise.resolve(ok(response));
        },
        write: (value) => { rendered += value; },
      });
      await observer.select({
        session: sessionOne,
        statusData: status(sessionOne, "event-cursor", [], "interaction-page"),
      });
      await waitUntil(() => rendered.includes("could not safely enumerate every pending interaction"));
      await observer.stop();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.kind).toBe("session.interactions");
      expect(calls.some((command) => command.kind === "session.events")).toBe(false);
    }
  });

  test("shows prepared and written interactions as in progress without inviting resubmission", async () => {
    let rendered = "";
    const observer = new ShellLiveObserver({
      callDaemon: () => new Promise<CommandResponse>(() => undefined),
      write: (value) => { rendered += value; },
    });
    await observer.select({
      session: sessionOne,
      statusData: status(sessionOne, "event-cursor", [
        {
          ...(pendingInteraction("73000000-0000-4000-8000-000000000001") as Record<string, unknown>),
          state: "response_prepared",
        },
        {
          ...(pendingInteraction("73000000-0000-4000-8000-000000000002") as Record<string, unknown>),
          state: "response_written",
        },
      ]),
    });
    await observer.stop();

    expect(rendered.match(/Interaction in progress:/gu)).toHaveLength(2);
    expect(rendered).toContain("A response is prepared. Do not resubmit it.");
    expect(rendered).toContain("awaiting provider acknowledgement. Do not resubmit it.");
    expect(rendered).not.toContain("Interaction required:");
    expect(rendered).not.toContain("Use /interactions to inspect it.");
  });

  test("cancels the old cursor follower before observing a newly selected session", async () => {
    let rendered = "";
    const requests: Array<Readonly<{
      command: Extract<LocalCommand, { kind: "session.events" }>;
      response: Deferred<CommandResponse>;
    }>> = [];
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        const response = deferred<CommandResponse>();
        requests.push({ command, response });
        return response.promise;
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "one-0") });
    await waitUntil(() => requests.length === 1);
    await observer.select({ session: sessionTwo, statusData: status(sessionTwo, "two-0") });
    await waitUntil(() => requests.length === 2);

    requests[0]?.response.resolve(ok(page(sessionOne, "one-0", "one-1", [
      event(sessionOne, 1, { type: "assistant_delta", turnId: "old", itemId: "old", text: "old selection must stay silent" }),
    ])));
    requests[1]?.response.resolve(ok(page(sessionTwo, "two-0", "two-2", [
      event(sessionTwo, 1, { type: "item_started", turnId: "new", itemId: "new", itemKind: "assistant" }),
      event(sessionTwo, 2, { type: "assistant_delta", turnId: "new", itemId: "new", text: "new selection update" }),
      event(sessionTwo, 3, { type: "turn_completed", turnId: "new", status: "completed" }),
    ])));
    await waitUntil(() => rendered.includes("new selection update"));
    await observer.stop();

    expect(rendered).toContain("new selection update");
    expect(rendered).not.toContain("old selection must stay silent");
    expect(requests[0]?.command).toMatchObject({
      session: sessionOne,
      cursor: cursorWire("one-0"),
    });
    expect(requests[1]?.command).toMatchObject({
      session: sessionTwo,
      cursor: cursorWire("two-0"),
    });
  });

  test("omits mid-item delta suffixes until an observed item-start boundary", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c2", [
          event(sessionOne, 1, {
            type: "assistant_delta",
            turnId: "turn-mid-item",
            itemId: "assistant-mid-item",
            text: "sensitive-filename-from-an-earlier-path",
          }),
          event(sessionOne, 2, {
            type: "turn_completed",
            turnId: "turn-mid-item",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("trustworthy item-start boundary");
    expect(rendered).not.toContain("sensitive-filename-from-an-earlier-path");
  });

  test("stops promptly while a daemon long poll remains unresolved", async () => {
    let requested = false;
    let underlyingAborted = false;
    const observer = new ShellLiveObserver({
      callDaemon: (_command, signal) => {
        requested = true;
        return new Promise<CommandResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            underlyingAborted = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
      write: () => undefined,
    });
    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => requested);

    const stopped = observer.stop().then(() => "stopped" as const);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100));
    expect(await Promise.race([stopped, timeout])).toBe("stopped");
    expect(underlyingAborted).toBe(true);
  });

  test("uses Unicode scalars consistently when reporting delta truncation", async () => {
    let rendered = "";
    let request = 0;
    const emoji = "🚀".repeat(5_000);
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c2", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-unicode",
            itemId: "assistant-unicode",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-unicode",
            itemId: "assistant-unicode",
            text: emoji,
          }),
          event(sessionOne, 3, { type: "turn_completed", turnId: "turn-unicode", status: "completed" }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain(emoji);
    expect(rendered).not.toContain("additional delta text omitted");
  });

  test("redacts a JWT that crosses the live display cutoff before bounding output", async () => {
    let rendered = "";
    let request = 0;
    const jwt = `eyJ${"A".repeat(100)}.${"B".repeat(100)}.${"C".repeat(100)}`;
    const exposedPrefix = `eyJ${"A".repeat(75)}`;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c2", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-secret-boundary",
            itemId: "assistant-secret-boundary",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-secret-boundary",
            itemId: "assistant-secret-boundary",
            text: `${"x".repeat(8_099)} ${jwt}`,
          }),
          event(sessionOne, 3, {
            type: "turn_completed",
            turnId: "turn-secret-boundary",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("[protected]");
    expect(rendered).not.toContain(exposedPrefix);
    expect(rendered).not.toContain(jwt);
  });

  test("preserves trusted prose that merely contains credential-like fragments", async () => {
    let rendered = "";
    let request = 0;
    const prose = "Please re-run token usage in SLOVAKIA with moneyJar. A simple example follows. The negotiable instrument matures tomorrow.";
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c3", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-trusted-prose",
            itemId: "assistant-trusted-prose",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-trusted-prose",
            itemId: "assistant-trusted-prose",
            text: prose,
          }),
          event(sessionOne, 3, {
            type: "turn_completed",
            turnId: "turn-trusted-prose",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain(prose);
    expect(rendered).not.toContain("[protected]");
  });

  test("preserves joined Unicode prose and later deltas without secret evidence", async () => {
    let rendered = "";
    let request = 0;
    const family = "👨‍👩‍👧‍👦";
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c4", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-family",
            itemId: "assistant-family",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-family",
            itemId: "assistant-family",
            text: `Family ${family}`,
          }),
          event(sessionOne, 3, {
            type: "assistant_delta",
            turnId: "turn-family",
            itemId: "assistant-family",
            text: " rest of answer",
          }),
          event(sessionOne, 4, {
            type: "turn_completed",
            turnId: "turn-family",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain(`Family ${family} rest of answer`);
    expect(rendered).not.toContain("[protected]");
  });

  test("enters JWT redaction at the first credible segment across a long split payload", async () => {
    let rendered = "";
    let request = 0;
    const first = `eyJ${"A".repeat(20)}.${"B".repeat(100)}`;
    const second = `.${"C".repeat(20)}`;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c5", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-split-jwt",
            itemId: "assistant-split-jwt",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-split-jwt",
            itemId: "assistant-split-jwt",
            text: first,
          }),
          event(sessionOne, 3, {
            type: "token_usage",
            turnId: "turn-split-jwt",
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
            modelContextWindow: 10_000,
          }),
          event(sessionOne, 4, {
            type: "assistant_delta",
            turnId: "turn-split-jwt",
            itemId: "assistant-split-jwt",
            text: second,
          }),
          event(sessionOne, 5, {
            type: "turn_completed",
            turnId: "turn-split-jwt",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("[protected]");
    expect(rendered).not.toContain(first);
    expect(rendered).not.toContain(second);
  });

  test("fails closed before a JWT candidate can cross the streaming carry bound", async () => {
    let rendered = "";
    let request = 0;
    const first = `eyJ${"A".repeat(200)}`;
    const second = `.${"B".repeat(20)}.${"C".repeat(20)}`;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c5", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-long-split-jwt",
            itemId: "assistant-long-split-jwt",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-long-split-jwt",
            itemId: "assistant-long-split-jwt",
            text: first,
          }),
          event(sessionOne, 3, {
            type: "token_usage",
            turnId: "turn-long-split-jwt",
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
            modelContextWindow: 10_000,
          }),
          event(sessionOne, 4, {
            type: "assistant_delta",
            turnId: "turn-long-split-jwt",
            itemId: "assistant-long-split-jwt",
            text: second,
          }),
          event(sessionOne, 5, {
            type: "turn_completed",
            turnId: "turn-long-split-jwt",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("[protected]");
    expect(rendered).not.toContain("A".repeat(200));
    expect(rendered).not.toContain(second);
  });

  test("fails closed before a UNC server candidate can cross the streaming carry bound", async () => {
    let rendered = "";
    let request = 0;
    const first = `path=\\\\${"server".repeat(34)}`;
    const second = "\\share\\private.txt";
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c5", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-long-split-unc",
            itemId: "assistant-long-split-unc",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-long-split-unc",
            itemId: "assistant-long-split-unc",
            text: first,
          }),
          event(sessionOne, 3, {
            type: "token_usage",
            turnId: "turn-long-split-unc",
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
            modelContextWindow: 10_000,
          }),
          event(sessionOne, 4, {
            type: "assistant_delta",
            turnId: "turn-long-split-unc",
            itemId: "assistant-long-split-unc",
            text: second,
          }),
          event(sessionOne, 5, {
            type: "turn_completed",
            turnId: "turn-long-split-unc",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("[local-path]");
    expect(rendered).not.toContain("server".repeat(34));
    expect(rendered).not.toContain(second);
  });

  test("retains the longest bounded assignment prefix across delta flushes", async () => {
    let rendered = "";
    let request = 0;
    const prefix = `verification_code${" ".repeat(32)}:${" ".repeat(25)}`;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c5", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-long-assignment",
            itemId: "assistant-long-assignment",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-long-assignment",
            itemId: "assistant-long-assignment",
            text: prefix,
          }),
          event(sessionOne, 3, {
            type: "token_usage",
            turnId: "turn-long-assignment",
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
            modelContextWindow: 10_000,
          }),
          event(sessionOne, 4, {
            type: "assistant_delta",
            turnId: "turn-long-assignment",
            itemId: "assistant-long-assignment",
            text: `${" ".repeat(7)}hunter2`,
          }),
          event(sessionOne, 5, {
            type: "turn_completed",
            turnId: "turn-long-assignment",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("[protected]");
    expect(rendered).not.toContain("verification_code");
    expect(rendered).not.toContain("hunter2");
  });

  test("keeps an incomplete credential masked across timed delta flushes", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: async (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request === 1) {
          return ok(page(sessionOne, command.cursor ?? "", "c1", [
            event(sessionOne, 1, {
              type: "item_started",
              turnId: "turn-split-secret",
              itemId: "assistant-split-secret",
              itemKind: "assistant",
            }),
            event(sessionOne, 2, {
              type: "assistant_delta",
              turnId: "turn-split-secret",
              itemId: "assistant-split-secret",
              text: `${"visible ".repeat(10)}sk_ABCD`,
            }),
          ]));
        }
        if (request === 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          return ok(page(sessionOne, command.cursor ?? "", "c3", [
            event(sessionOne, 3, {
              type: "assistant_delta",
              turnId: "turn-split-secret",
              itemId: "assistant-split-secret",
              text: "EFGHIJKL",
            }),
            event(sessionOne, 4, {
              type: "turn_completed",
              turnId: "turn-split-secret",
              status: "completed",
            }),
          ]));
        }
        return await new Promise<CommandResponse>(() => undefined);
      },
      coalesceMs: 5,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("visible visible");
    expect(rendered).toContain("[protected]");
    expect(rendered).not.toContain("sk_ABCD");
    expect(rendered).not.toContain("EFGHIJKL");
    expect(rendered).not.toContain("sk_ABCDEFGHIJKL");
  });

  test("retains redaction state across interleaved non-delta events", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c4", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-interleaved-secret",
            itemId: "assistant-interleaved-secret",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-interleaved-secret",
            itemId: "assistant-interleaved-secret",
            text: "s",
          }),
          event(sessionOne, 3, {
            type: "token_usage",
            turnId: "turn-interleaved-secret",
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
            modelContextWindow: 10_000,
          }),
          event(sessionOne, 4, {
            type: "assistant_delta",
            turnId: "turn-interleaved-secret",
            itemId: "assistant-interleaved-secret",
            text: "k-proj-ABCDEFGH",
          }),
          event(sessionOne, 5, {
            type: "turn_completed",
            turnId: "turn-interleaved-secret",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("[protected]");
    expect(rendered).not.toContain("sk-proj-ABCDEFGH");
  });

  test("redacts credential assignments in warnings and across split delta labels", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c8", [
          event(sessionOne, 1, {
            type: "warning",
            code: "AUTH",
            message: [
              "password=hunter2!warning,Secret;Tail cookie=\"quoted secret tail\"",
              `Authorization${" ".repeat(33)}: Bearer ALIGNEDHEADERSECRET123`,
              `password${" ".repeat(33)}=ALIGNEDPASSWORDSECRET456`,
              "client_secret=CLIENTSECRET789",
              "AWS_SECRET_ACCESS_KEY=AWSOPAQUESECRET123",
              "OPENAI_API_KEY=OPENAIOPAQUESECRET456",
              "clientSecret=CAMELCLIENTSECRET123",
              "apiKey=CAMELAPIKEYSECRET456",
              "accessToken=CAMELACCESSTOKEN789",
              "refreshToken=CAMELREFRESHTOKEN123",
              "secretAccessKey=CAMELSECRETACCESSKEY456",
              "api key=SPACEDAPISECRET123",
              "access token=SPACEDTOKENSECRET456",
            ].join("\n"),
          }),
          event(sessionOne, 2, {
            type: "item_started",
            turnId: "turn-split-label",
            itemId: "assistant-split-label",
            itemKind: "assistant",
          }),
          event(sessionOne, 3, {
            type: "assistant_delta",
            turnId: "turn-split-label",
            itemId: "assistant-split-label",
            text: "pass",
          }),
          event(sessionOne, 4, {
            type: "token_usage",
            turnId: "turn-split-label",
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
            modelContextWindow: 10_000,
          }),
          event(sessionOne, 5, {
            type: "assistant_delta",
            turnId: "turn-split-label",
            itemId: "assistant-split-label",
            text: "word=p@",
          }),
          event(sessionOne, 6, {
            type: "token_usage",
            turnId: "turn-split-label",
            inputTokens: 2,
            cachedInputTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 0,
            totalTokens: 4,
            modelContextWindow: 10_000,
          }),
          event(sessionOne, 7, {
            type: "assistant_delta",
            turnId: "turn-split-label",
            itemId: "assistant-split-label",
            text: "ssword!delta-secret-value",
          }),
          event(sessionOne, 8, {
            type: "turn_completed",
            turnId: "turn-split-label",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered.match(/\[protected\]/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(rendered).not.toContain("warning,Secret;Tail");
    expect(rendered).not.toContain("quoted secret tail");
    expect(rendered).not.toContain("delta-secret-value");
    expect(rendered).not.toContain("@ssword");
    expect(rendered).not.toContain("ALIGNEDHEADERSECRET123");
    expect(rendered).not.toContain("ALIGNEDPASSWORDSECRET456");
    expect(rendered).not.toContain("CLIENTSECRET789");
    expect(rendered).not.toContain("AWSOPAQUESECRET123");
    expect(rendered).not.toContain("OPENAIOPAQUESECRET456");
    expect(rendered).not.toContain("CAMELCLIENTSECRET123");
    expect(rendered).not.toContain("CAMELAPIKEYSECRET456");
    expect(rendered).not.toContain("CAMELACCESSTOKEN789");
    expect(rendered).not.toContain("CAMELREFRESHTOKEN123");
    expect(rendered).not.toContain("CAMELSECRETACCESSKEY456");
    expect(rendered).not.toContain("SPACEDAPISECRET123");
    expect(rendered).not.toContain("SPACEDTOKENSECRET456");
  });

  test("redacts authorization schemes and multi-part cookie headers across event boundaries", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c10", [
          event(sessionOne, 1, {
            type: "warning",
            code: "AUTH",
            message: [
              "Authorization: Bearer SUPERSECRETTOKEN123",
              "Cookie: first=secret; second=also-secret",
              "access_token=Bearer GENERICSECRETTOKEN789",
              "request failed with Bearer abc123",
              "Basic dTpw",
              "BEARER upper123",
              "BASIC dTpw2",
              "bEaReR mixed123",
            ].join("\n"),
          }),
          event(sessionOne, 2, {
            type: "item_started",
            turnId: "turn-split-authorization",
            itemId: "assistant-split-authorization",
            itemKind: "assistant",
          }),
          event(sessionOne, 3, {
            type: "assistant_delta",
            turnId: "turn-split-authorization",
            itemId: "assistant-split-authorization",
            text: "Authorization: Be",
          }),
          event(sessionOne, 4, {
            type: "token_usage",
            turnId: "turn-split-authorization",
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
            modelContextWindow: 10_000,
          }),
          event(sessionOne, 5, {
            type: "assistant_delta",
            turnId: "turn-split-authorization",
            itemId: "assistant-split-authorization",
            text: "arer SPLITSECRETTOKEN456",
          }),
          event(sessionOne, 6, {
            type: "item_started",
            turnId: "turn-split-authorization",
            itemId: "assistant-split-generic-scheme",
            itemKind: "assistant",
          }),
          event(sessionOne, 7, {
            type: "assistant_delta",
            turnId: "turn-split-authorization",
            itemId: "assistant-split-generic-scheme",
            text: "access_token=Ba",
          }),
          event(sessionOne, 8, {
            type: "token_usage",
            turnId: "turn-split-authorization",
            inputTokens: 2,
            cachedInputTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 0,
            totalTokens: 4,
            modelContextWindow: 10_000,
          }),
          event(sessionOne, 9, {
            type: "assistant_delta",
            turnId: "turn-split-authorization",
            itemId: "assistant-split-generic-scheme",
            text: "sic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
          }),
          event(sessionOne, 10, {
            type: "turn_completed",
            turnId: "turn-split-authorization",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered.match(/\[protected\]/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(rendered).not.toContain("SUPERSECRETTOKEN123");
    expect(rendered).not.toContain("also-secret");
    expect(rendered).not.toContain("SPLITSECRETTOKEN456");
    expect(rendered).not.toContain("GENERICSECRETTOKEN789");
    expect(rendered).not.toContain("QWxhZGRpbjpvcGVuIHNlc2FtZQ");
    expect(rendered).not.toContain("abc123");
    expect(rendered).not.toContain("dTpw");
    expect(rendered).not.toContain("upper123");
    expect(rendered).not.toContain("mixed123");
  });

  test("never emits a completed strong introducer while waiting for its value", async () => {
    let rendered = "";
    let request = 0;
    const cases = [
      {
        itemId: "assistant-delayed-cookie",
        prefix: `Cookie:${" ".repeat(200)}`,
        secret: "session_id=SESSIONSECRET123456789; theme=dark",
      },
      {
        itemId: "assistant-delayed-password",
        prefix: `password=${" ".repeat(200)}`,
        secret: "HUNTERSECRET123",
      },
      {
        itemId: "assistant-delayed-bearer",
        prefix: `Bearer ${" ".repeat(200)}`,
        secret: "OTHERWISEUNRECOGNIZEDCREDENTIAL",
      },
      {
        itemId: "assistant-delayed-authorization-delimiter",
        prefix: `Authorization${" ".repeat(200)}`,
        secret: ": Bearer DELAYEDHEADERSECRET123",
      },
      {
        itemId: "assistant-delayed-password-delimiter",
        prefix: `password${" ".repeat(200)}`,
        secret: "=DELAYEDPASSWORDSECRET456",
      },
      {
        itemId: "assistant-split-short-bearer",
        prefix: "Bear",
        secret: "er abc123",
      },
      {
        itemId: "assistant-split-short-basic",
        prefix: "Ba",
        secret: "sic dTpw",
      },
      {
        itemId: "assistant-delayed-prefixed-api-key",
        prefix: `OPENAI_API_KEY${" ".repeat(200)}`,
        secret: "=DELAYEDPREFIXEDSECRET123",
      },
      {
        itemId: "assistant-split-client-secret",
        prefix: "client_",
        secret: "secret=SPLITCLIENTSECRET456",
      },
      {
        itemId: "assistant-control-split-password",
        prefix: "pass\u001b",
        secret: "word=CONTROLWORDSECRET123",
      },
      {
        itemId: "assistant-long-control-split-password",
        prefix: `pass\u200bword${" ".repeat(200)}`,
        secret: "=LONGCONTROLWORDSECRET123",
      },
      {
        itemId: "assistant-long-zwj-split-password",
        prefix: `pass\u200dword${" ".repeat(200)}`,
        secret: "=JOINERSECRET123",
      },
      {
        itemId: "assistant-long-zwnj-split-password",
        prefix: `pass\u200cword${" ".repeat(200)}`,
        secret: "=NONJOINERSECRET123",
      },
      {
        itemId: "assistant-variation-password",
        prefix: "pass\ufe0fword=",
        secret: "VARIATIONSECRET123",
      },
      {
        itemId: "assistant-cgj-password",
        prefix: "pass\u034fword=",
        secret: "CGJSECRET456",
      },
      {
        itemId: "assistant-control-split-github-token",
        prefix: "github_\u001b",
        secret: "pat_CONTROLGITHUBSECRET456",
      },
      {
        itemId: "assistant-format-split-project-token",
        prefix: "sk-\u200b",
        secret: "proj-CONTROLPROJECTSECRET789",
      },
      {
        itemId: "assistant-nbsp-assignment",
        prefix: "password\u00a0",
        secret: "=\u00a0NBSPSECRET123",
      },
      {
        itemId: "assistant-thin-space-assignment",
        prefix: "password\u2009",
        secret: "=\u2009THINSPACESECRET456",
      },
      {
        itemId: "assistant-narrow-nbsp-assignment",
        prefix: "password\u202f",
        secret: "=\u202fNARROWNBSPSECRET789",
      },
      {
        itemId: "assistant-json-key-assignment",
        prefix: '{"client_secret"',
        secret: ':"JSONCLIENTSECRET123"}',
      },
    ] as const;
    const events = cases.flatMap((entry, index) => {
      const sequence = index * 3 + 1;
      return [
        event(sessionOne, sequence, {
          type: "item_started" as const,
          turnId: "turn-delayed-strong-introducers",
          itemId: entry.itemId,
          itemKind: "assistant" as const,
        }),
        event(sessionOne, sequence + 1, {
          type: "assistant_delta" as const,
          turnId: "turn-delayed-strong-introducers",
          itemId: entry.itemId,
          text: entry.prefix,
        }),
        event(sessionOne, sequence + 2, {
          type: "token_usage" as const,
          turnId: "turn-delayed-strong-introducers",
          inputTokens: index + 1,
          cachedInputTokens: 0,
          outputTokens: index + 1,
          reasoningOutputTokens: 0,
          totalTokens: (index + 1) * 2,
          modelContextWindow: 10_000,
        }),
      ];
    });
    for (const [index, entry] of cases.entries()) {
      events.push(event(sessionOne, cases.length * 3 + index + 1, {
        type: "assistant_delta",
        turnId: "turn-delayed-strong-introducers",
        itemId: entry.itemId,
        text: entry.secret,
      }));
    }
    events.push(event(sessionOne, cases.length * 4 + 1, {
      type: "turn_completed",
      turnId: "turn-delayed-strong-introducers",
      status: "completed",
    }));
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", `c${String(events.length)}`, events)));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered.match(/\[protected\]/gu)?.length).toBeGreaterThanOrEqual(cases.length);
    for (const entry of cases) expect(rendered).not.toContain(entry.secret);
    expect(rendered).not.toContain("NBSPSECRET123");
    expect(rendered).not.toContain("THINSPACESECRET456");
    expect(rendered).not.toContain("NARROWNBSPSECRET789");
    expect(rendered).not.toContain("JSONCLIENTSECRET123");
  });

  test("discards undecided state when a provider repeats an item-start boundary", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c5", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-repeated-start",
            itemId: "assistant-repeated-start",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-repeated-start",
            itemId: "assistant-repeated-start",
            text: "s",
          }),
          event(sessionOne, 3, {
            type: "item_started",
            turnId: "turn-repeated-start",
            itemId: "assistant-repeated-start",
            itemKind: "assistant",
          }),
          event(sessionOne, 4, {
            type: "assistant_delta",
            turnId: "turn-repeated-start",
            itemId: "assistant-repeated-start",
            text: "k_ABCDEFGH",
          }),
          event(sessionOne, 5, {
            type: "turn_completed",
            turnId: "turn-repeated-start",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("repeated an item-start boundary");
    expect(rendered).not.toContain("sk_ABCDEFGH");
  });

  test("suppresses an absolute path continuation across delta boundaries", async () => {
    let rendered = "";
    let request = 0;
    const sensitiveFilename = "private-filename-".repeat(12);
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c3", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-split-path",
            itemId: "assistant-split-path",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-split-path",
            itemId: "assistant-split-path",
            text: `${privateUserPath}/`,
          }),
          event(sessionOne, 3, {
            type: "assistant_delta",
            turnId: "turn-split-path",
            itemId: "assistant-split-path",
            text: sensitiveFilename,
          }),
          event(sessionOne, 4, {
            type: "turn_completed",
            turnId: "turn-split-path",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("[local-path]");
    expect(rendered).not.toContain(privateUserPath);
    expect(rendered).not.toContain(sensitiveFilename.slice(-32));
  });

  test("suppresses quoted and escaped-space absolute paths through their real boundary", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c8", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-quoted-paths",
            itemId: "assistant-quoted-path",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-quoted-paths",
            itemId: "assistant-quoted-path",
            text: `Working on "${privateFolderPath}/VERY PRIVATE/private-name.ts" now`,
          }),
          event(sessionOne, 3, {
            type: "item_started",
            turnId: "turn-quoted-paths",
            itemId: "assistant-split-quoted-path",
            itemKind: "assistant",
          }),
          event(sessionOne, 4, {
            type: "assistant_delta",
            turnId: "turn-quoted-paths",
            itemId: "assistant-split-quoted-path",
            text: `Review '${privateFolderPath}/SECRET`,
          }),
          event(sessionOne, 5, {
            type: "assistant_delta",
            turnId: "turn-quoted-paths",
            itemId: "assistant-split-quoted-path",
            text: " AREA/private-two.ts' after",
          }),
          event(sessionOne, 6, {
            type: "item_started",
            turnId: "turn-quoted-paths",
            itemId: "assistant-escaped-path",
            itemKind: "assistant",
          }),
          event(sessionOne, 7, {
            type: "assistant_delta",
            turnId: "turn-quoted-paths",
            itemId: "assistant-escaped-path",
            text: `Using ${privateFolderPath}/ESCAPED\\ SPACE/private-three.ts now`,
          }),
          event(sessionOne, 8, {
            type: "turn_completed",
            turnId: "turn-quoted-paths",
            status: "completed",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered.match(/\[local-path\]/gu)).toHaveLength(3);
    expect(rendered).toContain('Working on "[local-path]');
    expect(rendered).toContain("Review '[local-path]");
    expect(rendered).toContain("Using [local-path]");
    expect(rendered).toContain('" now');
    expect(rendered).toContain("' after");
    expect(rendered).not.toContain("VERY PRIVATE");
    expect(rendered).not.toContain("SECRET AREA");
    expect(rendered).not.toContain("ESCAPED\\ SPACE");
    expect(rendered).not.toContain("private-name.ts");
    expect(rendered).not.toContain("private-two.ts");
    expect(rendered).not.toContain("private-three.ts");
  });

  test("pauses delta text instead of recreating an evicted redaction state", async () => {
    let rendered = "";
    let request = 0;
    const turnId = "turn-redactor-cap";
    const oldestItem = "assistant-oldest";
    const events: SessionEvent[] = [
      event(sessionOne, 1, {
        type: "item_started",
        turnId,
        itemId: oldestItem,
        itemKind: "assistant",
      }),
      event(sessionOne, 2, {
        type: "assistant_delta",
        turnId,
        itemId: oldestItem,
        text: `${privateUserPath}/`,
      }),
    ];
    for (let index = 0; index < 32; index += 1) {
      const itemId = `assistant-${String(index)}`;
      events.push(
        event(sessionOne, 3 + index * 2, {
          type: "item_started",
          turnId,
          itemId,
          itemKind: "assistant",
        }),
        event(sessionOne, 4 + index * 2, {
          type: "assistant_delta",
          turnId,
          itemId,
          text: `ordinary-${String(index)}`,
        }),
      );
    }
    events.push(
      event(sessionOne, 67, {
        type: "assistant_delta",
        turnId,
        itemId: oldestItem,
        text: "sensitive-filename-must-not-render",
      }),
      event(sessionOne, 68, { type: "turn_completed", turnId, status: "completed" }),
    );
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c68", events)));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("bounded redaction state was exhausted");
    expect(rendered).not.toContain("sensitive-filename-must-not-render");
  });

  test("discards an undecided redaction suffix across an event gap", async () => {
    let rendered = "";
    let request = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        request += 1;
        if (request === 1) {
          return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c1", [
            event(sessionOne, 1, {
              type: "item_started",
              turnId: "turn-gap-secret",
              itemId: "assistant-gap-secret",
              itemKind: "assistant",
            }),
            event(sessionOne, 2, {
              type: "assistant_delta",
              turnId: "turn-gap-secret",
              itemId: "assistant-gap-secret",
              text: "s",
            }),
          ])));
        }
        if (request === 2) {
          return Promise.resolve(ok({
            ...page(sessionOne, command.cursor ?? "", "c3", [
              event(sessionOne, 3, {
                type: "assistant_delta",
                turnId: "turn-gap-secret",
                itemId: "assistant-gap-secret",
                text: "k_ABCDEFGH",
              }),
              event(sessionOne, 4, {
                type: "turn_completed",
                turnId: "turn-gap-secret",
                status: "completed",
              }),
            ]),
            gap: {
              reason: "provider_restart" as const,
              requestedSequence: 1,
              retainedFromSequence: 3,
            },
          }));
        }
        return new Promise<CommandResponse>(() => undefined);
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => rendered.includes("Turn completed."));
    await observer.stop();

    expect(rendered).toContain("redaction boundary was incomplete");
    expect(rendered).not.toContain("sk_ABCDEFGH");
  });

  test("discards an undecided redaction suffix when observation stops", async () => {
    let rendered = "";
    let requests = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        requests += 1;
        if (requests > 1) return new Promise<CommandResponse>(() => undefined);
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c1", [
          event(sessionOne, 1, {
            type: "item_started",
            turnId: "turn-stop-tail",
            itemId: "assistant-stop-tail",
            itemKind: "assistant",
          }),
          event(sessionOne, 2, {
            type: "assistant_delta",
            turnId: "turn-stop-tail",
            itemId: "assistant-stop-tail",
            text: "undecided-private-tail",
          }),
        ])));
      },
      coalesceMs: 0,
      write: (value) => { rendered += value; },
    });

    await observer.select({ session: sessionOne, statusData: status(sessionOne, "c0") });
    await waitUntil(() => requests > 1);
    await observer.stop();

    expect(rendered).toContain("observation ended before its redaction boundary completed");
    expect(rendered).not.toContain("undecided-private-tail");
  });

  test("degrades a throwing live display without rejecting or poisoning shell cleanup", async () => {
    let requests = 0;
    const observer = new ShellLiveObserver({
      callDaemon: (command) => {
        if (command.kind !== "session.events") throw new Error("Expected an event request.");
        requests += 1;
        return Promise.resolve(ok(page(sessionOne, command.cursor ?? "", "c1", [
          event(sessionOne, 1, { type: "turn_completed", turnId: "turn-1", status: "completed" }),
        ])));
      },
      write: () => { throw new Error("terminal write failed"); },
    });

    await expect(observer.select({
      session: sessionOne,
      statusData: status(sessionOne, "c0"),
    })).resolves.toBeUndefined();
    await waitUntil(() => requests === 1);
    await expect(observer.stop()).resolves.toBeUndefined();
    await expect(observer.stop()).resolves.toBeUndefined();
  });
});
