import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import type { LocalCommand } from "../domain/contracts";
import {
  createStoredAccountUsageSnapshot,
  storedAccountUsageSnapshotSchema,
} from "../domain/usage-metrics";
import type {
  CodexAccountProjection,
  CodexRuntimePort,
  CodexSessionProjection,
  CloudControlPort,
  ProfileAuthority,
} from "../daemon/ports";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../storage/paths";
import {
  USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
  StateStore,
} from "../storage/state-store";
import { cloudLimits } from "./contracts";
import type {
  CloudDaemonBridge,
  CloudDaemonCycleResult,
  CloudLocalCommandAuthority,
} from "./daemon-bridge";
import { BridgedCloudControl, StateBackedCloudDaemonAdapter } from "./daemon-adapters";
import type { CloudRemoteControlPort } from "./local-control";

const privateRootFixture = ["", "Users", "alice", "private"].join("/");
const bearerFixture = ["Bearer", "secret-token-value"].join(" ");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class FakeCodex implements CodexRuntimePort {
  projection: CodexSessionProjection = {
    providerThreadId: "thread_0001",
    providerUpdatedAt: 1_000,
    title: "Provider title",
    status: "idle",
    messages: [
      { role: "user", text: `Read \`${privateRootFixture}/repo/key.ts\``, turnId: "turn_0001" },
      { role: "assistant", text: `Done ${bearerFixture}`, turnId: "turn_0001" },
    ],
    turnSummaries: [{
      id: "turn_0001",
      status: "completed",
      runtimeMs: 1_250,
      files: ["src/index.ts", `${privateRootFixture}.ts`],
      actions: [`git status --short ${bearerFixture}`, "bun test"],
      omittedFiles: 0,
      omittedActions: 0,
    }],
  };
  readSessionCalls = 0;
  usageCalls = 0;

  login(): Promise<never> { return Promise.reject(new Error("unused")); }
  cancelLogin(): Promise<never> { return Promise.reject(new Error("unused")); }
  logout(): Promise<void> { return Promise.reject(new Error("unused")); }
  readAccount(): Promise<CodexAccountProjection> { return Promise.reject(new Error("unused")); }
  listPlugins(): Promise<never> { return Promise.reject(new Error("unused")); }
  listSessions(): ReturnType<CodexRuntimePort["listSessions"]> { return Promise.reject(new Error("unused")); }
  reviewSessionStart(): Promise<never> { return Promise.reject(new Error("unused")); }
  startSession(): Promise<never> { return Promise.reject(new Error("unused")); }
  observeSession(): ReturnType<CodexRuntimePort["observeSession"]> { return Promise.reject(new Error("unused")); }
  reviewTurnStart(): Promise<never> { return Promise.reject(new Error("unused")); }
  startTurn(): Promise<never> { return Promise.reject(new Error("unused")); }
  steer(): Promise<void> { return Promise.reject(new Error("unused")); }
  interrupt(): Promise<void> { return Promise.reject(new Error("unused")); }
  rename(): Promise<void> { return Promise.reject(new Error("unused")); }
  inspectTurn(): Promise<unknown> { return Promise.reject(new Error("unused")); }
  inspectInteractionAuthority(): ReturnType<CodexRuntimePort["inspectInteractionAuthority"]> { return Promise.reject(new Error("unused")); }
  validateInteractionResolution(): Promise<{ responseDigest: string }> { return Promise.reject(new Error("unused")); }
  resolveInteraction(): Promise<{ responseWritten: true }> { return Promise.reject(new Error("unused")); }
  validateInteractionTimeout(): Promise<{ responseDigest: string }> { return Promise.reject(new Error("unused")); }
  timeoutInteraction(): Promise<{ responseWritten: true }> { return Promise.reject(new Error("unused")); }
  close(): Promise<void> { return Promise.resolve(); }

  readSession(input: { authority: ProfileAuthority; providerThreadId: string; detail: boolean; signal: AbortSignal }): Promise<CodexSessionProjection> {
    this.readSessionCalls += 1;
    expect(input.providerThreadId).toBe("thread_0001");
    return Promise.resolve(this.projection);
  }

  readUsage(): Promise<{ revision: number; observedAt: number; payload: unknown }> {
    this.usageCalls += 1;
    return Promise.resolve({
      revision: this.usageCalls,
      observedAt: 2_000 + this.usageCalls,
      payload: {
        usage: {
          summary: {
            lifetimeTokens: 42,
            peakDailyTokens: 12,
            longestRunningTurnSec: 9,
            currentStreakDays: 2,
            longestStreakDays: 3,
          },
          dailyUsageBuckets: [{ startDate: "2026-08-22", tokens: 12 }],
        },
        rateLimits: {
          primary: {
            limitId: "primary",
            limitName: `Primary ${privateRootFixture}/secret`,
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
            secondary: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
          byLimitId: null,
        },
      },
    });
  }
}

const temporaryDirectories: string[] = [];

async function fixture(): Promise<Readonly<{
  codex: FakeCodex;
  paths: StatePaths;
  sessionId: string;
  store: StateStore;
}>> {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "hra-cloud-adapter-")));
  temporaryDirectories.push(temporary);
  const paths = resolveStatePaths({ homeDirectory: temporary, platform: "linux" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: () => 1_000 });
  const profile = store.createProfile(`Personal \`${privateRootFixture}/profile\``);
  const current = store.nextProfileGeneration(profile.id);
  expect(store.setProfileState(current.id, current.processGeneration, "signed_in", {
    email: "person@example.com",
    plan: `file://${privateRootFixture}/plan`,
  })).toBe(true);
  const starting = store.createSession({
    profileId: current.id,
    title: `Work ${privateRootFixture}`,
    preset: "high",
    fastEnabled: true,
  });
  const bound = store.bindSession({
    sessionId: starting.id,
    expectedRevision: starting.revision,
    providerThreadId: "thread_0001",
    state: "idle",
    providerUpdatedAt: 1_000,
  });
  store.updateSessionMetadata({
    sessionId: bound.id,
    expectedRevision: bound.revision,
    note: `Local checkout: ${privateRootFixture}/repo`,
  });
  const codex = new FakeCodex();
  const usage = await codex.readUsage();
  const sourceSequence = store.allocateNextUsageRevision(current.id);
  store.recordUsage(current.id, sourceSequence, usage.observedAt, createStoredAccountUsageSnapshot({
    providerPayload: usage.payload,
    sourceSequence,
    observedAt: usage.observedAt,
    receivedAt: usage.observedAt,
    accountFingerprint: null,
    providerGeneration: current.processGeneration,
    daemonGeneration: 1,
    previousPayload: null,
  }));
  return { codex, paths, sessionId: bound.id, store };
}

function beginTurnProfileBinding(value: Awaited<ReturnType<typeof fixture>>, input: Readonly<{
  fast: boolean;
  preset: "low" | "high" | "ultra";
}>): Readonly<{ attemptId: `attempt_${string}`; profile: Parameters<StateStore["recordSessionRuntimeProfile"]>[0]["profile"] }> {
  const session = value.store.requireSession(value.sessionId);
  const profile = value.store.requireProfileById(session.profileId);
  const runtime = {
    profileId: profile.id,
    processGeneration: profile.processGeneration,
    observedAt: 2_000,
    preset: input.preset,
    model: input.preset === "low" ? "gpt-5.6-luna" : "gpt-5.6-sol",
    reasoningEffort: input.preset === "ultra" ? "ultra" as const : "max" as const,
    serviceTier: input.fast ? "priority" as const : null,
    fast: input.fast,
    approvalPolicy: "on-request" as const,
    reviewMode: "auto_review" as const,
    permissionProfile: ":workspace" as const,
    computerUse: true as const,
    pluginCapability: true as const,
    enabledApps: [],
  };
  const attempt = value.store.prepareMutation({
    authorityGeneration: profile.processGeneration,
    authorityId: session.id,
    kind: "session.send",
    request: { message: "fixture" },
  });
  value.store.beginSessionMutationEffect({
    attemptId: attempt.id,
    evidence: {
      baseline: { activeTurnId: null, providerUpdatedAt: session.providerUpdatedAt ?? null, status: "idle" },
      clientMessageId: attempt.id,
      kind: "session.send",
      messageDigest: "a".repeat(64),
      providerThreadId: session.providerThreadId ?? "thread_0001",
      runtimeProfile: runtime,
    },
    profileGeneration: profile.processGeneration,
    sessionId: session.id,
  });
  return { attemptId: attempt.id as `attempt_${string}`, profile: runtime };
}

function admitCloudInteraction(
  value: Awaited<ReturnType<typeof fixture>>,
  publicId: string,
  connectionId: string,
): void {
  const session = value.store.requireSession(value.sessionId);
  const profile = value.store.requireProfileById(session.profileId);
  value.store.admitInteraction({
    authority: {
      approvalId: null,
      connectionId,
      itemId: null,
      method: "mcp/elicitation/create",
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      requestDigest: "d".repeat(64),
      requestId: { type: "string", value: `request_${publicId}` },
      threadId: session.providerThreadId ?? null,
      turnId: null,
    },
    blocking: true,
    display: {
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "fixture",
      summary: "Review provider input",
      url: null,
    },
    kind: "mcp_elicitation",
    publicId,
    sessionId: value.sessionId as `sess_${string}`,
  });
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const temporary = temporaryDirectories.pop();
    if (temporary !== undefined) await rm(temporary, { force: true, recursive: true });
  }
});

describe("state-backed cloud daemon adapter", () => {
  test("persists bounded compact sequences and projects polled usage without exporting local paths", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    let adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
      now: () => 5_000,
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const { sessions } = await adapter.listSessions({ limit: 25, signal });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        publicId: value.sessionId,
        metadata: {
          name: "Work [local-path]",
          note: "Local checkout: [local-path]",
        },
      });
      const first = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(first.complete).toBe(true);
      expect(first.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(first.events[0]).toMatchObject({ kind: "user_message", text: "Read `[local-path]`" });
      expect(JSON.stringify(first.events)).not.toContain("secret-token-value");
      expect(first.events[1]).toMatchObject({
        kind: "assistant_message",
        text: "Done [cloud projection secret omitted]",
      });
      expect(first.events[2]).toMatchObject({
        kind: "turn_summary",
        filesTouched: ["src/index.ts"],
        gitActions: [{
          kind: "status",
          label: "git status --short [cloud projection secret omitted]",
        }],
      });
      expect(first.events[2] === undefined || "model" in first.events[2]).toBe(false);
      const usage = await adapter.listUsage({ limit: 100, signal });
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        localReference: expect.stringMatching(/^acct_/),
        matchReference: "person@example.com",
        metadata: {
          label: "Personal `[local-path]`",
          plan: "[local-path]",
        },
        projection: {
          state: "ready",
          data: { lifetimeTokens: 42, limits: [{ name: "Primary [local-path]" }] },
        },
      });
      expect(JSON.stringify(usage)).not.toContain(privateRootFixture);

      adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
        paths: value.paths,
        store: value.store,
      });
      await adapter.listSessions({ limit: 25, signal });
      const replay = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(replay.events).toEqual(first.events);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("projects stable bounded local pages beyond the newest session window", async () => {
    const value = await fixture();
    const profileId = value.store.requireSession(value.sessionId).profileId;
    for (let index = 0; index < 30; index += 1) {
      const created = value.store.createSession({
        fastEnabled: false,
        preset: "high",
        profileId,
        title: `Paged ${index}`,
      });
      value.store.bindSession({
        expectedRevision: created.revision,
        providerThreadId: `thread_page_${index.toString().padStart(4, "0")}`,
        providerUpdatedAt: 2_000 + index,
        sessionId: created.id,
        state: "idle",
      });
    }
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const observed: string[] = [];
      let afterPublicId: string | null = null;
      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const page = await adapter.listSessions({
          afterPublicId,
          limit: 10,
          signal: new AbortController().signal,
        });
        observed.push(...page.sessions.map((session) => session.publicId));
        afterPublicId = page.continueAfterPublicId;
        if (page.isDone) break;
      }
      expect(observed).toHaveLength(31);
      expect(observed).toEqual([...observed].sort());
      expect(new Set(observed).size).toBe(31);
      expect(afterPublicId).toBeNull();
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("projects only bounded public interaction state and follows its terminal revision", async () => {
    const value = await fixture();
    const session = value.store.requireSession(value.sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const interactionId = "70000000-0000-4000-8000-000000000001";
    const providerRequestId = "provider_request_private_12345678";
    const providerTurnId = "provider_turn_private_12345678";
    const providerItemId = "provider_item_private_12345678";
    const providerApprovalId = "provider_approval_private_12345678";
    const privateFieldName = "provider_token_private";
    const privateChoice = ["sk", "secret_choice_12345678"].join("_");
    value.store.admitInteraction({
      authority: {
        approvalId: providerApprovalId,
        connectionId: "80000000-0000-4000-8000-000000000001",
        itemId: providerItemId,
        method: "mcp/elicitation/create",
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        requestDigest: "d".repeat(64),
        requestId: { type: "string", value: providerRequestId },
        threadId: session.providerThreadId ?? null,
        turnId: providerTurnId,
      },
      blocking: true,
      display: {
        fields: [{
          choices: [privateChoice],
          name: privateFieldName,
          required: true,
          type: "single_select",
        }],
        kind: "mcp_elicitation",
        mayContainSecrets: true,
        mode: "form",
        serverName: "private_provider_server",
        summary: `Review ${bearerFixture} at ${privateRootFixture}`,
        url: null,
      },
      kind: "mcp_elicitation",
      publicId: interactionId,
      sessionId: value.sessionId as `sess_${string}`,
    });
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const first = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(first.events.at(-1)).toEqual({
        blocking: true,
        interactionId,
        interactionKind: "mcp_elicitation",
        kind: "interaction_state",
        revision: 1,
        sequence: 4,
        state: "pending",
        summary: "An MCP server requests protected form input",
      });
      const serialized = JSON.stringify(first.events.at(-1));
      for (const privateValue of [
        providerRequestId,
        providerTurnId,
        providerItemId,
        providerApprovalId,
        privateFieldName,
        privateChoice,
        privateRootFixture,
        bearerFixture,
        "private_provider_server",
        "d".repeat(64),
      ]) expect(serialized).not.toContain(privateValue);

      value.store.expireInteraction({ id: interactionId, expectedRevision: 1 });
      await adapter.listSessions({ limit: 25, signal });
      const terminal = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(terminal.events.at(-1)).toEqual({
        blocking: true,
        interactionId,
        interactionKind: "mcp_elicitation",
        kind: "interaction_state",
        revision: 2,
        sequence: 5,
        state: "expired",
        summary: "An MCP server requests protected form input",
      });
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      })).events).toEqual(terminal.events);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("drains only an observed terminal interaction while its profile is signed out", async () => {
    const value = await fixture();
    const observedId = "70000000-0000-4000-8000-000000000201";
    const unobservedId = "70000000-0000-4000-8000-000000000202";
    admitCloudInteraction(
      value,
      observedId,
      "80000000-0000-4000-8000-000000000201",
    );
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const initial = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(initial.events.at(-1)).toMatchObject({
        interactionId: observedId,
        revision: 1,
        sequence: 4,
        state: "pending",
      });
      const initialCheckpoint = {
        cacheId: initial.cacheId,
        digest: "a".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence: 4,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(initialCheckpoint);
      await adapter.acknowledgeCompactUpload(initialCheckpoint);

      admitCloudInteraction(
        value,
        unobservedId,
        "80000000-0000-4000-8000-000000000202",
      );
      value.store.expireInteraction({ id: observedId, expectedRevision: 1 });
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);

      const readSessionCalls = value.codex.readSessionCalls;
      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);
      expect(value.codex.readSessionCalls).toBe(readSessionCalls);
      const terminal = await adapter.readCompactEvents({
        afterSequence: 4,
        limit: 128,
        remoteTailDigest: initialCheckpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(terminal.events).toEqual([{
        blocking: true,
        interactionId: observedId,
        interactionKind: "mcp_elicitation",
        kind: "interaction_state",
        revision: 2,
        sequence: 5,
        state: "expired",
        summary: "An MCP server requests protected form input",
      }]);
      expect(JSON.stringify(terminal.events)).not.toContain(unobservedId);

      const terminalCheckpoint = {
        cacheId: terminal.cacheId,
        digest: "b".repeat(64),
        expectedHeadSequence: 4,
        expectedStreamEpoch: 0,
        expectedTailDigest: initialCheckpoint.digest,
        headSequence: 5,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(terminalCheckpoint);
      expect((await adapter.listSessions({ limit: 25, signal })).sessions).toHaveLength(1);
      expect(value.codex.readSessionCalls).toBe(readSessionCalls);
      await adapter.acknowledgeCompactUpload(terminalCheckpoint);
      expect((await adapter.listSessions({ limit: 25, signal })).sessions).toEqual([]);
      expect(value.codex.readSessionCalls).toBe(readSessionCalls);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("unions newest and fair observed pages without starving an older terminal revision", async () => {
    const value = await fixture();
    const oldestId = "7fffffff-ffff-4fff-8fff-ffffffffffff";
    const interactionIds = [
      oldestId,
      ...Array.from({ length: 200 }, (_, index) =>
        `70000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`),
    ];
    admitCloudInteraction(
      value,
      oldestId,
      "8fffffff-ffff-4fff-8fff-ffffffffffff",
    );
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      for (const [index, interactionId] of interactionIds.slice(1).entries()) {
        admitCloudInteraction(
          value,
          interactionId,
          `80000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
        );
      }
      await adapter.listSessions({ limit: 25, signal });
      const initial = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      const initialHead = initial.events.at(-1)?.sequence ?? 0;
      expect(initialHead).toBe(204);
      const initialCheckpoint = {
        cacheId: initial.cacheId,
        digest: "c".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence: initialHead,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(initialCheckpoint);
      await adapter.acknowledgeCompactUpload(initialCheckpoint);

      for (const interactionId of interactionIds) {
        value.store.expireInteraction({ id: interactionId, expectedRevision: 1 });
      }
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);

      await adapter.listSessions({ limit: 25, signal });
      const firstTerminalPage = await adapter.readCompactEvents({
        afterSequence: initialHead,
        limit: 512,
        remoteTailDigest: initialCheckpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(firstTerminalPage.events).toHaveLength(201);
      expect(firstTerminalPage.events.some((event) =>
        event.kind === "interaction_state" && event.interactionId === oldestId)).toBe(true);
      const firstTerminalHead = firstTerminalPage.events.at(-1)?.sequence ?? initialHead;
      const firstTerminalCheckpoint = {
        cacheId: firstTerminalPage.cacheId,
        digest: "d".repeat(64),
        expectedHeadSequence: initialHead,
        expectedStreamEpoch: 0,
        expectedTailDigest: initialCheckpoint.digest,
        headSequence: firstTerminalHead,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(firstTerminalCheckpoint);
      await adapter.acknowledgeCompactUpload(firstTerminalCheckpoint);
      expect((await adapter.listSessions({ limit: 25, signal })).sessions).toEqual([]);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("persists a fair interaction scan and reaches item 201 while the first 200 stay pending", async () => {
    const value = await fixture();
    const interactionIds = [
      "7fffffff-ffff-4fff-8ffe-ffffffffffff",
      ...Array.from({ length: 200 }, (_, index) =>
        `70000000-0000-4000-8002-${String(index + 1).padStart(12, "0")}`),
    ];
    admitCloudInteraction(
      value,
      interactionIds[0] as string,
      "80000000-0000-4000-8002-000000000001",
    );
    let adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      for (const [index, interactionId] of interactionIds.slice(1).entries()) {
        admitCloudInteraction(
          value,
          interactionId,
          `80000000-0000-4000-8002-${String(index + 2).padStart(12, "0")}`,
        );
      }
      await adapter.listSessions({ limit: 25, signal });
      const initial = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      const pendingEvents = initial.events.filter((event) => event.kind === "interaction_state");
      expect(pendingEvents).toHaveLength(201);
      const terminalId = pendingEvents.at(-1)?.interactionId;
      expect(terminalId).toBeDefined();
      const initialHead = initial.events.at(-1)?.sequence ?? 0;
      const initialCheckpoint = {
        cacheId: initial.cacheId,
        digest: "6".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence: initialHead,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(initialCheckpoint);
      await adapter.acknowledgeCompactUpload(initialCheckpoint);

      value.store.expireInteraction({ id: terminalId as string, expectedRevision: 1 });
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);

      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);
      adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);
      const terminal = await adapter.readCompactEvents({
        afterSequence: initialHead,
        limit: 128,
        remoteTailDigest: initialCheckpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(terminal.events).toEqual([expect.objectContaining({
        interactionId: terminalId,
        revision: 2,
        state: "expired",
      })]);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("discovers the newest page while a persisted fair history cursor continues", async () => {
    const value = await fixture();
    const interactionIds = Array.from({ length: 201 }, (_, index) =>
      `71000000-0000-4000-8005-${String(index + 1).padStart(12, "0")}`);
    for (const [index, interactionId] of interactionIds.entries()) {
      admitCloudInteraction(
        value,
        interactionId,
        `81000000-0000-4000-8005-${String(index + 1).padStart(12, "0")}`,
      );
    }
    const terminalId = interactionIds.at(-1) as string;
    value.store.expireInteraction({ id: terminalId, expectedRevision: 1 });

    let adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const first = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(first.events.filter((event) => event.kind === "interaction_state"))
        .toHaveLength(200);

      adapter.close();
      const newestTerminalId = "11000000-0000-4000-8005-000000000001";
      admitCloudInteraction(
        value,
        newestTerminalId,
        "21000000-0000-4000-8005-000000000001",
      );
      value.store.expireInteraction({ id: newestTerminalId, expectedRevision: 1 });
      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      await adapter.listSessions({ limit: 25, signal });
      const complete = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      const interactions = complete.events.filter((event) => event.kind === "interaction_state");
      expect(interactions).toHaveLength(202);
      expect(interactions.find((event) => event.interactionId === terminalId)).toMatchObject({
        revision: 2,
        state: "expired",
      });
      expect(interactions.find((event) =>
        event.interactionId === newestTerminalId)).toMatchObject({
        revision: 2,
        state: "expired",
      });
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("freezes the interaction scan ceiling so continuous new rows cannot prevent wraparound", async () => {
    const value = await fixture();
    const firstId = "7fffffff-ffff-4fff-8ffd-ffffffffffff";
    const firstPageIds = Array.from({ length: 200 }, (_, index) =>
      `70000000-0000-4000-8004-${String(index + 1).padStart(12, "0")}`);
    const newerPageIds = Array.from({ length: 200 }, (_, index) =>
      `60000000-0000-4000-8004-${String(index + 1).padStart(12, "0")}`);
    admitCloudInteraction(
      value,
      firstId,
      "8fffffff-ffff-4fff-8ffd-ffffffffffff",
    );
    let adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      for (const [index, interactionId] of firstPageIds.entries()) {
        admitCloudInteraction(
          value,
          interactionId,
          `80000000-0000-4000-8004-${String(index + 1).padStart(12, "0")}`,
        );
      }
      await adapter.listSessions({ limit: 25, signal });
      for (const [index, interactionId] of newerPageIds.entries()) {
        admitCloudInteraction(
          value,
          interactionId,
          `90000000-0000-4000-8004-${String(index + 1).padStart(12, "0")}`,
        );
      }
      // Finish the frozen older discovery page, then wrap to the newer page.
      await adapter.listSessions({ limit: 25, signal });
      await adapter.listSessions({ limit: 25, signal });
      const initial = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      const interactions = initial.events.filter((event) => event.kind === "interaction_state");
      expect(interactions).toHaveLength(401);
      const initialHead = initial.events.at(-1)?.sequence ?? 0;
      const checkpoint = {
        cacheId: initial.cacheId,
        digest: "7".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence: initialHead,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(checkpoint);
      await adapter.acknowledgeCompactUpload(checkpoint);

      value.store.expireInteraction({ id: firstId, expectedRevision: 1 });
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);
      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);

      adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);
      const terminal = await adapter.readCompactEvents({
        afterSequence: initialHead,
        limit: 128,
        remoteTailDigest: checkpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(terminal.events).toEqual([expect.objectContaining({
        interactionId: firstId,
        revision: 2,
        state: "expired",
      })]);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("withholds offline heads when the compact stream ledger is semantically incoherent", async () => {
    for (const variant of [
      "epoch",
      "pending",
      "recovered_zero",
      "unsafe_sequence",
      "scan_cursor",
      "discovery_cursor",
    ] as const) {
      const value = await fixture();
      const cachePath = join(value.paths.root, "cloud-projection.sqlite");
      let adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      try {
        const signal = new AbortController().signal;
        await adapter.listSessions({ limit: 25, signal });
        const initial = await adapter.readCompactEvents({
          afterSequence: 0,
          limit: 128,
          sessionPublicId: value.sessionId,
          signal,
        });
        const checkpoint = {
          cacheId: initial.cacheId,
          digest: "a".repeat(64),
          expectedHeadSequence: 0,
          expectedStreamEpoch: 0,
          headSequence: initial.events.at(-1)?.sequence ?? 0,
          sessionPublicId: value.sessionId,
        };
        await adapter.recordCompactUploadIntent(checkpoint);
        await adapter.acknowledgeCompactUpload(checkpoint);
        adapter.close();

        const database = new Database(cachePath, { strict: true });
        if (variant === "epoch") {
          database.query(
            "UPDATE projection_sessions SET stream_epoch=1 WHERE session_id=?",
          ).run(value.sessionId);
        } else if (variant === "pending") {
          database.query(
            `UPDATE projection_remote_checkpoints
             SET pending_expected_head=head_sequence,
                 pending_expected_tail=tail_digest,
                 pending_head=head_sequence+100,
                 pending_tail=?
             WHERE session_id=?`,
          ).run("b".repeat(64), value.sessionId);
        } else if (variant === "recovered_zero") {
          database.query(
            "UPDATE projection_sessions SET stream_epoch=1 WHERE session_id=?",
          ).run(value.sessionId);
          database.query(
            `UPDATE projection_remote_checkpoints
             SET stream_epoch=1,head_sequence=0,tail_digest=NULL
             WHERE session_id=?`,
          ).run(value.sessionId);
        } else if (variant === "unsafe_sequence") {
          database.query(
            `UPDATE projection_sessions SET next_sequence=9007199254740992
             WHERE session_id=?`,
          ).run(value.sessionId);
        } else if (variant === "scan_cursor") {
          database.query(
            `UPDATE projection_sessions
             SET interaction_scan_sequence=4,interaction_scan_ceiling_sequence=4
             WHERE session_id=?`,
          ).run(value.sessionId);
        } else {
          database.query(
            `UPDATE projection_sessions SET interaction_discovery_cursor=?
             WHERE session_id=?`,
          ).run("x".repeat(50), value.sessionId);
        }
        database.close(false);
        const profile = value.store.requireProfileById(
          value.store.requireSession(value.sessionId).profileId,
        );
        expect(value.store.setProfileState(
          profile.id,
          profile.processGeneration,
          "signed_out",
        )).toBe(true);
        adapter = new StateBackedCloudDaemonAdapter({
          codex: value.codex,
          executeRemote: () => Promise.resolve({}),
          paths: value.paths,
          store: value.store,
        });

        expect((await adapter.listSessions({ limit: 25, signal })).sessions).toEqual([]);
        expect(adapter.projectionCacheStatus()).toMatchObject({
          affectedSessions: [value.sessionId],
          code: "STREAM_RECOVERY_REQUIRED",
          sessions: 1,
          state: "degraded",
        });
        await expect(adapter.readCompactEvents({
          afterSequence: checkpoint.headSequence,
          limit: 128,
          remoteTailDigest: checkpoint.digest,
          sessionPublicId: value.sessionId,
          signal,
        })).rejects.toThrow("explicit, potentially history-discarding reseed");
      } finally {
        adapter.close();
        value.store.close();
      }
    }
  });

  test("rejects compact rows whose body, count, sequence, or turn identity changed", async () => {
    for (const variant of ["body", "count", "sequence", "turn_id"] as const) {
      const value = await fixture();
      const cachePath = join(value.paths.root, "cloud-projection.sqlite");
      let adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      try {
        const signal = new AbortController().signal;
        await adapter.listSessions({ limit: 25, signal });
        adapter.close();
        const database = new Database(cachePath, { strict: true });
        if (variant === "body") {
          database.query(
            `UPDATE projection_turns
             SET events_json=json_set(events_json,'$[0].text','safe changed body')
             WHERE session_id=?`,
          ).run(value.sessionId);
        } else if (variant === "count") {
          database.query(
            "UPDATE projection_turns SET event_count=event_count+1 WHERE session_id=?",
          ).run(value.sessionId);
          database.query(
            "UPDATE projection_sessions SET next_sequence=next_sequence+1 WHERE session_id=?",
          ).run(value.sessionId);
        } else if (variant === "sequence") {
          database.query(
            `UPDATE projection_turns
             SET events_json=json_set(events_json,
               '$[0].sequence',2,'$[1].sequence',3,'$[2].sequence',4)
             WHERE session_id=?`,
          ).run(value.sessionId);
        } else {
          database.query(
            "UPDATE projection_turns SET turn_id='turn_tampered_0001' WHERE session_id=?",
          ).run(value.sessionId);
        }
        database.close(false);
        adapter = new StateBackedCloudDaemonAdapter({
          codex: value.codex,
          executeRemote: () => Promise.resolve({}),
          paths: value.paths,
          store: value.store,
        });
        await expect(adapter.readCompactEvents({
          afterSequence: 0,
          limit: 128,
          sessionPublicId: value.sessionId,
          signal,
        })).rejects.toThrow("explicit, potentially history-discarding reseed");
        expect(adapter.projectionCacheStatus()).toMatchObject({
          affectedSessions: [value.sessionId],
          code: "STREAM_RECOVERY_REQUIRED",
          state: "degraded",
        });
      } finally {
        adapter.close();
        value.store.close();
      }
    }
  });

  test("invalidates incremental ledger trust after an external SQLite commit", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });

      const tampered = new Database(cachePath, { strict: true });
      tampered.query(
        `UPDATE projection_turns
         SET events_json=json_set(events_json,'$[0].text','externally changed')
         WHERE session_id=?`,
      ).run(value.sessionId);
      tampered.close(false);

      await expect(adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "STREAM_RECOVERY_REQUIRED",
        state: "degraded",
      });
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("rejects an interaction index that no longer matches the verified ledger", async () => {
    const value = await fixture();
    const interactionId = "73000000-0000-4000-8007-000000000001";
    admitCloudInteraction(
      value,
      interactionId,
      "83000000-0000-4000-8007-000000000001",
    );
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const tampered = new Database(cachePath, { strict: true });
      tampered.query(
        `DELETE FROM projection_interaction_index
         WHERE session_id=? AND interaction_id=?`,
      ).run(value.sessionId, interactionId);
      tampered.close(false);

      await expect(adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "STREAM_RECOVERY_REQUIRED",
        state: "degraded",
      });
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("rejects a forged safe interaction identity before offline state lookup", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const interactionId = "70000000-0000-4000-8003-000000000001";
    admitCloudInteraction(
      value,
      interactionId,
      "80000000-0000-4000-8003-000000000001",
    );
    let adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      adapter.close();
      const database = new Database(cachePath, { strict: true });
      database.query(
        `UPDATE projection_turns
         SET events_json=json_set(
           events_json,'$[0].interactionId','70000000-0000-4000-8003-000000000002'
         )
         WHERE session_id=? AND json_extract(events_json,'$[0].kind')='interaction_state'`,
      ).run(value.sessionId);
      database.close(false);
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);
      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      expect((await adapter.listSessions({ limit: 25, signal })).sessions).toEqual([]);
      expect(adapter.projectionCacheStatus()).toMatchObject({
        affectedSessions: [value.sessionId],
        code: "STREAM_RECOVERY_REQUIRED",
        state: "degraded",
      });
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("pages upload history by source revision with bounded redacted projections", async () => {
    const value = await fixture();
    const profile = value.store.listProfiles()[0];
    if (profile === undefined) throw new Error("missing profile fixture");
    const head = value.store.latestUsage(profile.id);
    if (head === null) throw new Error("missing usage fixture");
    const firstReceivedAt = storedAccountUsageSnapshotSchema.parse(head.payload)
      .observation.receivedAt;
    for (const [sourceSequence, observedAt] of [[2, 9_000], [3, 8_000]] as const) {
      const provider = await value.codex.readUsage();
      value.store.recordUsage(profile.id, sourceSequence, observedAt, createStoredAccountUsageSnapshot({
        accountFingerprint: null,
        daemonGeneration: 1,
        observedAt,
        previousPayload: null,
        providerGeneration: profile.processGeneration,
        providerPayload: provider.payload,
        receivedAt: firstReceivedAt
          + (sourceSequence - 1) * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
        sourceSequence,
      }));
    }
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const history = await adapter.listUsageHistory({
        afterSourceRevision: 1,
        limit: 2,
        localReference: profile.id,
        signal,
        sourceGeneration: profile.processGeneration,
      });

      expect(history.map((snapshot) => ({
        observedAt: snapshot.observedAt,
        sourceRevision: snapshot.sourceRevision,
      }))).toEqual([
        { observedAt: 9_000, sourceRevision: 2 },
        { observedAt: 8_000, sourceRevision: 3 },
      ]);
      expect(JSON.stringify(history)).not.toContain(privateRootFixture);
      expect(await adapter.listUsageHistory({
        afterSourceRevision: 1,
        limit: 2,
        localReference: profile.id,
        signal,
        sourceGeneration: profile.processGeneration + 1,
      })).toEqual([]);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("keeps completed turn model and Fast immutable after mutable session settings change", async () => {
    const value = await fixture();
    const binding = beginTurnProfileBinding(value, { fast: false, preset: "high" });
    value.store.completeSessionTurnEffect({
      applyResponseState: false,
      attemptId: binding.attemptId,
      expectedSessionRevision: value.store.requireSession(value.sessionId).revision,
      receipt: { turnId: "turn_0001" },
      runtimeProfile: binding.profile,
      sessionId: value.sessionId as `sess_${string}`,
      turnId: "turn_0001",
      turnStatus: "completed",
    });
    const current = value.store.requireSession(value.sessionId);
    value.store.updateSessionMetadata({
      expectedRevision: current.revision,
      fastEnabled: true,
      preset: "ultra",
      sessionId: current.id,
    });
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const first = await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal });
      expect(first.events.at(-1)).toMatchObject({ fast: false, model: "high", turnId: "turn_0001" });
      await adapter.listSessions({ limit: 25, signal });
      expect(await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).toEqual(first);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("waits for an exact in-flight turn profile, then ingests it without freezing unknown metadata", async () => {
    const value = await fixture();
    const binding = beginTurnProfileBinding(value, { fast: true, preset: "ultra" });
    value.codex.projection = {
      ...value.codex.projection,
      messages: (value.codex.projection.messages ?? []).map((message) =>
        message.role === "user" ? { ...message, clientId: binding.attemptId } : message),
    };
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).events).toEqual([]);
      value.store.completeSessionTurnEffect({
        applyResponseState: false,
        attemptId: binding.attemptId,
        expectedSessionRevision: value.store.requireSession(value.sessionId).revision,
        receipt: { turnId: "turn_0001" },
        runtimeProfile: binding.profile,
        sessionId: value.sessionId as `sess_${string}`,
        turnId: "turn_0001",
        turnStatus: "completed",
      });
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).events.at(-1))
        .toMatchObject({ fast: true, model: "ultra" });
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("defers only explicitly incomplete completed turns and ingests them once complete", async () => {
    const value = await fixture();
    value.codex.projection = {
      ...value.codex.projection,
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: ["turn_0001"],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 0,
        turnLimit: 100,
        unreadItemTurnIds: ["turn_0001"],
      },
    };
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).events).toEqual([]);
      value.codex.projection = {
        ...value.codex.projection,
        omission: {
          hasMoreOlderTurns: false,
          incompleteTurnIds: [],
          omittedMessages: 0,
          returnedTurns: 1,
          truncatedMessages: 0,
          turnLimit: 100,
          unreadItemTurnIds: ["turn_0001"],
        },
      };
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).events)
        .toHaveLength(3);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("reads an offline projection cache with bounded rows and transport bytes", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const initial = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    initial.close();
    const database = new Database(cachePath, { strict: true });
    database.query("INSERT INTO projection_sessions(session_id,next_sequence) VALUES (?,?)")
      .run(value.sessionId, 41);
    const insert = database.query(
      "INSERT INTO projection_turns(session_id,turn_id,start_sequence,event_count,digest,events_json) VALUES (?,?,?,?,?,?)",
    );
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      const body = {
        kind: "assistant_message",
        text: "x".repeat(60_000),
        turnId: `turn_cache_${String(sequence).padStart(4, "0")}`,
      } as const;
      insert.run(
        value.sessionId,
        body.turnId,
        sequence,
        1,
        sha256(JSON.stringify([body])),
        JSON.stringify([{ ...body, sequence }]),
      );
    }
    database.close(false);
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const first = await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal });
      expect(first.complete).toBe(false);
      expect(first.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
      expect(new TextEncoder().encode(JSON.stringify(first.events)).byteLength)
        .toBeLessThanOrEqual(cloudLimits.detailChunkBytes);
      const seen = [...first.events];
      let page = first;
      let remoteHead = 0;
      let remoteTailDigest: string | undefined;
      let upload = 0;
      while (!page.complete) {
        const headSequence = seen.at(-1)?.sequence ?? 0;
        const digest = `${"a".repeat(63)}${String(upload % 10)}`;
        const checkpoint = {
          cacheId: page.cacheId,
          digest,
          expectedHeadSequence: remoteHead,
          expectedStreamEpoch: 0,
          ...(remoteTailDigest === undefined ? {} : { expectedTailDigest: remoteTailDigest }),
          headSequence,
          sessionPublicId: value.sessionId,
        };
        await adapter.recordCompactUploadIntent(checkpoint);
        await adapter.acknowledgeCompactUpload(checkpoint);
        remoteHead = headSequence;
        remoteTailDigest = digest;
        upload += 1;
        page = await adapter.readCompactEvents({
          afterSequence: remoteHead,
          limit: 128,
          remoteTailDigest,
          sessionPublicId: value.sessionId,
          signal,
        });
        seen.push(...page.events);
      }
      expect(seen.map((event) => event.sequence)).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 1),
      );
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("quarantines a recreated projection stream against a nonzero remote head without aliasing sequences", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      await expect(adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");
      expect(adapter.projectionCacheStatus()).toMatchObject({
        affectedSessions: [value.sessionId],
        affectedSessionsTruncated: false,
        code: "STREAM_RECOVERY_REQUIRED",
        sessions: 1,
        state: "degraded",
      });
      expect(await adapter.listUsage({ limit: 100, signal })).toHaveLength(1);
      const authority = await adapter.resolveCommandAuthority({
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000009",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "stop" },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      expect(commands).toHaveLength(1);
      await expect(adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("reports cache unavailability when recovery activation fails after closing the source", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      await expect(adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");

      const idempotencyKey = "00000000-0000-7000-8000-00000000071a";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 300,
        boundaryTailDigest: "b".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await writeFile(
        `${cachePath}.quarantine-${idempotencyKey}`,
        "safe conflict",
        { mode: 0o600 },
      );

      await expect(adapter.activateCompactProjectionRecovery(installation))
        .rejects.toThrow("quarantine conflicts");
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "CACHE_RECOVERY_IN_PROGRESS",
        state: "unavailable",
      });
      await expect(adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("awaiting exact local cache activation");
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("recovers at the global remote head, baselines visible turns, and uploads only later turns", async () => {
    const value = await fixture();
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const idempotencyKey = "00000000-0000-7000-8000-000000000701";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(plan.baselineCompletedTurns).toHaveLength(1);
      const installation = {
        ...plan,
        boundaryHeadSequence: 300,
        boundaryTailDigest: "b".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);
      await adapter.listSessions({ limit: 25, signal });
      const baseline = await adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(baseline).toMatchObject({ complete: true, events: [] });
      expect(baseline.cacheId).toBe(plan.replacementCacheId);

      value.codex.projection = {
        ...value.codex.projection,
        messages: [
          ...(value.codex.projection.messages ?? []),
          { role: "user", text: "Future question", turnId: "turn_0002" },
          { role: "assistant", text: "Future answer", turnId: "turn_0002" },
        ],
        turnSummaries: [
          ...(value.codex.projection.turnSummaries ?? []),
          {
            actions: [],
            files: [],
            id: "turn_0002",
            omittedActions: 0,
            omittedFiles: 0,
            runtimeMs: 25,
            status: "completed",
          },
        ],
      };
      await adapter.listSessions({ limit: 25, signal });
      const future = await adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(future.events.map((event) => event.sequence)).toEqual([301, 302, 303]);
      expect(future.events.map((event) => "turnId" in event ? event.turnId : null)).toEqual([
        "turn_0002",
        "turn_0002",
        "turn_0002",
      ]);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("replays recovery with the current terminal revision of an old cloud interaction", async () => {
    const value = await fixture();
    const session = value.store.requireSession(value.sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const interactionId = "70000000-0000-4000-8000-000000000101";
    const privateRequestId = "provider_request_private_recovery";
    value.store.admitInteraction({
      authority: {
        approvalId: "provider_approval_private_recovery",
        connectionId: "80000000-0000-4000-8000-000000000101",
        itemId: "provider_item_private_recovery",
        method: "mcp/elicitation/create",
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        requestDigest: "d".repeat(64),
        requestId: { type: "string", value: privateRequestId },
        threadId: session.providerThreadId ?? null,
        turnId: "provider_turn_private_recovery",
      },
      blocking: true,
      display: {
        fields: [{
          choices: ["sk_secret_answer"],
          name: "provider_token_private",
          required: true,
          type: "single_select",
        }],
        kind: "mcp_elicitation",
        mayContainSecrets: true,
        mode: "form",
        serverName: "private_provider_server",
        summary: `Review ${bearerFixture} at ${privateRootFixture}`,
        url: null,
      },
      kind: "mcp_elicitation",
      publicId: interactionId,
      sessionId: value.sessionId as `sess_${string}`,
    });
    let adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      })).events.at(-1)).toMatchObject({
        interactionId,
        revision: 1,
        state: "pending",
      });
      value.store.expireInteraction({ id: interactionId, expectedRevision: 1 });

      const idempotencyKey = "00000000-0000-7000-8000-000000000711";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        observedInteractionIds: [interactionId],
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(plan.baselineInteractions).toEqual([{
        blocking: true,
        interactionId,
        interactionKind: "mcp_elicitation",
        revision: 2,
        state: "expired",
        summary: "An MCP server requests protected form input",
      }]);
      const installation = {
        ...plan,
        boundaryHeadSequence: 300,
        boundaryTailDigest: "b".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);

      adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);
      await adapter.listSessions({ limit: 25, signal });
      const recovered = await adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(recovered).toMatchObject({ complete: true });
      expect(recovered.events).toEqual([{
        blocking: true,
        interactionId,
        interactionKind: "mcp_elicitation",
        kind: "interaction_state",
        revision: 2,
        sequence: 301,
        state: "expired",
        summary: "An MCP server requests protected form input",
      }]);

      adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      const replay = await adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(replay.events).toEqual(recovered.events);
      for (const privateValue of [
        privateRequestId,
        "provider_approval_private_recovery",
        "provider_item_private_recovery",
        "provider_turn_private_recovery",
        "provider_token_private",
        "sk_secret_answer",
        "private_provider_server",
        privateRootFixture,
        bearerFixture,
        "d".repeat(64),
      ]) expect(JSON.stringify(replay.events)).not.toContain(privateValue);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("never baselines an explicitly incomplete turn and ingests it after recovery", async () => {
    const value = await fixture();
    value.codex.projection = {
      ...value.codex.projection,
      omission: {
        hasMoreOlderTurns: true,
        incompleteTurnIds: ["turn_0001"],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 0,
        turnLimit: 24,
        unreadItemTurnIds: ["turn_0001"],
      },
    };
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const idempotencyKey = "00000000-0000-7000-8000-000000000702";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(plan.baselineCompletedTurns).toEqual([]);
      const installation = {
        ...plan,
        boundaryHeadSequence: 9,
        boundaryTailDigest: "c".repeat(64),
        compactStreamEpoch: 2,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);
      value.codex.projection = {
        ...value.codex.projection,
        omission: {
          ...value.codex.projection.omission,
          incompleteTurnIds: [],
        } as NonNullable<CodexSessionProjection["omission"]>,
      };
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({
        afterSequence: 9,
        limit: 128,
        remoteStreamEpoch: 2,
        remoteTailDigest: "c".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).events.map((event) => event.sequence)).toEqual([10, 11, 12]);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("baselines only fully read completed turns", async () => {
    const value = await fixture();
    value.codex.projection = {
      ...value.codex.projection,
      omission: {
        hasMoreOlderTurns: true,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 3,
        truncatedMessages: 0,
        turnLimit: 24,
        unreadItemTurnIds: ["turn_0001"],
      },
      turnSummaries: [
        ...(value.codex.projection.turnSummaries ?? []),
        {
          actions: [],
          files: [],
          id: "turn_failed_0002",
          omittedActions: 0,
          omittedFiles: 0,
          status: "failed",
        },
        {
          actions: [],
          files: [],
          id: "turn_interrupted_0003",
          omittedActions: 0,
          omittedFiles: 0,
          status: "interrupted",
        },
      ],
    };
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey: "00000000-0000-7000-8000-00000000070a",
        sessionPublicId: value.sessionId,
        signal: new AbortController().signal,
      });
      expect(plan.baselineCompletedTurns).toEqual([]);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("preserves a corrupt cache in quarantine and atomically activates a fresh ledger", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const corruptBytes = "corrupt projection sentinel";
    await writeFile(cachePath, corruptBytes, { mode: 0o600 });
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "CACHE_CORRUPT_OR_UNREADABLE",
        state: "unavailable",
      });
      const signal = new AbortController().signal;
      const idempotencyKey = "00000000-0000-7000-8000-000000000703";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(plan.sourceCacheId).toBeNull();
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "d".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
      expect(await readFile(
        `${cachePath}.quarantine-${idempotencyKey}`,
        "utf8",
      )).toBe(corruptBytes);
      expect((await adapter.readCompactEvents({
        afterSequence: 5,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "d".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).cacheId).toBe(plan.replacementCacheId);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("refuses to overwrite a newer cache that replaces the planned corrupt source", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    await writeFile(cachePath, "corrupt projection sentinel", { mode: 0o600 });
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    const idempotencyKey = "00000000-0000-7000-8000-00000000070b";
    try {
      const signal = new AbortController().signal;
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "d".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await rm(cachePath);
      const replacement = new Database(cachePath, { create: true, strict: true });
      replacement.exec("PRAGMA user_version=6");
      replacement.close(false);
      await chmod(cachePath, 0o600);

      await expect(adapter.activateCompactProjectionRecovery(installation))
        .rejects.toThrow("newer HRA version");
      const preserved = new Database(cachePath, { strict: true });
      expect((preserved.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(6);
      preserved.close(false);
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`quarantine-${idempotencyKey}`))).toBe(false);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("refuses a same-user pathname replacement of the active source cache", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const movedPath = join(value.paths.root, "cloud-projection-original.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    const idempotencyKey = "00000000-0000-7000-8000-00000000070c";
    try {
      const signal = new AbortController().signal;
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "e".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);

      await rename(cachePath, movedPath);
      await copyFile(movedPath, cachePath);
      await chmod(cachePath, 0o600);
      const replacementIdentity = await lstat(cachePath);
      expect(replacementIdentity.ino).not.toBe((await lstat(movedPath)).ino);

      await expect(adapter.activateCompactProjectionRecovery(installation))
        .rejects.toThrow("pathname changed");
      expect((await lstat(cachePath)).ino).toBe(replacementIdentity.ino);
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`quarantine-${idempotencyKey}`))).toBe(false);
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`recovery-${idempotencyKey}`))).toBe(true);
      await adapter.discardCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
      });
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`recovery-${idempotencyKey}`))).toBe(false);
      expect((await lstat(cachePath)).ino).toBe(replacementIdentity.ino);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("reopens the exact installed cache before acknowledging activation replay", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const movedPath = join(value.paths.root, "cloud-projection-installed.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    const idempotencyKey = "00000000-0000-7000-8000-00000000070d";
    try {
      const signal = new AbortController().signal;
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "f".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);

      await rename(cachePath, movedPath);
      await copyFile(movedPath, cachePath);
      await chmod(cachePath, 0o600);
      const replacementIdentity = await lstat(cachePath);

      await expect(adapter.activateCompactProjectionRecovery(installation))
        .rejects.toThrow("pathname changed");
      expect((await lstat(cachePath)).ino).toBe(replacementIdentity.ino);
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`quarantine-${idempotencyKey}`))).toBe(true);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("attests the source pathname and rebuilds partial or retried staging from that source", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const originalPath = join(value.paths.root, "cloud-projection-source.sqlite");
    let adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    const idempotencyKey = "00000000-0000-7000-8000-00000000070e";
    try {
      const signal = new AbortController().signal;
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "1".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;

      await rename(cachePath, originalPath);
      await copyFile(originalPath, cachePath);
      await chmod(cachePath, 0o600);
      await expect(adapter.stageCompactProjectionRecovery(installation))
        .rejects.toThrow("pathname changed");
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`recovery-${idempotencyKey}`))).toBe(false);

      adapter.close();
      await rm(cachePath);
      await rename(originalPath, cachePath);
      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      const stagingPath = join(
        value.paths.root,
        `cloud-projection.sqlite.recovery-${idempotencyKey}`,
      );
      await copyFile(cachePath, stagingPath);
      await chmod(stagingPath, 0o600);
      await adapter.stageCompactProjectionRecovery(installation);
      const tampered = new Database(stagingPath, { strict: true });
      tampered.query(
        "INSERT INTO projection_sessions(session_id,next_sequence,stream_epoch) VALUES (?,?,?)",
      ).run("session_foreign_12345678", 1, 0);
      tampered.close(false);

      await adapter.stageCompactProjectionRecovery(installation);
      const rebuilt = new Database(stagingPath, { readonly: true, strict: true });
      expect(rebuilt.query(
        "SELECT session_id FROM projection_sessions WHERE session_id=?",
      ).get("session_foreign_12345678")).toBeNull();
      rebuilt.close(false);
      await adapter.activateCompactProjectionRecovery(installation);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("observes a future-version cache without mutating its bytes or journal mode", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    execFileSync(process.execPath, ["-e", `
      import { Database } from "bun:sqlite";
      const future = new Database(process.argv[1], { create: true, strict: true });
      future.exec(\`
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        CREATE TABLE future_sentinel(value TEXT NOT NULL) STRICT;
        INSERT INTO future_sentinel(value) VALUES ('preserve-me');
        PRAGMA user_version=6;
      \`);
      process.exit(0);
    `, cachePath]);
    const futurePaths = [cachePath, `${cachePath}-wal`, `${cachePath}-shm`];
    for (const path of futurePaths) {
      try {
        await chmod(path, 0o600);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path === cachePath) throw error;
      }
    }
    const snapshotFutureFiles = async () => Promise.all(futurePaths.map(async (path) => {
      try {
        return {
          path,
          present: true as const,
          bytes: await readFile(path),
          mode: (await lstat(path)).mode,
        };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { path, present: false as const };
      }
    }));
    const before = await snapshotFutureFiles();
    expect(before[0]).toMatchObject({ path: cachePath, present: true });

    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "CACHE_NEWER_VERSION",
        state: "unavailable",
      });
      const after = await snapshotFutureFiles();
      expect(after).toEqual(before);
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("rejects symlink, hardlink, FIFO, and newer-version cache authority before staging recovery", async () => {
    for (const variant of ["symlink", "hardlink", "fifo", "newer"] as const) {
      const value = await fixture();
      const cachePath = join(value.paths.root, "cloud-projection.sqlite");
      if (variant === "symlink") {
        await symlink("/dev/null", cachePath);
      } else if (variant === "hardlink") {
        const source = join(value.paths.root, "projection-hardlink-source");
        await writeFile(source, "unsafe cache authority", { mode: 0o600 });
        await link(source, cachePath);
      } else if (variant === "fifo") {
        execFileSync("mkfifo", [cachePath]);
      } else {
        const database = new Database(cachePath, { create: true, strict: true });
        database.exec("PRAGMA user_version=6");
        database.close(false);
        await chmod(cachePath, 0o600);
      }
      const adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      try {
        const idempotencyKey = `00000000-0000-7000-8000-00000000070${
          variant === "symlink" ? "4" : variant === "hardlink" ? "5" : variant === "fifo" ? "6" : "7"
        }`;
        await expect(adapter.planCompactProjectionRecovery({
          idempotencyKey,
          sessionPublicId: value.sessionId,
          signal: new AbortController().signal,
        })).rejects.toThrow("refuses unsafe cache authority");
        expect((await readdir(value.paths.root)).some((name) =>
          name.includes(`recovery-${idempotencyKey}`))).toBe(false);
      } finally {
        adapter.close();
        value.store.close();
      }
    }
  });

  test("migrates a legacy v1 cache without changing its stream meaning", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const database = new Database(cachePath, { create: true, strict: true });
    database.exec(`
      CREATE TABLE projection_sessions (
        session_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL CHECK(next_sequence > 0)
      ) STRICT;
      CREATE TABLE projection_turns (
        session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
        event_count INTEGER NOT NULL CHECK(event_count > 0),
        digest TEXT NOT NULL CHECK(length(digest) = 64),
        events_json TEXT NOT NULL,
        PRIMARY KEY(session_id, turn_id),
        UNIQUE(session_id, start_sequence)
      ) STRICT;
      CREATE TABLE projection_ledger (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        cache_id TEXT NOT NULL CHECK(length(cache_id) BETWEEN 16 AND 128)
      ) STRICT;
      CREATE TABLE projection_remote_checkpoints (
        session_id TEXT PRIMARY KEY,
        head_sequence INTEGER NOT NULL CHECK(head_sequence >= 0),
        tail_digest TEXT,
        pending_expected_head INTEGER,
        pending_expected_tail TEXT,
        pending_head INTEGER,
        pending_tail TEXT
      ) STRICT;
      INSERT INTO projection_ledger(singleton,cache_id)
        VALUES (1,'cache_legacy_12345678');
      PRAGMA user_version=1;
    `);
    database.close(false);
    await chmod(cachePath, 0o600);
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const projection = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        remoteStreamEpoch: 0,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(projection.cacheId).toBe("cache_legacy_12345678");
      expect(projection.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    } finally {
      adapter.close();
      const migrated = new Database(cachePath, { strict: true });
      expect((migrated.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(5);
      const migratedColumns = (migrated.query("PRAGMA table_info(projection_sessions)").all() as
        Array<{ name: string }>).map((column) => column.name);
      expect(migratedColumns).toContain("stream_epoch");
      expect(migratedColumns).toContain("interaction_scan_sequence");
      expect(migratedColumns).toContain("interaction_scan_ceiling_sequence");
      expect(migratedColumns).toContain("interaction_discovery_cursor");
      migrated.close(false);
      value.store.close();
    }
  });

  test("migrates a populated v2 cache with an inactive durable interaction scan", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const database = new Database(cachePath, { create: true, strict: true });
    database.exec(`
      CREATE TABLE projection_sessions (
        session_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL CHECK(next_sequence > 0),
        stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0)
      ) STRICT;
      CREATE TABLE projection_turns (
        session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
        event_count INTEGER NOT NULL CHECK(event_count > 0),
        digest TEXT NOT NULL CHECK(length(digest) = 64),
        events_json TEXT NOT NULL,
        PRIMARY KEY(session_id, turn_id),
        UNIQUE(session_id, start_sequence)
      ) STRICT;
      CREATE TABLE projection_baselines (
        session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        digest TEXT NOT NULL CHECK(length(digest) = 64),
        PRIMARY KEY(session_id, turn_id)
      ) STRICT;
      CREATE TABLE projection_ledger (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        cache_id TEXT NOT NULL CHECK(length(cache_id) BETWEEN 16 AND 128)
      ) STRICT;
      CREATE TABLE projection_remote_checkpoints (
        session_id TEXT PRIMARY KEY,
        head_sequence INTEGER NOT NULL CHECK(head_sequence >= 0),
        stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0),
        tail_digest TEXT,
        pending_expected_head INTEGER,
        pending_expected_tail TEXT,
        pending_head INTEGER,
        pending_tail TEXT
      ) STRICT;
      INSERT INTO projection_ledger(singleton,cache_id)
        VALUES (1,'cache_v2_1234567890');
      PRAGMA user_version=2;
    `);
    database.query(
      "INSERT INTO projection_sessions(session_id,next_sequence,stream_epoch) VALUES (?,1,0)",
    ).run(value.sessionId);
    database.query(
      `INSERT INTO projection_remote_checkpoints(
         session_id,head_sequence,stream_epoch,tail_digest
       ) VALUES (?,0,0,NULL)`,
    ).run(value.sessionId);
    database.close(false);
    await chmod(cachePath, 0o600);

    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
    } finally {
      adapter.close();
      const migrated = new Database(cachePath, { readonly: true, strict: true });
      expect((migrated.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(5);
      expect(migrated.query(
        `SELECT interaction_scan_sequence,interaction_scan_ceiling_sequence,
                interaction_discovery_cursor
         FROM projection_sessions WHERE session_id=?`,
      ).get(value.sessionId)).toEqual({
        interaction_discovery_cursor: null,
        interaction_scan_ceiling_sequence: 0,
        interaction_scan_sequence: 0,
      });
      expect(migrated.query(
        "SELECT cache_id FROM projection_ledger WHERE singleton=1",
      ).get()).toEqual({ cache_id: "cache_v2_1234567890" });
      expect(migrated.query(
        "SELECT head_sequence,stream_epoch,tail_digest FROM projection_remote_checkpoints WHERE session_id=?",
      ).get(value.sessionId)).toEqual({ head_sequence: 0, stream_epoch: 0, tail_digest: null });
      migrated.close(false);
      value.store.close();
    }
  });

  test("migrates a populated v3 cache with an inactive interaction discovery cursor", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    let adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      await adapter.listSessions({
        limit: 25,
        signal: new AbortController().signal,
      });
      adapter.close();
      const previous = new Database(cachePath, { strict: true });
      previous.exec(`
        DROP TABLE projection_interaction_index;
        ALTER TABLE projection_sessions DROP COLUMN interaction_discovery_cursor;
        PRAGMA user_version=3;
      `);
      previous.close(false);

      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
    } finally {
      adapter.close();
      const migrated = new Database(cachePath, { readonly: true, strict: true });
      expect((migrated.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(5);
      expect(migrated.query(
        "SELECT interaction_discovery_cursor FROM projection_sessions WHERE session_id=?",
      ).get(value.sessionId)).toEqual({ interaction_discovery_cursor: null });
      migrated.close(false);
      value.store.close();
    }
  });

  test("migrates v4 by rebuilding the bounded interaction index atomically", async () => {
    const value = await fixture();
    const interactionId = "72000000-0000-4000-8006-000000000001";
    admitCloudInteraction(
      value,
      interactionId,
      "82000000-0000-4000-8006-000000000001",
    );
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    let adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      await adapter.listSessions({
        limit: 25,
        signal: new AbortController().signal,
      });
      adapter.close();
      const previous = new Database(cachePath, { strict: true });
      previous.exec(`
        DROP TABLE projection_interaction_index;
        PRAGMA user_version=4;
      `);
      previous.close(false);

      adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
    } finally {
      adapter.close();
      const migrated = new Database(cachePath, { readonly: true, strict: true });
      expect((migrated.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(5);
      expect(migrated.query(
        `SELECT interaction_id,start_sequence FROM projection_interaction_index
         WHERE session_id=?`,
      ).get(value.sessionId)).toEqual({
        interaction_id: interactionId,
        start_sequence: 4,
      });
      migrated.close(false);
      value.store.close();
    }
  });

  test("reconciles an exact committed compact upload after its response is lost", async () => {
    const value = await fixture();
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const page = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      const headSequence = page.events.at(-1)?.sequence ?? 0;
      const checkpoint = {
        cacheId: page.cacheId,
        digest: "d".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(checkpoint);

      expect(await adapter.readCompactEvents({
        afterSequence: headSequence,
        limit: 128,
        remoteTailDigest: checkpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ cacheId: page.cacheId, complete: true, events: [] });
      await adapter.acknowledgeCompactUpload(checkpoint);
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
    } finally {
      adapter.close();
      value.store.close();
    }
  });

  test("quarantines corrupt, symlinked, and newer projection caches without blocking local authority or cloud usage", async () => {
    for (const variant of ["corrupt", "symlink", "newer"] as const) {
      const value = await fixture();
      const cachePath = join(value.paths.root, "cloud-projection.sqlite");
      if (variant === "corrupt") await writeFile(cachePath, "not sqlite", { mode: 0o600 });
      else if (variant === "symlink") await symlink("/dev/null", cachePath);
      else {
        const database = new Database(cachePath, { create: true, strict: true });
        database.exec("PRAGMA user_version=6");
        database.close(false);
      }
      const commands: LocalCommand[] = [];
      const adapter = new StateBackedCloudDaemonAdapter({
        codex: value.codex,
        executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
        paths: value.paths,
        store: value.store,
      });
      try {
        expect(adapter.projectionCacheStatus()).toMatchObject({ state: "unavailable" });
        expect((await adapter.listSessions({
          limit: 25,
          signal: new AbortController().signal,
        })).sessions).toHaveLength(1);
        expect(await adapter.listUsage({ limit: 100, signal: new AbortController().signal })).toHaveLength(1);
        const authority = await adapter.resolveCommandAuthority({ sessionPublicId: value.sessionId, signal: new AbortController().signal });
        expect(authority).not.toBeNull();
        expect(await adapter.execute({
          authority: authority as CloudLocalCommandAuthority,
          idempotencyKey: `00000000-0000-7000-8000-00000000000${variant === "corrupt" ? "3" : variant === "symlink" ? "4" : "5"}`,
          leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
          payload: { kind: "stop" },
          sessionPublicId: value.sessionId,
          signal: new AbortController().signal,
        })).toEqual({ code: "APPLIED", state: "applied" });
        expect(commands).toHaveLength(1);
        await expect(adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal: new AbortController().signal }))
          .rejects.toThrow("cloud projection cache");
      } finally {
        adapter.close();
        value.store.close();
      }
    }
  });

  test("dispatches only under the exact local profile and provider authority", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      codex: value.codex,
      executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const authority = await adapter.resolveCommandAuthority({ sessionPublicId: value.sessionId, signal });
      expect(authority).not.toBeNull();
      const applied = await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000001",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "send", message: "Continue" },
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(applied).toEqual({ code: "APPLIED", state: "applied" });
      expect(commands).toEqual([{
        kind: "session.send",
        session: value.sessionId,
        message: "Continue",
        idempotencyKey: "00000000-0000-7000-8000-000000000001",
      }]);

      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000006",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "set_fast", enabled: true },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      expect(commands.at(-1)).toEqual({
        enabled: true,
        idempotencyKey: "00000000-0000-7000-8000-000000000006",
        kind: "session.fast",
        session: value.sessionId,
      });

      const profile = value.store.requireProfileById((authority as CloudLocalCommandAuthority).profileId as Parameters<StateStore["requireProfileById"]>[0]);
      value.store.advanceProfileGeneration(profile.id, profile.processGeneration);
      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000002",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "stop" },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "LOCAL_AUTHORITY_CHANGED", state: "failed" });
      expect(commands).toHaveLength(2);
    } finally {
      adapter.close();
      value.store.close();
    }
  });
});

describe("bridged cloud control", () => {
  test("manual sync runs the daemon bridge before the ordinary control pull", async () => {
    const calls: string[] = [];
    const deviceSignals: AbortSignal[] = [];
    const cycle: CloudDaemonCycleResult = {
      commandsApplied: 0,
      commandsUnsettled: 0,
      errors: [],
      online: true,
      remoteSessions: [{
        complete: true,
        events: [{
          kind: "assistant_message",
          sequence: 1,
          text: "remote-sentinel".repeat(450_000),
          turnId: "turn_large_sync",
        }],
        executionDevicePublicId: "device_12345678",
        metadata: null,
        publicId: "session_large_sync",
        state: "idle",
        updatedAt: 4_000,
      }],
      sessionsUploaded: 1,
      usageUploaded: 1,
    };
    const bridge: CloudDaemonBridge = {
      close: () => { calls.push("close"); return Promise.resolve(); },
      cycle: () => { calls.push("bridge"); return Promise.resolve(cycle); },
      pullRemoteSessions: () => Promise.resolve([]),
    };
    const unused = () => Promise.reject(new Error("unused"));
    const control: CloudControlPort & CloudRemoteControlPort = {
      status: unused,
      auth: unused,
      logout: unused,
      deleteAccount: (input) => {
        calls.push(`delete:${String(input.acknowledgeErasure)}`);
        return Promise.resolve({ deletion: { effectsDisabled: true, state: "pending" } });
      },
      listDevices: unused,
      pairDevice: unused,
      acknowledgeNoAccountKeyHolders: (signal) => {
        expect(signal.aborted).toBe(false);
        calls.push("key-loss");
        return Promise.resolve({ localOnly: true });
      },
      approveDevice: (device, idempotencyKey, signal) => {
        expect(signal.aborted).toBe(false);
        deviceSignals.push(signal);
        calls.push(`approve:${device}:${idempotencyKey}`);
        return Promise.resolve({ approved: true });
      },
      revokeDevice: (device, idempotencyKey, signal) => {
        expect(signal.aborted).toBe(false);
        deviceSignals.push(signal);
        calls.push(`revoke:${device}:${idempotencyKey}`);
        return Promise.resolve({ revoked: true });
      },
      listRemoteSessionHeads: unused,
      resolveRemoteSession: unused,
      pullRemoteSession: unused,
      getRemoteCommandStatus: unused,
      enqueueRemoteCommand: unused,
      isCompactProjectionRecoveryUnsettled: () => Promise.resolve(false),
      isCompactProjectionRecoveryUnsettledForProfile: () => Promise.resolve(false),
      supersedeCompactProjectionRecoveryForProviderDeletion: () =>
        Promise.resolve({ superseded: false }),
      supersedeTerminalCompactProjectionRecoveries: () =>
        Promise.resolve({ superseded: 0 }),
      recoverCompactProjection: unused,
      sync: () => {
        calls.push("control");
        return Promise.resolve({
          accountCount: 2,
          ignoredProjection: "sentinel".repeat(900_000),
          sessionCount: 3,
          synced: true,
          syncedAt: 4_000,
          truncated: false,
          usageSnapshotCount: 1,
        });
      },
    };
    const combined = new BridgedCloudControl(control, bridge);
    const synced = await combined.sync(new AbortController().signal);
    expect(synced).toEqual({
      control: {
        accountCount: 2,
        sessionCount: 3,
        synced: true,
        syncedAt: 4_000,
        truncated: false,
        usageSnapshotCount: 1,
      },
      daemon: {
        commandsApplied: 0,
        commandsUnsettled: 0,
        errors: [],
        online: true,
        remoteSessionCount: 1,
        sessionsUploaded: 1,
        usageUploaded: 1,
      },
    });
    expect(JSON.stringify(synced).length).toBeLessThan(2_048);
    expect(JSON.stringify(synced)).not.toContain("sentinel");
    expect(calls).toEqual(["bridge", "control"]);

    calls.length = 0;
    expect(await combined.deleteAccount({
      acknowledgeErasure: true,
      signal: new AbortController().signal,
    })).toEqual({
      daemonRestartRequired: true,
      deletion: { effectsDisabled: true, state: "pending" },
    });
    expect(calls).toEqual(["close", "delete:true"]);

    calls.length = 0;
    const deviceSignal = new AbortController().signal;
    const approvalKey = "018bcfe5-6800-7000-8000-000000000031";
    const revocationKey = "018bcfe5-6800-7000-8000-000000000032";
    expect(await combined.acknowledgeNoAccountKeyHolders(deviceSignal))
      .toEqual({ localOnly: true });
    expect(await combined.approveDevice("device_pending", approvalKey, deviceSignal))
      .toEqual({ approved: true });
    expect(await combined.revokeDevice("device_active", revocationKey, deviceSignal))
      .toEqual({ revoked: true });
    expect(calls).toEqual([
      "key-loss",
      `approve:device_pending:${approvalKey}`,
      `revoke:device_active:${revocationKey}`,
    ]);
    expect(deviceSignals).toEqual([deviceSignal, deviceSignal]);
  });
});
