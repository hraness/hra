import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { z } from "zod";

import { CloudProjectionRecoveryAdmissionError } from "../cloud/contracts";
import { AccountKeyLossPreconditionError } from "../cloud/local-control";
import {
  CodexError,
  IndeterminateCodexEffectError,
  resolvePinnedCodexRuntime,
  validateMcpFormSubmission,
  type CodexFact,
  type CodexPluginCatalog,
  type CodexPluginSummary,
} from "../codex/index";
import {
  signedOutSessionListMetadataSchema,
  type LocalCommand,
} from "../domain/contracts";
import {
  PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES,
  encodeProtectedInteractionDetailDocument,
  protectedInteractionDetailDocumentSchema,
  publicInteractionSchema,
  type InteractionRecord,
  type InteractionIntendedTerminalState,
  type InteractionResolution,
  type PublicInteraction,
} from "../domain/interactions";
import {
  SESSION_STATUS_PENDING_SUMMARY_LIMIT,
  deriveSessionAttention,
  sessionStatusSchema,
  type ProviderObservation,
  type SessionStatus,
} from "../domain/observation";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { sessionEventPageSchema, type SessionEventBody, type SessionEventPage } from "../domain/session-events";
import {
  accountUsageHistoryEntrySchema,
  accountUsageHistoryPageSchema,
  accountUsageCounterSamples,
  createStoredAccountUsageSnapshot,
  observedAccountTokenVelocity,
  providerUsagePayload,
  storedAccountUsageSnapshotSchema,
  type UsageVelocityWindow,
} from "../domain/usage-metrics";
import {
  WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
  workActionCursorPayloadSchema,
  workEventPageSchema,
  workEventCursorPayloadSchema,
  workOperationResultSchema,
  workPollSchema,
  workPreparedEffectStatusSchema,
  workTaskHistoryCursorPayloadSchema,
  type WorkEventPage,
  type WorkId,
  type WorkOperation,
  type WorkOperationResult,
  type WorkPoll,
  type WorkPreparedEffect,
} from "../domain/work";
import { describeWorkProtocol } from "../domain/work-protocol";
import { workPreparedEffectMessage } from "../domain/work-message";
import { canonicalLabelKey, profileIdSchema, sessionIdSchema } from "../domain/values";
import { initializeProfilePaths, profilePaths, type StatePaths } from "../storage/paths";
import { resolveUsableCanonicalProjectDirectory } from "../storage/project-directory";
import { WorkCapabilityCodec } from "../storage/work-capability";
import {
  SelectionError,
  StateSecurityScrubRequiredError,
  UnusableProjectRootError,
  USAGE_LOCAL_RETAIN_AGE_MS,
  type MutationAttemptRecord,
  type MutationEffectEvidence,
  type ProfileRecord,
  type SessionRecord,
  type StateStore,
} from "../storage/state-store";
import {
  WorkStoreError,
  canonicalWorkJson,
  type WorkPreparedEffectAuthorization,
  type WorkStore,
} from "../storage/work-store";
import { DaemonAuthoritySafetyError, type DaemonAuthorityFence } from "./daemon-lock";
import type { HraFactsMemoryLifecyclePort } from "./facts-memory-lifecycle";
import { commandFailureBrand } from "./local-transport";
import {
  CodexSessionObservationError,
  type CloudControlPort,
  type CodexAccountProjection,
  type CodexLoginOutcome,
  type CodexRuntimePort,
  type CodexSessionObservation,
  type CodexSessionProjection,
  type DesktopSwitchPort,
  type ProfileAuthority,
  type RuntimeStartReview,
} from "./ports";
import {
  SessionEventCursorCodec,
  SessionEventCursorError,
  type InteractionCursorScope,
} from "./session-event-cursor";
import { SessionEventWaiterLimitError, SessionEventWaiters } from "./session-event-waiters";
import {
  WorkEventWaiterLimitError,
  WorkEventWaiters,
} from "./work-event-waiters";
import {
  UsageHistoryCursorCodec,
  UsageHistoryCursorError,
} from "./usage-history-cursor";
import {
  sanitizeInteractionDisplay,
  SessionEventStreamRedactor,
  type SessionEventWrite,
} from "./streaming-redaction";

export class CommandFailure extends Error {
  readonly [commandFailureBrand] = true as const;

  constructor(
    readonly code: "INVALID_INPUT" | "NOT_FOUND" | "AMBIGUOUS" | "CONFLICT" | "INTERACTION_REQUIRED" | "UNAVAILABLE" | "RECOVERY_REQUIRED" | "INTERNAL",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CommandFailure";
  }
}

const doctorProjectionCacheSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready") }).passthrough(),
  z.object({
    state: z.literal("degraded"),
    code: z.literal("STREAM_RECOVERY_REQUIRED"),
    sessions: z.number().int().nonnegative(),
    affectedSessions: z.array(z.unknown()).optional(),
  }).passthrough(),
  z.object({
    state: z.literal("unavailable"),
    code: z.enum([
      "CACHE_CORRUPT_OR_UNREADABLE",
      "CACHE_NEWER_VERSION",
      "CACHE_RECOVERY_IN_PROGRESS",
      "CACHE_SYMLINK",
      "CACHE_UNSAFE_AUTHORITY",
    ]),
  }).passthrough(),
]);

const doctorProjectionRecoveryEntrySchema = z.object({
  cacheActivated: z.boolean().optional(),
  idempotencyKey: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  ),
  phase: z.enum(["prepared", "effect_started", "applied", "rejected"]),
  sessionPublicId: sessionIdSchema,
}).passthrough();

const doctorProjectionRecoveryStatusSchema = z.object({
  recoveries: z.array(doctorProjectionRecoveryEntrySchema).max(128),
  recoveriesTruncated: z.boolean(),
  totalRecoveries: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).passthrough();

const isCanonicalCloudDeploymentUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const localHttp = url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
    return (url.protocol === "https:" || localHttp)
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.origin === value;
  } catch {
    return false;
  }
};

const doctorCloudReenableSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("use_hosted_default") }).strict(),
  z.object({
    deploymentUrl: z.string().max(2_048).refine(isCanonicalCloudDeploymentUrl),
    kind: z.literal("restore_bound_deployment"),
  }).strict(),
]);

const doctorRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const cloudReenableAction = (root: Record<string, unknown>): string => {
  const parsed = doctorCloudReenableSchema.safeParse(root.reenable);
  if (parsed.success && parsed.data.kind === "restore_bound_deployment") {
    return `Set HRA_CONVEX_URL to ${parsed.data.deploymentUrl} and restart the daemon`;
  }
  if (parsed.success) return "Unset HRA_CONVEX_URL and restart the daemon";
  return "Restore this state root's bound cloud deployment selection and restart the daemon";
};

const cloudProjectionRecoveryAction = (
  root: Record<string, unknown>,
  action: string,
): string => root.unavailability === "disabled"
  ? `${cloudReenableAction(root)} first. After restart, ${action}`
  : `${action.slice(0, 1).toUpperCase()}${action.slice(1)}`;

const codexCommandFailure = (error: CodexError): CommandFailure => {
  switch (error.code) {
    case "AUTHORITY_STALE":
      return new CommandFailure(
        "UNAVAILABLE",
        "The exact Codex process authority changed before the operation finished. Inspect daemon status before starting a fresh attempt.",
        { reason: "codex_authority_stale", nextCommand: "hra daemon status --json" },
      );
    case "DEADLINE_EXPIRED":
      return new CommandFailure(
        "CONFLICT",
        "The Codex interaction deadline expired before HRA could apply the response. Refresh pending interactions instead of replaying the expired response.",
        { reason: "codex_interaction_deadline_expired", nextCommand: "hra interaction list --pending --json" },
      );
    case "HOME_MISMATCH":
      return new CommandFailure(
        "UNAVAILABLE",
        "The Codex home does not match this account's isolated runtime. Run `hra doctor --json` and repair the reported configuration before retrying.",
        { reason: "codex_home_mismatch", nextCommand: "hra doctor --json" },
      );
    case "INDETERMINATE_EFFECT":
      return new CommandFailure(
        "RECOVERY_REQUIRED",
        "Codex may have applied the operation, but HRA could not prove its outcome. Reconcile the recorded attempt before retrying.",
        { reason: "codex_effect_indeterminate" },
      );
    case "INVALID_INPUT":
      return new CommandFailure(
        "INVALID_INPUT",
        "Codex rejected HRA's bounded request as invalid. Inspect the command and run `hra doctor --json` before retrying.",
        { reason: "codex_request_invalid", nextCommand: "hra doctor --json" },
      );
    case "PROCESS_EXITED":
      return new CommandFailure(
        "UNAVAILABLE",
        "The pinned Codex process exited before the operation finished. Inspect daemon status before starting a fresh attempt.",
        { reason: "codex_process_exited", nextCommand: "hra daemon status --json" },
      );
    case "PROTOCOL_ERROR":
      return new CommandFailure(
        "UNAVAILABLE",
        "Codex returned data that violates HRA's pinned protocol. Run `hra doctor --json` and repair or update HRA before retrying.",
        { reason: "codex_protocol_error", nextCommand: "hra doctor --json" },
      );
    case "PROTOCOL_LIMIT":
      return new CommandFailure(
        "UNAVAILABLE",
        "Codex data exceeded HRA's bounded protocol limits. Narrow the request where possible or update HRA before trying again.",
        { reason: "codex_protocol_limit" },
      );
    case "REMOTE_ERROR":
      return new CommandFailure(
        "UNAVAILABLE",
        "Codex rejected the provider request. That request has settled; inspect current state before deciding whether a fresh attempt is appropriate.",
        { reason: "codex_remote_rejected", requestState: "settled" },
      );
    case "RUNTIME_MISMATCH":
      return new CommandFailure(
        "UNAVAILABLE",
        "HRA's pinned Codex runtime is missing or incompatible. Run `hra doctor --json` and repair or reinstall HRA before retrying.",
        { reason: "codex_runtime_mismatch", nextCommand: "hra doctor --json" },
      );
    case "TIMEOUT":
      return new CommandFailure(
        "UNAVAILABLE",
        "Codex did not complete the operation within HRA's bounded deadline. Inspect current state before deciding whether to start a fresh attempt.",
        { reason: "codex_timeout" },
      );
    case "UNSUPPORTED_CAPABILITY":
      return new CommandFailure(
        "UNAVAILABLE",
        "The pinned Codex runtime does not support a capability required for this operation. Run `hra doctor --json` and update or reconfigure HRA before retrying.",
        { reason: "codex_capability_unsupported", nextCommand: "hra doctor --json" },
      );
  }
};

const cloudDoctorProblems = (status: unknown): readonly string[] => {
  const root = doctorRecord(status);
  if (root === null) {
    return ["Cloud status returned an invalid local shape. Restart the daemon, then rerun `hra doctor`."];
  }
  const problems: string[] = [];
  if (typeof root.configured !== "boolean") {
    problems.push("Cloud status omitted its configuration state. Restart the daemon, then rerun `hra doctor`.");
  }
  if (
    root.configured === false
    && typeof root.diagnostic === "string"
    && root.unavailability !== "disabled"
  ) {
    problems.push("Cloud deployment custody is unavailable. Run `hra sync status --json`, correct the reported deployment configuration or custody state, then restart the daemon.");
  }
  if (
    root.unavailability === "disabled"
    && !doctorCloudReenableSchema.safeParse(root.reenable).success
  ) {
    problems.push("Cloud sync is disabled, but its restart configuration is invalid. Run `hra sync status --json`, restore this state root's bound deployment selection, then restart the daemon.");
  }

  const parsedProjectionRecovery = root.projectionRecovery === undefined
    ? null
    : doctorProjectionRecoveryStatusSchema.safeParse(root.projectionRecovery);
  const coherentProjectionRecovery = parsedProjectionRecovery !== null
    && parsedProjectionRecovery.success
    && parsedProjectionRecovery.data.recoveries.length
      === Math.min(parsedProjectionRecovery.data.totalRecoveries, 128)
    && parsedProjectionRecovery.data.recoveriesTruncated
      === (parsedProjectionRecovery.data.totalRecoveries > 128);
  const unsettledProjectionRecovery = coherentProjectionRecovery
    ? parsedProjectionRecovery.data.recoveries.find((recovery) =>
        recovery.phase === "prepared"
        || recovery.phase === "effect_started"
        || (recovery.phase === "applied" && recovery.cacheActivated !== true))
    : undefined;

  if (root.projectionCache !== undefined) {
    const parsed = doctorProjectionCacheSchema.safeParse(root.projectionCache);
    if (!parsed.success) {
      problems.push("Cloud projection cache status is invalid. Restart the daemon, then rerun `hra doctor`.");
    } else if (parsed.data.state === "unavailable") {
      switch (parsed.data.code) {
        case "CACHE_CORRUPT_OR_UNREADABLE":
          if (unsettledProjectionRecovery === undefined) {
            problems.push(`The cloud projection cache is corrupt or unreadable. ${cloudProjectionRecoveryAction(root, "run `hra session list`, choose each affected local session, then explicitly run `hra sync projection recover <session> --acknowledge-gap`.")}`);
          }
          break;
        case "CACHE_NEWER_VERSION":
          problems.push(`The cloud projection cache was created by a newer HRA version. ${cloudProjectionRecoveryAction(root, "upgrade or reinstall HRA, restart the daemon, then rerun `hra doctor`.")}`);
          break;
        case "CACHE_RECOVERY_IN_PROGRESS":
          if (unsettledProjectionRecovery === undefined) {
            problems.push(`Cloud projection recovery is incomplete. ${cloudProjectionRecoveryAction(root, "restart the daemon, then run `hra sync status --json` and retry the exact same-key recovery it reports.")}`);
          }
          break;
        case "CACHE_SYMLINK":
        case "CACHE_UNSAFE_AUTHORITY":
          problems.push(`The cloud projection cache has unsafe filesystem authority. ${cloudProjectionRecoveryAction(root, "stop HRA, repair the cache entry reported by `hra sync status --json`, then restart the daemon.")}`);
          break;
      }
    } else if (parsed.data.state === "degraded" && unsettledProjectionRecovery === undefined) {
      const firstSession = (parsed.data.affectedSessions ?? [])
        .slice(0, 20)
        .map((value) => sessionIdSchema.safeParse(value))
        .find((value) => value.success);
      problems.push(firstSession?.success === true
        ? `Cloud transcript projection requires recovery for ${String(parsed.data.sessions)} session(s). ${cloudProjectionRecoveryAction(root, `run \`hra sync projection recover ${firstSession.data} --acknowledge-gap\`.`)}`
        : `Cloud transcript projection requires recovery. ${cloudProjectionRecoveryAction(root, "run `hra sync status --json` and use the exact affected session it reports.")}`);
    }
  }

  if (parsedProjectionRecovery !== null) {
    if (!coherentProjectionRecovery) {
      problems.push("Cloud projection recovery status is invalid or exceeds its local bound. Restart the daemon, then rerun `hra doctor`.");
    } else if (unsettledProjectionRecovery !== undefined) {
      problems.push(`Cloud projection recovery is unsettled. ${cloudProjectionRecoveryAction(root, `retry \`hra sync projection recover ${unsettledProjectionRecovery.sessionPublicId} --acknowledge-gap --idempotency-key ${unsettledProjectionRecovery.idempotencyKey}\`.`)}`);
    }
  }
  return problems;
};

class IndeterminateLocalCommitError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "IndeterminateLocalCommitError";
  }
}

class WorkEffectExecutionSuppressed extends Error {
  constructor() {
    super("The durable work-effect authority rejected nested execution.");
    this.name = "WorkEffectExecutionSuppressed";
  }
}

class InteractionPersistenceBoundaryError extends Error {
  constructor(
    readonly focalInteraction: InteractionRecord,
    readonly quarantineFailed: boolean,
    cause: unknown,
  ) {
    super("The interaction persistence boundary could not complete safely.", { cause });
    this.name = "InteractionPersistenceBoundaryError";
  }
}

const authorityFor = (paths: StatePaths, profile: ProfileRecord): ProfileAuthority => {
  const owned = profilePaths(paths, profile.id);
  return { id: profile.id, generation: profile.processGeneration, codexHome: owned.codexHome, desktopUserData: owned.desktopUserData };
};

const loginReceiptSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    loginId: z.string().min(1).max(512).refine((value) => !/\p{Cc}/u.test(value)),
  }).strict(),
  z.object({
    status: z.literal("signed_in"),
    account: z.object({ signedIn: z.literal(true), email: z.string().optional(), plan: z.string().optional() }).strict(),
  }).strict(),
]);
const logoutReceiptSchema = z.object({ loggedOut: z.literal(true) }).strict();
const sessionStartReceiptSchema = z.object({
  sessionId: sessionIdSchema,
  sourceId: z.string().min(1).max(200).optional(),
  effectiveRuntimeProfile: effectiveRuntimeProfileSchema.optional(),
}).strict();
const turnStartReceiptSchema = z.object({
  turnId: z.string().min(1).max(200),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]).optional(),
  sourceId: z.string().min(1).max(200).optional(),
  effectiveRuntimeProfile: effectiveRuntimeProfileSchema.optional(),
}).strict();
const steeredReceiptSchema = z.object({ steered: z.literal(true), activeTurnId: z.string().min(1).max(200) }).strict();
const stoppedReceiptSchema = z.discriminatedUnion("stopped", [
  z.object({ stopped: z.literal(true), activeTurnId: z.string().min(1).max(200) }).strict(),
  z.object({ stopped: z.literal(false), activeTurnId: z.null() }).strict(),
]);
const renamedReceiptSchema = z.object({ renamed: z.literal(true) }).strict();

const digestText = (value: string): string => createHash("sha256").update(value).digest("hex");
const QUEUE_PRE_EFFECT_RETRY_DELAYS_MS = [25, 100, 250] as const;
export const FACTS_MEMORY_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const isSqliteUniqueConstraint = (error: unknown): boolean =>
  error instanceof Error
  && (error as Error & { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";

type LoginOutcome = CodexLoginOutcome;
type BoundSessionRecord = SessionRecord & { providerThreadId: string };
type PublicProviderObservation = ProviderObservation;
type RemoteSessionCommand = Extract<LocalCommand, { kind:
  | "session.send"
  | "session.queue"
  | "session.steer"
  | "session.stop"
  | "session.rename"
  | "session.preset"
  | "session.fast"
}>;
const restoreLoginReceipt = (value: unknown): LoginOutcome => {
  const parsed = loginReceiptSchema.parse(value);
  if (parsed.status === "pending") return { status: "pending", loginId: parsed.loginId };
  return {
    status: "signed_in",
    account: {
      signedIn: true,
      ...(parsed.account.email === undefined ? {} : { email: parsed.account.email }),
      ...(parsed.account.plan === undefined ? {} : { plan: parsed.account.plan }),
    },
  };
};

export class HraService {
  readonly #store: StateStore;
  readonly #paths: StatePaths;
  readonly #codex: CodexRuntimePort;
  readonly #desktop: DesktopSwitchPort | undefined;
  readonly #cloud: CloudControlPort;
  readonly #daemonAuthority: Pick<DaemonAuthorityFence, "assertCurrent" | "close">;
  readonly #requestStop: () => void;
  readonly #eventCursors: SessionEventCursorCodec;
  readonly #usageHistoryCursors: UsageHistoryCursorCodec;
  readonly #eventWaiters: SessionEventWaiters;
  readonly #work: WorkStore;
  readonly #workWaiters: WorkEventWaiters;
  readonly #eventRedactor: SessionEventStreamRedactor;
  readonly #factsMemory: HraFactsMemoryLifecyclePort | undefined;
  readonly #daemonGeneration: number;
  readonly #now: () => number;
  readonly #mutationTails = new Map<string, Promise<unknown>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #operations = new Set<Promise<void>>();
  readonly #projectionRecoveriesInFlight = new Set<string>();
  readonly #sessionFactEpochs = new Map<string, number>();
  readonly #sessionProviderConnections = new Map<string, string>();
  readonly #sessionObservationFailures = new Map<string, string>();
  readonly #sessionResubscriptionConnections = new Map<string, string>();
  readonly #sessionsAwaitingResubscription = new Set<string>();
  readonly #queuePreEffectRetryCounts = new Map<string, number>();
  readonly #queuePreEffectRetryScheduled = new Set<string>();
  readonly #interactionDeadlineAbort = new AbortController();
  #interactionDeadlineTask: Promise<void> | undefined;
  #interactionDeadlineWake: (() => void) | undefined;
  #stopScheduled = false;
  #state: "open" | "closing" | "closed" = "open";
  #terminalFactsMemoryReconciled = false;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    store: StateStore;
    paths: StatePaths;
    codex: CodexRuntimePort;
    cloud: CloudControlPort;
    daemonAuthority: Pick<DaemonAuthorityFence, "assertCurrent" | "close">;
    desktop?: DesktopSwitchPort;
    eventCursors?: SessionEventCursorCodec;
    usageHistoryCursors?: UsageHistoryCursorCodec;
    eventWaiters?: SessionEventWaiters;
    factsMemory?: HraFactsMemoryLifecyclePort;
    workWaiters?: WorkEventWaiters;
    workCapabilities?: WorkCapabilityCodec;
    daemonGeneration?: number;
    now?: () => number;
    requestStop: () => void;
  }) {
    this.#store = input.store;
    this.#paths = input.paths;
    this.#codex = input.codex;
    this.#cloud = input.cloud;
    this.#daemonAuthority = input.daemonAuthority;
    this.#eventCursors = input.eventCursors
      ?? new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    this.#store.configurePublicProviderIdentifierProjector(
      (value) => this.#eventCursors.projectPublicProviderIdentifier(value),
    );
    this.#eventRedactor = new SessionEventStreamRedactor({
      projectPublicProviderIdentifier: (value) =>
        this.#eventCursors.projectPublicProviderIdentifier(value),
    });
    this.#usageHistoryCursors = input.usageHistoryCursors
      ?? new UsageHistoryCursorCodec(UsageHistoryCursorCodec.generateKey());
    this.#eventWaiters = input.eventWaiters ?? new SessionEventWaiters();
    this.#factsMemory = input.factsMemory;
    this.#daemonGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      .parse(input.daemonGeneration ?? 0);
    const workCapabilities = input.workCapabilities
      ?? new WorkCapabilityCodec(WorkCapabilityCodec.generateKey());
    this.#work = this.#store.createWorkStore(
      this.#daemonGeneration,
      (payload) => payload.type === "work"
        ? this.#eventCursors.encodeWorkEvent(workEventCursorPayloadSchema.parse(payload))
        : payload.type === "work_actions"
          ? this.#eventCursors.encodeWorkAction(workActionCursorPayloadSchema.parse(payload))
          : this.#eventCursors.encodeWorkTaskHistory(
              workTaskHistoryCursorPayloadSchema.parse(payload),
            ),
      {
        issue: (authority) => authority.scope === "attempt"
          ? workCapabilities.issue({
              scope: authority.scope,
              workId: authority.workId,
              sessionId: authority.sessionId,
              subjectId: authority.attemptId,
              fence: authority.fence,
            })
          : workCapabilities.issue(authority),
        verify: (capability, authority) => authority.scope === "attempt"
          ? workCapabilities.verify({
              scope: authority.scope,
              workId: authority.workId,
              sessionId: authority.sessionId,
              subjectId: authority.attemptId,
              fence: authority.fence,
              capability,
            })
          : workCapabilities.verify({ ...authority, capability }),
      },
    );
    this.#workWaiters = input.workWaiters ?? new WorkEventWaiters();
    this.#now = input.now ?? Date.now;
    this.#desktop = input.desktop;
    this.#requestStop = input.requestStop;
  }

  async execute(command: LocalCommand, context: { signal: AbortSignal; afterResponse?: (callback: () => void) => void }): Promise<unknown> {
    const finish = this.#beginOperation();
    try {
      await this.#daemonAuthority.assertCurrent();
      await this.#reconcileTerminalFactsMemory();
      await this.#factsMemory?.sweepExpired(this.#now());
      const result = await this.#executeAdmitted(command, context);
      await this.#daemonAuthority.assertCurrent();
      return result;
    } catch (error: unknown) {
      if (error instanceof InteractionPersistenceBoundaryError) {
        this.#scheduleStop(context.afterResponse);
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          error.quarantineFailed
            ? "The interaction response crossed an uncertain local persistence boundary. HRA stopped accepting work because the durable quarantine could not be confirmed; restart before another response can be sent."
            : "The interaction response crossed an uncertain local persistence boundary. HRA fenced the provider authority and must restart before another response can be sent.",
          {
            interaction: this.#publicInteraction(error.focalInteraction),
            daemonRestartRequired: true,
          },
        );
      }
      if (error instanceof StateSecurityScrubRequiredError) {
        (context.afterResponse ?? ((callback) => setTimeout(callback, 0)))(this.#requestStop);
        throw new CommandFailure(
          "UNAVAILABLE",
          error.operationCommitted
            ? "The local transition committed, but its security scrub could not finish. HRA is stopping and will complete the scrub before the next startup."
            : "A required local security scrub could not finish. HRA is stopping and will retry it before the next startup.",
          { operationCommitted: error.operationCommitted },
        );
      }
      throw error;
    } finally {
      finish();
    }
  }

  async #executeAdmitted(command: LocalCommand, context: { signal: AbortSignal; afterResponse?: (callback: () => void) => void }): Promise<unknown> {
    try {
      switch (command.kind) {
        case "doctor": return await this.#doctor(command.offline, context.signal);
        case "daemon.status": return { running: true, pid: process.pid };
        case "daemon.stop": throw new CommandFailure(
          "INVALID_INPUT",
          "Daemon stop commands must be admitted by the exact local authority boundary.",
        );
        case "account.list": return { accounts: this.#store.listProfiles().map((profile) => this.#publicProfile(profile)) };
        case "account.add": return await this.#addAccount(command.label);
        case "account.show": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#showAccount(profile.id, context.signal)); }
        case "account.login": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#login(profile.id, command.deviceCode, command.idempotencyKey, context.signal)); }
        case "account.login-cancel": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#cancelLogin(profile.id, context.signal)); }
        case "account.logout": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#logout(profile.id, command.idempotencyKey, context.signal)); }
        case "account.usage": {
          if (command.account === undefined) return await this.#usage(undefined, command.refresh, context.signal);
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize(`account:${profile.id}`, async () => this.#usage(profile.id, command.refresh, context.signal));
        }
        case "account.usage-history": {
          const profile = this.#store.requireProfile(command.account);
          return this.#usageHistory({ ...command, account: profile.id });
        }
        case "account.switch": { const profile = this.#store.requireProfile(command.account); return await this.#serialize("desktop-switch", async () => this.#switchAccount(profile.id, command.idempotencyKey, context.signal)); }
        case "account.switch-recover": return await this.#serialize("desktop-switch", async () => this.#recoverDesktopSwitch(context.signal));
        case "plugin.list": {
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize(`account:${profile.id}`, async () =>
            await this.#listPlugins(profile.id, command.project, command.refresh, context.signal));
        }
        case "plugin.show": {
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize(`account:${profile.id}`, async () =>
            await this.#showPlugin(
              profile.id,
              command.plugin,
              command.project,
              command.refresh,
              context.signal,
            ));
        }
        case "project.list": return { projects: this.#store.listProjects() };
        case "project.add": return { project: await this.#addProject(command.label, command.path) };
        case "project.use": return { project: this.#store.setDefaultProject(this.#store.requireProject(command.project).id) };
        case "session.list": {
          if (command.account === undefined) {
            return await this.#listSessions(
              undefined,
              command.limit,
              command.cursor,
              context.signal,
            );
          }
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize(`account:${profile.id}`, async () => this.#listSessions(
            profile.id,
            command.limit,
            command.cursor,
            context.signal,
          ));
        }
        case "session.show": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#showSession(session.id, command.detail, context.signal), { allowDuringProjectionRecovery: true }); }
        case "session.status": {
          const session = this.#store.requireSession(command.session);
          return await this.#serializeSessionAuthority(
            session,
            async () => await this.#sessionStatus(session.id, context.signal),
            { allowDuringProjectionRecovery: true },
          );
        }
        case "session.events": return await this.#sessionEvents(command, context.signal);
        case "session.interactions": {
          const session = this.#store.requireSession(command.session);
          return this.#interactionPage({
            sessionId: session.id,
            pending: command.pending,
            limit: command.limit,
            ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          });
        }
        case "session.start": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#startSession({ ...command, account: profile.id }, context.signal)); }
        case "session.send": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#send(session.id, command.message, command.idempotencyKey, context.signal)); }
        case "session.queue": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#queue(session.id, command.message, command.idempotencyKey)); }
        case "session.steer": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#steer(session.id, command.message, command.idempotencyKey, context.signal)); }
        case "session.stop": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#stop(session.id, command.idempotencyKey, context.signal)); }
        case "session.rename": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#rename(session.id, command.name, command.idempotencyKey, context.signal)); }
        case "session.recover": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#resolveSessionRecovery(session.id, "recover", context.signal)); }
        case "session.abandon": {
          const session = this.#store.requireSession(command.session);
          return await this.#serializeSessionAuthority(session, async () => {
            const current = this.#store.requireSession(session.id);
            if (current.state !== "recovery_required") {
              return await this.#resolveSessionRecovery(current.id, "abandon", context.signal);
            }
            await this.#cleanupFactsMemory(current, "abandon");
            return await this.#resolveSessionRecovery(current.id, "abandon", context.signal);
          });
        }
        case "session.note.get": { const session = this.#store.requireSession(command.session); return { sessionId: session.id, note: session.note, revision: session.revision }; }
        case "session.note.edit": throw new CommandFailure("INTERACTION_REQUIRED", "Open the editor through the local `hra session note edit` command.");
        case "session.note.set": return { session: await this.#updateSession(command.session, (session) => ({ note: command.note, expectedRevision: session.revision })) };
        case "session.note.clear": return { session: await this.#updateSession(command.session, (session) => ({ note: "", expectedRevision: session.revision })) };
        case "session.preset": return { session: await this.#updateSession(command.session, (session) => ({ preset: command.preset, expectedRevision: session.revision })) };
        case "session.fast": return { session: await this.#updateSession(command.session, (session) => ({ fastEnabled: command.enabled, expectedRevision: session.revision })) };
        case "session.project": {
          const project = this.#store.requireProject(command.project);
          const session = await this.#updateSession(command.session, (current) => ({ projectId: project.id, expectedRevision: current.revision }));
          this.#resetQueuePreEffectRetries(session.id);
          this.#scheduleIdleQueue(session);
          return { session };
        }
        case "turn.inspect": {
          const session = this.#store.requireSession(command.session);
          return await this.#serializeSessionAuthority(
            session,
            async () => await this.#inspectTurn(session.id, command.turn, context.signal),
          );
        }
        case "interaction.list": {
          const sessionId = command.session === undefined
            ? undefined
            : this.#store.requireSession(command.session).id;
          return this.#interactionPage({
            ...(sessionId === undefined ? {} : { sessionId }),
            pending: command.pending,
            limit: command.limit,
            ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          });
        }
        case "interaction.show": return {
          interaction: this.#publicInteraction(this.#store.requireInteraction(command.interaction)),
        };
        case "interaction.inspect": return await this.#inspectInteraction(command, context.signal);
        case "interaction.resolve": return await this.#resolveInteraction(command, context);
        case "work.protocol": return describeWorkProtocol(command.query);
        case "work.apply": return await this.#applyWorkOperation(
          command.operation,
          context.signal,
        );
        case "work.snapshot": return this.#readWorkSnapshot(command.work, command.actor);
        case "work.task": return this.#readWorkTask(command);
        case "work.poll": return await this.#pollWork(command, context.signal);
        case "work.events": return await this.#readWorkEvents(command, context.signal);
        case "auth.login": {
          const result = await this.#fencedEffect(async () => await this.#cloud.auth({
            email: command.email,
            ...(command.code === undefined ? {} : { code: command.code }),
            ...(command.invite === undefined ? {} : { invite: command.invite }),
            signal: context.signal,
          }));
          if (
            result !== null
            && typeof result === "object"
            && "daemonRestartRequired" in result
            && result.daemonRestartRequired === true
          ) {
            (context.afterResponse ?? ((callback) => setTimeout(callback, 0)))(this.#requestStop);
          }
          return result;
        }
        case "auth.status": return await this.#fencedEffect(async () => await this.#cloud.status(context.signal));
        case "auth.logout": await this.#fencedEffect(async () => await this.#cloud.logout(context.signal)); return { signedOut: true };
        case "auth.delete": {
          const result = await this.#fencedEffect(async () => await this.#cloud.deleteAccount({
            acknowledgeErasure: command.acknowledgeErasure,
            signal: context.signal,
          }));
          if (
            result !== null
            && typeof result === "object"
            && "daemonRestartRequired" in result
            && result.daemonRestartRequired === true
          ) {
            (context.afterResponse ?? ((callback) => setTimeout(callback, 0)))(this.#requestStop);
          }
          return result;
        }
        case "device.list": return await this.#fencedEffect(async () => await this.#cloud.listDevices(context.signal));
        case "device.pair": return await this.#fencedEffect(async () => await this.#cloud.pairDevice(context.signal));
        case "device.key-loss": return await this.#fencedEffect(async () =>
          await this.#cloud.acknowledgeNoAccountKeyHolders(context.signal));
        case "device.approve": return await this.#fencedEffect(async () => await this.#cloud.approveDevice(command.device, command.idempotencyKey, context.signal));
        case "device.revoke": return await this.#fencedEffect(async () => await this.#cloud.revokeDevice(command.device, command.idempotencyKey, context.signal));
        case "sync.status": return await this.#fencedEffect(async () => await this.#cloud.status(context.signal));
        case "sync.now": return await this.#fencedEffect(async () => await this.#cloud.sync(context.signal));
        case "sync.projection-recover": {
          const selected = this.#store.requireSession(command.session);
          return await this.#serializeSessionAuthority(selected, async () => {
            this.#projectionRecoveriesInFlight.add(selected.id);
            try {
              await this.#daemonAuthority.assertCurrent();
              const replay = await this.#cloud.readCompactProjectionRecoveryReceipt?.({
                idempotencyKey: command.idempotencyKey,
                sessionPublicId: selected.id,
                signal: context.signal,
              });
              await this.#daemonAuthority.assertCurrent();
              if (replay !== undefined) {
                if (replay.status === "conflict") {
                  throw new CommandFailure(
                    "CONFLICT",
                    "The projection recovery idempotency key belongs to another session.",
                  );
                }
                if (replay.status === "found") return replay.result;
              }
              const session = this.#requireBoundSession(selected.id);
              const profile = this.#store.requireProfile(session.profileId);
              return await this.#recoverCompactProjection({
                acknowledgeGap: command.acknowledgeGap,
                idempotencyKey: command.idempotencyKey,
                processGeneration: profile.processGeneration,
                profileId: profile.id,
                providerThreadId: session.providerThreadId,
                sessionId: session.id,
              }, context.signal);
            } finally {
              this.#projectionRecoveriesInFlight.delete(selected.id);
            }
          }, { allowDuringProjectionRecovery: true });
        }
      }
    } catch (error: unknown) {
      if (error instanceof CommandFailure) throw error;
      if (error instanceof SessionEventCursorError) {
        throw new CommandFailure("INVALID_INPUT", error.message);
      }
      if (error instanceof UsageHistoryCursorError) {
        throw new CommandFailure(
          error.reason === "expired" ? "CONFLICT" : "INVALID_INPUT",
          error.message,
          { reason: error.reason },
        );
      }
      if (error instanceof SessionEventWaiterLimitError) {
        throw new CommandFailure("UNAVAILABLE", error.message);
      }
      if (error instanceof WorkEventWaiterLimitError) {
        throw new CommandFailure("UNAVAILABLE", error.message);
      }
      if (error instanceof WorkStoreError) {
        const details = { reason: error.code };
        switch (error.code) {
          case "WORK_NOT_FOUND":
          case "TASK_NOT_FOUND":
          case "ATTEMPT_NOT_FOUND":
          case "SIGNAL_NOT_FOUND":
          case "MEMBER_NOT_FOUND":
          case "WORK_RELEASED":
            throw new CommandFailure("NOT_FOUND", error.message, details);
          case "BAD_CURSOR":
          case "BAD_IDEMPOTENCY_KEY":
          case "DEPENDENCY_CYCLE":
          case "EVIDENCE_INVALID":
          case "TASK_DEPTH_EXCEEDED":
          case "TASK_LIMIT_EXCEEDED":
          case "UNKNOWN_DEPENDENCY":
          case "UNKNOWN_PARENT":
            throw new CommandFailure("INVALID_INPUT", error.message, details);
          case "ATTEMPT_RECOVERY_REQUIRED":
            throw new CommandFailure("RECOVERY_REQUIRED", error.message, details);
          case "WORK_CAPACITY_EXCEEDED":
            throw new CommandFailure("CONFLICT", error.message, details);
          case "ATTEMPT_EXHAUSTED":
          case "ATTEMPT_NOT_OWNER":
          case "ATTEMPT_NOT_CLAIMABLE":
          case "DEPENDENCY_INCOMPLETE":
          case "FENCE_MISMATCH":
          case "IDEMPOTENCY_CONFLICT":
          case "LEASE_EXPIRED":
          case "NO_READY_TASK":
          case "NOT_REVIEWABLE":
          case "REVISION_CONFLICT":
          case "ROUTE_MISMATCH":
          case "SELF_REVIEW":
          case "WORK_NOT_ACTIVE":
            throw new CommandFailure("CONFLICT", error.message, details);
        }
      }
      if (error instanceof AccountKeyLossPreconditionError) {
        switch (error.code) {
          case "signed_out":
            throw new CommandFailure(
              "INTERACTION_REQUIRED",
              "Sign in to the HRA cloud account before acknowledging account-key loss.",
              { nextCommand: "hra auth login --input-stdin" },
            );
          case "device_unregistered":
            throw new CommandFailure(
              "INTERACTION_REQUIRED",
              "Register and activate this installation before acknowledging account-key loss.",
              { nextCommand: "hra device pair" },
            );
          case "observation_missing":
            throw new CommandFailure(
              "INTERACTION_REQUIRED",
              "Inspect the current account-key status before acknowledging account-key loss.",
              { nextCommand: "hra auth status" },
            );
          case "already_ready":
            throw new CommandFailure(
              "CONFLICT",
              "The real account key is already available on this device.",
              { nextCommand: "hra auth status" },
            );
          case "auth_identity_unbound":
          case "authority_changed":
            throw new CommandFailure(
              "RECOVERY_REQUIRED",
              "The local auth, device, and account-key recovery authority do not identify one exact cloud account.",
              { nextCommand: "hra auth status" },
            );
        }
      }
      if (error instanceof CloudProjectionRecoveryAdmissionError) {
        switch (error.code) {
          case "identity_or_session_conflict":
            throw new CommandFailure(
              "CONFLICT",
              "The projection recovery idempotency key belongs to another HRA identity or session.",
            );
          case "idempotency_authority_invalid":
            throw new CommandFailure(
              "INVALID_INPUT",
              "No retained projection recovery matches this expired or future idempotency key. Omit `--idempotency-key` to create a fresh recovery attempt.",
            );
          case "journal_capacity":
            throw new CommandFailure(
              "UNAVAILABLE",
              "Projection recovery capacity is full. Run `hra sync status --json` and settle an existing recovery before retrying.",
              { nextCommand: "hra sync status --json" },
            );
          case "unsettled_session":
            throw new CommandFailure(
              "RECOVERY_REQUIRED",
              "Another projection recovery already owns this session. Run `hra sync status --json` and replay the exact idempotency key it reports.",
              { nextCommand: "hra sync status --json" },
            );
        }
      }
      if (error instanceof SelectionError) throw new CommandFailure(error.code, error.message, { candidates: error.candidates });
      if (
        error instanceof Error
        && (
          error.message === "IDEMPOTENCY_CONFLICT"
          || error.message === "Cloud device mutation idempotency key was reused for a different request."
        )
      ) throw new CommandFailure("CONFLICT", error.message);
      if (error instanceof Error && error.message === "UNSETTLED_MUTATION_AUTHORITY") throw new CommandFailure("RECOVERY_REQUIRED", "This mutation authority has an unsettled earlier effect and rejects new idempotency keys.");
      if (error instanceof Error && error.message === "SESSION_EVENT_CURSOR_AHEAD") {
        throw new CommandFailure("CONFLICT", "The session event cursor is ahead of the current stream.");
      }
      if (error instanceof CodexError) throw codexCommandFailure(error);
      if (error instanceof Error && /unavailable|not configured/iu.test(error.message)) {
        throw new CommandFailure("UNAVAILABLE", "A required local or provider capability is unavailable.");
      }
      throw error;
    }
  }

  async executeRemote(
    command: RemoteSessionCommand,
    expectedAuthority: { sessionId: SessionRecord["id"]; profileId: ProfileRecord["id"]; processGeneration: number; providerThreadId: string },
    context: { signal: AbortSignal },
  ): Promise<unknown> {
    const finish = this.#beginOperation();
    try {
      await this.#daemonAuthority.assertCurrent();
      const result = await this.#executeRemoteAdmitted(command, expectedAuthority, context);
      await this.#daemonAuthority.assertCurrent();
      return result;
    } catch (error: unknown) {
      if (error instanceof StateSecurityScrubRequiredError) {
        this.#requestStop();
        throw new CommandFailure(
          "UNAVAILABLE",
          "The local security scrub could not finish. HRA is stopping and will retry it before the next startup.",
          { operationCommitted: error.operationCommitted },
        );
      }
      throw error;
    } finally {
      finish();
    }
  }

  async #executeRemoteAdmitted(
    command: RemoteSessionCommand,
    expectedAuthority: { sessionId: SessionRecord["id"]; profileId: ProfileRecord["id"]; processGeneration: number; providerThreadId: string },
    context: { signal: AbortSignal },
  ): Promise<unknown> {
    const expected = z
      .object({
        sessionId: sessionIdSchema,
        profileId: profileIdSchema,
        processGeneration: z.number().int().nonnegative(),
        providerThreadId: z.string().min(1).max(200),
      })
      .strict()
      .parse(expectedAuthority);
    if (command.session !== expected.sessionId) {
      throw new CommandFailure("CONFLICT", "The remote command selector does not match its exact session authority.");
    }
    return await this.#serializeSessionAuthority({ id: expected.sessionId, profileId: expected.profileId }, async () => {
      await this.#daemonAuthority.assertCurrent();
      const session = this.#store.requireSession(expected.sessionId);
      const profile = this.#store.requireProfileById(expected.profileId);
      if (
        session.profileId !== expected.profileId
        || session.providerThreadId !== expected.providerThreadId
        || profile.processGeneration !== expected.processGeneration
      ) {
        throw new CommandFailure("CONFLICT", "The remote command authority changed before dispatch.");
      }
      this.#assertSignedIn(profile);
      switch (command.kind) {
        case "session.send": return await this.#send(session.id, command.message, command.idempotencyKey, context.signal);
        case "session.queue": return await this.#queue(session.id, command.message, command.idempotencyKey);
        case "session.steer": return await this.#steer(session.id, command.message, command.idempotencyKey, context.signal);
        case "session.stop": return await this.#stop(session.id, command.idempotencyKey, context.signal);
        case "session.rename": return await this.#rename(session.id, command.name, command.idempotencyKey, context.signal);
        case "session.preset": return {
          session: this.#store.updateSessionMetadata({
            expectedRevision: session.revision,
            preset: command.preset,
            sessionId: session.id,
          }),
        };
        case "session.fast": return {
          session: this.#store.updateSessionMetadata({
            expectedRevision: session.revision,
            fastEnabled: command.enabled,
            sessionId: session.id,
          }),
        };
      }
    });
  }

  #scheduleStop(afterResponse?: (callback: () => void) => void): void {
    if (this.#stopScheduled) return;
    this.#stopScheduled = true;
    (afterResponse ?? ((callback) => setTimeout(callback, 0)))(this.#requestStop);
  }

  close(): Promise<void> {
    if (this.#closeTask !== undefined) return this.#closeTask;
    this.#state = "closing";
    this.#interactionDeadlineAbort.abort(new Error("HRA service is closing."));
    this.#interactionDeadlineWake?.();
    this.#interactionDeadlineWake = undefined;
    this.#daemonAuthority.close();
    this.#closeTask = this.#closeAdmittedService();
    return this.#closeTask;
  }

  async recover(): Promise<void> {
    const finish = this.#beginOperation();
    try {
      await this.#daemonAuthority.assertCurrent();
      await this.#recoverAdmitted();
      await this.#daemonAuthority.assertCurrent();
    } finally {
      finish();
    }
  }

  async #recoverAdmitted(): Promise<void> {
    await this.#cloud.supersedeTerminalCompactProjectionRecoveries();
    await this.#daemonAuthority.assertCurrent();
    const recoveredMutations = this.#store.recoverEffectStartedMutations();
    if (recoveredMutations.unresolved.length > 0) {
      throw new Error(`Daemon recovery cannot resolve ${String(recoveredMutations.unresolved.length)} effect-started mutation authorities.`);
    }
    const recoveredQueue = this.#store.recoverDispatchingQueueEffects();
    if (recoveredQueue.unresolved.length > 0) {
      throw new Error(`Daemon recovery cannot resolve ${String(recoveredQueue.unresolved.length)} dispatching queue authorities.`);
    }
    await this.#reconcileTerminalFactsMemory();
    await this.#recoverPreparedWorkEffects(this.#interactionDeadlineAbort.signal);
    await this.#daemonAuthority.assertCurrent();
    const pendingSessions = new Set<string>();
    for (const queued of this.#store.listRecoverableQueue()) {
      const session = this.#store.requireSession(queued.sessionId);
      if (queued.state === "pending" && session.state === "idle") {
        pendingSessions.add(session.id);
      }
    }
    for (const sessionId of pendingSessions) {
      const session = this.#store.requireSession(sessionId);
      const profile = this.#store.requireProfile(session.profileId);
      if (profile.state === "signed_in") this.#scheduleQueueDispatch(session);
    }
    let continueAfterId: string | null = null;
    const activeSessions: SessionRecord[] = [];
    for (;;) {
      const page = this.#store.listCloudSessionPage({
        afterId: continueAfterId,
        limit: 100,
      });
      for (const session of page.sessions) {
        if (session.providerThreadId === undefined || session.state === "terminal") continue;
        this.#sessionsAwaitingResubscription.add(session.id);
        const profile = this.#store.requireProfile(session.profileId);
        if (session.state === "active" && profile.state === "signed_in") {
          activeSessions.push(session);
        }
      }
      if (page.isDone || page.continueAfterId === null) break;
      continueAfterId = page.continueAfterId;
    }
    this.#scheduleRecoverySessionObservations(activeSessions);
    this.#wakeInteractionDeadlinePump();
  }

  async #recoverPreparedWorkEffects(signal: AbortSignal): Promise<void> {
    let cursor: Parameters<WorkStore["recoverablePreparedEffects"]>[0];
    for (;;) {
      if (this.#workEffectRecoveryStopped(signal)) return;
      await this.#daemonAuthority.assertCurrent();
      const page = this.#work.recoverablePreparedEffects(cursor, 32);
      for (const recoverable of page.effects) {
        if (this.#workEffectRecoveryStopped(signal)) return;
        await this.#daemonAuthority.assertCurrent();
        this.#assertPreparedEffectBinding(recoverable.effect, recoverable.status);

        let executionError: unknown;
        if (recoverable.status.state === "prepared") {
          try {
            await this.#performPreparedWorkEffect(
              recoverable.effect,
              recoverable.idempotencyKey,
              signal,
            );
          } catch (error: unknown) {
            executionError = error;
          }
        }

        await this.#daemonAuthority.assertCurrent();
        let projected = this.#work.reprojectPreparedEffect(recoverable.idempotencyKey);
        this.#assertPreparedEffectBinding(recoverable.effect, projected);
        if (projected.state === "prepared") {
          projected = this.#work.settlePreparedEffectNoEffect(
            recoverable.idempotencyKey,
            "startup_preflight_no_effect",
          );
          this.#assertPreparedEffectBinding(recoverable.effect, projected);
        }
        this.#workWaiters.notify(recoverable.effect.workId);
        if (executionError instanceof StateSecurityScrubRequiredError) {
          throw executionError;
        }
      }
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
      // Keep each startup read and recovery batch bounded while allowing close
      // and notification work to run before the next page is admitted.
      await new Promise<void>((resolveYield) => setTimeout(resolveYield, 0));
    }
  }

  #workEffectRecoveryStopped(signal: AbortSignal): boolean {
    return this.#state !== "open" || signal.aborted;
  }

  async settled(): Promise<void> {
    while (this.#mutationTails.size > 0 || this.#background.size > 0) {
      await Promise.allSettled([...this.#mutationTails.values(), ...this.#background]);
    }
  }

  /** Runs one bounded deadline batch. Exposed for deterministic daemon tests. */
  async maintainInteractionDeadlines(): Promise<{ examined: number; failed: number }> {
    if (this.#interactionDeadlineMaintenanceStopped()) {
      return { examined: 0, failed: 0 };
    }
    const due = this.#store.listDueInteractions({ now: this.#now(), limit: 32 });
    let failed = 0;
    for (const interaction of due) {
      if (this.#interactionDeadlineMaintenanceStopped()) break;
      await this.#serialize(`interaction:${interaction.publicId}`, async () => {
        const current = this.#store.requireInteraction(interaction.publicId);
        if (current.state !== "pending" || current.deadlineAt > this.#now()) return;
        await this.#expireInteractionAtDeadline(
          current,
          this.#interactionDeadlineAbort.signal,
        );
      }).catch((error: unknown) => {
        if (error instanceof InteractionPersistenceBoundaryError) this.#scheduleStop();
        failed += 1;
      });
    }
    return { examined: due.length, failed };
  }

  #interactionDeadlineMaintenanceStopped(): boolean {
    return this.#state !== "open" || this.#interactionDeadlineAbort.signal.aborted;
  }

  #wakeInteractionDeadlinePump(): void {
    if (this.#state !== "open" || this.#interactionDeadlineAbort.signal.aborted) return;
    if (this.#interactionDeadlineTask === undefined) {
      const task = this.#runInteractionDeadlinePump();
      this.#interactionDeadlineTask = task;
      void task.finally(() => {
        if (this.#interactionDeadlineTask === task) this.#interactionDeadlineTask = undefined;
      }).catch(() => undefined);
      return;
    }
    this.#interactionDeadlineWake?.();
  }

  async #runInteractionDeadlinePump(): Promise<void> {
    const signal = this.#interactionDeadlineAbort.signal;
    while (this.#state === "open" && !signal.aborted) {
      const processed = await this.maintainInteractionDeadlines();
      if (processed.failed > 0) {
        await this.#waitForInteractionDeadline(1_000, signal);
        continue;
      }
      if (processed.examined >= 32) continue;
      const next = this.#store.nextInteractionDeadlineAt();
      await this.#waitForInteractionDeadline(
        next === null ? null : Math.max(0, next - this.#now()),
        signal,
      );
    }
  }

  async #waitForInteractionDeadline(
    delayMs: number | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (this.#interactionDeadlineWake === finish) this.#interactionDeadlineWake = undefined;
        resolve();
      };
      this.#interactionDeadlineWake = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (delayMs !== null) {
        timer = setTimeout(finish, delayMs);
        timer.unref();
      }
    });
  }

  async #expireInteractionAtDeadline(
    current: InteractionRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const profile = this.#store.requireProfileById(current.authority.profileId);
    let responseDigest: string;
    try {
      await this.#daemonAuthority.assertCurrent();
      const validated = await this.#codex.validateInteractionTimeout({
        authority: authorityFor(this.#paths, profile),
        provider: current.authority,
        signal,
      });
      responseDigest = validated.responseDigest;
    } catch (error: unknown) {
      if (signal.aborted) return;
      const latest = this.#store.requireInteraction(current.publicId);
      if (latest.state !== "pending" || latest.revision !== current.revision) return;
      const terminal = error instanceof CodexError && error.code === "INDETERMINATE_EFFECT"
        ? this.#store.markInteractionResolutionUnknown({
            id: latest.publicId,
            expectedRevision: latest.revision,
          })
        : this.#store.expireInteraction({
            id: latest.publicId,
            expectedRevision: latest.revision,
          });
      this.#appendInteractionState(terminal);
      return;
    }
    let prepared: InteractionRecord;
    try {
      prepared = this.#store.prepareInteractionResponse({
        id: current.publicId,
        expectedRevision: current.revision,
        responseDigest,
        intendedTerminalState: "expired",
      });
      this.#appendInteractionState(prepared);
    } catch (error: unknown) {
      throw this.#interactionPersistenceBoundaryError({
        cause: error,
        effect: "known_unsent",
        focalInteraction: current,
      });
    }
    try {
      await this.#daemonAuthority.assertCurrent();
      await this.#codex.timeoutInteraction({
        authority: authorityFor(this.#paths, profile),
        provider: prepared.authority,
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) return;
      const latest = this.#store.requireInteraction(prepared.publicId);
      if (latest.state !== "response_prepared" || latest.revision !== prepared.revision) return;
      const terminal = error instanceof CodexError && error.code === "INDETERMINATE_EFFECT"
        ? this.#store.markInteractionResolutionUnknown({
            id: latest.publicId,
            expectedRevision: latest.revision,
            responseDigest,
          })
        : this.#store.expireInteraction({
            id: latest.publicId,
            expectedRevision: latest.revision,
          });
      this.#appendInteractionState(terminal);
      return;
    }
    try {
      const written = this.#store.markInteractionResponseWritten({
        id: prepared.publicId,
        expectedRevision: prepared.revision,
        responseDigest,
      });
      if (written.state === "response_written") this.#appendInteractionState(written);
      if (written.state !== "response_written") return;
      const terminal = this.#store.settleInteraction({
        id: written.publicId,
        expectedRevision: written.revision,
        state: "expired",
        authority: written.authority,
        responseDigest,
      });
      this.#appendInteractionState(terminal);
    } catch (error: unknown) {
      throw this.#interactionPersistenceBoundaryError({
        cause: error,
        effect: "possibly_sent",
        focalInteraction: prepared,
        responseDigest,
      });
    }
  }

  async observeCodexFact(authority: ProfileAuthority, fact: CodexFact): Promise<void> {
    const finish = this.#beginFactOperation();
    if (finish === null) return;
    try {
      await this.#observeCodexFactAdmitted(authority, fact);
    } catch (error: unknown) {
      if (error instanceof InteractionPersistenceBoundaryError) this.#scheduleStop();
      if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
      throw error;
    } finally {
      finish();
    }
  }

  async observeCodexAccount(
    authority: ProfileAuthority,
    account: CodexAccountProjection,
  ): Promise<void> {
    const finish = this.#beginFactOperation();
    if (finish === null) return;
    try {
      await this.#daemonAuthority.assertCurrent();
      let profile: ProfileRecord;
      try {
        profile = this.#store.requireProfileById(authority.id);
      } catch {
        return;
      }
      if (
        profile.processGeneration !== authority.generation
        || this.#profileHasProjectionRecoveryInFlight(profile.id)
      ) return;
      const recoveryUnsettled = await this.#cloud
        .isCompactProjectionRecoveryUnsettledForProfile(profile.id);
      await this.#daemonAuthority.assertCurrent();
      if (recoveryUnsettled || this.#profileHasProjectionRecoveryInFlight(profile.id)) return;
      const apply = async (): Promise<void> => {
        const current = this.#store.requireProfileById(profile.id);
        if (
          current.processGeneration !== authority.generation
          || this.#profileHasProjectionRecoveryInFlight(profile.id)
        ) return;
        const blocked = await this.#cloud
          .isCompactProjectionRecoveryUnsettledForProfile(profile.id);
        await this.#daemonAuthority.assertCurrent();
        if (blocked || this.#profileHasProjectionRecoveryInFlight(profile.id)) return;
        if (!account.signedIn && current.state === "login_pending") return;
        const stateChange = this.#store.setProfileStateWithWorkRetirement(
          current.id,
          current.processGeneration,
          account.signedIn ? "signed_in" : "signed_out",
          this.#work,
          {
            ...(account.email === undefined ? {} : { email: account.email }),
            ...(account.plan === undefined ? {} : { plan: account.plan }),
          },
        );
        this.#notifyAffectedWork(stateChange.affectedWorkIds);
      };
      if (this.#mutationTails.has(`account:${profile.id}`)) await apply();
      else await this.#serialize(`account:${profile.id}`, apply);
    } catch (error: unknown) {
      if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
      throw error;
    } finally {
      finish();
    }
  }

  async #observeCodexFactAdmitted(authority: ProfileAuthority, fact: CodexFact): Promise<void> {
    await this.#daemonAuthority.assertCurrent();
    let profile: ProfileRecord;
    try {
      profile = this.#store.requireProfileById(authority.id);
    } catch {
      return;
    }
    if (profile.processGeneration !== authority.generation || profile.state === "removed") return;
    if (fact.type === "providerDisconnected") {
      await this.#applyOrderedAccountFact(profile.id, () => {
        let current: ProfileRecord;
        try {
          current = this.#store.requireProfileById(authority.id);
        } catch (error: unknown) {
          if (error instanceof SelectionError && error.code === "NOT_FOUND") return;
          throw error;
        }
        if (current.processGeneration !== authority.generation) return;
        this.#handleProviderDisconnected(authority, fact.connectionId, fact.reason);
        const retirement = this.#store.advanceProfileGenerationWithWorkRetirement(
          authority.id,
          authority.generation,
          this.#work,
        );
        this.#notifyAffectedWork(retirement.affectedWorkIds);
      });
      return;
    }
    if (fact.type === "providerConnected") return;
    if (fact.type === "notificationIgnored") return;
    if (fact.type === "loginCompleted") {
      if (fact.success || fact.loginId === null) return;
      const loginId = fact.loginId;
      const settleFailedLogin = (): void => {
        let current: ProfileRecord;
        try {
          current = this.#store.requireProfileById(authority.id);
        } catch (error: unknown) {
          if (error instanceof SelectionError && error.code === "NOT_FOUND") return;
          throw error;
        }
        if (
          current.processGeneration !== authority.generation
          || current.state !== "login_pending"
        ) return;
        const pending = this.#store.readPendingLoginAuthority(
          current.id,
          current.processGeneration,
        );
        if (pending?.loginId !== loginId) return;
        this.#store.settlePendingLogin({
          profileId: current.id,
          processGeneration: current.processGeneration,
          loginId,
          providerStatus: "not_found",
          provider: { signedIn: false },
        });
      };
      await this.#applyOrderedAccountFact(profile.id, settleFailedLogin);
      return;
    }
    if (fact.type === "interactionRequested") {
      if (
        fact.provider.profileId !== authority.id
        || fact.provider.processGeneration !== authority.generation
        || fact.provider.connectionId !== fact.connectionId
      ) throw new Error("INTERACTION_FACT_AUTHORITY_MISMATCH");
      if (
        fact.kind === "mcp_elicitation"
        && (
          fact.display.kind !== "mcp_elicitation"
          || fact.display.mode !== "form"
          || fact.display.fields === undefined
        )
      ) throw new Error("MCP_FORM_DISPLAY_CONTRACT_MISSING");
      const session = fact.provider.threadId === null
        ? null
        : this.#store.findSessionByProviderThread(authority.id, fact.provider.threadId);
      if (session !== null) this.#ensureSessionProviderConnection(authority, session, fact.connectionId);
      const admitted = this.#store.admitInteraction({
        publicId: randomUUID(),
        sessionId: session?.id ?? null,
        authority: fact.provider,
        kind: fact.kind,
        blocking: fact.blocking,
        display: sanitizeInteractionDisplay(fact.display),
        ...(fact.timeoutMs === undefined ? {} : { timeoutMs: fact.timeoutMs }),
        ...(fact.requestedAt === undefined ? {} : { requestedAt: fact.requestedAt }),
        ...(fact.deadlineAt === undefined ? {} : { deadlineAt: fact.deadlineAt }),
      });
      if (!admitted.replayed && admitted.record.sessionId !== null) {
        this.#appendSessionEvent(authority, admitted.record.sessionId, fact.connectionId, {
          type: "interaction_requested",
          interactionId: admitted.record.publicId,
          interactionKind: admitted.record.kind,
          revision: admitted.record.revision,
          blocking: admitted.record.blocking,
          summary: admitted.record.display.summary,
        });
      }
      this.#wakeInteractionDeadlinePump();
      return;
    }
    if (fact.type === "interactionResolved") {
      const observed = this.#store.findInteractionByAuthority(fact.provider);
      if (observed === null) return;
      await this.#serialize(`interaction:${observed.publicId}`, async () => {
        const current = this.#store.findInteractionByAuthority(fact.provider);
        if (
          current === null
          || current.state === "resolved"
          || current.state === "declined"
          || current.state === "canceled"
          || current.state === "expired"
          || current.state === "resolution_unknown"
        ) return;
        try {
          const settled = this.#store.settleInteraction({
            id: current.publicId,
            expectedRevision: current.revision,
            state: current.intendedTerminalState ?? "resolved",
            authority: fact.provider,
            ...(current.responseDigest === null ? {} : { responseDigest: current.responseDigest }),
          });
          this.#appendInteractionState(settled);
        } catch (error: unknown) {
          throw this.#interactionPersistenceBoundaryError({
            cause: error,
            effect: "possibly_sent",
            focalInteraction: current,
            ...(current.responseDigest === null
              ? {}
              : { responseDigest: current.responseDigest }),
          });
        }
      });
      return;
    }
    if (fact.type === "protocolNotice") {
      if (fact.connectionId === undefined) return;
      for (const [sessionId, connectionId] of this.#sessionProviderConnections) {
        if (connectionId !== fact.connectionId) continue;
        const session = this.#store.requireSession(sessionId);
        if (session.profileId !== authority.id) continue;
        this.#appendSessionEvent(authority, session.id, connectionId, {
          type: "protocol_incompatible",
          method: fact.method,
          payloadDigest: digestText(fact.method),
        });
      }
      return;
    }
    if (!("threadId" in fact) || typeof fact.threadId !== "string") return;
    const session = this.#store.findSessionByProviderThread(authority.id, fact.threadId);
    if (
      session === null
      || (session.state === "terminal" && fact.type !== "threadDeleted")
      || (session.state === "recovery_required" && fact.type !== "threadDeleted")
    ) return;
    this.#ensureSessionProviderConnection(authority, session, fact.connectionId);
    if (fact.type === "threadDeleted") {
      await this.#applyProviderThreadDeletion(authority, fact, session);
      return;
    }
    const event = this.#eventBodyForCodexFact(fact, session);
    if (event !== null) {
      this.#appendSessionEvent(authority, session.id, fact.connectionId ?? null, event);
    }
    const recoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettled(session.id);
    await this.#daemonAuthority.assertCurrent();
    if (recoveryUnsettled || this.#projectionRecoveriesInFlight.has(session.id)) return;
    let dispatchQueue = false;
    if (this.#mutationTails.has(`session:${session.id}`)) {
      dispatchQueue = this.#applyCodexFact(authority, fact, session);
    } else {
      try {
        dispatchQueue = await this.#serializeSessionAuthority(session, () =>
          this.#applyCodexFact(authority, fact, session));
      } catch (error: unknown) {
        if (error instanceof CommandFailure && error.code === "RECOVERY_REQUIRED") return;
        throw error;
      }
    }
    if (dispatchQueue) {
      const task = this.#serializeSessionAuthority(session, async () => this.#dispatchNextQueue(session.id, authority));
      const tracked = task.then(
        () => undefined,
        () => undefined,
      );
      this.#background.add(tracked);
      void tracked.then(() => this.#background.delete(tracked));
    }
  }

  async #applyProviderThreadDeletion(
    authority: ProfileAuthority,
    fact: Extract<CodexFact, { type: "threadDeleted" }>,
    expected: SessionRecord,
  ): Promise<void> {
    const current = this.#store.findSessionByProviderThread(authority.id, fact.threadId);
    if (current === null || current.id !== expected.id) return;
    this.#persistSessionEventWrites(this.#eventRedactor.interruptSession({
      sessionId: current.id,
      accountId: authority.id,
      providerGeneration: authority.generation,
      providerConnectionId: fact.connectionId ?? null,
    }));
    this.#sessionFactEpochs.set(current.id, (this.#sessionFactEpochs.get(current.id) ?? 0) + 1);
    const terminal = this.#store.terminalizeSessionFromProviderDeletion({
      accountId: authority.id,
      providerConnectionId: fact.connectionId ?? null,
      providerGeneration: authority.generation,
      sessionId: current.id,
    });
    if (terminal.event !== undefined) this.#eventWaiters.notify(current.id);
    for (const interaction of terminal.interactions) this.#appendInteractionState(interaction);
    this.#sessionProviderConnections.delete(current.id);
    this.#sessionObservationFailures.delete(current.id);
    this.#sessionResubscriptionConnections.delete(current.id);
    this.#sessionsAwaitingResubscription.delete(current.id);
    await this.#cloud.supersedeCompactProjectionRecoveryForProviderDeletion(current.id);
    await this.#daemonAuthority.assertCurrent();
    await this.#cleanupTerminalFactsMemory(this.#store.requireSession(current.id));
  }

  #appendSessionEvent(
    authority: ProfileAuthority,
    sessionId: SessionRecord["id"],
    connectionId: string | null | undefined,
    body: SessionEventBody,
  ): void {
    const parsedConnection = connectionId === null || connectionId === undefined
      ? null
      : z.string().uuid().parse(connectionId);
    this.#persistSessionEventWrites(this.#eventRedactor.accept({
      sessionId,
      accountId: authority.id,
      providerGeneration: authority.generation,
      providerConnectionId: parsedConnection,
      body,
    }));
  }

  #persistSessionEventWrites(writes: readonly SessionEventWrite[]): void {
    for (const write of writes) {
      this.#store.appendPublicSessionEvent(write);
      this.#eventWaiters.notify(write.sessionId);
    }
  }

  #ensureSessionProviderConnection(
    authority: ProfileAuthority,
    session: SessionRecord,
    connectionId: string | undefined,
  ): void {
    if (connectionId === undefined) return;
    z.string().uuid().parse(connectionId);
    const previous = this.#sessionProviderConnections.get(session.id);
    if (previous === connectionId) return;
    if (previous !== undefined) {
      const position = this.#store.eventStreamPosition(session.id);
      this.#appendSessionEvent(authority, session.id, previous, {
        type: "gap",
        reason: "provider_restart",
        fromSequence: position.observedThroughSequence + 1,
        throughSequence: position.observedThroughSequence + 1,
      });
    }
    this.#sessionProviderConnections.set(session.id, connectionId);
    const resubscribed = previous !== undefined
      || this.#sessionsAwaitingResubscription.has(session.id)
      || this.#lastSessionEventIsProviderGap(session.id);
    this.#sessionsAwaitingResubscription.delete(session.id);
    if (resubscribed) this.#sessionResubscriptionConnections.set(session.id, connectionId);
    this.#appendSessionEvent(authority, session.id, connectionId, {
      type: "connection",
      state: resubscribed ? "resubscribed" : "connected",
    });
  }

  #lastSessionEventIsProviderGap(sessionId: SessionRecord["id"]): boolean {
    const position = this.#store.eventStreamPosition(sessionId);
    if (position.observedThroughSequence === 0) return false;
    const latest = this.#store.listSessionEvents({
      sessionId,
      afterSequence: position.observedThroughSequence - 1,
      limit: 1,
    }).events[0];
    return latest?.body.type === "gap"
      && (latest.body.reason === "provider_restart" || latest.body.reason === "provider_disconnect");
  }

  #handleProviderDisconnected(
    authority: ProfileAuthority,
    connectionId: string,
    reason: "eof" | "process_exit" | "closed" | "protocol_fault",
  ): void {
    const terminal = this.#store.expireGenerationInteractions({
      profileId: authority.id,
      processGeneration: authority.generation,
      connectionId,
    });
    for (const interaction of terminal) this.#appendInteractionState(interaction);
    for (const [sessionId, activeConnectionId] of [...this.#sessionProviderConnections]) {
      if (activeConnectionId !== connectionId) continue;
      const session = this.#store.requireSession(sessionId);
      if (session.profileId !== authority.id) continue;
      this.#appendSessionEvent(authority, session.id, connectionId, {
        type: "connection",
        state: "disconnected",
        reason,
      });
      const position = this.#store.eventStreamPosition(session.id);
      this.#appendSessionEvent(authority, session.id, connectionId, {
        type: "gap",
        reason: reason === "protocol_fault" ? "protocol_incompatible" : "provider_disconnect",
        fromSequence: position.observedThroughSequence + 1,
        throughSequence: position.observedThroughSequence + 1,
      });
      this.#sessionProviderConnections.delete(session.id);
      this.#sessionObservationFailures.delete(session.id);
      this.#sessionResubscriptionConnections.delete(session.id);
      this.#sessionsAwaitingResubscription.add(session.id);
    }
  }

  #prepareAccountLoginProviderRetirements(
    profileId: ProfileRecord["id"],
    processGeneration: number,
  ): readonly Readonly<{
    connectionId: string;
    releasedEvents: readonly SessionEventWrite[];
    sessionId: SessionRecord["id"];
  }>[] {
    const retirements: Array<Readonly<{
      connectionId: string;
      releasedEvents: readonly SessionEventWrite[];
      sessionId: SessionRecord["id"];
    }>> = [];
    for (const [sessionId, connectionId] of this.#sessionProviderConnections) {
      const session = this.#store.requireSession(sessionId);
      if (session.profileId !== profileId) continue;
      retirements.push({
        connectionId,
        releasedEvents: this.#eventRedactor.interruptSession({
          accountId: profileId,
          providerConnectionId: connectionId,
          providerGeneration: processGeneration,
          sessionId,
        }),
        sessionId,
      });
    }
    return retirements;
  }

  #applyAccountLoginProviderRetirements(
    retirements: readonly Readonly<{
      connectionId: string;
      sessionId: SessionRecord["id"];
    }>[],
    retiredSessionIds: readonly SessionRecord["id"][],
  ): void {
    for (const retirement of retirements) {
      if (this.#sessionProviderConnections.get(retirement.sessionId) !== retirement.connectionId) {
        throw new Error("ACCOUNT_LOGIN_RETIREMENT_CONNECTION_CHANGED");
      }
      this.#sessionProviderConnections.delete(retirement.sessionId);
      this.#sessionObservationFailures.delete(retirement.sessionId);
      this.#sessionResubscriptionConnections.delete(retirement.sessionId);
      this.#sessionsAwaitingResubscription.add(retirement.sessionId);
    }
    for (const sessionId of retiredSessionIds) this.#eventWaiters.notify(sessionId);
  }

  #eventBodyForCodexFact(
    fact: Exclude<CodexFact, { type: "providerConnected" | "providerDisconnected" | "interactionRequested" | "interactionResolved" | "protocolNotice" }>
      & Readonly<{ threadId: string }>,
    session: SessionRecord,
  ): SessionEventBody | null {
    switch (fact.type) {
      case "turnStarted": return { type: "turn_started", turnId: fact.turn.id };
      case "turnCompleted": return {
        type: "turn_completed",
        turnId: fact.turn.id,
        status: fact.turn.status === "inProgress" ? "failed" : fact.turn.status,
      };
      case "threadStatusChanged": return {
        type: "session_status",
        status: fact.status.type === "notLoaded"
          ? "not_loaded"
          : fact.status.type === "systemError"
            ? "system_error"
            : fact.status.type,
        activeTurnId: fact.status.type === "active" ? session.activeTurnId ?? null : null,
      };
      case "threadDeleted": return null;
      case "itemStarted": return {
        type: "item_started",
        turnId: fact.turnId,
        itemId: fact.itemId,
        itemKind: fact.itemKind,
        ...(fact.server === undefined ? {} : { server: fact.server }),
        ...(fact.tool === undefined ? {} : { tool: fact.tool }),
        ...(fact.liveAcceptanceCommandDigest === undefined
          ? {}
          : { liveAcceptanceCommandDigest: fact.liveAcceptanceCommandDigest }),
      };
      case "itemCompleted": return {
        type: "item_completed",
        turnId: fact.turnId,
        itemId: fact.itemId,
        itemKind: fact.itemKind,
        ...(fact.server === undefined ? {} : { server: fact.server }),
        ...(fact.tool === undefined ? {} : { tool: fact.tool }),
        ...(fact.liveAcceptanceCommandDigest === undefined
          ? {}
          : { liveAcceptanceCommandDigest: fact.liveAcceptanceCommandDigest }),
        ...(fact.status === undefined ? {} : { status: fact.status }),
      };
      case "assistantDelta": return {
        type: "assistant_delta",
        turnId: fact.turnId,
        itemId: fact.itemId,
        text: fact.text,
      };
      case "reasoningSummaryDelta": return {
        type: "reasoning_summary_delta",
        turnId: fact.turnId,
        itemId: fact.itemId,
        summaryPart: fact.summaryIndex,
        text: fact.text,
      };
      case "toolProgress": return {
        type: "tool_progress",
        turnId: fact.turnId,
        itemId: fact.itemId,
        toolKind: fact.toolKind,
        ...(fact.status === undefined ? {} : { status: fact.status }),
        ...(fact.outputBytesObserved === undefined
          ? {}
          : { outputBytesObserved: fact.outputBytesObserved }),
        ...(fact.server === undefined ? {} : { server: fact.server }),
        ...(fact.tool === undefined ? {} : { tool: fact.tool }),
      };
      case "planUpdated": return {
        type: "plan_updated",
        turnId: fact.turnId,
        steps: [...fact.steps],
        ...(fact.explanation === undefined ? {} : { explanation: fact.explanation }),
      };
      case "diffUpdated": return {
        type: "diff_updated",
        turnId: fact.turnId,
        changedFiles: fact.changedFiles,
        patchBytesObserved: fact.patchBytesObserved,
      };
      case "tokenUsageUpdated": return {
        type: "token_usage",
        turnId: fact.turnId,
        inputTokens: fact.inputTokens,
        cachedInputTokens: fact.cachedInputTokens,
        outputTokens: fact.outputTokens,
        reasoningOutputTokens: fact.reasoningOutputTokens,
        totalTokens: fact.totalTokens,
        modelContextWindow: fact.modelContextWindow,
      };
      case "providerWarning": return {
        type: "warning",
        code: fact.code,
        message: fact.message,
      };
      case "providerError": return {
        type: "error",
        code: fact.code,
        message: fact.message,
        terminal: fact.terminal,
      };
      case "accountUpdated":
      case "loginCompleted":
      case "serverRequestResolved":
      case "notificationIgnored":
      case "threadNameUpdated":
        return null;
    }
  }

  #applyCodexFact(
    authority: ProfileAuthority,
    fact: CodexFact & Readonly<{ threadId: string }>,
    expected: SessionRecord,
  ): boolean {
    let profile: ProfileRecord;
    try {
      profile = this.#store.requireProfileById(authority.id);
    } catch {
      return false;
    }
    if (profile.processGeneration !== authority.generation || profile.state !== "signed_in") return false;
    const current = this.#store.findSessionByProviderThread(authority.id, fact.threadId);
    if (
      current === null
      || current.id !== expected.id
      || current.state === "terminal"
      || (current.state === "recovery_required" && fact.type !== "threadDeleted")
      || this.#projectionRecoveriesInFlight.has(current.id)
    ) return false;
    this.#sessionFactEpochs.set(current.id, (this.#sessionFactEpochs.get(current.id) ?? 0) + 1);
    if (fact.type === "threadDeleted") return false;
    if (fact.type === "turnStarted") {
      this.#store.reconcileSessionFromProvider({ sessionId: current.id, state: "active", activeTurnId: fact.turn.id });
      return false;
    }
    if (fact.type === "turnCompleted") {
      for (const interaction of this.#store.expireTurnInteractions({
        sessionId: current.id,
        profileId: authority.id,
        processGeneration: authority.generation,
        turnId: fact.turn.id,
      })) this.#appendInteractionState(interaction);
      this.#store.reconcileSessionFromProvider({ sessionId: current.id, state: "idle", activeTurnId: null });
      return true;
    }
    if (fact.type === "threadStatusChanged") {
      if (fact.status.type === "systemError") {
        this.#quarantineSession(current.id);
        return false;
      }
      const state = fact.status.type === "active" ? "active" : "idle";
      this.#store.reconcileSessionFromProvider({ sessionId: current.id, state, ...(state === "active" ? {} : { activeTurnId: null }) });
      return false;
    }
    if (fact.type === "threadNameUpdated" && fact.name !== null) {
      this.#store.reconcileSessionFromProvider({ sessionId: current.id, title: fact.name });
    }
    return false;
  }

  async #closeAdmittedService(): Promise<void> {
    let runtimeError: unknown;
    try {
      if (this.#interactionDeadlineTask !== undefined) {
        await this.#interactionDeadlineTask.catch(() => undefined);
      }
      await this.#codex.close();
    } catch (error: unknown) {
      runtimeError = error;
    }
    await this.#drainOwnedWork();
    this.#persistSessionEventWrites(this.#eventRedactor.interruptAll());
    let retirementError: unknown;
    try {
      this.#retireClosedRuntimeAuthorities();
    } catch (error: unknown) {
      retirementError = error;
    }
    this.#state = "closed";
    if (runtimeError !== undefined && retirementError !== undefined) {
      throw new AggregateError(
        [runtimeError, retirementError],
        "The Codex runtime and its durable authority retirement both failed during shutdown.",
      );
    }
    if (runtimeError !== undefined) {
      throw runtimeError instanceof Error ? runtimeError : new Error("The Codex runtime closed with a non-Error failure.");
    }
    if (retirementError !== undefined) {
      throw retirementError instanceof Error
        ? retirementError
        : new Error("The Codex runtime authority retirement failed with a non-Error failure.");
    }
  }

  #retireClosedRuntimeAuthorities(): void {
    const projectionErrors: unknown[] = [];
    for (const profile of this.#store.listProfiles()) {
      if (profile.processGeneration === 0) continue;
      let terminal: readonly InteractionRecord[];
      try {
        terminal = this.#store.expireGenerationInteractions({
          profileId: profile.id,
          processGeneration: profile.processGeneration,
        });
      } catch (error: unknown) {
        projectionErrors.push(error);
        continue;
      }
      for (const interaction of terminal) {
        try {
          this.#appendInteractionState(interaction);
        } catch (error: unknown) {
          projectionErrors.push(error);
        }
      }
      const authority = authorityFor(this.#paths, profile);
      for (const [sessionId, connectionId] of [...this.#sessionProviderConnections]) {
        let session: SessionRecord;
        try {
          session = this.#store.requireSession(sessionId);
        } catch (error: unknown) {
          projectionErrors.push(error);
          this.#sessionProviderConnections.delete(sessionId);
          this.#sessionObservationFailures.delete(sessionId);
          this.#sessionResubscriptionConnections.delete(sessionId);
          this.#sessionsAwaitingResubscription.delete(sessionId);
          continue;
        }
        if (session.profileId !== profile.id) continue;
        try {
          this.#appendSessionEvent(authority, session.id, connectionId, {
            type: "connection",
            state: "disconnected",
            reason: "closed",
          });
          const position = this.#store.eventStreamPosition(session.id);
          this.#appendSessionEvent(authority, session.id, connectionId, {
            type: "gap",
            reason: "provider_disconnect",
            fromSequence: position.observedThroughSequence + 1,
            throughSequence: position.observedThroughSequence + 1,
          });
        } catch (error: unknown) {
          projectionErrors.push(error);
        } finally {
          this.#sessionProviderConnections.delete(sessionId);
          this.#sessionObservationFailures.delete(sessionId);
          this.#sessionResubscriptionConnections.delete(sessionId);
          this.#sessionsAwaitingResubscription.delete(sessionId);
        }
      }
      try {
        const retirement = this.#store.advanceProfileGenerationWithWorkRetirement(
          profile.id,
          profile.processGeneration,
          this.#work,
        );
        this.#notifyAffectedWork(retirement.affectedWorkIds);
      } catch (error: unknown) {
        projectionErrors.push(error);
      }
    }
    this.#sessionProviderConnections.clear();
    this.#sessionObservationFailures.clear();
    this.#sessionResubscriptionConnections.clear();
    this.#sessionsAwaitingResubscription.clear();
    if (projectionErrors.length > 0) {
      throw new AggregateError(
        projectionErrors,
        "The closed Codex runtime could not retire every durable provider authority.",
      );
    }
  }

  async #drainOwnedWork(): Promise<void> {
    for (;;) {
      const owned = [
        ...this.#operations,
        ...this.#mutationTails.values(),
        ...this.#background,
      ];
      if (owned.length === 0) return;
      await Promise.allSettled(owned);
      await Promise.resolve();
    }
  }

  #beginOperation(): () => void {
    if (this.#state !== "open") {
      throw new CommandFailure("UNAVAILABLE", "The daemon service is closing and no longer accepts operations.");
    }
    return this.#trackOperation();
  }

  #beginFactOperation(): (() => void) | null {
    if (this.#state !== "open") return null;
    return this.#trackOperation();
  }

  #trackOperation(): () => void {
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    this.#operations.add(pending);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#operations.delete(pending);
      settle();
    };
  }

  async #fencedEffect<T>(operation: () => Promise<T>): Promise<T> {
    await this.#daemonAuthority.assertCurrent();
    const result = await operation();
    await this.#daemonAuthority.assertCurrent();
    return result;
  }

  async #doctor(offline: boolean, signal: AbortSignal): Promise<unknown> {
    const problems: string[] = [];
    const bunReady = Bun.version === "1.3.14";
    if (!bunReady) problems.push(`HRA requires Bun 1.3.14, but ${Bun.version} is running.`);
    let codex: { status: "ready"; version: string } | { status: "invalid"; diagnostic: string };
    try {
      const runtime = await resolvePinnedCodexRuntime();
      codex = { status: "ready", version: runtime.packageVersion };
    } catch {
      const diagnostic = "The pinned Codex runtime check failed without exposing its runtime diagnostic.";
      codex = { status: "invalid", diagnostic };
      problems.push(diagnostic);
    }
    let cloud: unknown = { configured: false, skipped: offline };
    if (!offline) {
      try {
        cloud = await this.#fencedEffect(async () => await this.#cloud.status(signal));
        problems.push(...cloudDoctorProblems(cloud));
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        const diagnostic = "Cloud status failed without exposing its runtime diagnostic.";
        cloud = { configured: true, status: "unavailable", diagnostic };
        problems.push(diagnostic);
      }
    }
    const projects = this.#store.listProjects();
    const projectReady = projects.length > 0;
    if (!projectReady) {
      problems.push("No project directory is configured. Stop the daemon with `hra daemon stop`, then run `hra init --yes`.");
    }
    if (projectReady) {
      const usable = await Promise.all(projects.map(async (project) =>
        await resolveUsableCanonicalProjectDirectory(project.rootPath)));
      if (usable.some((projectRoot) => projectRoot === null)) {
        problems.push("A configured project directory is missing or unsafe. Run `hra project list`, then restore or repair every listed directory so it is readable, writable, traversable, and canonical.");
      }
    }
    let desktopRecovery: unknown = { status: "unavailable" };
    if (this.#desktop !== undefined) {
      try {
        desktopRecovery = await this.#fencedEffect(async () => await this.#desktop?.currentRecovery());
        if (
          desktopRecovery !== null &&
          typeof desktopRecovery === "object" &&
          "status" in desktopRecovery &&
          desktopRecovery.status === "recovery_required"
        ) {
          problems.push("A desktop switch is unresolved. Run `hra account switch-recover`.");
        }
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        const diagnostic = "Desktop switch recovery failed without exposing its runtime diagnostic.";
        desktopRecovery = { status: "invalid", diagnostic };
        problems.push(diagnostic);
      }
    }
    return {
      healthy: problems.length === 0,
      offline,
      runtime: { bun: Bun.version, requiredBun: "1.3.14", bunReady, codex, platform: process.platform, architecture: process.arch },
      state: { database: "ready", profiles: this.#store.listProfiles().length, projects: projects.length, unsettledMutations: this.#store.listUnsettledMutations().length },
      cloud,
      desktop: { supportedPlatform: process.platform === "darwin", configured: this.#desktop !== undefined, recovery: desktopRecovery },
      problems,
    };
  }

  async #addAccount(label: string): Promise<unknown> {
    let profile: ProfileRecord;
    try {
      profile = this.#store.createProfile(label);
    } catch (error: unknown) {
      const normalizedLabel = canonicalLabelKey(label);
      const duplicate = this.#store.listProfiles().some((candidate) =>
        canonicalLabelKey(candidate.label) === normalizedLabel);
      if (duplicate && isSqliteUniqueConstraint(error)) {
        throw new CommandFailure("CONFLICT", "An active account already uses that label.");
      }
      throw error;
    }
    try {
      await initializeProfilePaths(this.#paths, profile.id);
      await this.#daemonAuthority.assertCurrent();
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      this.#store.removeProfile(profile.id);
      throw error;
    }
    return { account: this.#publicProfile(profile), next: `hra account login ${profile.id}` };
  }

  async #addProject(label: string, path: string): Promise<unknown> {
    try {
      return await this.#store.createProject(
        label,
        path,
        this.#store.listProjects().length === 0,
      );
    } catch (error: unknown) {
      const normalizedLabel = canonicalLabelKey(label);
      const requestedRoot = resolve(path);
      const projects = this.#store.listProjects();
      const duplicateLabel = projects.some((candidate) =>
        canonicalLabelKey(candidate.label) === normalizedLabel);
      const duplicateRoot = projects.some((candidate) =>
        candidate.rootPath === requestedRoot);
      if (isSqliteUniqueConstraint(error) && duplicateLabel) {
        throw new CommandFailure("CONFLICT", "A project already uses that label.");
      }
      if (isSqliteUniqueConstraint(error) && duplicateRoot) {
        throw new CommandFailure("CONFLICT", "A project already uses that directory.");
      }
      if (error instanceof UnusableProjectRootError) {
        throw new CommandFailure(
          "UNAVAILABLE",
          "The project directory is missing, unsafe, or not readable, writable, traversable, and canonical. Repair it or choose another directory before retrying.",
          {
            nextCommand: "hra doctor",
            repair: "repair_or_select_project",
          },
        );
      }
      throw error;
    }
  }

  async #requireUsableProjectRoot(projectRoot: string): Promise<string> {
    const canonical = await resolveUsableCanonicalProjectDirectory(projectRoot);
    if (canonical === null) {
      throw new CommandFailure(
        "UNAVAILABLE",
        "The selected project directory is missing, unsafe, or not readable, writable, and traversable. Repair it or select another project before retrying.",
        {
          nextCommand: "hra doctor",
          repair: "repair_or_select_project",
        },
      );
    }
    // Filesystem validation awaits several operations. Recheck daemon authority
    // after that await boundary so the following provider call cannot escape a
    // concurrent service shutdown on a formerly valid root.
    await this.#daemonAuthority.assertCurrent();
    return canonical;
  }

  async #readPluginCatalog(
    profileId: ProfileRecord["id"],
    projectSelector: string | undefined,
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<Readonly<{ catalog: CodexPluginCatalog; profile: ProfileRecord }>> {
    const profile = this.#store.requireProfile(profileId);
    this.#assertSignedIn(profile);
    const project = projectSelector === undefined
      ? undefined
      : this.#store.requireProject(projectSelector);
    const catalog = await this.#fencedEffect(async () => {
      const projectRoot = project === undefined
        ? undefined
        : await this.#requireUsableProjectRoot(project.rootPath);
      return await this.#codex.listPlugins({
        authority: authorityFor(this.#paths, profile),
        ...(projectRoot === undefined ? {} : { projectRoot }),
        forceRefetch: refresh,
        signal,
      });
    });
    return { catalog, profile: this.#store.requireProfile(profile.id) };
  }

  async #listPlugins(
    profileId: ProfileRecord["id"],
    projectSelector: string | undefined,
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { catalog, profile } = await this.#readPluginCatalog(
      profileId,
      projectSelector,
      refresh,
      signal,
    );
    return { account: this.#publicProfile(profile), catalog };
  }

  async #showPlugin(
    profileId: ProfileRecord["id"],
    selector: string,
    projectSelector: string | undefined,
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { catalog, profile } = await this.#readPluginCatalog(
      profileId,
      projectSelector,
      refresh,
      signal,
    );
    const entries: Array<Readonly<{
      marketplace: CodexPluginCatalog["marketplaces"][number];
      plugin: CodexPluginSummary;
    }>> = [];
    for (const marketplace of catalog.marketplaces) {
      for (const plugin of marketplace.plugins) entries.push({ marketplace, plugin });
    }
    const exact = entries.filter((entry) => entry.plugin.id === selector);
    const normalized = selector.toLocaleLowerCase("en-US");
    const labels = exact.length > 0
      ? exact
      : entries.filter((entry) =>
        entry.plugin.name.toLocaleLowerCase("en-US") === normalized
        || entry.plugin.displayName?.toLocaleLowerCase("en-US") === normalized);
    if (labels.length !== 1) {
      throw new SelectionError(
        labels.length === 0 ? "NOT_FOUND" : "AMBIGUOUS",
        labels.map(({ plugin }) => ({
          id: plugin.id,
          label: plugin.displayName ?? plugin.name,
        })),
      );
    }
    const selected = labels[0];
    if (selected === undefined) throw new SelectionError("NOT_FOUND");
    return {
      account: this.#publicProfile(profile),
      marketplace: {
        name: selected.marketplace.name,
        displayName: selected.marketplace.displayName,
      },
      plugin: selected.plugin,
      lifecycle: catalog.lifecycle,
    };
  }

  async #showAccount(selector: string, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    if (profile.state === "signed_out" && profile.processGeneration === 0) {
      return { account: this.#publicProfile(profile) };
    }
    const projectionRecoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettledForProfile(profile.id);
    await this.#daemonAuthority.assertCurrent();
    const account = await this.#fencedEffect(async () => await this.#codex.readAccount({ authority: authorityFor(this.#paths, profile), signal }));
    if (projectionRecoveryUnsettled) {
      return {
        account: this.#publicProfile(profile),
        providerProjection: account,
        recovery: {
          cleared: false,
          diagnostic: "Compact-projection recovery preserves this account's exact local authority; provider state was read without changing local custody.",
          required: true,
        },
      };
    }
    if (profile.state === "recovery_required") {
      const unsettled = this.#store.listUnsettledMutations({ authorityId: profile.id })
        .filter((attempt) => attempt.authorityGeneration === profile.processGeneration && (attempt.kind === "account.login" || attempt.kind === "account.logout"));
      if (unsettled.length !== 1) {
        return { account: this.#publicProfile(profile), providerProjection: account, recovery: { required: true, cleared: false, diagnostic: "No single exact account recovery authority is available." } };
      }
      const attempt = unsettled[0];
      if (attempt?.evidence === undefined || (attempt.originalState ?? attempt.state) === "reconciled") {
        throw new CommandFailure("RECOVERY_REQUIRED", "The account recovery evidence is incomplete.");
      }
      const originalState = attempt.originalState ?? attempt.state;
      if (originalState !== "effect_started" && originalState !== "ambiguous") {
        throw new CommandFailure("RECOVERY_REQUIRED", "The account recovery state is not resolvable.");
      }
      if (attempt.kind === "account.login" && !account.signedIn) {
        return { account: this.#publicProfile(profile), providerProjection: account, recovery: { required: true, cleared: false, diagnostic: "The exact provider read does not prove that login completed." } };
      }
      const applied = attempt.kind === "account.login" || !account.signedIn;
      const reconciled = this.#store.resolveAccountMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: attempt.evidence.digest,
        resolution: applied ? "proven_applied" : "provider_state_reconciled",
        resolutionEvidence: { source: "account/read", signedIn: account.signedIn },
        ...(attempt.kind === "account.login"
          ? { receipt: { status: "signed_in", account } }
          : account.signedIn ? {} : { receipt: { loggedOut: true } }),
        provider: account,
      });
      return { account: this.#publicProfile(reconciled), providerProjection: account, idempotencyKey: attempt.idempotencyKey, recovery: { required: false, cleared: true, resolution: applied ? "proven_applied" : "provider_state_reconciled" } };
    }
    if (profile.state === "login_pending" && !account.signedIn) {
      const authority = this.#store.readPendingLoginAuthority(profile.id, profile.processGeneration);
      return {
        account: this.#publicProfile(profile),
        providerProjection: account,
        login: authority === null
          ? {
              status: "pending",
              recoveryRequired: true,
              diagnostic: "The pending login has no exact durable provider login authority.",
            }
          : {
              status: "pending",
              loginId: authority.loginId,
              next: `hra account login-cancel ${profile.id}`,
            },
      };
    }
    const stateChange = this.#store.setProfileStateWithWorkRetirement(
      profile.id,
      profile.processGeneration,
      account.signedIn ? "signed_in" : "signed_out",
      this.#work,
      {
        ...(account.email === undefined ? {} : { email: account.email }),
        ...(account.plan === undefined ? {} : { plan: account.plan }),
      },
    );
    this.#notifyAffectedWork(stateChange.affectedWorkIds);
    if (!stateChange.changed) {
      throw new CommandFailure("CONFLICT", "Account generation changed during reconciliation.");
    }
    return { account: this.#publicProfile(this.#store.requireProfile(profile.id)) };
  }

  async #login(selector: string, deviceCode: boolean, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const current = this.#store.requireProfile(selector);
    await this.#assertNoCompactProjectionRecoveryForProfile(current.id);
    if (current.state === "signed_in" && idempotencyKey === undefined) return { account: this.#publicProfile(current), login: { status: "signed_in" } };
    const key = idempotencyKey ?? randomUUID();
    const prior = this.#store.readMutation(key);
    if (prior !== null && (prior.kind !== "account.login" || prior.authorityId !== current.id)) {
      throw new CommandFailure("CONFLICT", "The idempotency key belongs to another mutation authority.");
    }
    if (prior === null && (current.state === "login_pending" || current.state === "recovery_required")) {
      throw new CommandFailure("RECOVERY_REQUIRED", "This account already has an unsettled login. Reuse its idempotency key or inspect the account before starting another login.");
    }
    const reboundAuthority = current.state === "login_pending"
      ? this.#store.readPendingLoginAuthority(current.id, current.processGeneration)
      : null;
    const targetGeneration = prior?.authorityGeneration ?? current.processGeneration + 1;
    const canBegin = current.processGeneration + 1 === targetGeneration && (prior === null || prior.state === "prepared");
    const canReplayReboundPending = prior?.state === "applied"
      && reboundAuthority?.attemptId === prior.id;
    if (current.processGeneration !== targetGeneration && !canBegin && !canReplayReboundPending) {
      throw new CommandFailure("CONFLICT", "The login attempt belongs to a stale account generation.");
    }
    const authority = { ...current, processGeneration: targetGeneration };
    try {
      const result = await this.#effect({
        kind: "account.login",
        authorityId: current.id,
        authorityGeneration: targetGeneration,
        request: { deviceCode },
        idempotencyKey: key,
        beginEffect: (attemptId) => {
          try {
            const retirements = this.#prepareAccountLoginProviderRetirements(
              current.id,
              current.processGeneration,
            );
            const begun = this.#store.beginAccountMutationEffect({
              attemptId,
              profileId: current.id,
              profileGeneration: targetGeneration,
              evidence: { kind: "account.login", method: deviceCode ? "device_code" : "browser" },
              providerRetirements: retirements,
              workStore: this.#work,
            });
            this.#notifyAffectedWork(begun.affectedWorkIds);
            this.#applyAccountLoginProviderRetirements(
              retirements,
              begun.retiredSessionIds,
            );
          } catch (error: unknown) {
            // Preparing the retirement drains bounded redactor custody. A
            // failed atomic commit must stop this daemon so recovery exposes a
            // provider gap instead of continuing from an incomplete stream.
            this.#state = "closing";
            this.#interactionDeadlineAbort.abort(
              new Error("Account login provider retirement did not commit exactly."),
            );
            this.#interactionDeadlineWake?.();
            this.#interactionDeadlineWake = undefined;
            this.#daemonAuthority.close();
            this.#scheduleStop();
            throw error;
          }
        },
        effect: async () => await this.#fencedEffect(async () => await this.#codex.login({ authority: authorityFor(this.#paths, authority), method: deviceCode ? "device_code" : "browser", signal })),
        receipt: (value) => loginReceiptSchema.parse(value.status === "pending"
          ? { status: "pending", loginId: value.loginId }
          : { status: "signed_in", account: value.account }),
        restore: restoreLoginReceipt,
        commit: (attemptId, _value, receipt) => {
          this.#store.completeAccountLoginMutation({
            attemptId,
            profileId: current.id,
            processGeneration: targetGeneration,
            receipt: loginReceiptSchema.parse(receipt),
          });
        },
      });
      const observed = this.#store.requireProfile(current.id);
      const replayedPendingReceipt = prior?.state === "applied" && result.status === "pending";
      const login = replayedPendingReceipt && observed.state === "signed_in"
        ? {
            status: "signed_in" as const,
            account: {
              signedIn: true as const,
              ...(observed.providerEmail === undefined ? {} : { email: observed.providerEmail }),
              ...(observed.providerPlan === undefined ? {} : { plan: observed.providerPlan }),
            },
          }
        : replayedPendingReceipt && observed.state === "signed_out"
          ? { status: "settled" as const, outcome: "signed_out" as const }
          : result.status === "pending"
            ? {
                ...result,
                next: `hra account login-cancel ${current.id}`,
              }
            : result;
      return {
        account: this.#publicProfile(observed),
        login,
        idempotencyKey: key,
      };
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      const observed = this.#store.requireProfile(current.id);
      const attempt = this.#store.readMutation(key);
      if (observed.processGeneration === targetGeneration) {
        if (attempt?.state === "effect_started" || attempt?.state === "ambiguous") {
          this.#quarantineProfile(observed);
        } else if (observed.state === "login_pending") {
          const stateChange = this.#store.setProfileStateWithWorkRetirement(
            current.id,
            targetGeneration,
            "signed_out",
            this.#work,
          );
          this.#notifyAffectedWork(stateChange.affectedWorkIds);
        }
      }
      throw error;
    }
  }

  async #cancelLogin(selector: string, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    await this.#assertNoCompactProjectionRecoveryForProfile(profile.id);
    if (profile.state === "recovery_required") {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "This login has no safely replayable cancellation authority. Inspect the account before changing provider state.",
      );
    }
    if (profile.state === "signed_in") {
      return { account: this.#publicProfile(profile), status: "signed_in" };
    }
    if (profile.state === "signed_out") {
      return { account: this.#publicProfile(profile), status: "already_settled" };
    }
    if (profile.state !== "login_pending") {
      throw new CommandFailure("CONFLICT", "This account cannot cancel a login in its current state.");
    }
    const login = this.#store.readPendingLoginAuthority(profile.id, profile.processGeneration);
    if (login === null) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The pending login has no exact durable provider login authority and cannot be canceled automatically.",
      );
    }
    const authority = authorityFor(this.#paths, profile);
    const canceled = await this.#fencedEffect(async () => await this.#codex.cancelLogin({
      authority,
      loginId: login.loginId,
      signal,
    }));
    const provider = await this.#fencedEffect(async () => await this.#codex.readAccount({
      authority,
      signal,
    }));
    const observed = this.#store.requireProfileById(profile.id);
    if (observed.processGeneration !== profile.processGeneration) {
      throw new CommandFailure("CONFLICT", "The login cancellation belongs to a stale account generation.");
    }
    if (observed.state === "signed_in") {
      return { account: this.#publicProfile(observed), loginId: login.loginId, status: "signed_in" };
    }
    if (observed.state === "signed_out") {
      return { account: this.#publicProfile(observed), loginId: login.loginId, status: "already_settled" };
    }
    let settled: ProfileRecord;
    try {
      settled = this.#store.settlePendingLogin({
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        loginId: login.loginId,
        providerStatus: canceled.status,
        provider,
      });
    } catch {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The exact login cancellation could not be committed under its original authority.",
      );
    }
    return {
      account: this.#publicProfile(settled),
      loginId: login.loginId,
      providerStatus: canceled.status,
      status: provider.signedIn ? "signed_in" : "canceled",
    };
  }

  async #logout(selector: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    await this.#assertNoCompactProjectionRecoveryForProfile(profile.id);
    this.#work.assertProfileCanChangeAuthority(profile.id);
    const key = idempotencyKey ?? randomUUID();
    if (profile.state === "recovery_required") {
      throw new CommandFailure("RECOVERY_REQUIRED", "This account has an indeterminate logout. Run `hra account show` to reconcile its exact provider state before another logout.");
    }
    await this.#effect({
      kind: "account.logout",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: {},
      idempotencyKey: key,
      beginEffect: (attemptId) => {
        const begun = this.#store.beginAccountMutationEffect({
          attemptId,
          profileId: profile.id,
          profileGeneration: profile.processGeneration,
          evidence: { kind: "account.logout", baselineSignedIn: profile.state !== "signed_out" },
          workStore: this.#work,
        });
        this.#notifyAffectedWork(begun.affectedWorkIds);
      },
      effect: async () => {
        if (profile.state !== "signed_out") await this.#fencedEffect(async () => await this.#codex.logout({ authority: authorityFor(this.#paths, profile), signal }));
        return { loggedOut: true as const };
      },
      receipt: (value) => logoutReceiptSchema.parse(value),
      restore: (value) => logoutReceiptSchema.parse(value),
      onAmbiguous: () => this.#quarantineProfile(profile),
    });
    const current = this.#store.requireProfile(profile.id);
    const stateChange = current.state === "signed_out"
      ? null
      : this.#store.setProfileStateWithWorkRetirement(
          profile.id,
          profile.processGeneration,
          "signed_out",
          this.#work,
        );
    if (stateChange !== null) this.#notifyAffectedWork(stateChange.affectedWorkIds);
    if (stateChange !== null && !stateChange.changed) {
      this.#quarantineProfile(profile);
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex logged out, but its local account state could not be committed. Run `hra account show` to reconcile it.");
    }
    return { account: this.#publicProfile(this.#store.requireProfile(profile.id)), idempotencyKey: key };
  }

  async #usage(selector: string | undefined, refresh: boolean, signal: AbortSignal): Promise<unknown> {
    if (selector === undefined && refresh) {
      const usage: unknown[] = [];
      for (const profile of this.#store.listProfiles()) {
        const value = await this.#serialize(`account:${profile.id}`, async () =>
          this.#usage(profile.id, true, signal)) as { usage: unknown[] };
        usage.push(...value.usage);
      }
      return { usage };
    }
    const profiles = selector === undefined ? this.#store.listProfiles() : [this.#store.requireProfile(selector)];
    const usage = [];
    for (const profile of profiles) {
      if (refresh) {
        this.#assertSignedIn(profile);
        const sourceSequence = this.#store.allocateNextUsageRevision(profile.id);
        let snapshot: Awaited<ReturnType<CodexRuntimePort["readUsage"]>>;
        try {
          snapshot = await this.#fencedEffect(async () =>
            await this.#codex.readUsage({ authority: authorityFor(this.#paths, profile), signal }));
        } catch (error: unknown) {
          if (!signal.aborted) {
            this.#store.recordUsagePollFailure(
              profile.id,
              sourceSequence,
              this.#now(),
              "account_usage_read_failed",
            );
          }
          throw error;
        }
        const receivedAt = this.#now();
        const previous = this.#store.latestUsage(profile.id);
        const stored = createStoredAccountUsageSnapshot({
          providerPayload: snapshot.payload,
          sourceSequence,
          observedAt: snapshot.observedAt,
          receivedAt,
          accountFingerprint: profile.providerEmail === undefined
            ? null
            : digestText(profile.providerEmail.trim().toLowerCase()),
          providerGeneration: profile.processGeneration,
          daemonGeneration: this.#daemonGeneration,
          previousPayload: previous?.payload ?? null,
        });
        this.#store.recordUsage(profile.id, sourceSequence, snapshot.observedAt, stored);
      }
      const latest = this.#store.latestUsage(profile.id);
      const latestFailure = this.#store.latestUsagePollFailure(profile.id);
      const now = this.#now();
      const samples = accountUsageCounterSamples(this.#store.usageRange({
        profileId: profile.id,
        fromObservedAt: Math.max(0, now - 30 * 60_000),
        throughObservedAt: now,
        limit: 2_000,
      }));
      const windows = ["1m", "5m", "15m"] satisfies readonly UsageVelocityWindow[];
      const velocity = Object.fromEntries(windows.map((window) => [
        window,
        observedAccountTokenVelocity({ samples, window, now }),
      ]));
      const parsedStored = latest === null
        ? null
        : storedAccountUsageSnapshotSchema.safeParse(latest.payload);
      usage.push({
        account: this.#publicProfile(profile),
        poll: latestFailure !== null
          && (latest === null || latestFailure.sourceRevision > latest.sourceRevision)
          ? { state: "failed", ...latestFailure }
          : latest === null
            ? { state: "never_observed" }
            : {
                observedAt: latest.observedAt,
                sourceRevision: latest.sourceRevision,
                state: "observed",
              },
        snapshot: latest === null ? null : {
          ...latest,
          payload: providerUsagePayload(latest.payload),
          ...(parsedStored?.success === true
            ? { observation: parsedStored.data.observation }
            : {}),
        },
        velocity,
      });
    }
    return { usage };
  }

  #usageHistory(
    command: Extract<LocalCommand, { kind: "account.usage-history" }>,
  ): unknown {
    const profile = this.#store.requireProfile(command.account);
    const now = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(this.#now());
    let fromObservedAt: number;
    let throughObservedAt: number;
    let afterSourceRevision = 0;
    let issuedAt = now;
    if (command.cursor !== undefined) {
      const decoded = this.#usageHistoryCursors.decode(command.cursor, {
        accountId: profile.id,
        now,
        ...(command.fromObservedAt === undefined
          ? {}
          : { fromObservedAt: command.fromObservedAt }),
        ...(command.throughObservedAt === undefined
          ? {}
          : { throughObservedAt: command.throughObservedAt }),
      });
      fromObservedAt = decoded.fromObservedAt;
      throughObservedAt = decoded.throughObservedAt;
      afterSourceRevision = decoded.afterSourceRevision;
      issuedAt = decoded.issuedAt;
    } else {
      const retentionFloor = Math.max(0, now - USAGE_LOCAL_RETAIN_AGE_MS);
      fromObservedAt = command.fromObservedAt ?? retentionFloor;
      throughObservedAt = command.throughObservedAt ?? now;
      if (fromObservedAt > throughObservedAt) {
        throw new CommandFailure(
          "INVALID_INPUT",
          "Usage history --from must not be later than --through.",
        );
      }
      if (throughObservedAt > now) {
        throw new CommandFailure(
          "INVALID_INPUT",
          "Usage history --through must not be in the future.",
        );
      }
      if (fromObservedAt < retentionFloor || throughObservedAt < retentionFloor) {
        throw new CommandFailure(
          "INVALID_INPUT",
          "Usage history ranges must stay within the retained 24-hour window.",
          { retentionFloorObservedAt: retentionFloor, throughObservedAt: now },
        );
      }
    }

    const listed = this.#store.usageHistoryPage({
      profileId: profile.id,
      fromObservedAt,
      throughObservedAt,
      afterSourceRevision,
      limit: command.limit,
    });
    const entries = listed.entries.map((entry) => {
      if (entry.state === "failed") {
        return accountUsageHistoryEntrySchema.parse(entry);
      }
      const parsed = storedAccountUsageSnapshotSchema.safeParse(entry.payload);
      const observation = parsed.success
        && parsed.data.observation.sourceSequence === entry.sourceRevision
        && parsed.data.observation.observedAt === entry.observedAt
        ? parsed.data.observation
        : null;
      return accountUsageHistoryEntrySchema.parse({
        state: "observed",
        sourceRevision: entry.sourceRevision,
        observedAt: entry.observedAt,
        receivedAt: observation?.receivedAt ?? null,
        lifetimeTokens: observation?.lifetimeTokens ?? null,
        gapBefore: observation?.gapBefore ?? null,
      });
    });
    const nextCursor = listed.nextSourceRevision === null
      ? null
      : this.#usageHistoryCursors.encode({
          version: 1,
          type: "account_usage_history",
          accountId: profile.id,
          fromObservedAt,
          throughObservedAt,
          afterSourceRevision: listed.nextSourceRevision,
          issuedAt,
        });
    return accountUsageHistoryPageSchema.parse({
      account: { id: profile.id, label: profile.label },
      range: { fromObservedAt, throughObservedAt },
      entries,
      nextCursor,
    });
  }

  async #switchAccount(selector: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown> {
    if (this.#desktop === undefined) throw new CommandFailure("UNAVAILABLE", "Desktop account switching is available only on a supported macOS ChatGPT build.");
    const desktop = this.#desktop;
    const target = this.#store.requireProfile(selector);
    if (target.state !== "signed_in") throw new CommandFailure("CONFLICT", "The target account is not signed in.");
    const result = await this.#fencedEffect(async () => await desktop.switchAccount({ idempotencyKey, target: authorityFor(this.#paths, target), signal }));
    if (result.status === "recovery_required") {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        result.diagnostic ?? "Desktop account switch requires recovery.",
        { idempotencyKey: result.idempotencyKey, action: "hra account switch-recover" },
      );
    }
    return result;
  }

  async #recoverDesktopSwitch(signal: AbortSignal): Promise<unknown> {
    if (this.#desktop === undefined) {
      throw new CommandFailure("UNAVAILABLE", "Desktop account switching is available only on a supported macOS ChatGPT build.");
    }
    const desktop = this.#desktop;
    return await this.#fencedEffect(async () => await desktop.recoverSwitch({ signal }));
  }

  async #recoverCompactProjection(
    expected: Readonly<{
      acknowledgeGap: true;
      idempotencyKey: string;
      processGeneration: number;
      profileId: ProfileRecord["id"];
      providerThreadId: string;
      sessionId: SessionRecord["id"];
    }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    await this.#daemonAuthority.assertCurrent();
    const session = this.#requireBoundSession(expected.sessionId);
    const profile = this.#store.requireProfileById(expected.profileId);
    if (
      session.profileId !== expected.profileId
      || session.providerThreadId !== expected.providerThreadId
      || profile.processGeneration !== expected.processGeneration
    ) {
      throw new CommandFailure("CONFLICT", "The projection recovery authority changed before admission.");
    }
    this.#assertSignedIn(profile);
    if (session.state !== "idle" || session.activeTurnId !== undefined) {
      throw new CommandFailure("CONFLICT", "Projection recovery requires an idle session with no active turn.");
    }
    const unsettledMutations = this.#store.listUnsettledMutations({ sessionId: session.id });
    const unsettledQueueEffects = this.#store.listUnsettledQueueEffects(session.id);
    const unsettledQueueEntries = this.#store.listQueue(session.id)
      .filter((entry) => entry.state === "pending" || entry.state === "dispatching" || entry.state === "ambiguous");
    if (unsettledMutations.length > 0 || unsettledQueueEffects.length > 0 || unsettledQueueEntries.length > 0) {
      throw new CommandFailure("RECOVERY_REQUIRED", "Projection recovery rejects a session with unsettled mutation or queue authority.");
    }
    return await this.#fencedEffect(async () => await this.#cloud.recoverCompactProjection({
      acknowledgeGap: expected.acknowledgeGap,
      idempotencyKey: expected.idempotencyKey,
      sessionPublicId: session.id,
      signal,
    }));
  }

  #encodeEventCursor(input: {
    sessionId: SessionRecord["id"];
    streamEpoch: string;
    sequence: number;
  }): string {
    return this.#eventCursors.encode({
      version: 1,
      sessionId: input.sessionId,
      streamEpoch: input.streamEpoch,
      sequence: input.sequence,
    });
  }

  #factsMemoryExpiry(session: SessionRecord): number {
    return Math.min(Number.MAX_SAFE_INTEGER, session.updatedAt + FACTS_MEMORY_SESSION_TTL_MS);
  }

  async #ensureFactsMemory(session: SessionRecord): Promise<void> {
    if (this.#factsMemory === undefined) return;
    try {
      await this.#factsMemory.ensureSession({
        expiresAt: this.#factsMemoryExpiry(session),
        ownerId: session.profileId,
        sessionId: session.id,
      });
    } catch (cause: unknown) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The session facts-memory authority could not be created or reconciled. The provider session remains under its existing HRA authority; retry this exact session operation after reconciling local memory custody.",
        { cause: cause instanceof Error ? cause.name : "error", sessionId: session.id },
      );
    }
  }

  async #cleanupFactsMemory(
    session: SessionRecord,
    reason: "abandon" | "archive" | "expired",
  ): Promise<void> {
    if (this.#factsMemory === undefined) return;
    try {
      await this.#factsMemory.cleanupSession({
        ownerId: session.profileId,
        reason,
        sessionId: session.id,
      });
    } catch (cause: unknown) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The session facts-memory directory could not be proven fully purged. HRA retained the cleanup authority for an exact retry.",
        { cause: cause instanceof Error ? cause.name : "error", sessionId: session.id },
      );
    }
  }

  async #cleanupTerminalFactsMemory(session: SessionRecord): Promise<void> {
    this.#terminalFactsMemoryReconciled = false;
    await this.#cleanupFactsMemory(session, "archive");
  }

  async #ensureSessionObservedLocked(
    selector: string,
    signal: AbortSignal,
  ): Promise<PublicProviderObservation> {
    let session = this.#store.requireSession(selector);
    const profile = this.#store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) {
      return {
        basis: "local_state",
        coverage: "not_attempted",
        freshness: "unknown",
        observedAt: this.#now(),
        profileGeneration: profile.processGeneration,
        reason: "unbound",
        source: "codex_app_server",
        state: "not_applicable",
      };
    }
    if (session.state === "terminal") {
      await this.#cleanupTerminalFactsMemory(session);
      return {
        basis: "local_state",
        coverage: "not_attempted",
        freshness: "unknown",
        observedAt: this.#now(),
        profileGeneration: profile.processGeneration,
        reason: "terminal",
        source: "codex_app_server",
        state: "not_applicable",
      };
    }
    if (session.state === "recovery_required") {
      return {
        basis: "local_state",
        code: "session_quarantined",
        coverage: "partial",
        freshness: "fresh",
        observedAt: this.#now(),
        profileGeneration: profile.processGeneration,
        source: "codex_app_server",
        state: "recovery_required",
      };
    }
    await this.#ensureFactsMemory(session);
    if (profile.state !== "signed_in") {
      return {
        basis: "local_state",
        code: "account_signed_out",
        coverage: "unavailable",
        freshness: "fresh",
        observedAt: this.#now(),
        profileGeneration: profile.processGeneration,
        source: "codex_app_server",
        state: "unavailable",
      };
    }
    if (this.#lastSessionEventIsProviderGap(session.id)) {
      this.#sessionsAwaitingResubscription.add(session.id);
    }
    const projectionRecoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettled(session.id);
    await this.#daemonAuthority.assertCurrent();
    const observationFactEpoch = this.#sessionFactEpochs.get(session.id) ?? 0;
    const providerThreadId = session.providerThreadId;
    const authority = authorityFor(this.#paths, profile);
    let observation: CodexSessionObservation;
    try {
      observation = await this.#fencedEffect(async () => await this.#codex.observeSession({
        authority,
        providerThreadId,
        signal,
      }));
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      const exact = this.#currentObservationSession(
        authority,
        session.id,
        providerThreadId,
      );
      if (exact === null) {
        return {
          basis: "provider_read",
          code: "resume_unavailable",
          coverage: "unavailable",
          freshness: "fresh",
          observedAt: this.#now(),
          profileGeneration: this.#currentProfileGeneration(authority),
          source: "codex_app_server",
          state: "unavailable",
        };
      }
      if (
        error instanceof CodexSessionObservationError
        && error.reason === "thread_mismatch"
      ) {
        return this.#quarantineObservationMismatch(authority, exact);
      }
      if (!(error instanceof CodexSessionObservationError)) throw error;
      this.#recordSessionObservationFailure(authority, exact, "resume_unavailable", false);
      return {
        basis: "provider_read",
        code: "resume_unavailable",
        coverage: "unavailable",
        freshness: "fresh",
        observedAt: this.#now(),
        profileGeneration: profile.processGeneration,
        source: "codex_app_server",
        state: "unavailable",
      };
    }
    await this.#daemonAuthority.assertCurrent();
    session = this.#store.requireSession(session.id);
    const currentProfile = this.#store.requireProfileById(profile.id);
    if (
      session.profileId !== profile.id
      || session.providerThreadId === undefined
      || session.providerThreadId !== observation.projection.providerThreadId
      || currentProfile.processGeneration !== profile.processGeneration
      || currentProfile.state !== "signed_in"
    ) {
      if (
        this.#currentObservationSession(authority, session.id, providerThreadId) !== null
        && observation.projection.providerThreadId !== providerThreadId
      ) return this.#quarantineObservationMismatch(authority, session);
      return {
        basis: "provider_read",
        code: "resume_unavailable",
        coverage: "unavailable",
        freshness: "fresh",
        observedAt: this.#now(),
        profileGeneration: currentProfile.processGeneration,
        source: "codex_app_server",
        state: "unavailable",
      };
    }
    z.string().uuid().parse(observation.connectionId);
    this.#sessionObservationFailures.delete(session.id);
    this.#ensureSessionProviderConnection(authority, session, observation.connectionId);
    const projection = observation.projection;
    if (
      !projectionRecoveryUnsettled
      && !this.#projectionRecoveriesInFlight.has(session.id)
      && (this.#sessionFactEpochs.get(session.id) ?? 0) === observationFactEpoch
    ) {
      const beforeState = session.state;
      const beforeActiveTurnId = session.activeTurnId ?? null;
      const reconciled = this.#store.reconcileSessionFromProvider({
        sessionId: session.id,
        state: projection.status,
        activeTurnId: projection.status === "active"
          ? projection.activeTurnId ?? null
          : null,
        title: projection.title,
      });
      if (
        reconciled.state !== beforeState
        || (reconciled.activeTurnId ?? null) !== beforeActiveTurnId
      ) {
        this.#appendSessionEvent(authority, reconciled.id, observation.connectionId, {
          type: "session_status",
          status: projection.status,
          activeTurnId: reconciled.activeTurnId ?? null,
        });
      }
      if (reconciled.state === "terminal") {
        await this.#cleanupTerminalFactsMemory(reconciled);
      }
    }
    const mode = this.#sessionResubscriptionConnections.get(session.id) === observation.connectionId
      ? "resubscribed"
      : "connected";
    return {
      basis: "provider_read",
      connectionId: observation.connectionId,
      coverage: "complete",
      freshness: "fresh",
      mode,
      observedAt: this.#now(),
      profileGeneration: profile.processGeneration,
      source: "codex_app_server",
      state: "live",
    };
  }

  #currentObservationSession(
    authority: ProfileAuthority,
    sessionId: SessionRecord["id"],
    providerThreadId: string,
  ): SessionRecord | null {
    try {
      const profile = this.#store.requireProfileById(authority.id);
      const session = this.#store.requireSession(sessionId);
      return profile.processGeneration === authority.generation
        && profile.state === "signed_in"
        && session.profileId === authority.id
        && session.providerThreadId === providerThreadId
        && session.state !== "terminal"
        ? session
        : null;
    } catch (error: unknown) {
      if (error instanceof SelectionError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  #currentProfileGeneration(authority: ProfileAuthority): number {
    try {
      return this.#store.requireProfileById(authority.id).processGeneration;
    } catch (error: unknown) {
      if (error instanceof SelectionError && error.code === "NOT_FOUND") {
        return authority.generation;
      }
      throw error;
    }
  }

  #recordSessionObservationFailure(
    authority: ProfileAuthority,
    session: SessionRecord,
    code: "resume_unavailable",
    terminal: boolean,
  ): void {
    const marker = `${String(authority.generation)}:${code}`;
    if (this.#sessionObservationFailures.get(session.id) === marker) return;
    this.#sessionObservationFailures.set(session.id, marker);
    this.#appendSessionEvent(authority, session.id, null, terminal
      ? {
          type: "error",
          code: "provider_resume_unavailable",
          message: "Provider observation is unavailable; HRA will not follow a stale event stream.",
          terminal: true,
        }
      : {
          type: "warning",
          code: "provider_resume_unavailable",
          message: "Provider observation is unavailable; HRA will not follow a stale event stream.",
        });
  }

  #quarantineObservationMismatch(
    authority: ProfileAuthority,
    session: SessionRecord,
  ): PublicProviderObservation {
    this.#quarantineSession(session.id);
    const marker = `${String(authority.generation)}:thread_mismatch`;
    if (this.#sessionObservationFailures.get(session.id) !== marker) {
      this.#sessionObservationFailures.set(session.id, marker);
      this.#appendSessionEvent(authority, session.id, null, {
        type: "error",
        code: "provider_thread_mismatch",
        message: "Provider observation returned a different thread; the session is quarantined.",
        terminal: true,
      });
    }
    return {
      basis: "provider_read",
      code: "thread_mismatch",
      coverage: "partial",
      freshness: "fresh",
      observedAt: this.#now(),
      profileGeneration: authority.generation,
      source: "codex_app_server",
      state: "recovery_required",
    };
  }

  #requireLiveProviderObservation(observation: PublicProviderObservation): void {
    if (observation.state === "live") return;
    if (observation.state === "recovery_required") {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The provider thread could not be observed under this session's exact authority; the session is quarantined.",
        { providerObservation: observation },
      );
    }
    if (observation.state === "unavailable") {
      throw new CommandFailure(
        "UNAVAILABLE",
        "The provider thread is not currently observable; HRA will not use stale session state.",
        { providerObservation: observation },
      );
    }
    throw new CommandFailure(
      observation.reason === "terminal" ? "CONFLICT" : "RECOVERY_REQUIRED",
      observation.reason === "terminal"
        ? "The session is terminal and has no live provider observation."
        : "The session has no proven provider binding.",
      { providerObservation: observation },
    );
  }

  async #sessionStatus(
    sessionId: SessionRecord["id"],
    signal: AbortSignal,
  ): Promise<SessionStatus> {
    const providerObservation = await this.#ensureSessionObservedLocked(sessionId, signal);
    const snapshot = this.#store.readSessionObservationSnapshot(
      sessionId,
      SESSION_STATUS_PENDING_SUMMARY_LIMIT,
    );
    return sessionStatusSchema.parse({
      version: 2,
      session: snapshot.session,
      advisory: {
        execution: snapshot.session.execution,
        attention: deriveSessionAttention({
          execution: snapshot.session.execution,
          localCoverage: "complete",
          pendingInteractionCount: snapshot.interactions.pendingCount,
          responseInFlightCount: snapshot.interactions.responseInFlightCount,
        }),
        queueDepth: snapshot.queue.depth,
      },
      localObservation: {
        source: "sqlite",
        coverage: "complete",
        freshness: "fresh",
        observedAt: snapshot.observedAt,
      },
      providerObservation,
      eventStream: {
        cursor: this.#encodeEventCursor({
          sessionId,
          streamEpoch: snapshot.eventStream.streamEpoch,
          sequence: snapshot.eventStream.observedThroughSequence,
        }),
        retentionFloorCursor: this.#encodeEventCursor({
          sessionId,
          streamEpoch: snapshot.eventStream.streamEpoch,
          sequence: Math.max(0, snapshot.eventStream.floorSequence - 1),
        }),
        streamEpoch: snapshot.eventStream.streamEpoch,
        floorSequence: snapshot.eventStream.floorSequence,
        observedThroughSequence: snapshot.eventStream.observedThroughSequence,
      },
      interactions: snapshot.interactions,
      queue: snapshot.queue,
    });
  }

  #interactionPage(input: Readonly<{
    cursor?: string;
    limit: number;
    pending: boolean;
    sessionId?: SessionRecord["id"];
  }>): Readonly<{
    interactions: readonly PublicInteraction[];
    nextCursor: string | null;
    sessionId: SessionRecord["id"] | null;
  }> {
    const scope: InteractionCursorScope = input.sessionId === undefined
      ? { type: "global" }
      : { type: "session", sessionId: input.sessionId };
    let after: Readonly<{ publicId: string; requestedAt: number }> | undefined;
    if (input.cursor !== undefined) {
      try {
        const decoded = this.#eventCursors.decodeInteraction(input.cursor, {
          scope,
          pending: input.pending,
        });
        after = { requestedAt: decoded.requestedAt, publicId: decoded.publicId };
      } catch (error: unknown) {
        if (error instanceof SessionEventCursorError) {
          throw new CommandFailure(
            "INVALID_INPUT",
            "The interaction cursor is invalid for this exact interaction listing.",
          );
        }
        throw error;
      }
    }
    const page = this.#store.listInteractionPage({
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      pendingOnly: input.pending,
      limit: input.limit,
      ...(after === undefined ? {} : { after }),
    });
    const nextCursor = page.nextPosition === null
      ? null
      : this.#eventCursors.encodeInteraction({
          version: 1,
          type: "interaction",
          scope,
          pending: input.pending,
          requestedAt: page.nextPosition.requestedAt,
          publicId: page.nextPosition.publicId,
        });
    return {
      sessionId: input.sessionId ?? null,
      interactions: page.interactions.map((interaction) => this.#publicInteraction(interaction)),
      nextCursor,
    };
  }

  async #sessionEvents(
    command: Extract<LocalCommand, { kind: "session.events" }>,
    signal: AbortSignal,
  ): Promise<SessionEventPage> {
    const selected = this.#store.requireSession(command.session);
    const decodedCursor = command.cursor === undefined
      ? undefined
      : this.#eventCursors.decode(command.cursor);
    if (decodedCursor !== undefined && decodedCursor.sessionId !== selected.id) {
      throw new CommandFailure("INVALID_INPUT", "The session event cursor belongs to another session.");
    }
    const providerObservation = await this.#serializeSessionAuthority(
      selected,
      async () => await this.#ensureSessionObservedLocked(selected.id, signal),
      { allowDuringProjectionRecovery: true },
    );
    const session = this.#store.requireSession(selected.id);
    let requestedSequence: number | null = null;
    let restoredRequestedSequence: number | null = null;
    let streamRestored = false;
    if (decodedCursor !== undefined) {
      const current = this.#store.eventStreamPosition(session.id);
      if (decodedCursor.streamEpoch !== current.streamEpoch) {
        streamRestored = true;
        restoredRequestedSequence = decodedCursor.sequence;
      } else {
        requestedSequence = decodedCursor.sequence;
      }
    }

    let listed = this.#store.listSessionEvents({
      sessionId: session.id,
      afterSequence: requestedSequence,
      limit: command.limit,
    });
    if (
      providerObservation.state === "live"
      && !streamRestored
      && listed.events.length === 0
      && command.waitMs > 0
    ) {
      await this.#eventWaiters.wait({
        sessionId: session.id,
        expectedObservedThrough: listed.observedThroughSequence,
        waitMs: command.waitMs,
        signal,
        readObservedThrough: () =>
          this.#store.eventStreamPosition(session.id).observedThroughSequence,
      });
      listed = this.#store.listSessionEvents({
        sessionId: session.id,
        afterSequence: requestedSequence,
        limit: command.limit,
      });
    }
    if (
      listed.events.length === 0
      && !streamRestored
      && listed.gapReason === null
      && providerObservation.state !== "live"
    ) {
      this.#requireLiveProviderObservation(providerObservation);
    }
    const gapCheckpointSequence = Math.max(0, listed.floorSequence - 1);
    const nextSequence = listed.events.at(-1)?.sequence
      ?? (streamRestored || listed.gapReason !== null
        ? gapCheckpointSequence
        : requestedSequence ?? gapCheckpointSequence);
    const page = {
      version: 1 as const,
      sessionId: session.id,
      requestedCursor: command.cursor ?? null,
      retentionFloorCursor: this.#encodeEventCursor({
        sessionId: session.id,
        streamEpoch: listed.streamEpoch,
        sequence: Math.max(0, listed.floorSequence - 1),
      }),
      observedThroughCursor: this.#encodeEventCursor({
        sessionId: session.id,
        streamEpoch: listed.streamEpoch,
        sequence: listed.observedThroughSequence,
      }),
      nextCursor: this.#encodeEventCursor({
        sessionId: session.id,
        streamEpoch: listed.streamEpoch,
        sequence: nextSequence,
      }),
      gap: streamRestored
        ? {
            reason: "stream_restored" as const,
            requestedSequence: restoredRequestedSequence,
            retainedFromSequence: listed.floorSequence,
          }
        : listed.gapReason === null
          ? null
          : {
              reason: listed.gapReason,
              requestedSequence,
              retainedFromSequence: listed.floorSequence,
            },
      events: [...listed.events],
    };
    return sessionEventPageSchema.parse(page);
  }

  #workSequence(workId: WorkId): number {
    const page = this.#work.events(workId, 0, 1);
    return this.#eventCursors.decodeWorkEvent(
      page.observedThroughCursor,
      workId,
    ).sequence;
  }

  #notifyWorkIfAdvanced(workId: WorkId, priorSequence: number): void {
    if (this.#workSequence(workId) !== priorSequence) this.#workWaiters.notify(workId);
  }

  #notifyAffectedWork(workIds: readonly string[]): void {
    for (const workId of new Set(workIds)) this.#workWaiters.notify(workId);
  }

  #normalizeWorkEventPage(input: Readonly<{
    workId: WorkId;
    requestedCursor: string | undefined;
    decodedCursor: ReturnType<SessionEventCursorCodec["decodeWorkEvent"]> | undefined;
    page: WorkEventPage;
    readFromStart: () => WorkEventPage;
  }>): WorkEventPage {
    let page = input.page;
    if (
      input.decodedCursor !== undefined
      && input.decodedCursor.streamEpoch !== page.streamEpoch
    ) {
      page = input.readFromStart();
      return workEventPageSchema.parse({
        ...page,
        requestedCursor: input.requestedCursor ?? null,
        gap: {
          reason: "stream_reset",
          requestedSequence: input.decodedCursor.sequence,
          retainedFromSequence: 1,
        },
      });
    }
    const observed = this.#eventCursors.decodeWorkEvent(
      page.observedThroughCursor,
      input.workId,
    );
    if (
      input.decodedCursor !== undefined
      && input.decodedCursor.sequence > observed.sequence
    ) {
      throw new CommandFailure(
        "CONFLICT",
        "The work event cursor is ahead of the current durable stream.",
      );
    }
    return workEventPageSchema.parse({
      ...page,
      requestedCursor: input.requestedCursor ?? null,
    });
  }

  #readWorkSnapshot(workId: WorkId, actorSessionId?: string): unknown {
    const priorSequence = this.#workSequence(workId);
    const snapshot = this.#work.snapshot(workId, actorSessionId);
    this.#notifyWorkIfAdvanced(workId, priorSequence);
    return snapshot;
  }

  #readWorkTask(command: Extract<LocalCommand, { kind: "work.task" }>): unknown {
    const historyMode = command.historyLimit !== undefined
      || command.historyCursor !== undefined;
    if (historyMode) {
      const decoded = command.historyCursor === undefined
        ? undefined
        : this.#eventCursors.decodeWorkTaskHistory(command.historyCursor, command.task);
      if (decoded !== undefined) {
        // A continuation keeps its signed point-in-time projection while later
        // work events append independently to the live stream.
        return this.#work.taskHistory(
          command.task,
          command.historyLimit ?? WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
          decoded,
        );
      }
      const prior = this.#work.taskPosition(command.task);
      const page = this.#work.taskHistory(
        command.task,
        command.historyLimit ?? WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
      );
      const observed = this.#eventCursors.decodeWorkEvent(
        page.observedThroughCursor,
        page.workId,
      ).sequence;
      if (observed !== prior.sequence) this.#workWaiters.notify(page.workId);
      return page;
    }
    const prior = this.#work.taskPosition(command.task);
    const detail = this.#work.task(command.task);
    const current = this.#work.taskPosition(command.task);
    if (current.sequence !== prior.sequence) this.#workWaiters.notify(detail.workId);
    return detail;
  }

  async #readWorkEvents(
    command: Extract<LocalCommand, { kind: "work.events" }>,
    signal: AbortSignal,
  ): Promise<WorkEventPage> {
    const decodedCursor = command.cursor === undefined
      ? undefined
      : this.#eventCursors.decodeWorkEvent(command.cursor, command.work);
    const read = (): WorkEventPage => {
      const priorSequence = this.#workSequence(command.work);
      this.#work.snapshot(command.work);
      this.#notifyWorkIfAdvanced(command.work, priorSequence);
      return this.#normalizeWorkEventPage({
        workId: command.work,
        requestedCursor: command.cursor,
        decodedCursor,
        page: this.#work.events(
          command.work,
          decodedCursor?.sequence ?? 0,
          command.limit,
        ),
        readFromStart: () => this.#work.events(command.work, 0, command.limit),
      });
    };
    let page = read();
    if (page.events.length === 0 && page.gap === null && command.waitMs > 0) {
      const expectedSequence = this.#eventCursors.decodeWorkEvent(
        page.observedThroughCursor,
        command.work,
      ).sequence;
      await this.#workWaiters.wait({
        workId: command.work,
        expectedSequence,
        waitMs: command.waitMs,
        signal,
        readSequence: () => this.#workSequence(command.work),
      });
      page = read();
    }
    return page;
  }

  async #pollWork(
    command: Extract<LocalCommand, { kind: "work.poll" }>,
    signal: AbortSignal,
  ): Promise<WorkPoll> {
    const actionCursor = command.actionCursor;
    if (actionCursor !== undefined && command.waitMs !== 0) {
      throw new CommandFailure(
        "INVALID_INPUT",
        "A work action continuation is a fixed snapshot page and requires waitMs=0.",
      );
    }
    const decodedCursor = command.cursor === undefined
      ? undefined
      : this.#eventCursors.decodeWorkEvent(command.cursor, command.work);
    const decodedActionCursor = actionCursor === undefined
      ? undefined
      : this.#eventCursors.decodeWorkAction(
          actionCursor,
          command.work,
          command.actor ?? null,
        );
    const read = (): WorkPoll => {
      const priorSequence = this.#workSequence(command.work);
      const readPoll = (afterSequence: number): WorkPoll => this.#work.poll(
        command.work,
        command.actor,
        afterSequence,
        command.limit,
        decodedActionCursor,
      );
      let poll = readPoll(decodedCursor?.sequence ?? 0);
      const eventPage = this.#normalizeWorkEventPage({
        workId: command.work,
        requestedCursor: command.cursor,
        decodedCursor,
        page: poll.eventPage,
        readFromStart: () => {
          poll = readPoll(0);
          return poll.eventPage;
        },
      });
      this.#notifyWorkIfAdvanced(command.work, priorSequence);
      return workPollSchema.parse({ ...poll, eventPage });
    };
    let poll = read();
    if (
      poll.eventPage.events.length === 0
      && poll.eventPage.gap === null
      && command.waitMs > 0
      && poll.readyTasks.length === 0
      && poll.ownedAttempts.length === 0
      && poll.recoveryAttempts.length === 0
      && poll.reviewableSubmissions.length === 0
      && poll.signals.length === 0
      && poll.preparedEffects.length === 0
    ) {
      const expectedSequence = this.#eventCursors.decodeWorkEvent(
        poll.eventPage.observedThroughCursor,
        command.work,
      ).sequence;
      const waitMs = poll.nextWakeAt === null
        ? command.waitMs
        : Math.min(command.waitMs, Math.max(0, poll.nextWakeAt - this.#now()));
      if (waitMs > 0) {
        await this.#workWaiters.wait({
          workId: command.work,
          expectedSequence,
          waitMs,
          signal,
          readSequence: () => this.#workSequence(command.work),
        });
      }
      poll = read();
    }
    return poll;
  }

  #assertPreparedEffectBinding(
    effect: WorkPreparedEffect,
    status: NonNullable<ReturnType<WorkStore["effectStatus"]>>,
  ): void {
    const subjectId = effect.kind === "dispatch" ? effect.attemptId : effect.signalId;
    if (
      status.kind !== effect.kind
      || status.subjectId !== subjectId
      || status.targetSessionId !== effect.targetSessionId
      || status.instructionDigest !== digestText(canonicalWorkJson(effect))
    ) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The prepared work effect no longer matches its durable authority binding.",
      );
    }
  }

  #assertPreparedEffectStatusProjection(
    projected: unknown,
    status: NonNullable<ReturnType<WorkStore["effectStatus"]>>,
  ): void {
    if (
      canonicalWorkJson(workPreparedEffectStatusSchema.parse(projected))
      !== canonicalWorkJson(status)
    ) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The public work-effect receipt no longer matches its durable authority binding.",
      );
    }
  }

  async #performPreparedWorkEffect(
    effect: WorkPreparedEffect,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.#store.requireSession(effect.targetSessionId);
    const message = workPreparedEffectMessage(effect);
    return await this.#serializeSessionAuthority(session, async () => {
      const beforeEffect = (): void => {
        const authorization = this.#work.authorizePreparedEffect(idempotencyKey);
        this.#assertPreparedEffectBinding(effect, authorization.status);
        if (!authorization.executable) throw new WorkEffectExecutionSuppressed();
        this.#assertAuthorizedWorkEffect(effect, authorization);
      };
      if (effect.kind === "dispatch") {
        await this.#send(session.id, message, effect.nestedMutationKey, signal, beforeEffect);
        return;
      }
      if (effect.mode === "queue") {
        await this.#queue(session.id, message, effect.nestedMutationKey, beforeEffect);
        return;
      }
      await this.#steer(session.id, message, effect.nestedMutationKey, signal, beforeEffect);
    });
  }

  #assertAuthorizedWorkEffect(
    expected: WorkPreparedEffect,
    authorization: Extract<WorkPreparedEffectAuthorization, { executable: true }>,
  ): void {
    this.#assertPreparedEffectBinding(authorization.effect, authorization.status);
    if (canonicalWorkJson(authorization.effect) !== canonicalWorkJson(expected)) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The persisted work effect does not match the operation projection and was not executed.",
      );
    }
  }

  #projectSettledWorkEffect(
    operation: Extract<WorkOperation, { kind: "attempt.dispatch" | "signal.send" }>,
    effect: WorkPreparedEffect,
  ): WorkOperationResult {
    const status = this.#work.reprojectPreparedEffect(operation.idempotencyKey);
    this.#assertPreparedEffectBinding(effect, status);
    if (status.state === "accepted") {
      const replay = workOperationResultSchema.parse(
        this.#work.apply(operation, operation.idempotencyKey),
      );
      if (replay.kind !== "attempt.dispatch" && replay.kind !== "signal.send") {
        throw new CommandFailure("RECOVERY_REQUIRED", "The settled work effect replay changed operation kind.");
      }
      this.#assertPreparedEffectStatusProjection(replay.effect, status);
      return replay;
    }
    if (status.state === "failed") {
      throw new CommandFailure(
        "CONFLICT",
        "The exact work effect was durably settled without an external effect.",
        { idempotencyKey: operation.idempotencyKey, subjectId: status.subjectId },
      );
    }
    throw new CommandFailure(
      "RECOVERY_REQUIRED",
      status.state === "unknown"
        ? "The exact nested effect has an unknown outcome and will not be replayed."
        : "The exact nested effect has unsettled durable authority and will not be replayed.",
      { idempotencyKey: operation.idempotencyKey, subjectId: status.subjectId },
    );
  }

  async #applyWorkOperation(
    operation: WorkOperation,
    signal: AbortSignal,
  ): Promise<WorkOperationResult> {
    const result = workOperationResultSchema.parse(
      this.#work.apply(operation, operation.idempotencyKey),
    );
    const workId = result.workId;
    this.#workWaiters.notify(workId);
    if (result.kind !== "attempt.dispatch" && result.kind !== "signal.send") return result;
    if (
      (operation.kind !== "attempt.dispatch" && operation.kind !== "signal.send")
      || operation.kind !== result.kind
    ) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The work effect result changed operation kind.");
    }

    const prepared = this.#work.preparedEffect(operation.idempotencyKey);
    if (prepared === null) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The work effect result has no matching durable prepared-effect receipt.",
      );
    }
    const { effect, status } = prepared;
    this.#assertPreparedEffectStatusProjection(result.effect, status);
    this.#assertPreparedEffectBinding(effect, status);
    if (status.state !== "prepared") {
      return this.#projectSettledWorkEffect(operation, effect);
    }

    let executionError: unknown;
    try {
      await this.#performPreparedWorkEffect(effect, operation.idempotencyKey, signal);
    } catch (error: unknown) {
      executionError = error;
    }
    try {
      let projected = this.#work.reprojectPreparedEffect(operation.idempotencyKey);
      this.#assertPreparedEffectBinding(effect, projected);
      if (projected.state === "prepared") {
        projected = this.#work.settlePreparedEffectNoEffect(
          operation.idempotencyKey,
          "nested_preflight_no_effect",
        );
        this.#assertPreparedEffectBinding(effect, projected);
      }
      this.#workWaiters.notify(workId);
    } catch (settlementError: unknown) {
      if (settlementError instanceof StateSecurityScrubRequiredError) throw settlementError;
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The nested work effect could not be projected into its durable work receipt; replay the exact operation document.",
        { idempotencyKey: operation.idempotencyKey, subjectId: status.subjectId },
      );
    }
    if (executionError instanceof StateSecurityScrubRequiredError) throw executionError;
    return this.#projectSettledWorkEffect(operation, effect);
  }

  #publicInteraction(interaction: InteractionRecord): PublicInteraction {
    return publicInteractionSchema.parse({
      version: interaction.version,
      id: interaction.publicId,
      sessionId: interaction.sessionId,
      kind: interaction.kind,
      state: interaction.state,
      revision: interaction.revision,
      blocking: interaction.blocking,
      display: interaction.display,
      responseRecorded: interaction.responseDigest !== null,
      context: {
        turnId: interaction.authority.turnId === null
          ? null
          : this.#eventCursors.projectPublicProviderIdentifier(
              interaction.authority.turnId,
            ),
        itemId: interaction.authority.itemId === null
          ? null
          : this.#eventCursors.projectPublicProviderIdentifier(
              interaction.authority.itemId,
            ),
      },
      requestedAt: interaction.requestedAt,
      deadlineAt: interaction.deadlineAt,
      updatedAt: interaction.updatedAt,
      terminalAt: interaction.terminalAt,
    });
  }

  #appendInteractionState(interaction: InteractionRecord): void {
    if (interaction.sessionId === null) return;
    this.#store.appendSessionEvent({
      sessionId: interaction.sessionId,
      accountId: interaction.authority.profileId,
      providerGeneration: interaction.authority.processGeneration,
      providerConnectionId: interaction.authority.connectionId,
      body: {
        type: "interaction_state",
        interactionId: interaction.publicId,
        state: interaction.state,
        revision: interaction.revision,
      },
    });
    this.#eventWaiters.notify(interaction.sessionId);
  }

  #interactionPersistenceBoundaryError(input: Readonly<{
    cause: unknown;
    effect: "known_unsent" | "possibly_sent";
    focalInteraction: InteractionRecord;
    responseDigest?: string;
  }>): InteractionPersistenceBoundaryError {
    const failures: unknown[] = [input.cause];
    let focalInteraction = input.focalInteraction;
    let quarantineFailed = false;
    try {
      const quarantined = this.#store.quarantineInteractionPersistenceBoundary({
        profileId: input.focalInteraction.authority.profileId,
        processGeneration: input.focalInteraction.authority.processGeneration,
        connectionId: input.focalInteraction.authority.connectionId,
        focalInteractionId: input.focalInteraction.publicId,
        effect: input.effect,
        ...(input.responseDigest === undefined
          ? {}
          : { responseDigest: input.responseDigest }),
      });
      focalInteraction = quarantined.focalInteraction;
      for (const interaction of quarantined.terminalInteractions) {
        if (interaction.sessionId !== null) this.#eventWaiters.notify(interaction.sessionId);
      }
    } catch (error: unknown) {
      quarantineFailed = true;
      failures.push(error);
      this.#state = "closing";
      this.#interactionDeadlineAbort.abort(
        new Error("The interaction persistence quarantine failed."),
      );
      this.#interactionDeadlineWake?.();
      this.#interactionDeadlineWake = undefined;
      try {
        focalInteraction = this.#store.requireInteraction(
          input.focalInteraction.publicId,
        );
      } catch (readError: unknown) {
        failures.push(readError);
      }
    }
    return new InteractionPersistenceBoundaryError(
      focalInteraction,
      quarantineFailed,
      new AggregateError(failures, "Interaction persistence quarantine evidence."),
    );
  }

  #assertResolutionMatches(
    interaction: InteractionRecord,
    resolution: InteractionResolution,
  ): void {
    if (
      interaction.kind === "file_change_approval"
      && resolution.kind === "approval_decision"
      && (resolution.decision === "once" || resolution.decision === "session")
    ) {
      throw new CommandFailure(
        "INVALID_INPUT",
        "File-change approval is disabled because the pinned provider callback does not expose exact affected paths or change detail.",
      );
    }
    const expected = interaction.kind === "user_input"
        ? "user_answers"
        : interaction.kind === "mcp_elicitation"
          ? "mcp_submission"
          : "approval_decision";
    const permissionDecision = interaction.kind === "permission_approval"
      && resolution.kind === "approval_decision"
      && resolution.decision === "decline";
    const permissionGrant = interaction.kind === "permission_approval"
      && resolution.kind === "permission_grant";
    if (!permissionDecision && !permissionGrant && resolution.kind !== expected) {
      throw new CommandFailure(
        "INVALID_INPUT",
        interaction.kind === "permission_approval"
          ? "A permission approval requires an exact permission grant or decline resolution."
          : `A ${interaction.kind} interaction requires a ${expected} resolution.`,
      );
    }
    if (
      interaction.kind === "permission_approval"
      && resolution.kind === "approval_decision"
      && !permissionDecision
    ) {
      throw new CommandFailure(
        "INVALID_INPUT",
        "Permission approvals can be declined, but cancel, once, and session decisions are not represented by this provider callback.",
      );
    }
    if (
      resolution.kind === "approval_decision"
      && (interaction.display.kind === "command_approval"
        || interaction.display.kind === "file_change_approval")
      && !interaction.display.availableDecisions.includes(resolution.decision)
    ) {
      throw new CommandFailure("INVALID_INPUT", "This provider request does not offer that decision.");
    }
    if (
      resolution.kind === "permission_grant"
      && interaction.display.kind === "permission_approval"
    ) {
      const requested = new Set(interaction.display.requested.map((permission) => permission.name));
      if (resolution.permissions.some((name) => !requested.has(name))) {
        throw new CommandFailure("INVALID_INPUT", "Granted permissions must be a subset of the request.");
      }
      if (resolution.scope === "session" && !interaction.display.allowsSessionScope) {
        throw new CommandFailure("INVALID_INPUT", "This provider request does not allow session permission scope.");
      }
    }
    if (resolution.kind === "user_answers" && interaction.display.kind === "user_input") {
      const questions = new Set(interaction.display.questions.map((question) => question.id));
      const answers = Object.keys(resolution.answers);
      if (answers.length !== questions.size || answers.some((id) => !questions.has(id))) {
        throw new CommandFailure("INVALID_INPUT", "User answers must match the provider's exact question IDs.");
      }
    }
    if (resolution.kind === "mcp_submission" && interaction.display.kind === "mcp_elicitation") {
      if (interaction.display.mode !== "form" || interaction.display.fields === undefined) {
        throw new CommandFailure("INVALID_INPUT", "This MCP form cannot be safely completed through HRA.");
      }
      if (resolution.action !== "accept") {
        if (resolution.content !== undefined) {
          throw new CommandFailure("INVALID_INPUT", "Declined or canceled MCP forms cannot include content.");
        }
        return;
      }
      try {
        validateMcpFormSubmission(interaction.display.fields, resolution.content ?? {});
      } catch {
        throw new CommandFailure(
          "INVALID_INPUT",
          "Protected MCP form content does not match the requested field contract.",
        );
      }
    }
  }

  #intendedInteractionTerminalState(
    resolution: InteractionResolution,
  ): InteractionIntendedTerminalState {
    if (resolution.kind === "approval_decision") {
      if (resolution.decision === "decline") return "declined";
      if (resolution.decision === "cancel") return "canceled";
      return "resolved";
    }
    if (resolution.kind === "mcp_submission") {
      if (resolution.action === "decline") return "declined";
      if (resolution.action === "cancel") return "canceled";
    }
    return "resolved";
  }

  async #inspectInteraction(
    command: Extract<LocalCommand, { kind: "interaction.inspect" }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return await this.#serialize(`interaction:${command.interaction}`, async () => {
      const current = this.#store.requireInteraction(command.interaction);
      if (
        current.revision !== command.expectedRevision
        || current.state !== "pending"
        || this.#now() >= current.deadlineAt
      ) {
        throw new CommandFailure(
          "CONFLICT",
          "The interaction revision, state, or deadline changed before protected inspection.",
        );
      }
      if (current.kind !== "command_approval" && current.kind !== "permission_approval") {
        throw new CommandFailure(
          "INVALID_INPUT",
          "This interaction has no complete approval authority available for protected inspection.",
        );
      }
      const profile = this.#store.requireProfileById(current.authority.profileId);
      let authority: Awaited<ReturnType<CodexRuntimePort["inspectInteractionAuthority"]>>;
      try {
        await this.#daemonAuthority.assertCurrent();
        authority = await this.#codex.inspectInteractionAuthority({
          authority: authorityFor(this.#paths, profile),
          provider: current.authority,
          kind: current.kind,
          signal,
        });
        await this.#daemonAuthority.assertCurrent();
      } catch (error: unknown) {
        if (error instanceof CodexError && error.code === "UNSUPPORTED_CAPABILITY") {
          throw new CommandFailure("INVALID_INPUT", error.message);
        }
        throw new CommandFailure(
          "CONFLICT",
          "The interaction's exact live provider authority is no longer available.",
        );
      }
      const observed = this.#store.requireInteraction(current.publicId);
      if (
        observed.revision !== current.revision
        || observed.state !== "pending"
        || observed.kind !== current.kind
        || observed.sessionId !== current.sessionId
        || observed.authority.profileId !== current.authority.profileId
        || observed.authority.processGeneration !== current.authority.processGeneration
        || observed.authority.connectionId !== current.authority.connectionId
        || observed.authority.requestDigest !== current.authority.requestDigest
        || observed.authority.requestId.type !== current.authority.requestId.type
        || observed.authority.requestId.value !== current.authority.requestId.value
        || this.#now() >= observed.deadlineAt
      ) {
        throw new CommandFailure(
          "CONFLICT",
          "The interaction authority changed during protected inspection.",
        );
      }
      const document = protectedInteractionDetailDocumentSchema.parse({
        type: "hra_protected_interaction_detail",
        version: 1,
        binding: {
          interactionId: observed.publicId,
          revision: observed.revision,
          kind: observed.kind,
          sessionId: observed.sessionId,
          profileId: observed.authority.profileId,
          processGeneration: observed.authority.processGeneration,
          connectionId: observed.authority.connectionId,
        },
        authority,
      });
      const encoded = encodeProtectedInteractionDetailDocument(document);
      const fits = encoded.byteLength <= PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES;
      encoded.fill(0);
      if (!fits) {
        throw new CommandFailure(
          "INVALID_INPUT",
          "The complete approval authority exceeds HRA's protected-output limit.",
        );
      }
      return document;
    });
  }

  async #resolveInteraction(
    command: Extract<LocalCommand, { kind: "interaction.resolve" }>,
    context: { signal: AbortSignal; afterResponse?: (callback: () => void) => void },
  ): Promise<unknown> {
    const signal = context.signal;
    return await this.#serialize(`interaction:${command.interaction}`, async () => {
      const current = this.#store.requireInteraction(command.interaction);
      if (current.revision !== command.expectedRevision || current.state !== "pending") {
        throw new CommandFailure(
          "CONFLICT",
          "The interaction revision or state changed before resolution.",
          { interaction: this.#publicInteraction(current) },
        );
      }
      if (this.#now() >= current.deadlineAt) {
        await this.#rejectManualResolutionAtDeadline(current);
      }
      this.#assertResolutionMatches(current, command.resolution);
      const profile = this.#store.requireProfileById(current.authority.profileId);
      let responseDigest: string;
      try {
        await this.#daemonAuthority.assertCurrent();
        const validated = await this.#codex.validateInteractionResolution({
          authority: authorityFor(this.#paths, profile),
          provider: current.authority,
          kind: current.kind,
          resolution: command.resolution,
          signal,
        });
        responseDigest = validated.responseDigest;
      } catch (error: unknown) {
        if (this.#now() >= current.deadlineAt) {
          await this.#rejectManualResolutionAtDeadline(current);
        }
        if (error instanceof CodexError && error.code === "INVALID_INPUT") {
          throw new CommandFailure("INVALID_INPUT", error.message);
        }
        const terminal = error instanceof CodexError && error.code === "INDETERMINATE_EFFECT"
          ? this.#store.markInteractionResolutionUnknown({
              id: current.publicId,
              expectedRevision: current.revision,
            })
          : this.#store.expireInteraction({
              id: current.publicId,
              expectedRevision: current.revision,
            });
        this.#appendInteractionState(terminal);
        if (error instanceof CodexError && error.code === "INDETERMINATE_EFFECT") {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The interaction response may already have reached Codex; its resolution is unknown.",
            { interaction: this.#publicInteraction(terminal) },
          );
        }
        throw new CommandFailure(
          "CONFLICT",
          "The interaction's exact provider connection is no longer available.",
          { interaction: this.#publicInteraction(terminal) },
        );
      }
      if (this.#now() >= current.deadlineAt) {
        await this.#rejectManualResolutionAtDeadline(current);
      }
      let prepared: InteractionRecord;
      try {
        prepared = this.#store.prepareInteractionResponse({
          id: current.publicId,
          expectedRevision: current.revision,
          responseDigest,
          intendedTerminalState: this.#intendedInteractionTerminalState(command.resolution),
        });
        this.#appendInteractionState(prepared);
      } catch (error: unknown) {
        throw this.#interactionPersistenceBoundaryError({
          cause: error,
          effect: "known_unsent",
          focalInteraction: current,
        });
      }
      if (this.#now() >= prepared.deadlineAt) {
        await this.#rejectPreparedManualResolutionAtDeadline(prepared);
      }
      try {
        await this.#daemonAuthority.assertCurrent();
        if (this.#now() >= prepared.deadlineAt) {
          await this.#rejectPreparedManualResolutionAtDeadline(prepared);
        }
        await this.#codex.resolveInteraction({
          authority: authorityFor(this.#paths, profile),
          provider: prepared.authority,
          kind: prepared.kind,
          resolution: command.resolution,
          deadlineAt: prepared.deadlineAt,
          signal,
        });
      } catch (error: unknown) {
        if (error instanceof CommandFailure) throw error;
        if (error instanceof CodexError && error.code === "DEADLINE_EXPIRED") {
          await this.#rejectPreparedManualResolutionAtDeadline(prepared);
        }
        const terminal = error instanceof CodexError && error.code === "INDETERMINATE_EFFECT"
          ? this.#store.markInteractionResolutionUnknown({
              id: prepared.publicId,
              expectedRevision: prepared.revision,
              responseDigest,
            })
          : this.#store.expireInteraction({
              id: prepared.publicId,
              expectedRevision: prepared.revision,
            });
        this.#appendInteractionState(terminal);
        if (error instanceof CodexError && error.code === "INDETERMINATE_EFFECT") {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The interaction response may have reached Codex; its resolution is unknown.",
            { interaction: this.#publicInteraction(terminal) },
          );
        }
        if (error instanceof CodexError && error.code === "INVALID_INPUT") {
          throw new CommandFailure("INVALID_INPUT", error.message);
        }
        throw new CommandFailure(
          "CONFLICT",
          "The interaction's exact provider connection is no longer available.",
          { interaction: this.#publicInteraction(terminal) },
        );
      }
      let written: InteractionRecord;
      try {
        written = this.#store.markInteractionResponseWritten({
          id: prepared.publicId,
          expectedRevision: prepared.revision,
          responseDigest,
        });
        if (written.state === "response_written") this.#appendInteractionState(written);
      } catch (error: unknown) {
        throw this.#interactionPersistenceBoundaryError({
          cause: error,
          effect: "possibly_sent",
          focalInteraction: prepared,
          responseDigest,
        });
      }
      return { interaction: this.#publicInteraction(written), responseWritten: true };
    });
  }

  async #rejectManualResolutionAtDeadline(current: InteractionRecord): Promise<never> {
    await this.#expireInteractionAtDeadline(
      current,
      this.#interactionDeadlineAbort.signal,
    );
    const terminal = this.#store.requireInteraction(current.publicId);
    throw new CommandFailure(
      "CONFLICT",
      "The interaction deadline elapsed before the manual resolution could be dispatched.",
      { interaction: this.#publicInteraction(terminal) },
    );
  }

  async #rejectPreparedManualResolutionAtDeadline(
    prepared: InteractionRecord,
  ): Promise<never> {
    if (
      prepared.state !== "response_prepared"
      || prepared.responseDigest === null
      || prepared.intendedTerminalState === null
      || prepared.intendedTerminalState === "expired"
    ) throw new Error("INTERACTION_MANUAL_RESPONSE_NOT_PREPARED");
    const profile = this.#store.requireProfileById(prepared.authority.profileId);
    const signal = this.#interactionDeadlineAbort.signal;
    let timeoutResponseDigest: string;
    try {
      await this.#daemonAuthority.assertCurrent();
      const validated = await this.#codex.validateInteractionTimeout({
        authority: authorityFor(this.#paths, profile),
        provider: prepared.authority,
        signal,
      });
      timeoutResponseDigest = validated.responseDigest;
    } catch (error: unknown) {
      const latest = this.#store.requireInteraction(prepared.publicId);
      const terminal = latest.state === "response_prepared"
        && latest.revision === prepared.revision
        && latest.responseDigest === prepared.responseDigest
        ? this.#store.markInteractionResolutionUnknown({
            id: latest.publicId,
            expectedRevision: latest.revision,
            responseDigest: prepared.responseDigest,
          })
        : latest;
      if (terminal !== latest) this.#appendInteractionState(terminal);
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        error instanceof CodexError && error.code === "INDETERMINATE_EFFECT"
          ? "The interaction response may already have reached Codex; its resolution is unknown."
          : "The expired interaction could not be closed on its exact provider connection.",
        { interaction: this.#publicInteraction(terminal) },
      );
    }

    let timeoutPrepared: InteractionRecord;
    try {
      timeoutPrepared = this.#store.supersedePreparedInteractionResponseWithTimeout({
        id: prepared.publicId,
        expectedRevision: prepared.revision,
        manualResponseDigest: prepared.responseDigest,
        timeoutResponseDigest,
      });
      this.#appendInteractionState(timeoutPrepared);
    } catch (error: unknown) {
      throw this.#interactionPersistenceBoundaryError({
        cause: error,
        effect: "known_unsent",
        focalInteraction: prepared,
      });
    }
    try {
      await this.#daemonAuthority.assertCurrent();
      await this.#codex.timeoutInteraction({
        authority: authorityFor(this.#paths, profile),
        provider: timeoutPrepared.authority,
        signal,
      });
    } catch (error: unknown) {
      const latest = this.#store.requireInteraction(timeoutPrepared.publicId);
      const terminal = latest.state === "response_prepared"
        && latest.revision === timeoutPrepared.revision
        && latest.responseDigest === timeoutResponseDigest
        ? error instanceof CodexError && error.code === "INDETERMINATE_EFFECT"
          ? this.#store.markInteractionResolutionUnknown({
              id: latest.publicId,
              expectedRevision: latest.revision,
              responseDigest: timeoutResponseDigest,
            })
          : this.#store.expireInteraction({
              id: latest.publicId,
              expectedRevision: latest.revision,
            })
        : latest;
      if (terminal !== latest) this.#appendInteractionState(terminal);
      throw new CommandFailure(
        error instanceof CodexError && error.code === "INDETERMINATE_EFFECT"
          ? "RECOVERY_REQUIRED"
          : "CONFLICT",
        error instanceof CodexError && error.code === "INDETERMINATE_EFFECT"
          ? "The provider timeout response may have reached Codex; its resolution is unknown."
          : "The expired interaction could not be closed on its exact provider connection.",
        { interaction: this.#publicInteraction(terminal) },
      );
    }
    let terminal: InteractionRecord;
    try {
      const written = this.#store.markInteractionResponseWritten({
        id: timeoutPrepared.publicId,
        expectedRevision: timeoutPrepared.revision,
        responseDigest: timeoutResponseDigest,
      });
      if (written.state === "response_written") this.#appendInteractionState(written);
      terminal = written.state === "response_written"
        ? this.#store.settleInteraction({
            id: written.publicId,
            expectedRevision: written.revision,
            state: "expired",
            authority: written.authority,
            responseDigest: timeoutResponseDigest,
          })
        : written;
      if (terminal !== written) this.#appendInteractionState(terminal);
    } catch (error: unknown) {
      throw this.#interactionPersistenceBoundaryError({
        cause: error,
        effect: "possibly_sent",
        focalInteraction: timeoutPrepared,
        responseDigest: timeoutResponseDigest,
      });
    }
    throw new CommandFailure(
      "CONFLICT",
      "The interaction deadline elapsed before the manual resolution could be dispatched.",
      { interaction: this.#publicInteraction(terminal) },
    );
  }

  async #listSessions(
    account: string | undefined,
    limit: number,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (account === undefined) {
      if (cursor !== undefined) {
        throw new CommandFailure(
          "INVALID_INPUT",
          "A session-list cursor requires the same --account filter that created it.",
        );
      }
      return {
        accountId: null,
        sessions: this.#store.listSessions(limit),
        nextCursor: null,
      };
    }
    const profile = this.#store.requireProfile(account);
    if (profile.state === "signed_out") {
      const cursorFilter = {
        accountId: profile.id,
        accountGeneration: profile.processGeneration,
        limit,
      } as const;
      const decodedCursor = cursor === undefined
        ? undefined
        : this.#eventCursors.decodeLocalSessionList(cursor, cursorFilter);
      const page = this.#store.listLocalSessionPage({
        profileId: profile.id,
        after: decodedCursor === undefined
          ? null
          : {
              createdAt: decodedCursor.afterCreatedAt,
              sessionId: decodedCursor.afterSessionId,
            },
        limit,
      });
      const nextCursor = page.nextPosition === null
        ? null
        : this.#eventCursors.encodeLocalSessionList({
            ...cursorFilter,
            afterCreatedAt: page.nextPosition.createdAt,
            afterSessionId: page.nextPosition.sessionId,
          });
      return {
        accountId: profile.id,
        sessions: page.sessions,
        nextCursor,
        listing: signedOutSessionListMetadataSchema.parse({
          accountSelector: profile.id,
          accountState: "signed_out",
          scope: "local_only",
          freshness: "stale",
          localCompleteness: nextCursor === null ? "complete" : "partial",
          providerAccess: "not_attempted",
          providerCompleteness: "unknown",
          nextCommand: `hra account login ${profile.id}`,
        }),
      };
    }
    this.#assertSignedIn(profile);
    const cursorFilter = {
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      limit,
    } as const;
    const decodedCursor = cursor === undefined
      ? undefined
      : this.#eventCursors.decodeSessionList(cursor, cursorFilter);
    if (await this.#cloud.isCompactProjectionRecoveryUnsettledForProfile(profile.id)) {
      await this.#daemonAuthority.assertCurrent();
      if (decodedCursor !== undefined) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "Provider session-list continuation is paused while compact-projection recovery preserves exact local authority.",
        );
      }
      return {
        accountId: profile.id,
        sessions: this.#store.listSessions(limit, profile.id),
        nextCursor: null,
        recovery: {
          diagnostic: "Provider reconciliation is paused while compact-projection recovery preserves exact local authority.",
          required: true,
        },
      };
    }
    const remote = await this.#fencedEffect(async () => await this.#codex.listSessions({
      authority: authorityFor(this.#paths, profile),
      limit,
      ...(decodedCursor === undefined ? {} : { cursor: decodedCursor.providerCursor }),
      signal,
    }));
    let nextCursor: string | null = null;
    if (remote.nextCursor !== null) {
      try {
        nextCursor = this.#eventCursors.advanceSessionList({
          ...cursorFilter,
          providerCursor: remote.nextCursor,
          ...(decodedCursor === undefined ? {} : { prior: decodedCursor }),
        });
      } catch (error: unknown) {
        if (error instanceof SessionEventCursorError) {
          throw new CommandFailure(
            "UNAVAILABLE",
            "Codex returned an unsafe or nonadvancing session-list continuation.",
          );
        }
        throw error;
      }
    }
    const projects = this.#store.listProjects();
    const sessions: SessionRecord[] = [];
    for (const projection of remote.sessions) {
      const projectId = projection.projectRoot === undefined ? undefined : projects.find((project) => project.rootPath === projection.projectRoot)?.id;
      const session = this.#store.upsertProviderSession({
        profileId: profile.id,
        providerThreadId: projection.providerThreadId,
        ...(projectId === undefined ? {} : { projectId }),
        title: projection.title,
        state: projection.status,
        ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
        ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
      });
      sessions.push(session);
      if (session.state === "terminal") await this.#cleanupTerminalFactsMemory(session);
    }
    return { accountId: profile.id, sessions, nextCursor };
  }

  async #showSession(selector: string, detail: boolean, signal: AbortSignal): Promise<unknown> {
    const session = this.#store.requireSession(selector);
    if (session.providerThreadId === undefined) return { session, effectiveRuntimeProfile: this.#store.latestSessionRuntimeProfile(session.id)?.profile ?? null };
    const providerThreadId = session.providerThreadId;
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    if (session.state !== "terminal" && session.state !== "recovery_required") {
      this.#requireLiveProviderObservation(
        await this.#ensureSessionObservedLocked(session.id, signal),
      );
    }
    const projectionRecoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettled(session.id);
    await this.#daemonAuthority.assertCurrent();
    const projection = await this.#fencedEffect(async () => await this.#codex.readSession({ authority: authorityFor(this.#paths, profile), providerThreadId, detail, signal }));
    if (projectionRecoveryUnsettled || this.#projectionRecoveriesInFlight.has(session.id)) {
      const runtimeProfile = this.#store.latestSessionRuntimeProfile(session.id)?.profile ?? null;
      const coherentSession = this.#store.requireSession(session.id);
      return {
        session: coherentSession,
        ...(projection.providerThreadId === providerThreadId ? { projection } : {}),
        effectiveRuntimeProfile: runtimeProfile,
        recovery: {
          cleared: false,
          diagnostic: projection.providerThreadId === providerThreadId
            ? "Compact-projection recovery preserves this session's exact local authority; provider state was read without changing local custody."
            : "Codex returned a different provider thread while compact-projection recovery preserves this session; local custody was left unchanged.",
          required: true,
        },
      };
    }
    if (projection.providerThreadId !== providerThreadId) {
      this.#quarantineSession(session.id);
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex returned a projection for a different provider thread; the session remains quarantined.");
    }
    const coherentSession = this.#store.requireSession(session.id);
    const runtimeProfile = this.#store.latestSessionRuntimeProfile(session.id)?.profile ?? null;
    return coherentSession.state === "recovery_required"
      ? { session: coherentSession, projection, effectiveRuntimeProfile: runtimeProfile, recovery: { required: true, cleared: false } }
      : { session: coherentSession, projection, effectiveRuntimeProfile: runtimeProfile };
  }

  async #startSession(command: Extract<LocalCommand, { kind: "session.start" }>, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(command.account);
    this.#assertSignedIn(profile);
    const project = command.project === undefined ? this.#store.listProjects().find((candidate) => candidate.default) : this.#store.requireProject(command.project);
    if (project === undefined) throw new CommandFailure("INTERACTION_REQUIRED", "Add or select a project directory before starting a session.");
    await this.#requireUsableProjectRoot(project.rootPath);
    const key = command.idempotencyKey ?? randomUUID();
    let localSessionId: SessionRecord["id"] | undefined;
    let clientMessageId: string | undefined;
    let review: RuntimeStartReview | undefined;
    let startedProjection: (CodexSessionProjection & { effectiveRuntimeProfile: z.infer<typeof effectiveRuntimeProfileSchema> }) | undefined;
    const outcome = await this.#effect<z.infer<typeof sessionStartReceiptSchema>>({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { projectId: project.id, preset: command.preset, fast: command.fast },
      idempotencyKey: key,
      beginEffect: async (attemptId) => {
        clientMessageId = attemptId;
        review = await this.#fencedEffect(async () => {
          const projectRoot = await this.#requireUsableProjectRoot(project.rootPath);
          return await this.#codex.reviewSessionStart({
            authority: authorityFor(this.#paths, profile),
            projectRoot,
            preset: command.preset,
            fast: command.fast,
            signal,
          });
        });
        const local = this.#store.beginSessionStartEffect({
          attemptId,
          profileId: profile.id,
          profileGeneration: profile.processGeneration,
          projectId: project.id,
          preset: command.preset,
          fastEnabled: command.fast,
          evidence: {
            kind: "session.start",
            projectId: project.id,
            clientMessageId: null,
            messageDigest: null,
            runtimeProfile: review.effectiveRuntimeProfile,
          },
        });
        localSessionId = local.id;
      },
      effect: async () => {
        if (localSessionId === undefined || clientMessageId === undefined || review === undefined) throw new Error("Session start effect lost its durable placeholder or runtime-review binding.");
        const runtimeReview = review;
        const local = this.#store.requireSession(localSessionId);
        try {
          startedProjection = await this.#fencedEffect(async () => {
            const projectRoot = await this.#requireUsableProjectRoot(project.rootPath);
            return await this.#codex.startSession({
              authority: authorityFor(this.#paths, profile),
              projectRoot,
              review: runtimeReview,
              signal,
            });
          });
        } catch (error: unknown) {
          await this.#daemonAuthority.assertCurrent();
          if (error instanceof IndeterminateCodexEffectError) {
            this.#quarantineSession(local.id);
            throw error;
          }
          if (!this.#store.deleteUnboundStartingSession(local.id, local.revision)) {
            this.#quarantineSession(local.id);
            throw new IndeterminateLocalCommitError("Codex rejected session creation, but its unused local placeholder could not be removed.", error);
          }
          throw error;
        }
        return { sessionId: local.id, sourceId: clientMessageId, effectiveRuntimeProfile: startedProjection.effectiveRuntimeProfile };
      },
      receipt: (value) => sessionStartReceiptSchema.parse(value),
      restore: (value) => sessionStartReceiptSchema.parse(value),
      commit: (attemptId, _value, receipt) => {
        if (localSessionId === undefined || startedProjection === undefined) throw new Error("Session start commit lost its exact provider projection.");
        const local = this.#store.requireSession(localSessionId);
        this.#store.completeSessionStartEffect({
          attemptId,
          sessionId: local.id,
          expectedSessionRevision: local.revision,
          providerThreadId: startedProjection.providerThreadId,
          state: startedProjection.status,
          ...(startedProjection.activeTurnId === undefined ? {} : { activeTurnId: startedProjection.activeTurnId }),
          ...(startedProjection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: startedProjection.providerUpdatedAt }),
          runtimeProfile: startedProjection.effectiveRuntimeProfile,
          receipt,
        });
      },
      onAmbiguous: () => {
        if (localSessionId !== undefined) this.#quarantineSession(localSessionId);
      },
    });
    try {
      await this.#ensureFactsMemory(this.#store.requireSession(outcome.sessionId));
    } catch (error: unknown) {
      if (error instanceof CommandFailure) {
        throw new CommandFailure(error.code, error.message, {
          idempotencyKey: key,
          nextCommand: `hra session show ${outcome.sessionId}`,
          sessionId: outcome.sessionId,
        });
      }
      throw error;
    }
    await this.#ensureSessionObservedLocked(outcome.sessionId, signal);
    return {
      session: this.#store.requireSession(outcome.sessionId),
      effectiveRuntimeProfile: outcome.effectiveRuntimeProfile
        ?? this.#store.latestSessionRuntimeProfile(outcome.sessionId)?.profile
        ?? null,
      idempotencyKey: key,
    };
  }

  async #send(
    selector: string,
    message: string,
    idempotencyKey: string | undefined,
    signal: AbortSignal,
    beforeEffect?: (attemptId: MutationAttemptRecord["id"]) => void,
  ): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const project = session.projectId === undefined ? undefined : this.#store.requireProject(session.projectId);
    if (project !== undefined) await this.#requireUsableProjectRoot(project.rootPath);
    this.#requireLiveProviderObservation(
      await this.#ensureSessionObservedLocked(session.id, signal),
    );
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    let review: RuntimeStartReview | undefined;
    let dispatchSessionRevision: number | undefined;
    let dispatchFactEpoch: number | undefined;
    let startedResult: { turnId: string; status: "completed" | "interrupted" | "failed" | "inProgress"; effectiveRuntimeProfile: z.infer<typeof effectiveRuntimeProfileSchema> } | undefined;
    const result = await this.#effect<z.infer<typeof turnStartReceiptSchema>>({ kind: "session.send", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { message }, idempotencyKey: key, effect: async (attemptId) => {
      if (baseline === undefined || review === undefined) throw new Error("Session send lost its exact pre-effect provider baseline or runtime review.");
      const runtimeReview = review;
      if (baseline.status === "active" || baseline.activeTurnId !== undefined) throw new CommandFailure("CONFLICT", "The session already has an active turn. Use `session steer` or `session queue`.");
      startedResult = await this.#fencedEffect(async () => {
        const projectRoot = project === undefined
          ? undefined
          : await this.#requireUsableProjectRoot(project.rootPath);
        return await this.#codex.startTurn({
          authority: authorityFor(this.#paths, profile),
          providerThreadId: session.providerThreadId,
          ...(projectRoot === undefined ? {} : { projectRoot }),
          review: runtimeReview,
          message,
          clientMessageId: attemptId,
          signal,
        });
      });
      return { ...startedResult, sourceId: attemptId };
    }, beginEffect: async (attemptId) => {
      baseline = await this.#readExactSessionProjection(session, profile, false, signal);
      if (baseline.status === "active" || baseline.activeTurnId !== undefined) throw new CommandFailure("CONFLICT", "The session already has an active turn. Use `session steer` or `session queue`.");
      review = await this.#fencedEffect(async () => {
        const projectRoot = project === undefined
          ? undefined
          : await this.#requireUsableProjectRoot(project.rootPath);
        return await this.#codex.reviewTurnStart({
          authority: authorityFor(this.#paths, profile),
          providerThreadId: session.providerThreadId,
          ...(projectRoot === undefined ? {} : { projectRoot }),
          preset: session.preset,
          fast: session.fastEnabled,
          signal,
        });
      });
      // Work authorization and nested begin are one synchronous fence boundary.
      beforeEffect?.(attemptId);
      this.#store.beginSessionMutationEffect({
        attemptId,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "session.send",
          providerThreadId: session.providerThreadId,
          baseline: this.#providerBaseline(baseline),
          clientMessageId: attemptId,
          messageDigest: digestText(message),
          runtimeProfile: review.effectiveRuntimeProfile,
        },
      });
      dispatchSessionRevision = this.#store.requireSession(session.id).revision;
      dispatchFactEpoch = this.#sessionFactEpochs.get(session.id) ?? 0;
    }, receipt: (value) => turnStartReceiptSchema.parse(value), restore: (value) => turnStartReceiptSchema.parse(value), commit: (attemptId, _value, receipt) => {
      if (startedResult === undefined || dispatchSessionRevision === undefined || dispatchFactEpoch === undefined) throw new Error("Session turn commit lost its exact provider result, local revision, or fact epoch.");
      this.#store.completeSessionTurnEffect({
        attemptId,
        sessionId: session.id,
        expectedSessionRevision: dispatchSessionRevision,
        applyResponseState: (this.#sessionFactEpochs.get(session.id) ?? 0) === dispatchFactEpoch,
        turnId: startedResult.turnId,
        turnStatus: startedResult.status,
        runtimeProfile: startedResult.effectiveRuntimeProfile,
        receipt,
      });
    }, onAmbiguous: () => this.#quarantineSession(session.id) });
    const reconciled = this.#store.requireSession(session.id);
    if (reconciled.state === "idle") this.#scheduleQueueDispatch(reconciled);
    return { session: reconciled, turnId: result.turnId, effectiveRuntimeProfile: result.effectiveRuntimeProfile ?? null, idempotencyKey: key };
  }

  async #steer(
    selector: string,
    message: string,
    idempotencyKey: string | undefined,
    signal: AbortSignal,
    beforeEffect?: (attemptId: MutationAttemptRecord["id"]) => void,
  ): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    this.#requireLiveProviderObservation(
      await this.#ensureSessionObservedLocked(session.id, signal),
    );
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    let activeTurnId: string | undefined;
    const result = await this.#effect({ kind: "session.steer", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { message }, idempotencyKey: key, effect: async (attemptId) => {
      if (activeTurnId === undefined) throw new CommandFailure("CONFLICT", "The session has no active turn to steer.");
      const turnId = activeTurnId;
      await this.#fencedEffect(async () => await this.#codex.steer({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, activeTurnId: turnId, message, clientMessageId: attemptId, signal }));
      return { steered: true as const, activeTurnId: turnId };
    }, beginEffect: async (attemptId) => {
      baseline = await this.#readExactSessionProjection(session, profile, false, signal);
      activeTurnId = baseline.activeTurnId;
      // Work authorization and nested begin are one synchronous fence boundary.
      beforeEffect?.(attemptId);
      this.#store.beginSessionMutationEffect({
        attemptId,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "session.steer",
          providerThreadId: session.providerThreadId,
          baseline: this.#providerBaseline(baseline),
          activeTurnId: activeTurnId ?? null,
          clientMessageId: attemptId,
          messageDigest: digestText(message),
        },
      });
    }, receipt: (value) => steeredReceiptSchema.parse(value), restore: (value) => steeredReceiptSchema.parse(value), onAmbiguous: () => this.#quarantineSession(session.id) });
    return { steered: true, turnId: result.activeTurnId, idempotencyKey: key };
  }

  async #queue(
    selector: string,
    message: string,
    idempotencyKey: string | undefined,
    beforeEffect?: () => void,
  ): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const key = idempotencyKey ?? randomUUID();
    // Work authorization and durable enqueue are one synchronous fence boundary.
    beforeEffect?.();
    const queued = this.#store.enqueueIdempotent({ sessionId: session.id, profileGeneration: profile.processGeneration, message, idempotencyKey: key });
    const observed = this.#store.requireSession(session.id);
    if (queued.state === "pending" && observed.state === "idle") {
      this.#scheduleQueueDispatch(observed);
    }
    return { queued, idempotencyKey: key };
  }

  #scheduleQueueDispatch(session: SessionRecord): void {
    if (this.#state !== "open") return;
    const profile = this.#store.requireProfile(session.profileId);
    const task = this.#serializeSessionAuthority(session, async () => this.#dispatchNextQueue(session.id, authorityFor(this.#paths, profile)));
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #scheduleRecoverySessionObservations(sessions: readonly SessionRecord[]): void {
    if (this.#state !== "open" || sessions.length === 0) return;
    const task = (async () => {
      for (const session of sessions) {
        if (this.#state !== "open") return;
        await this.#serializeSessionAuthority(
          session,
          async () => {
            await this.#ensureSessionObservedLocked(
              session.id,
              new AbortController().signal,
            );
          },
          { allowDuringProjectionRecovery: true },
        ).catch(() => undefined);
      }
    })();
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #scheduleIdleQueue(session: SessionRecord): void {
    if (session.state === "idle") this.#scheduleQueueDispatch(session);
  }

  #resetQueuePreEffectRetries(sessionId: SessionRecord["id"]): void {
    for (const queued of this.#store.listQueue(sessionId)) {
      this.#queuePreEffectRetryCounts.delete(queued.id);
    }
  }

  #scheduleQueuePreEffectRetry(session: SessionRecord, queueId: string): void {
    if (this.#state !== "open" || this.#queuePreEffectRetryScheduled.has(queueId)) return;
    const retryCount = this.#queuePreEffectRetryCounts.get(queueId) ?? 0;
    const delayMs = QUEUE_PRE_EFFECT_RETRY_DELAYS_MS[retryCount];
    if (delayMs === undefined) return;
    this.#queuePreEffectRetryCounts.set(queueId, retryCount + 1);
    this.#queuePreEffectRetryScheduled.add(queueId);
    const task = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      this.#queuePreEffectRetryScheduled.delete(queueId);
      if (this.#state !== "open") return;
      const queued = this.#store.requireQueue(queueId);
      const current = this.#store.requireSession(session.id);
      if (queued.state !== "pending" || current.state !== "idle") {
        if (queued.state !== "pending") this.#queuePreEffectRetryCounts.delete(queueId);
        return;
      }
      const profile = this.#store.requireProfile(current.profileId);
      if (profile.state !== "signed_in") return;
      await this.#serializeSessionAuthority(current, async () => this.#dispatchNextQueue(current.id, authorityFor(this.#paths, profile)));
      if (this.#store.requireQueue(queueId).state !== "pending") this.#queuePreEffectRetryCounts.delete(queueId);
    })();
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #isRetryableQueuePreEffectError(error: unknown): boolean {
    return !(error instanceof CommandFailure
      || error instanceof DaemonAuthoritySafetyError
      || error instanceof IndeterminateCodexEffectError
      || error instanceof IndeterminateLocalCommitError);
  }

  async #stop(selector: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    this.#requireLiveProviderObservation(
      await this.#ensureSessionObservedLocked(session.id, signal),
    );
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    let activeTurnId: string | null = null;
    const result = await this.#effect({ kind: "session.stop", authorityId: session.id, authorityGeneration: profile.processGeneration, request: {}, idempotencyKey: key, effect: async () => {
      if (activeTurnId === null) return { stopped: false as const, activeTurnId: null };
      const turnId = activeTurnId;
      await this.#fencedEffect(async () => await this.#codex.interrupt({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, activeTurnId: turnId, signal }));
      return { stopped: true as const, activeTurnId: turnId };
    }, beginEffect: async (attemptId) => {
      baseline = await this.#readExactSessionProjection(session, profile, false, signal);
      activeTurnId = baseline.activeTurnId ?? null;
      this.#store.beginSessionMutationEffect({
        attemptId,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "session.stop",
          providerThreadId: session.providerThreadId,
          baseline: this.#providerBaseline(baseline),
          activeTurnId,
        },
      });
    }, receipt: (value) => stoppedReceiptSchema.parse(value), restore: (value) => stoppedReceiptSchema.parse(value), onAmbiguous: () => this.#quarantineSession(session.id) });
    if (!result.stopped) return { stopped: false, reason: "idle", idempotencyKey: key };
    try {
      const observed = this.#store.requireSession(session.id);
      return { stopped: true, session: observed.state === "idle" && observed.activeTurnId === undefined ? observed : this.#store.reconcileSessionFromProvider({ sessionId: session.id, state: "idle", activeTurnId: null }), idempotencyKey: key };
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      this.#quarantineSession(session.id);
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex stopped the turn, but its local session state could not be committed; the session is quarantined.", { cause: error instanceof Error ? error.name : "error" });
    }
  }

  async #rename(selector: string, name: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    await this.#effect({ kind: "session.rename", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { name }, idempotencyKey: key, effect: async () => { await this.#fencedEffect(async () => await this.#codex.rename({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, name, signal })); return { renamed: true as const }; }, beginEffect: async (attemptId) => {
      baseline = await this.#readExactSessionProjection(session, profile, false, signal);
      this.#store.beginSessionMutationEffect({
        attemptId,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "session.rename",
          providerThreadId: session.providerThreadId,
          baseline: this.#providerBaseline(baseline),
          requestedName: name,
        },
      });
    }, receipt: (value) => renamedReceiptSchema.parse(value), restore: (value) => renamedReceiptSchema.parse(value), onAmbiguous: () => this.#quarantineSession(session.id) });
    try {
      const observed = this.#store.requireSession(session.id);
      return { session: observed.title === name ? observed : this.#store.reconcileSessionFromProvider({ sessionId: session.id, title: name }), idempotencyKey: key };
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      this.#quarantineSession(session.id);
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex renamed the session, but its local title could not be committed; the session is quarantined.", { cause: error instanceof Error ? error.name : "error" });
    }
  }

  async #resolveSessionRecovery(selector: string, action: "recover" | "abandon", signal: AbortSignal): Promise<unknown> {
    const session = this.#store.requireSession(selector);
    if (session.state !== "recovery_required") {
      throw new CommandFailure("CONFLICT", "The session does not currently require recovery.");
    }
    const unsettled = this.#store.listUnsettledMutations({ sessionId: session.id });
    const unsettledQueue = this.#store.listUnsettledQueueEffects(session.id);
    if (unsettled.length + unsettledQueue.length === 0) {
      if (action === "abandon") {
        const resolved = this.#store.resolveSessionStatusRecovery({
          sessionId: session.id,
          expectedRevision: session.revision,
          resolution: "abandoned",
        });
        this.#scheduleIdleQueue(resolved);
        return {
          session: resolved,
          recovery: {
            resolved: true,
            resolution: "abandoned",
            providerEffectRetried: false,
            providerStateDeleted: false,
          },
        };
      }
      if (session.providerThreadId === undefined) {
        throw new CommandFailure("RECOVERY_REQUIRED", "The status quarantine has no exact provider-thread binding. Run `hra session abandon` to release only the local authority.");
      }
      const profile = this.#store.requireProfile(session.profileId);
      this.#assertSignedIn(profile);
      const projection = await this.#readExactSessionProjection({ ...session, providerThreadId: session.providerThreadId }, profile, false, signal);
      const resolved = this.#store.resolveSessionStatusRecovery({
        sessionId: session.id,
        expectedRevision: session.revision,
        resolution: "provider_state_reconciled",
        provider: {
          providerThreadId: projection.providerThreadId,
          title: projection.title,
          status: projection.status,
          ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
          ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
        },
      });
      this.#scheduleIdleQueue(resolved);
      return {
        session: resolved,
        projection,
        recovery: {
          resolved: true,
          resolution: "provider_state_reconciled",
          providerEffectRetried: false,
        },
      };
    }
    if (unsettled.length + unsettledQueue.length !== 1) {
      throw new CommandFailure("RECOVERY_REQUIRED", "No single exact mutation authority is available for this session.");
    }
    if (unsettled.length === 0) {
      const queueEffect = unsettledQueue[0];
      if (queueEffect === undefined) throw new CommandFailure("RECOVERY_REQUIRED", "The queue recovery authority disappeared.");
      return await this.#resolveQueueRecovery(session, queueEffect, action, signal);
    }
    const attempt = unsettled[0];
    if (attempt?.evidence === undefined) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The mutation has no immutable pre-effect evidence and cannot be reconciled automatically.");
    }
    const originalState = attempt.originalState ?? attempt.state;
    if (originalState !== "effect_started" && originalState !== "ambiguous") {
      throw new CommandFailure("CONFLICT", "The mutation authority is already settled.");
    }

    if (session.providerThreadId === undefined) {
      if (attempt.kind !== "session.start" || attempt.sessionStartId !== session.id) {
        throw new CommandFailure("RECOVERY_REQUIRED", "The unbound session does not have an exact start-attempt binding.");
      }
      if (action !== "abandon") {
        throw new CommandFailure("RECOVERY_REQUIRED", "An unbound session start has no causal provider identifier. Inspect the account, then explicitly run `hra session abandon` if you accept releasing only the local authority.");
      }
      const resolved = this.#store.resolveSessionMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: attempt.evidence.digest,
        resolution: "abandoned",
        resolutionEvidence: { action: "user_abandon", providerEffectRetried: false, providerStateDeleted: false },
      });
      this.#scheduleIdleQueue(resolved);
      return { session: resolved, idempotencyKey: attempt.idempotencyKey, recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false } };
    }

    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    if (profile.processGeneration !== attempt.authorityGeneration) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The account generation changed after the uncertain session effect.");
    }
    const projection = await this.#readExactSessionProjection({ ...session, providerThreadId: session.providerThreadId }, profile, false, signal);
    const provider = {
      providerThreadId: projection.providerThreadId,
      title: projection.title,
      status: projection.status,
      ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
      ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
    } as const;
    if (action === "abandon") {
      const resolved = this.#store.resolveSessionMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: attempt.evidence.digest,
        resolution: "abandoned",
        resolutionEvidence: { action: "user_abandon", providerEffectRetried: false, providerStateDeleted: false, observedProviderUpdatedAt: projection.providerUpdatedAt ?? null },
        provider,
      });
      this.#scheduleIdleQueue(resolved);
      return { session: resolved, projection, idempotencyKey: attempt.idempotencyKey, recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false } };
    }

    const proof = this.#proveSessionMutation(attempt, session.id, projection);
    if (proof === null) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The exact provider read does not contain kind-specific causal proof for the uncertain mutation. No effect was replayed.");
    }
    const resolved = this.#store.resolveSessionMutation({
      attemptId: attempt.id,
      expectedOriginalState: originalState,
      expectedEvidenceDigest: attempt.evidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: proof.evidence,
      receipt: proof.receipt,
      provider,
    });
    this.#scheduleIdleQueue(resolved);
    return { session: resolved, projection, idempotencyKey: attempt.idempotencyKey, recovery: { resolved: true, resolution: "proven_applied", providerEffectRetried: false } };
  }

  #proveSessionMutation(attempt: MutationAttemptRecord, sessionId: SessionRecord["id"], projection: CodexSessionProjection): { receipt: unknown; evidence: unknown } | null {
    const record = attempt.evidence;
    if (record === undefined) return null;
    const evidence: MutationEffectEvidence = record.evidence;
    if (evidence.kind !== attempt.kind) return null;
    if (evidence.kind === "session.start") {
      if (attempt.sessionStartId !== sessionId) return null;
      return { receipt: { sessionId, sourceId: attempt.id }, evidence: { kind: evidence.kind, providerThreadId: projection.providerThreadId, exactBinding: true } };
    }
    if (!("providerThreadId" in evidence) || projection.providerThreadId !== evidence.providerThreadId) return null;
    if (evidence.kind === "session.send" || evidence.kind === "session.steer") {
      const matchingTurns = new Set((projection.messages ?? [])
        .filter((message) => message.role === "user" && message.clientId === evidence.clientMessageId && message.turnId !== undefined)
        .map((message) => message.turnId as string));
      if (matchingTurns.size !== 1) return null;
      const [turnId] = matchingTurns;
      if (turnId === undefined) return null;
      if (evidence.kind === "session.send") {
        return { receipt: { turnId, sourceId: attempt.id }, evidence: { kind: evidence.kind, clientMessageId: evidence.clientMessageId, turnId, providerUpdatedAt: projection.providerUpdatedAt } };
      }
      if (evidence.activeTurnId === null || turnId !== evidence.activeTurnId) return null;
      return { receipt: { steered: true, activeTurnId: evidence.activeTurnId }, evidence: { kind: evidence.kind, clientMessageId: evidence.clientMessageId, turnId, providerUpdatedAt: projection.providerUpdatedAt } };
    }
    const strictlyNewer = evidence.baseline.providerUpdatedAt !== null
      && projection.providerUpdatedAt !== undefined
      && projection.providerUpdatedAt > evidence.baseline.providerUpdatedAt;
    if (!strictlyNewer) return null;
    if (evidence.kind === "session.stop") {
      if (evidence.activeTurnId === null || projection.activeTurnId === evidence.activeTurnId) return null;
      const observed = (projection.turnSummaries ?? []).find((turn) => turn.id === evidence.activeTurnId);
      const absentOrTerminal = observed === undefined || observed.status === "completed" || observed.status === "interrupted" || observed.status === "failed";
      if (!absentOrTerminal) return null;
      return { receipt: { stopped: true, activeTurnId: evidence.activeTurnId }, evidence: { kind: evidence.kind, activeTurnId: evidence.activeTurnId, observedStatus: observed?.status ?? "absent", providerUpdatedAt: projection.providerUpdatedAt } };
    }
    if (projection.title !== evidence.requestedName) return null;
    return { receipt: { renamed: true }, evidence: { kind: evidence.kind, requestedName: evidence.requestedName, providerUpdatedAt: projection.providerUpdatedAt } };
  }

  async #resolveQueueRecovery(
    session: SessionRecord,
    record: ReturnType<StateStore["readQueueEffect"]> extends infer T ? Exclude<T, null> : never,
    action: "recover" | "abandon",
    signal: AbortSignal,
  ): Promise<unknown> {
    if (session.providerThreadId === undefined) throw new CommandFailure("RECOVERY_REQUIRED", "The queued effect has no exact provider-thread binding.");
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    if (profile.processGeneration !== record.evidence.profileGeneration) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The account generation changed after the uncertain queued effect.");
    }
    const projection = await this.#readExactSessionProjection({ ...session, providerThreadId: session.providerThreadId }, profile, false, signal);
    const provider = {
      providerThreadId: projection.providerThreadId,
      title: projection.title,
      status: projection.status,
      ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
      ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
    } as const;
    if (action === "abandon") {
      const resolved = this.#store.resolveQueueEffect({
        queueId: record.queueId,
        expectedEvidenceDigest: record.digest,
        resolution: "abandoned",
        resolutionEvidence: { action: "user_abandon", providerEffectRetried: false, providerStateDeleted: false, observedProviderUpdatedAt: projection.providerUpdatedAt ?? null },
        provider,
      });
      this.#scheduleIdleQueue(resolved);
      return { session: resolved, projection, queueId: record.queueId, recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false } };
    }
    const matches = new Set((projection.messages ?? [])
      .filter((message) => message.role === "user" && message.clientId === record.evidence.clientMessageId && message.turnId !== undefined)
      .map((message) => message.turnId as string));
    const [turnId] = matches;
    if (matches.size !== 1 || turnId === undefined) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The exact provider read does not contain causal proof for the uncertain queued message. No effect was replayed.");
    }
    const receipt = { turnId, sourceId: record.queueId };
    const resolved = this.#store.resolveQueueEffect({
      queueId: record.queueId,
      expectedEvidenceDigest: record.digest,
      resolution: "proven_applied",
      resolutionEvidence: { kind: "queue.dispatch", clientMessageId: record.evidence.clientMessageId, turnId, providerUpdatedAt: projection.providerUpdatedAt },
      receipt,
      provider,
    });
    this.#scheduleIdleQueue(resolved);
    return { session: resolved, projection, queueId: record.queueId, recovery: { resolved: true, resolution: "proven_applied", providerEffectRetried: false } };
  }

  async #readExactSessionProjection(session: BoundSessionRecord, profile: ProfileRecord, detail: boolean, signal: AbortSignal): Promise<CodexSessionProjection> {
    const projection = await this.#fencedEffect(async () => await this.#codex.readSession({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, detail, signal }));
    if (projection.providerThreadId !== session.providerThreadId) {
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex returned a projection for a different provider thread.");
    }
    return projection;
  }

  #providerBaseline(projection: CodexSessionProjection): Extract<MutationEffectEvidence, { kind: "session.send" }>["baseline"] {
    return {
      providerUpdatedAt: projection.providerUpdatedAt ?? null,
      status: projection.status,
      activeTurnId: projection.activeTurnId ?? null,
    };
  }

  async #inspectTurn(sessionSelector: string, turnId: string, signal: AbortSignal): Promise<unknown> {
    const session = this.#requireBoundSession(sessionSelector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    this.#requireLiveProviderObservation(
      await this.#ensureSessionObservedLocked(session.id, signal),
    );
    return await this.#fencedEffect(async () => await this.#codex.inspectTurn({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, turnId, signal }));
  }

  #requireBoundSession(selector: string): BoundSessionRecord {
    const session = this.#store.requireSession(selector);
    if (session.providerThreadId === undefined) throw new CommandFailure("RECOVERY_REQUIRED", "The session has no proven provider binding.");
    if (session.state === "recovery_required") throw new CommandFailure("RECOVERY_REQUIRED", "The session requires recovery before another mutation.");
    if (session.state === "terminal") throw new CommandFailure("CONFLICT", "The session is terminal and cannot accept another mutation.");
    return { ...session, providerThreadId: session.providerThreadId };
  }

  #assertSignedIn(profile: ProfileRecord): void {
    if (profile.state === "recovery_required") {
      throw new CommandFailure("RECOVERY_REQUIRED", `Run \`hra account show ${profile.id}\` to reconcile this account before another provider operation.`);
    }
    if (profile.state === "signed_out") {
      throw new CommandFailure(
        "INTERACTION_REQUIRED",
        `Sign in with \`hra account login ${profile.id}\` before using this account's Codex runtime.`,
        {
          accountSelector: profile.id,
          accountState: "signed_out",
          nextCommand: `hra account login ${profile.id}`,
        },
      );
    }
    if (profile.state !== "signed_in") {
      throw new CommandFailure("INTERACTION_REQUIRED", `Sign in to ${profile.label} with \`hra account login ${profile.id}\` before using its Codex runtime.`);
    }
  }

  #quarantineProfile(profile: Pick<ProfileRecord, "id" | "processGeneration" | "providerEmail" | "providerPlan">): ProfileRecord {
    const current = this.#store.requireProfile(profile.id);
    if (current.processGeneration !== profile.processGeneration) {
      throw new Error("Account generation changed before recovery quarantine.");
    }
    const stateChange = current.state === "recovery_required"
      ? null
      : this.#store.setProfileStateWithWorkRetirement(
          profile.id,
          profile.processGeneration,
          "recovery_required",
          this.#work,
          {
            ...(current.providerEmail === undefined ? {} : { email: current.providerEmail }),
            ...(current.providerPlan === undefined ? {} : { plan: current.providerPlan }),
          },
        );
    if (stateChange !== null) this.#notifyAffectedWork(stateChange.affectedWorkIds);
    if (stateChange !== null && !stateChange.changed) {
      throw new Error("Account could not be quarantined after an indeterminate provider effect.");
    }
    return this.#store.requireProfile(profile.id);
  }

  #quarantineSession(sessionId: SessionRecord["id"]): SessionRecord {
    const session = this.#store.quarantineSession(sessionId);
    if (session.state !== "recovery_required" && session.state !== "terminal") {
      throw new Error("Session quarantine did not reach a non-dispatchable state.");
    }
    return session;
  }

  #profileHasProjectionRecoveryInFlight(profileId: ProfileRecord["id"]): boolean {
    for (const sessionId of this.#projectionRecoveriesInFlight) {
      try {
        if (this.#store.requireSession(sessionId).profileId === profileId) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  async #updateSession(selector: string, fields: (session: SessionRecord) => Omit<Parameters<StateStore["updateSessionMetadata"]>[0], "sessionId">): Promise<SessionRecord> {
    const session = this.#store.requireSession(selector);
    return await this.#serializeSessionAuthority(session, async () => {
      const current = this.#store.requireSession(session.id);
      const updated = this.#store.updateSessionMetadata({ sessionId: current.id, ...fields(current) });
      if (updated.state !== "terminal" && updated.state !== "recovery_required") {
        await this.#ensureFactsMemory(updated);
      }
      return updated;
    });
  }

  async #reconcileTerminalFactsMemory(): Promise<void> {
    if (this.#terminalFactsMemoryReconciled || this.#factsMemory === undefined) {
      this.#terminalFactsMemoryReconciled = true;
      return;
    }
    let afterId: string | null = null;
    for (;;) {
      const page = this.#store.listCloudSessionPage({ afterId, limit: 100 });
      for (const session of page.sessions) {
        if (session.state === "terminal") await this.#cleanupTerminalFactsMemory(session);
      }
      if (page.isDone || page.continueAfterId === null) break;
      afterId = page.continueAfterId;
    }
    this.#terminalFactsMemoryReconciled = true;
  }

  #publicProfile(profile: ProfileRecord): unknown {
    return { id: profile.id, label: profile.label, state: profile.state, processGeneration: profile.processGeneration, providerEmail: profile.providerEmail, providerPlan: profile.providerPlan, updatedAt: profile.updatedAt };
  }

  async #dispatchNextQueue(sessionId: SessionRecord["id"], authority: ProfileAuthority): Promise<void> {
    const session = this.#store.requireSession(sessionId);
    if (session.state !== "idle" || session.providerThreadId === undefined) return;
    const boundSession: BoundSessionRecord = { ...session, providerThreadId: session.providerThreadId };
    const queued = this.#store.nextPendingQueue(session.id);
    if (queued === null) return;
    const project = session.projectId === undefined ? undefined : this.#store.requireProject(session.projectId);
    if (project === undefined) return;
    let evidence: ReturnType<StateStore["beginQueueEffect"]> | undefined;
    let providerApplied = false;
    try {
      const signal = new AbortController().signal;
      const profile = this.#store.requireProfile(session.profileId);
      await this.#requireUsableProjectRoot(project.rootPath);
      this.#requireLiveProviderObservation(
        await this.#ensureSessionObservedLocked(session.id, signal),
      );
      const baseline = await this.#readExactSessionProjection(boundSession, profile, false, signal);
      if (baseline.status === "active" || baseline.activeTurnId !== undefined) return;
      const review = await this.#fencedEffect(async () => {
        const projectRoot = await this.#requireUsableProjectRoot(project.rootPath);
        return await this.#codex.reviewTurnStart({
          authority,
          providerThreadId: boundSession.providerThreadId,
          projectRoot,
          preset: session.preset,
          fast: session.fastEnabled,
          signal,
        });
      });
      evidence = this.#store.beginQueueEffect({
        queueId: queued.id,
        sessionId: session.id,
        profileGeneration: authority.generation,
        evidence: {
          kind: "queue.dispatch",
          queueId: queued.id,
          sessionId: session.id,
          providerThreadId: boundSession.providerThreadId,
          profileGeneration: authority.generation,
          baseline: this.#providerBaseline(baseline),
          clientMessageId: queued.id,
          messageDigest: digestText(queued.message),
          runtimeProfile: review.effectiveRuntimeProfile,
        },
      });
      this.#queuePreEffectRetryCounts.delete(queued.id);
      const dispatchRevision = this.#store.requireSession(session.id).revision;
      const dispatchFactEpoch = this.#sessionFactEpochs.get(session.id) ?? 0;
      const result = await this.#fencedEffect(async () => {
        const projectRoot = await this.#requireUsableProjectRoot(project.rootPath);
        return await this.#codex.startTurn({
          authority,
          providerThreadId: boundSession.providerThreadId,
          projectRoot,
          review,
          message: queued.message,
          clientMessageId: queued.id,
          signal,
        });
      });
      providerApplied = true;
      this.#store.completeQueueEffect({
        queueId: queued.id,
        expectedEvidenceDigest: evidence.digest,
        expectedSessionRevision: dispatchRevision,
        applyResponseState: (this.#sessionFactEpochs.get(session.id) ?? 0) === dispatchFactEpoch,
        turnId: result.turnId,
        turnStatus: result.status,
        runtimeProfile: result.effectiveRuntimeProfile,
        receipt: { turnId: result.turnId, sourceId: queued.id, status: result.status },
      });
      const observed = this.#store.requireSession(session.id);
      if (observed.state === "idle") this.#scheduleQueueDispatch(observed);
    } catch (error: unknown) {
      if (error instanceof StateSecurityScrubRequiredError) {
        this.#requestStop();
        throw error;
      }
      await this.#daemonAuthority.assertCurrent();
      if (evidence === undefined) {
        if (this.#isRetryableQueuePreEffectError(error)) this.#scheduleQueuePreEffectRetry(session, queued.id);
        return;
      }
      this.#queuePreEffectRetryCounts.delete(queued.id);
      if (providerApplied || error instanceof IndeterminateCodexEffectError || error instanceof IndeterminateLocalCommitError) {
        this.#store.markQueueEffectAmbiguous(queued.id, evidence.digest);
        return;
      }
      try {
        if (!this.#store.failQueueEffect(queued.id)) return;
      } catch (settlementError: unknown) {
        if (settlementError instanceof StateSecurityScrubRequiredError) {
          this.#requestStop();
        }
        throw settlementError;
      }
      const observed = this.#store.requireSession(session.id);
      if (observed.state === "idle") this.#scheduleQueueDispatch(observed);
    }
  }

  async #serialize<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await this.#daemonAuthority.assertCurrent();
      return await operation();
    });
    this.#mutationTails.set(key, current);
    try {
      return await current;
    } finally {
      if (this.#mutationTails.get(key) === current) this.#mutationTails.delete(key);
    }
  }

  async #applyOrderedAccountFact(
    profileId: ProfileRecord["id"],
    operation: () => Promise<void> | void,
  ): Promise<void> {
    const accountKey = `account:${profileId}`;
    if (!this.#mutationTails.has(accountKey)) {
      await this.#serialize(accountKey, operation);
      return;
    }
    // Return the old client's fact callback before a queued fresh-generation
    // login closes that client. Later account facts join the same FIFO tail, so a
    // disconnect cannot overtake an already observed terminal login result.
    const task = this.#serialize(accountKey, operation);
    const tracked = task.then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
        else this.#scheduleStop();
      },
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  async #serializeSessionAuthority<T>(
    session: Pick<SessionRecord, "id" | "profileId">,
    operation: () => Promise<T> | T,
    options: Readonly<{ allowDuringProjectionRecovery?: boolean }> = {},
  ): Promise<T> {
    return await this.#serialize(`account:${session.profileId}`, async () =>
      this.#serialize(`session:${session.id}`, async () => {
        if (options.allowDuringProjectionRecovery !== true) {
          const unsettled = await this.#cloud.isCompactProjectionRecoveryUnsettled(session.id);
          await this.#daemonAuthority.assertCurrent();
          if (unsettled) {
            throw new CommandFailure(
              "RECOVERY_REQUIRED",
              "This session has an unsettled compact-projection recovery. Retry that exact recovery before changing local or provider state.",
            );
          }
        }
        return await operation();
      }));
  }

  async #assertNoCompactProjectionRecoveryForProfile(profileId: ProfileRecord["id"]): Promise<void> {
    const unsettled = await this.#cloud.isCompactProjectionRecoveryUnsettledForProfile(profileId);
    await this.#daemonAuthority.assertCurrent();
    if (unsettled) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "This account owns an unsettled compact-projection recovery. Retry that exact recovery before changing provider or account authority.",
      );
    }
  }

  async #effect<T>(input: { kind: string; authorityId: string; authorityGeneration: number; request: unknown; idempotencyKey: string | undefined; beginEffect?(attemptId: MutationAttemptRecord["id"]): Promise<void> | void; effect(attemptId: string): Promise<T>; receipt(result: T): unknown; restore(receipt: unknown): T; commit?(attemptId: MutationAttemptRecord["id"], result: T, receipt: unknown): Promise<void> | void; onAmbiguous?: (result: T | undefined) => void }): Promise<T> {
    const attempt = this.#store.prepareMutation(input);
    if (attempt.replay) {
      if (attempt.state === "applied") return input.restore(attempt.result);
      if (attempt.state === "reconciled") {
        if (attempt.result !== undefined) return input.restore(attempt.result);
        throw new CommandFailure("CONFLICT", `${input.kind} was explicitly resolved without replay and will never be dispatched under the same idempotency key.`, { idempotencyKey: input.idempotencyKey });
      }
      if (attempt.state === "effect_started" || attempt.state === "ambiguous") {
        throw new CommandFailure("RECOVERY_REQUIRED", `${input.kind} has an indeterminate earlier attempt and will not be replayed.`, { idempotencyKey: input.idempotencyKey });
      }
      if (attempt.state !== "prepared") throw new CommandFailure("CONFLICT", `${input.kind} already reached ${attempt.state}.`);
    }
    if (input.beginEffect === undefined) {
      if (!this.#store.transitionMutation(attempt.id, "prepared", "effect_started")) throw new CommandFailure("CONFLICT", "Mutation authority changed before effect dispatch.");
    } else {
      await input.beginEffect(attempt.id);
      await this.#daemonAuthority.assertCurrent();
    }
    let result: T;
    try {
      result = await input.effect(attempt.id);
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      const terminal = error instanceof IndeterminateCodexEffectError || error instanceof IndeterminateLocalCommitError ? "ambiguous" : "failed";
      if (terminal === "ambiguous") input.onAmbiguous?.(undefined);
      this.#store.transitionMutation(attempt.id, "effect_started", terminal, { code: error instanceof Error ? error.name : "error" });
      if (terminal === "ambiguous") throw new CommandFailure("RECOVERY_REQUIRED", `${input.kind} has an indeterminate provider or local commit outcome and will not be replayed.`, { idempotencyKey: input.idempotencyKey });
      throw error;
    }
    try {
      await this.#daemonAuthority.assertCurrent();
      const receipt = input.receipt(result);
      if (input.commit === undefined) {
        if (!this.#store.transitionMutation(attempt.id, "effect_started", "applied", receipt)) throw new Error("Mutation result authority changed before commit.");
      } else {
        await input.commit(attempt.id, result, receipt);
        await this.#daemonAuthority.assertCurrent();
      }
      return result;
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      input.onAmbiguous?.(result);
      this.#store.transitionMutation(attempt.id, "effect_started", "ambiguous", { code: error instanceof Error ? error.name : "commit_error" });
      throw new CommandFailure("RECOVERY_REQUIRED", `${input.kind} completed externally but its durable receipt could not be committed; it will not be replayed.`, { idempotencyKey: input.idempotencyKey });
    }
  }
}
