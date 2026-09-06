import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_PIN, CLAUDE_PIN_MODEL } from "../claude/pin";
import { IndeterminateCodexEffectError } from "../codex/errors";
import { DEVIN_PIN, DEVIN_PIN_MODEL } from "../devin/pin";
import type { Preset } from "../domain/presets";
import type {
  EffectiveClaudeRuntimeProfile,
  EffectiveDevinRuntimeProfile,
  EffectiveRuntimeProfile,
} from "../domain/runtime-profile";
import {
  digestTranscriptSeed,
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
  type DevinRuntimePort,
  type DevinRuntimeStartReview,
  type ProfileAuthority,
  type RuntimeStartReview,
} from "./ports";
import { DaemonAuthoritySafetyError, type DaemonAuthorityFence } from "./daemon-lock";
import type {
  HraFactsMemoryLifecyclePort,
  HraFactsMemoryLifecycleReceipt,
} from "./facts-memory-lifecycle";
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
  model: preset === "low" ? "gpt-5.6-luna" : "gpt-6-astra",
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

const devinProfile = (authority: ProfileAuthority): EffectiveDevinRuntimeProfile => ({
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: 2_000,
  preset: "astra",
  model: DEVIN_PIN_MODEL,
  reasoningEffort: "provider-default",
  devinVersion: DEVIN_PIN,
  protocolVersion: 1,
  isolatedHome: true,
});

/** A Codex seam that starts sessions and turns and records every call. */
class SwitchFakeCodex implements CodexRuntimePort {
  readonly provider = "codex" as const;
  discardRuntimeReview(): void {}
  readonly calls: string[] = [];
  readonly endedThreads: string[] = [];
  sessionStartRequirement?: Parameters<CodexRuntimePort["reviewSessionStart"]>[0]["requirement"];
  endSessionError?: Error;
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
    this.sessionStartRequirement = input.requirement;
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
    if (this.endSessionError !== undefined) throw this.endSessionError;
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
  async listSessions(): ReturnType<CodexRuntimePort["listSessions"]> {
    this.calls.push("list");
    return { sessions: [], nextCursor: null };
  }
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
  readonly readSessionDetails: boolean[] = [];
  readonly seededMessages: string[] = [];
  sessionStartRequirement?: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0]["requirement"];
  accountSignedIn = true;
  readonly accountSignedInResults: boolean[] = [];
  beforeReadAccountReturn?: () => Promise<void>;
  readAccountError?: Error;
  activateError?: Error;
  observeError?: Error;
  endSessionError?: Error;
  reviewProfileGenerationOffset = 0;
  observationThreadIdOverride?: string;
  onActivate?: (input: Parameters<NonNullable<ClaudeRuntimePort["activateSessionHostTools"]>>[0]) => void;
  startSessionError?: Error;
  turnStatus: "completed" | "inProgress" = "completed";
  #turns = 0;
  projection: CodexSessionProjection = {
    providerThreadId: "claude-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 20,
  };

  pinnedVersion(): string { return CLAUDE_PIN; }
  hasRetainedProfileAuthority(): boolean { return false; }
  async retireProfileAuthority(): Promise<void> {}
  async readAccount(): Promise<CodexAccountProjection> {
    this.calls.push("read-account");
    await this.beforeReadAccountReturn?.();
    if (this.readAccountError !== undefined) throw this.readAccountError;
    const signedIn = this.accountSignedInResults.shift() ?? this.accountSignedIn;
    return signedIn
      ? { signedIn: true, email: "person@example.com" }
      : { signedIn: false };
  }
  async close(): Promise<void> {}
  async reviewSessionStart(
    input: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-session");
    this.sessionStartRequirement = input.requirement;
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
    return { ...this.projection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async activateSessionHostTools(
    input: Parameters<NonNullable<ClaudeRuntimePort["activateSessionHostTools"]>>[0],
  ): Promise<void> {
    this.calls.push("activate-host-tools");
    this.onActivate?.(input);
    if (this.activateError !== undefined) throw this.activateError;
  }
  async observeSession(
    input: Parameters<ClaudeRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    this.calls.push("observe");
    if (this.observeError !== undefined) throw this.observeError;
    return {
      connectionId: "30000000-0000-4000-8000-000000000002",
      projection: {
        ...this.projection,
        providerThreadId: this.observationThreadIdOverride ?? input.providerThreadId,
      },
      resumed: false,
    };
  }
  async readSession(
    input: Parameters<ClaudeRuntimePort["readSession"]>[0],
  ): Promise<CodexSessionProjection> {
    this.calls.push("read");
    this.readSessionDetails.push(input.detail);
    if (input.detail) return this.projection;
    return {
      providerThreadId: this.projection.providerThreadId,
      title: this.projection.title,
      status: this.projection.status,
      ...(this.projection.providerUpdatedAt === undefined
        ? {}
        : { providerUpdatedAt: this.projection.providerUpdatedAt }),
      ...(this.projection.activeTurnId === undefined
        ? {}
        : { activeTurnId: this.projection.activeTurnId }),
    };
  }
  async endSession(input: Parameters<ClaudeRuntimePort["endSession"]>[0]): Promise<void> {
    this.calls.push("end-session");
    if (this.endSessionError !== undefined) throw this.endSessionError;
    this.endedThreads.push(input.providerThreadId);
  }
  async reviewTurnStart(
    input: Parameters<ClaudeRuntimePort["reviewTurnStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-turn");
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
    this.seededMessages.push(input.message);
    this.#turns += 1;
    const turnId = `claude-turn-${String(this.#turns)}`;
    this.projection = {
      ...this.projection,
      status: this.turnStatus === "inProgress" ? "active" : "idle",
      ...(this.turnStatus === "inProgress" ? { activeTurnId: turnId } : {}),
      providerUpdatedAt: (this.projection.providerUpdatedAt ?? 20) + 1,
    };
    if (this.turnStatus !== "inProgress") {
      delete (this.projection as { activeTurnId?: string }).activeTurnId;
    }
    return {
      turnId,
      status: this.turnStatus,
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
    };
  }
  async steer(): Promise<void> { this.calls.push("steer"); }
  async interrupt(): Promise<void> {
    this.calls.push("interrupt");
    this.projection = {
      ...this.projection,
      status: "idle",
      providerUpdatedAt: (this.projection.providerUpdatedAt ?? 20) + 1,
    };
    delete (this.projection as { activeTurnId?: string }).activeTurnId;
  }
  #unsupported(): never { throw new Error("This fixture does not drive that Claude capability."); }
  interactionAuthority(): never { return this.#unsupported(); }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unsupported()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unsupported()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
}

/** A Devin seam that proves ACP routing while deliberately exposing no HRA host tools. */
class SwitchFakeDevin implements DevinRuntimePort {
  readonly provider = "devin" as const;
  readonly pendingReviewIds = new Set<string>();
  readonly calls: string[] = [];
  readonly endedThreads: string[] = [];
  readonly observedDeveloperInstructions: Array<string | undefined> = [];
  readonly readDeveloperInstructions: Array<string | undefined> = [];
  readonly seededMessages: string[] = [];
  turnStatus: "completed" | "inProgress" = "completed";
  #turns = 0;
  projection: CodexSessionProjection = {
    providerThreadId: "devin-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 30,
  };

  discardRuntimeReview(review: DevinRuntimeStartReview): void {
    this.pendingReviewIds.delete(review.reviewId);
  }
  pinnedVersion(): string { return DEVIN_PIN; }
  rebindProfileAuthority(): void {}
  hasLiveOrLoadableSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
  }): boolean {
    return input.providerThreadId === this.projection.providerThreadId;
  }
  async readAccount(): Promise<CodexAccountProjection> {
    this.calls.push("read-account");
    return { signedIn: true };
  }
  async close(): Promise<void> {}
  async reviewSessionStart(
    input: Parameters<DevinRuntimePort["reviewSessionStart"]>[0],
  ): Promise<DevinRuntimeStartReview> {
    this.calls.push("review-session");
    const review = {
      reviewId: crypto.randomUUID(),
      kind: "session_start" as const,
      effectiveRuntimeProfile: devinProfile(input.authority),
    };
    this.pendingReviewIds.add(review.reviewId);
    return review;
  }
  async startSession(
    input: Parameters<DevinRuntimePort["startSession"]>[0],
  ): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveDevinRuntimeProfile }> {
    this.calls.push("start-session");
    this.pendingReviewIds.delete(input.review.reviewId);
    return { ...this.projection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async observeSession(
    input: Parameters<DevinRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    this.calls.push("observe");
    this.observedDeveloperInstructions.push(input.developerInstructions);
    return {
      connectionId: "30000000-0000-4000-8000-000000000003",
      projection: { ...this.projection, providerThreadId: input.providerThreadId },
      resumed: false,
    };
  }
  async readSession(
    input: Parameters<DevinRuntimePort["readSession"]>[0],
  ): Promise<CodexSessionProjection> {
    this.calls.push("read");
    this.readDeveloperInstructions.push(input.developerInstructions);
    return { ...this.projection, providerThreadId: input.providerThreadId };
  }
  async endSession(input: Parameters<DevinRuntimePort["endSession"]>[0]): Promise<void> {
    this.calls.push("end-session");
    this.endedThreads.push(input.providerThreadId);
  }
  async reviewTurnStart(
    input: Parameters<DevinRuntimePort["reviewTurnStart"]>[0],
  ): Promise<DevinRuntimeStartReview> {
    this.calls.push("review-turn");
    const review = {
      reviewId: crypto.randomUUID(),
      kind: "turn_start" as const,
      effectiveRuntimeProfile: devinProfile(input.authority),
    };
    this.pendingReviewIds.add(review.reviewId);
    return review;
  }
  async startTurn(
    input: Parameters<DevinRuntimePort["startTurn"]>[0],
  ): Promise<{
    turnId: string;
    status: "completed" | "inProgress";
    effectiveRuntimeProfile: EffectiveDevinRuntimeProfile;
  }> {
    this.calls.push("start-turn");
    this.pendingReviewIds.delete(input.review.reviewId);
    this.seededMessages.push(input.message);
    this.#turns += 1;
    const turnId = `devin-turn-${String(this.#turns)}`;
    this.projection = {
      ...this.projection,
      status: this.turnStatus === "inProgress" ? "active" : "idle",
      ...(this.turnStatus === "inProgress" ? { activeTurnId: turnId } : {}),
      providerUpdatedAt: (this.projection.providerUpdatedAt ?? 30) + 1,
    };
    if (this.turnStatus !== "inProgress") {
      delete (this.projection as { activeTurnId?: string }).activeTurnId;
    }
    return {
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
      status: this.turnStatus,
      turnId,
    };
  }
  async steer(): Promise<void> { this.calls.push("steer"); }
  async interrupt(): Promise<void> {
    this.calls.push("interrupt");
    this.projection = {
      ...this.projection,
      status: "idle",
      providerUpdatedAt: (this.projection.providerUpdatedAt ?? 30) + 1,
    };
    delete (this.projection as { activeTurnId?: string }).activeTurnId;
  }
  #unsupported(): never { throw new Error("This fixture does not drive that Devin capability."); }
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

class BoundMemoryLifecycle implements HraFactsMemoryLifecyclePort {
  readonly ensures: Array<Parameters<HraFactsMemoryLifecyclePort["ensureSession"]>[0]> = [];
  readonly cleanups: Array<Parameters<HraFactsMemoryLifecyclePort["cleanupSession"]>[0]> = [];
  readonly owners = new Map<string, string>();

  #receipt(sessionId: string): HraFactsMemoryLifecycleReceipt {
    return {
      bindingDigest: "a".repeat(64),
      epoch: 1,
      handleHash: "b".repeat(64),
      head: { digest: "c".repeat(64), operationSha256: null, sequence: 0 },
      ownerId: this.owners.get(sessionId) ?? "missing",
      sessionId,
      state: "active",
    };
  }

  readSession(sessionId: string): HraFactsMemoryLifecycleReceipt | null {
    return this.owners.has(sessionId) ? this.#receipt(sessionId) : null;
  }

  async ensureSession(input: Parameters<HraFactsMemoryLifecyclePort["ensureSession"]>[0]) {
    const owner = this.owners.get(input.sessionId);
    if (owner !== undefined && owner !== input.ownerId) {
      throw new Error("FACTS_MEMORY_AUTHORITY_MISMATCH");
    }
    this.owners.set(input.sessionId, input.ownerId);
    this.ensures.push(input);
    return this.#receipt(input.sessionId);
  }

  async resumeSession(input: Parameters<HraFactsMemoryLifecyclePort["resumeSession"]>[0]) {
    return this.#receipt(input.sessionId);
  }

  async forkSession(input: Parameters<HraFactsMemoryLifecyclePort["forkSession"]>[0]) {
    this.owners.set(input.childSessionId, input.ownerId);
    return this.#receipt(input.childSessionId);
  }

  async cleanupSession(input: Parameters<HraFactsMemoryLifecyclePort["cleanupSession"]>[0]) {
    this.cleanups.push(input);
    const receipt = this.#receipt(input.sessionId);
    return { ...receipt, handleHash: null, head: null, state: "purged" as const };
  }

  async sweepExpired() {
    return { attempted: 0, failed: 0, purged: 0 };
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
  daemonGeneration: number;
  devin: SwitchFakeDevin;
  documents: string;
  paths: ReturnType<typeof resolveStatePaths>;
  service: HraService;
  store: StateStore;
}>;

async function fixture(
  daemonAuthority: Pick<DaemonAuthorityFence, "assertCurrent" | "close"> = {
    assertCurrent: async () => {},
    close: () => {},
  },
  daemonGeneration = 0,
  factsMemory?: HraFactsMemoryLifecyclePort,
): Promise<Fixture> {
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
  const devin = new SwitchFakeDevin();
  const service = new HraService({
    claude,
    cloud: new OfflineCloud(),
    codex,
    devin,
    daemonAuthority,
    daemonGeneration,
    paths,
    platform: "linux",
    requestStop: () => undefined,
    store,
    ...(factsMemory === undefined ? {} : { factsMemory }),
  });
  services.push(service);
  return { claude, codex, daemonGeneration, devin, documents, paths, service, store };
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
  const devin = new SwitchFakeDevin();
  const service = new HraService({
    claude,
    cloud: new OfflineCloud(),
    codex,
    devin,
    daemonAuthority: {
      assertCurrent: async () => {},
      close: () => {},
    },
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
    daemonGeneration,
    devin,
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

async function devinSession(value: Fixture): Promise<Readonly<{
  accountId: `acct_${string}`;
  sessionId: `sess_${string}`;
}>> {
  const added = await value.service.execute(
    { kind: "account.add", label: "Devin work" },
    { signal },
  ) as { account: { id: `acct_${string}` } };
  await value.service.execute(
    { kind: "project.add", label: "Devin work docs", path: value.documents },
    { signal },
  );
  const started = await value.service.execute(
    {
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "astra",
      provider: "devin",
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

const leaveUnseededTargetUnsettled = async (
  value: Fixture,
  sessionId: `sess_${string}`,
  idempotencyKey: string,
): Promise<void> => {
  await createLegacyProviderSwitch(value, {
    idempotencyKey,
    sessionId,
    targetProvider: "claude",
    targetRecorded: true,
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
  const targetProfileId = command.account
    ?? value.store.requireSession(command.session).profileId as `acct_${string}`;
  await createLegacyProviderSwitch(value, {
    bindTarget: true,
    idempotencyKey: command.idempotencyKey,
    seedResult: true,
    sessionId: command.session,
    sourceReleased: true,
    targetProfileId,
    targetProvider: command.provider,
    targetRecorded: true,
  });
};

const createLegacyProviderSwitch = async (
  value: Fixture,
  input: Readonly<{
    bindTarget?: boolean;
    idempotencyKey: string;
    seedIntent?: boolean;
    seedResult?: boolean;
    sessionId: `sess_${string}`;
    sourceReleased?: boolean;
    targetProfileId?: `acct_${string}`;
    targetProvider: "claude" | "codex";
    targetRecorded?: boolean;
  }>,
): Promise<void> => {
  const session = value.store.requireSession(input.sessionId);
  if (session.providerThreadId === undefined) throw new Error("Expected a bound source session.");
  const sourceProfile = value.store.requireProfileById(session.profileId);
  const targetProfile = value.store.requireProfileById(input.targetProfileId ?? session.profileId);
  const targetPreset: Preset = input.targetProvider === "claude" ? "fable-max" : "high";
  const targetThreadId = input.targetProvider === "claude"
    ? value.claude.projection.providerThreadId
    : value.codex.projection.providerThreadId;
  const runtimeProfile = input.targetProvider === "claude"
    ? claudeProfile({
        id: targetProfile.id,
        generation: targetProfile.processGeneration,
        codexHome: "unused",
        desktopUserData: "unused",
      })
    : codexProfile({
        id: targetProfile.id,
        generation: targetProfile.processGeneration,
        codexHome: "unused",
        desktopUserData: "unused",
      }, targetPreset);
  const seedText = "[HRA provider handoff]\nlegacy recovery fixture";
  const attempt = value.store.prepareMutation({
    authorityGeneration: targetProfile.processGeneration,
    authorityId: session.id,
    idempotencyKey: input.idempotencyKey,
    kind: "session.switch",
    request: {
      provider: input.targetProvider,
      preset: targetPreset,
      targetProfileId: targetProfile.id,
      seedDigest: digestTranscriptSeed(seedText),
    },
  });
  value.store.beginSessionProviderSwitchEffect({
    attemptId: attempt.id,
    sessionId: session.id,
    providerAuthentication: {
      profileId: targetProfile.id,
      processGeneration: targetProfile.processGeneration,
      provider: input.targetProvider,
      signedIn: true,
    },
    evidence: {
      kind: "session.switch",
      daemonGeneration: value.daemonGeneration,
      requestedAccountId: input.targetProfileId ?? null,
      requestedPreset: null,
      sourceProfileId: sourceProfile.id,
      sourceProcessGeneration: sourceProfile.processGeneration,
      sourceProvider: session.provider,
      sourceProviderThreadId: session.providerThreadId,
      sourcePreset: session.preset,
      targetProfileId: targetProfile.id,
      targetProcessGeneration: targetProfile.processGeneration,
      targetProvider: input.targetProvider,
      targetPreset,
      transcriptDigest: "a".repeat(64),
      seedDigest: digestTranscriptSeed(seedText),
      seedIncludedRecords: 0,
      seedOmittedRecords: 0,
      runtimeProfile,
    },
  });
  if (input.targetRecorded) {
    value.store.recordSessionProviderSwitchTarget({
      attemptId: attempt.id,
      sessionId: session.id,
      providerThreadId: targetThreadId,
    });
  }
  if (input.seedIntent || input.seedResult || input.sourceReleased) {
    value.store.recordSessionProviderSwitchSeedIntent({
      attemptId: attempt.id,
      sessionId: session.id,
      providerThreadId: targetThreadId,
      seedText,
      runtimeProfile,
    });
  }
  if (input.seedResult || input.sourceReleased) {
    value.store.recordSessionProviderSwitchSeedResult({
      attemptId: attempt.id,
      sessionId: session.id,
      providerThreadId: targetThreadId,
      runtimeProfile,
      turnId: input.targetProvider === "claude" ? "claude-turn-1" : "codex-turn-1",
      turnStatus: "completed",
    });
  }
  if (input.sourceReleased) {
    value.store.recordSessionProviderSwitchSourceReleased({
      attemptId: attempt.id,
      sessionId: session.id,
    });
  }
  const quarantined = value.store.quarantineSession(session.id);
  if (input.bindTarget) {
    value.store.bindSessionProviderSwitchRecoveryTarget({
      attemptId: attempt.id,
      sessionId: session.id,
      expectedSessionRevision: quarantined.revision,
      title: "Recovered target",
      providerUpdatedAt: input.targetProvider === "claude" ? 20 : 10,
    });
  }
  if (!value.store.transitionMutation(attempt.id, "effect_started", "ambiguous")) {
    throw new Error("Expected to mark the legacy switch ambiguous.");
  }
};

const leaveJournaledTargetStarted = async (
  value: Fixture,
  sessionId: `sess_${string}`,
  idempotencyKey: string,
): Promise<void> => {
  const beginSourceRelease = value.store.beginSessionProviderSwitchSourceRelease.bind(value.store);
  Object.defineProperty(value.store, "beginSessionProviderSwitchSourceRelease", {
    configurable: true,
    value: () => { throw new Error("simulated source-release intent failure"); },
  });
  try {
    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  } finally {
    Object.defineProperty(value.store, "beginSessionProviderSwitchSourceRelease", {
      configurable: true,
      value: beginSourceRelease,
    });
  }
  expect(value.store.readSessionProviderSwitchForSession(sessionId)).toMatchObject({
    phase: "target_started",
    target: {
      providerThreadId: "claude-thread-1",
      providerUpdatedAt: 20,
      state: "idle",
    },
  });
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
    expect(value.store.requireProfileById(authority.profileId).processGeneration)
      .toBeGreaterThan(authority.originGeneration);
    expect(value.store.isSessionMutationProviderAuthorityCurrent({
      attemptId: attempt.id,
      ...authority,
    })).toBe(true);
  }
};

describe("provider portability", () => {
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

  test("reports Claude host-tool activation failure as runtime resume unavailable", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const activationsBefore = value.claude.calls.filter(
      (call) => call === "activate-host-tools",
    ).length;
    const observationsBefore = value.claude.calls.filter((call) => call === "observe").length;
    value.claude.activateError = new Error("Claude process-local session is not retained");

    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        basis: "provider_read",
        code: "resume_unavailable",
        source: "claude_runtime",
        state: "unavailable",
      },
      session: { id: sessionId },
    });
    expect(value.claude.calls.filter((call) => call === "activate-host-tools"))
      .toHaveLength(activationsBefore + 1);
    expect(value.claude.calls.filter((call) => call === "observe"))
      .toHaveLength(observationsBefore);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "idle",
    });
  });

  test("requests detailed Claude history to recover an ambiguous sent message", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound Claude session.");
    const message = "Recover this exact Claude send.";
    const idempotencyKey = crypto.randomUUID();
    const attempt = value.store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: session.id,
      idempotencyKey,
      kind: "session.send",
      request: { message },
    });
    value.store.beginSessionMutationEffect({
      attemptId: attempt.id,
      evidence: {
        baseline: {
          activeTurnId: null,
          providerUpdatedAt: session.providerUpdatedAt ?? null,
          status: "idle",
        },
        clientMessageId: attempt.id,
        kind: "session.send",
        messageDigest: createHash("sha256").update(message).digest("hex"),
        providerThreadId: session.providerThreadId,
        runtimeProfile: claudeProfile({
          id: profile.id,
          generation: profile.processGeneration,
          codexHome: "unused",
          desktopUserData: "unused",
        }),
      },
      message,
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
    });
    expect(value.store.transitionMutation(attempt.id, "effect_started", "ambiguous"))
      .toBe(true);
    value.store.quarantineSession(session.id);
    value.claude.projection = {
      activeTurnId: "claude-recovered-turn",
      messages: [{
        clientId: attempt.id,
        role: "user",
        text: message,
        turnId: "claude-recovered-turn",
      }],
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 0,
        turnLimit: 20,
        unreadItemTurnIds: [],
      },
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: (session.providerUpdatedAt ?? 20) + 1,
      status: "active",
      title: session.title,
      turnSummaries: [{
        actions: [],
        files: [],
        id: "claude-recovered-turn",
        omittedActions: 0,
        omittedFiles: 0,
        status: "inProgress",
      }],
    };
    const detailReadsBefore = value.claude.readSessionDetails.length;

    await expect(value.service.execute({
      kind: "session.recover",
      session: session.id,
    }, { signal })).resolves.toMatchObject({
      recovery: { resolution: "proven_applied" },
      session: { activeTurnId: "claude-recovered-turn", state: "active" },
    });
    expect(value.claude.readSessionDetails.slice(detailReadsBefore)).toEqual([true]);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: { kind: "proven_applied" },
      state: "reconciled",
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
    const loginKey = crypto.randomUUID();
    const attempt = value.store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login",
      request: { provider: "claude" },
    });
    value.store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      evidence: {
        baselineSignedIn: false,
        kind: "account.claude-login",
        provider: "claude",
      },
      profileGeneration: profile.processGeneration,
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
    const loginKey = crypto.randomUUID();
    const attempt = value.store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login",
      request: { provider: "claude" },
    });
    value.store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      evidence: {
        baselineSignedIn: false,
        kind: "account.claude-login",
        provider: "claude",
      },
      profileGeneration: profile.processGeneration,
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
    const factsMemory = new BoundMemoryLifecycle();
    const value = await fixture(undefined, 0, factsMemory);
    const { sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "ship the release", session: sessionId },
      { signal },
    );

    value.claude.onActivate = (input) => {
      expect(value.store.findSessionByProviderThread(input.authority.id, input.providerThreadId))
        .toMatchObject({ id: sessionId, provider: "claude" });
    };
    const switchKey = crypto.randomUUID();
    const switched = await value.service.execute(
      { idempotencyKey: switchKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    ) as {
      from: { preset: string; provider: string };
      seed: { digest: string; includedRecords: number; omittedRecords: number };
      to: { preset: string; provider: string };
    };

    expect(switched.from).toMatchObject({ preset: "high", provider: "codex" });
    expect(switched.to).toMatchObject({ preset: "fable-max", provider: "claude" });
    expect(switched.seed.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(value.claude.sessionStartRequirement).toEqual({
      model: CLAUDE_PIN_MODEL,
      effort: "max",
    });

    const session = value.store.requireSession(sessionId);
    expect(session.provider).toBe("claude");
    expect(session.preset).toBe("fable-max");
    expect(session.providerThreadId).toBe("claude-thread-1");
    expect(factsMemory.readSession(sessionId)).toMatchObject({
      ownerId: session.profileId,
      state: "active",
    });
    expect(factsMemory.ensures.every((entry) => entry.ownerId === session.profileId)).toBe(true);
    // The outgoing provider was released, and its thread was not deleted.
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(value.claude.calls.indexOf("activate-host-tools"))
      .toBeGreaterThan(value.claude.calls.indexOf("start-session"));
    expect(value.claude.calls.indexOf("observe"))
      .toBeGreaterThan(value.claude.calls.indexOf("activate-host-tools"));

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

    // An exact replay returns the journal's original terminal result. It does
    // not start another target, release the source again, resend the seed, or
    // duplicate either transcript record.
    await expect(value.service.execute(
      { idempotencyKey: switchKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).resolves.toEqual(switched);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(value.claude.seededMessages).toHaveLength(1);
    const replayedTranscript = await transcriptOf(value, sessionId);
    expect(replayedTranscript.records.filter((record) => record.kind === "provider_switch"))
      .toHaveLength(1);
    expect(replayedTranscript.records.filter(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    )).toHaveLength(1);

    // The next ordinary turn runs on Claude.
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "carry on", session: sessionId },
      { signal },
    );
    expect(value.claude.seededMessages.at(-1)).toBe("carry on");
  });

  test("switches Codex to Devin without carrying an unimplemented host-capability binding", async () => {
    const factsMemory = new BoundMemoryLifecycle();
    const value = await fixture(undefined, 0, factsMemory);
    const { sessionId } = await codexSession(value);
    const source = value.store.requireSession(sessionId);
    expect(value.store.readSessionHostCapabilityBinding(sessionId)).not.toBeNull();

    const switched = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "devin",
      session: sessionId,
    }, { signal }) as {
      from: { provider: string };
      to: { provider: string };
    };

    expect(switched).toMatchObject({
      from: { provider: "codex" },
      to: { provider: "devin" },
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: source.profileId,
      provider: "devin",
      providerThreadId: "devin-thread-1",
      preset: "astra",
    });
    expect(value.store.readSessionHostCapabilityBinding(sessionId)).toBeNull();
    expect(value.devin.observedDeveloperInstructions).not.toHaveLength(0);
    expect(value.devin.observedDeveloperInstructions.every((value) => value === undefined)).toBe(true);
    expect(value.devin.readDeveloperInstructions).not.toHaveLength(0);
    expect(value.devin.readDeveloperInstructions.every((value) => value === undefined)).toBe(true);
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(value.devin.seededMessages[0]).toContain(
      "This conversation ran on codex and now runs on devin.",
    );
    expect(factsMemory.readSession(sessionId)).toMatchObject({
      ownerId: source.profileId,
      state: "active",
    });
    expect(factsMemory.cleanups).toEqual([]);
  });

  test("switches Devin to Claude and atomically establishes the target host-capability binding", async () => {
    const factsMemory = new BoundMemoryLifecycle();
    const value = await fixture(undefined, 0, factsMemory);
    const { sessionId } = await devinSession(value);
    const source = value.store.requireSession(sessionId);
    expect(value.store.readSessionHostCapabilityBinding(sessionId)).toBeNull();

    await value.service.execute(
      { detail: false, kind: "session.show", session: sessionId },
      { signal },
    );
    expect(value.devin.observedDeveloperInstructions).toEqual([undefined]);
    expect(value.devin.readDeveloperInstructions).toEqual([undefined]);

    value.claude.onActivate = (input) => {
      expect(value.store.findSessionByProviderThread(input.authority.id, input.providerThreadId))
        .toMatchObject({ id: sessionId, provider: "claude" });
      expect(value.store.readSessionHostCapabilityBinding(sessionId)).not.toBeNull();
    };
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal });

    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: source.profileId,
      provider: "claude",
      providerThreadId: "claude-thread-1",
      preset: "fable-max",
    });
    expect(value.store.readSessionHostCapabilityBinding(sessionId)).toMatchObject({
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      manifestVersion: 1,
      preambleDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      preambleVersion: 1,
    });
    expect(value.devin.endedThreads).toEqual(["devin-thread-1"]);
    expect(value.claude.calls).toContain("activate-host-tools");
    expect(factsMemory.readSession(sessionId)).toMatchObject({
      ownerId: source.profileId,
      state: "active",
    });
    expect(factsMemory.cleanups).toEqual([]);
  });

  test("replays a committed rebind after response loss without repeating completed provider effects", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "preserve this", session: sessionId },
      { signal },
    );
    const idempotencyKey = crypto.randomUUID();
    const complete = value.store.completeJournaledSessionProviderSwitch.bind(value.store);
    Object.defineProperty(value.store, "completeJournaledSessionProviderSwitch", {
      configurable: true,
      value: (attemptId: Parameters<StateStore["completeJournaledSessionProviderSwitch"]>[0]) => {
        complete(attemptId);
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
    }).toEqual({
      sourceEnds: callsAfterCommit.sourceEnds,
      targetStarts: callsAfterCommit.targetStarts,
    });
    // The rebind was durable but the seed had not begun. Replay sends that
    // pending effect exactly once; it does not redo target start or release.
    expect(callsAfterCommit.seedStarts).toBe(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
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

  test("keeps a legacy v35 seeded target available for exact recovery", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await createLegacyProviderSwitch(value, {
      idempotencyKey,
      seedResult: true,
      sessionId,
      targetProvider: "claude",
      targetRecorded: true,
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

  test("does not replay or inspect an unseeded Claude target after daemon restart", async () => {
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

  test("does not claim a seeded Claude target applied after daemon restart", async () => {
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

  test("cleans a Codex target but keeps Claude source state unknown after restart", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Codex target");
    const idempotencyKey = crypto.randomUUID();
    await createLegacyProviderSwitch(value, {
      idempotencyKey,
      seedResult: true,
      sessionId,
      targetProfileId: targetAccountId,
      targetProvider: "codex",
      targetRecorded: true,
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

  test("recovers a seeded Codex target when the Claude source release receipt survived restart", async () => {
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

  test("does not accept one visible seed match from an incomplete recovery projection", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await createLegacyProviderSwitch(value, {
      idempotencyKey,
      seedIntent: true,
      sessionId,
      targetProvider: "claude",
      targetRecorded: true,
    });
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    value.claude.projection = {
      ...value.claude.projection,
      messages: [{
        clientId: attempt.id,
        role: "user",
        text: "[HRA provider handoff]\nlegacy recovery fixture",
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
      messages: [
        {
          clientId: attempt.id,
          role: "user",
          text: "[HRA provider handoff]\nlegacy recovery fixture",
          turnId: "claude-turn-1",
        },
        {
          clientId: attempt.id,
          role: "user",
          text: "same client id, different message",
        },
      ],
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 0,
        turnLimit: 20,
        unreadItemTurnIds: [],
      },
      turnSummaries: [],
    };
    await expect(value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("multiple messages"),
    });
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).seedTurnId).toBeUndefined();
    expect(value.claude.endedThreads).toEqual([]);

    value.claude.projection = {
      ...value.claude.projection,
      messages: [{
        clientId: attempt.id,
        role: "user",
        text: "same client id, different message",
        turnId: "claude-turn-1",
      }],
    };
    await expect(value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("does not exactly match"),
    });
    expect(value.claude.endedThreads).toEqual([]);

    value.claude.projection = {
      ...value.claude.projection,
      messages: [],
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

  test("reports retained source state after cleaning an unseeded target", async () => {
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

  test("does not resolve abandonment after losing daemon authority during target cleanup", async () => {
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

  test("does not resolve abandonment after losing daemon authority during source read", async () => {
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
      processGeneration: profile.processGeneration,
      profileId: profile.id,
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
      processGeneration: sourceProfile.processGeneration,
      profileId: sourceProfile.id,
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

  test("never retries an indeterminate target start without an exact target thread", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.claude.startSessionError = new IndeterminateCodexEffectError(
      "thread/start",
      0,
    );

    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
    const journal = value.store.readSessionProviderSwitchForSession(sessionId);
    expect(journal).toMatchObject({
      ambiguousFromPhase: "target_start_started",
      phase: "ambiguous",
    });
    expect(journal?.target.providerThreadId).toBeUndefined();

    delete value.claude.startSessionError;
    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.endedThreads).toEqual([]);
  });

  test("explicitly abandons an unreceipted journal target with orphan acknowledgement", async () => {
    const factsMemory = new BoundMemoryLifecycle();
    const value = await fixture(undefined, 0, factsMemory);
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.claude.startSessionError = new IndeterminateCodexEffectError("thread/start", 0);

    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    delete value.claude.startSessionError;

    await expect(value.service.execute(
      { kind: "session.recover", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute(
      { kind: "session.abandon", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      recovery: {
        orphanAcknowledged: true,
        providerStateDeleted: false,
        providerStateUnknown: true,
        resolution: "abandoned",
        sourceRetained: true,
        unaddressableTargetMayExist: true,
      },
      session: {
        provider: "codex",
        providerThreadId: "codex-thread-1",
        state: "idle",
      },
    });
    expect(value.claude.endedThreads).toEqual([]);
    expect(factsMemory.cleanups).toEqual([]);
    expect(factsMemory.readSession(sessionId)).toMatchObject({ state: "active" });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
      evidence: { evidence: { kind: "session.switch.journal" } },
      resolution: {
        evidence: { possibleOrphanTarget: true },
        kind: "abandoned",
      },
      state: "reconciled",
    });
  });

  test("explicitly abandons a receipted journal target by releasing that exact target", async () => {
    const factsMemory = new BoundMemoryLifecycle();
    const value = await fixture(undefined, 0, factsMemory);
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveJournaledTargetStarted(value, sessionId, idempotencyKey);

    await expect(value.service.execute(
      { kind: "session.abandon", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      recovery: {
        providerStateDeleted: true,
        providerStateUnknown: false,
        resolution: "abandoned",
        sourceRetained: true,
        targetReleased: true,
      },
      session: {
        provider: "codex",
        providerThreadId: "codex-thread-1",
        state: "idle",
      },
    });
    expect(value.claude.endedThreads).toEqual(["claude-thread-1"]);
    expect(value.codex.endedThreads).toEqual([]);
    expect(factsMemory.cleanups).toEqual([]);
    expect(factsMemory.readSession(sessionId)).toMatchObject({ state: "active" });
  });

  test("refuses journal abandonment after source release begins and recovers by exact retry", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.codex.endSessionError = new Error("source release did not settle");

    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute(
      { kind: "session.abandon", session: sessionId },
      { signal },
    )).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("can only be recovered"),
    });
    expect(value.claude.endedThreads).toEqual([]);

    delete value.codex.endSessionError;
    await expect(value.service.execute(
      { kind: "session.recover", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      recovery: {
        providerEffectRetried: true,
        resolution: "proven_applied",
        targetStartRetried: false,
      },
      session: { provider: "claude", providerThreadId: "claude-thread-1" },
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(2);
  });

  test("settles a prior-generation Claude source as unknown only after explicit abandon", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Restart target");
    const idempotencyKey = crypto.randomUUID();
    value.claude.endSessionError = new Error("source release did not settle");

    await expect(value.service.execute({
      account: targetAccountId,
      idempotencyKey,
      kind: "session.switch",
      provider: "codex",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionProviderSwitchForSession(sessionId)).toMatchObject({
      ambiguousFromPhase: "source_release_started",
      phase: "ambiguous",
      source: { provider: "claude", providerThreadId: "claude-thread-1" },
      target: { provider: "codex", providerThreadId: "codex-thread-1" },
    });

    const restarted = await reopenFixture(value);
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.codex.calls).toEqual([]);
    await expect(restarted.service.execute(
      { kind: "session.recover", session: sessionId },
      { signal },
    )).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("Claude sessions are process-local"),
    });
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.codex.calls).toEqual([]);

    await expect(restarted.service.execute(
      { kind: "session.abandon", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      recovery: {
        providerEffectRetried: false,
        providerStateDeleted: false,
        providerStateUnknown: true,
        resolution: "abandoned",
        sourceReleased: false,
        sourceStateUnknown: true,
        targetAddressable: true,
        targetReleased: true,
        targetStateUnknown: false,
      },
      session: { state: "terminal" },
    });
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.codex.calls).toEqual(["end-session"]);
    expect(restarted.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: {
        evidence: {
          providerStateUnknown: true,
          sourceStateUnknown: true,
          targetReleased: true,
        },
        kind: "abandoned",
      },
      state: "reconciled",
    });
  });

  test("never inspects a prior-generation Claude target during unknown-state abandon", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.codex.endSessionError = new Error("source release did not settle");
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const restarted = await reopenFixture(value);
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);

    await expect(restarted.service.execute(
      { kind: "session.abandon", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      recovery: {
        providerEffectRetried: false,
        providerStateDeleted: false,
        providerStateUnknown: true,
        resolution: "abandoned",
        sourceObserved: true,
        sourceReleased: false,
        sourceStateUnknown: false,
        targetAddressable: true,
        targetReleased: false,
        targetStateUnknown: true,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).toEqual(["read"]);
    expect(restarted.claude.calls).toEqual([]);
    await expect(restarted.service.execute(command, { signal })).resolves.toMatchObject({
      settlement: {
        kind: "session.switch.journal",
        providerReleaseClaimed: false,
        providerStateUnknown: true,
        sourceStateUnknown: false,
        targetStateUnknown: true,
      },
    });
    expect(restarted.codex.calls).toEqual(["read"]);
    expect(restarted.claude.calls).toEqual([]);
  });

  test("refuses abandonment after a receipted source release and retries only local rebind", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    const complete = value.store.completeJournaledSessionProviderSwitch.bind(value.store);
    Object.defineProperty(value.store, "completeJournaledSessionProviderSwitch", {
      configurable: true,
      value: () => { throw new Error("simulated local rebind failure"); },
    });
    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionProviderSwitchForSession(sessionId)).toMatchObject({
      ambiguousFromPhase: "source_released",
      phase: "ambiguous",
    });
    await expect(value.service.execute(
      { kind: "session.abandon", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    Object.defineProperty(value.store, "completeJournaledSessionProviderSwitch", {
      configurable: true,
      value: complete,
    });

    await expect(value.service.execute(
      { kind: "session.recover", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      recovery: { resolution: "proven_applied", targetStartRetried: false },
      session: { provider: "claude", providerThreadId: "claude-thread-1" },
    });
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
  });

  test("does not seed an applied prior-generation Claude target and permits unknown settlement", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    const beginSeed = value.store.beginSessionProviderSwitchSeed.bind(value.store);
    Object.defineProperty(value.store, "beginSessionProviderSwitchSeed", {
      configurable: true,
      value: () => { throw new Error("simulated seed-intent commit failure"); },
    });
    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    Object.defineProperty(value.store, "beginSessionProviderSwitchSeed", {
      configurable: true,
      value: beginSeed,
    });
    expect(value.store.readSessionProviderSwitchForSession(sessionId)).toMatchObject({
      phase: "applied",
      seed: { state: "pending" },
    });

    const restarted = await reopenFixture(value);
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);
    await expect(restarted.service.execute(
      { kind: "session.recover", session: sessionId },
      { signal },
    )).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("Claude sessions are process-local"),
    });
    await expect(restarted.service.execute(
      { kind: "session.abandon", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      recovery: {
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
  });

  test("fails closed when a journaled target no longer matches providerUpdatedAt", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveJournaledTargetStarted(value, sessionId, idempotencyKey);
    value.claude.projection = { ...value.claude.projection, providerUpdatedAt: 21 };

    await expect(value.service.execute(
      { kind: "session.recover", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(value.claude.endedThreads).toEqual(["claude-thread-1"]);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "idle",
    });
  });

  test("rejects a target runtime that differs from its reviewed receipt and releases it", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const startSession = value.claude.startSession.bind(value.claude);
    Object.defineProperty(value.claude, "startSession", {
      configurable: true,
      value: async (input: Parameters<ClaudeRuntimePort["startSession"]>[0]) => {
        const started = await startSession(input);
        return {
          ...started,
          effectiveRuntimeProfile: {
            ...started.effectiveRuntimeProfile,
            observedAt: started.effectiveRuntimeProfile.observedAt + 1,
          },
        };
      },
    });

    await expect(value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.claude.endedThreads).toEqual(["claude-thread-1"]);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "idle",
    });
  });

  test("makes seed-journal finalization failure recoverable without resending the seed", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    const finishSeed = value.store.finishSessionProviderSwitchSeed.bind(value.store);
    Object.defineProperty(value.store, "finishSessionProviderSwitchSeed", {
      configurable: true,
      value: () => { throw new Error("simulated seed journal commit failure"); },
    });
    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    Object.defineProperty(value.store, "finishSessionProviderSwitchSeed", {
      configurable: true,
      value: finishSeed,
    });

    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      idempotencyKey,
      seed: { delivered: true },
      session: { provider: "claude" },
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);
  });

  test("journals an unsettled source release without retrying target creation", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.codex.endSessionError = new Error("source release failed after partial cleanup");

    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
      kind: "session.switch",
      state: "effect_started",
    });
    expect(value.store.readSessionProviderSwitchForSession(sessionId)).toMatchObject({
      ambiguousFromPhase: "source_release_started",
      phase: "ambiguous",
      target: { providerThreadId: "claude-thread-1" },
    });
    // The recorded target stays owned by the journal. Cleaning it up here
    // would make a later idempotent source-release recovery impossible.
    expect(value.claude.endedThreads).toEqual([]);
    expect(value.claude.calls).not.toContain("activate-host-tools");
    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(2);
  });

  test("retries an exact unsettled source release and completes without a second target", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.codex.endSessionError = new Error("source release failed after partial cleanup");

    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    delete value.codex.endSessionError;
    await expect(value.service.recover()).resolves.toBeUndefined();
    await expect(value.service.execute(
      { idempotencyKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      seed: { delivered: true },
      session: { provider: "claude", providerThreadId: "claude-thread-1" },
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "idle",
    });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    expect(value.claude.endedThreads).toEqual([]);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.claude.seededMessages).toHaveLength(1);
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
