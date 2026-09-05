import { afterEach, describe, expect, test } from "bun:test";
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
  ClaudeProcessExitUnprovenError,
  ClaudeSessionObservationError,
  UnavailableCloudControl,
  type ClaudeProcessIdentity,
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
  beforeEndSessionReturn?: () => Promise<void> | void;
  beforeLogoutReturn?: () => Promise<void> | void;
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
  async logout(): Promise<void> {
    this.calls.push("logout");
    await this.beforeLogoutReturn?.();
  }
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
    await this.beforeEndSessionReturn?.();
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
  readonly claimRequests: Array<Parameters<ClaudeRuntimePort["claimSession"]>[0]> = [];
  readonly endRequests: Array<Parameters<ClaudeRuntimePort["endSession"]>[0]> = [];
  readonly endedProcessIdentities: ClaudeProcessIdentity[] = [];
  readonly identityRequests: Array<
    Parameters<ClaudeRuntimePort["readSessionProcessIdentity"]>[0]
  > = [];
  readonly observeRequests: Array<Parameters<ClaudeRuntimePort["observeSession"]>[0]> = [];
  readonly startSessionRequests: Array<Parameters<ClaudeRuntimePort["startSession"]>[0]> = [];
  readonly seededMessages: string[] = [];
  beforeStartSessionAdmission?: (
    input: Parameters<ClaudeRuntimePort["startSession"]>[0],
  ) => Promise<void> | void;
  beforeStartSessionReturn?: () => Promise<void> | void;
  beforeStartTurnReturn?: () => Promise<void> | void;
  connectionId = "30000000-0000-4000-8000-000000000002";
  connectionIdOnClaim?: string;
  controllerLive = true;
  disconnectOnObserveRequest?: number;
  processIdentity: ClaudeProcessIdentity = {
    pid: 64_001,
    pidDomain: "darwin",
    procStart: "switch-claude-initial",
  };
  processIdentityOnClaim?: ClaudeProcessIdentity;
  startSessionError?: Error;
  #turns = 0;
  projection: CodexSessionProjection = {
    providerThreadId: "claude-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 20,
  };

  pinnedVersion(): string { return CLAUDE_PIN; }
  async readAccount(): Promise<CodexAccountProjection> {
    return { signedIn: true, email: "person@example.com" };
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
    this.startSessionRequests.push(input);
    if (this.startSessionError !== undefined) throw this.startSessionError;
    if (input.providerThreadId !== undefined) {
      this.projection = { ...this.projection, providerThreadId: input.providerThreadId };
    }
    await this.beforeStartSessionAdmission?.(input);
    await input.admitProcessIdentity?.(this.processIdentity);
    await this.beforeStartSessionReturn?.();
    this.controllerLive = true;
    return { ...this.projection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async claimSession(
    input: Parameters<ClaudeRuntimePort["claimSession"]>[0],
  ): ReturnType<ClaudeRuntimePort["claimSession"]> {
    this.calls.push("claim-session");
    this.claimRequests.push(input);
    this.controllerLive = true;
    if (this.processIdentityOnClaim !== undefined) {
      this.processIdentity = this.processIdentityOnClaim;
      delete this.processIdentityOnClaim;
    }
    if (this.connectionIdOnClaim !== undefined) {
      this.connectionId = this.connectionIdOnClaim;
      delete this.connectionIdOnClaim;
    }
    await input.admitProcessIdentity?.(this.processIdentity);
    this.projection = {
      ...this.projection,
      providerThreadId: input.providerThreadId,
      projectRoot: input.projectRoot,
      status: "idle",
      title: input.title,
    };
    delete (this.projection as { activeTurnId?: string }).activeTurnId;
    return {
      ...this.projection,
      effectiveRuntimeProfile: claudeProfile(input.authority),
    };
  }
  async readSessionProcessIdentity(
    input: Parameters<ClaudeRuntimePort["readSessionProcessIdentity"]>[0],
  ): ReturnType<ClaudeRuntimePort["readSessionProcessIdentity"]> {
    this.calls.push("read-identity");
    this.identityRequests.push(input);
    return this.processIdentity;
  }
  async observeSession(
    input: Parameters<ClaudeRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    this.calls.push("observe");
    this.observeRequests.push(input);
    if (this.disconnectOnObserveRequest === this.observeRequests.length) {
      this.controllerLive = false;
      throw new ClaudeSessionObservationError();
    }
    if (!this.controllerLive) throw new ClaudeSessionObservationError();
    return {
      connectionId: this.connectionId,
      projection: { ...this.projection, providerThreadId: input.providerThreadId },
      resumed: false,
    };
  }
  async readSession(): Promise<CodexSessionProjection> {
    this.calls.push("read");
    return this.projection;
  }
  async endSession(
    input: Parameters<ClaudeRuntimePort["endSession"]>[0],
  ): Promise<void> {
    this.calls.push("end-session");
    this.endRequests.push(input);
    this.endedProcessIdentities.push(this.processIdentity);
    this.controllerLive = false;
  }
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
    await this.beforeStartTurnReturn?.();
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
  interactionAuthority(): never { return this.#unsupported(); }
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
  return { claude, codex, documents, service, store };
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
  test("owns the transcript: a sent message and a tool call are HRA's own records", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "ship the release", session: sessionId },
      { signal },
    );
    const profile = value.store.requireProfileById(accountId);
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
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
    await value.service.settled();

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
    expect(session.providerThreadId).toMatch(/^[0-9a-f-]{36}$/u);
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

  test("holds the destination account lock through a cross-account provider switch", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    const targetGeneration = value.store
      .requireProfileById(target.account.id).processGeneration;

    const events: string[] = [];
    let targetStartEntered!: () => void;
    const targetStarted = new Promise<void>((resolve) => { targetStartEntered = resolve; });
    let releaseTargetStart!: () => void;
    const targetStartGate = new Promise<void>((resolve) => { releaseTargetStart = resolve; });
    value.claude.beforeStartSessionReturn = async () => {
      events.push("target-start");
      targetStartEntered();
      await targetStartGate;
    };
    value.codex.beforeEndSessionReturn = () => { events.push("source-release"); };
    value.claude.beforeStartTurnReturn = () => { events.push("seed"); };
    value.codex.beforeLogoutReturn = () => { events.push("logout"); };

    let switching: Promise<unknown> | undefined;
    let logout: Promise<unknown> | undefined;
    try {
      switching = value.service.execute({
        account: target.account.id,
        idempotencyKey: crypto.randomUUID(),
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      }, { signal });
      await targetStarted;

      let logoutSettled = false;
      logout = value.service.execute({
        account: target.account.id,
        idempotencyKey: crypto.randomUUID(),
        kind: "account.logout",
      }, { signal }).finally(() => { logoutSettled = true; });
      await Bun.sleep(0);

      expect(logoutSettled).toBe(false);
      expect(value.codex.calls.filter((call) => call === "logout")).toHaveLength(0);
      expect(value.store.requireProfileById(target.account.id)).toMatchObject({
        processGeneration: targetGeneration,
        state: "signed_in",
      });

      releaseTargetStart();
      const switched = await switching as {
        to: { account: `acct_${string}`; preset: string; provider: string };
      };
      await logout;

      expect(switched.to).toEqual({
        account: target.account.id,
        preset: "fable-max",
        provider: "claude",
      });
      expect(events).toEqual(["target-start", "source-release", "seed", "logout"]);
      expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
      const switchedSession = value.store.requireSession(sessionId);
      expect(switchedSession).toMatchObject({
        profileId: target.account.id,
        provider: "claude",
      });
      expect(switchedSession.providerThreadId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(value.store.latestSessionRuntimeProfile(sessionId)?.profile).toMatchObject({
        processGeneration: targetGeneration,
        profileId: target.account.id,
      });
    } finally {
      releaseTargetStart();
      await Promise.allSettled([
        ...(switching === undefined ? [] : [switching]),
        ...(logout === undefined ? [] : [logout]),
      ]);
    }
  });

  test("releases and resumes a switched-in Claude child lost before seeding", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    await value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.send",
        message: "preserve this context",
        session: sessionId,
      },
      { signal },
    );
    const initialIdentity = value.claude.processIdentity;
    const replacementIdentity: ClaudeProcessIdentity = {
      pid: 64_002,
      pidDomain: "darwin",
      procStart: "switch-claude-replacement",
    };
    const replacementConnectionId = "30000000-0000-4000-8000-000000000003";
    value.claude.disconnectOnObserveRequest = 1;
    value.claude.processIdentityOnClaim = replacementIdentity;
    value.claude.connectionIdOnClaim = replacementConnectionId;

    const switched = await value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      },
      { signal },
    ) as { seed: { delivered: boolean } };

    const switchedSession = value.store.requireSession(sessionId);
    const claudeThreadId = switchedSession.providerThreadId;
    if (claudeThreadId === undefined) throw new Error("Expected a bound Claude session.");
    expect(claudeThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(switched.seed.delivered).toBe(true);
    expect(value.claude.endRequests).toHaveLength(1);
    expect(value.claude.endRequests[0]?.providerThreadId).toBe(claudeThreadId);
    expect(value.claude.endedProcessIdentities).toEqual([initialIdentity]);
    expect(value.claude.claimRequests).toHaveLength(1);
    expect(value.claude.claimRequests[0]).toMatchObject({
      providerThreadId: claudeThreadId,
      sourceLiveness: "not_live",
      title: "New session",
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: claudeThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity: replacementIdentity,
      sessionId,
      state: "bound",
    });

    const firstObservation = value.claude.calls.indexOf("observe");
    const release = value.claude.calls.indexOf("end-session", firstObservation + 1);
    const claim = value.claude.calls.indexOf("claim-session", release + 1);
    const replacementObservation = value.claude.calls.indexOf("observe", claim + 1);
    const seedDelivery = value.claude.calls.indexOf("start-turn", replacementObservation + 1);
    expect(firstObservation).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(firstObservation);
    expect(claim).toBeGreaterThan(release);
    expect(replacementObservation).toBeGreaterThan(claim);
    expect(seedDelivery).toBeGreaterThan(replacementObservation);
    expect(value.claude.seededMessages).toHaveLength(1);
    expect(value.claude.seededMessages[0]).toContain("[HRA provider handoff]");
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

  test("stages target Claude launch authority before admission and binds it atomically", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    let stagedProviderThreadId: string | undefined;
    let stagedIntentId: string | undefined;
    value.claude.beforeStartSessionAdmission = (input) => {
      stagedProviderThreadId = input.providerThreadId;
      if (stagedProviderThreadId === undefined) {
        throw new Error("Expected HRA to reserve the Claude provider identity before launch.");
      }
      const intent = value.store.readClaudeProcessLaunchIntent({
        providerThreadId: stagedProviderThreadId,
        profileId: accountId,
        runtimeScope: "managed",
      });
      if (intent === null) throw new Error("Expected durable pre-admission launch authority.");
      stagedIntentId = intent.intentId;
      expect(intent).toMatchObject({
        profileId: accountId,
        runtimeScope: "managed",
        sessionId,
      });
      expect(value.store.readClaudeProcessAuthority({
        providerThreadId: stagedProviderThreadId,
        profileId: accountId,
        runtimeScope: "managed",
      })).toBeNull();
    };

    await expect(value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      to: { provider: "claude" },
    });

    if (stagedProviderThreadId === undefined || stagedIntentId === undefined) {
      throw new Error("Expected the Claude launch-intent callback to run.");
    }
    expect(stagedProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId: stagedProviderThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toBeNull();
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: stagedProviderThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity: value.claude.processIdentity,
      sessionId,
      state: "bound",
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      providerThreadId: stagedProviderThreadId,
    });
  });

  test("preserves the source session when a Claude child exit is unproven and never respawns it", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.claude.startSessionError = new ClaudeProcessExitUnprovenError();

    const first = await value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(CommandFailure);
    expect((first as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(value.claude.startSessionRequests).toHaveLength(1);
    const providerThreadId = value.claude.startSessionRequests[0]?.providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected a reserved Claude identity.");
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      profileId: accountId,
      runtimeScope: "managed",
      sessionId,
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toBeNull();
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "idle",
    });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "failed" });

    const replay = await value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(CommandFailure);
    expect((replay as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    const freshAttempt = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);
    expect(freshAttempt).toBeInstanceOf(CommandFailure);
    expect((freshAttempt as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(value.claude.startSessionRequests).toHaveLength(1);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "idle",
    });
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
      await value.service.observeCodexFact({
        id: profile.id,
        generation: profile.processGeneration,
        codexHome: "unused",
        desktopUserData: "unused",
      }, {
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
