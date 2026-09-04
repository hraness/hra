import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  CodexError,
  CodexRemoteError,
  IndeterminateCodexEffectError,
  type CodexFact,
  type CodexPluginCatalog,
} from "../codex";
import { parseFact } from "../codex/protocol";
import { CloudProjectionRecoveryAdmissionError } from "../cloud/contracts";
import { AccountKeyLossPreconditionError } from "../cloud/local-control";
import {
  CloudDaemonJournalRecoveryBlocker,
  createCloudProjectionRecoveryTerminalReceipt,
  MemoryCloudDaemonJournal,
  transitionCloudProjectionRecovery,
  type CloudProjectionRecoveryJournalEntry,
} from "../cloud/daemon-journal";
import { renderSuccess } from "../cli/render";
import { localCommandSchema, type LocalCommand } from "../domain/contracts";
import {
  PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES,
  encodeProtectedInteractionDetailDocument,
  protectedInteractionDetailDocumentSchema,
  publicInteractionSchema,
  type InteractionRecord,
  type InteractionResolution,
  type PublicInteraction,
} from "../domain/interactions";
import { sessionStatusSchema, type SessionStatus } from "../domain/observation";
import type { Preset } from "../domain/presets";
import type { EffectiveRuntimeProfile } from "../domain/runtime-profile";
import {
  SESSION_EVENT_RETAIN_AGE_MS,
  sessionEventPageSchema,
} from "../domain/session-events";
import {
  createStoredAccountUsageSnapshot,
  storedAccountUsageSnapshotSchema,
} from "../domain/usage-metrics";
import { initializeStatePaths, profilePaths, resolveStatePaths } from "../storage/paths";
import { StateStore } from "../storage/state-store";
import { DaemonAuthoritySafetyError } from "./daemon-lock";
import type {
  HraFactsMemoryLifecyclePort,
  HraFactsMemoryLifecycleReceipt,
} from "./facts-memory-lifecycle";
import { CodexSessionObservationError, UnavailableCloudControl, type CloudControlPort, type CodexAccountProjection, type CodexLoginOutcome, type CodexRuntimePort, type CodexSessionProjection, type CompactProjectionRecoveryBlocker, type DesktopSwitchPort, type ProfileAuthority, type RuntimeStartReview } from "./ports";
import { SessionEventCursorCodec } from "./session-event-cursor";
import { CommandFailure, FACTS_MEMORY_SESSION_TTL_MS, HraService } from "./service";
import { USAGE_HISTORY_CURSOR_TTL_MS } from "./usage-history-cursor";

const privatePathRoot = ["", "Users", "private"].join("/");

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
  readonly observedThreads: string[] = [];
  readonly freshThreads = new Set<string>();
  readonly turnEffectTrace: string[] = [];
  beforeObserveReturn?: () => Promise<void>;
  observeError?: Error;
  observeErrorOnce?: Error;
  observationConnectionId = "30000000-0000-4000-8000-000000000001";
  observationThreadIdOverride?: string;
  activeObservations = 0;
  maximumConcurrentObservations = 0;
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
  beforeResolveInteractionReturn?: () => Promise<void>;
  validateInteractionResolutionError?: Error;
  beforeValidateInteractionResolutionReturn?: () => Promise<void>;
  validateInteractionTimeoutError?: Error;
  timeoutInteractionError?: Error;
  readonly validatedInteractions: Array<Parameters<CodexRuntimePort["validateInteractionResolution"]>[0]> = [];
  readonly resolvedInteractions: Array<Parameters<NonNullable<CodexRuntimePort["resolveInteraction"]>>[0]> = [];
  readonly validatedInteractionTimeouts: Array<Parameters<CodexRuntimePort["validateInteractionTimeout"]>[0]> = [];
  readonly timedOutInteractions: Array<Parameters<CodexRuntimePort["timeoutInteraction"]>[0]> = [];
  readonly inspectedInteractions: Array<Parameters<CodexRuntimePort["inspectInteractionAuthority"]>[0]> = [];
  interactionAuthority: Awaited<ReturnType<CodexRuntimePort["inspectInteractionAuthority"]>> = {
    kind: "command_approval",
    command: "git status --short",
    reason: null,
    availableDecisions: ["accept", "decline", "cancel"],
    workingDirectory: "/workspace",
    environmentId: null,
    commandActions: null,
    networkApprovalContext: null,
    additionalPermissions: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
  };
  accountProjection: CodexAccountProjection = { signedIn: true, email: "person@example.com", plan: "Plus" };
  usageResult: { revision: number; observedAt: number; payload: unknown } = { revision: 1, observedAt: 2_000, payload: { primary: { usedPercent: 25 } } };
  readonly usageResults: Array<{ revision: number; observedAt: number; payload: unknown }> = [];
  usageError: Error | undefined;
  beforeReadUsageReturn?: () => Promise<void>;
  resetOutcome: "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit" = "reset";
  resetError: Error | undefined;
  beforeResetReturn?: () => Promise<void>;
  readonly resetIdempotencyKeys: string[] = [];
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
  listedNextCursor: string | null = null;
  readonly sessionListRequests: Array<Parameters<CodexRuntimePort["listSessions"]>[0]> = [];
  loginResult: CodexLoginOutcome = { status: "signed_in", account: { signedIn: true, email: "person@example.com", plan: "Plus" } };
  cancelLoginResult: { status: "canceled" | "not_found" } = { status: "canceled" };
  beforeLoginReturn?: (input: { authority: ProfileAuthority; method: "browser" | "device_code" }) => Promise<void>;
  beforeCancelLoginReturn: (() => Promise<void>) | undefined = undefined;
  beforeReadAccountReturn?: () => Promise<void>;
  async login(input: { authority: ProfileAuthority; method: "browser" | "device_code" }): Promise<CodexLoginOutcome> { this.calls.push(`login:${input.authority.id}:${input.authority.generation}:${input.method}`); await this.beforeLoginReturn?.(input); return this.loginResult; }
  async cancelLogin(input: { authority: ProfileAuthority; loginId: string }): Promise<{ status: "canceled" | "not_found" }> { this.calls.push(`login-cancel:${input.authority.id}:${input.authority.generation}:${input.loginId}`); await this.beforeCancelLoginReturn?.(); return this.cancelLoginResult; }
  async logout(): Promise<void> { this.calls.push("logout"); await this.beforeLogoutReturn?.(); if (this.logoutError !== undefined) throw this.logoutError; }
  async readAccount(): Promise<CodexAccountProjection> { this.calls.push("readAccount"); await this.beforeReadAccountReturn?.(); return this.accountProjection; }
  async listPlugins(input: Parameters<CodexRuntimePort["listPlugins"]>[0]): Promise<CodexPluginCatalog> {
    this.calls.push("plugins");
    this.pluginRequests.push(input);
    return this.pluginCatalog;
  }
  async readUsage(): Promise<{ revision: number; observedAt: number; payload: unknown }> {
    this.calls.push("usage");
    await this.beforeReadUsageReturn?.();
    if (this.usageError !== undefined) throw this.usageError;
    return this.usageResults.shift() ?? this.usageResult;
  }
  async consumeRateLimitReset(
    input: Parameters<CodexRuntimePort["consumeRateLimitReset"]>[0],
  ): ReturnType<CodexRuntimePort["consumeRateLimitReset"]> {
    this.calls.push("reset");
    this.resetIdempotencyKeys.push(input.idempotencyKey);
    await this.beforeResetReturn?.();
    if (this.resetError !== undefined) throw this.resetError;
    return this.resetOutcome;
  }
  async listSessions(input: Parameters<CodexRuntimePort["listSessions"]>[0]): ReturnType<CodexRuntimePort["listSessions"]> {
    this.calls.push("list");
    this.sessionListRequests.push(input);
    return { sessions: this.listedProjections, nextCursor: this.listedNextCursor };
  }
  async reviewSessionStart(input: { authority: ProfileAuthority; preset: Preset; fast: boolean }): Promise<RuntimeStartReview> {
    this.calls.push("review-session");
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
    this.freshThreads.add(this.readProjection.providerThreadId);
    return { ...this.readProjection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async observeSession(input: Parameters<CodexRuntimePort["observeSession"]>[0]): ReturnType<CodexRuntimePort["observeSession"]> {
    this.calls.push("observe");
    this.observedThreads.push(input.providerThreadId);
    this.activeObservations += 1;
    this.maximumConcurrentObservations = Math.max(
      this.maximumConcurrentObservations,
      this.activeObservations,
    );
    const oneShotError = this.observeErrorOnce;
    delete this.observeErrorOnce;
    try {
      await this.beforeObserveReturn?.();
      if (oneShotError !== undefined) throw oneShotError;
      if (this.observeError !== undefined) throw this.observeError;
      return {
        connectionId: this.observationConnectionId,
        projection: {
          ...this.readProjection,
          providerThreadId: this.observationThreadIdOverride ?? input.providerThreadId,
        },
        resumed: !this.freshThreads.has(input.providerThreadId),
      };
    } finally {
      this.activeObservations -= 1;
    }
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
    this.calls.push("review-turn");
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
  async inspectInteractionAuthority(
    input: Parameters<CodexRuntimePort["inspectInteractionAuthority"]>[0],
  ): ReturnType<CodexRuntimePort["inspectInteractionAuthority"]> {
    this.inspectedInteractions.push(input);
    return this.interactionAuthority;
  }
  async resolveInteraction(
    input: Parameters<NonNullable<CodexRuntimePort["resolveInteraction"]>>[0],
  ): Promise<{ responseWritten: true }> {
    this.resolvedInteractions.push(input);
    await this.beforeResolveInteractionReturn?.();
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
    await this.beforeValidateInteractionResolutionReturn?.();
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
  beforeProjectionUnsettledSessionReturn?: (sessionPublicId: `sess_${string}`) => Promise<void>;
  beforeProjectionUnsettledProfileReturn?: (
    profileId: Parameters<CloudControlPort["isCompactProjectionRecoveryUnsettledForProfile"]>[0],
  ) => Promise<void>;
  projectionRecoveryResult: unknown = { phase: "applied", compactStreamEpoch: 1 };
  projectionRecoveryBlocker?: CompactProjectionRecoveryBlocker;
  readonly unsettledProjectionProfiles = new Set<string>();
  readonly unsettledProjectionSessions = new Set<string>();
  readonly providerDeletionSupersessions: string[] = [];
  readonly providerDeletionSupersededSessions = new Set<string>();
  projectionRecoveryError?: CloudProjectionRecoveryAdmissionError;
  authResult: unknown = { requested: true };
  deleteAccountResult: unknown = {
    daemonRestartRequired: true,
    deletion: { effectsDisabled: true, state: "pending", statusFresh: true },
  };
  deleteAccountCalls = 0;
  keyLossCalls = 0;
  keyLossError?: AccountKeyLossPreconditionError;
  readonly deviceApprovalFingerprints: string[] = [];
  readonly deviceMutations: Array<Readonly<{
    device: string;
    idempotencyKey: string;
    kind: "approve" | "revoke";
    signal: AbortSignal;
  }>> = [];
  readonly loseNextDeviceMutationResponses = new Set<"approve" | "revoke">();
  readonly #deviceMutationReceipts = new Map<string, Readonly<{
    device: string;
    kind: "approve" | "revoke";
    result: Readonly<{
      approved?: true;
      device: string;
      idempotencyKey: string;
      revoked?: true;
    }>;
  }>>();
  statusError?: unknown;
  statusResult: unknown = { configured: true };
  async status(): Promise<unknown> {
    if (this.statusError !== undefined) {
      throw this.statusError instanceof Error
        ? this.statusError
        : new Error("Fake cloud status failed.");
    }
    return this.statusResult;
  }
  async sync(): Promise<unknown> { return { synced: true }; }
  async isCompactProjectionRecoveryUnsettled(sessionPublicId: `sess_${string}`): Promise<boolean> {
    await this.beforeProjectionUnsettledSessionReturn?.(sessionPublicId);
    return this.projectionRecoveryBlocker === undefined
      ? this.unsettledProjectionSessions.has(sessionPublicId)
      : await this.projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettled(sessionPublicId);
  }
  async isCompactProjectionRecoveryUnsettledForProfile(
    profileId: Parameters<CloudControlPort["isCompactProjectionRecoveryUnsettledForProfile"]>[0],
  ): Promise<boolean> {
    await this.beforeProjectionUnsettledProfileReturn?.(profileId);
    return this.projectionRecoveryBlocker === undefined
      ? this.unsettledProjectionProfiles.has(profileId)
      : await this.projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettledForProfile(profileId);
  }
  async recoverCompactProjection(input: { sessionPublicId: `sess_${string}`; idempotencyKey: string; acknowledgeGap: true; signal: AbortSignal }): Promise<unknown> {
    if (this.projectionRecoveryError !== undefined) throw this.projectionRecoveryError;
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
  async acknowledgeNoAccountKeyHolders(): Promise<unknown> {
    this.keyLossCalls += 1;
    if (this.keyLossError !== undefined) throw this.keyLossError;
    return { acknowledgedNoKeyHolders: true, localOnly: true };
  }
  async approveDevice(
    device: string,
    idempotencyKey: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.deviceApprovalFingerprints.push(fingerprint);
    return await this.#mutateDevice("approve", device, idempotencyKey, signal);
  }
  async revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown> {
    return await this.#mutateDevice("revoke", device, idempotencyKey, signal);
  }

  async #mutateDevice(
    kind: "approve" | "revoke",
    device: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.deviceMutations.push({ device, idempotencyKey, kind, signal });
    const receipt = this.#deviceMutationReceipts.get(idempotencyKey);
    if (receipt !== undefined) {
      if (receipt.kind !== kind || receipt.device !== device) {
        throw new Error("Cloud device mutation idempotency key was reused for a different request.");
      }
      return { ...receipt.result, replay: true };
    }
    const result = kind === "approve"
      ? { approved: true as const, device, idempotencyKey }
      : { device, idempotencyKey, revoked: true as const };
    this.#deviceMutationReceipts.set(idempotencyKey, { device, kind, result });
    if (this.loseNextDeviceMutationResponses.delete(kind)) {
      throw new Error(`Lost local device ${kind} response.`);
    }
    return result;
  }
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

class FakeFactsMemoryLifecycle implements HraFactsMemoryLifecyclePort {
  readonly cleanups: Array<Parameters<HraFactsMemoryLifecyclePort["cleanupSession"]>[0]> = [];
  readonly ensures: Array<Parameters<HraFactsMemoryLifecyclePort["ensureSession"]>[0]> = [];
  readonly sweeps: number[] = [];
  readonly epochs = new Map<string, number>();
  readonly expiries = new Map<string, number>();
  readonly states = new Map<string, "active" | "purged">();
  readonly cleanupErrors = new Set<string>();
  ensureErrorOnce: Error | undefined;
  simulateExpiry = false;

  #receipt(sessionId: string, state: HraFactsMemoryLifecycleReceipt["state"] = "active"): HraFactsMemoryLifecycleReceipt {
    return {
      bindingDigest: "a".repeat(64),
      epoch: this.epochs.get(sessionId) ?? 1,
      handleHash: state === "purged" ? null : "b".repeat(64),
      head: state === "purged" ? null : {
        digest: "c".repeat(64),
        operationSha256: null,
        sequence: 0,
      },
      sessionId,
      state,
    };
  }

  async cleanupSession(input: Parameters<HraFactsMemoryLifecyclePort["cleanupSession"]>[0]) {
    this.cleanups.push(input);
    if (this.cleanupErrors.has(input.sessionId)) throw new Error("poisoned terminal cleanup");
    this.states.set(input.sessionId, "purged");
    return this.#receipt(input.sessionId, "purged");
  }

  async ensureSession(input: Parameters<HraFactsMemoryLifecyclePort["ensureSession"]>[0]) {
    this.ensures.push(input);
    const error = this.ensureErrorOnce;
    this.ensureErrorOnce = undefined;
    if (error !== undefined) throw error;
    if (this.states.get(input.sessionId) !== "active") {
      this.epochs.set(input.sessionId, (this.epochs.get(input.sessionId) ?? 0) + 1);
      this.states.set(input.sessionId, "active");
    }
    this.expiries.set(
      input.sessionId,
      Math.max(this.expiries.get(input.sessionId) ?? 0, input.expiresAt),
    );
    return this.#receipt(input.sessionId);
  }

  async forkSession(input: Parameters<HraFactsMemoryLifecyclePort["forkSession"]>[0]) {
    return this.#receipt(input.childSessionId);
  }

  async resumeSession(input: Parameters<HraFactsMemoryLifecyclePort["resumeSession"]>[0]) {
    return this.#receipt(input.sessionId);
  }

  async sweepExpired(now: number) {
    this.sweeps.push(now);
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
  factsMemory?: HraFactsMemoryLifecyclePort,
): Promise<{ service: HraService; store: StateStore; codex: FakeCodex; cloud: FakeCloud; daemonAuthority: FakeDaemonAuthority; documents: string; eventCursors: SessionEventCursorCodec; paths: ReturnType<typeof resolveStatePaths> }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-service-")));
  serviceRoots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  const documents = join(home, "Documents");
  await mkdir(documents, { recursive: true });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now });
  stores.push(store);
  // The daemon defaults to answering approvals itself; these tests exercise
  // the manual paths and opt in to autorespond explicitly where needed.
  store.setDefaultApprovalMode("manual");
  const codex = new FakeCodex();
  const daemonAuthority = new FakeDaemonAuthority();
  const eventCursors = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
  return { service: new HraService({ store, paths, codex, cloud, daemonAuthority, ...(desktop === undefined ? {} : { desktop }), eventCursors, ...(factsMemory === undefined ? {} : { factsMemory }), now, requestStop }), store, codex, cloud, daemonAuthority, documents, eventCursors, paths };
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

function seedUnsettledInteractionStates(
  value: Awaited<ReturnType<typeof fixture>>,
  sessionId: `sess_${string}`,
  connectionId: string,
  prefix: string,
) {
  const session = value.store.requireSession(sessionId);
  const profile = value.store.requireProfileById(session.profileId);
  if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
  const providerThreadId = session.providerThreadId;
  const admit = (state: "pending" | "prepared" | "written") => value.store.admitInteraction({
    publicId: crypto.randomUUID(),
    sessionId,
    authority: {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId,
      requestId: { type: "string", value: `${prefix}-${state}` },
      method: "item/fileChange/requestApproval",
      requestDigest: createHash("sha256").update(`${prefix}-${state}`).digest("hex"),
      threadId: providerThreadId,
      turnId: `${prefix}-turn`,
      itemId: `${prefix}-${state}-item`,
      approvalId: null,
    },
    kind: "file_change_approval",
    blocking: true,
    display: {
      kind: "file_change_approval",
      summary: `Recover ${state} response state`,
      reason: null,
      grantRoot: null,
      availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
    },
  }).record;
  const pending = admit("pending");
  const prepared = value.store.prepareInteractionResponse({
    id: admit("prepared").publicId,
    expectedRevision: 1,
    responseDigest: "a".repeat(64),
  });
  const preparedForWrite = value.store.prepareInteractionResponse({
    id: admit("written").publicId,
    expectedRevision: 1,
    responseDigest: "b".repeat(64),
  });
  const written = value.store.markInteractionResponseWritten({
    id: preparedForWrite.publicId,
    expectedRevision: preparedForWrite.revision,
    responseDigest: "b".repeat(64),
  });
  return { pending, prepared, written, profile, session };
}

async function seedResolvableInteraction(
  value: Awaited<ReturnType<typeof fixture>>,
  sessionId: `sess_${string}`,
  requestId: string,
  timing?: Readonly<{ requestedAt: number; deadlineAt: number }>,
): Promise<Readonly<{
  authority: ProfileAuthority;
  interaction: InteractionRecord;
}>> {
  const session = value.store.requireSession(sessionId);
  const profile = value.store.requireProfileById(session.profileId);
  if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
  const connectionId = crypto.randomUUID();
  const authority: ProfileAuthority = {
    id: profile.id,
    generation: profile.processGeneration,
    codexHome: "unused",
    desktopUserData: "unused",
  };
  await value.service.observeCodexFact(authority, {
    type: "interactionRequested",
    connectionId,
    provider: {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId,
      requestId: { type: "string", value: requestId },
      method: "item/commandExecution/requestApproval",
      requestDigest: createHash("sha256").update(requestId).digest("hex"),
      threadId: session.providerThreadId,
      turnId: `turn-${requestId}`,
      itemId: `item-${requestId}`,
      approvalId: null,
    },
    kind: "command_approval",
    blocking: true,
    display: {
      kind: "command_approval",
      summary: "Exercise the persistence boundary",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: ["once", "decline", "cancel"],
    },
    ...(timing === undefined ? {} : timing),
  });
  const interaction = value.store.listInteractions({
    sessionId,
    pendingOnly: true,
    limit: 10,
  }).find((candidate) => candidate.authority.requestId.value === requestId);
  if (interaction === undefined) throw new Error("Expected a resolvable interaction.");
  return { authority, interaction };
}

const providerMutationCalls = (codex: FakeCodex): readonly string[] => codex.calls.filter(
  (call) => call.startsWith("login:") || call.startsWith("start:") || call === "logout" || call === "send" || call === "steer" || call === "stop" || call === "rename",
);

const signal = new AbortController().signal;
const automaticResetWindowResetsAtSeconds = Math.floor(Date.now() / 1_000)
  + 3 * 24 * 60 * 60;
const automaticResetWindowResetsAt = automaticResetWindowResetsAtSeconds * 1_000;

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
  test("forwards one caller UUIDv7 through lost device responses and exact replays", async () => {
    for (const kind of ["approve", "revoke"] as const) {
      const cloud = new FakeCloud();
      const { service } = await fixture(undefined, cloud);
      const idempotencyKey = kind === "approve"
        ? "018bcfe5-6800-7000-8000-000000000041"
        : "018bcfe5-6800-7000-8000-000000000042";
      const command = kind === "approve"
        ? {
            device: "device_approve",
            fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777",
            idempotencyKey,
            kind: "device.approve",
          } as const
        : {
            device: "device_revoke",
            idempotencyKey,
            kind: "device.revoke",
          } as const;
      cloud.loseNextDeviceMutationResponses.add(kind);

      await expect(service.execute(command, { signal }))
        .rejects.toThrow(`Lost local device ${kind} response.`);
      await expect(service.execute(command, { signal })).resolves.toMatchObject({
        device: command.device,
        idempotencyKey,
        replay: true,
      });
      expect(cloud.deviceMutations).toEqual([
        { device: command.device, idempotencyKey, kind, signal },
        { device: command.device, idempotencyKey, kind, signal },
      ]);
    }
  });

  test("rejects a device caller key reused across targets or operations", async () => {
    const cloud = new FakeCloud();
    const { service } = await fixture(undefined, cloud);
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000043";
    await expect(service.execute({
      device: "device_original",
      fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777",
      idempotencyKey,
      kind: "device.approve",
    }, { signal })).resolves.toMatchObject({ approved: true, idempotencyKey });

    await expect(service.execute({
      device: "device_changed",
      fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777",
      idempotencyKey,
      kind: "device.approve",
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.execute({
      device: "device_original",
      idempotencyKey,
      kind: "device.revoke",
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("maps every expected account-key loss precondition to a closed actionable failure", async () => {
    const cases = [
      {
        failure: "signed_out",
        code: "INTERACTION_REQUIRED",
        nextCommand: "hra auth login --input-stdin",
      },
      {
        failure: "device_unregistered",
        code: "INTERACTION_REQUIRED",
        nextCommand: "hra device pair",
      },
      {
        failure: "observation_missing",
        code: "INTERACTION_REQUIRED",
        nextCommand: "hra auth status",
      },
      {
        failure: "already_ready",
        code: "CONFLICT",
        nextCommand: "hra auth status",
      },
      {
        failure: "auth_identity_unbound",
        code: "RECOVERY_REQUIRED",
        nextCommand: "hra auth status",
      },
      {
        failure: "authority_changed",
        code: "RECOVERY_REQUIRED",
        nextCommand: "hra auth status",
      },
    ] as const;
    const cloud = new FakeCloud();
    const { service } = await fixture(undefined, cloud);
    for (const expected of cases) {
      cloud.keyLossError = new AccountKeyLossPreconditionError(expected.failure);
      await expect(service.execute({
        acknowledgeNoKeyHolders: true,
        kind: "device.key-loss",
      }, { signal })).rejects.toMatchObject({
        code: expected.code,
        details: { nextCommand: expected.nextCommand },
        name: "CommandFailure",
      });
    }
    expect(cloud.keyLossCalls).toBe(cases.length);
  });

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

  test("shows a pristine signed-out account without touching Codex", async () => {
    const { service, codex } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Pristine" },
      { signal },
    ) as { account: { id: string } };

    await expect(service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: {
        id: added.account.id,
        label: "Pristine",
        processGeneration: 0,
        state: "signed_out",
      },
    });
    expect(codex.calls).toEqual([]);
  });

  test("returns ID-only signed-out recovery guidance for provider operations", async () => {
    const { service, codex } = await fixture();
    const privateLabel = "Private provider account";
    const added = await service.execute(
      { kind: "account.add", label: privateLabel },
      { signal },
    ) as { account: { id: `acct_${string}` } };

    const failure = await service.execute({
      account: added.account.id,
      kind: "plugin.list",
      refresh: false,
    }, { signal }).catch((error: unknown) => error);
    if (!(failure instanceof CommandFailure)) throw new Error("Expected a signed-out CommandFailure.");
    expect(failure).toMatchObject({
      code: "INTERACTION_REQUIRED",
      details: {
        accountSelector: added.account.id,
        accountState: "signed_out",
        nextCommand: `hra account login ${added.account.id}`,
      },
      name: "CommandFailure",
    });
    expect(failure.message).not.toContain(privateLabel);
    expect(JSON.stringify(failure.details)).not.toContain(privateLabel);
    expect(codex.calls).toEqual([]);
  });

  test("lists a selected signed-out account's locally stored sessions without provider access", async () => {
    const { service, codex, documents } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Offline sessions" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await service.execute({
      kind: "project.add",
      label: "Offline docs",
      path: documents,
    }, { signal });
    const started = await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}` } };
    await service.execute({
      kind: "account.logout",
      account: added.account.id,
    }, { signal });
    const providerCallsBeforeList = codex.calls.length;

    const unfiltered = await service.execute({
      kind: "session.list",
      limit: 100,
    }, { signal }) as { sessions: readonly { id: string; profileId: string }[] };
    const selected = await service.execute({
      kind: "session.list",
      account: added.account.id,
      limit: 100,
    }, { signal });

    expect(selected).toEqual({
      accountId: added.account.id,
      sessions: unfiltered.sessions.filter((session) => session.profileId === added.account.id),
      nextCursor: null,
      listing: {
        accountSelector: added.account.id,
        accountState: "signed_out",
        scope: "local_only",
        freshness: "stale",
        localCompleteness: "complete",
        providerAccess: "not_attempted",
        providerCompleteness: "unknown",
        nextCommand: `hra account login ${added.account.id}`,
      },
    });
    expect(selected).toMatchObject({ sessions: [{ id: started.session.id }] });
    expect(codex.calls).toHaveLength(providerCallsBeforeList);
  });

  test("pages every signed-out local session with account-bound tamper-evident continuations", async () => {
    const { service, store, codex } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Retained local history" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    for (let index = 0; index < 105; index += 1) {
      store.createSession({
        profileId: added.account.id,
        title: `Local retained ${String(index).padStart(3, "0")}`,
        preset: "high",
        fastEnabled: false,
      });
    }

    const ids: string[] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    let finalListing: unknown;
    do {
      const page = await service.execute({
        kind: "session.list",
        account: added.account.id,
        limit: 37,
        ...(cursor === undefined ? {} : { cursor }),
      }, { signal }) as {
        sessions: readonly { id: string }[];
        nextCursor: string | null;
        listing: unknown;
      };
      ids.push(...page.sessions.map((session) => session.id));
      firstCursor ??= page.nextCursor ?? undefined;
      cursor = page.nextCursor ?? undefined;
      finalListing = page.listing;
    } while (cursor !== undefined);

    expect(ids).toHaveLength(105);
    expect(new Set(ids).size).toBe(105);
    expect(firstCursor).toStartWith("hra1.");
    expect(finalListing).toEqual({
      accountSelector: added.account.id,
      accountState: "signed_out",
      scope: "local_only",
      freshness: "stale",
      localCompleteness: "complete",
      providerAccess: "not_attempted",
      providerCompleteness: "unknown",
      nextCommand: `hra account login ${added.account.id}`,
    });
    expect(codex.calls).toEqual([]);

    if (firstCursor === undefined) throw new Error("Expected a local continuation.");
    const other = await service.execute(
      { kind: "account.add", label: "Other retained history" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await expect(service.execute({
      kind: "session.list",
      account: other.account.id,
      limit: 37,
      cursor: firstCursor,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.execute({
      kind: "session.list",
      account: added.account.id,
      limit: 36,
      cursor: firstCursor,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const replacement = firstCursor.at(-1) === "A" ? "B" : "A";
    await expect(service.execute({
      kind: "session.list",
      account: added.account.id,
      limit: 37,
      cursor: `${firstCursor.slice(0, -1)}${replacement}`,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(codex.calls).toEqual([]);
  });

  test("returns a stable conflict for a duplicate non-ASCII case-insensitive account label", async () => {
    const { service, store } = await fixture();
    await service.execute({ kind: "account.add", label: "Équipe" }, { signal });

    const failure = await service.execute(
      { kind: "account.add", label: "équipe" },
      { signal },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "CONFLICT",
      message: "An active account already uses that label.",
      name: "CommandFailure",
    });
    expect(String(failure)).not.toContain("SQLite");
    expect(String(failure)).not.toContain("UNIQUE");
    expect(String(failure)).not.toContain("profiles_label_active");
    expect(String(failure)).not.toContain("profiles_label_key_active");
    expect(store.listProfiles()).toHaveLength(1);
  });

  test("returns a stable conflict for a canonically equivalent project label", async () => {
    const { service, store, documents } = await fixture();
    const secondRoot = join(documents, "Other");
    await mkdir(secondRoot, { recursive: true });
    await service.execute({
      kind: "project.add",
      label: "Café",
      path: documents,
    }, { signal });

    const failure = await service.execute({
      kind: "project.add",
      label: "Cafe\u0301",
      path: secondRoot,
    }, { signal }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "CONFLICT",
      message: "A project already uses that label.",
      name: "CommandFailure",
    });
    expect(String(failure)).not.toContain("SQLite");
    expect(String(failure)).not.toContain("UNIQUE");
    expect(String(failure)).not.toContain("projects_label_unique");
    expect(String(failure)).not.toContain("projects_label_key_unique");
    expect(store.listProjects()).toHaveLength(1);
  });

  test("returns a stable conflict when another label names the same project directory", async () => {
    const { service, store, documents } = await fixture();
    await service.execute({
      kind: "project.add",
      label: "Primary",
      path: documents,
    }, { signal });

    const failure = await service.execute({
      kind: "project.add",
      label: "Same directory",
      path: documents,
    }, { signal }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "CONFLICT",
      message: "A project already uses that directory.",
      name: "CommandFailure",
    });
    expect(String(failure)).not.toContain("SQLite");
    expect(String(failure)).not.toContain("UNIQUE");
    expect(store.listProjects()).toHaveLength(1);
  });

  test("maps an existing but noncanonical project root to actionable unavailability", async () => {
    const { service, store, documents } = await fixture();
    const linkedRoot = `${documents}-linked-private`;
    await symlink(documents, linkedRoot, "dir");

    await expect(service.execute({
      kind: "project.add",
      label: "Linked project",
      path: linkedRoot,
    }, { signal })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: {
        nextCommand: "hra doctor",
        repair: "repair_or_select_project",
      },
      message: "The project directory is missing, unsafe, or not readable, writable, traversable, and canonical. Repair it or choose another directory before retrying.",
    });
    expect(store.listProjects()).toHaveLength(0);
  });

  test("rejects a post-registration project symlink swap before Codex and reports it in both doctor modes", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Project custody" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    expect(store.setProfileState(added.account.id, 0, "signed_in")).toBe(true);
    await service.execute({
      kind: "project.add",
      label: "Custody docs",
      path: documents,
    }, { signal });
    const relocated = `${documents}-relocated-private`;
    await rename(documents, relocated);
    await symlink(relocated, documents, "dir");
    expect(codex.calls).toEqual([]);

    await expect(service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      fast: false,
    }, { signal })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: {
        nextCommand: "hra doctor",
        repair: "repair_or_select_project",
      },
    });
    expect(codex.calls).toEqual([]);
    expect(codex.calls).not.toContain("review-session");
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(0);
    expect(store.listSessions()).toHaveLength(0);

    const expectedProblem = "A configured project directory is missing or unsafe. Run `hra project list`, then restore or repair every listed directory so it is readable, writable, traversable, and canonical.";
    for (const offline of [true, false]) {
      const doctor = await service.execute({ kind: "doctor", offline }, { signal }) as {
        healthy: boolean;
        problems: readonly string[];
        state: { database: string; projects: number };
      };
      expect(doctor).toMatchObject({
        healthy: false,
        offline,
        state: { database: "ready", projects: 1 },
      });
      expect(doctor.problems).toContain(expectedProblem);
      expect(JSON.stringify(doctor)).not.toContain(documents);
      expect(JSON.stringify(doctor)).not.toContain(relocated);
    }
  });

  test("turns bounded projection and deployment status into actionable doctor health", async () => {
    const cloud = new FakeCloud();
    const { service, documents } = await fixture(undefined, cloud);
    await service.execute({ kind: "project.add", label: "Doctor docs", path: documents }, { signal });

    cloud.statusResult = {
      configured: true,
      projectionCache: {
        code: "CACHE_CORRUPT_OR_UNREADABLE",
        state: "unavailable",
      },
    };
    const unavailable = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(unavailable.healthy).toBe(false);
    expect(unavailable.problems).toContain(
      "The cloud projection cache is corrupt or unreadable. Run `hra session list`, choose each affected local session, then explicitly run `hra sync projection recover <session> --acknowledge-gap`.",
    );

    const affectedSession = `sess_${"3".repeat(32)}`;
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000703";
    cloud.statusResult = {
      configured: true,
      projectionCache: {
        affectedSessions: [affectedSession],
        affectedSessionsTruncated: false,
        code: "STREAM_RECOVERY_REQUIRED",
        sessions: 1,
        state: "degraded",
      },
      projectionRecovery: {
        recoveries: [{
          cacheActivated: false,
          idempotencyKey,
          phase: "effect_started",
          sessionPublicId: affectedSession,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      },
    };
    const unsettled = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(unsettled.healthy).toBe(false);
    expect(unsettled.problems).not.toContain(
      `Cloud transcript projection requires recovery for 1 session(s). Run \`hra sync projection recover ${affectedSession} --acknowledge-gap\`.`,
    );
    expect(unsettled.problems).toContain(
      `Cloud projection recovery is unsettled. Retry \`hra sync projection recover ${affectedSession} --acknowledge-gap --idempotency-key ${idempotencyKey}\`.`,
    );

    cloud.statusResult = {
      configured: true,
      projectionCache: { state: "ready" },
      projectionRecovery: {
        recoveries: Array.from({ length: 128 }, (_, index) => ({
          idempotencyKey: `018bcfe5-6800-7000-8000-${index.toString(16).padStart(12, "0")}`,
          phase: "rejected",
          sessionPublicId: `sess_${index.toString(16).padStart(32, "0")}`,
        })),
        recoveriesTruncated: true,
        totalRecoveries: 150,
      },
    };
    const boundedHistory = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(boundedHistory).toMatchObject({ healthy: true, problems: [] });

    cloud.statusResult = {
      configured: true,
      projectionCache: { state: "ready" },
      projectionRecovery: {
        recoveries: [],
        recoveriesTruncated: true,
        totalRecoveries: 150,
      },
    };
    const impossibleShortPage = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(impossibleShortPage.healthy).toBe(false);
    expect(impossibleShortPage.problems).toContain(
      "Cloud projection recovery status is invalid or exceeds its local bound. Restart the daemon, then rerun `hra doctor`.",
    );

    cloud.statusResult = {
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon. Unset HRA_CONVEX_URL and restart the daemon to use hosted sync.",
      projectionRecovery: {
        recoveries: [{
          cacheActivated: false,
          idempotencyKey,
          phase: "effect_started",
          sessionPublicId: affectedSession,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      },
      reenable: { kind: "use_hosted_default" },
      signedIn: false,
      unavailability: "disabled",
    };
    const disabledRecovery = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(disabledRecovery.healthy).toBe(false);
    expect(disabledRecovery.problems).toContain(
      `Cloud projection recovery is unsettled. Unset HRA_CONVEX_URL and restart the daemon first. After restart, retry \`hra sync projection recover ${affectedSession} --acknowledge-gap --idempotency-key ${idempotencyKey}\`.`,
    );

    cloud.statusResult = {
      ...(cloud.statusResult as Record<string, unknown>),
      diagnostic: "Cloud sync is disabled for this daemon. Restore this state root's bound HRA_CONVEX_URL deployment and restart the daemon.",
      reenable: {
        deploymentUrl: "https://bound.convex.cloud",
        kind: "restore_bound_deployment",
      },
    };
    const selfManagedRecovery = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(selfManagedRecovery.healthy).toBe(false);
    expect(selfManagedRecovery.problems).toContain(
      `Cloud projection recovery is unsettled. Set HRA_CONVEX_URL to https://bound.convex.cloud and restart the daemon first. After restart, retry \`hra sync projection recover ${affectedSession} --acknowledge-gap --idempotency-key ${idempotencyKey}\`.`,
    );

    cloud.statusResult = {
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon. Unset HRA_CONVEX_URL and restart the daemon to use hosted sync.",
      reenable: { kind: "use_hosted_default" },
      signedIn: false,
      unavailability: "disabled",
    };
    const intentionallyDisabled = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
    };
    expect(intentionallyDisabled.healthy).toBe(true);

    cloud.statusResult = {
      configured: false,
      diagnostic: "Cloud sync is unavailable because deployment custody requires recovery.",
      signedIn: false,
    };
    const custody = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(custody.healthy).toBe(false);
    expect(custody.problems).toContain(
      "Cloud deployment custody is unavailable. Run `hra sync status --json`, correct the reported deployment configuration or custody state, then restart the daemon.",
    );
  });

  test("imports every requested Codex session page and binds continuations to the resolved account filter", async () => {
    const value = await fixture();
    const firstAccount = await value.service.execute(
      { kind: "account.add", label: "Mutable label" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: firstAccount.account.id,
      deviceCode: false,
    }, { signal });
    value.codex.listedProjections = [{
      providerThreadId: "provider-newer",
      providerUpdatedAt: 20,
      status: "idle",
      title: "Newer provider thread",
    }];
    value.codex.listedNextCursor = "provider-page-2";

    const first = await value.service.execute({
      kind: "session.list",
      account: "Mutable label",
      limit: 1,
    }, { signal }) as {
      accountId: string;
      sessions: readonly { providerThreadId?: string; title: string }[];
      nextCursor: string;
    };
    expect(first).toMatchObject({
      accountId: firstAccount.account.id,
      sessions: [{ providerThreadId: "provider-newer", title: "Newer provider thread" }],
    });
    expect(first.nextCursor).toStartWith("hra1.");

    value.codex.listedProjections = [{
      providerThreadId: "provider-older",
      providerUpdatedAt: 10,
      status: "idle",
      title: "Older provider thread",
    }];
    value.codex.listedNextCursor = null;
    await expect(value.service.execute({
      kind: "session.list",
      account: firstAccount.account.id,
      cursor: first.nextCursor,
      limit: 1,
    }, { signal })).resolves.toMatchObject({
      accountId: firstAccount.account.id,
      nextCursor: null,
      sessions: [{ providerThreadId: "provider-older", title: "Older provider thread" }],
    });
    expect(value.codex.sessionListRequests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
      { cursor: undefined, limit: 1 },
      { cursor: "provider-page-2", limit: 1 },
    ]);
    const importedTitles = value.store.listSessions(10, firstAccount.account.id)
      .map((session) => session.title);
    expect(importedTitles).toHaveLength(2);
    expect(new Set(importedTitles)).toEqual(new Set([
      "Newer provider thread",
      "Older provider thread",
    ]));

    const callsBeforeInvalid = value.codex.sessionListRequests.length;
    const tampered = `${first.nextCursor.slice(0, -1)}${first.nextCursor.at(-1) === "A" ? "B" : "A"}`;
    await expect(value.service.execute({
      kind: "session.list",
      account: firstAccount.account.id,
      cursor: tampered,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(value.service.execute({
      kind: "session.list",
      account: firstAccount.account.id,
      cursor: first.nextCursor,
      limit: 2,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(value.service.execute({
      kind: "session.list",
      cursor: first.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const secondAccount = await value.service.execute(
      { kind: "account.add", label: "Other account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: secondAccount.account.id,
      deviceCode: false,
    }, { signal });
    await expect(value.service.execute({
      kind: "session.list",
      account: secondAccount.account.id,
      cursor: first.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(value.codex.sessionListRequests).toHaveLength(callsBeforeInvalid);
  });

  test("fails closed on a provider session-list cursor cycle before importing that page", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Paged account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });

    value.codex.listedProjections = [{
      providerThreadId: "provider-page-one",
      status: "idle",
      title: "Page one",
    }];
    value.codex.listedNextCursor = "provider-a";
    const first = await value.service.execute({
      kind: "session.list",
      account: added.account.id,
      limit: 1,
    }, { signal }) as { nextCursor: string };

    value.codex.listedProjections = [{
      providerThreadId: "provider-page-two",
      status: "idle",
      title: "Page two",
    }];
    value.codex.listedNextCursor = "provider-b";
    const second = await value.service.execute({
      kind: "session.list",
      account: added.account.id,
      cursor: first.nextCursor,
      limit: 1,
    }, { signal }) as { nextCursor: string };

    value.codex.listedProjections = [{
      providerThreadId: "provider-page-three",
      status: "idle",
      title: "Page three",
    }];
    value.codex.listedNextCursor = "provider-a";
    const third = await value.service.execute({
      kind: "session.list",
      account: added.account.id,
      cursor: second.nextCursor,
      limit: 1,
    }, { signal }) as { nextCursor: string };

    value.codex.listedProjections = [{
      providerThreadId: "provider-must-not-import",
      status: "idle",
      title: "Must not import",
    }];
    value.codex.listedNextCursor = "provider-b";
    await expect(value.service.execute({
      kind: "session.list",
      account: added.account.id,
      cursor: third.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const importedTitles = value.store.listSessions(10, added.account.id)
      .map((session) => session.title);
    expect(importedTitles).toHaveLength(3);
    expect(new Set(importedTitles)).toEqual(new Set(["Page one", "Page two", "Page three"]));
    expect(importedTitles).not.toContain("Must not import");
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

  test("hooks host-owned facts memory into start, resume, terminal archive, and expiry without a model command", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const now = () => 10_000;
    const { service, documents, codex } = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      now,
      factsMemory,
    );
    const added = await service.execute({ kind: "account.add", label: "Memory" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Memory docs", path: documents }, { signal });
    const started = await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      fast: false,
    }, { signal }) as { session: { id: string } };
    expect(factsMemory.ensures.length).toBeGreaterThanOrEqual(2);
    expect(factsMemory.ensures.every((entry) =>
      entry.ownerId === added.account.id && entry.sessionId === started.session.id)).toBe(true);
    expect(JSON.stringify(factsMemory.ensures)).not.toMatch(/path|store|space|authority|rule|purge|credential/iu);

    codex.readProjection = {
      providerThreadId: "provider-thread",
      status: "terminal",
      title: "Archived",
    };
    await service.execute({ kind: "session.show", session: started.session.id, detail: false }, { signal });
    expect(factsMemory.cleanups).toContainEqual({
      ownerId: added.account.id,
      reason: "archive",
      sessionId: started.session.id,
    });
    expect(factsMemory.sweeps.length).toBeGreaterThan(0);
    expect(localCommandSchema.safeParse({
      kind: "facts-memory.query",
      path: "/tmp/agent-selected",
    }).success).toBe(false);
  });

  test("cleans list-driven terminalization and reconciles a crash-left terminal on restart", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "List terminal memory");
    const session = value.store.requireSession(sessionId);
    if (session.providerThreadId === undefined) throw new Error("Expected provider binding.");
    value.codex.listedProjections = [{
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: (session.providerUpdatedAt ?? 0) + 1,
      status: "terminal",
      title: "List terminal memory",
    }];
    await value.service.execute({
      account: session.profileId,
      kind: "session.list",
      limit: 20,
    }, { signal });
    expect(value.store.requireSession(sessionId).state).toBe("terminal");
    expect(factsMemory.cleanups).toContainEqual({
      ownerId: session.profileId,
      reason: "archive",
      sessionId,
    });

    const crashFactsMemory = new FakeFactsMemoryLifecycle();
    const otherSession = value.store.upsertProviderSession({
      profileId: session.profileId,
      providerThreadId: "provider-thread-crash-terminal",
      providerUpdatedAt: 1,
      state: "idle",
      title: "Crash terminal memory",
    });
    if (otherSession.providerThreadId === undefined) throw new Error("Expected provider binding.");
    value.store.upsertProviderSession({
      profileId: otherSession.profileId,
      providerThreadId: otherSession.providerThreadId,
      providerUpdatedAt: (otherSession.providerUpdatedAt ?? 0) + 1,
      state: "terminal",
      title: otherSession.title,
    });
    const restarted = new HraService({
      store: value.store,
      paths: value.paths,
      codex: new FakeCodex(),
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      factsMemory: crashFactsMemory,
      requestStop: () => undefined,
    });
    await restarted.recover();
    expect(crashFactsMemory.cleanups).toContainEqual({
      ownerId: otherSession.profileId,
      reason: "archive",
      sessionId: otherSession.id,
    });
    await restarted.close();
  });

  test("renews facts-memory expiry after metadata-only durable activity", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    let now = 1_000;
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      () => now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Metadata memory renewal");
    factsMemory.ensures.length = 0;
    now += 29 * 24 * 60 * 60 * 1_000;
    await value.service.execute({
      kind: "session.note.set",
      note: "day twenty-nine activity",
      session: sessionId,
    }, { signal });
    expect(factsMemory.ensures).toEqual([{
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      ownerId: value.store.requireSession(sessionId).profileId,
      sessionId,
    }]);
  });

  test("reactivates stale live memory with a current TTL and does not churn epochs on unchanged resume", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    factsMemory.simulateExpiry = true;
    let now = 1_000;
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      () => now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Stale live memory");
    const firstExpiry = factsMemory.expiries.get(sessionId);
    if (firstExpiry === undefined) throw new Error("Expected initial facts-memory expiry.");
    now = firstExpiry;
    factsMemory.ensures.length = 0;

    await value.service.execute({
      detail: false,
      kind: "session.show",
      session: sessionId,
    }, { signal });
    expect(factsMemory.epochs.get(sessionId)).toBe(2);
    expect(factsMemory.ensures.every((entry) =>
      entry.expiresAt >= now + FACTS_MEMORY_SESSION_TTL_MS)).toBe(true);

    now += 1;
    await value.service.execute({
      detail: false,
      kind: "session.show",
      session: sessionId,
    }, { signal });
    expect(factsMemory.epochs.get(sessionId)).toBe(2);
  });

  test("sweeps and renews facts memory for remote metadata and provider-list commits", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    let now = 2_000;
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      () => now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Remote memory activity");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected provider binding.");
    factsMemory.ensures.length = 0;
    factsMemory.sweeps.length = 0;
    now = 20_000;

    await value.service.executeRemote({
      enabled: true,
      kind: "session.fast",
      session: session.id,
    }, {
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      providerThreadId: session.providerThreadId,
      sessionId: session.id,
    }, { signal });
    expect(factsMemory.sweeps).toContain(now);
    expect(factsMemory.ensures.at(-1)).toEqual({
      expiresAt: now + FACTS_MEMORY_SESSION_TTL_MS,
      ownerId: profile.id,
      sessionId,
    });

    factsMemory.ensures.length = 0;
    value.codex.listedProjections = [{
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: (session.providerUpdatedAt ?? 0) + 1,
      status: "idle",
      title: session.title,
    }];
    await value.service.execute({
      account: profile.id,
      kind: "session.list",
      limit: 20,
    }, { signal });
    expect(factsMemory.ensures.at(-1)).toEqual({
      expiresAt: now + FACTS_MEMORY_SESSION_TTL_MS,
      ownerId: profile.id,
      sessionId,
    });
  });

  test("terminal recovery commits purge immediately and a poisoned terminal row cannot block restart", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Terminal recovery memory");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected provider binding.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    await value.service.observeCodexFact(authority, {
      type: "threadStatusChanged",
      threadId: session.providerThreadId,
      status: { type: "systemError" },
    });
    factsMemory.cleanups.length = 0;
    value.codex.readProjection = {
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: (session.providerUpdatedAt ?? 0) + 1,
      status: "terminal",
      title: session.title,
    };
    await expect(value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({ session: { state: "terminal" } });
    expect(factsMemory.cleanups.at(-1)).toEqual({
      ownerId: profile.id,
      reason: "archive",
      sessionId,
    });

    const poisoned = value.store.upsertProviderSession({
      profileId: profile.id,
      providerThreadId: "provider-terminal-poisoned",
      providerUpdatedAt: 1,
      state: "terminal",
      title: "Poisoned terminal memory",
    });
    const healthy = value.store.upsertProviderSession({
      profileId: profile.id,
      providerThreadId: "provider-terminal-healthy",
      providerUpdatedAt: 1,
      state: "terminal",
      title: "Healthy terminal memory",
    });
    const restartMemory = new FakeFactsMemoryLifecycle();
    restartMemory.cleanupErrors.add(poisoned.id);
    const restarted = new HraService({
      store: value.store,
      paths: value.paths,
      codex: new FakeCodex(),
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      factsMemory: restartMemory,
      requestStop: () => undefined,
    });
    await expect(restarted.recover()).resolves.toBeUndefined();
    const cleanedSessionIds = restartMemory.cleanups.map(({ sessionId: candidate }) => candidate);
    expect(cleanedSessionIds).toContain(poisoned.id);
    expect(cleanedSessionIds).toContain(healthy.id);
    restartMemory.cleanupErrors.clear();
    await expect(restarted.execute({ kind: "account.list" }, { signal })).resolves.toBeDefined();
    expect(restartMemory.states.get(poisoned.id)).toBe("purged");
    await restarted.close();
  });

  test("purges facts memory before releasing an abandoned local recovery authority", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Abandon memory");
    value.store.quarantineSession(sessionId);
    await expect(value.service.execute({ kind: "session.abandon", session: sessionId }, { signal }))
      .resolves.toMatchObject({ recovery: { resolution: "abandoned" } });
    expect(factsMemory.cleanups.at(-1)).toEqual({
      ownerId: value.store.requireSession(sessionId).profileId,
      reason: "abandon",
      sessionId,
    });
  });

  test("does not purge facts memory when abandon is rejected for a live session", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Live abandon memory");
    await expect(value.service.execute({ kind: "session.abandon", session: sessionId }, { signal }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(factsMemory.cleanups).toEqual([]);
  });

  test("returns the created session authority when memory finalization needs an exact retry", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    factsMemory.ensureErrorOnce = new Error("lost memory receipt");
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const added = await value.service.execute({ kind: "account.add", label: "Memory retry" }, { signal }) as { account: { id: string } };
    await value.service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await value.service.execute({ kind: "project.add", label: "Memory retry docs", path: value.documents }, { signal });
    let details: { idempotencyKey: string; nextCommand: string; sessionId: `sess_${string}` } | undefined;
    try {
      await value.service.execute({
        kind: "session.start",
        account: added.account.id,
        preset: "high",
        fast: false,
      }, { signal });
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "RECOVERY_REQUIRED" });
      details = (error as CommandFailure).details as typeof details;
    }
    expect(details).toBeDefined();
    if (details === undefined) throw new Error("Expected memory recovery details.");
    expect(details.nextCommand).toBe(`hra session show ${details.sessionId}`);
    await expect(value.service.execute({
      kind: "session.show",
      session: details.sessionId,
      detail: false,
    }, { signal })).resolves.toMatchObject({ session: { id: details.sessionId } });
    expect(factsMemory.ensures.filter(({ sessionId }) => sessionId === details.sessionId).length)
      .toBeGreaterThanOrEqual(2);
    expect(value.codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
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

  test("reconciles a changed provider identity before reading below-threshold usage", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Usage identity",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.accountProjection = {
      signedIn: true,
      email: "other@example.com",
      plan: "Plus",
    };
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: { primary: { usedPercent: 20 }, privateIdentity: "other" },
    };
    const callsBefore = codex.calls.length;
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.calls.slice(callsBefore)).toEqual(["readAccount"]);
    expect(store.latestUsage(added.account.id)).toBeNull();
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        account: { providerEmail: "other@example.com" },
        automaticReset: { policy: { state: "reconciliation_required" } },
        poll: { state: "never_observed" },
        snapshot: null,
      }],
    });
  });

  test("discards usage when the provider identity changes during the read", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Usage identity sandwich",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: { primary: { usedPercent: 20 }, privateIdentity: "other" },
    };
    codex.beforeReadUsageReturn = async () => {
      codex.accountProjection = {
        signedIn: true,
        email: "other@example.com",
        plan: "Plus",
      };
    };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.calls.slice(-3)).toEqual(["readAccount", "usage", "readAccount"]);
    expect(store.latestUsage(added.account.id)).toBeNull();
    expect(codex.resetIdempotencyKeys).toEqual([]);
  });

  test("keeps below-threshold usage polling to the identity sandwich", async () => {
    const { service, codex } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Below reset threshold",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 50,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };

    const callsBefore = codex.calls.length;
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        automaticReset: {
          refresh: { state: "not_eligible", reason: "below_threshold" },
        },
      }],
    });
    expect(codex.calls.slice(callsBefore)).toEqual([
      "readAccount",
      "usage",
      "readAccount",
    ]);
    expect(codex.resetIdempotencyKeys).toEqual([]);
  });

  test("automatically consumes one reset at one percent remaining and rereads limits", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Auto reset" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const limits = (usedPercent: number, credits: number) => ({
      usage: { summary: { lifetimeTokens: 10 } },
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: automaticResetWindowResetsAtSeconds },
          secondary: { usedPercent, windowDurationMins: 10_080, resetsAt: automaticResetWindowResetsAtSeconds },
        },
        byLimitId: null,
        resetCreditsAvailable: credits,
      },
    });
    const afterReset = { revision: 2, observedAt: 2_001, payload: limits(0, 0) };
    codex.usageResult = afterReset;
    codex.usageResults.push(
      { revision: 1, observedAt: 2_000, payload: limits(99, 1) },
      afterReset,
    );

    const response = await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.calls.slice(-8)).toEqual([
      "readAccount",
      "usage",
      "readAccount",
      "readAccount",
      "reset",
      "readAccount",
      "usage",
      "readAccount",
    ]);
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
    expect(store.usageRange({ profileId: added.account.id }).map((row) => row.sourceRevision))
      .toEqual([1, 2]);
    expect(response).toMatchObject({
      usage: [{
        automaticReset: {
          threshold: { remainingPercent: 1, usedPercent: 99 },
          observation: {
            state: "available",
            creditsAvailable: 0,
            remainingPercent: 100,
            usedPercent: 0,
          },
          lastAttempt: {
            state: "settled",
            outcome: "reset",
            weeklyWindowResetsAt: automaticResetWindowResetsAt,
          },
          refresh: { state: "settled", outcome: "reset" },
        },
        snapshot: { sourceRevision: 2, payload: limits(0, 0) },
      }],
    });

    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
  });

  test("rechecks the provider identity immediately before automatic reset dispatch", async () => {
    const { service, codex, daemonAuthority, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset identity fence",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 99,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    let identityChanged = false;
    daemonAuthority.beforeAssert = async () => {
      if (
        !identityChanged
        && codex.calls.slice(-3).join(",") === "readAccount,usage,readAccount"
      ) {
        identityChanged = true;
        codex.accountProjection = {
          signedIn: true,
          email: "replacement@example.com",
          plan: "Plus",
        };
      }
    };

    const callsBefore = codex.calls.length;
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(identityChanged).toBe(true);
    expect(codex.calls.slice(callsBefore)).toEqual([
      "readAccount",
      "usage",
      "readAccount",
      "readAccount",
    ]);
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireProfileById(added.account.id)).toMatchObject({
      providerEmail: "replacement@example.com",
    });
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        automaticReset: { policy: { state: "reconciliation_required" } },
      }],
    });

    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: {
          state: "window_suppressed",
          weeklyWindowResetsAt: automaticResetWindowResetsAt,
        },
        refresh: { state: "suppressed", reason: "reconciliation_window" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "window_suppressed",
      accountFingerprint: createHash("sha256")
        .update("replacement@example.com").digest("hex"),
      weeklyWindowResetsAt: automaticResetWindowResetsAt,
    });
  });

  test("suppresses the first reconciled window through its boundary before activating a later window", async () => {
    let now = 1_000_000_000;
    const suppressedWindow = now + 3 * 24 * 60 * 60 * 1_000;
    const laterWindow = suppressedWindow + 3 * 24 * 60 * 60 * 1_000;
    const { service, codex, store } = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      () => now,
    );
    const added = await service.execute({
      kind: "account.add",
      label: "Legacy reset reconciliation",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const original = store.requireProfileById(added.account.id);
    const originalFingerprint = createHash("sha256")
      .update("person@example.com").digest("hex");
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: original.id,
      processGeneration: original.processGeneration,
      accountFingerprint: originalFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow,
    }).decision).toBe("allow");
    const legacyEmail = "legacy@example.com";
    expect(store.setProfileState(
      original.id,
      original.processGeneration,
      "signed_in",
      { email: legacyEmail, plan: "Plus" },
    )).toBe(true);
    const legacy = store.requireProfileById(original.id);
    const legacyFingerprint = createHash("sha256").update(legacyEmail).digest("hex");
    expect(store.requireAccountRateLimitResetPolicy(legacy.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    codex.accountProjection = { signedIn: true, email: legacyEmail, plan: "Plus" };

    const payload = (usedPercent: number, credits: number, resetsAt: number) => ({
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent,
            windowDurationMins: 10_080,
            resetsAt,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: credits,
      },
    });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: payload(0, 0, suppressedWindow / 1_000),
    };
    await expect(service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: {
          state: "window_suppressed",
          weeklyWindowResetsAt: suppressedWindow,
        },
        refresh: { state: "suppressed", reason: "reconciliation_window" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.latestAccountRateLimitResetAttempt(legacy.id, legacyFingerprint))
      .toBeNull();

    codex.usageResult = {
      revision: 2,
      observedAt: 3_000,
      payload: payload(99, 1, suppressedWindow / 1_000),
    };
    await service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([]);

    now = suppressedWindow - 1_000;
    codex.usageResult = {
      revision: 3,
      observedAt: 4_000,
      payload: payload(99, 1, laterWindow / 1_000),
    };
    await expect(service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: {
          state: "window_suppressed",
          weeklyWindowResetsAt: suppressedWindow,
        },
        refresh: { state: "suppressed", reason: "weekly_window_nonmonotonic" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);

    now = suppressedWindow;
    codex.usageResult = {
      revision: 4,
      observedAt: 5_000,
      payload: payload(0, 1, laterWindow / 1_000),
    };
    await expect(service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "active" },
        refresh: { state: "not_eligible", reason: "below_threshold" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireAccountRateLimitResetPolicy(legacy.id)).toMatchObject({
      state: "active_bound",
      weeklyWindowResetsAt: laterWindow,
    });

    codex.usageResult = {
      revision: 5,
      observedAt: 6_000,
      payload: payload(99, 1, laterWindow / 1_000),
    };
    await service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
    expect(JSON.stringify(store.requireAccountRateLimitResetPolicy(legacy.id)))
      .not.toContain(legacyEmail);
  });

  test("migrates a signed-in v24 profile and suppresses its first valid window across restart and notification", async () => {
    const now = 3_000_000_000;
    const firstWindow = now + 3 * 24 * 60 * 60 * 1_000;
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      () => now,
    );
    const added = await value.service.execute({
      kind: "account.add",
      label: "V24 reset reconciliation",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });

    await value.service.close();
    value.store.close();
    stores.splice(stores.indexOf(value.store), 1);
    const legacy = new Database(value.paths.database, { create: false, strict: true });
    try {
      legacy.exec("PRAGMA foreign_keys=OFF");
      const resetTriggers = legacy.query(
        `SELECT name FROM sqlite_master
         WHERE type='trigger' AND name GLOB 'account_rate_limit_reset_*'
         ORDER BY name`,
      ).all() as Array<{ name: string }>;
      for (const { name } of resetTriggers) {
        if (!/^account_rate_limit_reset_[a-z_]+$/u.test(name)) {
          throw new Error("Unexpected reset trigger name.");
        }
        legacy.exec(`DROP TRIGGER "${name}"`);
      }
      legacy.exec(`
        DROP TABLE account_rate_limit_reset_rebinds;
        DROP TABLE account_rate_limit_reset_attempts;
        DROP TABLE account_rate_limit_reset_policies;
        DROP INDEX IF EXISTS usage_poll_failures_identity_recent;
        ALTER TABLE session_events DROP COLUMN projection_version;
        ALTER TABLE usage_poll_failures DROP COLUMN account_fingerprint;
      `);
      const workTriggers = legacy.query(
        `SELECT name FROM sqlite_master
         WHERE type='trigger'
           AND (name GLOB 'work_*' OR name GLOB 'works_*')
         ORDER BY name`,
      ).all() as Array<{ name: string }>;
      for (const { name } of workTriggers) {
        if (!/^(?:work|works)_[a-z_]+$/u.test(name)) {
          throw new Error("Unexpected v26 work trigger name.");
        }
        legacy.exec(`DROP TRIGGER "${name}"`);
      }
      const workTables = legacy.query(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND (name='works' OR name GLOB 'work_*')
         ORDER BY name`,
      ).all() as Array<{ name: string }>;
      for (const { name } of workTables) {
        if (!/^(?:works|work_[a-z_]+)$/u.test(name)) {
          throw new Error("Unexpected v26 work table name.");
        }
        legacy.exec(`DROP TABLE "${name}"`);
      }
      legacy.exec(`
        DELETE FROM migrations WHERE version>=25;
        PRAGMA user_version=24;
        PRAGMA foreign_keys=ON;
      `);
    } finally {
      legacy.close(false);
    }

    const store = new StateStore(value.paths, { now: () => now });
    stores.push(store);
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    const inspector = new Database(value.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 30 });
      expect(inspector.query(
        "SELECT version FROM migrations WHERE version>=25 ORDER BY version",
      ).all()).toEqual([{ version: 25 }, { version: 26 }, { version: 27 }, { version: 28 }, { version: 29 }, { version: 30 }]);
    } finally {
      inspector.close(false);
    }

    const codex = new FakeCodex();
    const migrated = new HraService({
      store,
      paths: value.paths,
      codex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      now: () => now,
      requestStop: () => undefined,
    });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: { rateLimits: { temporarilyUnavailable: true } },
    };
    await expect(migrated.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "reconciliation_required" },
        refresh: { state: "suppressed", reason: "reconciliation_required" },
      } }],
    });

    const eligiblePayload = {
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: firstWindow / 1_000,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    codex.usageResult = { revision: 2, observedAt: 3_000, payload: eligiblePayload };
    await expect(migrated.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "window_suppressed" },
        refresh: { state: "suppressed", reason: "reconciliation_window" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);

    await migrated.close();
    const restartedCodex = new FakeCodex();
    restartedCodex.usageResult = {
      revision: 3,
      observedAt: 4_000,
      payload: eligiblePayload,
    };
    const restarted = new HraService({
      store,
      paths: value.paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      now: () => now,
      requestStop: () => undefined,
    });
    await restarted.recover();
    const profile = store.requireProfileById(added.account.id);
    const owned = profilePaths(value.paths, profile.id);
    await restarted.observeCodexFact({
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: owned.codexHome,
      desktopUserData: owned.desktopUserData,
    }, { type: "rateLimitsUpdated" });
    await restarted.settled();
    expect(restartedCodex.calls).toEqual(["readAccount", "usage", "readAccount"]);
    expect(restartedCodex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "window_suppressed",
      weeklyWindowResetsAt: firstWindow,
    });
    await restarted.close();
  });

  test("fails before reset-attempt inspection when policy storage is unavailable", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset policy failure",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 99,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    Object.defineProperty(store, "authorizeAccountRateLimitResetPolicy", {
      configurable: true,
      value: () => { throw new Error("injected reset policy failure"); },
    });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toThrow("injected reset policy failure");
    expect(codex.resetIdempotencyKeys).toEqual([]);
  });

  test("persists a background reset result for later passive usage status", async () => {
    const { service, codex, store, paths } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Background reset",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const limits = (usedPercent: number, credits: number) => ({
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: null,
          secondary: {
            usedPercent,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
        },
        byLimitId: null,
        resetCreditsAvailable: credits,
      },
    });
    const afterReset = { revision: 2, observedAt: 2_001, payload: limits(0, 0) };
    codex.usageResult = afterReset;
    codex.usageResults.push(
      { revision: 1, observedAt: 2_000, payload: limits(99, 1) },
      afterReset,
    );
    const profile = store.requireProfileById(added.account.id);
    const owned = profilePaths(paths, profile.id);
    await service.observeCodexFact({
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: owned.codexHome,
      desktopUserData: owned.desktopUserData,
    }, { type: "rateLimitsUpdated" });
    await service.settled();

    const passive = await service.execute({
      kind: "account.usage",
      account: profile.id,
      refresh: false,
    }, { signal }) as { usage: Array<{ automaticReset: Record<string, unknown> }> };
    expect(codex.calls.slice(-8)).toEqual([
      "readAccount",
      "usage",
      "readAccount",
      "readAccount",
      "reset",
      "readAccount",
      "usage",
      "readAccount",
    ]);
    expect(passive).toMatchObject({
      usage: [{
        automaticReset: {
          lastAttempt: {
            state: "settled",
            outcome: "reset",
            weeklyWindowResetsAt: automaticResetWindowResetsAt,
          },
        },
      }],
    });
    expect(passive.usage[0]?.automaticReset).not.toHaveProperty("refresh");
    const automaticReset = JSON.stringify(passive.usage[0]?.automaticReset);
    expect(automaticReset).not.toContain(codex.resetIdempotencyKeys[0] as string);
    expect(automaticReset).not.toContain(
      createHash("sha256").update("person@example.com").digest("hex"),
    );
  });

  test("settles known reset no-ops without degrading successful usage polling", async () => {
    for (const outcome of ["nothingToReset", "noCredit"] as const) {
      const { service, codex } = await fixture();
      const added = await service.execute({
        kind: "account.add",
        label: `Reset ${outcome}`,
      }, { signal }) as { account: { id: string } };
      await service.execute({
        kind: "account.login",
        account: added.account.id,
        deviceCode: false,
      }, { signal });
      const payload = {
        usage: { summary: { lifetimeTokens: 10 } },
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: null,
            secondary: {
              usedPercent: 99,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      };
      codex.usageResult = { revision: 1, observedAt: 2_000, payload };
      codex.resetOutcome = outcome;
      const first = await service.execute({
        kind: "account.usage",
        account: added.account.id,
        refresh: true,
      }, { signal });
      expect(first).toMatchObject({
        usage: [{
          automaticReset: { refresh: { state: "settled", outcome } },
          poll: { state: "observed" },
        }],
      });
      expect(codex.resetIdempotencyKeys).toHaveLength(1);
      await service.execute({
        kind: "account.usage",
        account: added.account.id,
        refresh: true,
      }, { signal });
      expect(codex.resetIdempotencyKeys).toHaveLength(outcome === "noCredit" ? 2 : 1);
      await service.execute({
        kind: "account.usage",
        account: added.account.id,
        refresh: true,
      }, { signal });
      expect(codex.resetIdempotencyKeys).toHaveLength(outcome === "noCredit" ? 2 : 1);
    }
  });

  test("reconciles an indeterminate reset with its exact persisted key", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Reset retry" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const payload = {
      usage: { summary: { lifetimeTokens: 10 } },
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: null,
          secondary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    codex.usageResult = { revision: 1, observedAt: 2_000, payload };
    codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    const indeterminate = await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(indeterminate).toMatchObject({
      usage: [{ automaticReset: {
        lastAttempt: {
          state: "recovery_pending",
          weeklyWindowResetsAt: automaticResetWindowResetsAt,
        },
        refresh: { state: "recovery_pending" },
      } }],
    });
    const key = codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected a persisted reset idempotency key.");
    expect(typeof key).toBe("string");
    expect(store.readRecoverableAccountRateLimitReset(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ idempotencyKey: key, state: "ambiguous" });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: { lastAttempt: {
        state: "recovery_pending",
        weeklyWindowResetsAt: automaticResetWindowResetsAt,
      } } }],
    });

    codex.resetError = undefined;
    codex.resetOutcome = "alreadyRedeemed";
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([key, key]);
    expect(store.latestAccountRateLimitResetAttempt(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ idempotencyKey: key, state: "settled", outcome: "alreadyRedeemed" });
  });

  test("preserves an ambiguous reset key while its live weekly bucket is unavailable", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset missing bucket",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const eligiblePayload = {
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    codex.usageResult = { revision: 1, observedAt: 2_000, payload: eligiblePayload };
    codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    const key = codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected an ambiguous reset key.");

    codex.resetError = undefined;
    codex.usageResult = {
      revision: 2,
      observedAt: 3_000,
      payload: { rateLimits: { temporarilyUnavailable: true } },
    };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: { refresh: {
        state: "suppressed",
        reason: "weekly_window_unavailable",
      } } }],
    });
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    expect(store.readRecoverableAccountRateLimitReset(added.account.id, fingerprint))
      .toMatchObject({ idempotencyKey: key, state: "ambiguous" });
    expect(codex.resetIdempotencyKeys).toEqual([key]);

    codex.usageResult = { revision: 3, observedAt: 4_000, payload: eligiblePayload };
    codex.resetOutcome = "alreadyRedeemed";
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([key, key]);
    expect(store.latestAccountRateLimitResetAttempt(added.account.id, fingerprint))
      .toMatchObject({ idempotencyKey: key, state: "settled", outcome: "alreadyRedeemed" });
  });

  test("never redispatches a terminal reset latch returned by preparation", async () => {
    const settled = await fixture();
    const settledAccount = await settled.service.execute({
      kind: "account.add",
      label: "Settled reset latch",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await settled.service.execute({
      kind: "account.login",
      account: settledAccount.account.id,
      deviceCode: false,
    }, { signal });
    const eligiblePayload = {
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    settled.codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: eligiblePayload,
    };
    await settled.service.execute({
      kind: "account.usage",
      account: settledAccount.account.id,
      refresh: true,
    }, { signal });
    await expect(settled.service.execute({
      kind: "account.usage",
      account: settledAccount.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        refresh: { state: "latched", outcome: "reset" },
      } }],
    });
    expect(settled.codex.resetIdempotencyKeys).toHaveLength(1);

    const closed = await fixture();
    const closedAccount = await closed.service.execute({
      kind: "account.add",
      label: "Closed reset latch",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await closed.service.execute({
      kind: "account.login",
      account: closedAccount.account.id,
      deviceCode: false,
    }, { signal });
    const profile = closed.store.requireProfileById(closedAccount.account.id);
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    expect(closed.store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: fingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: automaticResetWindowResetsAt,
    }).decision).toBe("allow");
    const prepared = closed.store.prepareAccountRateLimitReset({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: fingerprint,
      weeklyWindowResetsAt: automaticResetWindowResetsAt,
      observedUsedPercent: 99,
    });
    closed.store.closeAccountRateLimitReset(
      prepared.idempotencyKey,
      "weekly_window_changed",
    );
    closed.codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: eligiblePayload,
    };
    await expect(closed.service.execute({
      kind: "account.usage",
      account: closedAccount.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        refresh: { state: "latched", reason: "weekly_window_changed" },
      } }],
    });
    expect(closed.codex.resetIdempotencyKeys).toEqual([]);
  });

  test("rechecks eligibility after a determinate reset rejection", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset rejection",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const payload = (usedPercent: number) => ({
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    });
    codex.usageResult = { revision: 1, observedAt: 2_000, payload: payload(99) };
    codex.resetError = new CodexRemoteError(-32_000, "request failed");
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: { refresh: { state: "retry_pending" } } }],
    });
    const key = codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected a retryable reset key.");
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    expect(store.readRecoverableAccountRateLimitReset(added.account.id, fingerprint))
      .toMatchObject({ idempotencyKey: key, state: "retryable" });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: { lastAttempt: {
        state: "retry_pending",
        weeklyWindowResetsAt: automaticResetWindowResetsAt,
      } } }],
    });

    codex.resetError = undefined;
    codex.usageResult = { revision: 2, observedAt: 3_000, payload: payload(98) };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        automaticReset: {
          refresh: { state: "waiting", reason: "below_threshold" },
        },
      }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([key]);

    codex.usageResult = { revision: 3, observedAt: 4_000, payload: payload(99) };
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([key, key]);
  });

  test("reconciles an ambiguous reset with its original key in a later active window", async () => {
    let now = 2_000_000_000;
    const originalWindow = now + 3 * 24 * 60 * 60 * 1_000;
    const laterWindow = originalWindow + 3 * 24 * 60 * 60 * 1_000;
    const { service, codex, store } = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      () => now,
    );
    const added = await service.execute({
      kind: "account.add",
      label: "Reset window",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const payload = (resetsAt: number, usedPercent: number, credits: number) => ({
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent,
            windowDurationMins: 10_080,
            resetsAt,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: credits,
      },
    });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: payload(originalWindow / 1_000, 99, 1),
    };
    codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    const key = codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected an ambiguous reset key.");
    codex.resetError = undefined;
    codex.resetOutcome = "alreadyRedeemed";
    now = originalWindow;
    codex.usageResult = {
      revision: 2,
      observedAt: 3_000,
      payload: payload(laterWindow / 1_000, 0, 0),
    };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "active" },
        refresh: { state: "settled", outcome: "alreadyRedeemed" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([key, key]);
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "active_bound",
      weeklyWindowResetsAt: laterWindow,
    });
    expect(store.requireProfileById(added.account.id).state).toBe("signed_in");
    expect(store.latestAccountRateLimitResetAttempt(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ idempotencyKey: key, state: "settled", outcome: "alreadyRedeemed" });
  });

  test("rebinds and reconciles an ambiguous reset across an app-server generation", async () => {
    const value = await fixture();
    const added = await value.service.execute({
      kind: "account.add",
      label: "Reset restart",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const payload = {
      usage: { summary: { lifetimeTokens: 10 } },
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: null,
          secondary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    value.codex.usageResult = { revision: 1, observedAt: 2_000, payload };
    value.codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    await value.service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    const key = value.codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected an ambiguous reset key.");
    const originalGeneration = value.store.requireProfileById(added.account.id)
      .processGeneration;
    await value.service.close();
    const replacementGeneration = value.store.requireProfileById(added.account.id)
      .processGeneration;
    expect(replacementGeneration).toBe(originalGeneration + 1);

    const replacementCodex = new FakeCodex();
    replacementCodex.usageResult = { revision: 2, observedAt: 3_000, payload };
    replacementCodex.resetOutcome = "alreadyRedeemed";
    const replacement = new HraService({
      store: value.store,
      paths: value.paths,
      codex: replacementCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration: 2,
      requestStop: () => undefined,
    });
    await replacement.recover();
    await replacement.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(replacementCodex.resetIdempotencyKeys).toEqual([key]);
    expect(value.store.listAccountRateLimitResetRebinds(key)).toEqual([
      expect.objectContaining({
        idempotencyKey: key,
        fromProcessGeneration: originalGeneration,
        toProcessGeneration: replacementGeneration,
      }),
    ]);
    expect(value.store.latestAccountRateLimitResetAttempt(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ idempotencyKey: key, state: "settled", outcome: "alreadyRedeemed" });
    await replacement.close();
  });

  test("keeps a prepared reset dormant until the same weekly window is eligible again", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset threshold recheck",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const profile = store.requireProfileById(added.account.id);
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    const resetAt = automaticResetWindowResetsAt;
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: fingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: resetAt,
    }).decision).toBe("allow");
    const prepared = store.prepareAccountRateLimitReset({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: fingerprint,
      weeklyWindowResetsAt: resetAt,
      observedUsedPercent: 99,
    });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 98,
              windowDurationMins: 10_080,
              resetsAt: resetAt / 1_000,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    await service.execute({
      kind: "account.usage",
      account: profile.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.readRecoverableAccountRateLimitReset(profile.id, fingerprint))
      .toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "prepared" });
  });

  test("keeps ambiguous recovery inert while a replacement identity reconciles", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset identity",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const payload = {
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    codex.usageResult = { revision: 1, observedAt: 2_000, payload };
    codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    codex.resetError = undefined;
    codex.accountProjection = {
      signedIn: true,
      email: "someone-else@example.com",
      plan: "Plus",
    };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
    expect(store.requireProfileById(added.account.id)).toMatchObject({
      state: "signed_in",
      providerEmail: "someone-else@example.com",
      providerPlan: "Plus",
    });
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    expect(store.latestAccountRateLimitResetAttempt(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ state: "closed", localResolution: "account_identity_changed" });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        account: { providerEmail: "someone-else@example.com" },
        automaticReset: {
          lastAttempt: null,
          observation: {
            state: "unavailable",
            reason: "weekly_window_unavailable",
          },
        },
        snapshot: null,
      }],
    });

    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "window_suppressed" },
        refresh: { state: "suppressed", reason: "reconciliation_window" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "window_suppressed",
      accountFingerprint: createHash("sha256")
        .update("someone-else@example.com").digest("hex"),
      weeklyWindowResetsAt: automaticResetWindowResetsAt,
    });
  });

  test("account show clears a reset-era recovery quarantine without a generic mutation", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset recovery",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const profile = store.requireProfileById(added.account.id);
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "recovery_required",
      {
        ...(profile.providerEmail === undefined ? {} : { email: profile.providerEmail }),
        ...(profile.providerPlan === undefined ? {} : { plan: profile.providerPlan }),
      },
    )).toBe(true);
    codex.accountProjection = {
      signedIn: true,
      email: "person@example.com",
      plan: "Plus",
    };
    await expect(service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { state: "signed_in" },
      recovery: {
        cleared: true,
        required: false,
        resolution: "provider_state_reconciled",
      },
    });
  });

  test("synchronously fences provider authority when reset journaling fails", async () => {
    for (const boundary of ["defer", "settle"] as const) {
      let stopCalls = 0;
      const value = await fixture(
        undefined,
        new FakeCloud(),
        () => { stopCalls += 1; },
      );
      const added = await value.service.execute({
        kind: "account.add",
        label: `Reset journal ${boundary}`,
      }, { signal }) as { account: { id: `acct_${string}` } };
      await value.service.execute({
        kind: "account.login",
        account: added.account.id,
        deviceCode: false,
      }, { signal });
      value.codex.usageResult = {
        revision: 1,
        observedAt: 2_000,
        payload: {
          rateLimits: {
            primary: {
              limitId: "codex",
              primary: {
                usedPercent: 99,
                windowDurationMins: 10_080,
                resetsAt: automaticResetWindowResetsAtSeconds,
              },
              secondary: null,
            },
            byLimitId: null,
            resetCreditsAvailable: 1,
          },
        },
      };
      if (boundary === "defer") {
        value.codex.resetError = new IndeterminateCodexEffectError(
          "account/rateLimitResetCredit/consume",
          99,
        );
        Object.defineProperty(value.store, "deferAccountRateLimitReset", {
          configurable: true,
          value: () => { throw new Error("injected reset defer failure"); },
        });
      } else {
        Object.defineProperty(value.store, "settleAccountRateLimitReset", {
          configurable: true,
          value: () => { throw new Error("injected reset settlement failure"); },
        });
      }
      await expect(value.service.execute({
        kind: "account.usage",
        account: added.account.id,
        refresh: true,
      }, { signal })).rejects.toBeInstanceOf(AggregateError);
      expect(value.daemonAuthority.current).toBe(false);
      expect(value.daemonAuthority.closeCalls).toBe(1);
      const callsAtFence = value.codex.calls.length;
      await expect(value.service.execute({
        kind: "account.logout",
        account: added.account.id,
      }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(value.codex.calls).toHaveLength(callsAtFence);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(stopCalls).toBe(1);
    }
  });

  test("commits a returned reset outcome even when shutdown closes daemon authority", async () => {
    const value = await fixture();
    const added = await value.service.execute({
      kind: "account.add",
      label: "Reset shutdown",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    value.codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 99,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    let signalReset!: () => void;
    const resetStarted = new Promise<void>((resolve) => { signalReset = resolve; });
    let releaseReset!: () => void;
    const resetGate = new Promise<void>((resolve) => { releaseReset = resolve; });
    value.codex.beforeResetReturn = async () => {
      signalReset();
      await resetGate;
    };
    const refresh = value.service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    await resetStarted;
    const closing = value.service.close();
    releaseReset();
    await expect(refresh).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    await closing;
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    expect(value.store.readRecoverableAccountRateLimitReset(
      added.account.id,
      fingerprint,
    )).toBeNull();
  });

  test("coalesces rate-limit notifications into authoritative serialized reads", async () => {
    const { service, codex, store, paths } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Reset wake" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const profile = store.requireProfileById(added.account.id);
    const owned = profilePaths(paths, profile.id);
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: owned.codexHome,
      desktopUserData: owned.desktopUserData,
    };
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        usage: { summary: { lifetimeTokens: 10 } },
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: null,
            secondary: {
              usedPercent: 98,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    let reads = 0;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalTrailing!: () => void;
    const trailingStarted = new Promise<void>((resolve) => { signalTrailing = resolve; });
    codex.beforeReadUsageReturn = async () => {
      reads += 1;
      if (reads === 1) {
        signalFirst();
        await firstGate;
      } else if (reads === 2) {
        signalTrailing();
      }
    };

    await service.observeCodexFact(authority, { type: "rateLimitsUpdated" });
    await firstStarted;
    await service.observeCodexFact(authority, { type: "rateLimitsUpdated" });
    releaseFirst();
    await trailingStarted;
    await service.execute({
      kind: "account.usage",
      account: profile.id,
      refresh: false,
    }, { signal });
    expect(reads).toBe(2);
    expect(codex.resetIdempotencyKeys).toEqual([]);
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

  test("pages a safe source-ordered 24-hour account usage history", async () => {
    let now = 1_700_000_000_000;
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => now);
    const added = await value.service.execute(
      { kind: "account.add", label: "Usage history" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const accountFingerprint = createHash("sha256")
      .update("person@example.com")
      .digest("hex");
    const sentinel = "PRIVATE_PROVIDER_PAYLOAD_SENTINEL";
    const first = createStoredAccountUsageSnapshot({
      providerPayload: {
        privateProviderPayload: sentinel,
        usage: { summary: { lifetimeTokens: 100 } },
      },
      sourceSequence: 1,
      observedAt: now - 180_000,
      receivedAt: now - 179_000,
      accountFingerprint,
      providerGeneration: 0,
      daemonGeneration: 1,
      previousPayload: null,
    });
    const third = createStoredAccountUsageSnapshot({
      providerPayload: {
        privateProviderPayload: sentinel,
        usage: { summary: { lifetimeTokens: 250 } },
      },
      sourceSequence: 3,
      observedAt: now - 60_000,
      receivedAt: now - 59_000,
      accountFingerprint,
      providerGeneration: 0,
      daemonGeneration: 1,
      previousPayload: first,
    });
    value.store.recordUsage(added.account.id, 1, first.observation.observedAt, first);
    value.store.recordUsagePollFailure(
      added.account.id,
      accountFingerprint,
      2,
      now - 120_000,
    );
    value.store.recordUsage(added.account.id, 3, third.observation.observedAt, third);
    value.store.recordUsagePollFailure(
      added.account.id,
      accountFingerprint,
      4,
      now - 30_000,
    );

    const firstPage = await value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      fromObservedAt: now - 240_000,
      throughObservedAt: now,
      limit: 2,
    }, { signal }) as {
      entries: Array<{ sourceRevision: number }>;
      nextCursor: string;
      range: { fromObservedAt: number; throughObservedAt: number };
    };
    expect(firstPage).toMatchObject({
      account: { id: added.account.id, label: "Usage history" },
      range: { fromObservedAt: now - 240_000, throughObservedAt: now },
      entries: [
        {
          state: "observed",
          sourceRevision: 1,
          observedAt: now - 180_000,
          receivedAt: now - 179_000,
          lifetimeTokens: 100,
          gapBefore: false,
        },
        {
          state: "failed",
          sourceRevision: 2,
          observedAt: now - 120_000,
          reasonCode: "account_usage_read_failed",
        },
      ],
    });
    expect(JSON.stringify(firstPage)).not.toContain(sentinel);
    expect(JSON.stringify(firstPage)).not.toContain("providerPayload");

    const secondPage = await value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      cursor: firstPage.nextCursor,
      limit: 2,
    }, { signal }) as { entries: Array<{ sourceRevision: number }>; nextCursor: null };
    expect(secondPage.entries.map((entry) => entry.sourceRevision)).toEqual([3, 4]);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.entries.some((entry) => entry.sourceRevision === 2)).toBe(false);

    await expect(value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      cursor: firstPage.nextCursor,
      fromObservedAt: firstPage.range.fromObservedAt + 1,
      limit: 2,
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { reason: "filter_mismatch" },
    });
    const other = await value.service.execute(
      { kind: "account.add", label: "Other usage" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await expect(value.service.execute({
      kind: "account.usage-history",
      account: other.account.id,
      cursor: firstPage.nextCursor,
      limit: 2,
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { reason: "account_mismatch" },
    });
    now += USAGE_HISTORY_CURSOR_TTL_MS + 1;
    await expect(value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      cursor: firstPage.nextCursor,
      limit: 2,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "expired" },
    });
  });

  test("binds usage-history rows and cursors to the current account identity", async () => {
    const now = 1_700_000_000_000;
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => now);
    const added = await value.service.execute({
      kind: "account.add",
      label: "Identity history",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const firstFingerprint = createHash("sha256")
      .update("person@example.com")
      .digest("hex");
    const first = createStoredAccountUsageSnapshot({
      providerPayload: { usage: { summary: { lifetimeTokens: 10 } } },
      sourceSequence: 1,
      observedAt: now - 2_000,
      receivedAt: now - 1_900,
      accountFingerprint: firstFingerprint,
      providerGeneration: 1,
      daemonGeneration: 1,
      previousPayload: null,
    });
    value.store.recordUsage(added.account.id, 1, first.observation.observedAt, first);
    value.store.recordUsagePollFailure(
      added.account.id,
      firstFingerprint,
      2,
      now - 1_000,
    );
    const firstPage = await value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      fromObservedAt: now - 3_000,
      throughObservedAt: now,
      limit: 1,
    }, { signal }) as { entries: unknown[]; nextCursor: string };
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.nextCursor).toBeString();

    const profile = value.store.requireProfileById(added.account.id);
    expect(value.store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: "other@example.com", plan: "Plus" },
    )).toBe(true);
    await expect(value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      cursor: firstPage.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { reason: "account_mismatch" },
    });
    await expect(value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      fromObservedAt: now - 3_000,
      throughObservedAt: now,
      limit: 10,
    }, { signal })).resolves.toMatchObject({ entries: [], nextCursor: null });
  });

  test("rejects usage-history ranges outside the retained window", async () => {
    const now = 1_700_000_000_000;
    const { service } = await fixture(undefined, new FakeCloud(), () => undefined, () => now);
    const added = await service.execute(
      { kind: "account.add", label: "Bounded usage" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await expect(service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      fromObservedAt: now - 24 * 60 * 60_000,
      throughObservedAt: now,
      limit: 50,
    }, { signal })).resolves.toMatchObject({
      range: {
        fromObservedAt: now - 24 * 60 * 60_000,
        throughObservedAt: now,
      },
      entries: [],
    });
    await expect(service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      limit: 50,
    }, { signal })).resolves.toMatchObject({
      range: {
        fromObservedAt: now - 24 * 60 * 60_000,
        throughObservedAt: now,
      },
    });
    for (const command of [
      {
        kind: "account.usage-history" as const,
        account: added.account.id,
        fromObservedAt: now - 1,
        throughObservedAt: now - 2,
        limit: 50,
      },
      {
        kind: "account.usage-history" as const,
        account: added.account.id,
        throughObservedAt: now + 1,
        limit: 50,
      },
      {
        kind: "account.usage-history" as const,
        account: added.account.id,
        fromObservedAt: now - 24 * 60 * 60_000 - 1,
        limit: 50,
      },
    ]) {
      await expect(service.execute(command, { signal })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
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
    const accountFingerprint = createHash("sha256")
      .update("person@example.com")
      .digest("hex");
    codex.usageError = new Error("provider failure at /private/secret with token=do-not-store");
    await expect(service.execute(
      { kind: "account.usage", account: added.account.id, refresh: true },
      { signal },
    )).rejects.toThrow("provider failure");

    expect(store.latestUsage(added.account.id)).toBeNull();
    expect(store.latestUsagePollFailure(added.account.id, accountFingerprint)).toMatchObject({
      reasonCode: "account_usage_read_failed",
      sourceRevision: 1,
    });
    expect(JSON.stringify(store.latestUsagePollFailure(
      added.account.id,
      accountFingerprint,
    ))).not.toContain("secret");
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

  test("classifies absent old keys and changed-key recovery authority without opaque internal failures", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Projection admission guidance");
    const command = {
      acknowledgeGap: true as const,
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000809",
      kind: "sync.projection-recover" as const,
      session: sessionId,
    };

    cloud.projectionRecoveryError = new CloudProjectionRecoveryAdmissionError(
      "idempotency_authority_invalid",
    );
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("Omit `--idempotency-key`"),
    });

    cloud.projectionRecoveryError = new CloudProjectionRecoveryAdmissionError(
      "unsettled_session",
    );
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { nextCommand: "hra sync status --json" },
      message: expect.stringContaining("replay the exact idempotency key"),
    });
    expect(cloud.projectionRecoveries).toEqual([]);
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

  test("drops a provider fact when its profile generation advances during the recovery-state read", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Stale fact generation");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    cloud.beforeProjectionUnsettledSessionReturn = async (observedSessionId) => {
      if (observedSessionId !== session.id) return;
      signalRead();
      await readGate;
    };
    const staleFact = value.service.observeCodexFact({
      codexHome: "unused",
      desktopUserData: "unused",
      generation: profile.processGeneration,
      id: profile.id,
    }, {
      threadId: session.providerThreadId,
      turn: {
        completedAt: null,
        durationMs: null,
        id: "stale-generation-turn",
        items: [],
        startedAt: 1,
        status: "inProgress",
      },
      type: "turnStarted",
    });

    await readStarted;
    value.store.advanceProfileGeneration(profile.id, profile.processGeneration);
    releaseRead();
    await staleFact;

    expect(value.store.requireProfileById(profile.id).processGeneration).toBe(
      profile.processGeneration + 1,
    );
    const after = value.store.requireSession(session.id);
    expect(after.state).toBe("idle");
    expect(after.activeTurnId).toBeUndefined();
  });

  test("drops a provider fact when its same-generation profile signs out during the recovery-state read", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(undefined, cloud);
    const { sessionId } = await createIdleSession(value, "Signed-out fact authority");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    cloud.beforeProjectionUnsettledSessionReturn = async (observedSessionId) => {
      if (observedSessionId !== session.id) return;
      signalRead();
      await readGate;
    };
    const staleFact = value.service.observeCodexFact({
      codexHome: "unused",
      desktopUserData: "unused",
      generation: profile.processGeneration,
      id: profile.id,
    }, {
      name: "must not apply after logout",
      threadId: session.providerThreadId,
      type: "threadNameUpdated",
    });

    await readStarted;
    expect(value.store.setProfileState(profile.id, profile.processGeneration, "signed_out")).toBe(true);
    releaseRead();
    await staleFact;

    expect(value.store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: profile.processGeneration,
      state: "signed_out",
    });
    expect(value.store.requireSession(session.id).title).toBe(session.title);
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
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
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
    }, { signal })).resolves.toEqual({
      idempotencyKey: active.idempotencyKey,
      phase: "rejected",
      rejectionCode: "PROVIDER_THREAD_DELETED",
      sessionPublicId: session.id,
    });
    expect((await journal.read()).state).toEqual(recovered);
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

  test("maps bounded Codex failures to phase-specific safe guidance before dispatch", async () => {
    const failures = [
      {
        code: "HOME_MISMATCH",
        reason: "codex_home_mismatch",
        message: "The Codex home does not match this account's isolated runtime. Run `hra doctor --json` and repair the reported configuration before retrying.",
      },
      {
        code: "PROCESS_EXITED",
        reason: "codex_process_exited",
        message: "The pinned Codex process exited before the operation finished. Inspect daemon status before starting a fresh attempt.",
      },
      {
        code: "PROTOCOL_ERROR",
        reason: "codex_protocol_error",
        message: "Codex returned data that violates HRA's pinned protocol. Run `hra doctor --json` and repair or update HRA before retrying.",
      },
      {
        code: "PROTOCOL_LIMIT",
        reason: "codex_protocol_limit",
        message: "Codex data exceeded HRA's bounded protocol limits. Narrow the request where possible or update HRA before trying again.",
      },
      {
        code: "REMOTE_ERROR",
        reason: "codex_remote_rejected",
        message: "Codex rejected the provider request. That request has settled; inspect current state before deciding whether a fresh attempt is appropriate.",
      },
      {
        code: "RUNTIME_MISMATCH",
        reason: "codex_runtime_mismatch",
        message: "HRA's pinned Codex runtime is missing or incompatible. Run `hra doctor --json` and repair or reinstall HRA before retrying.",
      },
      {
        code: "TIMEOUT",
        reason: "codex_timeout",
        message: "Codex did not complete the operation within HRA's bounded deadline. Inspect current state before deciding whether to start a fresh attempt.",
      },
      {
        code: "UNSUPPORTED_CAPABILITY",
        reason: "codex_capability_unsupported",
        message: "The pinned Codex runtime does not support a capability required for this operation. Run `hra doctor --json` and update or reconfigure HRA before retrying.",
      },
    ] as const;
    for (const [index, failure] of failures.entries()) {
      const { service, codex, documents, store } = await fixture();
      const added = await service.execute({ kind: "account.add", label: `Unavailable ${failure.code}` }, { signal }) as { account: { id: string } };
      await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
      await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
      const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
      const idempotencyKey = `00000000-0000-4000-8000-${String(730 + index).padStart(12, "0")}`;
      codex.reviewTurnErrorOnce = new CodexError(failure.code, "private provider capability diagnostic");

      await expect(service.execute({
        kind: "session.send",
        session: started.session.id,
        message: "must not dispatch",
        idempotencyKey,
      }, { signal })).rejects.toMatchObject({
        code: "UNAVAILABLE",
        details: { reason: failure.reason },
        message: failure.message,
      });

      expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
      expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });
      expect(JSON.stringify(store.readMutation(idempotencyKey))).not.toContain("private provider capability diagnostic");
    }
  });

  test("records a dispatched remote rejection as failed and never describes it as unsettled", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Remote rejection" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000799";
    codex.startTurnErrorOnce = new CodexRemoteError(-32_600, "private provider rejection diagnostic");

    const command = {
      kind: "session.send" as const,
      session: started.session.id,
      message: "settled rejection",
      idempotencyKey,
    };
    await expect(service.execute(command, { signal })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reason: "codex_remote_rejected", requestState: "settled" },
      message: "Codex rejected the provider request. That request has settled; inspect current state before deciding whether a fresh attempt is appropriate.",
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "failed" });
    expect(JSON.stringify(store.readMutation(idempotencyKey))).not.toContain("private provider rejection diagnostic");
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
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

  test("returns terminal signed-in evidence when replaying a formerly pending login after provider completion", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Completed login replay" }, { signal }) as { account: { id: `acct_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000120";
    codex.loginResult = {
      status: "pending",
      loginId: "provider-login-completed",
      verificationUrl: "https://example.test/device?secret=completed",
      userCode: "DONE-CODE",
    };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal });

    await service.observeCodexAccount({
      id: added.account.id,
      generation: 1,
      codexHome: "unused",
      desktopUserData: "unused",
    }, {
      signedIn: true,
      email: "completed@example.com",
      plan: "Plus",
    });
    await expect(service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
      idempotencyKey,
    }, { signal })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const replay = await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal });

    expect(replay).toMatchObject({
      account: {
        id: added.account.id,
        processGeneration: 1,
        providerEmail: "completed@example.com",
        providerPlan: "Plus",
        state: "signed_in",
      },
      idempotencyKey,
      login: {
        account: {
          email: "completed@example.com",
          plan: "Plus",
          signedIn: true,
        },
        status: "signed_in",
      },
    });
    expect((replay as { login: unknown }).login).toEqual({
      account: {
        email: "completed@example.com",
        plan: "Plus",
        signedIn: true,
      },
      status: "signed_in",
    });
    expect(codex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain("DONE-CODE");
    expect(JSON.stringify(replay)).not.toContain("secret=completed");
    expect(store.readMutation(idempotencyKey)).toMatchObject({
      authorityGeneration: 1,
      authorityId: added.account.id,
      state: "applied",
    });
  });

  test("returns a typed signed-out settlement when replaying a canceled pending login", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Canceled login replay" }, { signal }) as { account: { id: `acct_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000121";
    codex.loginResult = {
      status: "pending",
      loginId: "provider-login-canceled",
      verificationUrl: "https://example.test/device?secret=canceled",
      userCode: "STOP-CODE",
    };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.cancelLoginResult = { status: "canceled" };
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { processGeneration: 1, state: "signed_out" },
      loginId: "provider-login-canceled",
      providerStatus: "canceled",
      status: "canceled",
    });

    const replay = await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal });
    expect(replay).toEqual({
      account: expect.objectContaining({
        id: added.account.id,
        processGeneration: 1,
        state: "signed_out",
      }),
      idempotencyKey,
      login: { outcome: "signed_out", status: "settled" },
    });
    expect(codex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(1);
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain("STOP-CODE");
    expect(JSON.stringify(replay)).not.toContain("secret=canceled");
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
  });

  test("records the login cancellation before dispatch and replays it under the same key without another provider call", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Ledgered cancel" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-ledger" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.cancelLoginResult = { status: "canceled" };
    const idempotencyKey = "00000000-0000-4000-8000-000000000131";
    let recordedBeforeDispatch: unknown;
    codex.beforeCancelLoginReturn = async () => {
      recordedBeforeDispatch = store.readMutation(idempotencyKey);
    };
    const first = await service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey,
    }, { signal });
    expect(recordedBeforeDispatch).toMatchObject({
      kind: "account.login-cancel",
      authorityId: added.account.id,
      authorityGeneration: 1,
      state: "effect_started",
    });
    expect(first).toMatchObject({
      account: { processGeneration: 1, state: "signed_out" },
      loginId: "provider-login-ledger",
      providerStatus: "canceled",
      status: "canceled",
      idempotencyKey,
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({
      state: "applied",
      result: { loginId: "provider-login-ledger", providerStatus: "canceled", provider: { signedIn: false } },
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
    const cancelCalls = codex.calls.filter((call) => call.startsWith("login-cancel:")).length;
    const readCalls = codex.calls.filter((call) => call === "readAccount").length;

    const replay = await service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey,
    }, { signal });
    expect(replay).toEqual(first);
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(cancelCalls);
    expect(codex.calls.filter((call) => call === "readAccount")).toHaveLength(readCalls);
    expect(cancelCalls).toBe(1);

    const other = await service.execute({ kind: "account.add", label: "Other authority" }, { signal }) as { account: { id: `acct_${string}` } };
    await expect(service.execute({
      kind: "account.login-cancel",
      account: other.account.id,
      idempotencyKey,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("resolves an indeterminate login cancellation from an exact account read and admits a fresh cancellation", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Indeterminate cancel" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-indeterminate" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.beforeCancelLoginReturn = async () => {
      throw new IndeterminateCodexEffectError("account/cancelLogin", 7);
    };
    const firstKey = "00000000-0000-4000-8000-000000000132";
    const secondKey = "00000000-0000-4000-8000-000000000133";
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey: firstKey,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(firstKey)).toMatchObject({ state: "ambiguous", kind: "account.login-cancel" });
    expect(store.requireProfile(added.account.id)).toMatchObject({ processGeneration: 1, state: "login_pending" });

    codex.beforeCancelLoginReturn = undefined;
    codex.cancelLoginResult = { status: "not_found" };
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey: secondKey,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
    expect(store.readMutation(secondKey)).toBeNull();

    const shown = await service.execute({ kind: "account.show", account: added.account.id }, { signal });
    expect(shown).toMatchObject({
      account: { state: "login_pending" },
      login: { status: "pending", loginId: "provider-login-indeterminate" },
    });
    expect(store.readMutation(firstKey)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "provider_state_reconciled", evidence: { source: "account/read", signedIn: false } },
    });
    expect(store.listUnsettledMutations({ authorityId: added.account.id })).toEqual([]);

    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey: secondKey,
    }, { signal })).resolves.toMatchObject({
      account: { state: "signed_out" },
      providerStatus: "not_found",
      status: "canceled",
    });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(2);
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey: firstKey,
    }, { signal })).resolves.toMatchObject({ status: "already_settled" });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(2);
  });

  test("quarantines an effect-started login cancellation at restart and reconciles it from the account read", async () => {
    const value = await fixture();
    const { service, codex, store } = value;
    const added = await service.execute({ kind: "account.add", label: "Crashed cancel" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-crashed-cancel" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const idempotencyKey = "00000000-0000-4000-8000-000000000134";
    const attempt = store.prepareMutation({
      kind: "account.login-cancel",
      authorityId: added.account.id,
      authorityGeneration: 1,
      request: { loginId: "provider-login-crashed-cancel" },
      idempotencyKey,
    });
    store.beginLoginCancelMutationEffect({
      attemptId: attempt.id,
      profileId: added.account.id,
      processGeneration: 1,
      loginId: "provider-login-crashed-cancel",
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({
      state: "effect_started",
      evidence: { evidence: { kind: "account.login-cancel", loginId: "provider-login-crashed-cancel" } },
    });
    // A crash leaves the effect-started attempt behind without the graceful
    // close that retires the profile generation, so the first service is not
    // closed before the restarted one recovers over the same store.
    const restartedCodex = new FakeCodex();
    restartedCodex.accountProjection = { signedIn: false };
    const restarted = new HraService({
      store,
      paths: value.paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      requestStop: () => undefined,
    });
    await restarted.recover();
    expect(store.requireProfile(added.account.id)).toMatchObject({ processGeneration: 1, state: "recovery_required" });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous", result: { code: "DAEMON_RESTART" } });

    const shown = await restarted.execute({ kind: "account.show", account: added.account.id }, { signal });
    expect(shown).toMatchObject({
      account: { processGeneration: 1, state: "signed_out" },
      recovery: { cleared: true, required: false, resolution: "provider_state_reconciled" },
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "reconciled", originalState: "ambiguous" });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
    expect(restartedCodex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(0);
    await restarted.close();
    await service.close();
  });

  test("records a determinate provider rejection as failed when the daemon fence closes during the effect", async () => {
    const { service, codex, store, daemonAuthority } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Fence loss" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.logoutError = new Error("provider rejected the logout");
    codex.beforeLogoutReturn = async () => {
      daemonAuthority.invalidate();
    };
    const idempotencyKey = "00000000-0000-4000-8000-000000000141";
    await expect(service.execute({
      kind: "account.logout",
      account: added.account.id,
      idempotencyKey,
    }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "failed", result: { code: "Error" } });
    expect(store.listUnsettledMutations({ authorityId: added.account.id })).toEqual([]);
    expect(store.recoverEffectStartedMutations()).toEqual({ recovered: [], unresolved: [] });
  });

  test("leaves a fenced effect that lost the daemon fence to restart recovery", async () => {
    const { service, codex, store, daemonAuthority } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Fence loss after effect" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.beforeLogoutReturn = async () => {
      daemonAuthority.invalidate();
    };
    const idempotencyKey = "00000000-0000-4000-8000-000000000142";
    await expect(service.execute({
      kind: "account.logout",
      account: added.account.id,
      idempotencyKey,
    }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
  });

  test("commits a login whose signed-in account fact arrives before the receipt commit without quarantining the profile", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Early account fact" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "signed_in", account: { signedIn: true, email: "person@example.com", plan: "Plus" } };
    let factReturned = false;
    codex.beforeLoginReturn = async ({ authority }) => {
      await service.observeCodexAccount(authority, { signedIn: true, email: "person@example.com", plan: "Plus" });
      factReturned = true;
    };
    const idempotencyKey = "00000000-0000-4000-8000-000000000151";
    const result = await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
      idempotencyKey,
    }, { signal });
    expect(factReturned).toBe(true);
    expect(result).toMatchObject({
      account: { processGeneration: 1, state: "signed_in" },
      login: { status: "signed_in" },
    });
    await service.settled();
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 1,
      state: "signed_in",
      providerEmail: "person@example.com",
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    expect(service.backgroundDiagnostics()).toEqual({ last: null, byCode: [] });
  });

  test("keeps only closed codes and cause classes in background diagnostics", async () => {
    const { service } = await fixture();
    service.recordBackgroundDiagnostic("usage_poll_tick_failed", new Error("secret provider text /Users/private"));
    service.recordBackgroundDiagnostic("usage_poll_tick_failed", new CommandFailure("CONFLICT", "conflict"));
    service.recordBackgroundDiagnostic("queue_dispatch_failed", new DaemonAuthoritySafetyError("stale"));
    const diagnostics = service.backgroundDiagnostics();
    expect(diagnostics.last).toMatchObject({ code: "queue_dispatch_failed", cause: "authority_unsafe", count: 1 });
    expect(diagnostics.byCode).toEqual([
      expect.objectContaining({ code: "queue_dispatch_failed", cause: "authority_unsafe", count: 1 }),
      expect.objectContaining({ code: "usage_poll_tick_failed", cause: "command_failure", count: 2 }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret provider text");
    expect(JSON.stringify(diagnostics)).not.toContain("/Users/private");
  });

  test("settles only the exact failed provider login completion and permits a fresh login", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Timed out login",
    }, { signal }) as { account: { id: `acct_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000122";
    codex.loginResult = { status: "pending", loginId: "provider-login-timeout" };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
      idempotencyKey,
    }, { signal });
    const authority = {
      id: added.account.id,
      generation: 1,
      codexHome: "unused",
      desktopUserData: "unused",
    } as const;

    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: "provider-login-timeout",
      success: true,
    });
    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: null,
      success: false,
    });
    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: "another-provider-login",
      success: false,
    });
    await service.observeCodexFact({ ...authority, generation: 0 }, {
      type: "loginCompleted",
      loginId: "provider-login-timeout",
      success: false,
    });
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 1,
      state: "login_pending",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toMatchObject({
      idempotencyKey,
      loginId: "provider-login-timeout",
    });

    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: "provider-login-timeout",
      success: false,
    });
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 1,
      state: "signed_out",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
    await expect(service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
      idempotencyKey,
    }, { signal })).resolves.toMatchObject({
      login: { outcome: "signed_out", status: "settled" },
    });

    codex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    await expect(service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal })).resolves.toMatchObject({
      account: { processGeneration: 2, state: "signed_in" },
      login: { status: "signed_in" },
    });
  });

  test("returns an old failed-login fact before a queued fresh generation closes that client", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Cancellation race",
    }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-race" };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.cancelLoginResult = { status: "canceled" };
    let releaseCancellation!: () => void;
    let cancellationStarted!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const started = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    codex.beforeCancelLoginReturn = async () => {
      cancellationStarted();
      await cancellationGate;
    };
    let releaseOldFactObserver!: () => void;
    const oldFactObserverReturned = new Promise<void>((resolve) => {
      releaseOldFactObserver = resolve;
    });
    codex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    codex.beforeLoginReturn = async ({ authority }) => {
      if (authority.generation === 2) await oldFactObserverReturned;
    };

    const cancellation = service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal });
    await started;
    const freshLogin = service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await Bun.sleep(0);
    const fact = service.observeCodexFact({
      id: added.account.id,
      generation: 1,
      codexHome: "unused",
      desktopUserData: "unused",
    }, {
      type: "loginCompleted",
      loginId: "provider-login-race",
      success: false,
    }).then(() => {
      releaseOldFactObserver();
    });
    const factDelivery = await Promise.race([
      fact.then(() => "returned" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(factDelivery).toBe("returned");

    releaseCancellation();
    await expect(cancellation).resolves.toMatchObject({
      account: { state: "signed_out" },
      providerStatus: "canceled",
      status: "canceled",
    });
    await expect(freshLogin).resolves.toMatchObject({
      account: { processGeneration: 2, state: "signed_in" },
      login: { status: "signed_in" },
    });
    await service.settled();
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "signed_in",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
  });

  test("orders a failed login completion before a following provider disconnect", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Timeout then disconnect",
    }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-disconnect-race" };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.accountProjection = { signedIn: false };
    let releaseAccountRead!: () => void;
    let accountReadStarted!: () => void;
    const accountReadGate = new Promise<void>((resolve) => {
      releaseAccountRead = resolve;
    });
    const started = new Promise<void>((resolve) => {
      accountReadStarted = resolve;
    });
    codex.beforeReadAccountReturn = async () => {
      accountReadStarted();
      await accountReadGate;
    };
    const authority = {
      id: added.account.id,
      generation: 1,
      codexHome: "unused",
      desktopUserData: "unused",
    } as const;

    const accountShow = service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal });
    await started;
    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: "provider-login-disconnect-race",
      success: false,
    });
    await service.observeCodexFact(authority, {
      type: "providerDisconnected",
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      reason: "process_exit",
    });
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 1,
      state: "login_pending",
    });

    releaseAccountRead();
    await expect(accountShow).resolves.toMatchObject({
      account: { processGeneration: 1, state: "login_pending" },
    });
    await service.settled();
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "signed_out",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
    expect(store.readPendingLoginAuthority(added.account.id, 2)).toBeNull();
  });

  test("atomically retires an old connection while a fresh login advances the profile", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Disconnect retirement");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "disconnect-retirement",
    );
    const session = value.store.requireSession(sessionId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    await value.service.observeCodexFact(seeded.authority, {
      type: "itemStarted",
      connectionId: seeded.interaction.authority.connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-retirement-redaction",
      itemId: "assistant-retirement-redaction",
      itemKind: "agentMessage",
    });
    await value.service.observeCodexFact(seeded.authority, {
      type: "assistantDelta",
      connectionId: seeded.interaction.authority.connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-retirement-redaction",
      itemId: "assistant-retirement-redaction",
      text: "unfinished api_",
    });
    value.codex.observeErrorOnce = new CodexSessionObservationError("resume_unavailable");
    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        basis: "provider_read",
        code: "resume_unavailable",
        coverage: "unavailable",
        freshness: "fresh",
        source: "codex_app_server",
        state: "unavailable",
      },
    });
    expect(JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
      limit: 100,
    }))).not.toContain("unfinished api_");
    await value.service.execute({
      kind: "account.logout",
      account: seeded.authority.id,
    }, { signal });
    expect(value.store.requireInteraction(seeded.interaction.publicId).state).toBe("pending");
    let releaseFreshLogin!: () => void;
    let freshLoginPreflightStarted!: () => void;
    const freshLoginGate = new Promise<void>((resolve) => {
      releaseFreshLogin = resolve;
    });
    const preflightStarted = new Promise<void>((resolve) => {
      freshLoginPreflightStarted = resolve;
    });
    value.cloud.beforeProjectionUnsettledProfileReturn = async (profileId) => {
      if (profileId !== seeded.authority.id) return;
      freshLoginPreflightStarted();
      await freshLoginGate;
    };
    value.codex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    value.codex.beforeLoginReturn = async ({ authority }) => {
      if (authority.generation !== 2) return;
      await value.service.observeCodexFact(seeded.authority, {
        type: "providerDisconnected",
        connectionId: seeded.interaction.authority.connectionId,
        reason: "closed",
      });
    };

    const freshLogin = value.service.execute({
      kind: "account.login",
      account: seeded.authority.id,
      deviceCode: false,
    }, { signal });
    await preflightStarted;
    expect(value.store.requireInteraction(seeded.interaction.publicId).state).toBe("pending");
    expect(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
      limit: 100,
    }).events.map((event) => event.body)).not.toContainEqual(expect.objectContaining({
      type: "connection",
      state: "disconnected",
    }));
    releaseFreshLogin();
    await expect(freshLogin).resolves.toMatchObject({
      account: { processGeneration: 2, state: "signed_in" },
      login: { status: "signed_in" },
    });
    await value.service.settled();

    expect(value.store.requireProfileById(seeded.authority.id)).toMatchObject({
      processGeneration: 2,
      state: "signed_in",
    });
    expect(value.store.requireInteraction(seeded.interaction.publicId).state).toBe("expired");
    const events = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
      limit: 100,
    }).events;
    expect(JSON.stringify(events)).not.toContain("unfinished api_");
    expect(events.flatMap((event) =>
      event.body.type === "assistant_delta" ? [event.body.text] : []))
      .toEqual(["[protected]"]);
    const retirementEvents = events.filter((event) =>
      event.body.type === "assistant_delta"
      || event.body.type === "warning"
      || (event.body.type === "interaction_state" && event.body.interactionId === seeded.interaction.publicId)
      || (event.body.type === "connection" && event.body.state === "disconnected")
      || (event.body.type === "gap" && event.body.reason === "provider_disconnect"));
    expect(retirementEvents.map((event) => event.providerGeneration))
      .toEqual(retirementEvents.map(() => seeded.authority.generation));
    expect(retirementEvents.map((event) => event.sequence))
      .toEqual([...retirementEvents.map((event) => event.sequence)].sort((left, right) => left - right));
    const bodies = events.map((event) => event.body);
    expect(bodies.filter((event) => event.type === "connection" && event.state === "disconnected")).toEqual([{
      type: "connection",
      state: "disconnected",
      reason: "closed",
    }]);
    expect(bodies.filter((event) => event.type === "gap" && event.reason === "provider_disconnect"))
      .toHaveLength(1);
    expect(events.filter((event) => event.body.type === "warning")).toMatchObject([{
      providerConnectionId: null,
      body: {
        code: "provider_resume_unavailable",
        type: "warning",
      },
    }]);
  });

  test("retires a mapped session that a provider list already made terminal", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Terminal login retirement");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal });
    value.codex.listedProjections = [{
      ...value.codex.readProjection,
      providerThreadId: session.providerThreadId,
      status: "terminal",
      providerUpdatedAt: (session.providerUpdatedAt ?? 0) + 1,
    }];
    await value.service.execute({
      kind: "session.list",
      account: profile.id,
      limit: 100,
    }, { signal });
    expect(value.store.requireSession(sessionId).state).toBe("terminal");

    await value.service.execute({
      kind: "account.logout",
      account: profile.id,
    }, { signal });
    value.codex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    await expect(value.service.execute({
      kind: "account.login",
      account: profile.id,
      deviceCode: false,
    }, { signal })).resolves.toMatchObject({
      account: { processGeneration: profile.processGeneration + 1, state: "signed_in" },
      login: { status: "signed_in" },
    });

    const events = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
      limit: 100,
    }).events;
    expect(events.filter((event) =>
      event.body.type === "connection" && event.body.state === "disconnected")).toHaveLength(1);
    expect(events.filter((event) =>
      event.body.type === "gap" && event.body.reason === "provider_disconnect")).toHaveLength(1);
    expect(events.filter((event) =>
      event.body.type === "connection" || event.body.type === "gap").map(
      (event) => event.providerGeneration,
    )).toEqual(events.filter((event) =>
      event.body.type === "connection" || event.body.type === "gap").map(
      () => profile.processGeneration,
    ));
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

  test("causally reconciles a lost send by exact client id within one provider timestamp tick", async () => {
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
    codex.readProjection = { ...codex.readProjection, providerUpdatedAt: 10 };
    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      idempotencyKey: key,
      session: { state: "active", activeTurnId: "turn-next", providerUpdatedAt: 10 },
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

  test("reports a committed scrub quarantine and stops only after the local response boundary", async () => {
    let stopRequests = 0;
    const value = await fixture(undefined, new FakeCloud(), () => { stopRequests += 1; });
    const { sessionId } = await createIdleSession(value, "Committed scrub quarantine");
    const pending = value.store.enqueue(sessionId, "PINNED_SERVICE_QUEUE_BODY_SENTINEL");
    value.store.quarantineSession(sessionId);
    const pinnedReader = new Database(value.paths.database, { readonly: true, strict: true });
    pinnedReader.exec("BEGIN");
    expect(pinnedReader.query(
      "SELECT message FROM queue_entries WHERE id=?",
    ).get(pending.id)).toEqual({ message: "PINNED_SERVICE_QUEUE_BODY_SENTINEL" });
    const afterResponse: Array<() => void> = [];
    try {
      await expect(value.service.execute({
        kind: "session.abandon",
        session: sessionId,
      }, {
        signal,
        afterResponse: (callback) => afterResponse.push(callback),
      })).rejects.toMatchObject({
        code: "UNAVAILABLE",
        details: { operationCommitted: true },
      });
      expect(stopRequests).toBe(0);
      expect(value.store.requireSession(sessionId)).toMatchObject({ state: "terminal" });
      expect(value.store.requireQueue(pending.id)).toMatchObject({
        message: "[queue message removed after settlement]",
        state: "cancelled",
      });
      expect(afterResponse).toHaveLength(1);
      afterResponse[0]?.();
      expect(stopRequests).toBe(1);
    } finally {
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }
    expect(value.store.transitionQueue(pending.id, "pending", "cancelled")).toBe(false);
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

  test("pages recovery across the session quota and bounds eager active observations", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Paged active recovery",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const project = await service.execute({
      kind: "project.add",
      label: "Paged recovery docs",
      path: documents,
    }, { signal }) as { project: { id: `proj_${string}` } };
    const created = Array.from({ length: 103 }, (_, index) => {
      const session = store.createSession({
        profileId: added.account.id,
        projectId: project.project.id,
        title: `Recovery ${String(index)}`,
        preset: "high",
        fastEnabled: false,
      });
      return { index, session };
    }).toSorted((left, right) => left.session.id.localeCompare(right.session.id));
    const active = new Set(created.slice(-3).map(({ session }) => session.id));
    for (const { index, session } of created) {
      store.bindSession({
        sessionId: session.id,
        expectedRevision: session.revision,
        providerThreadId: `provider-recovery-${String(index)}`,
        state: active.has(session.id) ? "active" : "idle",
        ...(active.has(session.id) ? { activeTurnId: `turn-${String(index)}` } : {}),
      });
    }
    codex.beforeObserveReturn = async () => await Bun.sleep(2);

    const readiness = await Promise.race([
      service.recover().then(() => "ready" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(readiness).toBe("ready");
    await service.settled();
    for (const { index, session } of created.slice(-3)) {
      expect(codex.observedThreads).toContain(`provider-recovery-${String(index)}`);
      expect(active.has(session.id)).toBe(true);
    }
    expect(codex.maximumConcurrentObservations).toBe(1);
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

  test("stops after a committed queued turn scrub failure without inventing ambiguity", async () => {
    let stopRequests = 0;
    const value = await fixture(undefined, new FakeCloud(), () => { stopRequests += 1; });
    const { sessionId } = await createIdleSession(value, "Queued scrub quarantine");
    let releaseProvider!: () => void;
    let signalProviderApplied!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerApplied = new Promise<void>((resolve) => { signalProviderApplied = resolve; });
    value.codex.beforeStartTurnReturn = async () => {
      signalProviderApplied();
      await providerGate;
    };
    const result = await value.service.execute({
      kind: "session.queue",
      session: sessionId,
      message: "PINNED_BACKGROUND_QUEUE_BODY_SENTINEL",
    }, { signal }) as { queued: { id: `queue_${string}` } };
    await providerApplied;

    const pinnedReader = new Database(value.paths.database, { readonly: true, strict: true });
    pinnedReader.exec("BEGIN");
    expect(pinnedReader.query(
      "SELECT message,state FROM queue_entries WHERE id=?",
    ).get(result.queued.id)).toEqual({
      message: "PINNED_BACKGROUND_QUEUE_BODY_SENTINEL",
      state: "dispatching",
    });
    try {
      releaseProvider();
      await value.service.settled();
      expect(stopRequests).toBe(1);
      expect(value.store.requireQueue(result.queued.id)).toMatchObject({
        message: "[queue message removed after settlement]",
        state: "applied",
      });
      expect(value.store.requireSession(sessionId).state).not.toBe("recovery_required");
      expect(value.store.listUnsettledQueueEffects(sessionId)).toEqual([]);
    } finally {
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }
    expect(value.store.transitionQueue(result.queued.id, "dispatching", "applied")).toBe(false);
  });

  test("stops when a deterministic queued turn failure commits but its scrub cannot finish", async () => {
    let stopRequests = 0;
    const value = await fixture(undefined, new FakeCloud(), () => { stopRequests += 1; });
    const { sessionId } = await createIdleSession(value, "Failed queue scrub quarantine");
    let releaseProvider!: () => void;
    let signalProviderEntered!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerEntered = new Promise<void>((resolve) => { signalProviderEntered = resolve; });
    value.codex.startTurnErrorOnce = new Error("Deterministic provider turn rejection.");
    value.codex.beforeStartTurnEffect = async () => {
      signalProviderEntered();
      await providerGate;
    };
    const result = await value.service.execute({
      kind: "session.queue",
      session: sessionId,
      message: "PINNED_FAILED_QUEUE_BODY_SENTINEL",
    }, { signal }) as { queued: { id: `queue_${string}` } };
    await providerEntered;

    const pinnedReader = new Database(value.paths.database, { readonly: true, strict: true });
    pinnedReader.exec("BEGIN");
    expect(pinnedReader.query(
      "SELECT message,state FROM queue_entries WHERE id=?",
    ).get(result.queued.id)).toEqual({
      message: "PINNED_FAILED_QUEUE_BODY_SENTINEL",
      state: "dispatching",
    });
    try {
      releaseProvider();
      await value.service.settled();
      expect(stopRequests).toBe(1);
      expect(value.store.requireQueue(result.queued.id)).toMatchObject({
        message: "[queue message removed after settlement]",
        state: "failed",
      });
      expect(value.store.requireSession(sessionId).state).toBe("idle");
      expect(value.store.listUnsettledQueueEffects(sessionId)).toEqual([]);
    } finally {
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }
    expect(value.store.transitionQueue(result.queued.id, "dispatching", "failed")).toBe(false);
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
    codex.readProjection = { ...codex.readProjection, providerUpdatedAt: 10 };

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
    value.codex.observationConnectionId = connectionId;
    await value.service.observeCodexFact(authority, {
      type: "itemStarted",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "item-live",
      itemKind: "commandExecution",
      liveAcceptanceCommandDigest: "a".repeat(64),
    });
    await value.service.observeCodexFact(authority, {
      type: "assistantDelta",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "item-live",
      text: "Visible progress",
    });
    await value.service.observeCodexFact(authority, {
      type: "itemCompleted",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "item-live",
      itemKind: "commandExecution",
      status: "completed",
      liveAcceptanceCommandDigest: "a".repeat(64),
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
      "item_completed",
    ]);
    expect(first.events.at(-2)?.body.text).toBe("Visible progress");
    expect(first.events[1]?.body).toMatchObject({
      type: "item_started",
      liveAcceptanceCommandDigest: "a".repeat(64),
    });

    await value.service.observeCodexFact(authority, {
      type: "itemStarted",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "reasoning-live",
      itemKind: "reasoning",
    });

    const status = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(status).toMatchObject({
      version: 2,
      session: { id: sessionId, execution: "idle" },
      advisory: {
        attention: "none",
        execution: "idle",
        queueDepth: 0,
      },
      localObservation: {
        coverage: "complete",
        freshness: "fresh",
        source: "sqlite",
      },
      providerObservation: {
        basis: "provider_read",
        connectionId,
        coverage: "complete",
        freshness: "fresh",
        profileGeneration: authority.generation,
        source: "codex_app_server",
        state: "live",
      },
      eventStream: { observedThroughSequence: 5 },
      interactions: {
        pending: [],
        pendingCount: 0,
        responseInFlightCount: 0,
        truncated: false,
      },
      queue: {
        ambiguousCount: 0,
        depth: 0,
        dispatchingCount: 0,
        failedCount: 0,
      },
    });
    expect(Object.keys(status).sort()).toEqual([
      "advisory",
      "eventStream",
      "interactions",
      "localObservation",
      "providerObservation",
      "queue",
      "session",
      "version",
    ]);
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
    await value.service.observeCodexFact(authority, {
      type: "itemCompleted",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "reasoning-live",
      itemKind: "reasoning",
      status: "completed",
    });
    await expect(waiting).resolves.toMatchObject({
      events: [
        { body: { type: "reasoning_summary_delta", text: "Checking the public contract" } },
        {
          body: {
            type: "item_completed",
            itemId: value.eventCursors.projectPublicProviderIdentifier("reasoning-live"),
          },
        },
      ],
    });
    await expect(value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: `${first.nextCursor}tampered`,
      limit: 10,
      waitMs: 0,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("maintains idle and terminal event streams on read without a new append", async () => {
    for (const localState of ["idle_signed_out", "terminal"] as const) {
      let currentTime = 1_000;
      const value = await fixture(
        undefined,
        new FakeCloud(),
        () => undefined,
        () => currentTime,
      );
      const { sessionId } = await createIdleSession(value, `Read retention ${localState}`);
      const session = value.store.requireSession(sessionId);
      const profile = value.store.requireProfileById(session.profileId);
      const event = value.store.appendSessionEvent({
        sessionId,
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: null,
        body: {
          type: "warning",
          code: "RETENTION",
          message: `age ${localState} without append`,
        },
      });
      if (localState === "idle_signed_out") {
        expect(value.store.setProfileState(
          profile.id,
          profile.processGeneration,
          "signed_out",
        )).toBe(true);
      } else {
        value.store.setSessionTurnState({
          sessionId,
          expectedRevision: session.revision,
          state: "terminal",
        });
      }
      const cursor = value.eventCursors.encode({
        version: 1,
        sessionId,
        streamEpoch: event.streamEpoch,
        sequence: 0,
      });
      const providerReadsBefore = value.codex.observedThreads.length;

      currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;

      const page = sessionEventPageSchema.parse(await value.service.execute({
        kind: "session.events",
        session: sessionId,
        cursor,
        limit: 10,
        waitMs: 0,
      }, { signal }));
      expect(page.events).toEqual([]);
      expect(page.gap).toEqual({
        reason: "retention_age",
        requestedSequence: 0,
        retainedFromSequence: event.sequence + 1,
      });
      expect(value.eventCursors.decode(page.nextCursor)).toEqual({
        version: 1,
        sessionId,
        streamEpoch: event.streamEpoch,
        sequence: event.sequence,
      });
      expect(value.store.eventStreamPosition(sessionId)).toEqual({
        streamEpoch: event.streamEpoch,
        floorSequence: event.sequence + 1,
        observedThroughSequence: event.sequence,
      });
      expect(value.codex.observedThreads).toHaveLength(providerReadsBefore);
    }
  });

  test("fails an unavailable event follow closed after surfacing one durable warning", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Unavailable observation");
    const position = value.store.eventStreamPosition(sessionId);
    const cursor = value.eventCursors.encode({
      version: 1,
      sessionId,
      streamEpoch: position.streamEpoch,
      sequence: position.observedThroughSequence,
    });
    const observationsBeforeInvalidCursor = value.codex.observedThreads.length;
    await expect(value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: `${cursor}tampered`,
      limit: 200,
      waitMs: 1_000,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(value.codex.observedThreads).toHaveLength(observationsBeforeInvalidCursor);
    value.codex.observeError = new CodexSessionObservationError("resume_unavailable");

    const startedAt = Date.now();
    const warningPage = await value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor,
      limit: 200,
      waitMs: 1_000,
    }, { signal }) as { events: Array<{ body: { type: string; code?: string } }>; nextCursor: string };
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(warningPage.events).toHaveLength(1);
    expect(warningPage.events[0]?.body).toMatchObject({
      code: "provider_resume_unavailable",
      type: "warning",
    });
    await expect(value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: warningPage.nextCursor,
      limit: 200,
      waitMs: 1_000,
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    await expect(value.service.execute({
      kind: "session.send",
      session: sessionId,
      message: "must not dispatch",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000711",
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(value.codex.calls).not.toContain("send");
    await expect(value.service.execute({
      kind: "session.queue",
      session: sessionId,
      message: "dispatch after reconnect",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000712",
    }, { signal })).resolves.toMatchObject({ queued: { state: "pending" } });
  });

  test("quarantines a mismatched resumed thread and exposes the closed status", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Mismatched observation");
    value.codex.observationThreadIdOverride = "provider-thread-foreign";

    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        basis: "provider_read",
        code: "thread_mismatch",
        coverage: "partial",
        freshness: "fresh",
        source: "codex_app_server",
        state: "recovery_required",
      },
      advisory: {
        attention: "recovery_required",
        execution: "recovery_required",
      },
      session: { execution: "recovery_required" },
    });
    const mismatch = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events.find((event) => event.body.type === "error");
    expect(mismatch?.body).toMatchObject({
      code: "provider_thread_mismatch",
      terminal: true,
      type: "error",
    });
  });

  test("reports explicit provider provenance for unbound, signed-out, quarantined, and terminal sessions", async () => {
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => 210_000);
    const unboundProfile = value.store.createProfile("Unbound observation");
    const unboundSession = value.store.createSession({
      profileId: unboundProfile.id,
      title: "Unbound observation",
      preset: "high",
      fastEnabled: false,
    });
    const unbound = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: unboundSession.id,
    }, { signal }));
    expect(unbound.providerObservation).toEqual({
      source: "codex_app_server",
      basis: "local_state",
      profileGeneration: 0,
      observedAt: 210_000,
      state: "not_applicable",
      coverage: "not_attempted",
      freshness: "unknown",
      reason: "unbound",
    });

    const { sessionId } = await createIdleSession(value, "Provider variants");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const observeCallsBeforeNonLiveStatuses = value.codex.calls.filter(
      (call) => call === "observe",
    ).length;
    expect(value.store.setProfileState(profile.id, profile.processGeneration, "signed_out")).toBe(true);
    const signedOut = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(signedOut.providerObservation).toEqual({
      source: "codex_app_server",
      basis: "local_state",
      profileGeneration: profile.processGeneration,
      observedAt: 210_000,
      state: "unavailable",
      coverage: "unavailable",
      freshness: "fresh",
      code: "account_signed_out",
    });

    value.store.setSessionTurnState({
      sessionId,
      expectedRevision: session.revision,
      state: "recovery_required",
    });
    const quarantined = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(quarantined.providerObservation).toEqual({
      source: "codex_app_server",
      basis: "local_state",
      profileGeneration: profile.processGeneration,
      observedAt: 210_000,
      state: "recovery_required",
      coverage: "partial",
      freshness: "fresh",
      code: "session_quarantined",
    });
    expect(quarantined.advisory.attention).toBe("recovery_required");

    const terminalSession = value.store.upsertProviderSession({
      profileId: profile.id,
      providerThreadId: "provider-terminal-observation",
      title: "Terminal provider observation",
      state: "terminal",
    });
    const terminal = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: terminalSession.id,
    }, { signal }));
    expect(terminal.providerObservation).toEqual({
      source: "codex_app_server",
      basis: "local_state",
      profileGeneration: profile.processGeneration,
      observedAt: 210_000,
      state: "not_applicable",
      coverage: "not_attempted",
      freshness: "unknown",
      reason: "terminal",
    });
    expect(terminal.advisory).toMatchObject({
      attention: "none",
      execution: "terminal",
    });
    expect(value.codex.calls.filter((call) => call === "observe")).toHaveLength(
      observeCallsBeforeNonLiveStatuses,
    );
  });

  test("does not append an old-generation warning when resume retirement advances authority", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Retired observation generation");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const before = value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
    value.codex.beforeObserveReturn = async () => {
      delete value.codex.beforeObserveReturn;
      value.store.advanceProfileGeneration(profile.id, profile.processGeneration);
    };
    value.codex.observeErrorOnce = new CodexSessionObservationError("resume_unavailable");

    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        basis: "provider_read",
        code: "resume_unavailable",
        profileGeneration: profile.processGeneration + 1,
        state: "unavailable",
      },
    });
    expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events).toEqual(before);
  });

  test("preserves parsed MCP tool identity through safe events and human rendering", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "MCP lifecycle stream");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "30000000-0000-4000-8000-000000000002";
    const providerArgumentsSecret = "MCP-ARGUMENT-SECRET-MUST-NOT-PERSIST";
    const providerResultSecret = "MCP-RESULT-SECRET-MUST-NOT-PERSIST";
    const providerItem = {
      type: "mcpToolCall",
      id: "mcp-item-1",
      server: "github",
      tool: "create_issue",
      status: "inProgress",
      arguments: { token: providerArgumentsSecret },
      result: { content: providerResultSecret },
    };

    await value.service.observeCodexFact(authority, {
      ...parseFact("item/started", {
        threadId: session.providerThreadId,
        turnId: "turn-mcp",
        item: providerItem,
      }),
      connectionId,
    });
    await value.service.observeCodexFact(authority, {
      ...parseFact("item/completed", {
        threadId: session.providerThreadId,
        turnId: "turn-mcp",
        item: { ...providerItem, status: "completed" },
      }),
      connectionId,
    });

    const command = {
      kind: "session.events",
      session: sessionId,
      limit: 200,
      waitMs: 0,
    } satisfies LocalCommand;
    const page = await value.service.execute(command, { signal }) as {
      events: Array<{ body: Record<string, unknown> }>;
    };
    const lifecycle = page.events
      .map((event) => event.body)
      .filter((body) => body.type === "item_started" || body.type === "item_completed");
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0]).toMatchObject({
      type: "item_started",
      itemKind: "mcpToolCall",
      server: "github",
      tool: "create_issue",
    });
    expect(lifecycle[1]).toMatchObject({
      type: "item_completed",
      itemKind: "mcpToolCall",
      server: "github",
      tool: "create_issue",
      status: "completed",
    });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(providerArgumentsSecret);
    expect(serialized).not.toContain(providerResultSecret);
    expect(serialized).not.toContain('"arguments"');
    expect(serialized).not.toContain('"result"');
    expect(renderHuman(command, page)).toContain("mcpToolCall github/create_issue");
    expect(renderJson(command, page)).toContain('"server":"github"');
    expect(renderJson(command, page)).toContain('"tool":"create_issue"');
  });

  test("turns a valid prior-epoch cursor into one resumable stream-restored gap", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Restored event stream");
    const priorEpoch = "7f000000-0000-4000-8000-000000000001";
    const priorCursor = value.eventCursors.encode({
      version: 1,
      sessionId,
      streamEpoch: priorEpoch,
      sequence: 99,
    });

    const restored = await value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: priorCursor,
      limit: 1,
      waitMs: 30_000,
    }, { signal }) as {
      requestedCursor: string;
      nextCursor: string;
      gap: null | { reason: string; requestedSequence: number | null };
      events: Array<{ streamEpoch: string }>;
    };
    expect(restored).toMatchObject({
      requestedCursor: priorCursor,
      gap: { reason: "stream_restored", requestedSequence: 99 },
    });
    expect(restored.nextCursor).not.toBe(priorCursor);
    expect(restored.events.every((entry) => entry.streamEpoch !== priorEpoch)).toBe(true);

    const resumed = await value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: restored.nextCursor,
      limit: 200,
      waitMs: 0,
    }, { signal }) as { requestedCursor: string; gap: unknown };
    expect(resumed).toMatchObject({ requestedCursor: restored.nextCursor, gap: null });
  });

  test("routes provider close and delete lifecycle without leaving a mutable stale session", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
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
    factsMemory.ensures.length = 0;
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
    expect(factsMemory.ensures.at(-1)).toMatchObject({
      ownerId: profile.id,
      sessionId,
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
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
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
    expect(factsMemory.cleanups).toContainEqual({
      ownerId: profile.id,
      reason: "archive",
      sessionId,
    });
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

  test("redacts interleaved streamed and complete provider prose before SQLite or CLI output", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Stream confidentiality");
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
    const observe = async (fact: CodexFact): Promise<void> =>
      await value.service.observeCodexFact(authority, { ...fact, connectionId });

    await observe({
      type: "assistantDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "assistant-private",
      text: "Before Authori",
    });
    await observe({
      type: "reasoningSummaryDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "reasoning-private",
      summaryIndex: 0,
      text: "Checking device_",
    });
    await observe({
      type: "assistantDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "assistant-private",
      text: "zation: Bearer ASSISTANT-STREAM-SECRET-11\nAfter",
    });
    await observe({
      type: "reasoningSummaryDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "reasoning-private",
      summaryIndex: 0,
      text: "code=REASONING-STREAM-SECRET-22 done",
    });
    expect(JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }))).not.toContain("STREAM-SECRET");

    for (const [itemId, itemKind] of [
      ["assistant-private", "agentMessage"],
      ["reasoning-private", "reasoning"],
    ] as const) {
      await observe({
        type: "itemCompleted",
        threadId: session.providerThreadId,
        turnId: "turn-private",
        itemId,
        itemKind,
        status: "completed",
      });
    }
    await observe({
      type: "planUpdated",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      steps: [{
        text: "Load api_key=PLAN-PROSE-SECRET-33",
        status: "in_progress",
      }],
      explanation: `Read ${privatePathRoot}/.env with token=PLAN-PROSE-SECRET-44`,
    });
    await observe({
      type: "interactionRequested",
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: "confidentiality-request" },
        method: "item/tool/requestUserInput",
        requestDigest: "c".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-private",
        itemId: "question-private",
        approvalId: null,
      },
      kind: "user_input",
      blocking: true,
      display: {
        kind: "user_input",
        summary: "Authorization: Bearer INTERACTION-PROSE-SECRET-55",
        blocking: true,
        questions: [{
          id: "question-safe",
          header: "Device code=INTERACTION-PROSE-SECRET-66",
          question: `Continue from ${privatePathRoot}/project?`,
          options: [{ label: "Continue", description: "Use token=INTERACTION-PROSE-SECRET-77" }],
          allowsOther: false,
          secret: false,
        }],
      },
    });
    await observe({
      type: "assistantDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "interrupted-private",
      text: "unfinished api_",
    });
    await value.service.observeCodexFact(authority, {
      type: "providerDisconnected",
      connectionId,
      reason: "process_exit",
    });

    const command = {
      kind: "session.events",
      session: sessionId,
      limit: 200,
      waitMs: 0,
    } satisfies LocalCommand;
    const page = await value.service.execute(command, { signal });
    const durableEvents = JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }));
    const durableInteractions = JSON.stringify(value.store.listInteractions({
      sessionId,
      pendingOnly: false,
    }));
    for (const output of [
      durableEvents,
      durableInteractions,
      renderHuman(command, page),
      renderJson(command, page),
    ]) {
      expect(output).not.toContain("STREAM-SECRET");
      expect(output).not.toContain("PROSE-SECRET");
      expect(output).not.toContain(privatePathRoot);
      expect(output).not.toContain("unfinished api_");
    }
    expect(durableEvents).toContain("[protected]");
    expect(durableEvents).toContain("[local-path]");
    expect(durableEvents).toContain("provider_disconnect");
  });

  test("rejects unsafe exact interaction answer keys before durable admission", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Unsafe interaction key");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "33000000-0000-4000-8000-000000000001";
    await expect(value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: "unsafe-exact-key" },
        method: "item/tool/requestUserInput",
        requestDigest: "d".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-unsafe-key",
        itemId: "item-unsafe-key",
        approvalId: null,
      },
      kind: "user_input",
      blocking: true,
      display: {
        kind: "user_input",
        summary: "Choose",
        blocking: true,
        questions: [{
          id: "Authorization: Bearer EXACT-KEY-SECRET-11",
          header: "Choice",
          question: "Choose one",
          options: null,
          allowsOther: false,
          secret: false,
        }],
      },
    })).rejects.toThrow("UNSAFE_EXACT_INTERACTION_DISPLAY:question_id");
    expect(value.store.listInteractions({ sessionId, pendingOnly: false })).toEqual([]);
    expect(JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }))).not.toContain("EXACT-KEY-SECRET-11");
  });

  for (const fault of [
    { boundary: "prepare", timing: "before", providerCalls: 0, state: "expired" },
    { boundary: "prepare", timing: "after", providerCalls: 0, state: "expired" },
    { boundary: "prepared_event", timing: "before", providerCalls: 0, state: "expired" },
    { boundary: "prepared_event", timing: "after", providerCalls: 0, state: "expired" },
    { boundary: "mark", timing: "before", providerCalls: 1, state: "resolution_unknown" },
    { boundary: "mark", timing: "after", providerCalls: 1, state: "resolution_unknown" },
    { boundary: "written_event", timing: "before", providerCalls: 1, state: "resolution_unknown" },
    { boundary: "written_event", timing: "after", providerCalls: 1, state: "resolution_unknown" },
  ] as const) {
    test(`quarantines an interaction persistence fault ${fault.timing} ${fault.boundary}`, async () => {
      let stopCalls = 0;
      const value = await fixture(
        undefined,
        new FakeCloud(),
        () => { stopCalls += 1; },
      );
      const { sessionId } = await createIdleSession(
        value,
        `Persistence ${fault.boundary} ${fault.timing}`,
      );
      const seeded = await seedResolvableInteraction(
        value,
        sessionId,
        `persistence-${fault.boundary}-${fault.timing}`,
      );
      const originalGeneration = seeded.authority.generation;
      let injected = false;
      if (fault.boundary === "prepare") {
        const original = value.store.prepareInteractionResponse.bind(value.store);
        (value.store as unknown as {
          prepareInteractionResponse: StateStore["prepareInteractionResponse"];
        }).prepareInteractionResponse = (input) => {
          if (injected) return original(input);
          injected = true;
          if (fault.timing === "after") original(input);
          throw new Error(`injected ${fault.timing} prepare fault`);
        };
      } else if (fault.boundary === "mark") {
        const original = value.store.markInteractionResponseWritten.bind(value.store);
        (value.store as unknown as {
          markInteractionResponseWritten: StateStore["markInteractionResponseWritten"];
        }).markInteractionResponseWritten = (input) => {
          if (injected) return original(input);
          injected = true;
          if (fault.timing === "after") original(input);
          throw new Error(`injected ${fault.timing} mark fault`);
        };
      } else {
        const targetState = fault.boundary === "prepared_event"
          ? "response_prepared"
          : "response_written";
        const original = value.store.appendSessionEvent.bind(value.store);
        (value.store as unknown as {
          appendSessionEvent: StateStore["appendSessionEvent"];
        }).appendSessionEvent = (input) => {
          if (
            !injected
            && input.body.type === "interaction_state"
            && input.body.state === targetState
          ) {
            injected = true;
            if (fault.timing === "after") original(input);
            throw new Error(`injected ${fault.timing} ${fault.boundary} fault`);
          }
          return original(input);
        };
      }

      const command = {
        kind: "interaction.resolve" as const,
        interaction: seeded.interaction.publicId,
        expectedRevision: seeded.interaction.revision,
        resolution: { kind: "approval_decision" as const, decision: "once" as const },
      };
      const beforeQuarantine = await value.service.execute({
        kind: "session.status",
        session: sessionId,
      }, { signal }) as { eventStream: { cursor: string } };
      const afterResponse: Array<() => void> = [];
      const error = await value.service.execute(command, {
        signal,
        afterResponse: (callback) => { afterResponse.push(callback); },
      }).catch((caught: unknown) => caught);

      expect(injected).toBe(true);
      expect(error).toMatchObject({
        code: "RECOVERY_REQUIRED",
        details: {
          daemonRestartRequired: true,
          interaction: {
            id: seeded.interaction.publicId,
            state: fault.state,
          },
        },
      });
      expect(value.codex.resolvedInteractions).toHaveLength(fault.providerCalls);
      expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
        state: fault.state,
      });
      expect(value.store.requireProfileById(seeded.authority.id).processGeneration)
        .toBe(originalGeneration + 1);
      expect(afterResponse).toHaveLength(1);
      expect(stopCalls).toBe(0);

      const publicEvents = await value.service.execute({
        kind: "session.events",
        session: sessionId,
        cursor: beforeQuarantine.eventStream.cursor,
        limit: 200,
        waitMs: 0,
      }, { signal }) as {
        events: Array<{
          body: {
            interactionId?: string;
            revision?: number;
            state?: string;
            type: string;
          };
        }>;
      };
      expect(publicEvents.events.at(-1)?.body).toEqual({
        type: "interaction_state",
        interactionId: seeded.interaction.publicId,
        state: fault.state,
        revision: expect.any(Number),
      });

      const restartVisible = new StateStore(value.paths, { readonly: true });
      try {
        expect(restartVisible.requireInteraction(seeded.interaction.publicId)).toMatchObject({
          state: fault.state,
        });
        expect(restartVisible.requireProfileById(seeded.authority.id).processGeneration)
          .toBe(originalGeneration + 1);
        expect(restartVisible.listSessionEvents({
          sessionId,
          afterSequence: 0,
        }).events.at(-1)?.body).toEqual({
          type: "interaction_state",
          interactionId: seeded.interaction.publicId,
          state: fault.state,
          revision: expect.any(Number),
        });
      } finally {
        restartVisible.close();
      }

      await expect(value.service.execute(command, {
        signal,
        afterResponse: (callback) => { afterResponse.push(callback); },
      })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(value.codex.resolvedInteractions).toHaveLength(fault.providerCalls);
      expect(afterResponse).toHaveLength(1);

      const eventsBeforeStaleFact = value.store.listSessionEvents({
        sessionId,
        afterSequence: 0,
      }).events;
      await value.service.observeCodexFact(seeded.authority, {
        type: "assistantDelta",
        connectionId: seeded.interaction.authority.connectionId,
        threadId: seeded.interaction.authority.threadId as string,
        turnId: "turn-stale-persistence-boundary",
        itemId: "item-stale-persistence-boundary",
        text: "must remain fenced",
      });
      expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events)
        .toEqual(eventsBeforeStaleFact);

      afterResponse[0]?.();
      expect(stopCalls).toBe(1);
      await value.service.close();
    });
  }

  test("stops admitting work immediately when the atomic interaction quarantine itself fails", async () => {
    let stopCalls = 0;
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => { stopCalls += 1; },
    );
    const { sessionId } = await createIdleSession(value, "Failed persistence quarantine");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "failed-persistence-quarantine",
    );
    const originalPrepare = value.store.prepareInteractionResponse.bind(value.store);
    const originalQuarantine = value.store.quarantineInteractionPersistenceBoundary
      .bind(value.store);
    (value.store as unknown as {
      prepareInteractionResponse: StateStore["prepareInteractionResponse"];
      quarantineInteractionPersistenceBoundary:
        StateStore["quarantineInteractionPersistenceBoundary"];
    }).prepareInteractionResponse = () => {
      throw new Error("injected prepare failure before commit");
    };
    (value.store as unknown as {
      quarantineInteractionPersistenceBoundary:
        StateStore["quarantineInteractionPersistenceBoundary"];
    }).quarantineInteractionPersistenceBoundary = () => {
      throw new Error("injected atomic quarantine failure");
    };
    const afterResponse: Array<() => void> = [];

    const error = await value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, {
      signal,
      afterResponse: (callback) => { afterResponse.push(callback); },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: {
        daemonRestartRequired: true,
        interaction: { id: seeded.interaction.publicId, state: "pending" },
      },
    });
    expect((error as Error).message).toContain("could not be confirmed");
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      state: "pending",
      revision: 1,
    });
    expect(value.store.requireProfileById(seeded.authority.id).processGeneration)
      .toBe(seeded.authority.generation);
    expect(afterResponse).toHaveLength(1);
    await expect(value.service.execute({ kind: "account.list" }, { signal }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(stopCalls).toBe(0);
    afterResponse[0]?.();
    expect(stopCalls).toBe(1);

    (value.store as unknown as {
      prepareInteractionResponse: StateStore["prepareInteractionResponse"];
      quarantineInteractionPersistenceBoundary:
        StateStore["quarantineInteractionPersistenceBoundary"];
    }).prepareInteractionResponse = originalPrepare;
    (value.store as unknown as {
      quarantineInteractionPersistenceBoundary:
        StateStore["quarantineInteractionPersistenceBoundary"];
    }).quarantineInteractionPersistenceBoundary = originalQuarantine;
    await value.service.close();
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
    const privateTurnId = `${["", "Users", "person", "private"].join("/")}/api_key=INTERACTION-TURN-SECRET`;
    const privateItemId = "token=INTERACTION-ITEM-SECRET";
    const provider = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId: "40000000-0000-4000-8000-000000000001",
      requestId: { type: "string" as const, value: "approval-request-1" },
      method: "item/commandExecution/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: session.providerThreadId,
      turnId: privateTurnId,
      itemId: privateItemId,
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
        availableDecisions: ["once" as const, "cancel" as const],
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
    expect(JSON.stringify(listed)).not.toContain(privateTurnId);
    expect(JSON.stringify(listed)).not.toContain(privateItemId);
    const interaction = listed.interactions[0];
    if (interaction === undefined) throw new Error("Expected an admitted interaction.");
    expect(publicInteractionSchema.parse(interaction)).toEqual(interaction);
    expect(interaction.context.turnId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(interaction.context.itemId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    if (interaction.context.turnId === null) {
      throw new Error("Expected a public turn alias.");
    }
    const publicTurnId = interaction.context.turnId;
    expect(value.store.requireInteraction(interaction.id).authority).toMatchObject({
      turnId: privateTurnId,
      itemId: privateItemId,
    });

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
    const privateNote = "PRIVATE-SESSION-NOTE-MUST-NOT-LEAK";
    const beforeNote = value.store.requireSession(sessionId);
    value.store.updateSessionMetadata({
      sessionId,
      expectedRevision: beforeNote.revision,
      note: privateNote,
    });
    const beforeActive = value.store.requireSession(sessionId);
    value.store.setSessionTurnState({
      sessionId,
      expectedRevision: beforeActive.revision,
      state: "active",
      activeTurnId: privateTurnId,
    });
    value.store.appendSessionEvent({
      sessionId,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: provider.connectionId,
      body: { type: "turn_started", turnId: privateTurnId },
    });
    value.codex.readProjection = {
      ...value.codex.readProjection,
      providerThreadId: session.providerThreadId,
      status: "active",
      activeTurnId: privateTurnId,
      providerUpdatedAt: (value.codex.readProjection.providerUpdatedAt ?? 10) + 1,
    };
    const statusCommand = { kind: "session.status", session: sessionId } satisfies LocalCommand;
    const status = sessionStatusSchema.parse(
      await value.service.execute(statusCommand, { signal }),
    );
    expect(status.session.activeTurnId).toBe(publicTurnId);
    const eventAliases = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events.flatMap((event) =>
      event.body.type === "turn_started" ? [event.body.turnId] : []);
    expect(eventAliases).toContain(publicTurnId);
    const serializedStatus = JSON.stringify(status);
    expect(serializedStatus).not.toContain(privateNote);
    expect(serializedStatus).not.toContain(session.providerThreadId);
    expect(serializedStatus).not.toContain('"note"');
    expect(serializedStatus).not.toContain('"providerThreadId"');
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
      expect(json).not.toContain("INTERACTION-TURN-SECRET");
      expect(json).not.toContain("INTERACTION-ITEM-SECRET");
      expect(json).not.toContain("requestDigest");
      expect(json).not.toContain("responseDigest");
      expect(json).not.toContain("authority");
    }

    expect(renderHuman(interactionShowCommand, interactionShow)).toContain(
      "Available decisions: once, cancel",
    );
    const privateCommand = "git reset --hard PRIVATE-AUTHORITY-SENTINEL";
    value.codex.interactionAuthority = {
      kind: "command_approval",
      command: privateCommand,
      reason: "Apply the exact private command",
      availableDecisions: ["accept", "cancel"],
      workingDirectory: "/private/workspace",
      environmentId: "environment-1",
      commandActions: [{ type: "unknown", command: privateCommand }],
      networkApprovalContext: { host: "private.example", protocol: "https" },
      additionalPermissions: { network: { enabled: true } },
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
    };
    const inspectCommand = {
      kind: "interaction.inspect",
      interaction: interaction.id,
      expectedRevision: interaction.revision,
    } satisfies LocalCommand;
    const inspected = await value.service.execute(inspectCommand, { signal });
    const protectedDocument = protectedInteractionDetailDocumentSchema.parse(inspected);
    expect(protectedDocument.binding).toEqual({
      interactionId: interaction.id,
      revision: interaction.revision,
      kind: "command_approval",
      sessionId,
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId: provider.connectionId,
    });
    expect(protectedDocument.authority).toEqual(value.codex.interactionAuthority);
    expect(value.codex.inspectedInteractions).toHaveLength(1);
    expect(value.codex.inspectedInteractions[0]).toMatchObject({
      authority: expect.objectContaining({
        id: profile.id,
        generation: profile.processGeneration,
      }),
      provider,
      kind: "command_approval",
    });
    expect(JSON.stringify(value.store.requireInteraction(interaction.id))).not.toContain(
      "PRIVATE-AUTHORITY-SENTINEL",
    );
    expect(renderJson(inspectCommand, inspected)).not.toContain("PRIVATE-AUTHORITY-SENTINEL");
    expect(renderHuman(inspectCommand, inspected)).not.toContain("PRIVATE-AUTHORITY-SENTINEL");
    await expect(value.service.execute({
      ...inspectCommand,
      expectedRevision: interaction.revision + 1,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(value.codex.inspectedInteractions).toHaveLength(1);

    if (protectedDocument.authority.kind !== "command_approval") {
      throw new Error("Expected command approval authority.");
    }
    const exactEmptyDocument = {
      ...protectedDocument,
      authority: { ...protectedDocument.authority, additionalPermissions: "" },
    };
    const emptyEncoded = encodeProtectedInteractionDetailDocument(exactEmptyDocument);
    const fillerBytes = PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES - emptyEncoded.byteLength;
    emptyEncoded.fill(0);
    if (fillerBytes < 0) throw new Error("Protected interaction fixture exceeded its byte limit.");
    const exactAuthority = {
      ...protectedDocument.authority,
      additionalPermissions: "a".repeat(fillerBytes),
    };
    value.codex.interactionAuthority = exactAuthority;
    const exactInspected = protectedInteractionDetailDocumentSchema.parse(
      await value.service.execute(inspectCommand, { signal }),
    );
    const exactEncoded = encodeProtectedInteractionDetailDocument(exactInspected);
    expect(exactEncoded.byteLength).toBe(PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES);
    exactEncoded.fill(0);

    value.codex.interactionAuthority = {
      ...exactAuthority,
      additionalPermissions: `${exactAuthority.additionalPermissions}a`,
    };
    await expect(value.service.execute(inspectCommand, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    for (const unavailableDecision of ["session", "decline"] as const) {
      await expect(value.service.execute({
        kind: "interaction.resolve",
        interaction: interaction.id,
        expectedRevision: interaction.revision,
        resolution: { kind: "approval_decision", decision: unavailableDecision },
      }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(value.store.requireInteraction(interaction.id)).toMatchObject({
        state: "pending",
        revision: interaction.revision,
      });
      expect(value.codex.resolvedInteractions).toHaveLength(0);
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
        summary: "credential=TOPSECRET-9415",
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
    expect(mcpForm.display.summary).toBe("Codex requests MCP form input");
    expect(JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events)).not.toContain("TOPSECRET-9415");
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

  for (const timing of ["before", "after"] as const) {
    test(`quarantines a committed provider-resolution event boundary ${timing} event insertion`, async () => {
    let stopCalls = 0;
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => { stopCalls += 1; },
    );
    const { sessionId } = await createIdleSession(value, "Provider resolution persistence");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "provider-resolution-persistence",
    );
    await value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal });
    const peer = await seedResolvableInteraction(
      value,
      sessionId,
      "provider-resolution-peer",
    );
    const originalAppend = value.store.appendSessionEvent.bind(value.store);
    let injected = false;
    (value.store as unknown as {
      appendSessionEvent: StateStore["appendSessionEvent"];
    }).appendSessionEvent = (input) => {
      if (
        !injected
        && input.body.type === "interaction_state"
        && input.body.interactionId === seeded.interaction.publicId
        && input.body.state === "resolved"
      ) {
        injected = true;
        if (timing === "after") originalAppend(input);
        throw new Error(`injected ${timing} provider-resolution event fault`);
      }
      return originalAppend(input);
    };

    await expect(value.service.observeCodexFact(seeded.authority, {
      type: "interactionResolved",
      connectionId: seeded.interaction.authority.connectionId,
      provider: seeded.interaction.authority,
      kind: "command_approval",
    })).rejects.toMatchObject({ name: "InteractionPersistenceBoundaryError" });

    expect(injected).toBe(true);
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      state: "resolved",
      revision: 4,
    });
    expect(value.store.requireInteraction(peer.interaction.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(value.store.requireProfileById(seeded.authority.id).processGeneration)
      .toBe(seeded.authority.generation + 1);
    const focalTerminalEvents = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events.filter((event) =>
      event.body.type === "interaction_state"
      && event.body.interactionId === seeded.interaction.publicId
      && event.body.revision === 4
    );
    expect(focalTerminalEvents).toHaveLength(1);
    expect(focalTerminalEvents[0]?.body).toEqual({
      type: "interaction_state",
      interactionId: seeded.interaction.publicId,
      state: "resolved",
      revision: 4,
    });
    await Bun.sleep(10);
    expect(stopCalls).toBe(1);

    const restartVisible = new StateStore(value.paths, { readonly: true });
    try {
      expect(restartVisible.requireInteraction(seeded.interaction.publicId)).toMatchObject({
        state: "resolved",
      });
      expect(restartVisible.requireInteraction(peer.interaction.publicId)).toMatchObject({
        state: "expired",
      });
      expect(restartVisible.listSessionEvents({
        sessionId,
        afterSequence: 0,
      }).events.filter((event) =>
        event.body.type === "interaction_state"
        && event.body.interactionId === seeded.interaction.publicId
        && event.body.revision === 4
      )).toHaveLength(1);
    } finally {
      restartVisible.close();
    }
    await value.service.close();
    });
  }

  test("pages signed interaction listings and caps the separate status summary", async () => {
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => 200_000);
    const { sessionId } = await createIdleSession(value, "Interaction pagination");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const publicIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const publicId = `74000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      publicIds.push(publicId);
      value.store.admitInteraction({
        publicId,
        sessionId,
        authority: {
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          connectionId: "74000000-0000-4000-8000-999999999999",
          requestId: { type: "number", value: index },
          method: "item/commandExecution/requestApproval",
          requestDigest: index.toString(16).padStart(64, "0"),
          threadId: session.providerThreadId,
          turnId: `turn-page-${String(index)}`,
          itemId: `item-page-${String(index)}`,
          approvalId: null,
        },
        kind: "command_approval",
        blocking: true,
        display: {
          kind: "command_approval",
          summary: `Page interaction ${String(index)}`,
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
        requestedAt: 100_000 + index,
        deadlineAt: 500_000,
      });
    }
    const oldestPublicId = publicIds[0];
    if (oldestPublicId === undefined) throw new Error("Expected a seeded oldest interaction.");

    type InteractionPage = Readonly<{
      interactions: readonly PublicInteraction[];
      nextCursor: string | null;
      sessionId: string | null;
    }>;
    const first = await value.service.execute({
      kind: "session.interactions",
      session: session.title,
      pending: true,
      limit: 100,
    }, { signal }) as InteractionPage;
    expect(first.sessionId).toBe(sessionId);
    expect(first.interactions.map((interaction) => interaction.id)).toEqual(
      [...publicIds].reverse().slice(0, 100),
    );
    expect(first.nextCursor).toBeString();
    if (first.nextCursor === null) throw new Error("Expected an interaction continuation cursor.");

    const status = await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }) as SessionStatus;
    expect(status.interactions).toMatchObject({
      pendingCount: 101,
      responseInFlightCount: 0,
      truncated: true,
    });
    expect(status.interactions.pending.map((interaction) => interaction.id)).toEqual(
      publicIds.slice(0, 10),
    );
    expect(status.eventStream.cursor).not.toBe(first.nextCursor);

    const second = await value.service.execute({
      kind: "session.interactions",
      session: sessionId,
      pending: true,
      limit: 100,
      cursor: first.nextCursor,
    }, { signal }) as InteractionPage;
    expect(second.sessionId).toBe(sessionId);
    expect(second.nextCursor).toBeNull();
    expect(second.interactions.map((interaction) => interaction.id)).toEqual([oldestPublicId]);
    const oldest = second.interactions[0];
    if (oldest === undefined) throw new Error("Expected to discover the oldest interaction.");

    const global = await value.service.execute({
      kind: "interaction.list",
      pending: true,
      limit: 100,
    }, { signal }) as InteractionPage;
    expect(global.sessionId).toBeNull();
    expect(global.nextCursor).toBeString();
    if (global.nextCursor === null) throw new Error("Expected a global interaction continuation cursor.");

    const otherSessionId = value.store.createSession({
      profileId: profile.id,
      title: "Other interaction session",
      preset: "high",
      fastEnabled: false,
    }).id;
    for (const command of [
      {
        kind: "session.interactions",
        session: otherSessionId,
        pending: true,
        limit: 100,
        cursor: first.nextCursor,
      },
      {
        kind: "session.interactions",
        session: sessionId,
        pending: false,
        limit: 100,
        cursor: first.nextCursor,
      },
      {
        kind: "session.interactions",
        session: sessionId,
        pending: true,
        limit: 100,
        cursor: global.nextCursor,
      },
      {
        kind: "session.interactions",
        session: sessionId,
        pending: true,
        limit: 100,
        cursor: `${first.nextCursor}x`,
      },
    ] as const) {
      await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }

    const resolved = await value.service.execute({
      kind: "interaction.resolve",
      interaction: oldest.id,
      expectedRevision: oldest.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal });
    expect(resolved).toMatchObject({
      responseWritten: true,
      interaction: { id: oldestPublicId, state: "response_written" },
    });
  });

  test("session status separates pending summaries from responses in flight and reports queue axes", async () => {
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => 200_000);
    const { sessionId } = await createIdleSession(value, "Unsettled status");
    const seeded = seedUnsettledInteractionStates(
      value,
      sessionId,
      "75000000-0000-4000-8000-000000000001",
      "status-unsettled",
    );
    const pendingQueue = value.store.enqueue(sessionId, "Pending queue status");
    const dispatchingQueue = value.store.enqueue(sessionId, "Dispatching queue status");
    const ambiguousQueue = value.store.enqueue(sessionId, "Ambiguous queue status");
    const failedQueue = value.store.enqueue(sessionId, "Failed queue status");
    expect(value.store.transitionQueue(dispatchingQueue.id, "pending", "dispatching")).toBe(true);
    expect(value.store.transitionQueue(ambiguousQueue.id, "pending", "dispatching")).toBe(true);
    expect(value.store.transitionQueue(ambiguousQueue.id, "dispatching", "ambiguous")).toBe(true);
    expect(value.store.transitionQueue(failedQueue.id, "pending", "dispatching")).toBe(true);
    expect(value.store.transitionQueue(failedQueue.id, "dispatching", "failed")).toBe(true);

    const status = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(status.interactions).toMatchObject({
      pendingCount: 1,
      responseInFlightCount: 2,
      truncated: false,
    });
    expect(status.interactions.pending).toEqual([{
      id: seeded.pending.publicId,
      kind: seeded.pending.kind,
      revision: seeded.pending.revision,
      blocking: true,
      summary: "Recover pending response state",
      requestedAt: seeded.pending.requestedAt,
      deadlineAt: seeded.pending.deadlineAt,
    }]);
    expect(status.advisory).toEqual({
      attention: "human_action_required",
      execution: "idle",
      queueDepth: 1,
    });
    expect(status.queue).toEqual({
      depth: 1,
      dispatchingCount: 1,
      ambiguousCount: 1,
      failedCount: 1,
    });
    expect(value.store.requireQueue(pendingQueue.id).state).toBe("pending");

    value.store.expireInteraction({
      id: seeded.pending.publicId,
      expectedRevision: seeded.pending.revision,
    });
    const responseInFlightOnly = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(responseInFlightOnly.interactions).toMatchObject({
      pending: [],
      pendingCount: 0,
      responseInFlightCount: 2,
      truncated: false,
    });
    expect(responseInFlightOnly.advisory.attention).toBe("response_in_flight");
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
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
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
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
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

  test("rejects every manual interaction shape at the exact immutable deadline", async () => {
    let now = 70_000;
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Manual interaction deadlines");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const providerThreadId = session.providerThreadId;
    const connectionId = "43000000-0000-4000-8000-000000000001";
    const cases = [
      {
        kind: "command_approval" as const,
        method: "item/commandExecution/requestApproval",
        display: {
          kind: "command_approval" as const,
          summary: "Allow command",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
        },
        resolution: { kind: "approval_decision", decision: "once" } as const,
      },
      {
        kind: "file_change_approval" as const,
        method: "item/fileChange/requestApproval",
        display: {
          kind: "file_change_approval" as const,
          summary: "Allow files",
          reason: null,
          grantRoot: null,
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
        },
        resolution: { kind: "approval_decision", decision: "decline" } as const,
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
        resolution: {
          kind: "permission_grant",
          permissions: ["network"],
          scope: "turn",
        } as const,
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
        resolution: {
          kind: "user_answers",
          answers: { choice: { answers: ["manual answer"] } },
        } as const,
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
        resolution: {
          kind: "mcp_submission",
          action: "accept",
          content: {},
        } as const,
      },
    ] satisfies readonly {
      kind: Extract<CodexFact, { type: "interactionRequested" }>["kind"];
      method: string;
      display: Extract<CodexFact, { type: "interactionRequested" }>["display"];
      resolution: InteractionResolution;
    }[];
    const admitRound = async (round: string) => {
      const records = [];
      for (const [index, interactionCase] of cases.entries()) {
        const requestId = `${round}-${String(index + 1)}`;
        await value.service.observeCodexFact(authority, {
          type: "interactionRequested",
          connectionId,
          provider: {
            profileId: profile.id,
            processGeneration: profile.processGeneration,
            connectionId,
            requestId: { type: "string", value: requestId },
            method: interactionCase.method,
            requestDigest: createHash("sha256").update(requestId).digest("hex"),
            threadId: providerThreadId,
            turnId: `turn-${round}`,
            itemId: `item-${requestId}`,
            approvalId: null,
          },
          kind: interactionCase.kind,
          blocking: true,
          display: interactionCase.display,
          requestedAt: 70_000,
          deadlineAt: 71_000,
        });
        const record = value.store.listInteractions({ sessionId, limit: 100 })
          .find((candidate) => candidate.authority.requestId.value === requestId);
        if (record === undefined) throw new Error("Expected an admitted deadline interaction.");
        records.push(record);
      }
      return records;
    };

    const beforeBoundary = await admitRound("before");
    now = 70_999;
    for (const [index, interaction] of beforeBoundary.entries()) {
      const interactionCase = cases[index];
      if (interactionCase === undefined) throw new Error("Expected a manual resolution case.");
      if (interactionCase.kind === "file_change_approval") {
        await expect(value.service.execute({
          kind: "interaction.resolve",
          interaction: interaction.publicId,
          expectedRevision: interaction.revision,
          resolution: { kind: "approval_decision", decision: "once" },
        }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
      await expect(value.service.execute({
        kind: "interaction.resolve",
        interaction: interaction.publicId,
        expectedRevision: interaction.revision,
        resolution: interactionCase.resolution,
      }, { signal })).resolves.toMatchObject({
        interaction: { state: "response_written", revision: 3 },
        responseWritten: true,
      });
    }
    expect(value.codex.resolvedInteractions).toHaveLength(cases.length);

    const atBoundary = await admitRound("boundary");
    now = 71_000;
    for (const [index, interaction] of atBoundary.entries()) {
      const interactionCase = cases[index];
      if (interactionCase === undefined) throw new Error("Expected a manual resolution case.");
      await expect(value.service.execute({
        kind: "interaction.resolve",
        interaction: interaction.publicId,
        expectedRevision: interaction.revision,
        resolution: interactionCase.resolution,
      }, { signal })).rejects.toMatchObject({
        code: "CONFLICT",
        details: { interaction: { state: "expired", revision: 4 } },
      });
    }
    expect(value.codex.resolvedInteractions).toHaveLength(cases.length);
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(cases.length);
    expect(value.codex.timedOutInteractions).toHaveLength(cases.length);
    for (const interaction of atBoundary) {
      expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
        state: "expired",
        intendedTerminalState: "expired",
        deadlineAt: 71_000,
      });
    }
    await value.service.close();
  });

  test("expires a manual resolution when validation crosses the deadline before dispatch", async () => {
    let now = 80_000;
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Deadline validation race");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "44000000-0000-4000-8000-000000000001";
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: "validation-deadline" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "d".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-validation-deadline",
        itemId: "item-validation-deadline",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Allow command before deadline",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
      requestedAt: 80_000,
      deadlineAt: 81_000,
    });
    const interaction = value.store.listInteractions({ sessionId, pendingOnly: true })[0];
    if (interaction === undefined) throw new Error("Expected a pending interaction.");
    now = 80_999;
    value.codex.beforeValidateInteractionResolutionReturn = async () => {
      now = 81_000;
    };
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: interaction.publicId,
      expectedRevision: interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { interaction: { state: "expired", revision: 4 } },
    });
    expect(value.codex.validatedInteractions).toHaveLength(1);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "expired",
      intendedTerminalState: "expired",
      deadlineAt: 81_000,
    });
    await value.service.close();
  });

  test("does not dispatch a response prepared on the deadline clock edge", async () => {
    let baseNow = 90_000;
    let postValidationRead: number | null = null;
    const now = () => {
      if (postValidationRead === null) return baseNow;
      postValidationRead += 1;
      return postValidationRead === 1 ? 90_999 : 91_000;
    };
    const value = await fixture(undefined, new FakeCloud(), () => undefined, now);
    const { sessionId } = await createIdleSession(value, "Deadline prepare edge");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const connectionId = "45000000-0000-4000-8000-000000000001";
    await value.service.observeCodexFact({
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    }, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: "prepare-deadline" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "f".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-prepare-deadline",
        itemId: "item-prepare-deadline",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Apply before deadline",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
      requestedAt: 90_000,
      deadlineAt: 91_000,
    });
    const interaction = value.store.listInteractions({ sessionId, pendingOnly: true })[0];
    if (interaction === undefined) throw new Error("Expected a pending interaction.");
    baseNow = 90_999;
    value.codex.beforeValidateInteractionResolutionReturn = async () => {
      postValidationRead = 0;
    };
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: interaction.publicId,
      expectedRevision: interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { interaction: { state: "expired", revision: 5 } },
    });
    expect(value.codex.validatedInteractions).toHaveLength(1);
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(1);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "expired",
      intendedTerminalState: "expired",
      revision: 5,
      deadlineAt: 91_000,
    });
    await value.service.close();
  });

  test("turns a client final-boundary deadline rejection into one durable neutral timeout", async () => {
    let now = 100_000;
    const value = await fixture(undefined, new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Client deadline boundary");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "46000000-0000-4000-8000-000000000001";
    const admit = async (requestId: string, requestedAt: number, deadlineAt: number) => {
      await value.service.observeCodexFact(authority, {
        type: "interactionRequested",
        connectionId,
        provider: {
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          connectionId,
          requestId: { type: "string", value: requestId },
          method: "item/commandExecution/requestApproval",
          requestDigest: createHash("sha256").update(requestId).digest("hex"),
          threadId: session.providerThreadId as string,
          turnId: `turn-${requestId}`,
          itemId: `item-${requestId}`,
          approvalId: null,
        },
        kind: "command_approval",
        blocking: true,
        display: {
          kind: "command_approval",
          summary: "Allow before the final write boundary",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
        requestedAt,
        deadlineAt,
      });
      const interaction = value.store.listInteractions({ sessionId, pendingOnly: true, limit: 10 })
        .find((candidate) => candidate.authority.requestId.value === requestId);
      if (interaction === undefined) throw new Error("Expected a pending interaction.");
      return interaction;
    };

    const closed = await admit("client-deadline-success", 100_000, 101_000);
    now = 100_999;
    value.codex.beforeResolveInteractionReturn = async () => { now = 101_000; };
    value.codex.resolveInteractionError = new CodexError(
      "DEADLINE_EXPIRED",
      "the final serialized write guard rejected the manual response",
    );
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: closed.publicId,
      expectedRevision: closed.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { interaction: { state: "expired", revision: 5 } },
    });
    expect(value.codex.resolvedInteractions.at(-1)).toMatchObject({ deadlineAt: 101_000 });
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(1);
    expect(value.codex.timedOutInteractions).toHaveLength(1);

    now = 110_000;
    const unknown = await admit("client-deadline-unknown", 110_000, 111_000);
    now = 110_999;
    value.codex.beforeResolveInteractionReturn = async () => { now = 111_000; };
    value.codex.timeoutInteractionError = new CodexError(
      "INDETERMINATE_EFFECT",
      "the timeout write may have reached the provider",
    );
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: unknown.publicId,
      expectedRevision: unknown.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { interaction: { state: "resolution_unknown", revision: 4 } },
    });
    expect(value.store.requireInteraction(unknown.publicId)).toMatchObject({
      state: "resolution_unknown",
      intendedTerminalState: "expired",
      revision: 4,
    });
    expect(value.codex.timedOutInteractions).toHaveLength(2);
    await value.service.close();
  });

  test("quarantines automatic timeout persistence after the provider accepts the timeout", async () => {
    const now = 120_000;
    let stopCalls = 0;
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => { stopCalls += 1; },
      () => now,
    );
    const { sessionId } = await createIdleSession(value, "Automatic timeout persistence");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const interaction = value.store.admitInteraction({
      publicId: crypto.randomUUID(),
      sessionId,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId: "46100000-0000-4000-8000-000000000001",
        requestId: { type: "string", value: "automatic-timeout-persistence" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "a".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-automatic-timeout-persistence",
        itemId: "item-automatic-timeout-persistence",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Expire at the automatic timeout boundary",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
      requestedAt: now,
      deadlineAt: now,
    }).record;
    const originalMark = value.store.markInteractionResponseWritten.bind(value.store);
    let injected = false;
    (value.store as unknown as {
      markInteractionResponseWritten: StateStore["markInteractionResponseWritten"];
    }).markInteractionResponseWritten = (input) => {
      if (injected) return originalMark(input);
      injected = true;
      throw new Error("injected automatic timeout mark failure");
    };

    expect(await value.service.maintainInteractionDeadlines()).toEqual({
      examined: 1,
      failed: 1,
    });
    expect(injected).toBe(true);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "resolution_unknown",
      intendedTerminalState: "expired",
      revision: 3,
    });
    expect(value.store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    await Bun.sleep(10);
    expect(stopCalls).toBe(1);
    await value.service.close();
  });

  test("repairs a final automatic-timeout event failure before retiring the provider generation", async () => {
    const now = 125_000;
    let stopCalls = 0;
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => { stopCalls += 1; },
      () => now,
    );
    const { sessionId } = await createIdleSession(value, "Automatic timeout terminal event");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const interaction = value.store.admitInteraction({
      publicId: crypto.randomUUID(),
      sessionId,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId: "46150000-0000-4000-8000-000000000001",
        requestId: { type: "string", value: "automatic-timeout-terminal-event" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "b".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-automatic-timeout-terminal-event",
        itemId: "item-automatic-timeout-terminal-event",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Expire with one durable terminal event",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
      requestedAt: now,
      deadlineAt: now,
    }).record;
    const originalAppend = value.store.appendSessionEvent.bind(value.store);
    let injected = false;
    (value.store as unknown as {
      appendSessionEvent: StateStore["appendSessionEvent"];
    }).appendSessionEvent = (input) => {
      if (
        !injected
        && input.body.type === "interaction_state"
        && input.body.interactionId === interaction.publicId
        && input.body.state === "expired"
      ) {
        injected = true;
        throw new Error("injected pre-insert automatic timeout terminal event fault");
      }
      return originalAppend(input);
    };

    expect(await value.service.maintainInteractionDeadlines()).toEqual({
      examined: 1,
      failed: 1,
    });
    expect(injected).toBe(true);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "expired",
      revision: 4,
    });
    expect(value.store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    const terminalEvents = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events.filter((event) =>
      event.body.type === "interaction_state"
      && event.body.interactionId === interaction.publicId
      && event.body.revision === 4
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.body).toEqual({
      type: "interaction_state",
      interactionId: interaction.publicId,
      state: "expired",
      revision: 4,
    });
    await Bun.sleep(10);
    expect(stopCalls).toBe(1);
    await value.service.close();
  });

  test("quarantines deadline-supersede persistence after the provider accepts the neutral timeout", async () => {
    let now = 130_000;
    let stopCalls = 0;
    const value = await fixture(
      undefined,
      new FakeCloud(),
      () => { stopCalls += 1; },
      () => now,
    );
    const { sessionId } = await createIdleSession(value, "Deadline supersede persistence");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "deadline-supersede-persistence",
      { requestedAt: 130_000, deadlineAt: 131_000 },
    );
    now = 130_999;
    value.codex.beforeResolveInteractionReturn = async () => { now = 131_000; };
    value.codex.resolveInteractionError = new CodexError(
      "DEADLINE_EXPIRED",
      "the provider rejected the final manual write at its deadline",
    );
    const originalMark = value.store.markInteractionResponseWritten.bind(value.store);
    let injected = false;
    (value.store as unknown as {
      markInteractionResponseWritten: StateStore["markInteractionResponseWritten"];
    }).markInteractionResponseWritten = (input) => {
      if (injected) return originalMark(input);
      injected = true;
      throw new Error("injected deadline supersede mark failure");
    };
    const afterResponse: Array<() => void> = [];

    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, {
      signal,
      afterResponse: (callback) => { afterResponse.push(callback); },
    })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: {
        daemonRestartRequired: true,
        interaction: {
          id: seeded.interaction.publicId,
          state: "resolution_unknown",
        },
      },
    });
    expect(injected).toBe(true);
    expect(value.codex.resolvedInteractions).toHaveLength(1);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      state: "resolution_unknown",
      intendedTerminalState: "expired",
      revision: 4,
    });
    expect(value.store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    expect(afterResponse).toHaveLength(1);
    expect(stopCalls).toBe(0);
    afterResponse[0]?.();
    expect(stopCalls).toBe(1);
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
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
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
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: canceled.publicId,
      expectedRevision: canceled.revision,
      resolution: { kind: "approval_decision", decision: "cancel" },
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(value.store.requireInteraction(canceled.publicId)).toMatchObject({
      state: "pending",
      intendedTerminalState: null,
      revision: 1,
    });
    expect(value.codex.validatedInteractions).toHaveLength(3);
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
        method: "item/commandExecution/requestApproval",
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
        kind: "command_approval",
        blocking: true,
        display: {
          kind: "command_approval",
          summary: "Apply reviewed changes",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
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
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(0);
    expect(value.codex.timedOutInteractions).toHaveLength(0);
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
      type: "itemStarted",
      connectionId: replacementConnectionId,
      threadId: session.providerThreadId,
      turnId: "turn-after-restart",
      itemId: "assistant-after-restart",
      itemKind: "agentMessage",
    });
    await value.service.observeCodexFact(replacementAuthority, {
      type: "assistantDelta",
      connectionId: replacementConnectionId,
      threadId: session.providerThreadId,
      turnId: "turn-after-restart",
      itemId: "assistant-after-restart",
      text: "new generation visible",
    });
    await value.service.observeCodexFact(replacementAuthority, {
      type: "itemCompleted",
      connectionId: replacementConnectionId,
      threadId: session.providerThreadId,
      turnId: "turn-after-restart",
      itemId: "assistant-after-restart",
      itemKind: "agentMessage",
      status: "completed",
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

  test("clean shutdown retires every live provider generation when runtime close emits no disconnect fact", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Clean interaction shutdown");
    const connectionId = "51000000-0000-4000-8000-000000000001";
    const seeded = seedUnsettledInteractionStates(
      value,
      sessionId,
      connectionId,
      "clean-shutdown",
    );
    const originalGeneration = seeded.profile.processGeneration;
    const authority: ProfileAuthority = {
      id: seeded.profile.id,
      generation: originalGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    await value.service.observeCodexFact(authority, {
      type: "assistantDelta",
      connectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-turn",
      itemId: "clean-shutdown-agent",
      text: "visible before shutdown",
    });

    await value.service.close();

    expect(value.codex.closeCalls).toBe(1);
    expect(value.store.requireProfileById(seeded.profile.id).processGeneration)
      .toBe(originalGeneration + 1);
    expect(value.store.requireInteraction(seeded.pending.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(value.store.requireInteraction(seeded.prepared.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 3,
    });
    expect(value.store.requireInteraction(seeded.written.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 4,
    });
    expect(value.store.listInteractions({ sessionId, pendingOnly: true })).toEqual([]);
    expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events
      .map((event) => event.body))
      .toContainEqual({
        type: "connection",
        state: "disconnected",
        reason: "closed",
      });

    const restartedCodex = new FakeCodex();
    const restarted = new HraService({
      store: value.store,
      paths: value.paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration: 2,
      requestStop: () => undefined,
    });
    await restarted.recover();
    for (const interaction of [seeded.pending, seeded.prepared, seeded.written]) {
      await expect(restarted.execute({
        kind: "interaction.resolve",
        interaction: interaction.publicId,
        expectedRevision: interaction.revision,
        resolution: { kind: "approval_decision", decision: "once" },
      }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(restartedCodex.validatedInteractions).toHaveLength(0);
    expect(restartedCodex.resolvedInteractions).toHaveLength(0);

    const replacementConnectionId = "51000000-0000-4000-8000-000000000099";
    const replacementAuthority = {
      ...authority,
      generation: originalGeneration + 1,
    };
    await restarted.observeCodexFact(replacementAuthority, {
      type: "itemStarted",
      connectionId: replacementConnectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-replacement-turn",
      itemId: "clean-shutdown-replacement-agent",
      itemKind: "agentMessage",
    });
    await restarted.observeCodexFact(replacementAuthority, {
      type: "assistantDelta",
      connectionId: replacementConnectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-replacement-turn",
      itemId: "clean-shutdown-replacement-agent",
      text: "replacement generation visible",
    });
    await restarted.observeCodexFact(replacementAuthority, {
      type: "itemCompleted",
      connectionId: replacementConnectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-replacement-turn",
      itemId: "clean-shutdown-replacement-agent",
      itemKind: "agentMessage",
      status: "completed",
    });
    const afterReplacement = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events;
    await restarted.observeCodexFact(authority, {
      type: "assistantDelta",
      connectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-stale-turn",
      itemId: "clean-shutdown-stale-agent",
      text: "stale generation hidden",
    });
    expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events)
      .toEqual(afterReplacement);
    expect(JSON.stringify(afterReplacement)).toContain("replacement generation visible");
    expect(JSON.stringify(afterReplacement)).not.toContain("stale generation hidden");
    await restarted.close();
  });

  test("crash restart atomically fences the old generation and terminalizes ambiguous interaction states", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Crashed interaction authority");
    const seeded = seedUnsettledInteractionStates(
      value,
      sessionId,
      "52000000-0000-4000-8000-000000000001",
      "crash-restart",
    );
    const originalGeneration = seeded.profile.processGeneration;
    const oldStoreIndex = stores.indexOf(value.store);
    if (oldStoreIndex < 0) throw new Error("Expected the fixture store to be tracked.");
    value.daemonAuthority.invalidate();
    value.store.close();
    stores.splice(oldStoreIndex, 1);

    const restartedStore = new StateStore(value.paths);
    stores.push(restartedStore);
    const daemonGeneration = restartedStore.nextDaemonGeneration(
      `boot_${"f".repeat(32)}`,
    );
    expect(daemonGeneration).toBe(1);
    expect(restartedStore.requireProfileById(seeded.profile.id).processGeneration)
      .toBe(originalGeneration + 1);
    expect(restartedStore.requireInteraction(seeded.pending.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(restartedStore.requireInteraction(seeded.prepared.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 3,
    });
    expect(restartedStore.requireInteraction(seeded.written.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 4,
    });
    expect(restartedStore.listInteractions({ sessionId, pendingOnly: true })).toEqual([]);

    const restartedCodex = new FakeCodex();
    const restarted = new HraService({
      store: restartedStore,
      paths: value.paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration,
      requestStop: () => undefined,
    });
    await restarted.recover();
    for (const interaction of [seeded.pending, seeded.prepared, seeded.written]) {
      await expect(restarted.execute({
        kind: "interaction.resolve",
        interaction: interaction.publicId,
        expectedRevision: interaction.revision,
        resolution: { kind: "approval_decision", decision: "once" },
      }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(restartedCodex.validatedInteractions).toHaveLength(0);
    expect(restartedCodex.resolvedInteractions).toHaveLength(0);
    const restartStatus = await restarted.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }) as { eventStream: { cursor: string }; providerObservation: unknown };
    expect(restartStatus).toMatchObject({
      providerObservation: {
        basis: "provider_read",
        connectionId: restartedCodex.observationConnectionId,
        mode: "resubscribed",
        state: "live",
      },
    });
    await expect(restarted.execute({
      kind: "session.events",
      session: sessionId,
      cursor: restartStatus.eventStream.cursor,
      limit: 200,
      waitMs: 0,
    }, { signal })).resolves.toMatchObject({ events: [] });
    const restartEvents = restartedStore.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events;
    expect(restartEvents.filter((event) =>
      event.body.type === "gap" && event.body.reason === "provider_restart"))
      .toHaveLength(1);
    const resubscribed = restartEvents.find((event) =>
      event.body.type === "connection" && event.body.state === "resubscribed");
    expect(resubscribed).toMatchObject({
      body: { type: "connection", state: "resubscribed" },
      providerConnectionId: restartedCodex.observationConnectionId,
    });
    await restarted.close();
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

describe("HraService autorespond", () => {
  const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for autorespond.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const requestCommandApproval = async (
    value: Awaited<ReturnType<typeof fixture>>,
    sessionId: string,
    requestId: string,
  ) => {
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = {
      id: profile.id,
      generation: profile.processGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
    };
    const connectionId = "46000000-0000-4000-8000-000000000001";
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string" as const, value: requestId },
        method: "item/commandExecution/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: session.providerThreadId,
        turnId: "turn-autorespond",
        itemId: `item-${requestId}`,
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Run the test suite",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });
    const interaction = value.store.listInteractions({ sessionId, limit: 10 })
      .find((candidate) => candidate.authority.requestId.value === requestId);
    if (interaction === undefined) throw new Error("Expected a command approval interaction.");
    return interaction;
  };

  test("accepts a command approval at once scope under auto:all and records evidence", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Autorespond");
    value.store.setDefaultApprovalMode("auto:all");
    const interaction = await requestCommandApproval(value, sessionId, "autorespond-1");
    await waitFor(() => value.codex.resolvedInteractions.length === 1);
    expect(value.codex.resolvedInteractions[0]).toMatchObject({
      kind: "command_approval",
      resolution: { kind: "approval_decision", decision: "once" },
    });
    await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === 1);
    expect(value.store.listAutorespondEvidence({ sessionId })[0]).toMatchObject({
      approvalClass: "command:bun test",
      decision: "once",
      kind: "command_approval",
      mode: "auto:all",
      outcome: "accepted",
    });
    expect(value.store.requireInteraction(interaction.publicId).state).not.toBe("pending");
    expect(value.store.requireInteraction(interaction.publicId).resolvedBy).toBe("autorespond");
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(1);
  });

  test("leaves approvals pending under manual mode", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Manual");
    value.store.setSessionApprovalMode(sessionId, "manual");
    const interaction = await requestCommandApproval(value, sessionId, "manual-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.store.requireInteraction(interaction.publicId).state).toBe("pending");
    expect(value.store.listAutorespondEvidence({ sessionId })).toHaveLength(0);
  });
});
