import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_PIN, CLAUDE_PIN_MODEL } from "../claude/pin";
import type { Preset } from "../domain/presets";
import type {
  EffectiveClaudeRuntimeProfile,
  EffectiveRuntimeProfile,
} from "../domain/runtime-profile";
import {
  sessionTranscriptSchema,
  TRANSCRIPT_SEED_HEADER,
  type SessionTranscript,
} from "../domain/transcript";
import {
  transcriptToTrajectory,
  trajectoryRecordSchema,
} from "../domain/trajectory";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { StateStore } from "../storage/state-store";
import {
  UnavailableCloudControl,
  type ClaudeRuntimePort,
  type ClaudeRuntimeStartReview,
  type CodexAccountProjection,
  type CodexLoginOutcome,
  type CodexRuntimePort,
  type CodexSessionObservation,
  type CodexSessionProjection,
  type CompactProjectionRecoveryBlocker,
  type ProfileAuthority,
  type RuntimeStartReview,
} from "./ports";
import { CommandFailure, HraService } from "./service";

const signal = new AbortController().signal;

const codexProfile = (
  authority: ProfileAuthority,
  preset: Preset,
): EffectiveRuntimeProfile => ({
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: 2_000,
  preset,
  model: preset === "low" ? "gpt-5.6-luna" : "gpt-5.6-sol",
  reasoningEffort: preset === "ultra" ? "ultra" : "max",
  serviceTier: null,
  fast: false,
  approvalPolicy: "on-request",
  reviewMode: "auto_review",
  permissionProfile: ":workspace",
  computerUse: true,
  pluginCapability: true,
  enabledApps: [],
});

const claudeProfile = (authority: ProfileAuthority): EffectiveClaudeRuntimeProfile => ({
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: 2_000,
  preset: "fable-max",
  model: CLAUDE_PIN_MODEL,
  reasoningEffort: "max",
  claudeVersion: CLAUDE_PIN,
  permissionMode: "default",
  isolatedConfigDir: true,
  outputFormat: "stream-json",
  inputFormat: "stream-json",
});

/** A Codex seam that starts sessions and turns and records every call. */
class SwitchFakeCodex implements CodexRuntimePort {
  readonly provider = "codex" as const;
  readonly calls: string[] = [];
  readonly endedThreads: string[] = [];
  turnStatus: "completed" | "inProgress" = "completed";
  #turns = 0;
  projection: CodexSessionProjection = {
    providerThreadId: "codex-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 10,
  };

  async login(): Promise<CodexLoginOutcome> {
    return { status: "signed_in", account: { signedIn: true, email: "person@example.com" } };
  }
  async readAccount(): Promise<CodexAccountProjection> {
    return { signedIn: true, email: "person@example.com" };
  }
  async logout(): Promise<void> {}
  async close(): Promise<void> {}
  async reviewSessionStart(
    input: Parameters<CodexRuntimePort["reviewSessionStart"]>[0],
  ): Promise<RuntimeStartReview> {
    this.calls.push("review-session");
    return {
      reviewId: crypto.randomUUID(),
      kind: "session_start",
      effectiveRuntimeProfile: codexProfile(input.authority, input.preset),
    };
  }
  async startSession(
    input: Parameters<CodexRuntimePort["startSession"]>[0],
  ): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    this.calls.push("start-session");
    return { ...this.projection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async observeSession(
    input: Parameters<CodexRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    this.calls.push("observe");
    return {
      connectionId: "30000000-0000-4000-8000-000000000001",
      projection: { ...this.projection, providerThreadId: input.providerThreadId },
      resumed: false,
    };
  }
  async readSession(): Promise<CodexSessionProjection> {
    this.calls.push("read");
    return this.projection;
  }
  async endSession(input: Parameters<CodexRuntimePort["endSession"]>[0]): Promise<void> {
    this.calls.push("end-session");
    this.endedThreads.push(input.providerThreadId);
  }
  async reviewTurnStart(
    input: Parameters<CodexRuntimePort["reviewTurnStart"]>[0],
  ): Promise<RuntimeStartReview> {
    this.calls.push("review-turn");
    return {
      reviewId: crypto.randomUUID(),
      kind: "turn_start",
      effectiveRuntimeProfile: codexProfile(input.authority, input.preset),
    };
  }
  async startTurn(
    input: Parameters<CodexRuntimePort["startTurn"]>[0],
  ): Promise<{
    turnId: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    effectiveRuntimeProfile: EffectiveRuntimeProfile;
  }> {
    this.calls.push("start-turn");
    this.#turns += 1;
    const turnId = `codex-turn-${String(this.#turns)}`;
    const status = this.turnStatus;
    this.projection = {
      ...this.projection,
      status: status === "inProgress" ? "active" : "idle",
      ...(status === "inProgress" ? { activeTurnId: turnId } : {}),
      providerUpdatedAt: (this.projection.providerUpdatedAt ?? 10) + 1,
    };
    if (status !== "inProgress") {
      delete (this.projection as { activeTurnId?: string }).activeTurnId;
    }
    return {
      turnId,
      status,
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
    };
  }
  async steer(): Promise<void> { this.calls.push("steer"); }
  async interrupt(): Promise<void> { this.calls.push("interrupt"); }
  #unsupported(): never { throw new Error("This fixture does not drive that Codex capability."); }
  cancelLogin(): Promise<never> { return Promise.reject(this.#unsupported()); }
  readUsage(): Promise<never> { return Promise.reject(this.#unsupported()); }
  consumeRateLimitReset(): Promise<never> { return Promise.reject(this.#unsupported()); }
  listPlugins(): Promise<never> { return Promise.reject(this.#unsupported()); }
  listSessions(): Promise<never> { return Promise.reject(this.#unsupported()); }
  rename(): Promise<never> { return Promise.reject(this.#unsupported()); }
  inspectTurn(): Promise<never> { return Promise.reject(this.#unsupported()); }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unsupported()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unsupported()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
}

/** A Claude seam that accepts a switched-in session and its seeded turn. */
class SwitchFakeClaude implements ClaudeRuntimePort {
  readonly provider = "claude" as const;
  readonly calls: string[] = [];
  readonly seededMessages: string[] = [];
  interactionAuthorityCalls = 0;
  readiness: "signed_in" | "signed_out" | "unverified" = "signed_in";
  startSessionError?: Error;
  #turns = 0;
  projection: CodexSessionProjection = {
    providerThreadId: "claude-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 20,
  };

  pinnedVersion(): string { return CLAUDE_PIN; }
  async readAccount() {
    this.calls.push("read-account");
    return { readiness: this.readiness, observedAt: 2_000 };
  }
  async close(): Promise<void> {}
  async reviewSessionStart(
    input: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-session");
    return {
      reviewId: crypto.randomUUID(),
      kind: "session_start",
      effectiveRuntimeProfile: claudeProfile(input.authority),
    };
  }
  async startSession(
    input: Parameters<ClaudeRuntimePort["startSession"]>[0],
  ): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile }> {
    this.calls.push("start-session");
    if (this.startSessionError !== undefined) throw this.startSessionError;
    return { ...this.projection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async observeSession(
    input: Parameters<ClaudeRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    this.calls.push("observe");
    return {
      connectionId: "30000000-0000-4000-8000-000000000002",
      projection: { ...this.projection, providerThreadId: input.providerThreadId },
      resumed: false,
    };
  }
  async readSession(): Promise<CodexSessionProjection> {
    this.calls.push("read");
    return this.projection;
  }
  async endSession(): Promise<void> { this.calls.push("end-session"); }
  async reviewTurnStart(
    input: Parameters<ClaudeRuntimePort["reviewTurnStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-turn");
    return {
      reviewId: crypto.randomUUID(),
      kind: "turn_start",
      effectiveRuntimeProfile: claudeProfile(input.authority),
    };
  }
  async startTurn(
    input: Parameters<ClaudeRuntimePort["startTurn"]>[0],
  ): Promise<{
    turnId: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile;
  }> {
    this.calls.push("start-turn");
    this.seededMessages.push(input.message);
    this.#turns += 1;
    return {
      turnId: `claude-turn-${String(this.#turns)}`,
      status: "completed",
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
    };
  }
  async steer(): Promise<void> { this.calls.push("steer"); }
  async interrupt(): Promise<void> { this.calls.push("interrupt"); }
  #unsupported(): never { throw new Error("This fixture does not drive that Claude capability."); }
  interactionAuthority(
    _authority: ProfileAuthority,
    _providerThreadId: string,
    _requestId: string,
  ): never {
    this.interactionAuthorityCalls += 1;
    return this.#unsupported();
  }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unsupported()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unsupported()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
}

class OfflineCloud extends UnavailableCloudControl {
  constructor() {
    super({
      isCompactProjectionRecoveryUnsettled: async () => false,
      isCompactProjectionRecoveryUnsettledForProfile: async () => false,
      supersedeCompactProjectionRecoveryForProviderDeletion: async () => ({ superseded: false }),
      supersedeTerminalCompactProjectionRecoveries: async () => ({ superseded: 0 }),
    } satisfies CompactProjectionRecoveryBlocker as CompactProjectionRecoveryBlocker);
  }
}

const stores: StateStore[] = [];
const roots: string[] = [];
const services: HraService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => { await service.close(); }));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

type Fixture = Readonly<{
  claude: SwitchFakeClaude;
  codex: SwitchFakeCodex;
  documents: string;
  paths: ReturnType<typeof resolveStatePaths>;
  service: HraService;
  store: StateStore;
}>;

async function fixture(): Promise<Fixture> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-switch-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  const documents = join(home, "Documents");
  await mkdir(documents, { recursive: true });
  await initializeStatePaths(paths);
  const store = new StateStore(paths);
  stores.push(store);
  store.setDefaultApprovalMode("manual");
  const codex = new SwitchFakeCodex();
  const claude = new SwitchFakeClaude();
  const service = new HraService({
    claude,
    cloud: new OfflineCloud(),
    codex,
    daemonAuthority: { assertCurrent: async () => {}, close: () => {} },
    paths,
    requestStop: () => undefined,
    store,
  });
  services.push(service);
  return { claude, codex, documents, paths, service, store };
}

function liveAuthorityFor(
  store: StateStore,
  profileSelector: string,
  provider: "codex" | "claude" = "codex",
): ProfileAuthority {
  const profile = store.requireProfile(profileSelector);
  const authority = store.requireProviderAccountAuthority(profile.id, provider);
  return {
    id: authority.profileId,
    generation: authority.processGeneration,
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
    codexHome: "unused",
    desktopUserData: "unused",
  };
}

async function codexSession(value: Fixture): Promise<Readonly<{
  accountId: `acct_${string}`;
  sessionId: `sess_${string}`;
}>> {
  const added = await value.service.execute(
    { kind: "account.add", label: "Work" },
    { signal },
  ) as { account: { id: `acct_${string}` } };
  await value.service.execute(
    { account: added.account.id, deviceCode: false, kind: "account.login" },
    { signal },
  );
  await value.service.execute(
    { kind: "project.add", label: "Work docs", path: value.documents },
    { signal },
  );
  const started = await value.service.execute(
    { account: added.account.id, fast: false, kind: "session.start", preset: "high" },
    { signal },
  ) as { session: { id: `sess_${string}` } };
  return { accountId: added.account.id, sessionId: started.session.id };
}

const transcriptOf = async (
  value: Fixture,
  sessionId: string,
): Promise<SessionTranscript> => sessionTranscriptSchema.parse(await value.service.execute(
  { kind: "session.transcript", limit: 500, session: sessionId },
  { signal },
));

describe("provider portability", () => {
  test("drops a stale Claude callback before translator state or runtime authority lookup", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Stale Claude callback" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Claude docs", path: value.documents },
      { signal },
    );
    const started = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const providerThreadId = value.store.requireSession(started.session.id).providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected one bound Claude thread.");
    const staleAuthority = liveAuthorityFor(value.store, added.account.id, "claude");
    const current = value.store.requireProviderAccountAuthority(added.account.id, "claude");
    value.store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: current.processGeneration,
      profileId: current.profileId,
      provider: "claude",
    });
    const before = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events.length;

    await value.service.observeClaudeFact(staleAuthority, {
      blocking: true,
      connectionId: "30000000-0000-4000-8000-000000000002",
      display: {
        availableDecisions: ["once", "decline"],
        commandClass: "shell",
        kind: "command_approval",
        reason: null,
        summary: "Run a command",
        workingDirectory: null,
      },
      itemId: "same-item",
      kind: "command_approval",
      providerThreadId,
      request: {
        blockedPath: null,
        decisionReasonType: null,
        description: null,
        displayName: "Shell",
        input: { command: "true" },
        permissionSuggestionCount: 0,
        questions: null,
        requiresUserInteraction: false,
        subtype: "can_use_tool",
        toolName: "Shell",
        toolUseId: "same-item",
      },
      requestId: "same-request",
      turnId: "same-turn",
      type: "interactionRequested",
    });
    await value.service.observeClaudeFact(staleAuthority, {
      connectionId: "30000000-0000-4000-8000-000000000002",
      providerThreadId,
      requestId: "same-request",
      type: "interactionCanceled",
    });

    expect(value.claude.interactionAuthorityCalls).toBe(0);
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events).toHaveLength(before);
  });

  test("does not route a provider notice into another provider session with the same profile generation", async () => {
    const value = await fixture();
    const { accountId } = await codexSession(value);
    const claude = await value.service.execute({
      account: accountId,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const before = value.store.listSessionEvents({
      sessionId: claude.session.id,
      afterSequence: 0,
    }).events.length;

    await value.service.observeCodexFact(liveAuthorityFor(value.store, accountId, "codex"), {
      connectionId: "30000000-0000-4000-8000-000000000002",
      method: "provider/unknown-notification",
      type: "protocolNotice",
    });

    const after = value.store.listSessionEvents({
      sessionId: claude.session.id,
      afterSequence: 0,
    }).events;
    expect(after).toHaveLength(before);
    expect(after.some((event) => event.body.type === "protocol_incompatible")).toBe(false);
  });

  test("keeps Claude readiness independent and binds a new session to the observed generation", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Claude only" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Claude docs", path: value.documents },
      { signal },
    );

    value.claude.readiness = "unverified";
    const unverifiedStarted = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    expect(value.claude.calls).toEqual([
      "read-account",
      "review-session",
      "start-session",
      "observe",
    ]);
    expect(value.store.requireProviderAccountForProfile(
      added.account.id,
      "codex",
    )).toMatchObject({ bindingGeneration: 1, readiness: "signed_out" });
    const unverified = value.store.requireProviderAccountForProfile(
      added.account.id,
      "claude",
    );
    expect(unverified).toMatchObject({ bindingGeneration: 1, readiness: "unverified" });
    expect(value.store.requireSessionProviderAuthority(unverifiedStarted.session.id)).toMatchObject({
      bindingGeneration: 1,
      processGeneration: 1,
      provider: "claude",
      providerAccountId: unverified.id,
      routingProvenance: "explicit",
      appliedPointerRevision: null,
    });
    await expect(value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "continue under the explicitly bound unverified authority",
      session: unverifiedStarted.session.id,
    }, { signal })).resolves.toMatchObject({ session: { id: unverifiedStarted.session.id } });

    value.claude.readiness = "signed_in";
    value.claude.projection = {
      ...value.claude.projection,
      providerThreadId: "claude-thread-2",
      providerUpdatedAt: 21,
    };
    const started = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const observed = value.store.requireProviderAccountForProfile(
      added.account.id,
      "claude",
    );
    expect(observed).toMatchObject({ bindingGeneration: 2, readiness: "signed_in" });
    expect(value.store.requireSessionProviderAuthority(started.session.id)).toMatchObject({
      bindingGeneration: 2,
      processGeneration: 1,
      provider: "claude",
      providerAccountId: observed.id,
      routingProvenance: "explicit",
      appliedPointerRevision: null,
    });
    expect(() => value.store.requireSessionProviderAuthority(unverifiedStarted.session.id))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
  });

  test("owns the transcript: a sent message and a tool call are HRA's own records", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "ship the release", session: sessionId },
      { signal },
    );
    const profile = value.store.requireProfileById(accountId);
    const authority = liveAuthorityFor(value.store, profile.id);
    const threadId = value.store.requireSession(sessionId).providerThreadId;
    if (threadId === undefined) throw new Error("Expected a bound session.");
    const turnId = "codex-turn-1";
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-1",
      itemKind: "commandExecution",
      commandClass: "git commit",
      type: "itemStarted",
    });
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-1",
      itemKind: "commandExecution",
      commandClass: "git commit",
      status: "completed",
      type: "itemCompleted",
    });
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-2",
      itemKind: "agentMessage",
      type: "itemStarted",
    });
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-2",
      text: "Released.",
      type: "assistantDelta",
    });
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-2",
      itemKind: "agentMessage",
      status: "completed",
      type: "itemCompleted",
    });

    const transcript = await transcriptOf(value, sessionId);
    const kinds = transcript.records.map((record) => record.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("assistant");
    const user = transcript.records.find((record) => record.kind === "user");
    expect(user).toMatchObject({ actor: "human", text: "ship the release" });
    const call = transcript.records.find((record) => record.kind === "tool_call");
    const result = transcript.records.find((record) => record.kind === "tool_result");
    if (call?.kind !== "tool_call" || result?.kind !== "tool_result") {
      throw new Error("Expected one tool call and one tool result.");
    }
    // A result is linked to its call by the same opaque call id, and the
    // summary is the classified label, never the command itself.
    expect(result.callId).toBe(call.callId);
    expect(call.summary).toBe("commandExecution: git commit");
    expect(result.ok).toBe(true);
    // An agent-message item is conversation, not a tool call.
    expect(transcript.records.filter((record) => record.kind === "tool_call")).toHaveLength(1);
    expect(transcript.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("switches a live session from Codex to Claude and seeds the handoff", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "ship the release", session: sessionId },
      { signal },
    );

    const switched = await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    ) as {
      from: { preset: string; provider: string };
      seed: { digest: string; includedRecords: number; omittedRecords: number };
      to: { preset: string; provider: string };
    };

    expect(switched.from).toMatchObject({ preset: "high", provider: "codex" });
    expect(switched.to).toMatchObject({ preset: "fable-max", provider: "claude" });
    expect(switched.seed.digest).toMatch(/^[a-f0-9]{64}$/u);

    const session = value.store.requireSession(sessionId);
    expect(session.provider).toBe("claude");
    expect(session.preset).toBe("fable-max");
    expect(session.providerThreadId).toBe("claude-thread-1");
    // The outgoing provider was released, and its thread was not deleted.
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);

    // The seed reached the new provider as its first user message, marked as a
    // handoff, carrying its own omission count.
    const seeded = value.claude.seededMessages[0] ?? "";
    expect(seeded).toContain("[HRA provider handoff]");
    expect(seeded).toContain("This conversation ran on codex and now runs on claude.");
    expect(seeded).toContain("records were omitted");
    expect(seeded).toContain("ship the release");

    const transcript = await transcriptOf(value, sessionId);
    const boundary = transcript.records.find((record) => record.kind === "provider_switch");
    expect(boundary).toMatchObject({
      accountChanged: false,
      fromPreset: "high",
      fromProvider: "codex",
      seedDigest: switched.seed.digest,
      toPreset: "fable-max",
      toProvider: "claude",
    });
    const handoff = transcript.records.find(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    );
    expect(handoff).toBeDefined();

    // The next ordinary turn runs on Claude.
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "carry on", session: sessionId },
      { signal },
    );
    expect(value.claude.seededMessages.at(-1)).toBe("carry on");
  });

  test("releases a Claude session under its captured generation when the Codex mirror diverges", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    );
    const claudeAuthority = value.store.requireSessionProviderAuthority(sessionId);
    const codexBefore = value.store.requireProviderAccountAuthority(accountId, "codex");
    value.store.advanceProfileGeneration(accountId, codexBefore.processGeneration);
    const codexAfter = value.store.requireProviderAccountAuthority(accountId, "codex");
    expect(codexAfter.processGeneration).not.toBe(claudeAuthority.processGeneration);
    value.codex.projection = {
      providerThreadId: "codex-thread-2",
      title: "Returned session",
      status: "idle",
      providerUpdatedAt: 30,
    };

    await expect(value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "codex", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      from: { provider: "claude" },
      to: { provider: "codex" },
    });
    expect(value.claude.calls).toContain("end-session");
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-2",
    });
  });

  test("refuses a switch during an active turn and a preset the target cannot run", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    await expect(value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", preset: "low", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toThrow(/does not support the `low` model preset/u);

    value.codex.turnStatus = "inProgress";
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "long job", session: sessionId },
      { signal },
    );
    const refusal = await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("CONFLICT");
    expect((refusal as CommandFailure).message).toContain("active turn");
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
  });

  test("leaves the source provider intact when the target refuses to start", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    value.claude.startSessionError = new Error("Claude Code refused the session.");
    await expect(value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toThrow("Claude Code refused the session.");
    const session = value.store.requireSession(sessionId);
    expect(session.provider).toBe("codex");
    expect(session.preset).toBe("high");
    expect(session.providerThreadId).toBe("codex-thread-1");
    // The outgoing provider is released only after the target accepted, so a
    // refused target never strands a session on a released thread.
    expect(value.codex.endedThreads).toEqual([]);

    // A later switch still works.
    delete value.claude.startSessionError;
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    );
    expect(value.store.requireSession(sessionId).provider).toBe("claude");
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
  });

  test("quarantines a crash-adjacent provider switch and permits only exact local abandon", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    value.claude.projection = {
      ...value.claude.projection,
      providerThreadId: "claude-readiness-thread",
    };
    await value.service.execute({
      account: accountId,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal });
    const source = value.store.requireSessionProviderAuthority(sessionId);
    const target = value.store.requireProviderAccountAuthority(accountId, "claude");
    const sourceAuthority = {
      providerAccountId: source.providerAccountId,
      profileId: source.profileId,
      provider: source.provider,
      bindingGeneration: source.bindingGeneration,
      processGeneration: source.processGeneration,
    } as const;
    const providerAuthorities = [
      { role: "source" as const, authority: sourceAuthority, provenance: "session_switch_source" },
      { role: "target" as const, authority: target, provenance: "session_switch_target" },
    ];
    const key = "00000000-0000-4000-8000-0000000006c1";
    const attempt = value.store.prepareMutation({
      kind: "session.switch",
      authorityId: sessionId,
      authorityGeneration: target.processGeneration,
      request: {
        provider: "claude",
        preset: "fable-max",
        targetProfileId: accountId,
        seedDigest: "a".repeat(64),
      },
      idempotencyKey: key,
      providerAuthorities,
    });
    value.store.beginPreparedMutationEffect({
      attemptId: attempt.id,
      providerAuthorities,
    });
    const captured = value.store.readMutationProviderAuthorities(attempt.id);
    const callsBeforeRestart = {
      claude: [...value.claude.calls],
      codex: [...value.codex.calls],
    };

    const daemonGeneration = value.store.nextDaemonGeneration(`boot_${"a".repeat(32)}`);
    const restarted = new HraService({
      claude: value.claude,
      cloud: new OfflineCloud(),
      codex: value.codex,
      daemonAuthority: { assertCurrent: async () => {}, close: () => {} },
      daemonGeneration,
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    services.push(restarted);
    await restarted.recover();
    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "recovery_required" });
    expect(value.store.readMutation(key)).toMatchObject({
      state: "ambiguous",
      result: { code: "CLAUDE_DAEMON_RESTART_NO_RESUME" },
    });
    expect(value.store.readMutationProviderAuthorities(attempt.id)).toEqual(captured);
    await expect(restarted.execute({ kind: "session.recover", session: sessionId }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.claude.calls).toEqual(callsBeforeRestart.claude);
    expect(value.codex.calls).toEqual(callsBeforeRestart.codex);

    await expect(restarted.execute({ kind: "session.abandon", session: sessionId }, { signal }))
      .resolves.toMatchObject({
        idempotencyKey: key,
        session: { state: "terminal" },
        recovery: {
          resolved: true,
          resolution: "abandoned",
          providerEffectRetried: false,
          providerStateDeleted: false,
        },
      });
    expect(value.store.readMutation(key)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: {
        kind: "abandoned",
        evidence: {
          action: "user_abandon",
          providerEffectRetried: false,
          providerStateDeleted: false,
        },
      },
    });
    expect(value.store.readMutationProviderAuthorities(attempt.id)).toEqual(captured);
    expect(value.claude.calls).toEqual(callsBeforeRestart.claude);
    expect(value.codex.calls).toEqual(callsBeforeRestart.codex);
  });

  test("terminally settles active idle and unbound Claude authority on daemon loss without provider replay", async () => {
    const value = await fixture();
    const unrelated = await codexSession(value);
    const added = await value.service.execute(
      { kind: "account.add", label: "Claude restart authority" },
      { signal },
    ) as { account: { id: `acct_${string}` } };

    value.claude.projection = {
      providerThreadId: "claude-idle-restart",
      title: "Claude idle restart",
      status: "idle",
      providerUpdatedAt: 30,
    };
    const idle = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    value.claude.projection = {
      providerThreadId: "claude-active-restart",
      title: "Claude active restart",
      status: "active",
      activeTurnId: "claude-active-turn",
      providerUpdatedAt: 31,
    };
    const active = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };

    const project = value.store.listProjects()[0];
    if (project === undefined) throw new Error("Expected the fixture project.");
    const claudeAuthority = value.store.requireProviderAccountAuthority(added.account.id, "claude");
    const reviewed = claudeProfile(liveAuthorityFor(value.store, added.account.id, "claude"));
    const startKey = "00000000-0000-4000-8000-0000000006d1";
    const startAttempt = value.store.prepareMutation({
      kind: "session.start",
      authorityId: added.account.id,
      authorityGeneration: claudeAuthority.processGeneration,
      request: { projectId: project.id, preset: "fable-max", fast: false },
      idempotencyKey: startKey,
      providerAuthorities: [{
        role: "primary",
        authority: claudeAuthority,
        provenance: "session_start",
      }],
    });
    const unbound = value.store.beginSessionStartEffect({
      attemptId: startAttempt.id,
      profileId: added.account.id,
      profileGeneration: claudeAuthority.processGeneration,
      projectId: project.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
      providerAuthority: claudeAuthority,
      evidence: {
        kind: "session.start",
        projectId: project.id,
        clientMessageId: null,
        messageDigest: null,
        runtimeProfile: reviewed,
      },
    });

    const idleSession = value.store.requireSession(idle.session.id);
    const idleAuthority = value.store.requireSessionProviderAuthority(idle.session.id);
    const idleProviderAuthority = {
      providerAccountId: idleAuthority.providerAccountId,
      profileId: idleAuthority.profileId,
      provider: idleAuthority.provider,
      bindingGeneration: idleAuthority.bindingGeneration,
      processGeneration: idleAuthority.processGeneration,
    } as const;
    const sendKey = "00000000-0000-4000-8000-0000000006d2";
    const sendAttempt = value.store.prepareMutation({
      kind: "session.send",
      authorityId: idle.session.id,
      authorityGeneration: idleAuthority.processGeneration,
      request: { message: "uncertain Claude send" },
      idempotencyKey: sendKey,
      providerAuthorities: [{
        role: "primary",
        authority: idleProviderAuthority,
        provenance: "session_send",
      }],
    });
    value.store.beginSessionMutationEffect({
      attemptId: sendAttempt.id,
      sessionId: idle.session.id,
      profileGeneration: idleAuthority.processGeneration,
      providerAuthority: idleProviderAuthority,
      evidence: {
        kind: "session.send",
        providerThreadId: idleSession.providerThreadId as string,
        baseline: { providerUpdatedAt: 30, status: "idle", activeTurnId: null },
        clientMessageId: sendAttempt.id,
        messageDigest: createHash("sha256").update("uncertain Claude send").digest("hex"),
        runtimeProfile: reviewed,
      },
    });
    const dispatching = value.store.enqueue(idle.session.id, "uncertain Claude queue");
    value.store.beginQueueEffect({
      queueId: dispatching.id,
      sessionId: idle.session.id,
      profileGeneration: idleAuthority.processGeneration,
      providerAuthority: idleProviderAuthority,
      evidence: {
        kind: "queue.dispatch",
        queueId: dispatching.id,
        sessionId: idle.session.id,
        providerThreadId: idleSession.providerThreadId as string,
        profileGeneration: idleAuthority.processGeneration,
        baseline: { providerUpdatedAt: 30, status: "idle", activeTurnId: null },
        clientMessageId: dispatching.id,
        messageDigest: createHash("sha256").update("uncertain Claude queue").digest("hex"),
        runtimeProfile: reviewed,
      },
    });
    const pending = value.store.enqueue(active.session.id, "pending Claude queue");
    const captured = {
      dispatching: value.store.readQueueProviderAuthority(dispatching.id),
      send: value.store.readMutationProviderAuthorities(sendAttempt.id),
      start: value.store.readMutationProviderAuthorities(startAttempt.id),
    };
    const claudeCallsBeforeRestart = [...value.claude.calls];

    const daemonGeneration = value.store.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
    for (const sessionId of [idle.session.id, active.session.id, unbound.id]) {
      expect(value.store.requireSession(sessionId)).toMatchObject({ state: "terminal" });
      expect(() => value.store.requireSessionProviderAuthority(sessionId))
        .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
      const restartEvents = value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
      expect(restartEvents.filter((event) =>
        event.body.type === "connection"
          && event.body.state === "disconnected"
          && event.body.reason === "daemon_restart_no_resume"))
        .toHaveLength(1);
      expect(restartEvents.filter((event) =>
        event.body.type === "gap" && event.body.reason === "provider_restart"))
        .toHaveLength(1);
      const terminal = restartEvents.filter((event) =>
        event.body.type === "session_status" && event.body.status === "terminal");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        accountId: added.account.id,
        providerGeneration: claudeAuthority.processGeneration,
      });
      expect(value.store.listUnsettledMutations({ sessionId })).toEqual([]);
      expect(value.store.listUnsettledQueueEffects(sessionId)).toEqual([]);
    }
    expect(value.store.readMutation(sendKey)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: {
        kind: "abandoned",
        evidence: { outcome: "indeterminate", providerEffectRetried: false },
      },
    });
    expect(value.store.readMutation(startKey)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "abandoned", evidence: { outcome: "indeterminate" } },
    });
    expect(value.store.readQueueEffect(dispatching.id)).toMatchObject({
      resolution: {
        kind: "abandoned",
        evidence: { outcome: "indeterminate", providerEffectRetried: false },
      },
    });
    expect(value.store.requireQueue(dispatching.id)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireQueue(pending.id)).toMatchObject({ state: "cancelled" });
    expect(value.store.readMutationProviderAuthorities(sendAttempt.id)).toEqual(captured.send);
    expect(value.store.readMutationProviderAuthorities(startAttempt.id)).toEqual(captured.start);
    expect(value.store.readQueueProviderAuthority(dispatching.id)).toEqual(captured.dispatching);

    const restarted = new HraService({
      claude: value.claude,
      cloud: new OfflineCloud(),
      codex: value.codex,
      daemonAuthority: { assertCurrent: async () => {}, close: () => {} },
      daemonGeneration,
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    services.push(restarted);
    await restarted.recover();
    for (const sessionId of [idle.session.id, active.session.id, unbound.id]) {
      await expect(restarted.execute({ kind: "session.status", session: sessionId }, { signal }))
        .resolves.toMatchObject({
          advisory: { execution: "terminal" },
          providerObservation: { reason: "terminal", state: "not_applicable" },
        });
      await expect(restarted.execute({ kind: "session.show", session: sessionId, detail: false }, { signal }))
        .resolves.toMatchObject({
          session: { state: "terminal" },
          providerObservation: { reason: "terminal", state: "not_applicable" },
          next: expect.stringMatching(/Start a new Claude session/u),
        });
    }
    expect(value.claude.calls).toEqual(claudeCallsBeforeRestart);
    await expect(restarted.execute({ kind: "session.status", session: unrelated.sessionId }, { signal }))
      .resolves.toMatchObject({ providerObservation: { state: "live" } });
    expect(value.claude.calls).toEqual(claudeCallsBeforeRestart);
  });

  test("refuses a switch to the provider the session already runs", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const refusal = await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "codex", session: sessionId },
      { signal },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("INVALID_INPUT");
  });

  test("exports the neutral transcript as a letta-ai trajectory v1 document", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "ship the release", session: sessionId },
      { signal },
    );
    const profile = value.store.requireProfileById(accountId);
    const threadId = value.store.requireSession(sessionId).providerThreadId;
    if (threadId === undefined) throw new Error("Expected a bound session.");
    for (const type of ["itemStarted", "itemCompleted"] as const) {
      await value.service.observeCodexFact(liveAuthorityFor(value.store, profile.id), {
        connectionId: "30000000-0000-4000-8000-000000000001",
        threadId,
        turnId: "codex-turn-1",
        itemId: "item-1",
        itemKind: "mcpToolCall",
        server: "github",
        tool: "create_issue",
        ...(type === "itemCompleted" ? { status: "completed" } : {}),
        type,
      });
    }
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    );
    const transcript = await transcriptOf(value, sessionId);
    const trajectory = transcriptToTrajectory({
      transcript,
      provider: "claude",
      createdAt: 1_700_000_000_000,
    });
    for (const record of trajectory) trajectoryRecordSchema.parse(record);
    expect(trajectory[0]).toMatchObject({
      omitted_records: 0,
      provider: "claude",
      session_id: sessionId,
      source: "hra",
      transcript_digest: transcript.digest,
      type: "meta",
      version: 1,
    });
    const types = trajectory.map((record) => record.type);
    expect(types).toContain("user");
    expect(types).toContain("observation");
    const call = trajectory.find((record) => record.type === "tool_call");
    const tool = trajectory.find((record) => record.type === "tool");
    if (call?.type !== "tool_call" || tool?.type !== "tool") {
      throw new Error("Expected one trajectory tool call and one tool record.");
    }
    // The tool record links to its call, and neither carries a raw argument or
    // raw output: HRA never stored either.
    expect(tool.tool_call_id).toBe(call.id);
    expect(tool.ok).toBe(true);
    expect(call.name).toBe("github/create_issue");
    expect(JSON.parse(call.arguments)).toMatchObject({ hra_arguments_retained: false });
    expect(tool.content).toContain("never retained");
    // The handoff seed keeps exactly one explicit label.
    const handoff = trajectory.filter((record) =>
      record.type === "user" && record.content.includes("HRA provider handoff"));
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.type === "user" && handoff[0].content.startsWith(TRANSCRIPT_SEED_HEADER))
      .toBe(true);
  });
});
