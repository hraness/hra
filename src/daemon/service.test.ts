import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexError,
  IndeterminateCodexEffectError,
  type CodexFact,
  type CodexPluginCatalog,
} from "../codex";
import { parseFact } from "../codex/protocol";
import {
  CloudDaemonJournalRecoveryBlocker,
  createCloudProjectionRecoveryTerminalReceipt,
  MemoryCloudDaemonJournal,
  transitionCloudProjectionRecovery,
  type CloudProjectionRecoveryJournalEntry,
} from "../cloud/daemon-journal";
import { renderSuccess } from "../cli/render";
import type { LocalCommand } from "../domain/contracts";
import { publicInteractionSchema, type PublicInteraction } from "../domain/interactions";
import type { Preset } from "../domain/presets";
import type { EffectiveRuntimeProfile } from "../domain/runtime-profile";
import { storedAccountUsageSnapshotSchema } from "../domain/usage-metrics";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { StateStore } from "../storage/state-store";
import { DaemonAuthoritySafetyError } from "./daemon-lock";
import { UnavailableCloudControl, type CloudControlPort, type CodexAccountProjection, type CodexLoginOutcome, type CodexRuntimePort, type CodexSessionProjection, type CompactProjectionRecoveryBlocker, type DesktopSwitchPort, type ProfileAuthority, type RuntimeStartReview } from "./ports";
import { HraService } from "./service";

const runtimeProfile = (authority: ProfileAuthority): EffectiveRuntimeProfile => ({
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: 2_000,
  preset: "high",
  model: "gpt-5.6-sol",
  reasoningEffort: "max",
  serviceTier: null,
  fast: false,
  approvalPolicy: "on-request",
  reviewMode: "auto_review",
  permissionProfile: ":workspace",
  computerUse: true,
  pluginCapability: true,
  enabledApps: [{ id: "app.files", name: "Files", pluginDisplayNames: ["Files"] }],
});

class FakeCodex implements CodexRuntimePort {
  readonly calls: string[] = [];
  readonly turnEffectTrace: string[] = [];
  beforeStartTurnEffect?: () => Promise<void>;
  beforeStartTurnReturn?: () => Promise<void>;
  beforeReadSessionReturn?: () => Promise<void>;
  readSessionErrorOnce?: Error;
  reviewTurnErrorOnce?: Error;
  beforeLogoutReturn?: () => Promise<void>;
  logoutError?: Error;
  startSessionError?: Error;
  startTurnError?: Error;
  startTurnErrorOnce?: Error;
  steerError?: Error;
  interruptError?: Error;
  renameError?: Error;
  beforeInterruptReturn?: () => Promise<void>;
  beforeRenameReturn?: () => Promise<void>;
  turnId = "turn-next";
  turnStatus: "completed" | "interrupted" | "failed" | "inProgress" = "inProgress";
  committedStartTurns = 0;
  activeStartTurns = 0;
  maximumConcurrentStartTurns = 0;
  runtimeProfileOverride?: EffectiveRuntimeProfile;
  closeCalls = 0;
  resolveInteractionError?: Error;
  validateInteractionResolutionError?: Error;
  validateInteractionTimeoutError?: Error;
  timeoutInteractionError?: Error;
  readonly validatedInteractions: Array<Parameters<CodexRuntimePort["validateInteractionResolution"]>[0]> = [];
  readonly resolvedInteractions: Array<Parameters<NonNullable<CodexRuntimePort["resolveInteraction"]>>[0]> = [];
  readonly validatedInteractionTimeouts: Array<Parameters<CodexRuntimePort["validateInteractionTimeout"]>[0]> = [];
  readonly timedOutInteractions: Array<Parameters<CodexRuntimePort["timeoutInteraction"]>[0]> = [];
  accountProjection: CodexAccountProjection = { signedIn: true, email: "person@example.com", plan: "Plus" };
  usageResult: { revision: number; observedAt: number; payload: unknown } = { revision: 1, observedAt: 2_000, payload: { primary: { usedPercent: 25 } } };
  usageError: Error | undefined;
  readonly pluginRequests: Array<Parameters<CodexRuntimePort["listPlugins"]>[0]> = [];
  pluginCatalog: CodexPluginCatalog = {
    marketplaces: [{
      name: "official",
      displayName: "Official",
      plugins: [{
        id: "files@official",
        name: "files",
        displayName: "Files",
        shortDescription: "Search connected files",
        developerName: "OpenAI",
        category: "productivity",
        capabilities: ["search"],
        keywords: ["files"],
        version: "1.0.0",
        localVersion: null,
        sourceType: "remote",
        installed: false,
        enabled: false,
        installPolicy: "AVAILABLE",
        authPolicy: "ON_USE",
        availability: "AVAILABLE",
        disabledReason: null,
        eligiblePlanTypes: ["plus"],
      }],
    }],
    featuredPluginIds: ["files@official"],
    marketplaceLoadErrorCount: 0,
    lifecycle: {
      discovery: "available",
      install: "blocked_compound_upstream_effect",
      enablement: "no_separate_pinned_method",
      oauth: "separate_foreground_only",
    },
  };
  readProjection: CodexSessionProjection = { providerThreadId: "provider-thread", title: "New session", status: "idle", providerUpdatedAt: 10, messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }] };
  listedProjections: readonly CodexSessionProjection[] = [];
  loginResult: CodexLoginOutcome = { status: "signed_in", account: { signedIn: true, email: "person@example.com", plan: "Plus" } };
  cancelLoginResult: { status: "canceled" | "not_found" } = { status: "canceled" };
  async login(input: { authority: ProfileAuthority; method: "browser" | "device_code" }): Promise<CodexLoginOutcome> { this.calls.push(`login:${input.authority.id}:${input.authority.generation}:${input.method}`); return this.loginResult; }
  async cancelLogin(input: { authority: ProfileAuthority; loginId: string }): Promise<{ status: "canceled" | "not_found" }> { this.calls.push(`login-cancel:${input.authority.id}:${input.authority.generation}:${input.loginId}`); return this.cancelLoginResult; }
  async logout(): Promise<void> { this.calls.push("logout"); await this.beforeLogoutReturn?.(); if (this.logoutError !== undefined) throw this.logoutError; }
  async readAccount(): Promise<CodexAccountProjection> { this.calls.push("readAccount"); return this.accountProjection; }
  async listPlugins(input: Parameters<CodexRuntimePort["listPlugins"]>[0]): Promise<CodexPluginCatalog> {
    this.calls.push("plugins");
    this.pluginRequests.push(input);
    return this.pluginCatalog;
  }
  async readUsage(): Promise<{ revision: number; observedAt: number; payload: unknown }> {
    this.calls.push("usage");
    if (this.usageError !== undefined) throw this.usageError;
    return this.usageResult;
  }
  async listSessions(): Promise<readonly CodexSessionProjection[]> { this.calls.push("list"); return this.listedProjections; }
  async reviewSessionStart(input: { authority: ProfileAuthority; preset: Preset; fast: boolean }): Promise<RuntimeStartReview> {
    const base = runtimeProfile(input.authority);
    const effectiveRuntimeProfile = this.runtimeProfileOverride ?? {
      ...base,
      preset: input.preset,
      fast: input.fast,
      serviceTier: input.fast ? "priority" as const : null,
      model: input.preset === "low" ? "gpt-5.6-luna" : "gpt-5.6-sol",
      reasoningEffort: input.preset === "ultra" ? "ultra" as const : "max" as const,
    };
    return { reviewId: crypto.randomUUID(), kind: "session_start", effectiveRuntimeProfile };
  }
  async startSession(input: { review: RuntimeStartReview }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    this.calls.push(`start:${input.review.effectiveRuntimeProfile.preset}`);
    if (this.startSessionError !== undefined) throw this.startSessionError;
    this.readProjection = {
      providerThreadId: "provider-thread",
      title: "New session",
      status: "idle",
      providerUpdatedAt: 10,
    };
    return { ...this.readProjection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async readSession(): Promise<CodexSessionProjection> {
    this.calls.push("read");
    this.turnEffectTrace.push("read");
    const error = this.readSessionErrorOnce;
    delete this.readSessionErrorOnce;
    if (error !== undefined) throw error;
    await this.beforeReadSessionReturn?.();
    return this.readProjection;
  }
  async reviewTurnStart(input: { authority: ProfileAuthority; preset: Preset; fast: boolean }): Promise<RuntimeStartReview> {
    this.turnEffectTrace.push("review");
    const error = this.reviewTurnErrorOnce;
    delete this.reviewTurnErrorOnce;
    if (error !== undefined) throw error;
    const base = runtimeProfile(input.authority);
    const effectiveRuntimeProfile = this.runtimeProfileOverride ?? {
      ...base,
      preset: input.preset,
      fast: input.fast,
      serviceTier: input.fast ? "priority" as const : null,
      model: input.preset === "low" ? "gpt-5.6-luna" : "gpt-5.6-sol",
      reasoningEffort: input.preset === "ultra" ? "ultra" as const : "max" as const,
    };
    return { reviewId: crypto.randomUUID(), kind: "turn_start", effectiveRuntimeProfile };
  }
  async startTurn(input: { review: RuntimeStartReview; message: string; clientMessageId: string }): Promise<{ turnId: string; status: "completed" | "interrupted" | "failed" | "inProgress"; effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    this.calls.push("send");
    this.turnEffectTrace.push("start");
    this.activeStartTurns += 1;
    this.maximumConcurrentStartTurns = Math.max(this.maximumConcurrentStartTurns, this.activeStartTurns);
    const oneShotError = this.startTurnErrorOnce;
    delete this.startTurnErrorOnce;
    try {
      await this.beforeStartTurnEffect?.();
      if (oneShotError !== undefined) throw oneShotError;
      const turnId = this.committedStartTurns === 0
        ? this.turnId
        : `${this.turnId}-${String(this.committedStartTurns + 1)}`;
      this.committedStartTurns += 1;
      const turnStatus = this.turnStatus;
      const updatedAt = (this.readProjection.providerUpdatedAt ?? 10) + 1;
      this.readProjection = { ...this.readProjection, status: turnStatus === "inProgress" ? "active" : "idle", ...(turnStatus === "inProgress" ? { activeTurnId: turnId } : {}), providerUpdatedAt: updatedAt, messages: [...(this.readProjection.messages ?? []), { role: "user", text: input.message, turnId, clientId: input.clientMessageId }], turnSummaries: [...(this.readProjection.turnSummaries ?? []), { id: turnId, status: turnStatus, files: [], actions: [], omittedFiles: 0, omittedActions: 0 }] };
      if (turnStatus !== "inProgress") delete (this.readProjection as { activeTurnId?: string }).activeTurnId;
      await this.beforeStartTurnReturn?.();
      if (this.startTurnError !== undefined) throw this.startTurnError;
      return { turnId, status: turnStatus, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
    } finally {
      this.activeStartTurns -= 1;
    }
  }
  async steer(input: { activeTurnId: string; message: string; clientMessageId: string }): Promise<void> {
    this.calls.push("steer");
    this.readProjection = { ...this.readProjection, status: "active", activeTurnId: input.activeTurnId, providerUpdatedAt: (this.readProjection.providerUpdatedAt ?? 10) + 1, messages: [...(this.readProjection.messages ?? []), { role: "user", text: input.message, turnId: input.activeTurnId, clientId: input.clientMessageId }] };
    if (this.steerError !== undefined) throw this.steerError;
  }
  async interrupt(input: { activeTurnId: string }): Promise<void> {
    this.calls.push("stop");
    this.readProjection = { ...this.readProjection, status: "idle", providerUpdatedAt: (this.readProjection.providerUpdatedAt ?? 10) + 1, turnSummaries: (this.readProjection.turnSummaries ?? []).map((turn) => turn.id === input.activeTurnId ? { ...turn, status: "interrupted" } : turn) };
    delete (this.readProjection as { activeTurnId?: string }).activeTurnId;
    await this.beforeInterruptReturn?.();
    if (this.interruptError !== undefined) throw this.interruptError;
  }
  async rename(input: { name: string }): Promise<void> {
    this.calls.push("rename");
    this.readProjection = { ...this.readProjection, title: input.name, providerUpdatedAt: (this.readProjection.providerUpdatedAt ?? 10) + 1 };
    await this.beforeRenameReturn?.();
    if (this.renameError !== undefined) throw this.renameError;
  }
  async inspectTurn(): Promise<unknown> { return { id: "turn-next", runtimeMs: 123 }; }
  async resolveInteraction(
    input: Parameters<NonNullable<CodexRuntimePort["resolveInteraction"]>>[0],
  ): Promise<{ responseWritten: true }> {
    this.resolvedInteractions.push(input);
    if (this.resolveInteractionError !== undefined) throw this.resolveInteractionError;
    return { responseWritten: true };
  }
  async validateInteractionResolution(
    input: Parameters<CodexRuntimePort["validateInteractionResolution"]>[0],
  ): Promise<{ responseDigest: string }> {
    this.validatedInteractions.push(input);
    if (this.validateInteractionResolutionError !== undefined) {
      throw this.validateInteractionResolutionError;
    }
    return { responseDigest: createHash("sha256").update(JSON.stringify(input.resolution)).digest("hex") };
  }
  async validateInteractionTimeout(
    input: Parameters<CodexRuntimePort["validateInteractionTimeout"]>[0],
  ): Promise<{ responseDigest: string }> {
    this.validatedInteractionTimeouts.push(input);
    if (this.validateInteractionTimeoutError !== undefined) throw this.validateInteractionTimeoutError;
    return { responseDigest: "e".repeat(64) };
  }
  async timeoutInteraction(
    input: Parameters<CodexRuntimePort["timeoutInteraction"]>[0],
  ): Promise<{ responseWritten: true }> {
    this.timedOutInteractions.push(input);
    if (this.timeoutInteractionError !== undefined) throw this.timeoutInteractionError;
    return { responseWritten: true };
  }
  async close(): Promise<void> { this.closeCalls += 1; }
}

class FakeDaemonAuthority {
  current = true;
  closeCalls = 0;
  beforeAssert?: () => Promise<void>;

  async assertCurrent(): Promise<void> {
    await this.beforeAssert?.();
    if (!this.current) throw new DaemonAuthoritySafetyError("The fake daemon authority is stale.");
  }

  close(): void {
    this.closeCalls += 1;
    this.current = false;
  }

  invalidate(): void {
    this.current = false;
  }
}

class FakeCloud implements CloudControlPort {
  readonly projectionRecoveries: Array<{
    acknowledgeGap: true;
    idempotencyKey: string;
    sessionPublicId: `sess_${string}`;
    signal: AbortSignal;
  }> = [];
  beforeProjectionRecoveryReturn?: () => Promise<void>;
  projectionRecoveryResult: unknown = { phase: "applied", compactStreamEpoch: 1 };
  projectionRecoveryBlocker?: CompactProjectionRecoveryBlocker;
  readonly unsettledProjectionProfiles = new Set<string>();
  readonly unsettledProjectionSessions = new Set<string>();
  readonly providerDeletionSupersessions: string[] = [];
  readonly providerDeletionSupersededSessions = new Set<string>();
  authResult: unknown = { requested: true };
  deleteAccountResult: unknown = {
    daemonRestartRequired: true,
    deletion: { effectsDisabled: true, state: "pending", statusFresh: true },
  };
  deleteAccountCalls = 0;
  statusError?: unknown;
  async status(): Promise<unknown> {
    if (this.statusError !== undefined) {
      throw this.statusError instanceof Error
        ? this.statusError
        : new Error("Fake cloud status failed.");
    }
    return { configured: true };
  }
  async sync(): Promise<unknown> { return { synced: true }; }
  async isCompactProjectionRecoveryUnsettled(sessionPublicId: `sess_${string}`): Promise<boolean> {
    return this.projectionRecoveryBlocker === undefined
      ? this.unsettledProjectionSessions.has(sessionPublicId)
      : await this.projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettled(sessionPublicId);
  }
  async isCompactProjectionRecoveryUnsettledForProfile(
    profileId: Parameters<CloudControlPort["isCompactProjectionRecoveryUnsettledForProfile"]>[0],
  ): Promise<boolean> {
    return this.projectionRecoveryBlocker === undefined
      ? this.unsettledProjectionProfiles.has(profileId)
      : await this.projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettledForProfile(profileId);
  }
  async recoverCompactProjection(input: { sessionPublicId: `sess_${string}`; idempotencyKey: string; acknowledgeGap: true; signal: AbortSignal }): Promise<unknown> {
    this.projectionRecoveries.push(input);
    await this.beforeProjectionRecoveryReturn?.();
    if (this.providerDeletionSupersededSessions.has(input.sessionPublicId)) {
      return {
        idempotencyKey: input.idempotencyKey,
        phase: "rejected",
        rejectionCode: "PROVIDER_THREAD_DELETED",
        sessionPublicId: input.sessionPublicId,
      };
    }
    return this.projectionRecoveryResult;
  }
  async supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: `sess_${string}`,
  ): Promise<{ superseded: boolean }> {
    this.providerDeletionSupersessions.push(sessionPublicId);
    this.providerDeletionSupersededSessions.add(sessionPublicId);
    this.unsettledProjectionSessions.delete(sessionPublicId);
    return this.projectionRecoveryBlocker === undefined
      ? { superseded: true }
      : await this.projectionRecoveryBlocker
        .supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId);
  }
  async supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    return this.projectionRecoveryBlocker === undefined
      ? { superseded: 0 }
      : await this.projectionRecoveryBlocker.supersedeTerminalCompactProjectionRecoveries();
  }
  async auth(): Promise<unknown> { return this.authResult; }
  async logout(): Promise<void> {}
  async deleteAccount(): Promise<unknown> {
    this.deleteAccountCalls += 1;
    return this.deleteAccountResult;
  }
  async listDevices(): Promise<unknown> { return { devices: [] }; }
  async pairDevice(): Promise<unknown> { return { pending: true }; }
  async approveDevice(): Promise<unknown> { return { approved: true }; }
  async revokeDevice(): Promise<unknown> { return { revoked: true }; }
}

class FakeDesktop implements DesktopSwitchPort {
  readonly calls: string[] = [];
  recovery: unknown = {
    status: "resolved_not_applied",
    idempotencyKey: "00000000-0000-4000-8000-000000000601",
    switchGeneration: 1,
    targetProfileId: "acct_00000000000000000000000000000000",
    diagnostic: "ZERO_EXACT_PROCESSES",
    observationDigest: "a".repeat(64),
    resolvedAt: 2_000,
  };
  current: unknown = { status: "none" };
  currentError?: unknown;

  async switchAccount(input: { idempotencyKey: string }): Promise<{ status: "applied"; idempotencyKey: string }> {
    this.calls.push("switch");
    return { status: "applied", idempotencyKey: input.idempotencyKey };
  }

  async recoverSwitch(): Promise<unknown> {
    this.calls.push("recover");
    return this.recovery;
  }

  currentRecovery(): unknown {
    this.calls.push("current");
    if (this.currentError !== undefined) {
      throw this.currentError instanceof Error
        ? this.currentError
        : new Error("Fake desktop recovery failed.");
    }
    return this.current;
  }
}

const stores: StateStore[] = [];
const serviceRoots: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(serviceRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

async function fixture(
  desktop?: DesktopSwitchPort,
  cloud = new FakeCloud(),
  requestStop: () => void = () => undefined,
  now: () => number = Date.now,
): Promise<{ service: HraService; store: StateStore; codex: FakeCodex; cloud: FakeCloud; daemonAuthority: FakeDaemonAuthority; documents: string; paths: ReturnType<typeof resolveStatePaths> }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-service-")));
  serviceRoots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  const documents = join(home, "Documents");
  await mkdir(documents, { recursive: true });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now });
  stores.push(store);
  const codex = new FakeCodex();
  const daemonAuthority = new FakeDaemonAuthority();
  return { service: new HraService({ store, paths, codex, cloud, daemonAuthority, ...(desktop === undefined ? {} : { desktop }), now, requestStop }), store, codex, cloud, daemonAuthority, documents, paths };
}

async function createIdleSession(
  value: Awaited<ReturnType<typeof fixture>>,
  label: string,
): Promise<{ sessionId: `sess_${string}` }> {
  const added = await value.service.execute({ kind: "account.add", label }, { signal }) as { account: { id: string } };
  await value.service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
  await value.service.execute({ kind: "project.add", label: `${label} docs`, path: value.documents }, { signal });
  const started = await value.service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
  return { sessionId: started.session.id };
}

const providerMutationCalls = (codex: FakeCodex): readonly string[] => codex.calls.filter(
  (call) => call.startsWith("login:") || call.startsWith("start:") || call === "logout" || call === "send" || call === "steer" || call === "stop" || call === "rename",
);

const signal = new AbortController().signal;

const renderHuman = (command: LocalCommand, data: unknown): string => {
  let stdout = "";
  renderSuccess(command, data, false, {
    writeStdout: (value) => { stdout += value; },
    writeStderr: () => undefined,
  });
  return stdout;
};

const renderJson = (command: LocalCommand, data: unknown): string => {
  let stdout = "";
  renderSuccess(command, data, true, {
    writeStdout: (value) => { stdout += value; },
    writeStderr: () => undefined,
  });
  return stdout;
};

describe("HraService", () => {
  test("defers identity-switch and account-erasure shutdown until after the response boundary", async () => {
    const cloud = new FakeCloud();
    let stopCalls = 0;
    const { service, store } = await fixture(undefined, cloud, () => { stopCalls += 1; });
    const afterResponse: Array<() => void> = [];

    cloud.authResult = { daemonRestartRequired: true, signedIn: true };
    const auth = await service.execute({
      code: "12345678",
      email: "person@example.com",
      kind: "auth.login",
    }, {
      afterResponse: (callback) => { afterResponse.push(callback); },
      signal,
    });
    expect(auth).toMatchObject({ daemonRestartRequired: true });
    expect(stopCalls).toBe(0);
    expect(afterResponse).toHaveLength(1);
    afterResponse.shift()?.();
    expect(stopCalls).toBe(1);

    const localAccountsBefore = store.listProfiles().length;
    const localSessionsBefore = store.listSessions().length;
    const deletion = await service.execute({
      acknowledgeErasure: true,
      kind: "auth.delete",
    }, {
      afterResponse: (callback) => { afterResponse.push(callback); },
      signal,
    });
    expect(deletion).toMatchObject({
      daemonRestartRequired: true,
      deletion: { effectsDisabled: true, state: "pending" },
    });
    expect(cloud.deleteAccountCalls).toBe(1);
    expect(store.listProfiles()).toHaveLength(localAccountsBefore);
    expect(store.listSessions()).toHaveLength(localSessionsBefore);
    expect(stopCalls).toBe(1);
    expect(afterResponse).toHaveLength(1);
    afterResponse.shift()?.();
    expect(stopCalls).toBe(2);
  });

  test("delegates desktop recovery and projects the exact doctor action", async () => {
    const desktop = new FakeDesktop();
    desktop.current = {
      status: "recovery_required",
      idempotencyKey: "00000000-0000-4000-8000-000000000601",
      switchGeneration: 1,
      targetProfileId: "acct_00000000000000000000000000000000",
      diagnostic: "PROCESS_SET_CHANGED",
      action: "hra account switch-recover",
    };
    const { service } = await fixture(desktop);

    expect(await service.execute({ kind: "account.switch-recover" }, { signal })).toBe(desktop.recovery);
    const doctor = await service.execute({ kind: "doctor", offline: true }, { signal }) as {
      desktop: { recovery: unknown };
      problems: string[];
    };
    expect(desktop.calls).toEqual(["recover", "current"]);
    expect(doctor.desktop.recovery).toBe(desktop.current);
    expect(doctor.problems).toContain("A desktop switch is unresolved. Run `hra account switch-recover`.");
  });

  test("doctor closes dependency failures without repeating arbitrary runtime diagnostics", async () => {
    const privatePath = ["", "Users", "operator", "private"].join("/");
    const secret = `sk-live-secret ${privatePath}\u001b[31m`;
    const cloud = new FakeCloud();
    cloud.statusError = new Error(secret);
    const desktop = new FakeDesktop();
    desktop.currentError = new Error(secret);
    const { service } = await fixture(desktop, cloud);

    const doctor = await service.execute({ kind: "doctor", offline: false }, { signal });
    const serialized = JSON.stringify(doctor);
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain("\u001b");
    expect(doctor).toMatchObject({
      cloud: {
        diagnostic: "Cloud status failed without exposing its runtime diagnostic.",
        status: "unavailable",
      },
      desktop: {
        recovery: {
          diagnostic: "Desktop switch recovery failed without exposing its runtime diagnostic.",
          status: "invalid",
        },
      },
    });
  });

  test("creates and signs in an isolated account generation", async () => {
    const { service, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Personal" }, { signal }) as { account: { id: string } };
    const result = await service.execute({ kind: "account.login", account: added.account.id, deviceCode: true }, { signal }) as { account: { state: string; processGeneration: number } };
    expect(result.account).toMatchObject({ state: "signed_in", processGeneration: 1 });
    expect(codex.calls[0]).toContain(":1:device_code");
  });

  test("lists and selects plugins through the read-only account and project boundary", async () => {
    const { service, codex, documents } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Plugin account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await expect(service.execute({
      account: added.account.id,
      kind: "plugin.list",
      refresh: false,
    }, { signal })).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    expect(codex.pluginRequests).toHaveLength(0);

    await service.execute({
      account: added.account.id,
      deviceCode: false,
      kind: "account.login",
    }, { signal });
    const project = await service.execute({
      kind: "project.add",
      label: "Release",
      path: documents,
    }, { signal }) as { project: { id: string } };

    const listed = await service.execute({
      account: added.account.id,
      kind: "plugin.list",
      project: project.project.id,
      refresh: true,
    }, { signal });
    expect(listed).toMatchObject({
      account: { id: added.account.id, state: "signed_in" },
      catalog: {
        marketplaces: [{ plugins: [{ id: "files@official" }] }],
        lifecycle: {
          discovery: "available",
          install: "blocked_compound_upstream_effect",
          enablement: "no_separate_pinned_method",
          oauth: "separate_foreground_only",
        },
      },
    });
    expect(codex.pluginRequests[0]).toMatchObject({
      authority: { id: added.account.id, generation: 1 },
      forceRefetch: true,
      projectRoot: documents,
    });

    const selected = await service.execute({
      account: added.account.id,
      kind: "plugin.show",
      plugin: "Files",
      refresh: false,
    }, { signal });
    expect(selected).toMatchObject({
      marketplace: { name: "official" },
      plugin: { id: "files@official", displayName: "Files" },
      lifecycle: { install: "blocked_compound_upstream_effect" },
    });
    expect(codex.pluginRequests[1]).toMatchObject({
      forceRefetch: false,
    });
    expect(codex.pluginRequests[1]).not.toHaveProperty("projectRoot");

    const official = codex.pluginCatalog.marketplaces[0];
    const files = official?.plugins[0];
    if (official === undefined || files === undefined) throw new Error("Plugin fixture is incomplete.");
    codex.pluginCatalog = {
      ...codex.pluginCatalog,
      marketplaces: [
        official,
        {
          displayName: "Community",
          name: "community",
          plugins: [{ ...files, id: "files-search@community", name: "files-search" }],
        },
      ],
    };
    await expect(service.execute({
      account: added.account.id,
      kind: "plugin.show",
      plugin: "Files",
      refresh: false,
    }, { signal })).rejects.toMatchObject({ code: "AMBIGUOUS" });
    await expect(service.execute({
      account: added.account.id,
      kind: "plugin.show",
      plugin: "files@official",
      refresh: false,
    }, { signal })).resolves.toMatchObject({ plugin: { id: "files@official" } });
  });

  test("starts, reads, queues, steers, stops, and annotates a session", async () => {
    const { service, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Work" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: true }, { signal }) as { session: { id: `sess_${string}` }; effectiveRuntimeProfile: EffectiveRuntimeProfile };
    expect(started.effectiveRuntimeProfile).toMatchObject({ reviewMode: "auto_review", computerUse: true, enabledApps: [{ id: "app.files" }] });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 1, sourceKind: "session_start", profile: started.effectiveRuntimeProfile });
    await service.execute({ kind: "session.send", session: started.session.id, message: "hello" }, { signal });
    expect(await service.execute({ kind: "session.show", session: started.session.id, detail: false }, { signal })).toMatchObject({ projection: { status: "active", messages: [{ role: "user" }] }, effectiveRuntimeProfile: started.effectiveRuntimeProfile });
    expect(await service.execute({ kind: "session.queue", session: started.session.id, message: "later" }, { signal })).toMatchObject({ queued: { state: "pending" } });
    expect(await service.execute({ kind: "session.steer", session: started.session.id, message: "focus" }, { signal })).toMatchObject({ steered: true });
    expect(await service.execute({ kind: "session.stop", session: started.session.id }, { signal })).toMatchObject({ stopped: true });
    expect(await service.execute({ kind: "session.note.set", session: started.session.id, note: "One note" }, { signal })).toMatchObject({ session: { note: "One note" } });
    expect(await service.execute({ kind: "session.rename", session: started.session.id, name: "Release" }, { signal })).toMatchObject({ session: { title: "Release" } });
  });

  test("refreshes usage without treating missing data as zero", async () => {
    const { service } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Usage" }, { signal }) as { account: { id: string } };
    const before = await service.execute({ kind: "account.usage", account: added.account.id, refresh: false }, { signal });
    expect(before).toMatchObject({ usage: [{ snapshot: null }] });
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const after = await service.execute({ kind: "account.usage", account: added.account.id, refresh: true }, { signal });
    expect(after).toMatchObject({ usage: [{ snapshot: { payload: { primary: { usedPercent: 25 } } } }] });
  });

  test("allocates durable usage authority and returns an observed trailing velocity", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Velocity" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const through = Date.now();
    const payload = (lifetimeTokens: number) => ({
      usage: { summary: { lifetimeTokens } },
      rateLimits: { primary: null, byLimitId: null },
    });
    codex.usageResult = { revision: 99, observedAt: through - 60_000, payload: payload(100) };
    await service.execute({ kind: "account.usage", account: added.account.id, refresh: true }, { signal });
    codex.usageResult = { revision: 99, observedAt: through, payload: payload(220) };
    const response = await service.execute({ kind: "account.usage", account: added.account.id, refresh: true }, { signal });
    const ledger = store.usageRange({ profileId: added.account.id });
    expect(ledger.map((entry) => entry.sourceRevision)).toEqual([1, 2]);
    expect(storedAccountUsageSnapshotSchema.parse(ledger[1]?.payload).observation)
      .toMatchObject({ sourceSequence: 2, lifetimeTokens: 220, gapBefore: false });
    expect(response).toMatchObject({
      usage: [{
        snapshot: { sourceRevision: 2, payload: payload(220) },
        velocity: {
          "1m": {
            available: true,
            counterDelta: 120,
            elapsedMs: 60_000,
            tokensPerMinute: 120,
          },
        },
      }],
    });
  });

  test("records a path-free historical usage failure without inventing a zero snapshot", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Usage failure" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    codex.usageError = new Error("provider failure at /private/secret with token=do-not-store");
    await expect(service.execute(
      { kind: "account.usage", account: added.account.id, refresh: true },
      { signal },
    )).rejects.toThrow("provider failure");

    expect(store.latestUsage(added.account.id)).toBeNull();
    expect(store.latestUsagePollFailure(added.account.id)).toMatchObject({
      reasonCode: "account_usage_read_failed",
      sourceRevision: 1,
    });
    expect(JSON.stringify(store.latestUsagePollFailure(added.account.id))).not.toContain("secret");
    const status = await service.execute(
      { kind: "account.usage", account: added.account.id, refresh: false },
      { signal },
    );
    expect(status).toMatchObject({
      usage: [{
        poll: {
          reasonCode: "account_usage_read_failed",
          sourceRevision: 1,
          state: "failed",
        },
        snapshot: null,
      }],
    });

    codex.usageError = undefined;
    codex.usageResult = { observedAt: Date.now(), payload: { primary: { usedPercent: 31 } }, revision: 2 };
    const recovered = await service.execute(
      { kind: "account.usage", account: added.account.id, refresh: true },
      { signal },
    );
    expect(recovered).toMatchObject({
      usage: [{ poll: { sourceRevision: 2, state: "observed" } }],
    });
  });

  test("accepts provider notifications that arrive before mutation responses", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Race" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: string; providerThreadId: string } };
    const authority = { id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" };
    codex.beforeStartTurnReturn = async () => service.observeCodexFact(authority, { type: "turnStarted", threadId: started.session.providerThreadId, turn: { id: "turn-next", items: [], status: "inProgress", startedAt: 1, completedAt: null, durationMs: null } });
    expect(await service.execute({ kind: "session.send", session: started.session.id, message: "race" }, { signal })).toMatchObject({ session: { state: "active", activeTurnId: "turn-next" } });
    expect(store.latestSessionRuntimeProfile(started.session.id as `sess_${string}`)).toMatchObject({ revision: 2, sourceKind: "turn_start" });
    codex.beforeInterruptReturn = async () => service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "turn-next", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
    expect(await service.execute({ kind: "session.stop", session: started.session.id }, { signal })).toMatchObject({ session: { state: "idle" } });
    codex.beforeRenameReturn = async () => service.observeCodexFact(authority, { type: "threadNameUpdated", threadId: started.session.providerThreadId, name: "Raced name" });
    expect(await service.execute({ kind: "session.rename", session: started.session.id, name: "Raced name" }, { signal })).toMatchObject({ session: { title: "Raced name" } });
  });

  test("refreshes the exact turn profile after the provider baseline and immediately before dispatch", async () => {
    const { service, codex, documents } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Review order" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };

    codex.turnEffectTrace.length = 0;
    await service.execute({ kind: "session.send", session: started.session.id, message: "active" }, { signal });
    expect(codex.turnEffectTrace).toEqual(["read", "review", "start"]);

    await service.execute({ kind: "session.queue", session: started.session.id, message: "queued" }, { signal });
    codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
    delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
    codex.turnEffectTrace.length = 0;
    await service.observeCodexFact(
      { id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" },
      { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "active-turn", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } },
    );
    await service.settled();
    expect(codex.turnEffectTrace).toEqual(["read", "review", "start"]);
  });

  test("serializes concurrent note and Fast metadata behind a provider-applied turn receipt", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Metadata race" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    let note: Promise<unknown> | undefined;
    let fast: Promise<unknown> | undefined;
    codex.beforeStartTurnReturn = async () => {
      delete codex.beforeStartTurnReturn;
      note = service.execute({ kind: "session.note.set", session: started.session.id, note: "Concurrent note" }, { signal });
      fast = service.execute({ kind: "session.fast", session: started.session.id, enabled: true }, { signal });
      await Bun.sleep(0);
    };
    const key = "00000000-0000-4000-8000-000000000119";

    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "provider applies first", idempotencyKey: key }, { signal })).resolves.toMatchObject({ session: { state: "active" } });
    if (note === undefined || fast === undefined) throw new Error("Concurrent metadata commands were not admitted.");
    await Promise.all([note, fast]);

    expect(store.readMutation(key)).toMatchObject({ state: "applied" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", note: "Concurrent note", fastEnabled: true });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 2, sourceKind: "turn_start" });
  });

  test("holds send and metadata behind the full projection recovery fence without a provider mutation", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Projection serialization");
    const recoverySession = value.store.requireSession(sessionId);
    const recoveryProfile = value.store.requireProfileById(recoverySession.profileId);
    if (recoverySession.providerThreadId === undefined) throw new Error("Expected a bound recovery session.");
    const providerWritesBefore = providerMutationCalls(value.codex);
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { release = resolve; });
    cloud.beforeProjectionRecoveryReturn = async () => {
      await value.service.observeCodexFact({
        codexHome: "unused",
        desktopUserData: "unused",
        generation: recoveryProfile.processGeneration,
        id: recoveryProfile.id,
      }, {
        name: "must not cross the recovery fence",
        threadId: recoverySession.providerThreadId as string,
        type: "threadNameUpdated",
      });
      await value.service.observeCodexAccount({
        codexHome: "unused",
        desktopUserData: "unused",
        generation: recoveryProfile.processGeneration,
        id: recoveryProfile.id,
      }, { signedIn: false });
      entered();
      await recoveryGate;
    };
    const recoveryKey = "00000000-0000-4000-8000-000000000801";
    const recovery = value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: recoveryKey,
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal });
    await recoveryEntered;

    let sendSettled = false;
    const send = value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000802",
      kind: "session.send",
      message: "after recovery",
      session: sessionId,
    }, { signal }).finally(() => { sendSettled = true; });
    let metadataSettled = false;
    const metadata = value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000803",
      kind: "session.note.set",
      note: "after recovery",
      session: sessionId,
    }, { signal }).finally(() => { metadataSettled = true; });
    await Bun.sleep(5);

    expect(sendSettled).toBe(false);
    expect(metadataSettled).toBe(false);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      note: "",
      title: recoverySession.title,
    });
    expect(value.store.requireProfileById(recoveryProfile.id).state).toBe("signed_in");
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    expect(cloud.projectionRecoveries).toHaveLength(1);
    expect(cloud.projectionRecoveries[0]).toMatchObject({
      acknowledgeGap: true,
      idempotencyKey: recoveryKey,
      sessionPublicId: sessionId,
    });

    release();
    await expect(recovery).resolves.toBe(cloud.projectionRecoveryResult);
    await Promise.all([send, metadata]);
    expect(value.store.requireSession(sessionId).note).toBe("after recovery");
    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });

  test("routes same-key projection recovery replay through the same closed cloud seam", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Projection replay");
    const providerWritesBefore = providerMutationCalls(value.codex);
    const command = {
      acknowledgeGap: true as const,
      idempotencyKey: "00000000-0000-4000-8000-000000000809",
      kind: "sync.projection-recover" as const,
      session: sessionId,
    };

    expect(await value.service.execute(command, { signal })).toBe(cloud.projectionRecoveryResult);
    expect(await value.service.execute(command, { signal })).toBe(cloud.projectionRecoveryResult);
    expect(cloud.projectionRecoveries.map(({ acknowledgeGap, idempotencyKey, sessionPublicId }) => ({
      acknowledgeGap,
      idempotencyKey,
      sessionPublicId,
    }))).toEqual([
      { acknowledgeGap: true, idempotencyKey: command.idempotencyKey, sessionPublicId: sessionId },
      { acknowledgeGap: true, idempotencyKey: command.idempotencyKey, sessionPublicId: sessionId },
    ]);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });

  test("durably blocks provider and metadata mutations until an unsettled recovery resolves", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Projection durable block");
    const sessionBefore = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(sessionBefore.profileId);
    cloud.unsettledProjectionSessions.add(sessionId);
    cloud.unsettledProjectionProfiles.add(profile.id);
    const providerWritesBefore = providerMutationCalls(value.codex);

    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000810",
      kind: "session.send",
      message: "must remain blocked",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({
      kind: "session.fast",
      enabled: true,
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    expect(value.store.requireSession(sessionId).fastEnabled).toBe(false);
    await expect(value.service.execute({
      detail: false,
      kind: "session.show",
      session: sessionId,
    }, { signal })).resolves.toBeDefined();
    await expect(value.service.execute({
      account: profile.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000812",
      kind: "account.logout",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    value.codex.accountProjection = { signedIn: false };
    await expect(value.service.execute({
      account: profile.id,
      kind: "account.show",
    }, { signal })).resolves.toMatchObject({ recovery: { cleared: false, required: true } });
    expect(value.store.requireProfileById(profile.id).state).toBe("signed_in");
    value.codex.listedProjections = [{
      providerThreadId: sessionBefore.providerThreadId as string,
      providerUpdatedAt: 999,
      status: "active",
      title: "must not be reconciled",
    }];
    await expect(value.service.execute({
      account: profile.id,
      kind: "session.list",
      limit: 25,
    }, { signal })).resolves.toMatchObject({ recovery: { required: true } });
    await value.service.observeCodexFact(
      {
        codexHome: "unused",
        desktopUserData: "unused",
        generation: profile.processGeneration,
        id: profile.id,
      },
      {
        name: "must not mutate the session",
        threadId: sessionBefore.providerThreadId as string,
        type: "threadNameUpdated",
      },
    );
    const observerAuthority = {
      codexHome: "unused",
      desktopUserData: "unused",
      generation: profile.processGeneration,
      id: profile.id,
    } as const;
    await value.service.observeCodexAccount(observerAuthority, {
      signedIn: false,
    });
    value.codex.readProjection = {
      ...value.codex.readProjection,
      activeTurnId: "foreign-active-turn",
      providerThreadId: "foreign-provider-thread",
      status: "active",
    };
    const beforeBlockedShow = value.store.requireSession(sessionId);
    const blockedShow = await value.service.execute({
      detail: false,
      kind: "session.show",
      session: sessionId,
    }, { signal });
    expect(blockedShow).toMatchObject({
      recovery: { cleared: false, required: true },
      session: beforeBlockedShow,
    });
    expect(blockedShow).not.toHaveProperty("projection");
    await value.service.observeCodexFact(observerAuthority, {
      status: { type: "systemError" },
      threadId: sessionBefore.providerThreadId as string,
      type: "threadStatusChanged",
    });
    await value.service.settled();
    expect(value.store.requireSession(sessionId)).toEqual(sessionBefore);
    expect(value.store.requireProfileById(profile.id).state).toBe("signed_in");
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    expect(value.codex.calls.filter((call) => call === "logout")).toEqual([]);

    cloud.beforeProjectionRecoveryReturn = () => {
      cloud.unsettledProjectionSessions.delete(sessionId);
      cloud.unsettledProjectionProfiles.delete(profile.id);
      return Promise.resolve();
    };
    await expect(value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000811",
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal })).resolves.toBe(cloud.projectionRecoveryResult);
    await expect(value.service.execute({
      kind: "session.fast",
      enabled: true,
      session: sessionId,
    }, { signal })).resolves.toMatchObject({ session: { fastEnabled: true } });
  });

  test("drops queue-scheduling provider facts while projection recovery preserves the session", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Projection fact block");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const pending = value.store.enqueue(session.id, "must remain behind recovery");
    cloud.unsettledProjectionSessions.add(session.id);
    cloud.unsettledProjectionProfiles.add(profile.id);
    const providerWritesBefore = providerMutationCalls(value.codex);

    await value.service.observeCodexFact({
      codexHome: "unused",
      desktopUserData: "unused",
      generation: profile.processGeneration,
      id: profile.id,
    }, {
      threadId: session.providerThreadId,
      turn: {
        completedAt: 2,
        durationMs: 1,
        id: "blocked-completion",
        items: [],
        startedAt: 1,
        status: "completed",
      },
      type: "turnCompleted",
    });
    await value.service.settled();

    expect(value.store.requireSession(session.id)).toEqual(session);
    expect(value.store.listQueue(session.id).find((entry) => entry.id === pending.id))
      .toMatchObject({ state: "pending" });
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });

  test("provider deletion supersedes an in-flight recovery and terminalizes local authority exactly once", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Projection deletion race");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound recovery session.");
    const authority: ProfileAuthority = {
      codexHome: "unused",
      desktopUserData: "unused",
      generation: profile.processGeneration,
      id: profile.id,
    };
    const connectionId = "32000000-0000-4000-8000-000000000099";
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { release = resolve; });
    cloud.beforeProjectionRecoveryReturn = async () => {
      entered();
      await recoveryGate;
    };
    const providerWritesBefore = providerMutationCalls(value.codex);
    const recovery = value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000899",
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal });
    await recoveryEntered;

    const pendingQueue = value.store.enqueue(sessionId, "must be cancelled");
    await value.service.observeCodexFact(authority, {
      blocking: true,
      connectionId,
      display: {
        allowsSessionApproval: false,
        commandClass: "test",
        kind: "command_approval",
        reason: null,
        summary: "Must expire on deletion",
        workingDirectory: null,
      },
      kind: "command_approval",
      provider: {
        approvalId: null,
        connectionId,
        itemId: "item-delete-race",
        method: "item/commandExecution/requestApproval",
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        requestDigest: "9".repeat(64),
        requestId: { type: "number", value: 99 },
        threadId: session.providerThreadId,
        turnId: "turn-delete-race",
      },
      type: "interactionRequested",
    });
    await value.service.observeCodexFact(authority, {
      ...parseFact("thread/deleted", { threadId: session.providerThreadId }),
      connectionId,
    });

    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "terminal" });
    expect(value.store.requireQueue(pendingQueue.id)).toMatchObject({ state: "cancelled" });
    expect(value.store.listInteractions({ pendingOnly: true, sessionId })).toEqual([]);
    expect(cloud.providerDeletionSupersessions).toEqual([sessionId]);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);

    release();
    await expect(recovery).resolves.toMatchObject({
      phase: "rejected",
      rejectionCode: "PROVIDER_THREAD_DELETED",
      sessionPublicId: sessionId,
    });
    await value.service.observeCodexFact(authority, {
      ...parseFact("thread/deleted", { threadId: session.providerThreadId }),
      connectionId,
    });
    const terminalEvents = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId,
    }).events.filter((event) =>
      event.body.type === "session_status" && event.body.status === "terminal");
    expect(terminalEvents).toHaveLength(1);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });

  test("reopened recovery supersedes crash-left journal authority for a terminal session", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Projection deletion restart");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound recovery session.");
    const active: CloudProjectionRecoveryJournalEntry = {
      authority: { bootGeneration: 1, bootId: "boot_delete_restart_12345678", fence: 1 },
      baselineCompletedTurns: [],
      epochPublicId: "018bcfe5-6800-7000-8000-000000000892",
      expectedCompactStreamEpoch: 0,
      expectedHeadSequence: 300,
      expectedTailDigest: "a".repeat(64),
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000891",
      lineageCommitment: "b".repeat(64),
      localAuthority: {
        profileGeneration: profile.processGeneration,
        profileId: profile.id,
        providerThreadId: session.providerThreadId,
        providerUpdatedAt: session.providerUpdatedAt ?? null,
        sessionRevision: session.revision,
      },
      phase: "effect_started",
      replacementCacheId: "cache_delete_restart_12345678",
      requestDigest: "c".repeat(64),
      requestedAt: 1_700_000_000_000,
      sessionPublicId: session.id,
      sourceCacheId: "cache_source_delete_restart_12345678",
      sourceDevicePublicId: "device_delete_restart_12345678",
      userPublicId: "user_delete_restart_12345678",
    };
    const journal = new MemoryCloudDaemonJournal();
    expect(await journal.compareAndSwap(null, {
      commands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [active],
      projectionRecoveryReceipts: [],
      usageAccounts: [],
      version: 3,
    })).not.toBeNull();
    expect(value.store.terminalizeSessionFromProviderDeletion({
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      sessionId: session.id,
    }).changed).toBe(true);
    await value.service.close();
    const blocker = new CloudDaemonJournalRecoveryBlocker(journal, {
      isSessionTerminal: (sessionPublicId) =>
        value.store.requireSession(sessionPublicId).state === "terminal",
    });
    const reopened = new HraService({
      cloud: new UnavailableCloudControl(blocker),
      codex: value.codex,
      daemonAuthority: new FakeDaemonAuthority(),
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    const providerWritesBefore = providerMutationCalls(value.codex);

    await reopened.recover();
    const recovered = (await journal.read()).state;
    expect(recovered.projectionRecoveries).toEqual([]);
    expect(recovered.projectionRecoveryReceipts).toEqual([
      expect.objectContaining({
        idempotencyKey: active.idempotencyKey,
        phase: "rejected",
        rejectionCode: "PROVIDER_THREAD_DELETED",
        sessionPublicId: session.id,
      }),
    ]);
    await reopened.recover();
    expect((await journal.read()).state).toEqual(recovered);
    await expect(reopened.execute({
      acknowledgeGap: true,
      idempotencyKey: active.idempotencyKey,
      kind: "sync.projection-recover",
      session: session.id,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: session.id,
    }).events.filter((event) =>
      event.body.type === "session_status" && event.body.status === "terminal"))
      .toHaveLength(1);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    await reopened.close();
  });

  test("reopened service keeps custody recovery blocking without cloud transport and same-key restore unblocks", async () => {
    const value = await fixture();
    const { sessionId: affectedSessionId } = await createIdleSession(value, "Projection offline restart");
    const unrelatedAccount = await value.service.execute({
      kind: "account.add",
      label: "Projection unrelated authority",
    }, { signal }) as { account: { id: string } };
    await value.service.execute({
      account: unrelatedAccount.account.id,
      deviceCode: false,
      kind: "account.login",
    }, { signal });
    const unrelatedStarted = await value.service.execute({
      account: unrelatedAccount.account.id,
      fast: false,
      kind: "session.start",
      preset: "high",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const unrelatedSessionId = unrelatedStarted.session.id;
    const affectedSession = value.store.requireSession(affectedSessionId);
    const affectedProfile = value.store.requireProfile(affectedSession.profileId);
    if (affectedSession.providerThreadId === undefined) throw new Error("Expected a bound test session.");
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000881";
    const epochPublicId = "018bcfe5-6800-7000-8000-000000000882";
    const recovery: CloudProjectionRecoveryJournalEntry = {
      authority: { bootGeneration: 1, bootId: "boot_restart_12345678", fence: 1 },
      baselineCompletedTurns: [],
      epochPublicId,
      expectedCompactStreamEpoch: 0,
      expectedHeadSequence: 300,
      expectedTailDigest: "a".repeat(64),
      idempotencyKey,
      lineageCommitment: "b".repeat(64),
      localAuthority: {
        profileGeneration: affectedProfile.processGeneration,
        profileId: affectedProfile.id,
        providerUpdatedAt: 10,
        providerThreadId: affectedSession.providerThreadId,
        sessionRevision: affectedSession.revision,
      },
      phase: "effect_started",
      replacementCacheId: "cache_replacement_restart_12345678",
      requestDigest: "c".repeat(64),
      requestedAt: 1_700_000_000_000,
      sessionPublicId: affectedSession.id,
      sourceDevicePublicId: "device_restart_12345678",
      sourceCacheId: "cache_source_restart_12345678",
      userPublicId: "user_restart_12345678",
    };
    const journal = new MemoryCloudDaemonJournal();
    expect(await journal.compareAndSwap(null, {
      commands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [recovery],
      projectionRecoveryReceipts: [],
      usageAccounts: [],
      version: 3,
    })).not.toBeNull();
    const blocker = new CloudDaemonJournalRecoveryBlocker(journal);
    const providerWritesBefore = providerMutationCalls(value.codex);
    await value.service.close();

    const offlineAuthority = new FakeDaemonAuthority();
    const offlineService = new HraService({
      cloud: new UnavailableCloudControl(blocker),
      codex: value.codex,
      daemonAuthority: offlineAuthority,
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    await expect(offlineService.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000883",
      kind: "session.send",
      message: "must not reach the provider",
      session: affectedSessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(offlineService.execute({
      enabled: true,
      kind: "session.fast",
      session: affectedSessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(offlineService.execute({
      detail: false,
      kind: "session.show",
      session: affectedSessionId,
    }, { signal })).resolves.toBeDefined();
    await expect(offlineService.execute({
      enabled: true,
      kind: "session.fast",
      session: unrelatedSessionId,
    }, { signal })).resolves.toMatchObject({ session: { fastEnabled: true } });
    await expect(offlineService.execute({
      acknowledgeGap: true,
      idempotencyKey,
      kind: "sync.projection-recover",
      session: affectedSessionId,
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    expect(await blocker.isCompactProjectionRecoveryUnsettled(affectedSessionId)).toBe(true);
    await offlineService.close();

    const configuredCloud = new FakeCloud();
    configuredCloud.projectionRecoveryBlocker = blocker;
    configuredCloud.beforeProjectionRecoveryReturn = async () => {
      const observed = await journal.read();
      const current = observed.state.projectionRecoveries.find((entry) =>
        entry.idempotencyKey === idempotencyKey);
      if (current === undefined || current.phase !== "effect_started") {
        throw new Error("Expected exact recovery evidence.");
      }
      const applied: CloudProjectionRecoveryJournalEntry = {
        ...current,
        cacheActivated: false,
        phase: "applied",
        response: {
          boundaryHeadSequence: current.expectedHeadSequence,
          boundaryTailDigest: current.expectedTailDigest,
          compactHasRecoveryGap: true,
          compactStreamEpoch: current.expectedCompactStreamEpoch + 1,
          epochPublicId: current.epochPublicId,
          projectionRevision: 2,
          sessionPublicId: current.sessionPublicId,
        },
      };
      const appliedState = transitionCloudProjectionRecovery(
        observed.state,
        current,
        applied,
        Date.now(),
      );
      const receipt = createCloudProjectionRecoveryTerminalReceipt(applied, {
        phase: "applied",
      });
      const committed = await journal.compareAndSwap(
        observed.generation,
        transitionCloudProjectionRecovery(appliedState, applied, receipt, Date.now()),
      );
      if (committed === null) throw new Error("Recovery journal authority changed.");
    };
    const restoredService = new HraService({
      cloud: configuredCloud,
      codex: value.codex,
      daemonAuthority: new FakeDaemonAuthority(),
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    await expect(restoredService.execute({
      acknowledgeGap: true,
      idempotencyKey,
      kind: "sync.projection-recover",
      session: affectedSessionId,
    }, { signal })).resolves.toBe(configuredCloud.projectionRecoveryResult);
    expect(configuredCloud.projectionRecoveries).toHaveLength(1);
    expect(await blocker.isCompactProjectionRecoveryUnsettled(affectedSessionId)).toBe(false);
    await expect(restoredService.execute({
      enabled: true,
      kind: "session.fast",
      session: affectedSessionId,
    }, { signal })).resolves.toMatchObject({ session: { fastEnabled: true } });
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });

  test("rejects projection recovery before cloud dispatch for unsettled mutation and queue authority", async () => {
    for (const unsettled of ["mutation", "queue"] as const) {
      const cloud = new FakeCloud();
      const value = await fixture(undefined, cloud);
      const { sessionId } = await createIdleSession(value, `Projection ${unsettled}`);
      const session = value.store.requireSession(sessionId);
      const profile = value.store.requireProfile(session.profileId);
      if (unsettled === "mutation") {
        const attempt = value.store.prepareMutation({
          authorityGeneration: profile.processGeneration,
          authorityId: session.id,
          idempotencyKey: "00000000-0000-4000-8000-000000000804",
          kind: "session.rename",
          request: { name: "unsettled" },
        });
        expect(value.store.transitionMutation(attempt.id, "prepared", "effect_started")).toBe(true);
      } else {
        value.store.enqueue(session.id, "unsettled queue item");
      }
      const providerWritesBefore = providerMutationCalls(value.codex);

      await expect(value.service.execute({
        acknowledgeGap: true,
        idempotencyKey: unsettled === "mutation"
          ? "00000000-0000-4000-8000-000000000805"
          : "00000000-0000-4000-8000-000000000806",
        kind: "sync.projection-recover",
        session: session.id,
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(cloud.projectionRecoveries).toHaveLength(0);
      expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    }
  });

  test("rejects a projection recovery result when daemon authority becomes stale during the cloud await", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Projection stale fence");
    const providerWritesBefore = providerMutationCalls(value.codex);
    cloud.beforeProjectionRecoveryReturn = async () => { value.daemonAuthority.invalidate(); };

    await expect(value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000807",
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(cloud.projectionRecoveries).toHaveLength(1);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });

  test("fences an in-flight projection recovery during shutdown and joins it", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Projection shutdown fence");
    const providerWritesBefore = providerMutationCalls(value.codex);
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { release = resolve; });
    cloud.beforeProjectionRecoveryReturn = async () => {
      entered();
      await recoveryGate;
    };
    const recovery = value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000808",
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal });
    await recoveryEntered;

    const closing = value.service.close();
    release();
    await expect(recovery).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    await expect(closing).resolves.toBeUndefined();
    expect(value.daemonAuthority.closeCalls).toBe(1);
    expect(cloud.projectionRecoveries).toHaveLength(1);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });

  test("keeps completion facts newer than a delayed turn-start response and continues the queue", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Completion race" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const queued = store.enqueue(started.session.id, "after completion");
    const authority = { id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" };
    codex.beforeStartTurnReturn = async () => {
      delete codex.beforeStartTurnReturn;
      codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
      delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
      await service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "turn-next", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
    };

    await service.execute({ kind: "session.send", session: started.session.id, message: "finishes before reply" }, { signal });
    await service.settled();
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(2);
  });

  test("treats a terminal turn-start response as idle and dispatches the next queued message", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Terminal response" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const queued = store.enqueue(started.session.id, "next");
    codex.turnStatus = "completed";
    codex.beforeStartTurnReturn = async () => { delete codex.beforeStartTurnReturn; codex.turnStatus = "inProgress"; };

    expect(await service.execute({ kind: "session.send", session: started.session.id, message: "already complete" }, { signal })).toMatchObject({ turnId: "turn-next" });
    await service.settled();
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "applied" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", activeTurnId: "turn-next-2" });
  });

  test("keeps a queued completion fact newer than its response and dispatches the following queue entry", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queued completion race" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const first = store.enqueue(started.session.id, "first queued");
    const second = store.enqueue(started.session.id, "second queued");
    const authority = { id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" };
    codex.beforeStartTurnReturn = async () => {
      delete codex.beforeStartTurnReturn;
      codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
      delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
      await service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "turn-next", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
    };

    await service.recover();
    await service.settled();
    expect(store.requireQueue(first.id)).toMatchObject({ state: "applied" });
    expect(store.requireQueue(second.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(2);
  });

  test("serializes session show with mutations so projection and runtime profile are coherent", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Coherent show" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    codex.beforeReadSessionReturn = async () => { markReadStarted(); await readGate; };
    const show = service.execute({ kind: "session.show", session: started.session.id, detail: false }, { signal });
    await readStarted;
    delete codex.beforeReadSessionReturn;
    codex.runtimeProfileOverride = { ...runtimeProfile({ id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" }), observedAt: 3_000 };
    const send = service.execute({ kind: "session.send", session: started.session.id, message: "after read" }, { signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
    releaseRead();
    expect(await show).toMatchObject({ effectiveRuntimeProfile: { observedAt: 2_000 } });
    await send;
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 2, profile: { observedAt: 3_000 } });
  });

  test("dispatches the next durable queue item after a completed turn", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: string; providerThreadId: string } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "first" }, { signal });
    await service.execute({ kind: "session.queue", session: started.session.id, message: "second" }, { signal });
    codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
    delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
    await service.observeCodexFact({ id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" }, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "turn-initial", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
    await service.settled();
    expect(store.listQueue(started.session.id as `sess_${string}`)[0]).toMatchObject({ state: "applied" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", activeTurnId: "turn-next-2" });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 3, sourceKind: "queue_start" });
    expect(codex.calls).toContain("send");
  });

  test("continues FIFO after a determinate queued failure without overlapping dispatches", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue liveness" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "active" }, { signal });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active" });
    const first = await service.execute({ kind: "session.queue", session: started.session.id, message: "fails" }, { signal }) as { queued: { id: `queue_${string}` } };
    const second = await service.execute({ kind: "session.queue", session: started.session.id, message: "continues" }, { signal }) as { queued: { id: `queue_${string}` } };
    expect(store.requireQueue(first.queued.id)).toMatchObject({ state: "pending" });
    expect(store.requireQueue(second.queued.id)).toMatchObject({ state: "pending" });
    const authority = { id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" };
    codex.turnStatus = "completed";
    codex.startTurnErrorOnce = new Error("determinate rejection");
    codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
    delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
    codex.beforeStartTurnEffect = async () => {
      delete codex.beforeStartTurnEffect;
      await service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "competing-fact", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
      await Bun.sleep(0);
    };

    await service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "active-turn", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
    await service.settled();

    expect(store.requireQueue(first.queued.id)).toMatchObject({ state: "failed" });
    expect(store.requireQueue(second.queued.id)).toMatchObject({ state: "applied" });
    expect(codex.maximumConcurrentStartTurns).toBe(1);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(3);
  });

  test("dispatches a stranded imported queue when a project is assigned", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Imported project" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const project = await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal }) as { project: { id: string } };
    const imported = store.upsertProviderSession({
      profileId: added.account.id,
      providerThreadId: "provider-thread",
      title: "Imported without project",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const queued = await service.execute({ kind: "session.queue", session: imported.id, message: "run after project" }, { signal }) as { queued: { id: `queue_${string}` } };
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "pending" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);

    await service.execute({ kind: "session.project", session: imported.id, project: project.project.id }, { signal });
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });

  test("retries bounded pre-evidence baseline and capability failures without replaying a provider effect", async () => {
    for (const failure of ["baseline", "capability"] as const) {
      const { service, codex, documents, store } = await fixture();
      const added = await service.execute({ kind: "account.add", label: `Transient ${failure}` }, { signal }) as { account: { id: string } };
      await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
      await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
      const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
      if (failure === "baseline") codex.readSessionErrorOnce = new Error("transient baseline read");
      else codex.reviewTurnErrorOnce = new Error("transient capability read");

      const queued = await service.execute({ kind: "session.queue", session: started.session.id, message: `retry ${failure}` }, { signal }) as { queued: { id: `queue_${string}` } };
      await service.settled();

      expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "applied" });
      expect(store.readQueueEffect(queued.queued.id)).toMatchObject({ evidence: { queueId: queued.queued.id } });
      expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
      expect(codex.maximumConcurrentStartTurns).toBe(1);
    }
  });

  test("bounds persistent pre-evidence retries and permits an explicit project trigger", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Bounded retry" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const project = await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal }) as { project: { id: string } };
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    codex.beforeReadSessionReturn = async () => { throw new Error("persistent baseline failure"); };

    const queued = await service.execute({ kind: "session.queue", session: started.session.id, message: "bounded retry" }, { signal }) as { queued: { id: `queue_${string}` } };
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "pending" });
    expect(codex.calls.filter((call) => call === "read")).toHaveLength(4);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);

    delete codex.beforeReadSessionReturn;
    await service.execute({ kind: "session.project", session: started.session.id, project: project.project.id }, { signal });
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });

  test("canonicalizes selector aliases before serializing one session authority", async () => {
    const { service, codex, documents } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Canonical" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: string; title: string } };
    const results = await Promise.allSettled([
      service.execute({ kind: "session.send", session: started.session.id, message: "one" }, { signal }),
      service.execute({ kind: "session.send", session: started.session.title, message: "two" }, { signal }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });

  test("revalidates remote session authority inside the account and session locks", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Remote authority" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const session = store.requireSession(started.session.id);
    const profile = store.requireProfile(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("The provider binding is missing.");
    let logoutEntered!: () => void;
    const entered = new Promise<void>((resolve) => { logoutEntered = resolve; });
    let releaseLogout!: () => void;
    const logoutGate = new Promise<void>((resolve) => { releaseLogout = resolve; });
    codex.beforeLogoutReturn = async () => {
      logoutEntered();
      await logoutGate;
    };
    const logout = service.execute({ kind: "account.logout", account: profile.id, idempotencyKey: "00000000-0000-4000-8000-000000000701" }, { signal });
    await entered;
    const remote = service.executeRemote(
      { kind: "session.send", session: session.id, message: "must remain fenced", idempotencyKey: "00000000-0000-4000-8000-000000000702" },
      { sessionId: session.id, profileId: profile.id, processGeneration: profile.processGeneration, providerThreadId: session.providerThreadId },
      { signal },
    );
    releaseLogout();
    await logout;
    await expect(remote).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
  });

  test("serializes remote Fast behind an exact provider turn commit", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Remote metadata" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const session = store.requireSession(started.session.id);
    const profile = store.requireProfile(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("The provider binding is missing.");
    let entered!: () => void;
    const providerVisible = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    codex.beforeStartTurnReturn = async () => { entered(); await gate; };
    const send = service.execute({
      kind: "session.send",
      session: session.id,
      message: "provider visible first",
      idempotencyKey: "00000000-0000-4000-8000-000000000711",
    }, { signal });
    await providerVisible;
    let remoteSettled = false;
    const remote = service.executeRemote({
      enabled: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000712",
      kind: "session.fast",
      session: session.id,
    }, {
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      providerThreadId: session.providerThreadId,
      sessionId: session.id,
    }, { signal }).finally(() => { remoteSettled = true; });
    await Bun.sleep(0);
    expect(remoteSettled).toBe(false);
    expect(store.requireSession(session.id).fastEnabled).toBe(false);
    release();
    await send;
    await remote;
    expect(store.readMutation("00000000-0000-4000-8000-000000000711")).toMatchObject({ state: "applied" });
    expect(store.requireSession(session.id)).toMatchObject({ fastEnabled: true, state: "active" });
  });

  test("rechecks the daemon fence after a remote metadata command waits for its session lock", async () => {
    const { service, codex, daemonAuthority, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Remote fence" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const session = store.requireSession(started.session.id);
    const profile = store.requireProfile(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("The provider binding is missing.");
    let entered!: () => void;
    const providerVisible = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    codex.beforeStartTurnReturn = async () => { entered(); await gate; };
    const send = service.execute({ kind: "session.send", session: session.id, message: "hold", idempotencyKey: "00000000-0000-4000-8000-000000000713" }, { signal })
      .then(() => null, (error: unknown) => error);
    await providerVisible;
    const remote = service.executeRemote({
      idempotencyKey: "00000000-0000-4000-8000-000000000714",
      kind: "session.preset",
      preset: "ultra",
      session: session.id,
    }, {
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      providerThreadId: session.providerThreadId,
      sessionId: session.id,
    }, { signal }).then(() => null, (error: unknown) => error);
    await Bun.sleep(0);
    daemonAuthority.invalidate();
    release();
    expect(await send).toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(await remote).toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(store.requireSession(session.id).preset).toBe("high");
  });

  test("replays an applied login without advancing the profile generation or persisting its one-time code", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Login replay" }, { signal }) as { account: { id: string } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000101";
    codex.loginResult = { status: "pending", loginId: "provider-login-1", verificationUrl: "https://example.test/device?secret=1", userCode: "ABCD-EFGH" };
    const first = await service.execute({ kind: "account.login", account: added.account.id, deviceCode: true, idempotencyKey }, { signal }) as { login: { userCode?: string }; account: { processGeneration: number } };
    const replay = await service.execute({ kind: "account.login", account: added.account.id, deviceCode: true, idempotencyKey }, { signal }) as { login: { status: string; loginId?: string; next?: string; userCode?: string; verificationUrl?: string }; account: { processGeneration: number } };
    expect(first.login.userCode).toBe("ABCD-EFGH");
    expect(replay.login).toEqual({
      status: "pending",
      loginId: "provider-login-1",
      next: `hra account login-cancel ${added.account.id}`,
    });
    expect(replay.account.processGeneration).toBe(1);
    expect(codex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(1);
    expect(JSON.stringify(store.readMutation(idempotencyKey)?.result)).not.toContain("ABCD-EFGH");
    expect(JSON.stringify(store.readMutation(idempotencyKey)?.result)).not.toContain("secret=1");
  });

  test("recovers a lost pending-login response across daemon generation rollover by exact cancellation and fresh login", async () => {
    const { service, codex, store, paths } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Restart login" }, { signal }) as { account: { id: `acct_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000119";
    codex.loginResult = {
      status: "pending",
      loginId: "provider-login-restart",
      verificationUrl: "https://example.test/login?private=handoff",
      userCode: "PRIVATE-CODE",
    };
    const first = await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal }) as { login: { loginId: string; userCode: string } };
    expect(first.login).toMatchObject({ loginId: "provider-login-restart", userCode: "PRIVATE-CODE" });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toMatchObject({
      idempotencyKey,
      loginId: "provider-login-restart",
      processGeneration: 1,
    });

    store.nextDaemonGeneration(`boot_${"a".repeat(32)}`);
    const rebound = store.readPendingLoginAuthority(added.account.id, 2);
    expect(rebound).toMatchObject({ loginId: "provider-login-restart", processGeneration: 2 });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();

    const restartedCodex = new FakeCodex();
    restartedCodex.accountProjection = { signedIn: false };
    restartedCodex.cancelLoginResult = { status: "not_found" };
    const restarted = new HraService({
      store,
      paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      requestStop: () => undefined,
    });
    expect(await restarted.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).toMatchObject({
      account: { processGeneration: 2, state: "login_pending" },
      login: {
        status: "pending",
        loginId: "provider-login-restart",
        next: `hra account login-cancel ${added.account.id}`,
      },
    });
    const replay = await restarted.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal }) as { account: { processGeneration: number }; login: Record<string, unknown> };
    expect(replay.account.processGeneration).toBe(2);
    expect(replay.login).toEqual({
      status: "pending",
      loginId: "provider-login-restart",
      next: `hra account login-cancel ${added.account.id}`,
    });
    expect(JSON.stringify(replay)).not.toContain("PRIVATE-CODE");
    expect(JSON.stringify(replay)).not.toContain("private=handoff");
    expect(restartedCodex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(0);

    expect(() => store.settlePendingLogin({
      profileId: added.account.id,
      processGeneration: 2,
      loginId: "wrong-provider-login",
      providerStatus: "not_found",
      provider: { signedIn: false },
    })).toThrow("LOGIN_CANCEL_AUTHORITY_MISMATCH");

    const canceled = await restarted.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal }) as { account: { state: string }; providerStatus: string; status: string };
    expect(canceled).toMatchObject({
      account: { state: "signed_out" },
      providerStatus: "not_found",
      status: "canceled",
    });
    expect(restartedCodex.calls).toContain(`login-cancel:${added.account.id}:2:provider-login-restart`);
    expect(await restarted.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).toMatchObject({ status: "already_settled" });
    expect(restartedCodex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);

    restartedCodex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    const fresh = await restarted.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal }) as { account: { processGeneration: number; state: string } };
    expect(fresh.account).toMatchObject({ processGeneration: 3, state: "signed_in" });
  });

  test("rejects login cancellation after an unbound profile generation change", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Stale login" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-stale" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    store.nextProfileGeneration(added.account.id);
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(0);
  });

  test("preserves exact pending-login cancellation authority across an unexpected provider disconnect", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Disconnected login" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-disconnected" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.observeCodexFact({
      id: added.account.id,
      generation: 1,
      codexHome: "unused",
      desktopUserData: "unused",
    }, {
      type: "providerDisconnected",
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      reason: "process_exit",
    });
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "login_pending",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 2)).toMatchObject({
      loginId: "provider-login-disconnected",
    });
    codex.accountProjection = { signedIn: false };
    codex.cancelLoginResult = { status: "not_found" };
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { state: "signed_out" },
      status: "canceled",
    });
    expect(codex.calls).toContain(`login-cancel:${added.account.id}:2:provider-login-disconnected`);
  });

  test("rejects an idempotency key reused across account authorities without mutating the second account", async () => {
    const { service, store } = await fixture();
    const first = await service.execute({ kind: "account.add", label: "First" }, { signal }) as { account: { id: string } };
    const second = await service.execute({ kind: "account.add", label: "Second" }, { signal }) as { account: { id: string } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000102";
    await service.execute({ kind: "account.login", account: first.account.id, deviceCode: false, idempotencyKey }, { signal });
    await expect(service.execute({ kind: "account.login", account: second.account.id, deviceCode: false, idempotencyKey }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.requireProfile(second.account.id)).toMatchObject({ processGeneration: 0, state: "signed_out" });
  });

  test("queues exactly once when an applied response is retried", async () => {
    const { service, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue replay" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const command = { kind: "session.queue" as const, session: started.session.id, message: "only once", idempotencyKey: "00000000-0000-4000-8000-000000000103" };
    const first = await service.execute(command, { signal }) as { queued: { id: string } };
    const replay = await service.execute(command, { signal }) as { queued: { id: string } };
    expect(replay.queued.id).toBe(first.queued.id);
    expect(store.listQueue(started.session.id)).toHaveLength(1);
  });

  test("replays applied send and stop receipts after their local session state has advanced", async () => {
    const { service, codex, documents } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Effect replay" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: string } };
    const send = { kind: "session.send" as const, session: started.session.id, message: "once", idempotencyKey: "00000000-0000-4000-8000-000000000105" };
    const firstSend = await service.execute(send, { signal });
    expect(await service.execute(send, { signal })).toEqual(firstSend);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    const stop = { kind: "session.stop" as const, session: started.session.id, idempotencyKey: "00000000-0000-4000-8000-000000000106" };
    const firstStop = await service.execute(stop, { signal });
    expect(await service.execute(stop, { signal })).toEqual(firstStop);
    expect(codex.calls.filter((call) => call === "stop")).toHaveLength(1);
  });

  test("keeps a receipt-commit ambiguity quarantined across passive and exact provider reads", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Receipt failure" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: string } };
    codex.turnId = "";
    const idempotencyKey = "00000000-0000-4000-8000-000000000107";
    const command = { kind: "session.send" as const, session: started.session.id, message: "ambiguous", idempotencyKey };
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    const quarantined = store.requireSession(started.session.id);
    expect(quarantined).toMatchObject({ state: "recovery_required", providerUpdatedAt: 10 });

    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "different key", idempotencyKey: "00000000-0000-4000-8000-000000000110" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);

    codex.listedProjections = [{ providerThreadId: "provider-thread", title: "Passive", status: "active", activeTurnId: "turn-passive", providerUpdatedAt: 11 }];
    await service.execute({ kind: "session.list", account: added.account.id, limit: 20 }, { signal });
    expect(store.requireSession(started.session.id)).toEqual(quarantined);

    codex.readProjection = { providerThreadId: "provider-thread", title: "Exact", status: "active", activeTurnId: "turn-exact", providerUpdatedAt: 12 };
    expect(await service.execute({ kind: "session.show", session: started.session.id, detail: false }, { signal })).toMatchObject({
      session: { state: "recovery_required", providerUpdatedAt: 10 },
      recovery: { required: true, cleared: false },
    });
    expect(store.requireSession(started.session.id)).toEqual(quarantined);

    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });

  test("quarantines a provider turn when its effective runtime profile cannot be committed", async () => {
    const { service, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Runtime receipt" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const originalComplete = store.completeSessionTurnEffect.bind(store);
    store.completeSessionTurnEffect = (() => { throw new Error("simulated receipt storage failure"); }) as StateStore["completeSessionTurnEffect"];
    const key = "00000000-0000-4000-8000-000000000111";

    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "profile must commit", idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 1, sourceKind: "session_start" });
    store.completeSessionTurnEffect = originalComplete;
  });

  test("quarantines lost provider responses for send, steer, stop, and rename before another key can dispatch", async () => {
    for (const operation of ["send", "steer", "stop", "rename"] as const) {
      const { service, codex, documents, store } = await fixture();
      const added = await service.execute({ kind: "account.add", label: `Lost ${operation}` }, { signal }) as { account: { id: string } };
      await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
      await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
      const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: string } };
      if (operation === "steer" || operation === "stop") {
        await service.execute({ kind: "session.send", session: started.session.id, message: "activate" }, { signal });
      }
      const lost = new IndeterminateCodexEffectError(`turn/${operation}`, 41);
      if (operation === "send") codex.startTurnError = lost;
      if (operation === "steer") codex.steerError = lost;
      if (operation === "stop") codex.interruptError = lost;
      if (operation === "rename") codex.renameError = lost;
      const firstKey = `00000000-0000-4000-8000-0000000002${operation === "send" ? "01" : operation === "steer" ? "02" : operation === "stop" ? "03" : "04"}`;
      const secondKey = `00000000-0000-4000-8000-0000000003${operation === "send" ? "01" : operation === "steer" ? "02" : operation === "stop" ? "03" : "04"}`;
      const first = operation === "send"
        ? { kind: "session.send" as const, session: started.session.id, message: "lost", idempotencyKey: firstKey }
        : operation === "steer"
          ? { kind: "session.steer" as const, session: started.session.id, message: "lost", idempotencyKey: firstKey }
          : operation === "stop"
            ? { kind: "session.stop" as const, session: started.session.id, idempotencyKey: firstKey }
            : { kind: "session.rename" as const, session: started.session.id, name: "Lost", idempotencyKey: firstKey };
      const second = operation === "send"
        ? { kind: "session.send" as const, session: started.session.id, message: "different", idempotencyKey: secondKey }
        : operation === "steer"
          ? { kind: "session.steer" as const, session: started.session.id, message: "different", idempotencyKey: secondKey }
          : operation === "stop"
            ? { kind: "session.stop" as const, session: started.session.id, idempotencyKey: secondKey }
            : { kind: "session.rename" as const, session: started.session.id, name: "Different", idempotencyKey: secondKey };

      await expect(service.execute(first, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
      const providerCalls = codex.calls.filter((call) => call === operation).length;
      await expect(service.execute(second, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(codex.calls.filter((call) => call === operation)).toHaveLength(providerCalls);
    }
  });

  test("quarantines a bound session when the session-start receipt cannot commit", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Start receipt" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const originalComplete = store.completeSessionStartEffect.bind(store);
    store.completeSessionStartEffect = (() => { throw new Error("simulated atomic start receipt failure"); }) as StateStore["completeSessionStartEffect"];
    const command = { kind: "session.start" as const, account: added.account.id, preset: "high" as const, fast: false, idempotencyKey: "00000000-0000-4000-8000-000000000401" };
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    store.completeSessionStartEffect = originalComplete;

    const [session] = store.listSessions();
    expect(session).toMatchObject({ state: "recovery_required" });
    expect(session?.providerThreadId).toBeUndefined();
    if (session === undefined) throw new Error("The quarantined session is missing.");
    await expect(service.execute({ kind: "session.send", session: session.id, message: "must not dispatch", idempotencyKey: "00000000-0000-4000-8000-000000000402" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
  });

  test("quarantines an unbound session-start lost response without blind replay", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Lost start" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    codex.startSessionError = new IndeterminateCodexEffectError("thread/start", 42);
    const command = { kind: "session.start" as const, account: added.account.id, preset: "high" as const, fast: false, idempotencyKey: "00000000-0000-4000-8000-000000000403" };
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.listSessions()).toHaveLength(1);
    expect(store.listSessions()[0]).toMatchObject({ state: "recovery_required" });
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(service.execute({ ...command, idempotencyKey: "00000000-0000-4000-8000-000000000404" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
  });

  test("causally reconciles a lost send by exact client id and newer provider revision without redispatch", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Causal send" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const key = "00000000-0000-4000-8000-000000000405";
    codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 44);
    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "causal", idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", details: { idempotencyKey: key } });
    expect(store.readMutation(key)).toMatchObject({ state: "ambiguous", evidence: { evidence: { kind: "session.send", clientMessageId: expect.any(String), baseline: { providerUpdatedAt: 10 } } } });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);

    delete codex.startTurnError;
    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      idempotencyKey: key,
      session: { state: "active", activeTurnId: "turn-next", providerUpdatedAt: 11 },
      recovery: { resolved: true, resolution: "proven_applied", providerEffectRetried: false },
    });
    expect(store.readMutation(key)).toMatchObject({ state: "reconciled", originalState: "ambiguous", result: { turnId: "turn-next" } });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 2, sourceKind: "turn_start", sourceId: expect.any(String) });
    expect(await service.execute({ kind: "session.send", session: started.session.id, message: "causal", idempotencyKey: key }, { signal })).toMatchObject({ turnId: "turn-next", idempotencyKey: key });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(await service.execute({ kind: "session.stop", session: started.session.id, idempotencyKey: "00000000-0000-4000-8000-000000000406" }, { signal })).toMatchObject({ stopped: true });
  });

  test("rejects noncausal recovery proof and releases an unbound start only by explicit abandon", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Abandon start" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    codex.startSessionError = new IndeterminateCodexEffectError("thread/start", 45);
    const key = "00000000-0000-4000-8000-000000000407";
    await expect(service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false, idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", details: { idempotencyKey: key } });
    const [session] = store.listSessions();
    if (session === undefined) throw new Error("Expected a bound start placeholder.");
    expect(await service.execute({ kind: "session.recover", session: session.id }, { signal }).catch((error: unknown) => error)).toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await service.execute({ kind: "session.abandon", session: session.id }, { signal })).toMatchObject({
      idempotencyKey: key,
      session: { state: "terminal" },
      recovery: { resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false },
    });
    expect(store.readMutation(key)).toMatchObject({ state: "reconciled", originalState: "ambiguous", resolution: { kind: "abandoned" } });
    await expect(service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false, idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    delete codex.startSessionError;
    expect(await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false, idempotencyKey: "00000000-0000-4000-8000-000000000408" }, { signal })).toMatchObject({ session: { state: "idle" } });
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(2);
  });

  test("reconciles an unsettled-free system error through one exact read and no provider write", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Status recovery" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const authority = { id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" };
    await service.observeCodexFact(authority, { type: "threadStatusChanged", threadId: started.session.providerThreadId, status: { type: "systemError" } });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    expect(store.listUnsettledMutations({ sessionId: started.session.id })).toHaveLength(0);
    expect(store.listUnsettledQueueEffects(started.session.id)).toHaveLength(0);
    codex.readProjection = { ...codex.readProjection, title: "Recovered exact state", status: "idle", providerUpdatedAt: 12 };
    const providerWritesBefore = codex.calls.filter((call) => call === "send" || call === "steer" || call === "stop" || call === "rename").length;

    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      session: { state: "idle", title: "Recovered exact state", providerUpdatedAt: 12 },
      recovery: { resolved: true, resolution: "provider_state_reconciled", providerEffectRetried: false },
    });
    expect(codex.calls.filter((call) => call === "send" || call === "steer" || call === "stop" || call === "rename")).toHaveLength(providerWritesBefore);
  });

  test("continues a pending queue after recovery restores an idle session", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Recovery queue" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const pending = store.enqueue(started.session.id, "continue after recovery");
    const authority = { id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" };
    await service.observeCodexFact(authority, { type: "threadStatusChanged", threadId: started.session.providerThreadId, status: { type: "systemError" } });
    codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: 12 };

    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      session: { state: "idle" },
      recovery: { resolution: "provider_state_reconciled", providerEffectRetried: false },
    });
    await service.settled();
    expect(store.requireQueue(pending.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });

  test("explicitly abandons an unsettled-free status quarantine without reading or deleting provider state", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Status abandon" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const pending = store.enqueue(started.session.id, "never dispatched");
    const authority = { id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" };
    await service.observeCodexFact(authority, { type: "threadStatusChanged", threadId: started.session.providerThreadId, status: { type: "systemError" } });
    const readsBefore = codex.calls.filter((call) => call === "read").length;

    expect(await service.execute({ kind: "session.abandon", session: started.session.id }, { signal })).toMatchObject({
      session: { state: "terminal" },
      recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false },
    });
    expect(store.requireQueue(pending.id)).toMatchObject({ state: "cancelled" });
    expect(codex.calls.filter((call) => call === "read")).toHaveLength(readsBefore);
  });

  test("keeps a lost send ambiguous when client-id or revision proof is tampered", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Tamper proof" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 46);
    const key = "00000000-0000-4000-8000-000000000409";
    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "tamper", idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    delete codex.startTurnError;
    const actual = codex.readProjection;
    codex.readProjection = { ...actual, providerUpdatedAt: 10, messages: (actual.messages ?? []).map((message) => message.role === "user" ? { ...message, clientId: "wrong-client" } : message) };
    await expect(service.execute({ kind: "session.recover", session: started.session.id }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
  });

  test("schedules recoverable idle queues without awaiting provider dispatch before readiness", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue readiness" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    store.enqueue(started.session.id, "resume in background");
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    codex.beforeStartTurnReturn = async () => await dispatchGate;

    const readiness = await Promise.race([
      service.recover().then(() => "ready" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(readiness).toBe("ready");
    releaseDispatch();
    await service.settled();
    expect(store.listQueue(started.session.id)[0]).toMatchObject({ state: "applied" });
  });

  test("dispatches a durable queue immediately for an idle session", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Idle queue" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    await service.execute({ kind: "session.queue", session: started.session.id, message: "dispatch now" }, { signal });
    await service.settled();
    expect(store.listQueue(started.session.id)[0]).toMatchObject({ state: "applied" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", activeTurnId: "turn-next" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });

  test("recovers a crash-adjacent dispatch as ambiguous without replaying it", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue recovery" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const queued = store.enqueue(started.session.id, "uncertain");
    store.beginQueueEffect({
      queueId: queued.id,
      sessionId: started.session.id,
      profileGeneration: 1,
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.id,
        sessionId: started.session.id,
        providerThreadId: "provider-thread",
        profileGeneration: 1,
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: queued.id,
        messageDigest: createHash("sha256").update("uncertain").digest("hex"),
        runtimeProfile: runtimeProfile({ id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" }),
      },
    });
    await service.recover();
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
  });

  test("causally recovers an ambiguous queued dispatch with its reviewed runtime profile", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue causal recovery" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 47);
    const queued = await service.execute({ kind: "session.queue", session: started.session.id, message: "uncertain queue" }, { signal }) as { queued: { id: `queue_${string}` } };
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    delete codex.startTurnError;

    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      queueId: queued.queued.id,
      session: { state: "active", activeTurnId: "turn-next" },
      recovery: { resolution: "proven_applied", providerEffectRetried: false },
    });
    expect(store.readQueueEffect(queued.queued.id)).toMatchObject({ resolution: { kind: "proven_applied" } });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 2, sourceKind: "queue_start", sourceId: queued.queued.id });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    const authority = { id: added.account.id as `acct_${string}`, generation: 1, codexHome: "unused", desktopUserData: "unused" };
    await service.observeCodexFact(authority, { type: "threadStatusChanged", threadId: started.session.providerThreadId, status: { type: "systemError" } });
    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      recovery: { resolution: "provider_state_reconciled" },
    });
  });

  test("rejects signed-out runtime effects before creating sessions or usage observations", async () => {
    const { service, documents, store, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Signed out" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    await expect(service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal })).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    await expect(service.execute({ kind: "account.usage", account: added.account.id, refresh: true }, { signal })).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    expect(store.listSessions()).toHaveLength(0);
    expect(codex.calls).toHaveLength(0);
  });

  test("removes an unused local placeholder after a determinate provider start rejection", async () => {
    const { service, documents, store, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Rejected start" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    codex.startSessionError = new Error("provider rejected before creating a thread");

    await expect(service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal })).rejects.toThrow("provider rejected");

    expect(store.listSessions()).toHaveLength(0);
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
  });

  test("binds an idle steer key so it cannot steer a future turn", async () => {
    const { service, documents, store, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Idle steer" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: string } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000108";
    const steer = { kind: "session.steer" as const, session: started.session.id, message: "future", idempotencyKey };
    await expect(service.execute(steer, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "failed" });
    await service.execute({ kind: "session.send", session: started.session.id, message: "now" }, { signal });
    await expect(service.execute(steer, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.calls.filter((call) => call === "steer")).toHaveLength(0);
  });

  test("a determinate queued dispatch failure is terminal without quarantining the session", async () => {
    const { service, documents, store, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue failure" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    codex.startTurnError = new Error("provider rejected before effect");
    await service.execute({ kind: "session.queue", session: started.session.id, message: "will fail" }, { signal });
    await service.settled();
    expect(store.listQueue(started.session.id)[0]).toMatchObject({ state: "failed" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "idle" });
  });

  test("replays logout without contacting Codex twice", async () => {
    const { service, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Logout replay" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const command = { kind: "account.logout" as const, account: added.account.id, idempotencyKey: "00000000-0000-4000-8000-000000000109" };
    await service.execute(command, { signal });
    expect(await service.execute(command, { signal })).toMatchObject({ account: { state: "signed_out" } });
    expect(codex.calls.filter((call) => call === "logout")).toHaveLength(1);
  });

  test("reconciles an ambiguous logout only from an exact account read without replay", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Logout recovery" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: string } };
    codex.logoutError = new IndeterminateCodexEffectError("account/logout", 43);
    const command = { kind: "account.logout" as const, account: added.account.id, idempotencyKey: "00000000-0000-4000-8000-000000000501" };

    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const quarantined = store.requireProfile(added.account.id);
    expect(quarantined).toMatchObject({ state: "recovery_required", processGeneration: 1, providerEmail: "person@example.com" });
    expect(store.setProfileState(quarantined.id, quarantined.processGeneration, "signed_in", { email: "notification@example.com" })).toBe(false);

    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "blocked", idempotencyKey: "00000000-0000-4000-8000-000000000502" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(service.execute({ kind: "account.logout", account: added.account.id, idempotencyKey: "00000000-0000-4000-8000-000000000503" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
    expect(codex.calls.filter((call) => call === "logout")).toHaveLength(1);

    delete codex.logoutError;
    codex.accountProjection = { signedIn: true, email: "reconciled@example.com", plan: "Pro" };
    expect(await service.execute({ kind: "account.show", account: added.account.id }, { signal })).toMatchObject({
      account: { state: "signed_in", processGeneration: 1, providerEmail: "reconciled@example.com" },
      providerProjection: { signedIn: true, email: "reconciled@example.com" },
      recovery: { required: false, cleared: true, resolution: "provider_state_reconciled" },
    });
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.requireProfile(added.account.id)).toMatchObject({ state: "signed_in" });
    expect(codex.calls.filter((call) => call === "logout")).toHaveLength(1);
  });

  test("does not commit a provider turn after daemon authority becomes stale post-await", async () => {
    const { service, codex, daemonAuthority, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Stale authority" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    let releaseProvider!: () => void;
    let signalProviderApplied!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerApplied = new Promise<void>((resolve) => { signalProviderApplied = resolve; });
    codex.beforeStartTurnReturn = async () => {
      signalProviderApplied();
      await providerGate;
    };

    const sending = service.execute({ kind: "session.send", session: started.session.id, message: "must not commit" }, { signal });
    await providerApplied;
    daemonAuthority.invalidate();
    releaseProvider();

    await expect(sending).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "idle" });
    expect(store.requireSession(started.session.id).activeTurnId).toBeUndefined();
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 1, sourceKind: "session_start" });
    expect(store.listUnsettledMutations({ sessionId: started.session.id })).toEqual([
      expect.objectContaining({ kind: "session.send", state: "effect_started" }),
    ]);
    const recovered = store.recoverEffectStartedMutations();
    expect(recovered.unresolved).toEqual([]);
    expect(recovered.recovered).toHaveLength(1);
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    expect(store.listUnsettledMutations({ sessionId: started.session.id })).toEqual([
      expect.objectContaining({ kind: "session.send", state: "ambiguous" }),
    ]);
  });

  test("exposes an atomic status cursor and wakes a bounded event tail without losing safe deltas", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Event stream");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "30000000-0000-4000-8000-000000000001";
    await value.service.observeCodexFact(authority, {
      type: "itemStarted",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "item-live",
      itemKind: "agentMessage",
    });
    await value.service.observeCodexFact(authority, {
      type: "assistantDelta",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "item-live",
      text: "Visible progress",
    });
    const first = await value.service.execute({
      kind: "session.events",
      session: sessionId,
      limit: 200,
      waitMs: 0,
    }, { signal }) as { events: Array<{ body: { type: string; text?: string } }>; nextCursor: string };
    expect(first.events.map((event) => event.body.type)).toEqual([
      "connection",
      "item_started",
      "assistant_delta",
    ]);
    expect(first.events.at(-1)?.body.text).toBe("Visible progress");

    const status = await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }) as { eventStream: { cursor: string; observedThroughSequence: number }; session: { id: string } };
    expect(status).toMatchObject({
      version: 1,
      session: { id: sessionId },
      eventStream: { observedThroughSequence: 3 },
    });
    const waiting = value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: status.eventStream.cursor,
      limit: 200,
      waitMs: 1_000,
    }, { signal }) as Promise<{ events: Array<{ body: { type: string; text?: string } }>; nextCursor: string }>;
    await Bun.sleep(5);
    await value.service.observeCodexFact(authority, {
      type: "reasoningSummaryDelta",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "reasoning-live",
      summaryIndex: 0,
      text: "Checking the public contract",
    });
    await expect(waiting).resolves.toMatchObject({
      events: [{ body: { type: "reasoning_summary_delta", text: "Checking the public contract" } }],
    });
    await expect(value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: `${first.nextCursor}tampered`,
      limit: 10,
      waitMs: 0,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("routes provider close and delete lifecycle without leaving a mutable stale session", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Provider lifecycle");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "32000000-0000-4000-8000-000000000001";
    await value.service.observeCodexFact(authority, {
      type: "turnStarted",
      connectionId,
      threadId: session.providerThreadId,
      turn: {
        id: "turn-lifecycle",
        items: [],
        status: "inProgress",
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      },
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      activeTurnId: "turn-lifecycle",
      state: "active",
    });

    await value.service.observeCodexFact(authority, {
      ...parseFact("thread/closed", { threadId: session.providerThreadId }),
      connectionId,
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "idle" });
    expect(value.store.requireSession(sessionId).activeTurnId).toBeUndefined();
    const afterClose = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    });
    expect(afterClose.events.at(-1)?.body).toEqual({
      type: "session_status",
      status: "not_loaded",
      activeTurnId: null,
    });

    await value.service.observeCodexFact(authority, {
      ...parseFact("skills/changed", { paths: ["/private/discarded"] }),
      connectionId,
    });
    expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events)
      .toHaveLength(afterClose.events.length);

    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number", value: 41 },
        method: "item/commandExecution/requestApproval",
        requestDigest: "4".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-deleted",
        itemId: "item-deleted",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Approval cannot survive provider deletion",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        allowsSessionApproval: false,
      },
    });
    expect(value.store.listInteractions({ sessionId, pendingOnly: true })).toHaveLength(1);
    const pendingQueue = value.store.enqueue(session.id, "must not dispatch after deletion");
    expect(value.store.quarantineSession(session.id)).toMatchObject({ state: "recovery_required" });
    await value.service.observeCodexFact(authority, {
      ...parseFact("thread/deleted", { threadId: session.providerThreadId }),
      connectionId,
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "terminal" });
    expect(value.store.requireQueue(pendingQueue.id)).toMatchObject({ state: "cancelled" });
    expect(value.store.listInteractions({ sessionId, pendingOnly: true })).toEqual([]);
    expect(value.store.listInteractions({ sessionId, pendingOnly: false })).toEqual([
      expect.objectContaining({ state: "expired", revision: 2 }),
    ]);
    const afterDelete = value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
    expect(afterDelete.filter((event) =>
      event.body.type === "session_status" && event.body.status === "terminal")
      .map((event) => event.body))
      .toEqual([{ type: "session_status", status: "terminal", activeTurnId: null }]);
    await expect(value.service.execute({
      kind: "session.send",
      session: sessionId,
      message: "must fail closed",
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("keeps provider diagnostic secrets out of the durable stream and CLI", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Safe diagnostics");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const privatePath = ["", "Users", "alice", "private", "key"].join("/");
    const sentinel = `Bearer PROVIDER_EVENT_SECRET at ${privatePath}`;
    const parsed = parseFact("warning", {
      threadId: session.providerThreadId,
      message: sentinel,
    });
    await value.service.observeCodexFact(authority, {
      ...parsed,
      connectionId: "31000000-0000-4000-8000-000000000001",
    });
    const command = {
      kind: "session.events",
      session: sessionId,
      limit: 200,
      waitMs: 0,
    } satisfies LocalCommand;
    const page = await value.service.execute(command, { signal });
    const durable = JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }));
    const human = renderHuman(command, page);
    const json = renderJson(command, page);
    for (const output of [durable, human, json]) {
      expect(output).not.toContain("PROVIDER_EVENT_SECRET");
      expect(output).not.toContain(privatePath);
    }
    expect(human).toContain("Codex reported a provider warning.");
  });

  test("durably admits, privately routes, and settles an exact provider interaction", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Interaction broker");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const provider = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId: "40000000-0000-4000-8000-000000000001",
      requestId: { type: "string" as const, value: "approval-request-1" },
      method: "item/commandExecution/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: session.providerThreadId,
      turnId: "turn-approval",
      itemId: "item-approval",
      approvalId: "approval-1",
    };
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId: provider.connectionId,
      provider,
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Run the reviewed command",
        reason: "The test needs a safe effect",
        commandClass: "test",
        workingDirectory: null,
        allowsSessionApproval: true,
      },
    });
    const sessionInteractionsCommand = {
      kind: "session.interactions",
      session: sessionId,
      pending: true,
      limit: 10,
    } satisfies LocalCommand;
    const listed = await value.service.execute(
      sessionInteractionsCommand,
      { signal },
    ) as { interactions: PublicInteraction[] };
    expect(listed.interactions).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("approval-request-1");
    expect(JSON.stringify(listed)).not.toContain(provider.requestDigest);
    const interaction = listed.interactions[0];
    if (interaction === undefined) throw new Error("Expected an admitted interaction.");
    expect(publicInteractionSchema.parse(interaction)).toEqual(interaction);

    const interactionListCommand = {
      kind: "interaction.list",
      pending: true,
      limit: 10,
    } satisfies LocalCommand;
    const interactionList = await value.service.execute(interactionListCommand, { signal });
    const interactionShowCommand = {
      kind: "interaction.show",
      interaction: interaction.id,
    } satisfies LocalCommand;
    const interactionShow = await value.service.execute(interactionShowCommand, { signal });
    const statusCommand = { kind: "session.status", session: sessionId } satisfies LocalCommand;
    const status = await value.service.execute(statusCommand, { signal });
    for (const [command, result] of [
      [sessionInteractionsCommand, listed],
      [interactionListCommand, interactionList],
      [interactionShowCommand, interactionShow],
      [statusCommand, status],
    ] as const) {
      const human = renderHuman(command, result);
      expect(human).toContain("Run the reviewed command");
      expect(human).toContain(interaction.id);
      expect(human).not.toContain("unavailable");
      const json = renderJson(command, result);
      expect(json).not.toContain("approval-request-1");
      expect(json).not.toContain(provider.requestDigest);
      expect(json).not.toContain("requestDigest");
      expect(json).not.toContain("responseDigest");
      expect(json).not.toContain("authority");
    }

    const resolveCommand = {
      kind: "interaction.resolve",
      interaction: interaction.id,
      expectedRevision: interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    } satisfies LocalCommand;
    const resolved = await value.service.execute(resolveCommand, { signal });
    expect(resolved).toMatchObject({
      responseWritten: true,
      interaction: { id: interaction.id, state: "response_written", revision: 3 },
    });
    expect(renderHuman(resolveCommand, resolved)).toContain("State: response_written");
    expect(renderJson(resolveCommand, resolved)).not.toContain("responseDigest");
    expect(value.codex.resolvedInteractions).toHaveLength(1);
    expect(value.codex.resolvedInteractions[0]).toMatchObject({
      provider,
      kind: "command_approval",
      resolution: { kind: "approval_decision", decision: "once" },
    });
    await value.service.observeCodexFact(authority, {
      type: "interactionResolved",
      connectionId: provider.connectionId,
      provider,
      kind: "command_approval",
    });
    expect(value.store.requireInteraction(interaction.id)).toMatchObject({
      state: "resolved",
      revision: 4,
    });

    const mcpFormProvider = {
      ...provider,
      requestId: { type: "string" as const, value: "mcp-form-request-1" },
      method: "mcpServer/elicitation/request",
      requestDigest: "b".repeat(64),
      itemId: null,
      approvalId: null,
    };
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId: provider.connectionId,
      provider: mcpFormProvider,
      kind: "mcp_elicitation",
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "Configure the MCP server",
        serverName: "example",
        mode: "form",
        url: null,
        mayContainSecrets: true,
        fields: [
          {
            name: "token",
            type: "string",
            required: true,
            minLength: 8,
            maxLength: 64,
            format: null,
          },
          { name: "confirmed", type: "boolean", required: true },
        ],
      },
    });
    const mcpForm = value.store.listInteractions({ sessionId, pendingOnly: true, limit: 10 })
      .find((record) => record.authority.requestId.value === "mcp-form-request-1");
    if (mcpForm === undefined) throw new Error("Expected a standard MCP form interaction.");
    const submittedSentinel = "MCP_SERVICE_SUBMISSION_SECRET_SENTINEL";
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: mcpForm.publicId,
      expectedRevision: mcpForm.revision,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { token: submittedSentinel, confirmed: "yes" },
      },
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(value.store.requireInteraction(mcpForm.publicId)).toMatchObject({
      state: "pending",
      revision: 1,
      responseDigest: null,
    });
    expect(value.codex.resolvedInteractions).toHaveLength(1);
    const completedMcpForm = await value.service.execute({
      kind: "interaction.resolve",
      interaction: mcpForm.publicId,
      expectedRevision: mcpForm.revision,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { token: "protected-value", confirmed: true },
      },
    }, { signal });
    expect(completedMcpForm).toMatchObject({
      interaction: { id: mcpForm.publicId, state: "response_written", revision: 3 },
    });
    expect(value.codex.resolvedInteractions).toHaveLength(2);
    await value.service.observeCodexFact(authority, {
      type: "interactionResolved",
      connectionId: provider.connectionId,
      provider: mcpFormProvider,
      kind: "mcp_elicitation",
    });
    expect(value.store.requireInteraction(mcpForm.publicId)).toMatchObject({
      state: "resolved",
      revision: 4,
    });
    expect(JSON.stringify(value.store.listInteractions({ limit: 100 })))
      .not.toContain(submittedSentinel);
    expect(JSON.stringify(value.store.listInteractions({ limit: 100 })))
      .not.toContain("protected-value");

    const missingFieldsProvider = {
      ...mcpFormProvider,
      requestId: { type: "string" as const, value: "mcp-missing-fields-request" },
      requestDigest: "d".repeat(64),
    };
    await expect(value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId: provider.connectionId,
      provider: missingFieldsProvider,
      kind: "mcp_elicitation",
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "Incomplete MCP form",
        serverName: "example",
        mode: "form",
        url: null,
        mayContainSecrets: true,
      },
    })).rejects.toThrow("MCP_FORM_DISPLAY_CONTRACT_MISSING");
    expect(value.store.listInteractions({ limit: 100 }).some((record) =>
      record.authority.requestId.value === "mcp-missing-fields-request")).toBe(false);

    const secretUrl = "https://example.com/authorize?token=SECRET_SENTINEL";
    const mcpProvider = {
      ...provider,
      requestId: { type: "string" as const, value: "mcp-request-1" },
      method: "mcpServer/elicitation/request",
      requestDigest: "c".repeat(64),
      itemId: null,
      approvalId: null,
    };
    const unsafeUrlFact = {
      type: "interactionRequested",
      connectionId: provider.connectionId,
      provider: mcpProvider,
      kind: "mcp_elicitation",
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "Authorize the MCP server",
        serverName: "example",
        mode: "url",
        url: secretUrl,
        mayContainSecrets: true,
      },
    } as unknown as CodexFact;
    await expect(value.service.observeCodexFact(authority, unsafeUrlFact)).rejects.toThrow();
    const mcpRecord = value.store.listInteractions({
      sessionId,
      pendingOnly: true,
      limit: 10,
    }).find((record) => record.kind === "mcp_elicitation");
    expect(mcpRecord).toBeUndefined();
    expect(JSON.stringify(value.store.listInteractions({ limit: 100 })))
      .not.toContain("SECRET_SENTINEL");
  });

  test("expires all callback kinds exactly at their receipt-anchored deadline", async () => {
    let now = 50_000;
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Interaction deadlines");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "42000000-0000-4000-8000-000000000001";
    const requests = [
      {
        kind: "command_approval" as const,
        method: "item/commandExecution/requestApproval",
        display: {
          kind: "command_approval" as const,
          summary: "Allow command",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          allowsSessionApproval: false,
        },
      },
      {
        kind: "file_change_approval" as const,
        method: "item/fileChange/requestApproval",
        display: {
          kind: "file_change_approval" as const,
          summary: "Allow files",
          reason: null,
          grantRoot: null,
          allowsSessionApproval: false,
        },
      },
      {
        kind: "permission_approval" as const,
        method: "item/permissions/requestApproval",
        display: {
          kind: "permission_approval" as const,
          summary: "Allow permissions",
          reason: null,
          requested: [{ name: "network" }],
          allowsSessionScope: false,
        },
      },
      {
        kind: "user_input" as const,
        method: "item/tool/requestUserInput",
        display: {
          kind: "user_input" as const,
          summary: "Codex needs one answer",
          blocking: true,
          questions: [{
            id: "choice",
            header: "Choice",
            question: "Choose",
            options: null,
            allowsOther: true,
            secret: false,
          }],
        },
      },
      {
        kind: "mcp_elicitation" as const,
        method: "mcpServer/elicitation/request",
        display: {
          kind: "mcp_elicitation" as const,
          summary: "Configure MCP",
          serverName: "example",
          mode: "form" as const,
          url: null,
          mayContainSecrets: true as const,
          fields: [],
        },
      },
    ];
    for (const [index, request] of requests.entries()) {
      await value.service.observeCodexFact(authority, {
        type: "interactionRequested",
        connectionId,
        provider: {
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          connectionId,
          requestId: { type: "number", value: index + 1 },
          method: request.method,
          requestDigest: createHash("sha256").update(request.method).digest("hex"),
          threadId: session.providerThreadId,
          turnId: "turn-deadline",
          itemId: `item-${String(index + 1)}`,
          approvalId: null,
        },
        kind: request.kind,
        blocking: true,
        display: request.display,
        timeoutMs: 1_000,
        requestedAt: 50_000,
        deadlineAt: 51_000,
      });
    }
    now = 50_999;
    expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 0, failed: 0 });
    expect(value.codex.timedOutInteractions).toHaveLength(0);
    now = 51_000;
    expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 5, failed: 0 });
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(5);
    expect(value.codex.timedOutInteractions).toHaveLength(5);
    expect(value.store.listInteractions({ sessionId, limit: 10 })).toHaveLength(5);
    for (const interaction of value.store.listInteractions({ sessionId, limit: 10 })) {
      expect(interaction).toMatchObject({
        state: "expired",
        revision: 4,
        intendedTerminalState: "expired",
        deadlineAt: 51_000,
      });
    }
    expect(value.store.nextInteractionDeadlineAt()).toBeNull();
    await value.service.close();
  });

  test("backs off a persistent deadline maintenance fault and later recovers", async () => {
    const now = 60_000;
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Deadline retry");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const originalExpire = value.store.expireInteraction.bind(value.store);
    (value.store as unknown as { expireInteraction: StateStore["expireInteraction"] }).expireInteraction = () => {
      throw new Error("injected durable terminalization fault");
    };
    value.codex.validateInteractionTimeoutError = new CodexError(
      "AUTHORITY_STALE",
      "injected stale provider",
    );
    const connectionId = "43000000-0000-4000-8000-000000000001";
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number", value: 1 },
        method: "item/commandExecution/requestApproval",
        requestDigest: "f".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-retry",
        itemId: "item-retry",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Allow retry test",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        allowsSessionApproval: false,
      },
      timeoutMs: 0,
      requestedAt: now,
      deadlineAt: now,
    });
    await Bun.sleep(25);
    expect(value.codex.validatedInteractionTimeouts.length).toBeLessThanOrEqual(1);
    (value.store as unknown as { expireInteraction: StateStore["expireInteraction"] }).expireInteraction = originalExpire;
    expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 1, failed: 0 });
    expect(value.store.listInteractions({ sessionId, pendingOnly: true })).toEqual([]);
    await value.service.close();
  });

  test("keeps invalid permission grants pending and supports the fail-safe decline path", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Permission broker");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "45000000-0000-4000-8000-000000000001";
    const request = async (requestId: string) => {
      const provider = {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string" as const, value: requestId },
        method: "item/permissions/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: session.providerThreadId as string,
        turnId: "turn-permission",
        itemId: `item-${requestId}`,
        approvalId: null,
      };
      await value.service.observeCodexFact(authority, {
        type: "interactionRequested",
        connectionId,
        provider,
        kind: "permission_approval",
        blocking: true,
        display: {
          kind: "permission_approval",
          summary: "Allow requested permissions",
          reason: "The provider needs a bounded capability",
          requested: [{ name: "network" }, { name: "fileSystem" }],
          allowsSessionScope: true,
        },
      });
      const interaction = value.store.listInteractions({
        sessionId,
        pendingOnly: true,
        limit: 10,
      }).find((candidate) => candidate.authority.requestId.value === requestId);
      if (interaction === undefined) throw new Error("Expected a permission interaction.");
      return interaction;
    };

    const grant = await request("permission-grant-1");
    value.codex.validateInteractionResolutionError = new CodexError(
      "INVALID_INPUT",
      "selected permissions exceed the requested profile",
    );
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: grant.publicId,
      expectedRevision: grant.revision,
      resolution: {
        kind: "permission_grant",
        permissions: ["fileSystem"],
        scope: "turn",
      },
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(value.store.requireInteraction(grant.publicId)).toMatchObject({
      state: "pending",
      revision: 1,
      responseDigest: null,
    });
    expect(value.codex.resolvedInteractions).toHaveLength(0);

    delete value.codex.validateInteractionResolutionError;
    const corrected = await value.service.execute({
      kind: "interaction.resolve",
      interaction: grant.publicId,
      expectedRevision: grant.revision,
      resolution: {
        kind: "permission_grant",
        permissions: ["network"],
        scope: "turn",
      },
    }, { signal });
    expect(corrected).toMatchObject({
      interaction: { id: grant.publicId, state: "response_written", revision: 3 },
    });

    const declined = await request("permission-decline-1");
    const declineResult = await value.service.execute({
      kind: "interaction.resolve",
      interaction: declined.publicId,
      expectedRevision: declined.revision,
      resolution: { kind: "approval_decision", decision: "decline" },
    }, { signal });
    expect(declineResult).toMatchObject({
      interaction: { id: declined.publicId, state: "response_written", revision: 3 },
    });
    expect(value.codex.resolvedInteractions.at(-1)?.resolution).toEqual({
      kind: "approval_decision",
      decision: "decline",
    });
    await value.service.observeCodexFact(authority, {
      type: "interactionResolved",
      connectionId,
      provider: declined.authority,
      kind: "permission_approval",
    });
    expect(value.store.requireInteraction(declined.publicId)).toMatchObject({
      state: "declined",
      intendedTerminalState: "declined",
      revision: 4,
    });
    const canceled = await request("permission-cancel-1");
    await value.service.execute({
      kind: "interaction.resolve",
      interaction: canceled.publicId,
      expectedRevision: canceled.revision,
      resolution: { kind: "approval_decision", decision: "cancel" },
    }, { signal });
    await value.service.observeCodexFact(authority, {
      type: "interactionResolved",
      connectionId,
      provider: canceled.authority,
      kind: "permission_approval",
    });
    expect(value.store.requireInteraction(canceled.publicId)).toMatchObject({
      state: "canceled",
      intendedTerminalState: "canceled",
      revision: 4,
    });
    expect(value.codex.validatedInteractions).toHaveLength(4);
  });

  test("marks a response-write failure unknown and expires untouched prompts on disconnect", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Interaction recovery");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "50000000-0000-4000-8000-000000000001";
    const request = async (requestId: string) => {
      const provider = {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string" as const, value: requestId },
        method: "item/fileChange/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: session.providerThreadId as string,
        turnId: "turn-file",
        itemId: `item-${requestId}`,
        approvalId: null,
      };
      await value.service.observeCodexFact(authority, {
        type: "interactionRequested",
        connectionId,
        provider,
        kind: "file_change_approval",
        blocking: true,
        display: {
          kind: "file_change_approval",
          summary: "Apply reviewed changes",
          reason: null,
          grantRoot: null,
          allowsSessionApproval: false,
        },
      });
      return provider;
    };
    await request("file-request-1");
    const first = value.store.listInteractions({ sessionId, pendingOnly: true, limit: 10 })[0];
    if (first === undefined) throw new Error("Expected the first interaction.");
    value.codex.resolveInteractionError = new CodexError(
      "INDETERMINATE_EFFECT",
      "the response write may have reached Codex",
    );
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: first.publicId,
      expectedRevision: first.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.requireInteraction(first.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 3,
    });
    delete value.codex.resolveInteractionError;
    await request("file-request-2");
    const second = value.store.listInteractions({ sessionId, pendingOnly: true, limit: 10 })[0];
    if (second === undefined) throw new Error("Expected the second interaction.");
    await value.service.observeCodexFact(authority, {
      type: "providerDisconnected",
      connectionId,
      reason: "process_exit",
    });
    expect(value.store.requireProfileById(profile.id).processGeneration).toBe(
      profile.processGeneration + 1,
    );
    const replacementAuthority = {
      ...authority,
      generation: authority.generation + 1,
    };
    const replacementConnectionId = "50000000-0000-4000-8000-000000000099";
    await value.service.observeCodexFact(replacementAuthority, {
      type: "assistantDelta",
      connectionId: replacementConnectionId,
      threadId: session.providerThreadId,
      turnId: "turn-after-restart",
      itemId: "assistant-after-restart",
      text: "new generation visible",
    });
    const eventsAfterReplacement = value.store.listSessionEvents({
      sessionId,
      afterSequence: null,
      limit: 200,
    }).events;
    await value.service.observeCodexFact(authority, {
      type: "assistantDelta",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-before-restart",
      itemId: "assistant-before-restart",
      text: "stale generation hidden",
    });
    expect(value.store.listSessionEvents({
      sessionId,
      afterSequence: null,
      limit: 200,
    }).events).toEqual(eventsAfterReplacement);
    expect(JSON.stringify(eventsAfterReplacement)).toContain("new generation visible");
    expect(JSON.stringify(eventsAfterReplacement)).not.toContain("stale generation hidden");
    expect(value.store.requireInteraction(second.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    const bodies = value.store.listSessionEvents({
      sessionId,
      afterSequence: null,
      limit: 200,
    }).events.map((event) => event.body.type);
    expect(bodies).toContain("gap");
    expect(bodies).toContain("interaction_state");
  });

  test("closes fact admission before draining and never dispatches a queued turn from a late completion", async () => {
    const { service, codex, daemonAuthority, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Shutdown authority" }, { signal }) as { account: { id: `acct_${string}`; processGeneration: number } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "active" }, { signal });
    const queued = await service.execute({ kind: "session.queue", session: started.session.id, message: "must remain queued" }, { signal }) as { queued: { id: string } };
    let releaseFact!: () => void;
    let signalFactAdmitted!: () => void;
    const factGate = new Promise<void>((resolve) => { releaseFact = resolve; });
    const factAdmitted = new Promise<void>((resolve) => { signalFactAdmitted = resolve; });
    let gated = false;
    daemonAuthority.beforeAssert = async () => {
      if (gated) return;
      gated = true;
      signalFactAdmitted();
      await factGate;
    };
    const authority: ProfileAuthority = {
      id: added.account.id,
      generation: 1,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const fact = service.observeCodexFact(authority, {
      type: "turnCompleted",
      threadId: started.session.providerThreadId,
      turn: { id: "turn-next", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 },
    });
    await factAdmitted;

    let closeSettled = false;
    const closing = service.close().then(() => { closeSettled = true; });
    await service.observeCodexFact(authority, {
      type: "turnCompleted",
      threadId: started.session.providerThreadId,
      turn: { id: "late-turn", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 },
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseFact();
    await expect(fact).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    await closing;

    expect(daemonAuthority.closeCalls).toBe(1);
    expect(codex.closeCalls).toBe(1);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", activeTurnId: "turn-next" });
    expect(store.nextPendingQueue(started.session.id)).toMatchObject({ id: queued.queued.id, state: "pending" });
    await expect(service.execute({ kind: "daemon.status" }, { signal })).rejects.toThrow("no longer accepts operations");
  });
});
