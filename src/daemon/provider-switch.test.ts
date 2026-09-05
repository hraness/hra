import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_PIN, CLAUDE_PIN_MODEL } from "../claude/pin";
import { IndeterminateCodexEffectError } from "../codex";
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
  CodexSessionObservationError,
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
import { DaemonAuthoritySafetyError, type DaemonAuthorityFence } from "./daemon-lock";
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
  discardRuntimeReview(): void {}
  readonly calls: string[] = [];
  readonly endedThreads: string[] = [];
  beforeEndSessionReturn?: () => Promise<void> | void;
  beforeLogoutReturn?: () => Promise<void> | void;
  endSessionError?: Error;
  turnStatus: "completed" | "inProgress" = "completed";
  accountProjection: CodexAccountProjection = {
    signedIn: true,
    email: "person@example.com",
  };
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
    return this.accountProjection;
  }
  async releaseOwnedAuthority(): Promise<void> {}
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
    if (this.endSessionError !== undefined) throw this.endSessionError;
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
  readonly pendingReviewIds = new Set<string>();
  discardRuntimeReview(review: ClaudeRuntimeStartReview): void {
    this.pendingReviewIds.delete(review.reviewId);
  }
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
  readonly endedThreads: string[] = [];
  accountSignedIn = true;
  readonly accountSignedInResults: boolean[] = [];
  beforeReadAccountReturn?: () => Promise<void>;
  beforeClaimSessionReturn?: () => Promise<void> | void;
  readAccountError?: Error;
  observeError?: Error;
  endSessionError?: Error;
  reviewProfileGenerationOffset = 0;
  omitProcessIdentityOnClaim = false;
  startSessionError?: Error;
  #turns = 0;
  projection: CodexSessionProjection = {
    providerThreadId: "claude-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 20,
  };

  pinnedVersion(): string { return CLAUDE_PIN; }
  rebindProfileAuthority(): void {}
  async readAccount(): Promise<CodexAccountProjection> {
    this.calls.push("read-account");
    await this.beforeReadAccountReturn?.();
    if (this.readAccountError !== undefined) throw this.readAccountError;
    const signedIn = this.accountSignedInResults.shift() ?? this.accountSignedIn;
    return signedIn
      ? {
          signedIn: true,
          accountId: "claude-account",
          organizationId: "claude-organization",
          email: "person@example.com",
        }
      : { signedIn: false };
  }
  async close(): Promise<void> {}
  async reviewSessionStart(
    input: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-session");
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
    this.startSessionRequests.push(input);
    this.pendingReviewIds.delete(input.review.reviewId);
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
    if (!this.omitProcessIdentityOnClaim) {
      await input.admitProcessIdentity?.(this.processIdentity);
    }
    await this.beforeClaimSessionReturn?.();
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
    if (this.observeError !== undefined) throw this.observeError;
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
    if (this.endSessionError !== undefined) throw this.endSessionError;
    this.endRequests.push(input);
    this.endedThreads.push(input.providerThreadId);
    this.endedProcessIdentities.push(this.processIdentity);
    this.controllerLive = false;
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
  daemonGeneration: number;
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
  const service = new HraService({
    claude,
    cloud: new OfflineCloud(),
    codex,
    daemonAuthority,
    daemonGeneration,
    paths,
    platform: "linux",
    requestStop: () => undefined,
    store,
  });
  services.push(service);
  return { claude, codex, daemonGeneration, documents, paths, service, store };
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
  const service = new HraService({
    claude,
    cloud: new OfflineCloud(),
    codex,
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

const leaveUnseededTargetUnsettled = async (
  value: Fixture,
  sessionId: `sess_${string}`,
  idempotencyKey: string,
): Promise<void> => {
  const recordSeedIntent = value.store.recordSessionProviderSwitchSeedIntent.bind(value.store);
  const endTarget = value.claude.endSession.bind(value.claude);
  Object.defineProperty(value.store, "recordSessionProviderSwitchSeedIntent", {
    configurable: true,
    value: () => { throw new Error("simulated seed-intent receipt failure"); },
  });
  Object.defineProperty(value.claude, "endSession", {
    configurable: true,
    value: async () => { throw new Error("simulated target cleanup failure"); },
  });
  try {
    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  } finally {
    Object.defineProperty(value.store, "recordSessionProviderSwitchSeedIntent", {
      configurable: true,
      value: recordSeedIntent,
    });
    Object.defineProperty(value.claude, "endSession", {
      configurable: true,
      value: endTarget,
    });
  }
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
  const complete = value.store.completeSessionProviderSwitch.bind(value.store);
  Object.defineProperty(value.store, "completeSessionProviderSwitch", {
    configurable: true,
    value: () => { throw new Error("simulated final switch commit failure"); },
  });
  try {
    await expect(value.service.execute({
      ...command,
      kind: "session.switch",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  } finally {
    Object.defineProperty(value.store, "completeSessionProviderSwitch", {
      configurable: true,
      value: complete,
    });
  }
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

    const review = value.claude.calls.indexOf("review-session");
    const start = value.claude.calls.indexOf("start-session");
    expect(review).toBeGreaterThan(value.claude.calls.indexOf("read-account"));
    expect(start).toBeGreaterThan(review);
    expect(value.claude.calls.filter((call) => call === "read-account").length)
      .toBeGreaterThanOrEqual(3);
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
    const providerThreadId = value.store.requireSession(sessionId).providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected a bound Claude session.");
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
    expect(value.claude.endedThreads).toEqual([providerThreadId]);
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
    value.claude.observeError = new CodexSessionObservationError("resume_unavailable");

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
    expect(value.claude.calls.filter((call) => call === "review-session")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "read-account").length)
      .toBeGreaterThanOrEqual(2);

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
      expect(events).toEqual(["target-start", "seed", "source-release", "logout"]);
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

  test("releases and resumes a switched-in Claude child lost after seeding", async () => {
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

    const seedDelivery = value.claude.calls.indexOf("start-turn");
    const firstObservation = value.claude.calls.indexOf("observe", seedDelivery + 1);
    const release = value.claude.calls.indexOf("end-session", firstObservation + 1);
    const claim = value.claude.calls.indexOf("claim-session", release + 1);
    const replacementObservation = value.claude.calls.indexOf("observe", claim + 1);
    expect(seedDelivery).toBeGreaterThanOrEqual(0);
    expect(firstObservation).toBeGreaterThanOrEqual(0);
    expect(firstObservation).toBeGreaterThan(seedDelivery);
    expect(release).toBeGreaterThan(firstObservation);
    expect(claim).toBeGreaterThan(release);
    expect(replacementObservation).toBeGreaterThan(claim);
    expect(value.claude.seededMessages).toHaveLength(1);
    expect(value.claude.seededMessages[0]).toContain("[HRA provider handoff]");
  });

  test("replays a committed provider switch after response loss without repeating provider effects", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "preserve this", session: sessionId },
      { signal },
    );
    const idempotencyKey = crypto.randomUUID();
    const complete = value.store.completeSessionProviderSwitch.bind(value.store);
    Object.defineProperty(value.store, "completeSessionProviderSwitch", {
      configurable: true,
      value: (input: Parameters<StateStore["completeSessionProviderSwitch"]>[0]) => {
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
    const firstProviderThreadId = first.session.providerThreadId;
    expect(first.session).toMatchObject({
      provider: "claude",
      providerThreadId: firstProviderThreadId,
    });
    expect(firstProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);

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
      providerThreadId: firstProviderThreadId,
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

  test("keeps a durably seeded target when source release does not settle", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.codex.endSessionError = new Error("source release did not settle");

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
      kind: "session.switch",
      state: "ambiguous",
    });
    const seededProgress = value.store.readSessionProviderSwitchProgress(
      value.store.readMutation(idempotencyKey)!.id,
    );
    expect(seededProgress).toMatchObject({
      seedTurnId: "claude-turn-1",
      sourceReleased: false,
      targetReleased: false,
    });
    expect(seededProgress.targetProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(value.claude.seededMessages).toHaveLength(1);
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
      targetReleased: false,
    });
    expect(progressBeforeRestart.targetProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);

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
    const progressBeforeRestart = value.store.readSessionProviderSwitchProgress(
      attemptBeforeRestart.id,
    );
    const targetProviderThreadId = progressBeforeRestart.targetProviderThreadId;
    if (targetProviderThreadId === undefined) throw new Error("Expected a Claude target receipt.");
    expect(progressBeforeRestart).toMatchObject({
      seedTurnId: "claude-turn-1",
      sourceReleased: true,
      targetReleased: false,
    });
    expect(targetProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);

    const restarted = await reopenFixture(value);
    expectCurrentSwitchSuccessors(restarted, idempotencyKey);
    expect(restarted.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      providerThreadId: targetProviderThreadId,
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
    value.claude.endSessionError = new Error("source release did not settle");
    await expect(value.service.execute({
      account: targetAccountId,
      idempotencyKey,
      kind: "session.switch",
      provider: "codex",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
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

  test("does not target a replacement Codex account while abandoning a recovered switch", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Replaced Codex target");
    const idempotencyKey = crypto.randomUUID();
    value.claude.endSessionError = new Error("source release did not settle");
    await expect(value.service.execute({
      account: targetAccountId,
      idempotencyKey,
      kind: "session.switch",
      provider: "codex",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart?.evidence?.evidence.kind !== "session.switch") {
      throw new Error("Expected an unsettled provider switch.");
    }
    expect(attemptBeforeRestart.evidence.evidence.targetProviderAccountKey).toBeString();

    const restarted = await reopenFixture(value);
    restarted.codex.accountProjection = {
      signedIn: true,
      email: "replacement@example.com",
    };
    expect(await restarted.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        providerStateUnknown: true,
        sourceReleased: false,
        sourceStateUnknown: true,
        targetReleased: false,
        targetStateUnknown: true,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).not.toContain("end-session");
    expect(restarted.codex.endedThreads).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: {
        evidence: {
          providerStateDeleted: false,
          providerStateUnknown: true,
          targetReleased: false,
          targetStateUnknown: true,
        },
        kind: "abandoned",
      },
      state: "reconciled",
    });
  });

  test("keeps a lost target start ambiguous when the target account changes before the response", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Lost-response Codex target");
    const idempotencyKey = crypto.randomUUID();
    const startTarget = value.codex.startSession.bind(value.codex);
    Object.defineProperty(value.codex, "startSession", {
      configurable: true,
      value: async (input: Parameters<CodexRuntimePort["startSession"]>[0]) => {
        await startTarget(input);
        value.codex.accountProjection = {
          signedIn: true,
          email: "replacement@example.com",
        };
        throw new IndeterminateCodexEffectError("thread/start", 71);
      },
    });

    await expect(value.service.execute({
      account: targetAccountId,
      idempotencyKey,
      kind: "session.switch",
      provider: "codex",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(0);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "recovery_required",
    });
    await value.service.settled();
    await expect(value.service.close()).resolves.toBeUndefined();
  });

  test("runs the forced target-account proof after a failed recovery read", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Read-race Codex target");
    const idempotencyKey = crypto.randomUUID();
    const recordSeedResult = value.store.recordSessionProviderSwitchSeedResult.bind(value.store);
    value.codex.endSessionError = new Error("simulated target cleanup failure");
    Object.defineProperty(value.store, "recordSessionProviderSwitchSeedResult", {
      configurable: true,
      value: () => { throw new Error("simulated seed-result receipt failure"); },
    });
    try {
      await expect(value.service.execute({
        account: targetAccountId,
        idempotencyKey,
        kind: "session.switch",
        provider: "codex",
        session: sessionId,
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    } finally {
      delete value.codex.endSessionError;
      Object.defineProperty(value.store, "recordSessionProviderSwitchSeedResult", {
        configurable: true,
        value: recordSeedResult,
      });
    }
    const readsBefore = value.codex.calls.filter((call) => call === "read").length;
    const endsBefore = value.codex.calls.filter((call) => call === "end-session").length;
    Object.defineProperty(value.codex, "readSession", {
      configurable: true,
      value: async () => {
        value.codex.calls.push("read");
        value.codex.accountProjection = {
          signedIn: true,
          email: "replacement@example.com",
        };
        throw new Error("simulated target read failure");
      },
    });

    const failure = await value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "IndeterminateLocalCommitError" });
    expect(value.codex.calls.filter((call) => call === "read")).toHaveLength(readsBefore + 1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(endsBefore);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
  });

  test("runs the forced target-account proof when post-switch observation fails", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Observation-race Codex target");
    const idempotencyKey = crypto.randomUUID();
    Object.defineProperty(value.codex, "observeSession", {
      configurable: true,
      value: async () => {
        value.codex.calls.push("observe");
        value.codex.accountProjection = {
          signedIn: true,
          email: "replacement@example.com",
        };
        throw new CodexSessionObservationError("resume_unavailable");
      },
    });

    const failure = await value.service.execute({
      account: targetAccountId,
      idempotencyKey,
      kind: "session.switch",
      provider: "codex",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "IndeterminateLocalCommitError" });
    expect(value.codex.calls.filter((call) => call === "observe")).toHaveLength(1);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: targetAccountId,
      provider: "codex",
      state: "recovery_required",
    });
  });

  test("retains a launch fence and never target-ends a resumed Claude controller without PID custody", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.claude.disconnectOnObserveRequest = 1;
    value.claude.omitProcessIdentityOnClaim = true;
    value.claude.beforeClaimSessionReturn = () => {
      value.claude.accountSignedIn = false;
    };

    const failure = await value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ name: "IndeterminateLocalCommitError" });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    expect(value.claude.claimRequests).toHaveLength(1);
    // The first end releases the exact process that failed observation. The
    // replacement claim omitted PID/start custody, so it must never receive a
    // thread-targeted end even though its account changed during the call.
    expect(value.claude.endedThreads).toHaveLength(1);
    const providerThreadId = value.claude.claimRequests[0]?.providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected the resumed Claude target id.");
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      profileId: accountId,
      providerAccountKey: expect.any(String),
      sessionId,
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "recovery_required",
    });
  });

  test("does not record target release when cleanup fails across an account change", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const endTarget = value.claude.endSession.bind(value.claude);
    const targetEndsBefore = value.claude.endedThreads.length;
    Object.defineProperty(value.claude, "endSession", {
      configurable: true,
      value: async (input: Parameters<ClaudeRuntimePort["endSession"]>[0]) => {
        await endTarget(input);
        value.claude.accountSignedIn = false;
        throw new Error("simulated cleanup response loss");
      },
    });

    const result = await value.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal }) as { session: { state: string } };
    expect(result.session.state).toBe("terminal");
    expect(value.claude.endedThreads).toHaveLength(targetEndsBefore + 1);
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected the ambiguous provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).targetReleased).toBe(false);
    expect(attempt).toMatchObject({
      resolution: { kind: "abandoned" },
      state: "reconciled",
    });
  });

  test("never reads or ends a legacy target that aliases the source and lacks an account key", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.codex.projection = {
      ...value.codex.projection,
      providerThreadId: "codex-thread-2",
    };
    const recordSeedIntent = value.store.recordSessionProviderSwitchSeedIntent.bind(value.store);
    value.codex.endSessionError = new Error("simulated target cleanup failure");
    Object.defineProperty(value.store, "recordSessionProviderSwitchSeedIntent", {
      configurable: true,
      value: () => { throw new Error("simulated seed-intent receipt failure"); },
    });
    try {
      await expect(value.service.execute({
        idempotencyKey,
        kind: "session.switch",
        preset: "low",
        provider: "codex",
        session: sessionId,
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    } finally {
      delete value.codex.endSessionError;
      Object.defineProperty(value.store, "recordSessionProviderSwitchSeedIntent", {
        configurable: true,
        value: recordSeedIntent,
      });
    }
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt?.evidence?.evidence.kind !== "session.switch") {
      throw new Error("Expected immutable provider-switch evidence.");
    }
    const direct = new Database(value.store.paths.database, { create: false, strict: true });
    try {
      direct.exec("DROP TRIGGER mutation_effect_evidence_immutable_update");
      direct.exec("DROP TRIGGER session_provider_switch_targets_immutable_update");
      const legacyEvidence = { ...attempt.evidence.evidence } as Record<string, unknown>;
      delete legacyEvidence.targetProviderAccountKey;
      const legacyEvidenceJson = JSON.stringify(legacyEvidence);
      const legacyEvidenceDigest = createHash("sha256").update(legacyEvidenceJson).digest("hex");
      direct.query(
        "UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=? WHERE attempt_id=?",
      ).run(legacyEvidenceJson, legacyEvidenceDigest, attempt.id);
      direct.query(
        "UPDATE session_provider_switch_targets SET provider_thread_id=? WHERE attempt_id=?",
      ).run("codex-thread-1", attempt.id);
    } finally {
      direct.close();
    }
    const readsBefore = value.codex.calls.filter((call) => call === "read").length;
    const endsBefore = value.codex.calls.filter((call) => call === "end-session").length;

    await expect(value.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).rejects.toThrow("SESSION_PROVIDER_SWITCH_TARGET_ALIASES_SOURCE");
    expect(value.codex.calls.filter((call) => call === "read")).toHaveLength(readsBefore);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(endsBefore);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
  });

  test("never reads or ends a distinct legacy target without durable account authority", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.codex.projection = {
      ...value.codex.projection,
      providerThreadId: "codex-thread-2",
    };
    const recordSeedIntent = value.store.recordSessionProviderSwitchSeedIntent.bind(value.store);
    value.codex.endSessionError = new Error("simulated target cleanup failure");
    Object.defineProperty(value.store, "recordSessionProviderSwitchSeedIntent", {
      configurable: true,
      value: () => { throw new Error("simulated seed-intent receipt failure"); },
    });
    try {
      await expect(value.service.execute({
        idempotencyKey,
        kind: "session.switch",
        preset: "low",
        provider: "codex",
        session: sessionId,
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    } finally {
      delete value.codex.endSessionError;
      Object.defineProperty(value.store, "recordSessionProviderSwitchSeedIntent", {
        configurable: true,
        value: recordSeedIntent,
      });
    }
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt?.evidence?.evidence.kind !== "session.switch") {
      throw new Error("Expected immutable provider-switch evidence.");
    }
    const direct = new Database(value.store.paths.database, { create: false, strict: true });
    try {
      direct.exec("DROP TRIGGER mutation_effect_evidence_immutable_update");
      const legacyEvidence = { ...attempt.evidence.evidence } as Record<string, unknown>;
      delete legacyEvidence.targetProviderAccountKey;
      const legacyEvidenceJson = JSON.stringify(legacyEvidence);
      const legacyEvidenceDigest = createHash("sha256").update(legacyEvidenceJson).digest("hex");
      direct.query(
        "UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=? WHERE attempt_id=?",
      ).run(legacyEvidenceJson, legacyEvidenceDigest, attempt.id);
    } finally {
      direct.close();
    }
    const readsBefore = value.codex.calls.filter((call) => call === "read").length;
    const endsBefore = value.codex.calls.filter((call) => call === "end-session").length;

    await expect(value.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      recovery: {
        providerStateDeleted: false,
        targetAddressable: true,
      },
      session: { state: "terminal" },
    });
    expect(value.codex.calls.filter((call) => call === "read")).toHaveLength(readsBefore);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(endsBefore);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
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
    expect(restarted.codex.calls).toEqual(["read", "read"]);
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
    const recordSeedResult = value.store.recordSessionProviderSwitchSeedResult.bind(value.store);
    const beginTargetRelease = value.store.beginClaudeProcessAuthorityRelease.bind(value.store);
    Object.defineProperty(value.store, "recordSessionProviderSwitchSeedResult", {
      configurable: true,
      value: () => { throw new Error("simulated seed-result receipt failure"); },
    });
    Object.defineProperty(value.store, "beginClaudeProcessAuthorityRelease", {
      configurable: true,
      value: () => { throw new Error("simulated target cleanup failure"); },
    });
    try {
      await expect(value.service.execute({
        idempotencyKey,
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    } finally {
      Object.defineProperty(value.store, "recordSessionProviderSwitchSeedResult", {
        configurable: true,
        value: recordSeedResult,
      });
      Object.defineProperty(value.store, "beginClaudeProcessAuthorityRelease", {
        configurable: true,
        value: beginTargetRelease,
      });
    }
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    const targetProviderThreadId = value.store
      .readSessionProviderSwitchProgress(attempt.id).targetProviderThreadId;
    if (targetProviderThreadId === undefined) throw new Error("Expected a Claude target receipt.");
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
    expect(value.claude.endedThreads).toEqual([targetProviderThreadId]);
    expect(value.codex.endedThreads).toEqual([]);
  });

  test("reports retained source state after cleaning an unseeded target", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    const targetProviderThreadId = value.store
      .readSessionProviderSwitchProgress(attempt.id).targetProviderThreadId;
    if (targetProviderThreadId === undefined) {
      throw new Error("Expected an exact provider-switch target receipt.");
    }

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
    expect(value.claude.endedThreads).toEqual([targetProviderThreadId]);
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

  test("leaves the switch effect unsettled after daemon authority is lost during target cleanup", async () => {
    let stale = false;
    const value = await fixture({
      assertCurrent: async () => {
        if (stale) throw new DaemonAuthoritySafetyError("simulated stale daemon authority");
      },
      close: () => {},
    });
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    const recordSeedIntent = value.store.recordSessionProviderSwitchSeedIntent.bind(value.store);
    const endTarget = value.claude.endSession.bind(value.claude);
    Object.defineProperty(value.store, "recordSessionProviderSwitchSeedIntent", {
      configurable: true,
      value: () => { throw new Error("simulated seed-intent receipt failure"); },
    });
    Object.defineProperty(value.claude, "endSession", {
      configurable: true,
      value: async (input: Parameters<ClaudeRuntimePort["endSession"]>[0]) => {
        await endTarget(input);
        stale = true;
      },
    });
    try {
      await expect(value.service.execute({
        idempotencyKey,
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    } finally {
      stale = false;
      Object.defineProperty(value.store, "recordSessionProviderSwitchSeedIntent", {
        configurable: true,
        value: recordSeedIntent,
      });
      Object.defineProperty(value.claude, "endSession", {
        configurable: true,
        value: endTarget,
      });
    }

    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "idle",
    });
  });

  test("does not settle a source release after its forced account proof loses daemon authority", async () => {
    let stale = false;
    const value = await fixture({
      assertCurrent: async () => {
        if (stale) throw new DaemonAuthoritySafetyError("simulated stale daemon authority");
      },
      close: () => {},
    });
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    const readAccount = value.codex.readAccount.bind(value.codex);
    Object.defineProperty(value.codex, "readAccount", {
      configurable: true,
      value: async () => {
        const account = await readAccount();
        if (value.codex.calls.includes("end-session")) stale = true;
        return account;
      },
    });
    try {
      await expect(value.service.execute({
        idempotencyKey,
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    } finally {
      stale = false;
      Object.defineProperty(value.codex, "readAccount", {
        configurable: true,
        value: readAccount,
      });
    }

    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "idle",
    });
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
        authentication: { provider: "claude", signedIn: true },
        login: { status: "signed_in" },
      },
      status: "fulfilled",
    });
    expect(value.store.readMutation(loginKey)).toBeNull();
    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: target.account.id,
      provider: "claude",
      state: "idle",
    });
    expect(value.claude.endedThreads).toEqual([]);
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
        authentication: { provider: "claude", signedIn: true },
        login: { status: "signed_in" },
      },
      status: "fulfilled",
    });
    expect(value.store.readMutation(loginKey)).toBeNull();
    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: target.account.id,
      provider: "claude",
      state: "idle",
    });
    expect(value.claude.endedThreads).toEqual([]);
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
    expect((replay as CommandFailure).code).toBe("CONFLICT");
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

  test("quarantines a same-provider preset switch when its target aliases the source thread", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const startsBefore = value.codex.calls.filter((call) => call === "start-session").length;
    const turnsBefore = value.codex.calls.filter((call) => call === "start-turn").length;

    await expect(value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      preset: "low",
      provider: "codex",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(value.codex.calls.filter((call) => call === "start-session"))
      .toHaveLength(startsBefore + 1);
    expect(value.codex.calls.filter((call) => call === "start-turn"))
      .toHaveLength(turnsBefore);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
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
