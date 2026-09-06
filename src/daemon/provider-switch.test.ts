import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_PIN, CLAUDE_PIN_MODEL } from "../claude/pin";
import { ClaudeError } from "../claude/errors";
import type { Preset, PresetRequirement } from "../domain/presets";
import type {
  EffectiveClaudeRuntimeProfile,
  EffectiveRuntimeProfile,
} from "../domain/runtime-profile";
import {
  renderTranscriptSeed,
  sessionTranscriptSchema,
  TRANSCRIPT_SEED_HEADER,
  type SessionTranscript,
} from "../domain/transcript";
import {
  transcriptToTrajectory,
  trajectoryRecordSchema,
} from "../domain/trajectory";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { SessionSwitchStoreError, StateStore } from "../storage/state-store";
import {
  UnavailableCloudControl,
  type ClaudeRuntimePort,
  type ClaudeAccountReadinessProjection,
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
import { DaemonAuthoritySafetyError, type DaemonAuthorityFence } from "./daemon-lock";
import { CommandFailure, HraService } from "./service";
import type {
  HraFactsMemoryLifecyclePort,
  HraFactsMemoryLifecycleReceipt,
} from "./facts-memory-lifecycle";

const signal = new AbortController().signal;

const codexProfile = (
  authority: ProfileAuthority,
  preset: Preset,
  requirement?: PresetRequirement,
): EffectiveRuntimeProfile => {
  if (requirement?.effort === "provider-default") {
    throw new Error("A Codex fixture cannot use Devin's provider-default effort.");
  }
  return {
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: 2_000,
  preset,
  model: requirement?.model ?? (preset === "low" ? "gpt-5.6-luna" : "gpt-6-astra"),
  reasoningEffort: requirement?.effort ?? (preset === "ultra" ? "ultra" : "max"),
  serviceTier: null,
  fast: false,
  approvalPolicy: "on-request",
  reviewMode: "auto_review",
  permissionProfile: ":workspace",
  computerUse: true,
  pluginCapability: true,
  enabledApps: [],
  };
};

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
  discardRuntimeReview(): void {}
  readonly calls: string[] = [];
  readonly endedThreads: string[] = [];
  loginCalls = 0;
  endSessionError?: Error;
  turnStatus: "completed" | "inProgress" = "completed";
  endSessionErrorOnce?: Error;
  beforeEndSessionReturn?: (
    input: Parameters<CodexRuntimePort["endSession"]>[0],
  ) => Promise<void> | void;
  #turns = 0;
  projection: CodexSessionProjection = {
    providerThreadId: "codex-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 10,
  };

  async login(): Promise<CodexLoginOutcome> {
    this.loginCalls += 1;
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
      effectiveRuntimeProfile: codexProfile(input.authority, input.preset, input.requirement),
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
    if (this.endSessionError !== undefined) throw this.endSessionError;
    this.endedThreads.push(input.providerThreadId);
    await this.beforeEndSessionReturn?.(input);
    const error = this.endSessionErrorOnce;
    delete this.endSessionErrorOnce;
    if (error !== undefined) throw error;
  }
  async reviewTurnStart(
    input: Parameters<CodexRuntimePort["reviewTurnStart"]>[0],
  ): Promise<RuntimeStartReview> {
    this.calls.push("review-turn");
    return {
      reviewId: crypto.randomUUID(),
      kind: "turn_start",
      effectiveRuntimeProfile: codexProfile(input.authority, input.preset, input.requirement),
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
  readonly pendingReviewIds = new Set<string>();
  discardRuntimeReview(review: ClaudeRuntimeStartReview): void {
    this.pendingReviewIds.delete(review.reviewId);
  }
  readonly calls: string[] = [];
  readonly endedThreads: string[] = [];
  readonly seededMessages: string[] = [];
  interactionAuthorityCalls = 0;
  readiness?: "signed_in" | "signed_out" | "unverified";
  accountSignedIn = true;
  readonly accountSignedInResults: boolean[] = [];
  beforeReadAccountReturn?: () => Promise<void>;
  readAccountError?: Error;
  observeError?: Error;
  endSessionError?: Error;
  reviewProfileGenerationOffset = 0;
  startSessionError?: Error;
  startTurnError?: Error;
  endSessionErrorOnce?: Error;
  beforeStartSessionReturn?: (
    input: Parameters<ClaudeRuntimePort["startSession"]>[0],
    projection: CodexSessionProjection,
  ) => Promise<void> | void;
  beforeReviewSessionReturn?: (
    input: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0],
  ) => Promise<void> | void;
  beforeStartTurnReturn?: (
    input: Parameters<ClaudeRuntimePort["startTurn"]>[0],
  ) => Promise<void> | void;
  beforeReviewTurnReturn?: (
    input: Parameters<ClaudeRuntimePort["reviewTurnStart"]>[0],
  ) => Promise<void> | void;
  #turns = 0;
  projection: CodexSessionProjection = {
    providerThreadId: "claude-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 20,
  };

  pinnedVersion(): string { return CLAUDE_PIN; }
  async readAccount(): Promise<ClaudeAccountReadinessProjection> {
    this.calls.push("read-account");
    await this.beforeReadAccountReturn?.();
    if (this.readAccountError !== undefined) throw this.readAccountError;
    const signedIn = this.accountSignedInResults.shift() ?? this.accountSignedIn;
    return { readiness: this.readiness ?? (signedIn ? "signed_in" : "signed_out"), observedAt: 2_000 };
  }
  async close(): Promise<void> {}
  async reviewSessionStart(
    input: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-session");
    await this.beforeReviewSessionReturn?.(input);
    const review = {
      reviewId: crypto.randomUUID(),
      kind: "session_start" as const,
      effectiveRuntimeProfile: {
        ...claudeProfile(input.authority),
        processGeneration: input.authority.generation + this.reviewProfileGenerationOffset,
      },
    };
    this.pendingReviewIds.add(review.reviewId);
    return review;
  }
  async startSession(
    input: Parameters<ClaudeRuntimePort["startSession"]>[0],
  ): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile }> {
    this.calls.push("start-session");
    this.pendingReviewIds.delete(input.review.reviewId);
    if (this.startSessionError !== undefined) throw this.startSessionError;
    await this.beforeStartSessionReturn?.(input, this.projection);
    return { ...this.projection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async observeSession(
    input: Parameters<ClaudeRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    this.calls.push("observe");
    if (this.observeError !== undefined) throw this.observeError;
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
  async endSession(input: Parameters<ClaudeRuntimePort["endSession"]>[0]): Promise<void> {
    this.calls.push("end-session");
    if (this.endSessionError !== undefined) throw this.endSessionError;
    this.endedThreads.push(input.providerThreadId);
    const error = this.endSessionErrorOnce;
    delete this.endSessionErrorOnce;
    if (error !== undefined) throw error;
  }
  async reviewTurnStart(
    input: Parameters<ClaudeRuntimePort["reviewTurnStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-turn");
    await this.beforeReviewTurnReturn?.(input);
    const review = {
      reviewId: crypto.randomUUID(),
      kind: "turn_start" as const,
      effectiveRuntimeProfile: claudeProfile(input.authority),
    };
    this.pendingReviewIds.add(review.reviewId);
    return review;
  }
  async startTurn(
    input: Parameters<ClaudeRuntimePort["startTurn"]>[0],
  ): Promise<{
    turnId: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile;
  }> {
    this.calls.push("start-turn");
    this.pendingReviewIds.delete(input.review.reviewId);
    if (this.startTurnError instanceof ClaudeError) throw this.startTurnError;
    this.seededMessages.push(input.message);
    if (this.startTurnError !== undefined) throw this.startTurnError;
    this.#turns += 1;
    await this.beforeStartTurnReturn?.(input);
    return {
      turnId: `claude-turn-${String(this.#turns)}`,
      status: "completed",
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
    };
  }
  async steer(): Promise<void> { this.calls.push("steer"); }
  async interrupt(): Promise<void> { this.calls.push("interrupt"); }
  #unsupported(): never { throw new Error("This fixture does not drive that Claude capability."); }
  interactionAuthority(): never {
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

class SwitchDaemonAuthority {
  beforeAssertReturn?: () => Promise<void> | void;

  constructor(readonly delegate?: Pick<DaemonAuthorityFence, "assertCurrent" | "close">) {}

  async assertCurrent(): Promise<void> {
    if (this.delegate !== undefined) await this.delegate.assertCurrent();
    const hook = this.beforeAssertReturn;
    delete this.beforeAssertReturn;
    await hook?.();
  }

  close(): void { this.delegate?.close(); }
}

class SwitchFactsMemory implements HraFactsMemoryLifecyclePort {
  readonly cleanups: Array<Parameters<HraFactsMemoryLifecyclePort["cleanupSession"]>[0]> = [];
  readonly transfers: Array<Parameters<HraFactsMemoryLifecyclePort["transferSessionOwner"]>[0]> = [];
  readonly transferSourceStates: Array<"active" | "purged" | undefined> = [];
  readonly expiries = new Map<string, number>();
  readonly owners = new Map<string, string>();
  readonly states = new Map<string, "active" | "purged">();
  simulateExpiry = false;
  beforeTransferReturn?: (
    input: Parameters<HraFactsMemoryLifecyclePort["transferSessionOwner"]>[0],
  ) => Promise<void> | void;
  transferErrorOnce?: Error;

  #receipt(sessionId: string, state: "active" | "purged" = "active"):
    HraFactsMemoryLifecycleReceipt {
    return {
      bindingDigest: "a".repeat(64),
      epoch: 1,
      handleHash: state === "active" ? "b".repeat(64) : null,
      head: state === "active"
        ? { digest: "c".repeat(64), operationSha256: null, sequence: 0 }
        : null,
      sessionId,
      state,
    };
  }

  async cleanupSession(input: Parameters<HraFactsMemoryLifecyclePort["cleanupSession"]>[0]) {
    this.cleanups.push(input);
    if (this.owners.get(input.sessionId) !== input.ownerId) {
      throw new Error("FACTS_MEMORY_AUTHORITY_MISMATCH");
    }
    this.states.set(input.sessionId, "purged");
    return this.#receipt(input.sessionId, "purged");
  }

  async ensureSession(input: Parameters<HraFactsMemoryLifecyclePort["ensureSession"]>[0]) {
    this.owners.set(input.sessionId, input.ownerId);
    this.states.set(input.sessionId, "active");
    this.expiries.set(
      input.sessionId,
      Math.max(this.expiries.get(input.sessionId) ?? 0, input.expiresAt),
    );
    return this.#receipt(input.sessionId);
  }

  async transferSessionOwner(
    input: Parameters<HraFactsMemoryLifecyclePort["transferSessionOwner"]>[0],
  ) {
    this.transfers.push(input);
    this.transferSourceStates.push(this.states.get(input.sessionId));
    const error = this.transferErrorOnce;
    delete this.transferErrorOnce;
    if (error !== undefined) throw error;
    const owner = this.owners.get(input.sessionId);
    if (owner !== undefined && owner !== input.fromOwnerId && owner !== input.toOwnerId) {
      throw new Error("FACTS_MEMORY_AUTHORITY_MISMATCH");
    }
    this.owners.set(input.sessionId, input.toOwnerId);
    this.states.set(input.sessionId, "active");
    this.expiries.set(
      input.sessionId,
      Math.max(this.expiries.get(input.sessionId) ?? 0, input.expiresAt),
    );
    const hook = this.beforeTransferReturn;
    delete this.beforeTransferReturn;
    await hook?.(input);
    return this.#receipt(input.sessionId);
  }

  async forkSession(input: Parameters<HraFactsMemoryLifecyclePort["forkSession"]>[0]) {
    this.owners.set(input.childSessionId, input.ownerId);
    return this.#receipt(input.childSessionId);
  }

  async resumeSession(input: Parameters<HraFactsMemoryLifecyclePort["resumeSession"]>[0]) {
    return this.#receipt(input.sessionId);
  }

  async sweepExpired(now: number) {
    let purged = 0;
    if (this.simulateExpiry) {
      for (const [sessionId, expiresAt] of this.expiries) {
        if (this.states.get(sessionId) === "active" && expiresAt <= now) {
          this.states.set(sessionId, "purged");
          purged += 1;
        }
      }
    }
    return { attempted: purged, failed: 0, purged };
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
  daemonAuthority: SwitchDaemonAuthority;
  documents: string;
  factsMemory: SwitchFactsMemory;
  daemonGeneration: number;
  paths: ReturnType<typeof resolveStatePaths>;
  service: HraService;
  store: StateStore;
}>;

async function fixture(
  nowOrAuthority: (() => number) | Pick<DaemonAuthorityFence, "assertCurrent" | "close"> = Date.now,
  daemonGeneration = 0,
): Promise<Fixture> {
  const now = typeof nowOrAuthority === "function" ? nowOrAuthority : Date.now;
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
  const daemonAuthority = new SwitchDaemonAuthority(
    typeof nowOrAuthority === "function" ? undefined : nowOrAuthority,
  );
  const factsMemory = new SwitchFactsMemory();
  const service = new HraService({
    claude,
    cloud: new OfflineCloud(),
    codex,
    daemonAuthority,
    factsMemory,
    now,
    daemonGeneration,
    paths,
    platform: "linux",
    requestStop: () => undefined,
    store,
  });
  services.push(service);
  return { claude, codex, daemonAuthority, daemonGeneration, documents, factsMemory, paths, service, store };
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

function capturedAuthorityForSession(
  store: StateStore,
  sessionId: string,
): ProfileAuthority {
  const authority = store.requireCapturedSessionProviderAuthority(sessionId as `sess_${string}`);
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

async function reopenFixture(value: Fixture): Promise<Fixture> {
  await value.service.close();
  const storeIndex = stores.indexOf(value.store);
  if (storeIndex < 0) throw new Error("Expected the provider-switch store to be tracked.");
  value.store.close();
  stores.splice(storeIndex, 1);

  const store = new StateStore(value.paths);
  stores.push(store);
  const daemonGeneration = store.nextDaemonGeneration(
    `boot_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  const codex = new SwitchFakeCodex();
  const claude = new SwitchFakeClaude();
  const daemonAuthority = new SwitchDaemonAuthority();
  const factsMemory = value.factsMemory;
  const service = new HraService({
    claude,
    cloud: new OfflineCloud(),
    codex,
    daemonAuthority,
    factsMemory,
    daemonGeneration,
    paths: value.paths,
    platform: "linux",
    requestStop: () => undefined,
    store,
  });
  services.push(service);
  await service.recover();
  return {
    claude,
    codex,
    daemonAuthority,
    daemonGeneration,
    factsMemory,
    documents: value.documents,
    paths: value.paths,
    service,
    store,
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

async function claudeSession(value: Fixture): Promise<Readonly<{
  accountId: `acct_${string}`;
  sessionId: `sess_${string}`;
}>> {
  const added = await value.service.execute(
    { kind: "account.add", label: "Claude work" },
    { signal },
  ) as { account: { id: `acct_${string}` } };
  await value.service.execute(
    { kind: "project.add", label: "Claude work docs", path: value.documents },
    { signal },
  );
  const started = await value.service.execute(
    {
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    },
    { signal },
  ) as { session: { id: `sess_${string}` } };
  return { accountId: added.account.id, sessionId: started.session.id };
}

async function signedInCodexAccount(
  value: Fixture,
  label: string,
): Promise<`acct_${string}`> {
  const added = await value.service.execute(
    { kind: "account.add", label },
    { signal },
  ) as { account: { id: `acct_${string}` } };
  await value.service.execute(
    { account: added.account.id, deviceCode: false, kind: "account.login" },
    { signal },
  );
  return added.account.id;
}

const transcriptOf = async (
  value: Fixture,
  sessionId: string,
): Promise<SessionTranscript> => sessionTranscriptSchema.parse(await value.service.execute(
  { kind: "session.transcript", limit: 500, session: sessionId },
  { signal },
));

/**
 * Writes the released seed-before-release protocol explicitly, under current
 * exact account fences. This isolates its retained recovery algorithm from new
 * dispatch; schema-38 migration evidence is covered by storage upgrade tests.
 */
async function recordHistoricalSwitchProgress(
  value: Fixture,
  input: Readonly<{
    account?: `acct_${string}`;
    idempotencyKey: string;
    provider: "codex" | "claude";
    session: `sess_${string}`;
    stage: "target_started" | "seed_intended" | "seed_settled" | "source_released";
  }>,
): Promise<void> {
  const session = value.store.requireSession(input.session);
  if (session.providerThreadId === undefined) throw new Error("Expected historical source thread.");
  const source = value.store.requireProfileById(session.profileId);
  const target = value.store.requireProfileById(input.account ?? source.id);
  if (input.provider === "claude") {
    const before = value.store.requireProviderAccountAuthority(target.id, "claude");
    if (before.processGeneration === 0) {
      value.store.advanceProviderAccountProcessGeneration({
        expectedProcessGeneration: 0,
        profileId: target.id,
        provider: "claude",
      });
    }
    value.store.observeProviderAccountReadiness({
      expectedBindingGeneration: before.bindingGeneration,
      observedAt: 2_000,
      profileId: target.id,
      provider: "claude",
      readiness: "signed_in",
    });
  }
  const sourceAuthority = value.store.requireProviderAccountAuthority(source.id, session.provider);
  const targetAuthority = value.store.requireProviderAccountAuthority(target.id, input.provider);
  const targetPreset = input.provider === "claude" ? "fable-max" : "high";
  const historicalTarget = liveAuthorityFor(value.store, target.id, input.provider);
  const runtimeProfile = input.provider === "claude"
    ? claudeProfile(historicalTarget)
    : codexProfile(historicalTarget, targetPreset);
  const transcript = await transcriptOf(value, session.id);
  const seed = renderTranscriptSeed({
    fromProvider: session.provider,
    toProvider: input.provider,
    transcript,
  });
  const attempt = value.store.prepareMutation({
    authorityGeneration: targetAuthority.processGeneration,
    authorityId: session.id,
    idempotencyKey: input.idempotencyKey,
    kind: "session.switch",
    providerAuthorities: [
      { authority: sourceAuthority, role: "source", provenance: "legacy_switch_source" },
      { authority: targetAuthority, role: "target", provenance: "legacy_switch_target" },
    ],
    request: {
      provider: input.provider,
      preset: targetPreset,
      targetProfileId: target.id,
      seedDigest: seed.digest,
    },
  });
  value.store.beginSessionProviderSwitchEffect({
    attemptId: attempt.id,
    sessionId: session.id,
    ...(input.provider === "claude" ? {
      providerAuthentication: {
        profileId: target.id,
        processGeneration: targetAuthority.processGeneration,
        provider: "claude" as const,
        signedIn: true as const,
      },
    } : {}),
    evidence: {
      kind: "session.switch",
      daemonGeneration: value.daemonGeneration,
      requestedAccountId: input.account ?? null,
      requestedPreset: null,
      sourceProfileId: source.id,
      sourceProcessGeneration: sourceAuthority.processGeneration,
      sourceProvider: session.provider,
      sourceProviderThreadId: session.providerThreadId,
      sourcePreset: session.preset,
      targetProfileId: target.id,
      targetProcessGeneration: targetAuthority.processGeneration,
      targetProvider: input.provider,
      targetPreset,
      transcriptDigest: transcript.digest,
      seedDigest: seed.digest,
      seedIncludedRecords: seed.includedRecords,
      seedOmittedRecords: seed.omittedRecords,
      runtimeProfile,
    },
  });
  const providerThreadId = input.provider === "claude" ? "claude-thread-1" : "codex-thread-1";
  const shared = { attemptId: attempt.id, sessionId: session.id, providerThreadId };
  value.store.recordSessionProviderSwitchTarget(shared);
  if (input.stage !== "target_started") {
    value.store.recordSessionProviderSwitchSeedIntent({ ...shared, seedText: seed.text, runtimeProfile });
  }
  if (input.stage === "seed_settled" || input.stage === "source_released") {
    value.store.recordSessionProviderSwitchSeedResult({
      ...shared,
      runtimeProfile,
      turnId: input.provider === "claude" ? "claude-turn-1" : "codex-turn-1",
      turnStatus: "completed",
    });
  }
  if (input.stage === "source_released") {
    value.store.recordSessionProviderSwitchSourceReleased(shared);
    const current = value.store.requireSession(session.id);
    value.store.bindSessionProviderSwitchRecoveryTarget({
      attemptId: attempt.id,
      sessionId: session.id,
      expectedSessionRevision: current.revision,
      title: current.title,
      providerUpdatedAt: input.provider === "claude" ? 20 : 10,
    });
  }
  expect(value.store.transitionMutation(attempt.id, "effect_started", "ambiguous", {
    code: "RECOVERY_REQUIRED",
  })).toBe(true);
  value.store.quarantineSession(session.id);
}

const leaveUnseededTargetUnsettled = async (
  value: Fixture,
  sessionId: `sess_${string}`,
  idempotencyKey: string,
): Promise<void> => {
  await recordHistoricalSwitchProgress(value, {
    idempotencyKey, provider: "claude", session: sessionId, stage: "target_started",
  });
};

const leaveFinalSwitchCommitUnsettled = async (
  value: Fixture,
  command: Readonly<{
    account?: `acct_${string}`;
    idempotencyKey: string;
    provider: "claude" | "codex";
    session: `sess_${string}`;
  }>,
): Promise<void> => {
  await recordHistoricalSwitchProgress(value, { ...command, stage: "source_released" });
};

const expectCurrentSwitchSuccessors = (
  value: Fixture,
  idempotencyKey: string,
): void => {
  const attempt = value.store.readMutation(idempotencyKey);
  if (attempt?.evidence?.evidence.kind !== "session.switch") {
    throw new Error("Expected immutable provider-switch evidence.");
  }
  const evidence = attempt.evidence.evidence;
  if (evidence.daemonGeneration === undefined) {
    throw new Error("Expected the provider switch to name its daemon generation.");
  }
  expect(evidence.daemonGeneration).toBeLessThan(value.daemonGeneration);
  for (const authority of [
    {
      originGeneration: evidence.sourceProcessGeneration,
      profileId: evidence.sourceProfileId,
      provider: evidence.sourceProvider,
    },
    {
      originGeneration: evidence.targetProcessGeneration,
      profileId: evidence.targetProfileId,
      provider: evidence.targetProvider,
    },
  ] as const) {
    const current = value.store.requireProviderAccountForProfile(authority.profileId, authority.provider);
    expect(current.processGeneration).toBeGreaterThan(authority.originGeneration);
    if (authority.provider === "codex") {
      const raw = new Database(value.paths.database, { readonly: true });
      try {
        expect({
          current: value.store.isSessionMutationProviderAuthorityCurrent({
            attemptId: attempt.id,
            ...authority,
          }),
          currentAccount: current,
          frozen: value.store.readMutationProviderAuthorities(attempt.id),
          successors: raw.query(
            "SELECT provider,from_generation,to_generation FROM session_mutation_authority_rebinds WHERE attempt_id=? AND profile_id=?",
          ).all(attempt.id, authority.profileId),
          mutationState: attempt.state,
        }).toMatchObject({ current: true });
      } finally { raw.close(); }
    } else {
      const raw = new Database(value.paths.database, { readonly: true });
      try {
        expect(raw.query(
          "SELECT 1 FROM session_mutation_authority_rebinds WHERE attempt_id=? AND provider='claude' LIMIT 1",
        ).get(attempt.id)).toBeNull();
      } finally { raw.close(); }
    }
  }
};

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
    await expect(value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(value.claude.calls).toEqual(["read-account"]);
    expect(value.store.listSessions()).toHaveLength(0);
    expect(value.store.requireProviderAccountForProfile(added.account.id, "codex"))
      .toMatchObject({ bindingGeneration: 1, readiness: "signed_out" });
    expect(value.store.requireProviderAccountForProfile(added.account.id, "claude"))
      .toMatchObject({ bindingGeneration: 1, readiness: "unverified" });

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
  });

  test("starts and operates a Claude session while the profile's Codex account remains signed out", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Work" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Work docs", path: value.documents },
      { signal },
    );

    expect(value.store.requireProfileById(added.account.id).state).toBe("signed_out");
    const started = await value.service.execute(
      {
        account: added.account.id,
        fast: false,
        kind: "session.start",
        preset: "fable-max",
        provider: "claude",
      },
      { signal },
    ) as { session: { id: `sess_${string}` } };

    expect(value.claude.calls.slice(0, 2)).toEqual([
      "read-account",
      "review-session",
    ]);
    expect(value.store.requireProfileById(added.account.id).state).toBe("signed_out");
    await value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.send",
        message: "continue in Claude",
        session: started.session.id,
      },
      { signal },
    );
    expect(value.claude.seededMessages.at(-1)).toBe("continue in Claude");
    expect(value.store.requireProfileById(added.account.id).state).toBe("signed_out");
  });

  test("releases an idle Claude session before granting login for an expired account", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await claudeSession(value);
    value.claude.accountSignedIn = false;
    const loginKey = crypto.randomUUID();

    await expect(value.service.execute({
      account: accountId,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: false },
      login: { status: "launch_granted" },
    });

    expect(value.store.requireProfileById(accountId).state).toBe("signed_out");
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "terminal",
    });
    expect(value.claude.endedThreads).toEqual(["claude-thread-1"]);
    expect(value.store.readMutation(loginKey)).toMatchObject({
      authorityId: accountId,
      kind: "account.claude-login",
      state: "effect_started",
    });
    const bodies = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId,
    }).events.map((event) => event.body);
    expect(bodies).toContainEqual({
      reason: "Claude account login",
      state: "disconnected",
      type: "connection",
    });
    expect(bodies).toContainEqual({
      activeTurnId: null,
      status: "terminal",
      type: "session_status",
    });
  });

  test("does not touch an idle Claude session with queued authority when login is requested", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await claudeSession(value);
    const queued = value.store.enqueue(sessionId, "send after this finishes");
    value.claude.accountSignedIn = false;
    const loginKey = crypto.randomUUID();

    await expect(value.service.execute({
      account: accountId,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { provider: "claude", retryable: true },
    });

    expect(value.claude.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "idle" });
    expect(value.store.requireQueue(queued.id)).toMatchObject({ state: "pending" });
    expect(value.store.readMutation(loginKey)).toBeNull();
  });

  test("reports an ordinary Claude observation failure as bounded unavailable", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    value.claude.observeError = new Error("Claude runtime exited");

    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        basis: "provider_read",
        code: "resume_unavailable",
        state: "unavailable",
      },
      session: { id: sessionId },
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "idle",
    });
  });

  test("refuses a new Claude session when Claude reports the profile signed out", async () => {
    const value = await fixture();
    value.claude.accountSignedIn = false;
    const added = await value.service.execute(
      { kind: "account.add", label: "Work" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Work docs", path: value.documents },
      { signal },
    );

    const idempotencyKey = crypto.randomUUID();
    const refusal = await value.service.execute(
      {
        account: added.account.id,
        fast: false,
        idempotencyKey,
        kind: "session.start",
        preset: "fable-max",
        provider: "claude",
      },
      { signal },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("INTERACTION_REQUIRED");
    expect((refusal as CommandFailure).details).toEqual({
      accountSelector: added.account.id,
      accountState: "signed_out",
      readiness: "signed_out",
      nextCommand: `hra account login ${added.account.id} --provider claude`,
      provider: "claude",
    });
    expect(value.claude.calls).toEqual(["read-account"]);
    expect(value.claude.pendingReviewIds.size).toBe(0);
    expect(value.store.readMutation(idempotencyKey)).toBeNull();
    expect(value.store.requireProfileById(added.account.id).state).toBe("signed_out");
  });

  test("leaves no session-start authority when Claude status cannot be read", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Status failure" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Status failure docs", path: value.documents },
      { signal },
    );
    value.claude.readAccountError = new Error("Claude status failed");
    const idempotencyKey = crypto.randomUUID();

    await expect(value.service.execute({
      account: added.account.id,
      fast: false,
      idempotencyKey,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toThrow("Claude status failed");
    expect(value.store.readMutation(idempotencyKey)).toBeNull();
    expect(value.claude.pendingReviewIds.size).toBe(0);
    expect(value.claude.calls).toEqual(["read-account"]);
  });

  test("keeps a pre-effect start replayable and releases its review when validation fails", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Review cleanup" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Review cleanup docs", path: value.documents },
      { signal },
    );
    value.claude.reviewProfileGenerationOffset = 1;
    const idempotencyKey = crypto.randomUUID();

    await expect(value.service.execute({
      account: added.account.id,
      fast: false,
      idempotencyKey,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toThrow("MUTATION_EFFECT_RUNTIME_PROFILE_MISMATCH");
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });
    expect(value.store.listUnsettledMutations({ authorityId: added.account.id })).toEqual([]);
    expect(value.claude.pendingReviewIds.size).toBe(0);
    expect(value.claude.calls).toEqual(["read-account", "review-session"]);

    value.claude.reviewProfileGenerationOffset = 0;
    await expect(value.service.execute({
      account: added.account.id,
      fast: false,
      idempotencyKey,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).resolves.toMatchObject({ session: { provider: "claude" } });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    expect(value.claude.pendingReviewIds.size).toBe(0);
  });

  test("blocks a new Claude provider effect while foreground login is unsettled", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Foreground owner" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Foreground owner docs", path: value.documents },
      { signal },
    );
    const profile = value.store.requireProfileById(added.account.id);
    const providerAuthority = value.store.requireProviderAccountAuthority(profile.id, "claude");
    const loginKey = crypto.randomUUID();
    const attempt = value.store.prepareMutation({
      authorityGeneration: providerAuthority.processGeneration,
      authorityId: profile.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login",
      providerAuthorities: [{ role: "primary", authority: providerAuthority, provenance: "account_claude_login" }],
      request: { provider: "claude" },
    });
    value.store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      evidence: {
        baselineSignedIn: false,
        kind: "account.claude-login",
        provider: "claude",
      },
      profileGeneration: providerAuthority.processGeneration,
      profileId: profile.id,
    });
    const startKey = crypto.randomUUID();

    await expect(value.service.execute({
      account: profile.id,
      fast: false,
      idempotencyKey: startKey,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readMutation(startKey)).toBeNull();
    expect(value.claude.pendingReviewIds.size).toBe(0);
    expect(value.claude.calls).toEqual([]);
  });

  test("refuses a switch when the target Claude account is signed out", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    value.claude.accountSignedIn = false;

    const refusal = await value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      },
      { signal },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("INTERACTION_REQUIRED");
    expect((refusal as CommandFailure).message).toContain(
      "hra account login",
    );
    expect((refusal as CommandFailure).details).toMatchObject({
      accountState: "signed_out",
      nextCommand: expect.stringContaining("--provider claude"),
      provider: "claude",
    });
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.claude.calls).toEqual(["read-account"]);
  });

  test("refuses a switch while the target account has an unsettled Claude login", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const profile = value.store.requireProfileById(accountId);
    const providerAuthority = value.store.requireProviderAccountAuthority(profile.id, "claude");
    const loginKey = crypto.randomUUID();
    const attempt = value.store.prepareMutation({
      authorityGeneration: providerAuthority.processGeneration,
      authorityId: profile.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login",
      providerAuthorities: [{ role: "primary", authority: providerAuthority, provenance: "account_claude_login" }],
      request: { provider: "claude" },
    });
    value.store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      evidence: {
        baselineSignedIn: false,
        kind: "account.claude-login",
        provider: "claude",
      },
      profileGeneration: providerAuthority.processGeneration,
      profileId: profile.id,
    });

    await expect(value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.claude.calls).toEqual([]);
    expect(value.claude.pendingReviewIds.size).toBe(0);
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

  test("drops only the switching session's source protocol notice during target start", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const sourceAuthority = liveAuthorityFor(value.store, accountId, "codex");
    value.claude.beforeStartSessionReturn = async () => {
      await value.service.observeCodexFact(sourceAuthority, {
        connectionId: "30000000-0000-4000-8000-000000000001",
        method: "provider/switch-race-notice",
        type: "protocolNotice",
      });
    };

    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-0000000007b1",
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({ seed: { delivered: true } });
    const notices = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId,
    }).events.filter((event) => event.body.type === "protocol_incompatible");
    expect(notices).toEqual([]);
  });

  test("does not swallow a shared Codex disconnect during source release", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    value.codex.projection = {
      providerThreadId: "codex-thread-2",
      providerUpdatedAt: 12,
      status: "idle",
      title: "Unrelated source session",
    };
    const unrelated = await value.service.execute({
      account: source.accountId,
      fast: false,
      kind: "session.start",
      preset: "high",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const authority = liveAuthorityFor(value.store, source.accountId, "codex");
    const generationBefore = value.store.requireProfileById(source.accountId)
      .processGeneration;
    value.codex.beforeEndSessionReturn = async () => {
      await value.service.observeCodexFact(authority, {
        connectionId: "30000000-0000-4000-8000-000000000001",
        reason: "process_exit",
        type: "providerDisconnected",
      });
    };

    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-0000000007b3",
      kind: "session.switch",
      provider: "claude",
      session: source.sessionId,
    }, { signal })).resolves.toMatchObject({ seed: { delivered: true } });
    await value.service.settled();

    const unrelatedEvents = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: unrelated.session.id,
    }).events;
    expect(unrelatedEvents.some((event) => event.body.type === "connection"
      && event.body.state === "disconnected")).toBe(true);
    expect(unrelatedEvents.some((event) => event.body.type === "gap"
      && event.body.reason === "provider_disconnect")).toBe(true);
    expect(value.store.requireProfileById(source.accountId).processGeneration)
      .toBe(generationBefore + 1);
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      profileId: source.accountId,
      provider: "claude",
    });
  });

  test("reconciles before seed when an exact target error arrives during source release", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    let targetCallbackDelivered = false;
    value.codex.beforeEndSessionReturn = async () => {
      targetCallbackDelivered = true;
      const targetAuthority = liveAuthorityFor(value.store, accountId, "claude");
      await value.service.observeClaudeFact(targetAuthority, {
        code: "TARGET_FAILED_DURING_SOURCE_RELEASE",
        connectionId: "30000000-0000-4000-8000-000000000002",
        message: "target callback while the source provider was releasing",
        providerThreadId: value.claude.projection.providerThreadId,
        terminal: true,
        turnId: null,
        type: "providerError",
      });
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007bc",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(targetCallbackDelivered).toBe(true);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "TARGET_FACT_BEFORE_SEED",
        phase: "reconciliation_required",
      });

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("replays the immutable settled switch receipt before current-state no-op checks", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const sourceSession = value.store.requireSession(sessionId);
    const sourceAuthority = value.store.requireSessionProviderAuthority(sessionId);
    if (sourceSession.providerThreadId === undefined) throw new Error("Expected a source thread.");
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a1";
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };
    const first = await value.service.execute(command, { signal });
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };

    await expect(value.service.execute(command, { signal })).resolves.toEqual(first);
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);

    await expect(value.service.executeRemote(command, {
      sessionId,
      profileId: sourceAuthority.profileId,
      processGeneration: sourceAuthority.processGeneration + 1,
      provider: sourceAuthority.provider,
      providerAccountId: sourceAuthority.providerAccountId,
      bindingGeneration: sourceAuthority.bindingGeneration,
      providerThreadId: sourceSession.providerThreadId,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);

    const conflict = await value.service.execute({
      ...command,
      provider: "codex",
    }, { signal }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(CommandFailure);
    expect((conflict as CommandFailure).code).toBe("CONFLICT");
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("keeps the settled receipt stable when a deferred target fact is lost", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const appendEvent = value.store.appendPublicSessionEvent.bind(value.store);
    let rejectDeferredFact = true;
    Object.defineProperty(value.store, "appendPublicSessionEvent", {
      configurable: true,
      value: (input: Parameters<StateStore["appendPublicSessionEvent"]>[0]) => {
        if (rejectDeferredFact && input.body.type === "error"
          && input.body.code === "DEFERRED_TARGET_NOTICE") {
          rejectDeferredFact = false;
          throw new Error("forced deferred-fact persistence loss");
        }
        return appendEvent(input);
      },
    });
    value.claude.beforeStartTurnReturn = async (input) => {
      await value.service.observeClaudeFact(input.authority, {
        connectionId: "30000000-0000-4000-8000-000000000002",
        code: "DEFERRED_TARGET_NOTICE",
        message: "deferred target notice",
        providerThreadId: input.providerThreadId,
        terminal: false,
        turnId: null,
        type: "providerError",
      });
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b0",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    const first = await value.service.execute(command, { signal });
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    expect(rejectDeferredFact).toBe(false);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "seed_settled" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "recovery_required",
    });
    await expect(value.service.execute(command, { signal })).resolves.toEqual(first);
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("reconciles before startTurn when one target error arrives during seed review", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    let targetCallbackDelivered = false;
    value.claude.beforeReviewTurnReturn = async (input) => {
      targetCallbackDelivered = true;
      await value.service.observeClaudeFact(input.authority, {
        code: "TARGET_FAILED_DURING_SEED_REVIEW",
        connectionId: "30000000-0000-4000-8000-000000000002",
        message: "target callback while seed review was pending",
        providerThreadId: input.providerThreadId,
        terminal: true,
        turnId: null,
        type: "providerError",
      });
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007bd",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(targetCallbackDelivered).toBe(true);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "TARGET_FACT_BEFORE_SEED_EFFECT",
        phase: "reconciliation_required",
      });

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("reconciles without sending the seed when target facts overflow during review", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    value.claude.beforeReviewTurnReturn = async (input) => {
      // Fill the exact target-thread buffer, then deliver one more fact while
      // reviewTurnStart still owns the provider-neutral pre-effect boundary.
      for (let index = 0; index <= 256; index += 1) {
        await value.service.observeClaudeFact(input.authority, {
          connectionId: "30000000-0000-4000-8000-000000000002",
          code: `DEFERRED_OVERFLOW_${String(index)}`,
          message: "bounded target callback",
          providerThreadId: input.providerThreadId,
          terminal: false,
          turnId: null,
          type: "providerError",
        });
      }
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b4",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "reconciliation_required" });

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("rechecks target fact custody after the daemon fence and before seed effect", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    let reviewPostFenceArmedStartFence = false;
    let startPreFenceOverflowed = false;
    value.claude.beforeReviewTurnReturn = (input) => {
      // The review effect's post-operation fence consumes this first hook.
      // It arms a second hook that only the next effect's pre-operation fence
      // can consume, after the service's outer overflow guard has run.
      value.daemonAuthority.beforeAssertReturn = () => {
        reviewPostFenceArmedStartFence = true;
        value.daemonAuthority.beforeAssertReturn = async () => {
          startPreFenceOverflowed = true;
          for (let index = 0; index <= 256; index += 1) {
            await value.service.observeClaudeFact(input.authority, {
              connectionId: "30000000-0000-4000-8000-000000000002",
              code: `FENCE_OVERFLOW_${String(index)}`,
              message: "bounded target callback at the effect fence",
              providerThreadId: input.providerThreadId,
              terminal: false,
              turnId: null,
              type: "providerError",
            });
          }
        };
      };
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b5",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
    expect(reviewPostFenceArmedStartFence).toBe(true);
    expect(startPreFenceOverflowed).toBe(true);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "SEED_FACT_OVERFLOW",
        phase: "reconciliation_required",
      });
  });

  test("retries only the exact idempotent source release under one open journal", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a2";
    value.codex.endSessionErrorOnce = new Error("lost exact release response");
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "source_releasing",
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);

    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      seed: { delivered: true },
      to: { provider: "claude" },
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(2);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "seed_settled",
      sourceRelease: { status: "already_released" },
    });
  });

  test("does not replay provider effects when a source-releasing journal loses target proof", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = "00000000-0000-4000-8000-0000000007c8";
    value.codex.endSessionErrorOnce = new Error("hold source-releasing for corruption");
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "source_releasing",
      targetStart: { providerThreadId: "claude-thread-1" },
    });
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    const database = new Database(value.store.paths.database, { create: false, strict: true });
    try {
      database.exec(`
        PRAGMA foreign_keys=OFF;
        DROP TRIGGER session_switch_target_start_receipts_immutable_delete;
      `);
      database.query(
        `DELETE FROM session_switch_target_start_receipts
         WHERE attempt_id=(
           SELECT id FROM mutation_attempts WHERE idempotency_key=?
         )`,
      ).run(idempotencyKey);
      database.exec("PRAGMA foreign_keys=ON");
    } finally {
      database.close(false);
    }

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { reason: "SESSION_SWITCH_RECOVERY_CORRUPT" },
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("maps malformed switch replay to bounded recovery and absorbs its late target callback", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const idempotencyKey = "00000000-0000-4000-8000-0000000007c9";
    value.codex.endSessionErrorOnce = new Error("hold effect-started switch for quarantine");
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const open = value.store.readSessionSwitchByIdempotencyKey(idempotencyKey);
    if (open?.targetStart === null || open === null) {
      throw new Error("Expected an effect-started switch with exact target evidence.");
    }
    const targetAuthority = liveAuthorityFor(value.store, source.accountId, "claude");
    const targetProviderAuthority = value.store.requireProviderAccountAuthority(
      source.accountId,
      "claude",
    );
    const oversizedAttemptId = `attempt_${"f".repeat(4096)}`;
    const database = new Database(value.store.paths.database, { create: false, strict: true });
    try {
      database.exec(`
        PRAGMA foreign_keys=OFF;
        PRAGMA ignore_check_constraints=ON;
        DROP TRIGGER session_switch_attempt_id_repair_guard;
      `);
      database.query(
        "UPDATE session_switch_attempts SET attempt_id=? WHERE attempt_id=?",
      ).run(oversizedAttemptId, open.attemptId);
      database.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON;");
    } finally {
      database.close(false);
    }
    for (const read of [
      () => value.store.readSessionSwitchByIdempotencyKey(idempotencyKey),
      () => value.store.readSessionSwitchForRecovery(source.sessionId),
    ]) {
      try {
        read();
        throw new Error("Expected malformed switch recovery to fail closed.");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(SessionSwitchStoreError);
        expect((error as Error).message).toBe("SESSION_SWITCH_RECOVERY_CORRUPT");
        expect((error as Error).message).not.toContain(oversizedAttemptId);
      }
    }
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: open.targetStart.providerThreadId,
      providerAuthority: targetProviderAuthority,
    })).toEqual({ blocked: true, attemptId: null, role: "target" });
    const beforeQuarantineCalls = {
      claude: [...value.claude.calls],
      codex: [...value.codex.calls],
    };
    const beforeQuarantineSession = value.store.requireSession(source.sessionId);
    const beforeQuarantineEvents = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events;
    await value.service.observeClaudeFact(targetAuthority, {
      code: "LATE_UNDISPOSED_MALFORMED_SWITCH_TARGET_FACT",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "must remain inert before row-local quarantine",
      providerThreadId: open.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });
    expect(value.store.requireSession(source.sessionId)).toEqual(beforeQuarantineSession);
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events).toEqual(beforeQuarantineEvents);
    expect(value.claude.calls).toEqual(beforeQuarantineCalls.claude);
    expect(value.codex.calls).toEqual(beforeQuarantineCalls.codex);

    expect(value.store.recoverSessionSwitchesPage()).toMatchObject({
      malformedAttemptIds: [expect.stringMatching(/^attempt_[0-9a-f]{32}$/)],
      switches: [],
    });
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: open.targetStart.providerThreadId,
      providerAuthority: targetProviderAuthority,
    })).toEqual({ blocked: true, attemptId: null, role: "target" });

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    const beforeSession = value.store.requireSession(source.sessionId);
    const beforeEvents = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events;
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { reason: "SESSION_SWITCH_RECOVERY_CORRUPT" },
    });
    const loginCalls = value.codex.loginCalls;
    await expect(value.service.execute({
      account: source.accountId,
      deviceCode: false,
      idempotencyKey,
      kind: "account.login",
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { reason: "SESSION_SWITCH_RECOVERY_CORRUPT" },
    });
    expect(value.codex.loginCalls).toBe(loginCalls);
    await value.service.observeClaudeFact(targetAuthority, {
      code: "LATE_MALFORMED_SWITCH_TARGET_FACT",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "must remain inert behind the malformed journal fence",
      providerThreadId: open.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });
    expect(value.store.requireSession(source.sessionId)).toEqual(beforeSession);
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events).toEqual(beforeEvents);
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("repeats idempotent source release when its durable receipt transaction fails", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const complete = value.store.completeSessionSwitchSourceRelease.bind(value.store);
    let rejectReceipt = true;
    Object.defineProperty(value.store, "completeSessionSwitchSourceRelease", {
      configurable: true,
      value: (input: Parameters<StateStore["completeSessionSwitchSourceRelease"]>[0]) => {
        if (rejectReceipt) {
          rejectReceipt = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return complete(input);
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007ac";
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey))
      .toMatchObject({ phase: "source_releasing", sourceRelease: null });
    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      seed: { delivered: true },
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(2);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "seed_settled",
      sourceRelease: { status: "already_released" },
    });
  });

  test("settles a proved seed rejection but never replays an ambiguous seed", async () => {
    const rejected = await fixture();
    const rejectedSession = await codexSession(rejected);
    rejected.claude.startTurnError = new ClaudeError("INVALID_INPUT", "seed rejected");
    const rejectedKey = "00000000-0000-4000-8000-0000000007a3";
    await expect(rejected.service.execute({
      idempotencyKey: rejectedKey,
      kind: "session.switch",
      provider: "claude",
      session: rejectedSession.sessionId,
    }, { signal })).resolves.toMatchObject({
      seed: { delivered: false, failureCode: "SEED_INVALID_INPUT" },
      turnId: null,
    });
    expect(rejected.claude.seededMessages).toEqual([]);

    const ambiguous = await fixture();
    const ambiguousSession = await codexSession(ambiguous);
    const ambiguousTarget = await ambiguous.service.execute(
      { kind: "account.add", label: "Ambiguous target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const ambiguousSourceAuthority = liveAuthorityFor(
      ambiguous.store,
      ambiguousSession.accountId,
      "codex",
    );
    ambiguous.claude.startTurnError = new Error("transport ended after write");
    const ambiguousKey = "00000000-0000-4000-8000-0000000007a4";
    const ambiguousCommand = {
      idempotencyKey: ambiguousKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      account: ambiguousTarget.account.id,
      session: ambiguousSession.sessionId,
    };
    await expect(ambiguous.service.execute(ambiguousCommand, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const calls = [...ambiguous.claude.calls];
    expect(ambiguous.store.readSessionSwitchByIdempotencyKey(ambiguousKey)).toMatchObject({
      phase: "reconciliation_required",
    });
    await expect(ambiguous.service.execute(ambiguousCommand, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(ambiguous.claude.calls).toEqual(calls);
    expect(ambiguous.claude.seededMessages).toHaveLength(1);

    const beforeLateFacts = ambiguous.store.requireSession(ambiguousSession.sessionId);
    const beforeLateEvents = ambiguous.store.listSessionEvents({
      afterSequence: 0,
      sessionId: ambiguousSession.sessionId,
    }).events;
    await ambiguous.service.observeCodexFact(ambiguousSourceAuthority, {
      threadId: "codex-thread-1",
      type: "threadDeleted",
    });
    await ambiguous.service.observeClaudeFact(
      liveAuthorityFor(ambiguous.store, ambiguousTarget.account.id, "claude"),
      {
        connectionId: "30000000-0000-4000-8000-000000000002",
        providerThreadId: "claude-thread-1",
        reason: "eof",
        type: "providerDisconnected",
      },
    );
    const interactionCount = ambiguous.store.listInteractions({
      limit: 10,
      pendingOnly: false,
      sessionId: ambiguousSession.sessionId,
    }).length;
    await ambiguous.service.observeCodexFact(ambiguousSourceAuthority, {
      blocking: true,
      connectionId: "30000000-0000-4000-8000-000000000001",
      display: {
        availableDecisions: ["once", "decline", "cancel"],
        commandClass: "test",
        kind: "command_approval",
        reason: null,
        summary: "Must remain fenced",
        workingDirectory: null,
      },
      kind: "command_approval",
      provider: {
        approvalId: null,
        bindingGeneration: ambiguousSourceAuthority.bindingGeneration,
        connectionId: "30000000-0000-4000-8000-000000000001",
        itemId: "late-switch-item",
        method: "item/commandExecution/requestApproval",
        processGeneration: ambiguousSourceAuthority.generation,
        profileId: ambiguousSourceAuthority.id,
        provider: ambiguousSourceAuthority.provider,
        providerAccountId: ambiguousSourceAuthority.providerAccountId,
        requestDigest: "d".repeat(64),
        requestId: { type: "string", value: "late-switch-request" },
        threadId: "codex-thread-1",
        turnId: "late-switch-turn",
      },
      type: "interactionRequested",
    });
    expect(ambiguous.store.requireSession(ambiguousSession.sessionId)).toEqual(beforeLateFacts);
    expect(ambiguous.store.listSessionEvents({
      afterSequence: 0,
      sessionId: ambiguousSession.sessionId,
    }).events).toEqual(beforeLateEvents);
    expect(ambiguous.store.listInteractions({
      limit: 10,
      pendingOnly: false,
      sessionId: ambiguousSession.sessionId,
    })).toHaveLength(interactionCount);

    const providerCallsBeforeAbandon = {
      claude: [...ambiguous.claude.calls],
      codex: [...ambiguous.codex.calls],
    };
    ambiguous.factsMemory.transferErrorOnce = new Error("abandon transfer unavailable");
    await expect(ambiguous.service.execute({
      kind: "session.abandon",
      session: ambiguousSession.sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(ambiguous.store.readSessionSwitchByIdempotencyKey(ambiguousKey))
      .toMatchObject({ phase: "reconciliation_required" });
    expect(ambiguous.factsMemory.cleanups).toHaveLength(0);
    await expect(ambiguous.service.execute({
      kind: "session.abandon",
      session: ambiguousSession.sessionId,
    }, { signal })).resolves.toMatchObject({
      idempotencyKey: ambiguousKey,
      recovery: {
        providerEffectRetried: false,
        providerStateDeleted: false,
        resolution: "abandoned",
        resolved: true,
      },
      session: { profileId: ambiguousTarget.account.id, state: "terminal" },
    });
    expect(ambiguous.store.readSessionSwitchByIdempotencyKey(ambiguousKey))
      .toMatchObject({ phase: "abandoned" });
    expect(ambiguous.factsMemory.cleanups.at(-1)).toMatchObject({
      ownerId: ambiguousTarget.account.id,
      reason: "abandon",
      sessionId: ambiguousSession.sessionId,
    });
    expect(ambiguous.factsMemory.transfers.at(-1)?.operationKey)
      .toBe(ambiguous.factsMemory.transfers.at(-2)?.operationKey);
    await expect(ambiguous.service.execute(ambiguousCommand, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(ambiguous.claude.calls).toEqual(providerCallsBeforeAbandon.claude);
    expect(ambiguous.codex.calls).toEqual(providerCallsBeforeAbandon.codex);
  });

  test("does not release the source after a target Claude disconnects before receipt admission", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    value.claude.beforeStartSessionReturn = async (input, projection) => {
      await value.service.observeClaudeFact(input.authority, {
        connectionId: "30000000-0000-4000-8000-000000000002",
        providerThreadId: projection.providerThreadId,
        reason: "eof",
        type: "providerDisconnected",
      });
    };
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a5";
    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
      diagnosticCode: "TARGET_DISCONNECTED_BEFORE_RECEIPT_ADMISSION",
    });
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({ provider: "codex" });
  });

  test("does not release the source when the target-start receipt cannot commit", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    Object.defineProperty(value.store, "completeSessionSwitchTargetStart", {
      configurable: true,
      value: () => {
        throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007ad";

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
      targetStart: null,
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.claude.calls).not.toContain("start-turn");
  });

  test("reconciles a target-started switch when source-release intent admission fails", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    Object.defineProperty(value.store, "beginSessionSwitchSourceRelease", {
      configurable: true,
      value: () => {
        throw new SessionSwitchStoreError("SESSION_SWITCH_SESSION_REVISION_STALE");
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007ab";

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      diagnosticCode: "SOURCE_RELEASE_INTENT_SESSION_SWITCH_SESSION_REVISION_STALE",
      phase: "reconciliation_required",
      targetStart: { providerThreadId: "claude-thread-1" },
    });
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
  });

  test("surfaces interactions terminalized by dedicated switch abandonment", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const interactionId = "30000000-0000-4000-8000-0000000007b5";
    value.claude.beforeStartSessionReturn = (input, projection) => {
      value.store.admitInteraction({
        authority: {
          approvalId: null,
          bindingGeneration: input.authority.bindingGeneration,
          connectionId: "30000000-0000-4000-8000-000000000002",
          itemId: "switch-target-item",
          method: "claude/control_request/can_use_tool",
          processGeneration: input.authority.generation,
          profileId: input.authority.id,
          provider: input.authority.provider,
          providerAccountId: input.authority.providerAccountId,
          requestDigest: "e".repeat(64),
          requestId: { type: "string", value: "switch-target-request" },
          threadId: projection.providerThreadId,
          turnId: "switch-target-turn",
        },
        blocking: true,
        display: {
          availableDecisions: ["once", "decline"],
          commandClass: "test",
          kind: "command_approval",
          reason: null,
          summary: "Target interaction before receipt",
          workingDirectory: null,
        },
        kind: "command_approval",
        publicId: interactionId,
        sessionId: null,
      });
    };
    const idempotencyKey = "00000000-0000-4000-8000-0000000007b5";

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
    });
    expect(value.store.listInteractions({ limit: 200, pendingOnly: true })
      .find((interaction) => interaction.publicId === interactionId))
      .toMatchObject({ state: "pending" });

    await expect(value.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      recovery: { resolution: "abandoned", resolved: true },
    });
    expect(value.store.listInteractions({ limit: 200 })
      .find((interaction) => interaction.publicId === interactionId))
      .toMatchObject({ state: "expired" });
  });

  test("reconciles after release when exact rebind cannot commit", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    Object.defineProperty(value.store, "rebindSessionSwitch", {
      configurable: true,
      value: () => {
        throw new SessionSwitchStoreError("SESSION_SWITCH_SESSION_REVISION_STALE");
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007ae";

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
      rebind: null,
      sourceRelease: { status: "released" },
    });
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(value.claude.calls).not.toContain("start-turn");
  });

  test("never replays an accepted seed whose durable receipt cannot commit", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    Object.defineProperty(value.store, "completeSessionSwitchSeed", {
      configurable: true,
      value: () => {
        throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007af";
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const calls = [...value.claude.calls];
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
      seed: null,
      seedAuthority: { provenance: "rebound" },
    });
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls);
  });

  test("moves a session between accounts on the same provider", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Second Codex account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    value.codex.projection = {
      providerThreadId: "codex-thread-2",
      providerUpdatedAt: 40,
      status: "idle",
      title: "Moved session",
    };

    await expect(value.service.execute({
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007a6",
      kind: "session.switch",
      preset: "high",
      provider: "codex",
      session: source.sessionId,
    }, { signal })).resolves.toMatchObject({
      from: { account: source.accountId, provider: "codex" },
      to: { account: target.account.id, provider: "codex" },
    });
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      profileId: target.account.id,
      provider: "codex",
      providerThreadId: "codex-thread-2",
    });
    expect(value.factsMemory.transfers).toHaveLength(1);
    expect(value.factsMemory.transfers[0]).toMatchObject({
      fromOwnerId: source.accountId,
      sessionId: source.sessionId,
      toOwnerId: target.account.id,
    });
    expect(value.factsMemory.transfers[0]?.operationKey).toMatch(
      /^session-switch-owner:[a-f0-9]{64}$/u,
    );
    expect(new TextEncoder().encode(
      value.factsMemory.transfers[0]?.operationKey ?? "",
    ).byteLength).toBeLessThanOrEqual(200);
    expect(value.factsMemory.owners.get(source.sessionId)).toBe(target.account.id);
  });

  test("retries exact facts-memory custody before rebind without repeating provider effects", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Custody target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    value.codex.projection = {
      providerThreadId: "codex-custody-target",
      providerUpdatedAt: 41,
      status: "idle",
      title: "Custody target",
    };
    value.factsMemory.transferErrorOnce = new Error("lost transfer response");
    const command = {
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007a7",
      kind: "session.switch" as const,
      preset: "high" as const,
      provider: "codex" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey)).toMatchObject({
      phase: "source_released",
    });
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      profileId: source.accountId,
      providerThreadId: "codex-thread-1",
    });
    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(2);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);

    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      to: { account: target.account.id, provider: "codex" },
    });
    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(2);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);
    expect(value.factsMemory.transfers).toHaveLength(2);
    expect(value.factsMemory.transfers[1]?.operationKey)
      .toBe(value.factsMemory.transfers[0]?.operationKey);
    expect(value.factsMemory.owners.get(source.sessionId)).toBe(target.account.id);
  });

  test("cancels a prepared switch before applying a source fact without an in-memory owner", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const beginTarget = value.store.beginSessionSwitchTargetStart.bind(value.store);
    let rejectTargetIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchTargetStart", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchTargetStart"]>[0]) => {
        if (rejectTargetIntent) {
          rejectTargetIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginTarget(input);
      },
    });
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b8",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toBeDefined();
    const prepared = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(prepared).toMatchObject({ phase: "prepared" });
    if (prepared === null) throw new Error("Expected prepared switch.");
    const sourceAuthority = liveAuthorityFor(value.store, source.accountId, "codex");
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: "codex-thread-1",
      providerAuthority: {
        providerAccountId: sourceAuthority.providerAccountId,
        profileId: sourceAuthority.id,
        provider: sourceAuthority.provider,
        bindingGeneration: sourceAuthority.bindingGeneration,
        processGeneration: sourceAuthority.generation,
      },
    })).toMatchObject({ attemptId: prepared.attemptId, blocked: true, role: "source" });
    await value.service.observeCodexFact(
      sourceAuthority,
      {
        code: "PREPARED_SOURCE_CALLBACK",
        message: "source callback between exact retries",
        threadId: "codex-thread-1",
        type: "providerWarning",
      },
    );

    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "cancelled" });
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events.some((event) => event.body.type === "warning"
      && event.body.code === "PREPARED_SOURCE_CALLBACK")).toBe(true);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(0);

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("proves no target effect when a prepared replay receives a source fact at the inner fence", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const beginTarget = value.store.beginSessionSwitchTargetStart.bind(value.store);
    let rejectTargetIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchTargetStart", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchTargetStart"]>[0]) => {
        if (rejectTargetIntent) {
          rejectTargetIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginTarget(input);
      },
    });
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b9",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toBeDefined();
    const sourceAuthority = liveAuthorityFor(value.store, source.accountId, "codex");
    let reviewPostFenceArmedTargetFence = false;
    let targetPreFenceDeliveredSourceFact = false;
    value.claude.beforeReviewSessionReturn = () => {
      value.daemonAuthority.beforeAssertReturn = () => {
        reviewPostFenceArmedTargetFence = true;
        value.daemonAuthority.beforeAssertReturn = async () => {
          targetPreFenceDeliveredSourceFact = true;
          await value.service.observeCodexFact(sourceAuthority, {
            code: "TARGET_FENCE_SOURCE_CALLBACK",
            message: "source callback at target pre-effect fence",
            threadId: "codex-thread-1",
            type: "providerWarning",
          });
        };
      };
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(reviewPostFenceArmedTargetFence).toBe(true);
    expect(targetPreFenceDeliveredSourceFact).toBe(true);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "SOURCE_FACT_BEFORE_TARGET_EFFECT",
        phase: "failed",
      });
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events.some((event) => event.body.type === "warning"
      && event.body.code === "TARGET_FENCE_SOURCE_CALLBACK")).toBe(true);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(0);
  });

  test("releases target custody when a post-start source read throws", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007bf",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };
    const beginSourceRelease = value.store.beginSessionSwitchSourceRelease.bind(value.store);
    let sourceReleaseIntentCommitted = false;
    Object.defineProperty(value.store, "beginSessionSwitchSourceRelease", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchSourceRelease"]>[0]) => {
        const record = beginSourceRelease(input);
        sourceReleaseIntentCommitted = true;
        return record;
      },
    });
    const requireSession = value.store.requireSession.bind(value.store);
    let rejectPostTargetRead = true;
    Object.defineProperty(value.store, "requireSession", {
      configurable: true,
      value: (selector: Parameters<StateStore["requireSession"]>[0]) => {
        if (sourceReleaseIntentCommitted && rejectPostTargetRead) {
          rejectPostTargetRead = false;
          throw new Error("forced post-target source session read failure");
        }
        return requireSession(selector);
      },
    });

    await expect(value.service.execute(command, { signal }))
      .rejects.toThrow("forced post-target source session read failure");
    const sourceReleasing = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(sourceReleasing).toMatchObject({ phase: "source_releasing" });
    if (sourceReleasing?.targetStart === null || sourceReleasing === null) {
      throw new Error("Expected a source-releasing switch with a target receipt.");
    }
    const targetAuthority = liveAuthorityFor(value.store, source.accountId, "claude");
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };

    await value.service.observeClaudeFact(targetAuthority, {
      code: "TARGET_CALLBACK_AFTER_POST_START_READ_FAILURE",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "target callback after the failed post-start source read",
      providerThreadId: sourceReleasing.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });

    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "FACT_WITHOUT_IN_MEMORY_CUSTODY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("resumes source-released custody after the retry sweep expires its source", async () => {
    const now = Date.now();
    const value = await fixture(() => now);
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Expired custody target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    value.codex.projection = {
      providerThreadId: "codex-expired-custody-target",
      providerUpdatedAt: 42,
      status: "idle",
      title: "Expired custody target",
    };
    if (!value.factsMemory.expiries.has(source.sessionId)) {
      throw new Error("Expected source facts-memory expiry.");
    }
    value.factsMemory.transferErrorOnce = new Error("lost expired-source transfer response");
    const command = {
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007b6",
      kind: "session.switch" as const,
      preset: "high" as const,
      provider: "codex" as const,
      session: source.sessionId,
    };

    const firstFailure = await value.service.execute(command, { signal })
      .catch((error: unknown) => error);
    expect(firstFailure).toMatchObject({ code: "RECOVERY_REQUIRED" });
    const openSwitch = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    if (openSwitch === null) throw firstFailure;
    expect(openSwitch).toMatchObject({ phase: "source_released" });
    expect(value.factsMemory.transferSourceStates).toEqual(["active"]);
    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(2);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);

    value.factsMemory.simulateExpiry = true;
    value.factsMemory.expiries.set(source.sessionId, now);
    const settled = await value.service.execute(command, { signal });
    expect(settled).toMatchObject({
      to: { account: target.account.id, provider: "codex" },
    });
    expect(value.factsMemory.transferSourceStates).toEqual(["active", "purged"]);
    expect(value.factsMemory.transfers[1]?.operationKey)
      .toBe(value.factsMemory.transfers[0]?.operationKey);
    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(2);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    expect(value.factsMemory.owners.get(source.sessionId)).toBe(target.account.id);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "seed_settled" });

    const calls = [...value.codex.calls];
    await expect(value.service.execute(command, { signal })).resolves.toEqual(settled);
    expect(value.factsMemory.transfers).toHaveLength(2);
    expect(value.codex.calls).toEqual(calls);
  });

  test("reconciles before seed when a target error arrives during rebound custody replay", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Rebound custody target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const beginSeed = value.store.beginSessionSwitchSeedDispatch.bind(value.store);
    let rejectSeedIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchSeedDispatch", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchSeedDispatch"]>[0]) => {
        if (rejectSeedIntent) {
          rejectSeedIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginSeed(input);
      },
    });
    const command = {
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007b2",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const rebound = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(rebound).toMatchObject({ phase: "rebound", sourceRelease: { status: "released" } });
    if (rebound?.targetStart === null || rebound === null) {
      throw new Error("Expected a rebound switch with a target receipt.");
    }
    const firstOperationKey = value.factsMemory.transfers.at(-1)?.operationKey;
    value.factsMemory.owners.set(source.sessionId, source.accountId);
    const targetAuthority = capturedAuthorityForSession(value.store, source.sessionId);
    const targetProviderAuthority = {
      providerAccountId: targetAuthority.providerAccountId,
      profileId: targetAuthority.id,
      provider: targetAuthority.provider,
      bindingGeneration: targetAuthority.bindingGeneration,
      processGeneration: targetAuthority.generation,
    };
    expect(targetProviderAuthority).toEqual(rebound.targetAuthority);
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: rebound.targetStart.providerThreadId,
      providerAuthority: targetProviderAuthority,
    })).toMatchObject({ attemptId: rebound.attemptId, blocked: true, role: "target" });
    let custodyCallbackDelivered = false;
    value.factsMemory.beforeTransferReturn = async () => {
      custodyCallbackDelivered = true;
      await value.service.observeClaudeFact(targetAuthority, {
        code: "CUSTODY_REPLAY_CALLBACK",
        connectionId: "30000000-0000-4000-8000-000000000002",
        message: "callback delivered while facts-memory custody was replaying",
        providerThreadId: rebound.targetStart?.providerThreadId ?? "missing-target-thread",
        terminal: true,
        turnId: null,
        type: "providerError",
      });
    };
    const targetStarts = value.claude.calls.filter((call) => call === "start-session").length;
    const sourceReleases = value.codex.calls.filter((call) => call === "end-session").length;

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.factsMemory.transfers.at(-1)?.operationKey).toBe(firstOperationKey);
    expect(value.factsMemory.owners.get(source.sessionId)).toBe(target.account.id);
    expect(custodyCallbackDelivered).toBe(true);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "TARGET_FACT_DURING_CUSTODY_REPLAY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls.filter((call) => call === "start-session"))
      .toHaveLength(targetStarts);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.codex.calls.filter((call) => call === "end-session"))
      .toHaveLength(sourceReleases);
  });

  test("reconciles an exact target fact delivered between rebound retries", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const beginSeed = value.store.beginSessionSwitchSeedDispatch.bind(value.store);
    let rejectSeedIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchSeedDispatch", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchSeedDispatch"]>[0]) => {
        if (rejectSeedIntent) {
          rejectSeedIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginSeed(input);
      },
    });
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007be",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toBeDefined();
    const rebound = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(rebound).toMatchObject({ phase: "rebound" });
    if (rebound?.targetStart === null || rebound === null) {
      throw new Error("Expected a rebound switch with a target receipt.");
    }
    const targetAuthority = capturedAuthorityForSession(value.store, source.sessionId);
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };

    await value.service.observeClaudeFact(targetAuthority, {
      code: "TARGET_FAILED_BETWEEN_RETRIES",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "exact target callback while no replay owner was live",
      providerThreadId: rebound.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });

    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "FACT_WITHOUT_IN_MEMORY_CUSTODY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("releases rebound custody when captured seed authority cannot be read", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007c0",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };
    const requireCaptured = value.store.requireCapturedSessionProviderAuthority.bind(value.store);
    const rebind = value.store.rebindSessionSwitch.bind(value.store);
    let rebindCommitted = false;
    Object.defineProperty(value.store, "rebindSessionSwitch", {
      configurable: true,
      value: (input: Parameters<StateStore["rebindSessionSwitch"]>[0]) => {
        const result = rebind(input);
        rebindCommitted = true;
        return result;
      },
    });
    let rejectReboundAuthorityRead = true;
    Object.defineProperty(value.store, "requireCapturedSessionProviderAuthority", {
      configurable: true,
      value: (
        sessionId: Parameters<StateStore["requireCapturedSessionProviderAuthority"]>[0],
      ) => {
        if (rejectReboundAuthorityRead && rebindCommitted && sessionId === source.sessionId) {
          rejectReboundAuthorityRead = false;
          throw new Error("forced captured seed authority read failure");
        }
        return requireCaptured(sessionId);
      },
    });

    await expect(value.service.execute(command, { signal }))
      .rejects.toThrow("forced captured seed authority read failure");
    expect(rebindCommitted).toBe(true);
    const rebound = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(rebound).toMatchObject({ phase: "rebound" });
    if (rebound?.targetStart === null || rebound === null) {
      throw new Error("Expected a rebound switch with a target receipt.");
    }
    const targetAuthority = capturedAuthorityForSession(value.store, source.sessionId);
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };

    await value.service.observeClaudeFact(targetAuthority, {
      code: "TARGET_CALLBACK_AFTER_SEED_AUTHORITY_READ_FAILURE",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "target callback after the failed seed authority read",
      providerThreadId: rebound.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });

    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "FACT_WITHOUT_IN_MEMORY_CUSTODY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("reconciles before seed when target facts overflow during rebound custody replay", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Rebound overflow target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const beginSeed = value.store.beginSessionSwitchSeedDispatch.bind(value.store);
    let rejectSeedIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchSeedDispatch", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchSeedDispatch"]>[0]) => {
        if (rejectSeedIntent) {
          rejectSeedIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginSeed(input);
      },
    });
    const command = {
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007b7",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toBeDefined();
    const rebound = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(rebound).toMatchObject({ phase: "rebound" });
    if (rebound?.targetStart === null || rebound === null) {
      throw new Error("Expected a rebound switch with a target receipt.");
    }
    value.factsMemory.owners.set(source.sessionId, source.accountId);
    const targetAuthority = capturedAuthorityForSession(value.store, source.sessionId);
    const targetProviderAuthority = {
      providerAccountId: targetAuthority.providerAccountId,
      profileId: targetAuthority.id,
      provider: targetAuthority.provider,
      bindingGeneration: targetAuthority.bindingGeneration,
      processGeneration: targetAuthority.generation,
    };
    expect(targetProviderAuthority).toEqual(rebound.targetAuthority);
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: rebound.targetStart.providerThreadId,
      providerAuthority: targetProviderAuthority,
    })).toMatchObject({ attemptId: rebound.attemptId, blocked: true, role: "target" });
    let callbackCount = 0;
    value.factsMemory.beforeTransferReturn = async () => {
      for (let index = 0; index <= 256; index += 1) {
        callbackCount += 1;
        await value.service.observeClaudeFact(targetAuthority, {
          code: `CUSTODY_OVERFLOW_${String(index)}`,
          connectionId: "30000000-0000-4000-8000-000000000002",
          message: "bounded custody replay callback",
          providerThreadId: rebound.targetStart?.providerThreadId ?? "missing-target-thread",
          terminal: false,
          turnId: null,
          type: "providerError",
        });
      }
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(callbackCount).toBe(257);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "TARGET_FACT_OVERFLOW_DURING_CUSTODY_REPLAY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
  });

  test("abandons source-released recovery only after exact target custody cleanup", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Abandon custody target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    value.codex.projection = {
      providerThreadId: "codex-abandon-custody-target",
      providerUpdatedAt: 43,
      status: "idle",
      title: "Abandon custody target",
    };
    value.factsMemory.transferErrorOnce = new Error("transfer unavailable");
    const idempotencyKey = "00000000-0000-4000-8000-0000000007aa";
    await expect(value.service.execute({
      account: target.account.id,
      idempotencyKey,
      kind: "session.switch",
      preset: "high",
      provider: "codex",
      session: source.sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "source_released",
      rebind: null,
      sourceRelease: { status: "released" },
    });
    const callsBeforeAbandon = [...value.codex.calls];

    await expect(value.service.execute({
      kind: "session.abandon",
      session: source.sessionId,
    }, { signal })).resolves.toMatchObject({
      idempotencyKey,
      recovery: {
        providerEffectRetried: false,
        providerStateDeleted: false,
        resolution: "abandoned",
      },
      session: { profileId: source.accountId, state: "terminal" },
    });
    expect(value.codex.calls).toEqual(callsBeforeAbandon);
    expect(value.factsMemory.transfers).toHaveLength(2);
    expect(value.factsMemory.transfers[1]?.operationKey)
      .toBe(value.factsMemory.transfers[0]?.operationKey);
    expect(value.factsMemory.cleanups.at(-1)).toMatchObject({
      ownerId: target.account.id,
      reason: "abandon",
      sessionId: source.sessionId,
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey))
      .toMatchObject({ phase: "abandoned" });
  });

  test("contains a target thread collision before releasing the source", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Collision target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    value.claude.projection = {
      providerThreadId: "claude-collision-thread",
      providerUpdatedAt: 42,
      status: "idle",
      title: "Existing target",
    };
    const collision = await value.service.execute({
      account: target.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a8";

    await expect(value.service.execute({
      account: target.account.id,
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: source.sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      diagnosticCode: "TARGET_THREAD_ALREADY_BOUND",
      phase: "reconciliation_required",
      targetStart: { providerThreadId: "claude-collision-thread" },
    });
    expect(value.store.requireSession(collision.session.id).providerThreadId)
      .toBe("claude-collision-thread");
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      profileId: source.accountId,
      provider: "codex",
      providerThreadId: "codex-thread-1",
    });
    expect(value.codex.endedThreads).toEqual([]);

    const callsBeforeAbandon = {
      claude: [...value.claude.calls],
      codex: [...value.codex.calls],
    };
    await expect(value.service.execute({
      kind: "session.abandon",
      session: source.sessionId,
    }, { signal })).resolves.toMatchObject({
      recovery: { resolution: "abandoned" },
      session: { state: "terminal" },
    });
    expect(value.factsMemory.cleanups.at(-1)).toMatchObject({
      ownerId: source.accountId,
      reason: "abandon",
      sessionId: source.sessionId,
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey))
      .toMatchObject({ phase: "abandoned" });
    expect(value.store.requireSession(collision.session.id)).toMatchObject({
      profileId: target.account.id,
      providerThreadId: "claude-collision-thread",
      state: "idle",
    });
    expect(value.claude.calls).toEqual(callsBeforeAbandon.claude);
    expect(value.codex.calls).toEqual(callsBeforeAbandon.codex);
  });

  test("contains a same-session target thread collision before releasing the source", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a9";

    await expect(value.service.execute({
      account: source.accountId,
      idempotencyKey,
      kind: "session.switch",
      preset: "ultra",
      provider: "codex",
      session: source.sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      diagnosticCode: "TARGET_THREAD_ALREADY_BOUND",
      phase: "reconciliation_required",
      targetStart: { providerThreadId: "codex-thread-1" },
    });
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      preset: "high",
      provider: "codex",
      providerThreadId: "codex-thread-1",
    });
    expect(value.codex.endedThreads).toEqual([]);
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

  test("replays a committed provider switch after response loss without repeating provider effects", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "preserve this", session: sessionId },
      { signal },
    );
    const idempotencyKey = crypto.randomUUID();
    const complete = value.store.completeSessionSwitchSeed.bind(value.store);
    Object.defineProperty(value.store, "completeSessionSwitchSeed", {
      configurable: true,
      value: (input: Parameters<StateStore["completeSessionSwitchSeed"]>[0]) => {
        complete(input);
        throw new Error("simulated response loss after durable commit");
      },
    });

    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };
    await expect(value.service.execute(command, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    const callsAfterCommit = {
      sourceEnds: value.codex.endedThreads.length,
      targetStarts: value.claude.calls.filter((call) => call === "start-session").length,
      seedStarts: value.claude.calls.filter((call) => call === "start-turn").length,
    };

    const replayed = await value.service.execute(command, { signal }) as {
      idempotencyKey: string;
      seed: { delivered: boolean };
      session: { id: string };
    };
    expect(replayed).toMatchObject({
      idempotencyKey,
      seed: { delivered: true },
      session: { id: sessionId },
    });
    expect({
      sourceEnds: value.codex.endedThreads.length,
      targetStarts: value.claude.calls.filter((call) => call === "start-session").length,
      seedStarts: value.claude.calls.filter((call) => call === "start-turn").length,
    }).toEqual(callsAfterCommit);
    const transcript = await transcriptOf(value, sessionId);
    expect(transcript.records.filter((record) => record.kind === "provider_switch")).toHaveLength(1);
    expect(transcript.records.filter(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    )).toHaveLength(1);
  });

  test("replays the durable destination snapshot after a later reverse switch", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const firstKey = crypto.randomUUID();
    const firstCommand = {
      idempotencyKey: firstKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };
    const first = await value.service.execute(firstCommand, { signal }) as {
      session: { provider: string; providerThreadId: string; revision: number };
    };
    expect(first.session).toMatchObject({
      provider: "claude",
      providerThreadId: "claude-thread-1",
    });

    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "codex",
      session: sessionId,
    }, { signal });
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
    const effectsAfterReverse = {
      codexEnds: value.codex.endedThreads.length,
      codexStarts: value.codex.calls.filter((call) => call === "start-session").length,
      codexTurns: value.codex.calls.filter((call) => call === "start-turn").length,
      claudeEnds: value.claude.endedThreads.length,
      claudeStarts: value.claude.calls.filter((call) => call === "start-session").length,
      claudeTurns: value.claude.calls.filter((call) => call === "start-turn").length,
    };
    const transcriptAfterReverse = await transcriptOf(value, sessionId);

    const replayed = await value.service.execute(firstCommand, { signal }) as {
      session: { provider: string; providerThreadId: string; revision: number };
    };
    expect(replayed.session).toMatchObject({
      provider: "claude",
      providerThreadId: "claude-thread-1",
      revision: first.session.revision,
    });
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
    expect({
      codexEnds: value.codex.endedThreads.length,
      codexStarts: value.codex.calls.filter((call) => call === "start-session").length,
      codexTurns: value.codex.calls.filter((call) => call === "start-turn").length,
      claudeEnds: value.claude.endedThreads.length,
      claudeStarts: value.claude.calls.filter((call) => call === "start-session").length,
      claudeTurns: value.claude.calls.filter((call) => call === "start-turn").length,
    }).toEqual(effectsAfterReverse);
    const transcriptAfterReplay = await transcriptOf(value, sessionId);
    expect(transcriptAfterReplay.records).toEqual(transcriptAfterReverse.records);
    expect(transcriptAfterReplay.records.filter((record) => record.kind === "provider_switch"))
      .toHaveLength(2);
    expect(transcriptAfterReplay.records.filter(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    )).toHaveLength(2);
  });

  test("legacy journal: keeps a durably seeded target when source release does not settle", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await recordHistoricalSwitchProgress(value, {
      idempotencyKey, provider: "claude", session: sessionId, stage: "seed_settled",
    });

    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
      kind: "session.switch",
      state: "ambiguous",
    });
    expect(value.store.readSessionProviderSwitchProgress(
      value.store.readMutation(idempotencyKey)!.id,
    )).toMatchObject({
      seedTurnId: "claude-turn-1",
      sourceReleased: false,
      targetProviderThreadId: "claude-thread-1",
      targetReleased: false,
    });
    expect(value.claude.seededMessages).toHaveLength(0);
    expect(value.claude.endedThreads).toEqual([]);
  });

  test("legacy journal: does not replay or inspect an unseeded Claude target after daemon restart", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart === null) throw new Error("Expected an unsettled provider switch.");
    const progressBeforeRestart = value.store.readSessionProviderSwitchProgress(
      attemptBeforeRestart.id,
    );
    expect(progressBeforeRestart.seed).toBeUndefined();
    expect(progressBeforeRestart).toMatchObject({
      sourceReleased: false,
      targetProviderThreadId: "claude-thread-1",
      targetReleased: false,
    });

    const restarted = await reopenFixture(value);
    expectCurrentSwitchSuccessors(restarted, idempotencyKey);
    expect(restarted.store.requireSession(sessionId).state).toBe("recovery_required");
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);

    await expect(restarted.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("Claude sessions are process-local"),
    });
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);

    expect(await restarted.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerEffectRetried: false,
        providerStateDeleted: false,
        providerStateUnknown: true,
        resolution: "abandoned",
        sourceReleased: false,
        sourceObserved: true,
        sourceStateUnknown: false,
        targetAddressable: true,
        targetReleased: false,
        targetStateUnknown: true,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).toEqual(["read"]);
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      originalState: "ambiguous",
      resolution: {
        evidence: {
          providerStateDeleted: false,
          providerStateUnknown: true,
          source: "claude_process_local_restart_boundary",
        },
        kind: "abandoned",
      },
      state: "reconciled",
    });
  });

  test("legacy journal: does not claim a seeded Claude target applied after daemon restart", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveFinalSwitchCommitUnsettled(value, {
      idempotencyKey,
      provider: "claude",
      session: sessionId,
    });
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart === null) throw new Error("Expected an unsettled provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attemptBeforeRestart.id)).toMatchObject({
      seedTurnId: "claude-turn-1",
      sourceReleased: true,
      targetProviderThreadId: "claude-thread-1",
      targetReleased: false,
    });

    const restarted = await reopenFixture(value);
    expectCurrentSwitchSuccessors(restarted, idempotencyKey);
    expect(restarted.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      providerThreadId: "claude-thread-1",
      state: "recovery_required",
    });
    await expect(restarted.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("No provider effect was replayed"),
    });
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);

    expect(await restarted.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        providerStateUnknown: true,
        sourceReleased: true,
        sourceStateUnknown: false,
        targetReleased: false,
        targetStateUnknown: true,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: { kind: "abandoned" },
      state: "reconciled",
    });
  });

  test("legacy journal: cleans a Codex target but keeps Claude source state unknown after restart", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Codex target");
    const idempotencyKey = crypto.randomUUID();
    await recordHistoricalSwitchProgress(value, {
      account: targetAccountId, idempotencyKey, provider: "codex",
      session: sessionId, stage: "seed_settled",
    });
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart === null) throw new Error("Expected an unsettled provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attemptBeforeRestart.id)).toMatchObject({
      seedTurnId: "codex-turn-1",
      sourceReleased: false,
      targetProviderThreadId: "codex-thread-1",
      targetReleased: false,
    });

    const restarted = await reopenFixture(value);
    expectCurrentSwitchSuccessors(restarted, idempotencyKey);
    await expect(restarted.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("Claude sessions are process-local"),
    });
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);

    expect(await restarted.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        providerStateUnknown: true,
        sourceReleased: false,
        sourceStateUnknown: true,
        targetReleased: true,
        targetStateUnknown: false,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).toEqual(["end-session"]);
    expect(restarted.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: { kind: "abandoned" },
      state: "reconciled",
    });
  });

  test("legacy journal: recovers a seeded Codex target when the Claude source release receipt survived restart", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Recoverable Codex target");
    const idempotencyKey = crypto.randomUUID();
    await leaveFinalSwitchCommitUnsettled(value, {
      account: targetAccountId,
      idempotencyKey,
      provider: "codex",
      session: sessionId,
    });
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart === null) throw new Error("Expected an unsettled provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attemptBeforeRestart.id)).toMatchObject({
      seedTurnId: "codex-turn-1",
      sourceReleased: true,
      targetProviderThreadId: "codex-thread-1",
      targetReleased: false,
    });

    const restarted = await reopenFixture(value);
    expectCurrentSwitchSuccessors(restarted, idempotencyKey);
    expect(await restarted.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerEffectRetried: false,
        resolution: "proven_applied",
      },
      session: {
        profileId: targetAccountId,
        provider: "codex",
        providerThreadId: "codex-thread-1",
        state: "idle",
      },
    });
    expect(restarted.codex.calls).toEqual(["read"]);
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: { kind: "proven_applied" },
      state: "reconciled",
    });
    const transcript = await transcriptOf(restarted, sessionId);
    expect(transcript.records.filter((record) => record.kind === "provider_switch"))
      .toHaveLength(1);
    expect(transcript.records.filter(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    )).toHaveLength(1);
  });

  test("legacy journal: does not accept one visible seed match from an incomplete recovery projection", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await recordHistoricalSwitchProgress(value, {
      idempotencyKey, provider: "claude", session: sessionId, stage: "seed_intended",
    });
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    value.claude.projection = {
      ...value.claude.projection,
      messages: [{
        clientId: attempt.id,
        role: "user",
        text: "provider handoff",
        turnId: "claude-turn-1",
      }],
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 1,
        turnLimit: 20,
        unreadItemTurnIds: [],
      },
      turnSummaries: [{
        actions: [],
        files: [],
        id: "claude-turn-1",
        omittedActions: 0,
        omittedFiles: 0,
        status: "completed",
      }],
    };

    await expect(value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("cannot prove that the seed match is unique"),
    });
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).seedTurnId).toBeUndefined();
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.claude.endedThreads).toEqual([]);

    value.claude.projection = {
      ...value.claude.projection,
      messages: [],
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 0,
        truncatedMessages: 0,
        turnLimit: 20,
        unreadItemTurnIds: [],
      },
      turnSummaries: [],
    };
    expect(await value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        resolution: "abandoned",
      },
      session: {
        provider: "codex",
        providerThreadId: "codex-thread-1",
        state: "idle",
      },
    });
    expect(value.claude.endedThreads).toEqual(["claude-thread-1"]);
    expect(value.codex.endedThreads).toEqual([]);
  });

  test("legacy journal: reports retained source state after cleaning an unseeded target", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);

    expect(await value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        resolution: "abandoned",
      },
      session: {
        provider: "codex",
        providerThreadId: "codex-thread-1",
        state: "idle",
      },
    });
    expect(value.claude.endedThreads).toEqual(["claude-thread-1"]);
    expect(value.codex.endedThreads).toEqual([]);
  });

  test("legacy journal: does not resolve abandonment after losing daemon authority during target cleanup", async () => {
    let stale = false;
    const value = await fixture({
      assertCurrent: async () => {
        if (stale) throw new DaemonAuthoritySafetyError("simulated stale daemon authority");
      },
      close: () => {},
    });
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const endTarget = value.claude.endSession.bind(value.claude);
    Object.defineProperty(value.claude, "endSession", {
      configurable: true,
      value: async (input: Parameters<ClaudeRuntimePort["endSession"]>[0]) => {
        await endTarget(input);
        stale = true;
      },
    });
    try {
      await expect(value.service.execute({
        kind: "session.abandon",
        session: sessionId,
      }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    } finally {
      stale = false;
      Object.defineProperty(value.claude, "endSession", {
        configurable: true,
        value: endTarget,
      });
    }

    expect(value.store.requireSession(sessionId).state).toBe("recovery_required");
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).targetReleased).toBe(false);
  });

  test("legacy journal: does not resolve abandonment after losing daemon authority during source read", async () => {
    let stale = false;
    const value = await fixture({
      assertCurrent: async () => {
        if (stale) throw new DaemonAuthoritySafetyError("simulated stale daemon authority");
      },
      close: () => {},
    });
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const readSource = value.codex.readSession.bind(value.codex);
    Object.defineProperty(value.codex, "readSession", {
      configurable: true,
      value: async () => {
        const projection = await readSource();
        stale = true;
        return projection;
      },
    });
    try {
      await expect(value.service.execute({
        kind: "session.abandon",
        session: sessionId,
      }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    } finally {
      stale = false;
      Object.defineProperty(value.codex, "readSession", {
        configurable: true,
        value: readSource,
      });
    }

    expect(value.store.requireSession(sessionId).state).toBe("recovery_required");
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).targetReleased).toBe(true);
  });

  test("serializes a local cross-account switch before target Claude login admission", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Local target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    let entered!: () => void;
    let release!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const holdRead = new Promise<void>((resolve) => { release = resolve; });
    value.claude.accountSignedInResults.push(true, false);
    value.claude.beforeReadAccountReturn = async () => {
      entered();
      await holdRead;
    };

    const switching = value.service.execute({
      account: target.account.id,
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal });
    await enteredRead;
    const loginKey = crypto.randomUUID();
    let loginSettled = false;
    const login = value.service.execute({
      account: target.account.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal }).then(
      (result) => ({ result, status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    ).finally(() => { loginSettled = true; });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(loginSettled).toBe(false);

    release();
    await expect(switching).resolves.toMatchObject({
      session: { id: sessionId, profileId: target.account.id, provider: "claude" },
    });
    const loginOutcome = await login;
    expect(loginOutcome).toMatchObject({
      result: {
        authentication: { provider: "claude", signedIn: false },
        login: { status: "launch_granted" },
      },
      status: "fulfilled",
    });
    expect(value.store.readMutation(loginKey)).toMatchObject({ state: "effect_started" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: target.account.id,
      provider: "claude",
      state: "terminal",
    });
    expect(value.claude.endedThreads).toEqual(["claude-thread-1"]);
  });

  test("serializes a remote cross-account switch before target Claude login admission", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Remote target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(accountId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    let entered!: () => void;
    let release!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const holdRead = new Promise<void>((resolve) => { release = resolve; });
    value.claude.accountSignedInResults.push(true, false);
    value.claude.beforeReadAccountReturn = async () => {
      entered();
      await holdRead;
    };

    const switching = value.service.executeRemote({
      account: target.account.id,
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, {
      ...value.store.requireProviderAccountAuthority(profile.id, "codex"),
      providerThreadId: session.providerThreadId,
      sessionId,
    }, { signal });
    await enteredRead;
    const loginKey = crypto.randomUUID();
    let loginSettled = false;
    const login = value.service.execute({
      account: target.account.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal }).then(
      (result) => ({ result, status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    ).finally(() => { loginSettled = true; });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(loginSettled).toBe(false);

    release();
    await expect(switching).resolves.toMatchObject({
      session: { id: sessionId, profileId: target.account.id, provider: "claude" },
    });
    expect(await login).toMatchObject({
      result: {
        authentication: { provider: "claude", signedIn: false },
        login: { status: "launch_granted" },
      },
      status: "fulfilled",
    });
    expect(value.store.readMutation(loginKey)).toMatchObject({ state: "effect_started" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: target.account.id,
      provider: "claude",
      state: "terminal",
    });
    expect(value.claude.endedThreads).toEqual(["claude-thread-1"]);
  });

  test("replays a remote provider switch after its original authority changed", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const sourceSession = value.store.requireSession(sessionId);
    const sourceProfile = value.store.requireProfileById(accountId);
    if (sourceSession.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const idempotencyKey = crypto.randomUUID();
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };
    const expectedAuthority = {
      ...value.store.requireProviderAccountAuthority(sourceProfile.id, "codex"),
      providerThreadId: sourceSession.providerThreadId,
      sessionId,
    };
    await expect(value.service.executeRemote(command, expectedAuthority, { signal }))
      .resolves.toMatchObject({ session: { id: sessionId, provider: "claude" } });
    const callsAfterCommit = {
      sourceEnds: value.codex.endedThreads.length,
      targetStarts: value.claude.calls.filter((call) => call === "start-session").length,
      seedStarts: value.claude.calls.filter((call) => call === "start-turn").length,
    };
    await expect(value.service.executeRemote(command, expectedAuthority, { signal }))
      .resolves.toMatchObject({ idempotencyKey, session: { id: sessionId, provider: "claude" } });
    expect({
      sourceEnds: value.codex.endedThreads.length,
      targetStarts: value.claude.calls.filter((call) => call === "start-session").length,
      seedStarts: value.claude.calls.filter((call) => call === "start-turn").length,
    }).toEqual(callsAfterCommit);
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
    value.claude.startSessionError = new ClaudeError(
      "INVALID_INPUT",
      "Claude Code refused the session.",
    );
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
    const { sessionId } = await codexSession(value);
    const key = "00000000-0000-4000-8000-0000000006c1";
    const beginTarget = value.store.beginSessionSwitchTargetStart.bind(value.store);
    Object.defineProperty(value.store, "beginSessionSwitchTargetStart", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchTargetStart"]>[0]) => {
        // Lose control immediately after durable effect intent, before any
        // target receipt exists. A restarted daemon cannot infer no effect.
        beginTarget(input);
        throw new Error("simulated crash after durable target-start intent");
      },
    });
    await expect(value.service.execute({
      idempotencyKey: key,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toThrow("simulated crash after durable target-start intent");
    const attempt = value.store.readSessionSwitchByIdempotencyKey(key);
    if (attempt === null) throw new Error("Expected the dedicated switch journal.");
    expect(attempt).toMatchObject({ phase: "target_starting", targetStart: null });
    const captured = value.store.readMutationProviderAuthorities(attempt.attemptId);
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
      result: { code: "DAEMON_RESTART_AUTHORITY_RETIRED" },
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(key)).toMatchObject({
      phase: "reconciliation_required",
      diagnosticCode: "DAEMON_RESTART_AUTHORITY_RETIRED",
      targetStart: null,
    });
    expect(value.store.readMutationProviderAuthorities(attempt.attemptId)).toEqual(captured);
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
          source: "session_switch_abandon",
          providerEffectRetried: false,
          providerStateDeleted: false,
        },
      },
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(key))
      .toMatchObject({ phase: "abandoned" });
    expect(value.store.readMutationProviderAuthorities(attempt.attemptId)).toEqual(captured);
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
      providerAuthentication: {
        profileId: claudeAuthority.profileId,
        processGeneration: claudeAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
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
    // Admit the pending queue before arranging the independently unsettled
    // send; sealed queue admission cannot bypass an existing mutation fence.
    const dispatching = value.store.enqueue(idle.session.id, "uncertain Claude queue");
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
