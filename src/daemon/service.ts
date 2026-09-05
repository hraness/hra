import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { z } from "zod";

import {
  AccountKeyLossPreconditionError,
  CloudProjectionRecoveryAdmissionError,
  KeyRotationRequiredError,
} from "../domain/cloud-outcomes";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the daemon maps this provider's closed failure codes onto command outcomes; only the error class and the pinned version cross the boundary.
import { ClaudeError } from "../claude/errors";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- `claude/pin.ts` is the zero-import pin module; the daemon names the exact release an operator must install.
import { CLAUDE_PIN } from "../claude/pin";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- D4 extracts the provider port; until then the daemon composes the pinned Codex runtime directly.
import {
  CodexError,
  IndeterminateCodexEffectError,
  resolvePinnedCodexRuntime,
  validateMcpFormSubmission,
  type CodexFact,
  type CodexAutomationAuthorityRequest,
  type CodexAutomationAuthorityScan,
  type CodexPluginCatalog,
  type CodexPluginSummary,
  type ConversationAutomationToolCall,
  type DynamicToolPublicResult,
} from "../codex/index";
import {
  signedOutSessionListMetadataSchema,
  type LocalCommand,
} from "../domain/contracts";
import {
  PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES,
  encodeProtectedInteractionDetailDocument,
  protectedInteractionDetailDocumentSchema,
  computeInteractionPresentation,
  publicInteractionSchema,
  type InteractionRecord,
  type InteractionIntendedTerminalState,
  type InteractionResolution,
  type ProviderInteractionAuthority,
  type PublicInteraction,
} from "../domain/interactions";
import {
  SESSION_STATUS_PENDING_SUMMARY_LIMIT,
  deriveSessionAttention,
  sessionStatusSchema,
  type ProviderObservation,
  type SessionStatus,
} from "../domain/observation";
import {
  isPresetSupportedByProvider,
  PresetProviderMismatchError,
  presetsForProvider,
  presetTiers,
  type Preset,
  type Provider,
} from "../domain/presets";
import {
  projectPublicReviewedRuntimeProfile,
  reviewedRuntimeProfileSchema,
  type ReviewedRuntimeProfile,
} from "../domain/runtime-profile";
import {
  SESSION_CONVERSATION_AUTOMATION_CAPABILITY,
  summarizeSessionTask,
  type SessionTaskPatch,
} from "../domain/session-tasks";
import {
  SESSION_EVENT_PAGE_LIMIT,
  SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS,
  sessionEventPageSchema,
  type SessionEvent,
  type SessionEventBody,
  type SessionEventPage,
  type SessionMessageActor,
} from "../domain/session-events";
import {
  buildSessionTranscript,
  digestTranscriptSeed,
  renderTranscriptSeed,
  sessionProviderSwitchDurableReceiptSchema,
  sessionProviderSwitchReceiptSchema,
  sessionProviderSwitchSnapshotSchema,
  sessionTranscriptSchema,
  TRANSCRIPT_PAGE_LIMIT,
  type SessionTranscript,
} from "../domain/transcript";
import {
  AUTO_RATE_LIMIT_RESET_REMAINING_PERCENT,
  AUTO_RATE_LIMIT_RESET_USED_PERCENT,
  CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES,
  accountUsageHistoryEntrySchema,
  accountUsageHistoryPageSchema,
  accountUsageCounterSamples,
  automaticRateLimitResetDecision,
  automaticRateLimitResetObservation,
  automaticRateLimitResetStatusSchema,
  createStoredAccountUsageSnapshot,
  observedAccountTokenVelocity,
  providerUsagePayload,
  storedAccountUsageSnapshotSchema,
  type AutomaticRateLimitResetLastAttempt,
  type AutomaticRateLimitResetPolicyStatus,
  type AutomaticRateLimitResetRefreshStatus,
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
import { resolveMessageAttachments } from "./attachments";
import { describeWorkProtocol } from "../domain/work-protocol";
import { workPreparedEffectMessage } from "../domain/work-message";
import {
  attemptIdSchema,
  canonicalLabelKey,
  profileIdSchema,
  sessionIdSchema,
  sessionTaskIdSchema,
} from "../domain/values";
import {
  attachmentReferenceOf,
  type AttachmentReference,
  type PreparedAttachment,
} from "../domain/attachments";
import {
  ATTACHMENT_BLOB_SWEEP_GRACE_MS,
  AttachmentBlobStore,
} from "../storage/attachment-store";
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
  type AccountRateLimitResetAttemptRecord,
  type AccountRateLimitResetPolicyRecord,
  type ClaudeProcessAuthorityKey,
  type ClaudeProcessAuthorityRecord,
  type ClaudeProcessLaunchIntentRecord,
  type ProfileRecord,
  type ProviderRuntimeAccountRevocationRecord,
  type ProjectRecord,
  type SessionAdoptionCandidateRecord,
  type SessionRecord,
  type StateStore,
  type StoredMessageAttachment,
} from "../storage/state-store";
import {
  WorkStoreError,
  canonicalWorkJson,
  type WorkPreparedEffectAuthorization,
  type WorkStore,
} from "../storage/work-store";
import {
  SessionTaskStoreError,
  type SessionTaskStore,
} from "../storage/session-task-store";
import { DaemonAuthoritySafetyError, type DaemonAuthorityFence } from "./daemon-lock";
import type { HraFactsMemoryLifecyclePort } from "./facts-memory-lifecycle";
import { commandFailureBrand } from "./local-transport";
import {
  ClaudeProcessExitUnprovenError,
  ClaudeSessionObservationError,
  CodexClaimReleaseUnprovenError,
  CodexSessionObservationError,
  ProviderRuntimeUnavailableError,
  UnavailableClaudeRuntime,
  type ClaudeRuntimePort,
  type ClaudeProcessIdentity,
  type CloudControlPort,
  type CodexAccountProjection,
  type CodexLoginOutcome,
  type CodexRuntimePort,
  type CodexSessionObservation,
  type CodexSessionProjection,
  type DesktopSwitchPort,
  type ProfileAuthority,
  type RuntimeStartReviewOf,
  type SessionRuntimePort,
} from "./ports";
import {
  ClaudeSessionFactTranslator,
  type ClaudeSessionFact,
} from "./claude-session-facts";
import {
  CLAUDE_REGISTRY_MAX_RECORDS,
  inferCodexLiveness,
  PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS,
  type ClaudeProcessLivenessProbe,
  type DiscoveredPersonalSession,
  type PersonalSessionDiscoveryPort,
} from "./personal-session-discovery";
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
import { SessionStateTracker } from "./session-state-tracker";
import {
  decideAutorespond,
  decideProseAutorespond,
  permissionNamesOf,
  PROSE_AUTORESPOND_MAX_MESSAGE_CHARACTERS,
  type ProseAutorespondGateFailure,
} from "./autorespond";
import {
  PROSE_APPROVAL_REPLY,
  type ProseResponder,
} from "./prose-responder";
import type { GatewayKeyPort } from "../storage/gateway-key-custody";
import {
  DENYLIST_CUES,
  HUMAN_ACTION_CUES,
  prepareAssistantText,
  STRONG_HUMAN_ACTION_CUES,
  type SessionStateClassification,
} from "../domain/session-state";

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

class ProviderAccountAuthorityMismatchError extends CommandFailure {
  constructor(
    provider: Provider,
    runtimeScope: RuntimeAccountScope,
    profile: Pick<ProfileRecord, "id" | "label">,
  ) {
    super(
      "RECOVERY_REQUIRED",
      runtimeScope === "personal" && provider === "codex"
        ? `The personal-home Codex account does not match ${profile.label}. HRA refused controller authority and is releasing only that personal-home controller.`
        : `The ${runtimeScope} ${provider} account changed. HRA refused stale controller authority and is releasing the affected ${provider} sessions.`,
      { accountId: profile.id, provider, runtimeScope },
    );
    this.name = "ProviderAccountAuthorityMismatchError";
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

/**
 * The closed failure code either provider's adapter raised. The daemon's
 * interaction lane reasons about provider outcomes (invalid input, expired
 * deadline, unproven effect) rather than about which provider produced them.
 */
const providerFailure = (error: unknown): CodexError | ClaudeError | null =>
  error instanceof CodexError || error instanceof ClaudeError ? error : null;

const providerFailureCode = (error: unknown): string | null => providerFailure(error)?.code ?? null;

/** The provider's own bounded, credential-free message, or a neutral one. */
const providerFailureMessage = (error: unknown): string =>
  providerFailure(error)?.message ?? "The provider refused the operation.";

type ProviderFactSource = "managed" | "personal";

const claudeCommandFailure = (error: ClaudeError): CommandFailure => {
  switch (error.code) {
    case "AUTHORITY_STALE":
      return new CommandFailure(
        "UNAVAILABLE",
        "The exact Claude Code process authority changed before the operation finished. Inspect daemon status before starting a fresh attempt.",
        { reason: "claude_authority_stale", nextCommand: "hra daemon status --json" },
      );
    case "DEADLINE_EXPIRED":
      return new CommandFailure(
        "CONFLICT",
        "The Claude Code interaction deadline expired before HRA could apply the response. Refresh pending interactions instead of replaying the expired response.",
        { reason: "claude_interaction_deadline_expired", nextCommand: "hra interaction list --pending --json" },
      );
    case "INVALID_INPUT":
    case "PRESET_UNSUPPORTED":
    case "UNSUPPORTED_CAPABILITY":
      return new CommandFailure("INVALID_INPUT", error.message, { reason: "claude_unsupported" });
    case "NOT_AUTHENTICATED":
      return new CommandFailure(
        "INTERACTION_REQUIRED",
        `Claude Code ${CLAUDE_PIN} is installed but this account's isolated Claude profile is not signed in. Sign in inside that profile, then retry.`,
        { reason: "claude_not_authenticated" },
      );
    case "CONFIG_DIR_MISMATCH":
    case "RUNTIME_MISMATCH":
      return new CommandFailure("UNAVAILABLE", error.message, { reason: "claude_runtime_unavailable" });
    case "PROCESS_EXITED":
    case "PROTOCOL_ERROR":
    case "PROTOCOL_LIMIT":
    case "TIMEOUT":
      return new CommandFailure(
        "UNAVAILABLE",
        `The pinned Claude Code ${CLAUDE_PIN} runtime connection ended before the operation finished. Start a fresh attempt.`,
        { reason: "claude_runtime_fault" },
      );
  }
};

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

/**
 * Item kinds that are conversation rather than a tool call. Everything else a
 * provider announces as an item is treated as a tool call, so an unknown kind
 * still gets its neutral call identity instead of being silently dropped.
 * `src/domain/transcript.ts` applies the same rule when it reads the events
 * back, and `session-events.test.ts` pins the two lists equal.
 */
export const NEUTRAL_NON_TOOL_ITEM_KINDS = Object.freeze([
  "agentMessage",
  "assistantMessage",
  "reasoning",
  "subAgentActivity",
  "userMessage",
] as const);

const nonToolItemKinds: ReadonlySet<string> = new Set(NEUTRAL_NON_TOOL_ITEM_KINDS);

const isNeutralToolItemKind = (itemKind: string): boolean => !nonToolItemKinds.has(itemKind);

/**
 * The bounded one-line label HRA keeps for a tool call. It is assembled only
 * from values the protocol layer already reduced to safe labels: the item
 * kind, the MCP server and tool names, and the closed-vocabulary command
 * class. No raw argument reaches it.
 */
const neutralToolSummary = (fact: Readonly<{
  commandClass?: string;
  itemKind: string;
  server?: string;
  tool?: string;
}>): string => {
  const target = fact.tool === undefined
    ? undefined
    : fact.server === undefined ? fact.tool : `${fact.server}/${fact.tool}`;
  const detail = fact.commandClass ?? target;
  return (detail === undefined ? fact.itemKind : `${fact.itemKind}: ${detail}`).slice(0, 256);
};

/**
 * The most stored event pages one transcript page reads before it answers.
 * A transcript is bounded twice: by the records it returns and by the events
 * it is willing to walk to find them.
 */
const TRANSCRIPT_EVENT_PAGE_BUDGET = 20;

const sessionSwitchReceiptSchema = sessionProviderSwitchReceiptSchema;

/**
 * The preset a switch uses when the operator named none: the session's own
 * tier when the target provider has one, and otherwise that provider's
 * highest tier. A preset the target cannot run is still refused, never
 * silently downgraded.
 */
const defaultPresetForProviderSwitch = (provider: Provider, current: Preset): Preset => {
  const supported = presetsForProvider(provider);
  const sameTier = supported.find((preset) => presetTiers[preset] === presetTiers[current]);
  const fallback = supported[supported.length - 1];
  if (sameTier !== undefined) return sameTier;
  if (fallback === undefined) throw new Error(`No preset exists for the ${provider} provider.`);
  return fallback;
};

/** Projects private reviewed runtime evidence onto the ordinary public session surface. */
const publicRuntimeProfile = (
  profile: ReviewedRuntimeProfile | null | undefined,
): ReturnType<typeof projectPublicReviewedRuntimeProfile> | null =>
  profile === null || profile === undefined
    ? null
    : projectPublicReviewedRuntimeProfile(profile);

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
const loginCancelReceiptSchema = z.object({
  loginId: z.string().min(1).max(512).refine((value) => !/\p{Cc}/u.test(value)),
  providerStatus: z.enum(["canceled", "not_found"]),
  provider: z.object({
    signedIn: z.boolean(),
    email: z.string().max(1_024).optional(),
    plan: z.string().max(128).optional(),
  }).strict(),
}).strict();
const claudeLoginTerminalReceiptSchema = z.object({
  accountId: profileIdSchema,
  attemptId: attemptIdSchema,
  idempotencyKey: z.string().uuid(),
  providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  signedIn: z.boolean(),
  outcome: z.union([
    z.object({
      state: z.literal("joined"),
      exitCode: z.number().int().nonnegative().max(255),
      interruptedBy: z.enum(["SIGINT", "SIGTERM"]).nullable(),
    }).strict(),
    z.object({ state: z.literal("not_started"), reason: z.literal("spawn_failed") }).strict(),
    z.object({ state: z.literal("not_started"), reason: z.literal("preflight_stale") }).strict(),
    z.object({
      state: z.literal("not_started"),
      reason: z.literal("interrupted_before_spawn"),
      interruptedBy: z.enum(["SIGINT", "SIGTERM"]),
    }).strict(),
  ]),
}).strict();
const sessionStartReceiptSchema = z.object({
  sessionId: sessionIdSchema,
  sourceId: z.string().min(1).max(200).optional(),
  effectiveRuntimeProfile: reviewedRuntimeProfileSchema.optional(),
}).strict();
const turnStartReceiptSchema = z.object({
  turnId: z.string().min(1).max(200),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]).optional(),
  sourceId: z.string().min(1).max(200).optional(),
  effectiveRuntimeProfile: reviewedRuntimeProfileSchema.optional(),
}).strict();
const steeredReceiptSchema = z.object({ steered: z.literal(true), activeTurnId: z.string().min(1).max(200) }).strict();
const stoppedReceiptSchema = z.discriminatedUnion("stopped", [
  z.object({ stopped: z.literal(true), activeTurnId: z.string().min(1).max(200) }).strict(),
  z.object({ stopped: z.literal(false), activeTurnId: z.null() }).strict(),
]);
const renamedReceiptSchema = z.object({ renamed: z.literal(true) }).strict();

const digestText = (value: string): string => createHash("sha256").update(value).digest("hex");
const conversationAutomationIdempotencyKey = (
  authority: ProfileAuthority,
  call: ConversationAutomationToolCall,
): string => {
  const digest = createHash("sha256")
    .update("hra:conversation-automation-call:v1\0", "utf8")
    .update(authority.id, "utf8")
    .update("\0", "utf8")
    .update(call.threadId, "utf8")
    .update("\0", "utf8")
    .update(call.turnId, "utf8")
    .update("\0", "utf8")
    .update(call.callId, "utf8")
    .digest();
  digest[6] = (digest[6] ?? 0) & 0x0f | 0x50;
  digest[8] = (digest[8] ?? 0) & 0x3f | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const accountFingerprintForProfile = (
  profile: Pick<ProfileRecord, "providerEmail">,
): string | null => profile.providerEmail === undefined
  ? null
  : digestText(profile.providerEmail.trim().toLowerCase());
const normalizedProviderEmail = (value: string): string => value.trim().toLowerCase();
type RuntimeAccountScope = "managed" | "personal";

const boundedProviderIdentityScalar = (value: unknown): string | null => {
  const parsed = z.string().min(1).max(1_024).safeParse(value);
  if (!parsed.success) return null;
  const normalized = parsed.data.trim();
  if (normalized.length === 0 || /\p{Cc}/u.test(normalized)) return null;
  return normalized;
};

/**
 * Credential-free provider identity captured at custody admission. Codex's
 * stable authority is its normalized account email. Claude exposes distinct
 * account and organization UUIDs, so its authority deliberately does not
 * inherit the selected Codex profile email.
 */
const providerAccountAuthorityKey = (
  provider: Provider,
  account: CodexAccountProjection,
): string | null => {
  if (!account.signedIn) return null;
  if (provider === "codex") {
    const email = boundedProviderIdentityScalar(account.email);
    return email === null ? null : `v1:codex:${digestText(email.toLowerCase())}`;
  }
  const accountId = boundedProviderIdentityScalar(account.accountId);
  const organizationId = boundedProviderIdentityScalar(account.organizationId);
  if (accountId === null || organizationId === null) return null;
  return `v1:claude:${digestText(`${accountId}\0${organizationId}`)}`;
};

const profileCodexAccountAuthorityKey = (
  profile: Pick<ProfileRecord, "providerEmail">,
): string | null => profile.providerEmail === undefined
  ? null
  : providerAccountAuthorityKey("codex", {
      signedIn: true,
      email: profile.providerEmail,
    });
const providerAccountAuthorityChanged = (
  profile: Pick<ProfileRecord, "providerEmail">,
  account: CodexAccountProjection,
): boolean => {
  if (!account.signedIn) return true;
  if (profile.providerEmail === undefined || account.email === undefined) return true;
  return normalizedProviderEmail(account.email) !== normalizedProviderEmail(profile.providerEmail);
};
const QUEUE_PRE_EFFECT_RETRY_DELAYS_MS = [25, 100, 250] as const;
export const FACTS_MEMORY_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const isSqliteUniqueConstraint = (error: unknown): boolean =>
  error instanceof Error
  && (error as Error & { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";

type LoginOutcome = CodexLoginOutcome;
type BoundSessionRecord = SessionRecord & { providerThreadId: string };
type PublicProviderObservation = ProviderObservation;
type AutomaticRateLimitResetAttemptResult = Readonly<{
  authoritativeReread: boolean;
  refresh: AutomaticRateLimitResetRefreshStatus;
}>;
const publicAutomaticRateLimitResetPolicy = (
  policy: AccountRateLimitResetPolicyRecord,
  currentAccountFingerprint: string | null,
): AutomaticRateLimitResetPolicyStatus => {
  if (
    policy.accountFingerprint !== null
    && policy.accountFingerprint !== currentAccountFingerprint
  ) return { state: "reconciliation_required" };
  switch (policy.state) {
    case "active_unbound":
    case "active_bound": return { state: "active" };
    case "reconciliation_required": return { state: "reconciliation_required" };
    case "window_suppressed": {
      if (policy.weeklyWindowResetsAt === null) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_WINDOW_MISSING");
      }
      return {
        state: "window_suppressed",
        weeklyWindowResetsAt: policy.weeklyWindowResetsAt,
      };
    }
  }
};
const publicAutomaticRateLimitResetLastAttempt = (
  attempt: AccountRateLimitResetAttemptRecord | null,
): AutomaticRateLimitResetLastAttempt | null => {
  if (attempt === null) return null;
  const weeklyWindowResetsAt = attempt.weeklyWindowResetsAt;
  switch (attempt.state) {
    case "prepared": return { state: "prepared", weeklyWindowResetsAt };
    case "effect_started":
    case "ambiguous": return { state: "recovery_pending", weeklyWindowResetsAt };
    case "retryable": return { state: "retry_pending", weeklyWindowResetsAt };
    case "settled": {
      if (attempt.outcome === null) throw new Error("Settled reset attempt is missing its outcome.");
      return { state: "settled", outcome: attempt.outcome, weeklyWindowResetsAt };
    }
    case "closed": {
      if (attempt.localResolution === null) {
        throw new Error("Closed reset attempt is missing its local resolution.");
      }
      return {
        state: "closed",
        reason: attempt.localResolution,
        weeklyWindowResetsAt,
      };
    }
  }
};
type RemoteSessionCommand = Extract<LocalCommand, { kind:
  | "session.send"
  | "session.queue"
  | "session.steer"
  | "session.stop"
  | "session.rename"
  | "session.preset"
  | "session.switch"
  | "session.fast"
  | "interaction.resolve"
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

/** Background tasks that swallow their own rejection record one of these closed codes. */
export const BACKGROUND_DIAGNOSTIC_CODES = [
  "account_fact_apply_failed",
  "attachment_sweep_failed",
  "autorespond_failed",
  "claude_fact_untranslatable",
  "prose_autorespond_failed",
  "profile_authority_revocation_failed",
  "provider_account_authority_revocation_failed",
  "queue_dispatch_failed",
  "queue_pre_effect_retry_failed",
  "recovery_observation_failed",
  "session_adoption_failed",
  "session_state_tracking_failed",
  "usage_refresh_failed",
  "usage_poll_account_failed",
  "provider_switch_source_abandon_failed",
  "provider_switch_seed_failed",
  "provider_switch_target_release_failed",
  "provider_switch_target_abandon_failed",
  "usage_poll_tick_failed",
  "user_message_record_failed",
] as const;
export type BackgroundDiagnosticCode = (typeof BACKGROUND_DIAGNOSTIC_CODES)[number];
export type BackgroundDiagnosticCause =
  | "aborted"
  | "authority_unsafe"
  | "command_failure"
  | "indeterminate"
  | "scrub_required"
  | "error";
export type BackgroundDiagnostic = Readonly<{
  code: BackgroundDiagnosticCode;
  cause: BackgroundDiagnosticCause;
  count: number;
  observedAt: number;
}>;

const classifyBackgroundDiagnosticCause = (error: unknown): BackgroundDiagnosticCause => {
  if (error instanceof StateSecurityScrubRequiredError) return "scrub_required";
  if (error instanceof DaemonAuthoritySafetyError) return "authority_unsafe";
  if (error instanceof IndeterminateCodexEffectError || error instanceof IndeterminateLocalCommitError) return "indeterminate";
  if (error instanceof CommandFailure) return "command_failure";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "error";
};

/** Upper bound on remembered per-session fact epochs; oldest entries are dropped first. */
const SESSION_FACT_EPOCH_LIMIT = 4_096;
const PERSONAL_SESSION_ADOPTION_SCAN_LIMIT = 50;
const PERSONAL_CODEX_DISCOVERY_SCAN_LIMIT = PERSONAL_SESSION_ADOPTION_SCAN_LIMIT * 2;
const PERSONAL_SESSION_ADOPTION_RECENCY_MS = PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS;
const PERSONAL_SESSION_ADOPTION_CLOCK_SKEW_MS = 5 * 60_000;
const CLAUDE_PROCESS_LIVENESS_DEADLINE_MS = 3_000;
const CLAUDE_RETAINED_CANDIDATE_PROBE_CONCURRENCY = 8;
const PERSONAL_ACCOUNT_ATTESTATION_TTL_MS = 1_000;
const SESSION_LIST_TRAVERSAL_LIMIT = 64;
const SESSION_LIST_TRAVERSAL_IMPORT_RECEIPT_LIMIT = 10_000;

const isEligiblePersonalCodexAutomationStatus = (
  status: unknown,
): status is "active" | "paused" => status === "active" || status === "paused";

type RetainedClaudeCandidateObservation = Readonly<{
  candidate: DiscoveredPersonalSession;
  durableCandidate: SessionAdoptionCandidateRecord;
  project: ProjectRecord | undefined;
}>;

type PersonalAccountAttestation = Readonly<{
  checkedAt: number;
  accountKey: string;
  generation: number;
}>;

type PersonalCodexScheduledAuthorityBatch = Readonly<{
  providerThreadIds: readonly string[];
  sourceDirectoryNamesByProviderThreadId: ReadonlyMap<string, readonly string[]>;
}>;

/**
 * In-memory capability for provider deltas. Its durable components are
 * revalidated synchronously before every commit, so an ordinary delta never
 * performs a provider account read and can never outlive controller custody.
 */
type SessionFactAuthority = Readonly<{
  sessionId: SessionRecord["id"];
  profileId: ProfileRecord["id"];
  profileGeneration: number;
  provider: Provider;
  runtimeScope: RuntimeAccountScope;
  providerThreadId: string;
  connectionId: string;
  accountKey: string;
  personalBindingRevision: number | null;
  claudeProcess: Readonly<{
    identity: ClaudeProcessIdentity;
    revision: number;
  }> | null;
}>;

type SessionListTraversalReplayState = {
  readonly accountId: ProfileRecord["id"];
  readonly providerGeneration: number;
  readonly importedSessionIdsByProviderPage: Map<string, Set<SessionRecord["id"]>>;
  readonly emittedSessionIds: Set<SessionRecord["id"]>;
  importReceiptCount: number;
};

export class HraService {
  readonly #store: StateStore;
  readonly #paths: StatePaths;
  #attachmentBlobs: AttachmentBlobStore | undefined;
  readonly #codex: CodexRuntimePort;
  readonly #claude: ClaudeRuntimePort;
  readonly #personalCodex: CodexRuntimePort | undefined;
  readonly #personalClaude: ClaudeRuntimePort | undefined;
  readonly #personalCodexHome: string | undefined;
  readonly #personalDiscovery: PersonalSessionDiscoveryPort | undefined;
  readonly #readPersonalCodexAutomations: ((
    request: CodexAutomationAuthorityRequest,
  ) => Promise<CodexAutomationAuthorityScan>) | undefined;
  readonly #claudeProcessLiveness: ClaudeProcessLivenessProbe | undefined;
  readonly #claudeFacts: ClaudeSessionFactTranslator;
  readonly #personalClaudeFacts: ClaudeSessionFactTranslator | undefined;
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
  readonly #sessionTasks: SessionTaskStore;
  readonly #sessionStateTracker = new SessionStateTracker(() => this.#now());
  readonly #gatewayKeys: GatewayKeyPort | undefined;
  readonly #proseResponder: ProseResponder | undefined;
  /** Last turn per session that already spent its one prose autoresponse. */
  readonly #proseAutorespondedTurns = new Map<string, string>();
  readonly #factsMemory: HraFactsMemoryLifecyclePort | undefined;
  readonly #daemonGeneration: number;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #mutationTails = new Map<string, Promise<unknown>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #operations = new Set<Promise<void>>();
  readonly #projectionRecoveriesInFlight = new Set<string>();
  /** Immediate in-memory admission fence for a durable personal-authority revocation. */
  readonly #profileAuthorityRevocationsPending = new Map<string, number>();
  readonly #profileAuthorityRevocationTasks = new Map<string, Promise<void>>();
  /** Provider-home replacements fence only the sessions owned by that home. */
  readonly #providerAccountRevocationTasks = new Map<string, Promise<void>>();
  /** Short-lived fact-path cache; every controlling effect forces a fresh read. */
  readonly #personalAccountAttestations = new Map<string, PersonalAccountAttestation>();
  readonly #personalAccountChecks = new Map<string, Promise<string>>();
  readonly #sessionFactEpochs = new Map<string, number>();
  readonly #backgroundDiagnostics = new Map<BackgroundDiagnosticCode, BackgroundDiagnostic>();
  #lastBackgroundDiagnostic: BackgroundDiagnostic | null = null;
  readonly #sessionProviderConnections = new Map<string, string>();
  readonly #sessionFactAuthorities = new Map<string, SessionFactAuthority>();
  readonly #sessionObservationFailures = new Map<string, string>();
  readonly #sessionResubscriptionConnections = new Map<string, string>();
  readonly #sessionsAwaitingResubscription = new Set<string>();
  readonly #queuePreEffectRetryCounts = new Map<string, number>();
  readonly #queuePreEffectRetryScheduled = new Set<string>();
  /** Same-daemon Codex claims whose exact controller release was not proven. */
  readonly #unprovenCodexAdoptionClaims = new Set<string>();
  readonly #usageRefreshes = new Map<string, Promise<void>>();
  readonly #usageRefreshDirty = new Set<string>();
  readonly #sessionListTraversals = new Map<string, SessionListTraversalReplayState>();
  #personalCodexAutomationCursor: string | null = null;
  readonly #backgroundAbort = new AbortController();
  readonly #interactionDeadlineAbort = new AbortController();
  #interactionDeadlineTask: Promise<void> | undefined;
  #interactionDeadlineWake: (() => void) | undefined;
  #sessionTaskPumpTask: Promise<void> | undefined;
  #sessionTaskPumpWake: (() => void) | undefined;
  #sessionTaskPumpWakeRevision = 0;
  #stopScheduled = false;
  #state: "open" | "closing" | "closed" = "open";
  #terminalFactsMemoryRevision = 1;
  #terminalFactsMemoryReconciledRevision = 0;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    store: StateStore;
    paths: StatePaths;
    codex: CodexRuntimePort;
    /** Omitted on a machine with no admitted `claude` binary. */
    claude?: ClaudeRuntimePort;
    /** Dedicated runtimes for sessions claimed from the OS user's provider homes. */
    personalCodex?: CodexRuntimePort;
    personalClaude?: ClaudeRuntimePort;
    personalCodexHome?: string;
    personalDiscovery?: PersonalSessionDiscoveryPort;
    readPersonalCodexAutomations?: (
      request: CodexAutomationAuthorityRequest,
    ) => Promise<CodexAutomationAuthorityScan>;
    claudeProcessLiveness?: ClaudeProcessLivenessProbe;
    cloud: CloudControlPort;
    daemonAuthority: Pick<DaemonAuthorityFence, "assertCurrent" | "close">;
    desktop?: DesktopSwitchPort;
    eventCursors?: SessionEventCursorCodec;
    usageHistoryCursors?: UsageHistoryCursorCodec;
    eventWaiters?: SessionEventWaiters;
    factsMemory?: HraFactsMemoryLifecyclePort;
    gatewayKeys?: GatewayKeyPort;
    proseResponder?: ProseResponder;
    workWaiters?: WorkEventWaiters;
    workCapabilities?: WorkCapabilityCodec;
    daemonGeneration?: number;
    platform?: NodeJS.Platform;
    now?: () => number;
    requestStop: () => void;
  }) {
    this.#store = input.store;
    this.#paths = input.paths;
    this.#codex = input.codex;
    this.#claude = input.claude ?? new UnavailableClaudeRuntime(CLAUDE_PIN);
    this.#personalCodex = input.personalCodex;
    this.#personalClaude = input.personalClaude;
    this.#personalCodexHome = input.personalCodexHome;
    this.#personalDiscovery = input.personalDiscovery;
    this.#readPersonalCodexAutomations = input.readPersonalCodexAutomations;
    this.#claudeProcessLiveness = input.claudeProcessLiveness;
    this.#claudeFacts = new ClaudeSessionFactTranslator({
      authorityFor: (providerThreadId, requestId) =>
        this.#claude.interactionAuthority(providerThreadId, requestId),
      now: () => this.#now(),
    });
    this.#personalClaudeFacts = this.#personalClaude === undefined
      ? undefined
      : new ClaudeSessionFactTranslator({
          authorityFor: (providerThreadId, requestId) =>
            this.#personalClaude?.interactionAuthority(providerThreadId, requestId)
              ?? this.#claude.interactionAuthority(providerThreadId, requestId),
          now: () => this.#now(),
        });
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
    this.#sessionTasks = this.#store.createSessionTaskStore();
    this.#gatewayKeys = input.gatewayKeys;
    this.#proseResponder = input.proseResponder;
    this.#factsMemory = input.factsMemory;
    this.#daemonGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      .parse(input.daemonGeneration ?? 0);
    this.#platform = input.platform ?? process.platform;
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
        case "account.show": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => command.provider === "claude" ? this.#showClaudeAccount(profile.id, context.signal) : this.#showAccount(profile.id, context.signal)); }
        case "account.login": {
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize("session-adoption:codex", async () =>
            await this.#serialize("session-adoption:claude", async () =>
              await this.#serialize(`account:${profile.id}`, async () =>
                await this.#login(
                  profile.id,
                  command.deviceCode,
                  command.idempotencyKey,
                  context.signal,
                ))));
        }
        case "account.claude-login.prepare": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#prepareClaudeLogin(profile.id, command.idempotencyKey, context.signal)); }
        case "account.claude-login.complete": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#completeClaudeLogin({ ...command, account: profile.id }, context.signal)); }
        case "account.claude-login.abandon": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#abandonClaudeLogin({ ...command, account: profile.id })); }
        case "account.login-cancel": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#cancelLogin(profile.id, command.idempotencyKey, context.signal)); }
        case "account.logout": {
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize("session-adoption:codex", async () =>
            await this.#serialize("session-adoption:claude", async () =>
              await this.#serialize(`account:${profile.id}`, async () =>
                await this.#logout(profile.id, command.idempotencyKey, context.signal))));
        }
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
        case "session.archive": {
          const session = this.#store.requireSession(command.session);
          this.#assertSessionAccountAuthorityIfSignedIn(session);
          const archived = this.#store.setSessionArchived(session.id, command.archived);
          return {
            version: 1,
            session: archived.id,
            archived: archived.archivedAt !== undefined,
            archivedAt: archived.archivedAt ?? null,
          };
        }
        case "session.adoption.status": return this.#sessionAdoptionStatus(command.provider);
        case "session.adoption.set": return await this.#serialize(
          `session-adoption:${command.provider}`,
          async () => await this.#setSessionAdoption(command, context.signal),
        );
        case "session.adoption.discover": return await this.discoverPersonalSessions(
          command.provider,
          context.signal,
        );
        case "session.list": {
          if (command.account === undefined) {
            return await this.#listSessions(
              undefined,
              command.limit,
              command.cursor,
              command.archived,
              context.signal,
            );
          }
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize(`account:${profile.id}`, async () => this.#listSessions(
            profile.id,
            command.limit,
            command.cursor,
            command.archived,
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
        case "session.state": {
          const session = this.#store.requireSession(command.session);
          const durable = this.#store.readSessionState(session.id);
          return {
            version: 1,
            session: session.id,
            state: durable?.state ?? null,
            attention: durable?.attention ?? false,
            reason: durable?.reason ?? "",
            verbatimRequired: durable?.verbatimRequired ?? false,
            lastActivityAt: durable?.lastActivityAt ?? null,
            revision: durable?.revision ?? 0,
          };
        }
        case "autorespond.status": {
          const session = command.session === undefined ? null : this.#store.requireSession(command.session);
          const mode = session === null
            ? { mode: this.#store.readDefaultApprovalMode(), source: "default" as const }
            : this.#store.readSessionApprovalMode(session.id);
          return {
            version: 1,
            ...(session === null ? {} : { session: session.id }),
            mode: mode.mode,
            source: mode.source,
            // Status carries only whether a key exists, never any part of it.
            gateway: await this.#gatewayConfigured() ? "configured" : "not configured",
            counts: this.#store.countAutorespondEvidence(session === null ? {} : { sessionId: session.id }),
            ...(session === null ? {} : { budgets: this.#store.readAutorespondBudgets(session.id) }),
            recent: this.#store.listAutorespondEvidence({ ...(session === null ? {} : { sessionId: session.id }), limit: 20 }),
          };
        }
        case "autorespond.gateway-set": {
          const custody = this.#requireGatewayKeys();
          await custody.set(command.key);
          return { version: 1, gateway: "configured" };
        }
        case "autorespond.gateway-clear": {
          const custody = this.#requireGatewayKeys();
          const cleared = await custody.clear();
          return { version: 1, cleared, gateway: "not configured" };
        }
        case "autorespond.set": {
          if (command.session === undefined) {
            if (command.mode === null) throw new CommandFailure("INVALID_INPUT", "The default approval mode cannot be cleared.");
            this.#store.setDefaultApprovalMode(command.mode);
            return { version: 1, mode: command.mode, source: "default" };
          }
          const session = this.#store.requireSession(command.session);
          this.#assertSessionAccountAuthorityIfSignedIn(session);
          this.#store.setSessionApprovalMode(session.id, command.mode);
          const effective = this.#store.readSessionApprovalMode(session.id);
          return { version: 1, session: session.id, mode: effective.mode, source: effective.source };
        }
        case "remote.policy-set": {
          if (command.switch === "device-commands") {
            this.#store.setDeviceCommandsAllowed(command.allowed);
          } else {
            this.#store.setAccountLinkingAllowed(command.allowed);
          }
          return { version: 1, ...this.#store.readDeviceCommandPolicy() };
        }
        case "remote.policy-status":
          return { version: 1, ...this.#store.readDeviceCommandPolicy() };
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
        case "session.send": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#send(session.id, command.message, command.idempotencyKey, context.signal, undefined, "human", command.attachments ?? [])); }
        case "session.queue": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#queue(session.id, command.message, command.idempotencyKey, context.signal, undefined, command.attachments ?? [])); }
        case "session.steer": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#steer(session.id, command.message, command.idempotencyKey, context.signal, undefined, command.attachments ?? [])); }
        case "session.stop": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#stop(session.id, command.idempotencyKey, context.signal)); }
        case "session.rename": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#rename(session.id, command.name, command.idempotencyKey, context.signal)); }
        case "session.recover": {
          const session = this.#store.requireSession(command.session);
          return await this.#serializeSessionAuthorityAcrossProfiles(
            session,
            this.#sessionRecoveryProfileIds(session),
            async () => this.#resolveSessionRecovery(session.id, "recover", context.signal),
          );
        }
        case "session.abandon": {
          const session = this.#store.requireSession(command.session);
          return await this.#serializeSessionAuthorityAcrossProfiles(
            session,
            this.#sessionRecoveryProfileIds(session),
            async () => {
              const current = this.#store.requireSession(session.id);
              if (current.state === "recovery_required") {
                await this.#cleanupFactsMemory(current, "abandon");
              }
              const result = await this.#resolveSessionRecovery(
                current.id,
                "abandon",
                context.signal,
              );
              const terminal = this.#store.requireSession(current.id);
              const binding = this.#store.readSessionPersonalRuntimeBinding(terminal.id, true);
              if (
                binding !== null
                && binding.state !== "detached"
                && binding.provider === terminal.provider
                && binding.providerThreadId === terminal.providerThreadId
              ) {
                if (binding.state === "active") {
                  this.#clearSessionFactAuthority(terminal.id);
                  this.#store.beginPersonalSessionDetach({ sessionId: terminal.id });
                }
                this.#scheduleTerminalPersonalDetach(terminal);
              } else if (
                terminal.provider === "claude"
                && terminal.providerThreadId !== undefined
              ) {
                this.#scheduleClaudeProcessAuthorityRelease({
                  providerThreadId: terminal.providerThreadId,
                  profileId: terminal.profileId,
                  runtimeScope: "managed",
                });
              }
              return result;
            },
          );
        }
        case "session.note.get": { const session = this.#store.requireSession(command.session); return { sessionId: session.id, note: session.note, revision: session.revision }; }
        case "session.note.edit": throw new CommandFailure("INTERACTION_REQUIRED", "Open the editor through the local `hra session note edit` command.");
        case "session.note.set": return { session: await this.#updateSession(command.session, (session) => ({ note: command.note, expectedRevision: session.revision })) };
        case "session.note.clear": return { session: await this.#updateSession(command.session, (session) => ({ note: "", expectedRevision: session.revision })) };
        case "session.preset": return { session: await this.#updateSession(command.session, (session) => ({ preset: command.preset, expectedRevision: session.revision })) };
        case "session.switch": {
          const replay = this.#settledProviderSwitchReplay(command);
          if (replay.matched) return replay.value;
          const session = this.#store.requireSession(command.session);
          const targetProfileId = command.account === undefined
            ? session.profileId
            : this.#store.requireProfile(command.account).id;
          return await this.#serializeSessionAuthorityAcrossProfiles(
            session,
            [session.profileId, targetProfileId],
            async () => this.#switchProvider(command, context.signal),
          );
        }
        case "session.transcript": return this.#readTranscript(command.session, command.after, command.limit);
        case "session.fast": return { session: await this.#updateSession(command.session, (session) => ({ fastEnabled: command.enabled, expectedRevision: session.revision })) };
        case "session.project": {
          const project = this.#store.requireProject(command.project);
          const session = await this.#updateSession(command.session, (current) => ({ projectId: project.id, expectedRevision: current.revision }));
          this.#resetQueuePreEffectRetries(session.id);
          this.#scheduleIdleQueue(session);
          this.#wakeSessionTaskPump();
          return { session };
        }
        case "session.task.list": {
          const session = this.#store.requireSession(command.session);
          return {
            scope: "conversation",
            sessionId: session.id,
            tasks: this.#sessionTasks.list(session.id),
          };
        }
        case "session.task.show": {
          const session = this.#store.requireSession(command.session);
          return this.#sessionTasks.require(session.id, command.task);
        }
        case "session.task.create": {
          const session = this.#requireBoundSession(command.session);
          const task = await this.#serializeSessionAuthority(session, () => {
            const current = this.#requireBoundSession(session.id);
            return this.#sessionTasks.create({
              sessionId: current.id,
              name: command.name,
              prompt: command.prompt,
              minutes: command.everyMinutes,
              status: command.paused ? "paused" : "active",
              idempotencyKey: command.idempotencyKey,
            });
          });
          this.#wakeSessionTaskPump();
          return task;
        }
        case "session.task.edit": {
          const session = this.#store.requireSession(command.session);
          const task = await this.#serializeSessionAuthority(
            session,
            () => this.#sessionTasks.edit({
              sessionId: session.id,
              taskId: command.task,
              expectedRevision: command.expectedRevision,
              patch: {
                ...(command.name === undefined ? {} : { name: command.name }),
                ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
                ...(command.everyMinutes === undefined ? {} : { minutes: command.everyMinutes }),
                ...(command.status === undefined ? {} : { status: command.status }),
              },
              idempotencyKey: command.idempotencyKey,
            }),
            { allowDuringProjectionRecovery: true },
          );
          this.#wakeSessionTaskPump();
          return task;
        }
        case "session.task.delete": {
          const session = this.#store.requireSession(command.session);
          const result = await this.#serializeSessionAuthority(
            session,
            () => this.#sessionTasks.delete({
              sessionId: session.id,
              taskId: command.task,
              expectedRevision: command.expectedRevision,
              idempotencyKey: command.idempotencyKey,
            }),
            { allowDuringProjectionRecovery: true },
          );
          this.#wakeSessionTaskPump();
          return result;
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
        case "device.approve": return await this.#fencedEffect(async () => await this.#cloud.approveDevice(command.device, command.idempotencyKey, command.fingerprint, context.signal));
        case "device.revoke": return await this.#fencedEffect(async () => await this.#cloud.revokeDevice(command.device, command.idempotencyKey, context.signal));
        case "sync.status": return await this.#fencedEffect(async () => await this.#cloud.status(context.signal));
        case "sync.now": return await this.#fencedEffect(async () => await this.#cloud.sync(context.signal));
        case "sync.projection-recover": {
          const selected = this.#store.requireSession(command.session);
          const admission = await this.#serializeSessionAuthority(selected, async () => {
            if (
              this.#projectionRecoveriesInFlight.has(selected.id)
              || this.#profileHasProjectionRecoveryInFlight(selected.profileId)
            ) {
              throw new CommandFailure(
                "RECOVERY_REQUIRED",
                "This session or account already has a compact-projection recovery in flight.",
              );
            }
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
              if (replay.status === "found") {
                return { kind: "replay", result: replay.result } as const;
              }
            }
            const session = this.#requireBoundSession(selected.id);
            if (session.profileId !== selected.profileId) {
              throw new CommandFailure(
                "CONFLICT",
                "The session account changed before projection recovery admission.",
              );
            }
            const profile = this.#store.requireProfile(session.profileId);
            const expected = {
              acknowledgeGap: command.acknowledgeGap,
              idempotencyKey: command.idempotencyKey,
              processGeneration: profile.processGeneration,
              profileId: profile.id,
              providerThreadId: session.providerThreadId,
              sessionId: session.id,
            } as const;
            await this.#assertCompactProjectionRecoveryReady(expected);
            if (this.#profileHasProjectionRecoveryInFlight(profile.id)) {
              throw new CommandFailure(
                "RECOVERY_REQUIRED",
                "This account already has a compact-projection recovery in flight.",
              );
            }
            // This in-memory fence closes the pre-journal admission window.
            // Release the account/session tails before calling cloud: its
            // provider-read callback reacquires both tails through the public
            // exact-reader seam.
            this.#projectionRecoveriesInFlight.add(session.id);
            return { kind: "admitted", expected } as const;
          }, { allowDuringProjectionRecovery: true });
          if (admission.kind === "replay") return admission.result;
          try {
            return await this.#recoverCompactProjection(
              admission.expected,
              context.signal,
            );
          } finally {
            this.#projectionRecoveriesInFlight.delete(admission.expected.sessionId);
          }
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
      if (error instanceof SessionTaskStoreError) {
        const details = { reason: error.code };
        switch (error.code) {
          case "NOT_FOUND":
          case "SESSION_NOT_FOUND":
            throw new CommandFailure("NOT_FOUND", error.message, details);
          case "TASK_LIMIT":
          case "SCHEDULE_OVERFLOW":
            throw new CommandFailure("INVALID_INPUT", error.message, details);
          case "DAEMON_AUTHORITY_CHANGED":
          case "TIMESTAMP_OVERFLOW":
            throw new CommandFailure("UNAVAILABLE", error.message, details);
          case "IDEMPOTENCY_CONFLICT":
          case "IDEMPOTENCY_REPLAY_SUPERSEDED":
          case "NO_CHANGES":
          case "RECEIPT_CAPACITY_EXHAUSTED":
          case "REVISION_CONFLICT":
            throw new CommandFailure("CONFLICT", error.message, details);
        }
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
      if (error instanceof KeyRotationRequiredError) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          `${error.message} Inspect the account key with \`hra auth status\` and rotate it through the account-key recovery flow it names.`,
          { nextCommand: "hra auth status", reason: error.code },
        );
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
      if (error instanceof ClaudeError) throw claudeCommandFailure(error);
      // A provider this machine cannot run at all is reported verbatim: the
      // message names the exact release the operator has to install.
      if (error instanceof ProviderRuntimeUnavailableError) {
        throw new CommandFailure("UNAVAILABLE", error.message, {
          reason: "provider_runtime_unavailable",
        });
      }
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
      await this.#reconcileTerminalFactsMemory();
      await this.#factsMemory?.sweepExpired(this.#now());
      const result = await this.#executeRemoteAdmitted(command, expectedAuthority, context);
      await this.#reconcileCommittedSessionFactsMemory(
        this.#store.requireSession(expectedAuthority.sessionId),
      );
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

  /**
   * Supplies cloud reconciliation with an exact provider projection without
   * letting that adapter select a runtime or provider home on its own.
   */
  async readSessionProjectionForCloud(
    sessionId: SessionRecord["id"],
    signal: AbortSignal,
  ): Promise<CodexSessionProjection> {
    const finish = this.#beginOperation();
    try {
      signal.throwIfAborted();
      await this.#daemonAuthority.assertCurrent();
      const selected = this.#store.requireSession(sessionId);
      return await this.#serializeSessionAuthority(selected, async () => {
        signal.throwIfAborted();
        await this.#daemonAuthority.assertCurrent();
        const session = this.#store.requireSession(selected.id);
        if (session.profileId !== selected.profileId) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The session account changed before cloud projection authority was acquired.",
          );
        }
        const bound = this.#requireBoundSession(session.id);
        const profile = this.#store.requireProfileById(bound.profileId);
        this.#assertEstablishedSessionAccount(profile, bound);
        const projection = await this.#readExactSessionProjection(
          bound,
          profile,
          false,
          signal,
        );
        signal.throwIfAborted();
        await this.#daemonAuthority.assertCurrent();
        const exactSession = this.#store.requireSession(bound.id);
        const exactProfile = this.#store.requireProfileById(profile.id);
        if (
          exactSession.profileId !== bound.profileId
          || exactSession.provider !== bound.provider
          || exactSession.providerThreadId !== bound.providerThreadId
          || exactSession.state === "recovery_required"
          || exactSession.state === "terminal"
          || exactProfile.processGeneration !== profile.processGeneration
          || !this.#profileAllowsEstablishedSession(exactProfile, exactSession)
        ) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The session authority changed during the cloud projection read.",
          );
        }
        return projection;
      }, { allowDuringProjectionRecovery: true });
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
    if (command.kind !== "interaction.resolve" && command.session !== expected.sessionId) {
      throw new CommandFailure("CONFLICT", "The remote command selector does not match its exact session authority.");
    }
    if (command.kind === "session.switch") {
      const replay = this.#settledProviderSwitchReplay(command);
      if (replay.matched) return replay.value;
    }
    const targetProfileId = command.kind === "session.switch" && command.account !== undefined
      ? this.#store.requireProfile(command.account).id
      : expected.profileId;
    return await this.#serializeSessionAuthorityAcrossProfiles(
      { id: expected.sessionId, profileId: expected.profileId },
      [expected.profileId, targetProfileId],
      async () => {
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
      this.#assertEstablishedSessionAccount(profile, session);
      switch (command.kind) {
        case "session.send": return await this.#send(session.id, command.message, command.idempotencyKey, context.signal, undefined, "human", command.attachments ?? []);
        case "session.queue": return await this.#queue(session.id, command.message, command.idempotencyKey, context.signal, undefined, command.attachments ?? []);
        case "session.steer": return await this.#steer(session.id, command.message, command.idempotencyKey, context.signal, undefined, command.attachments ?? []);
        case "session.stop": return await this.#stop(session.id, command.idempotencyKey, context.signal);
        case "session.rename": return await this.#rename(session.id, command.name, command.idempotencyKey, context.signal);
        case "session.preset": return {
          session: this.#store.updateSessionMetadata({
            expectedRevision: session.revision,
            preset: command.preset,
            sessionId: session.id,
          }),
        };
        case "session.switch": return await this.#switchProvider(command, context.signal);
        case "session.fast": return {
          session: this.#store.updateSessionMetadata({
            expectedRevision: session.revision,
            fastEnabled: command.enabled,
            sessionId: session.id,
          }),
        };
        case "interaction.resolve": {
          // A remote decision must name an interaction of this exact session;
          // the ordinary resolve path then enforces revision, state, deadline,
          // and provider-offered decisions.
          const interaction = this.#store.requireInteraction(command.interaction);
          if (interaction.sessionId !== session.id) {
            throw new CommandFailure("CONFLICT", "The remote decision names an interaction of another session.");
          }
          return await this.#serialize(`interaction:${command.interaction}`, async () =>
            await this.#resolveInteractionLocked(command, { signal: context.signal }));
        }
      }
      },
    );
  }

  #scheduleStop(afterResponse?: (callback: () => void) => void): void {
    if (this.#stopScheduled) return;
    this.#stopScheduled = true;
    (afterResponse ?? ((callback) => setTimeout(callback, 0)))(this.#requestStop);
  }

  #failStopAfterResetJournalFailure(message: string): void {
    this.#state = "closing";
    this.#interactionDeadlineAbort.abort(new Error(message));
    this.#interactionDeadlineWake?.();
    this.#interactionDeadlineWake = undefined;
    this.#daemonAuthority.close();
    this.#scheduleStop();
  }

  close(): Promise<void> {
    if (this.#closeTask !== undefined) return this.#closeTask;
    this.#state = "closing";
    this.#sessionFactAuthorities.clear();
    this.#backgroundAbort.abort(new Error("HRA service is closing."));
    this.#interactionDeadlineAbort.abort(new Error("HRA service is closing."));
    this.#interactionDeadlineWake?.();
    this.#interactionDeadlineWake = undefined;
    this.#sessionTaskPumpWake?.();
    this.#sessionTaskPumpWake = undefined;
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
    // A launch intent can span an actual child launch before PID/start
    // admission. Never delete or step past it: an unidentified live child is
    // a harder boundary than a pending revocation and requires exact recovery.
    if (this.#store.listClaudeProcessLaunchIntents().length > 0) {
      throw new Error(
        "Daemon recovery cannot run while a Claude process launch intent is unresolved.",
      );
    }
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
    await this.#recoverProfilePersonalAuthorityRevocations(
      this.#interactionDeadlineAbort.signal,
    );
    await this.#recoverProviderRuntimeAccountRevocations(
      this.#interactionDeadlineAbort.signal,
    );
    await this.#reconcileTerminalFactsMemory();
    await this.#recoverPreparedWorkEffects(this.#interactionDeadlineAbort.signal);
    await this.#recoverClaudeProcessAuthorities(this.#interactionDeadlineAbort.signal);
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
      if (this.#profileAllowsEstablishedSession(profile, session)) {
        this.#scheduleQueueDispatch(session);
      }
    }
    let continueAfterId: string | null = null;
    const sessionsToReconnect: SessionRecord[] = [];
    for (;;) {
      const page = this.#store.listCloudSessionPage({
        afterId: continueAfterId,
        limit: 100,
      });
      for (const session of page.sessions) {
        if (session.providerThreadId === undefined) continue;
        const binding = this.#store.readSessionPersonalRuntimeBinding(session.id, true);
        const bindingMatches = binding !== null
          && binding.provider === session.provider
          && binding.providerThreadId === session.providerThreadId;
        if (bindingMatches && binding.state === "detaching") {
          try {
            if (session.provider === "codex") {
              const runtime = this.#personalCodex;
              if (runtime === undefined || runtime.releaseOwnedAuthority === undefined) {
                throw new ProviderRuntimeUnavailableError(
                  "Personal-home Codex control cannot finish detach recovery.",
                );
              }
              const profile = this.#store.requireProfileById(session.profileId);
              const authority = this.#personalAuthorityForProfile(profile);
              await runtime.releaseOwnedAuthority({
                authority,
                signal: new AbortController().signal,
              });
            } else {
              const process = this.#store.readClaudeProcessAuthority({
                providerThreadId: session.providerThreadId,
                profileId: session.profileId,
                runtimeScope: "personal",
              });
              if (process?.state !== "released") {
                throw new ProviderRuntimeUnavailableError(
                  "Claude detach recovery is waiting for exact process release.",
                );
              }
            }
            this.#store.completePersonalSessionDetach({ sessionId: session.id });
          } catch (error: unknown) {
            this.recordBackgroundDiagnostic("session_adoption_failed", error);
          }
          continue;
        }
        if (session.state === "terminal" || session.state === "recovery_required") continue;
        if (bindingMatches && binding.state === "detached") continue;
        const usesPersonalRuntime = bindingMatches && binding.state === "active";
        this.#sessionsAwaitingResubscription.add(session.id);
        const profile = this.#store.requireProfile(session.profileId);
        if (
          (session.state === "active" || session.provider === "claude" || usesPersonalRuntime)
          && this.#profileAllowsEstablishedSession(profile, session)
        ) {
          if (session.provider === "claude") {
            const process = this.#store.readClaudeProcessAuthority({
              providerThreadId: session.providerThreadId,
              profileId: session.profileId,
              runtimeScope: usesPersonalRuntime ? "personal" : "managed",
            });
            if (
              process === null
              || process.state !== "released"
              || (process.sessionId !== null && process.sessionId !== session.id)
            ) {
              if (process === null) this.#quarantineSession(session.id);
              continue;
            }
          }
          sessionsToReconnect.push(session);
        }
      }
      if (page.isDone || page.continueAfterId === null) break;
      continueAfterId = page.continueAfterId;
    }
    this.#scheduleRecoverySessionObservations(sessionsToReconnect);
    this.#wakeInteractionDeadlinePump();
    this.#wakeSessionTaskPump();
  }

  async #recoverClaudeProcessAuthorities(signal: AbortSignal): Promise<void> {
    for (const process of this.#store.listUnreleasedClaudeProcessAuthorities()) {
      signal.throwIfAborted();
      try {
        await this.#releaseClaudeProcessAuthority(process, signal);
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason;
        this.recordBackgroundDiagnostic("recovery_observation_failed", error);
      }
    }
    // A crash may land after personal-session detach was durably staged but
    // before its Claude child was released. The first recovery pass above now
    // owns that exact release; finish the already-authorized detach in the same
    // boot instead of requiring a second restart merely to observe `released`.
    for (;;) {
      const detaching = this.#store.listSessionPersonalRuntimeBindings({
        provider: "claude",
        state: "detaching",
        limit: 500,
      });
      if (detaching.length === 0) break;
      let progressed = false;
      for (const binding of detaching) {
        signal.throwIfAborted();
        const session = this.#store.requireSession(binding.sessionId);
        const process = this.#store.readClaudeProcessAuthority({
          providerThreadId: binding.providerThreadId,
          profileId: session.profileId,
          runtimeScope: "personal",
        });
        if (process?.state !== "released") continue;
        this.#store.completePersonalSessionDetach({ sessionId: binding.sessionId });
        progressed = true;
      }
      if (!progressed) break;
    }
  }

  async #recoverProfilePersonalAuthorityRevocations(signal: AbortSignal): Promise<void> {
    for (const revocation of this.#store.listReleasingProfilePersonalAuthorityRevocations()) {
      this.#profileAuthorityRevocationsPending.set(
        revocation.profileId,
        revocation.profileGeneration,
      );
    }
    for (const revocation of this.#store.listReleasingProfilePersonalAuthorityRevocations()) {
      signal.throwIfAborted();
      try {
        await this.#runProfilePersonalAuthorityRevocation(
          revocation.profileId,
          revocation.profileGeneration,
          signal,
        );
        if (
          this.#profileAuthorityRevocationsPending.get(revocation.profileId)
          === revocation.profileGeneration
        ) this.#profileAuthorityRevocationsPending.delete(revocation.profileId);
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason;
        this.recordBackgroundDiagnostic("profile_authority_revocation_failed", error);
      }
    }
  }

  async #recoverProviderRuntimeAccountRevocations(signal: AbortSignal): Promise<void> {
    for (const revocation of this.#store.listReleasingProviderRuntimeAccountRevocations()) {
      signal.throwIfAborted();
      this.#clearProfileFactAuthorities(
        revocation.profileId,
        revocation.provider,
        revocation.runtimeScope,
      );
      await this.#serialize(`session-adoption:${revocation.provider}`, async () =>
        await this.#serialize(`account:${revocation.profileId}`, async () =>
          await this.#runProviderRuntimeAccountRevocation(
            revocation,
            signal,
          )));
    }
  }

  #scheduleClaudeProcessAuthorityRelease(key: ClaudeProcessAuthorityKey): void {
    const task = Promise.resolve().then(async () => {
      await this.#releaseClaudeProcessAuthority(
        key,
        this.#backgroundAbort.signal,
      );
    });
    const tracked = task.catch((error: unknown) => {
      if (this.#backgroundAbort.signal.aborted) return;
      this.recordBackgroundDiagnostic("recovery_observation_failed", error);
    });
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #scheduleClaudeDisconnectRecovery(sessions: readonly SessionRecord[]): void {
    if (this.#state !== "open" || sessions.length === 0) return;
    const task = (async () => {
      for (const disconnected of sessions) {
        if (this.#state !== "open") return;
        await this.#serializeSessionAuthority(
          disconnected,
          async () => {
            let current: SessionRecord;
            try {
              current = this.#store.requireSession(disconnected.id);
            } catch (error: unknown) {
              if (error instanceof SelectionError && error.code === "NOT_FOUND") return;
              throw error;
            }
            if (
              current.profileId !== disconnected.profileId
              || current.provider !== "claude"
              || current.provider !== disconnected.provider
              || current.providerThreadId === undefined
              || current.providerThreadId !== disconnected.providerThreadId
            ) return;

            const binding = this.#store.readSessionPersonalRuntimeBinding(current.id, true);
            const bindingMatches = binding !== null
              && binding.provider === current.provider
              && binding.providerThreadId === current.providerThreadId;
            if (binding?.state === "active" && !bindingMatches) {
              throw new ProviderRuntimeUnavailableError(
                "The personal-home session binding no longer matches its durable session identity.",
              );
            }
            const runtimeScope = bindingMatches ? "personal" : "managed";
            const profile = this.#store.requireProfileById(current.profileId);
            if (
              current.state === "terminal"
              || current.state === "recovery_required"
              || !this.#profileAllowsEstablishedSession(profile, current)
              || (bindingMatches && binding.state !== "active")
            ) {
              const process = this.#store.readClaudeProcessAuthority({
                providerThreadId: current.providerThreadId,
                profileId: current.profileId,
                runtimeScope,
              });
              if (process !== null && process.state !== "released") {
                await this.#releaseClaudeProcessAuthority(
                  process,
                  new AbortController().signal,
                );
              }
              return;
            }

            // The disconnect callback can be delayed until a foreground
            // recovery has already bound a replacement child. Re-observe the
            // session under its authority tail so that healthy replacement is
            // retained; the central Claude observation-recovery path releases
            // only the exact currently persisted process when repair is needed.
            await this.#ensureSessionObservedLocked(
              current.id,
              new AbortController().signal,
            );
          },
          { allowDuringProjectionRecovery: true },
        ).catch((error: unknown) => {
          this.recordBackgroundDiagnostic("recovery_observation_failed", error);
        });
      }
    })();
    const tracked = task.catch((error: unknown) => {
      if (this.#backgroundAbort.signal.aborted) return;
      this.recordBackgroundDiagnostic("recovery_observation_failed", error);
    });
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #scheduleTerminalPersonalDetach(session: SessionRecord): void {
    const task = this.#serialize(`session-adoption:${session.provider}`, async () =>
      await this.#serializeSessionAuthority(
        session,
        async () => { await this.#detachPersonalSession(session.id, this.#backgroundAbort.signal); },
        { allowDuringProjectionRecovery: true },
      ));
    const tracked = task.catch((error: unknown) => {
      if (this.#backgroundAbort.signal.aborted) return;
      this.recordBackgroundDiagnostic("session_adoption_failed", error);
    });
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #profileAuthorityRevocationIsPending(
    profileId: ProfileRecord["id"],
    processGeneration?: number,
  ): boolean {
    const pending = this.#profileAuthorityRevocationsPending.get(profileId);
    return pending !== undefined
      && (processGeneration === undefined || pending === processGeneration);
  }

  #providerRuntimeAccountRevocationIsPending(
    profileId: ProfileRecord["id"],
    profileGeneration: number,
    provider: Provider,
    runtimeScope: RuntimeAccountScope,
  ): boolean {
    const revocation = this.#store.readProviderRuntimeAccountRevocation({
      profileId,
      provider,
      runtimeScope,
    });
    return revocation?.state === "releasing"
      && revocation.profileGeneration === profileGeneration;
  }

  #profileHasControllingRuntimeAuthority(
    profile: Pick<ProfileRecord, "id" | "processGeneration">,
  ): boolean {
    return this.#store.profileHasControllingPersonalSessions(profile.id)
      || this.#store.profileHasClaudeProcessLaunchIntents(
        profile.id,
      )
      || this.#store.profileHasUnreleasedClaudeProcessAuthorities(
        profile.id,
      );
  }

  async #releaseProfileClaudeControllersLocked(
    profile: Pick<ProfileRecord, "id" | "processGeneration">,
    signal: AbortSignal,
  ): Promise<void> {
    for (const runtimeScope of ["managed", "personal"] as const) {
      let afterProviderThreadId: string | null = null;
      for (;;) {
        const page = this.#store.listUnreleasedClaudeProcessAuthorityPage({
          profileId: profile.id,
          profileGeneration: profile.processGeneration,
          runtimeScope,
          afterProviderThreadId,
          limit: 100,
        });
        for (const process of page.authorities) {
          signal.throwIfAborted();
          await this.#releaseClaudeProcessAuthority(process, signal);
        }
        if (page.continueAfterProviderThreadId === null) break;
        afterProviderThreadId = page.continueAfterProviderThreadId;
      }
    }
    if (this.#store.profileHasUnreleasedClaudeProcessAuthorities(
      profile.id,
    )) {
      throw new ProviderRuntimeUnavailableError(
        "Every Claude controller must be exactly released before account authority can change.",
      );
    }
  }

  #scheduleProfilePersonalAuthorityRevocation(
    profile: Pick<ProfileRecord, "id" | "processGeneration">,
  ): void {
    this.#clearPersonalAccountAttestations(profile.id);
    // Persist and apply the complete authority fence before yielding to the
    // asynchronous controller-release task. A daemon loss or a same-tick
    // command after this callback must see recovery_required sessions, closed
    // interactions, and retired work rather than a merely staged row.
    const begun = this.#store.beginProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      workStore: this.#work,
    });
    this.#notifyAffectedWork(begun.affectedWorkIds);
    for (const sessionId of begun.sessionIds) {
      this.#sessionProviderConnections.delete(sessionId);
      this.#clearSessionFactAuthority(sessionId);
      this.#sessionObservationFailures.delete(sessionId);
      this.#sessionResubscriptionConnections.delete(sessionId);
      this.#sessionsAwaitingResubscription.delete(sessionId);
      this.#eventWaiters.notify(sessionId);
    }
    for (const interaction of begun.interactions) {
      if (interaction.sessionId !== null) this.#eventWaiters.notify(interaction.sessionId);
    }
    this.#profileAuthorityRevocationsPending.set(profile.id, profile.processGeneration);
    if (this.#profileAuthorityRevocationTasks.has(profile.id)) return;
    const task = Promise.resolve().then(async () => {
      await this.#runProfilePersonalAuthorityRevocation(
        profile.id,
        profile.processGeneration,
        this.#backgroundAbort.signal,
      );
      if (this.#profileAuthorityRevocationsPending.get(profile.id) === profile.processGeneration) {
        this.#profileAuthorityRevocationsPending.delete(profile.id);
      }
    });
    const tracked = task.catch((error: unknown) => {
      if (this.#backgroundAbort.signal.aborted) return;
      this.recordBackgroundDiagnostic("profile_authority_revocation_failed", error);
    });
    this.#profileAuthorityRevocationTasks.set(profile.id, tracked);
    this.#background.add(tracked);
    void tracked.then(() => {
      if (this.#profileAuthorityRevocationTasks.get(profile.id) === tracked) {
        this.#profileAuthorityRevocationTasks.delete(profile.id);
      }
      this.#background.delete(tracked);
    });
  }

  async #runProfilePersonalAuthorityRevocation(
    profileId: ProfileRecord["id"],
    expectedGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const revoke = async (): Promise<void> => {
      const profile = this.#store.requireProfileById(profileId);
      if (profile.processGeneration !== expectedGeneration) {
        throw new Error("PROFILE_PERSONAL_AUTHORITY_REVOCATION_STALE");
      }
      const existing = this.#store.readProfilePersonalAuthorityRevocation(profileId);
      if (existing?.state === "completed") {
        if (existing.profileGeneration !== expectedGeneration || profile.state !== "signed_out") {
          throw new Error("PROFILE_PERSONAL_AUTHORITY_REVOCATION_CONFLICT");
        }
        return;
      }
      const bindings = this.#store.listProfileControllingPersonalRuntimeBindings(profileId);
      const interactions = this.#store.listOpenInteractionsForProfile(
        profileId,
        expectedGeneration,
      );
      const claudeProcesses = this.#store.listUnreleasedClaudeProcessAuthoritiesForProfile(
        profileId,
      );
      const sessionIds = this.#nonterminalSessionIdsForProfile(profileId);
      const keys = [
        ...new Set([
          ...sessionIds.map((sessionId) => `session:${sessionId}`),
          ...bindings.map((binding) => `session:${binding.sessionId}`),
          ...claudeProcesses.flatMap((process) => process.sessionId === null
            ? []
            : [`session:${process.sessionId}`]),
        ]),
        ...interactions.map((interaction) => `interaction:${interaction.publicId}`),
      ];
      await this.#serializeKeys(keys, async () => {
        signal.throwIfAborted();
        const begun = this.#store.beginProfilePersonalAuthorityRevocation({
          profileId,
          expectedGeneration,
          workStore: this.#work,
        });
        this.#notifyAffectedWork(begun.affectedWorkIds);
        for (const sessionId of begun.sessionIds) {
          this.#sessionProviderConnections.delete(sessionId);
          this.#clearSessionFactAuthority(sessionId);
          this.#sessionObservationFailures.delete(sessionId);
          this.#sessionResubscriptionConnections.delete(sessionId);
          this.#sessionsAwaitingResubscription.delete(sessionId);
          this.#eventWaiters.notify(sessionId);
        }
        for (const interaction of begun.interactions) {
          if (interaction.sessionId !== null) this.#eventWaiters.notify(interaction.sessionId);
        }

        await this.#releaseProfileClaudeControllersLocked(
          { id: profileId, processGeneration: expectedGeneration },
          signal,
        );
        const exactProfile = this.#store.requireProfileById(profileId, {
          includeRemoved: true,
        });
        if (this.#codex.releaseOwnedAuthority !== undefined) {
          await this.#codex.releaseOwnedAuthority({
            authority: authorityFor(this.#paths, exactProfile),
            signal,
          });
        } else {
          await this.#codex.close();
        }
        if (begun.bindings.some((binding) => binding.provider === "codex")) {
          if (this.#personalCodex === undefined) {
            throw new ProviderRuntimeUnavailableError(
              "Personal-home Codex control is unavailable during authority release.",
            );
          }
          if (this.#personalCodex.releaseOwnedAuthority !== undefined) {
            await this.#personalCodex.releaseOwnedAuthority({
              authority: this.#personalAuthorityForProfile(exactProfile),
              signal,
            });
          } else {
            await this.#personalCodex.close();
          }
        }
        for (const binding of begun.bindings) {
          signal.throwIfAborted();
          const current = this.#store.readSessionPersonalRuntimeBinding(
            binding.sessionId,
            true,
          );
          if (current === null || current.state === "detached") continue;
          this.#store.completePersonalSessionDetach({ sessionId: binding.sessionId });
        }
        this.#store.completeProfilePersonalAuthorityRevocation({
          profileId,
          expectedGeneration,
        });
      });
    };
    await this.#serialize("session-adoption:codex", async () =>
      await this.#serialize("session-adoption:claude", async () =>
        await this.#serialize(`account:${profileId}`, revoke)));
  }

  #nonterminalSessionIdsForProfile(
    profileId: ProfileRecord["id"],
  ): readonly SessionRecord["id"][] {
    const sessionIds: SessionRecord["id"][] = [];
    let afterId: string | null = null;
    for (;;) {
      const page = this.#store.listCloudSessionPage({ afterId, limit: 100 });
      for (const session of page.sessions) {
        if (session.profileId === profileId && session.state !== "terminal") {
          sessionIds.push(session.id);
        }
      }
      if (page.isDone || page.continueAfterId === null) return sessionIds;
      afterId = page.continueAfterId;
    }
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

  /**
   * Records that a background task failed. Only the closed code and a closed
   * cause class are kept; error text never enters the record.
   */
  recordBackgroundDiagnostic(code: BackgroundDiagnosticCode, error?: unknown): void {
    if (this.#state !== "open") return;
    const previous = this.#backgroundDiagnostics.get(code);
    const diagnostic: BackgroundDiagnostic = {
      code,
      cause: classifyBackgroundDiagnosticCause(error),
      count: Math.min((previous?.count ?? 0) + 1, Number.MAX_SAFE_INTEGER),
      observedAt: this.#now(),
    };
    this.#backgroundDiagnostics.set(code, diagnostic);
    this.#lastBackgroundDiagnostic = diagnostic;
  }

  backgroundDiagnostics(): Readonly<{
    last: BackgroundDiagnostic | null;
    byCode: readonly BackgroundDiagnostic[];
  }> {
    return {
      last: this.#lastBackgroundDiagnostic,
      byCode: [...this.#backgroundDiagnostics.values()]
        .sort((left, right) => left.code.localeCompare(right.code)),
    };
  }

  #bumpSessionFactEpoch(sessionId: string): void {
    const next = (this.#sessionFactEpochs.get(sessionId) ?? 0) + 1;
    this.#sessionFactEpochs.delete(sessionId);
    this.#sessionFactEpochs.set(sessionId, next);
    this.#boundSessionFactEpochs();
  }

  /** Snapshots the epoch before a dispatch. The entry is created so a later absence reads as a change. */
  #snapshotSessionFactEpoch(sessionId: string): number {
    const current = this.#sessionFactEpochs.get(sessionId);
    if (current !== undefined) return current;
    this.#sessionFactEpochs.set(sessionId, 0);
    this.#boundSessionFactEpochs();
    return this.#sessionFactEpochs.get(sessionId) ?? -1;
  }

  /** Reads the epoch after a dispatch. A pruned or evicted entry never matches a snapshot. */
  #currentSessionFactEpoch(sessionId: string): number {
    return this.#sessionFactEpochs.get(sessionId) ?? -1;
  }

  #forgetSessionFactEpoch(sessionId: string): void {
    this.#sessionFactEpochs.delete(sessionId);
  }

  #boundSessionFactEpochs(): void {
    while (this.#sessionFactEpochs.size > SESSION_FACT_EPOCH_LIMIT) {
      const oldest = this.#sessionFactEpochs.keys().next();
      if (oldest.done === true) return;
      this.#sessionFactEpochs.delete(oldest.value);
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
      await this.#serializeInteractionAuthority(interaction.publicId, async () => {
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

  /** Runs one bounded scheduled-task materialization batch for deterministic tests. */
  async maintainSessionTasks(): Promise<{ materialized: number }> {
    if (this.#interactionDeadlineMaintenanceStopped()) return { materialized: 0 };
    await this.#daemonAuthority.assertCurrent();
    let materialized = 0;
    while (materialized < 32) {
      const [result] = await this.#sessionTasks.materializeDue({
        now: this.#now(),
        daemonGeneration: this.#daemonGeneration,
      });
      await this.#daemonAuthority.assertCurrent();
      if (result === undefined) break;
      const session = this.#store.requireSession(result.queue.sessionId);
      if (session.state === "idle") {
        this.#scheduleQueueDispatch(session);
      }
      materialized += 1;
    }
    return { materialized };
  }

  #wakeSessionTaskPump(): void {
    if (this.#state !== "open" || this.#interactionDeadlineAbort.signal.aborted) return;
    this.#sessionTaskPumpWakeRevision += 1;
    if (this.#sessionTaskPumpTask === undefined) {
      const task = this.#runSessionTaskPump();
      this.#sessionTaskPumpTask = task;
      void task.finally(() => {
        if (this.#sessionTaskPumpTask === task) this.#sessionTaskPumpTask = undefined;
      }).catch(() => undefined);
      return;
    }
    this.#sessionTaskPumpWake?.();
  }

  async #runSessionTaskPump(): Promise<void> {
    const signal = this.#interactionDeadlineAbort.signal;
    while (this.#state === "open" && !signal.aborted) {
      const observedWakeRevision = this.#sessionTaskPumpWakeRevision;
      let processed: { materialized: number };
      try {
        processed = await this.maintainSessionTasks();
      } catch (error: unknown) {
        if (
          this.#interactionDeadlineMaintenanceStopped()
          || (error instanceof SessionTaskStoreError
            && error.code === "DAEMON_AUTHORITY_CHANGED")
        ) return;
        await this.#waitForSessionTaskPump(60_000, signal, observedWakeRevision);
        continue;
      }
      if (processed.materialized >= 32) continue;
      const next = this.#sessionTasks.nextDueAt();
      const delay = next === null
        ? null
        : next <= this.#now() && processed.materialized === 0
          ? 60_000
          : Math.max(0, next - this.#now());
      await this.#waitForSessionTaskPump(delay, signal, observedWakeRevision);
    }
  }

  async #waitForSessionTaskPump(
    delayMs: number | null,
    signal: AbortSignal,
    observedWakeRevision: number,
  ): Promise<void> {
    if (
      signal.aborted
      || observedWakeRevision !== this.#sessionTaskPumpWakeRevision
    ) return;
    await new Promise<void>((resolveWait) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (this.#sessionTaskPumpWake === finish) this.#sessionTaskPumpWake = undefined;
        resolveWait();
      };
      this.#sessionTaskPumpWake = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (delayMs !== null) {
        timer = setTimeout(finish, Math.min(delayMs, 2_147_483_647));
        timer.unref();
      }
    });
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
    if (!this.#profileAuthorityIsUsable(
      current.authority.profileId,
      current.authority.processGeneration,
      current.authority.method.startsWith("claude/") ? "claude" : "codex",
      current.sessionId ?? undefined,
    )) {
      const terminal = this.#store.expireInteraction({
        id: current.publicId,
        expectedRevision: current.revision,
      });
      this.#appendInteractionState(terminal);
      return;
    }
    const runtime = this.#runtimeForInteraction(current);
    let responseDigest: string;
    try {
      await this.#daemonAuthority.assertCurrent();
      await this.#assertPersonalInteractionAccountAuthority(current, profile, signal);
      const validated = await runtime.validateInteractionTimeout({
        authority: this.#authorityForInteraction(current, profile),
        provider: current.authority,
        signal,
      });
      await this.#assertPersonalInteractionAccountAuthority(current, profile, signal);
      responseDigest = validated.responseDigest;
      if (!this.#profileAuthorityIsUsable(
        current.authority.profileId,
        current.authority.processGeneration,
        current.authority.method.startsWith("claude/") ? "claude" : "codex",
        current.sessionId ?? undefined,
      )) {
        const terminal = this.#store.expireInteraction({
          id: current.publicId,
          expectedRevision: current.revision,
        });
        this.#appendInteractionState(terminal);
        return;
      }
    } catch (error: unknown) {
      if (signal.aborted) return;
      const latest = this.#store.requireInteraction(current.publicId);
      if (latest.state !== "pending" || latest.revision !== current.revision) return;
      const terminal = providerFailureCode(error) === "INDETERMINATE_EFFECT"
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
      await this.#assertPersonalInteractionAccountAuthority(prepared, profile, signal);
      await runtime.timeoutInteraction({
        authority: this.#authorityForInteraction(prepared, profile),
        provider: prepared.authority,
        signal,
      });
      await this.#assertInteractionAccountAuthorityAfterProviderEffect(
        prepared,
        profile,
        signal,
      );
    } catch (error: unknown) {
      if (signal.aborted) return;
      const latest = this.#store.requireInteraction(prepared.publicId);
      if (latest.state !== "response_prepared" || latest.revision !== prepared.revision) return;
      const indeterminate = error instanceof IndeterminateLocalCommitError
        || providerFailureCode(error) === "INDETERMINATE_EFFECT";
      const terminal = indeterminate
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
    await this.#observeProviderFact(authority, fact, "codex", "managed");
  }

  async observePersonalCodexFact(
    authority: ProfileAuthority,
    fact: CodexFact,
  ): Promise<void> {
    await this.#observeProviderFact(authority, fact, "codex", "personal");
  }

  async #observeProviderFact(
    authority: ProfileAuthority,
    fact: CodexFact,
    provider: Provider,
    source: ProviderFactSource,
  ): Promise<void> {
    const finish = this.#beginFactOperation();
    if (finish === null) return;
    try {
      await this.#observeCodexFactAdmitted(authority, fact, provider, source);
    } catch (error: unknown) {
      if (error instanceof InteractionPersistenceBoundaryError) this.#scheduleStop();
      if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
      throw error;
    } finally {
      finish();
    }
  }

  /**
   * One Claude bridge fact, reduced to the daemon's neutral vocabulary and
   * then applied through exactly the same path a Codex fact takes. Everything
   * downstream (transcript events, durable interactions, turn boundaries, the
   * session-state classifier, the compact projection, the live uploader) is
   * therefore provider-agnostic by construction.
   */
  async observeClaudeFact(authority: ProfileAuthority, fact: ClaudeSessionFact): Promise<void> {
    await this.#observeTranslatedClaudeFact(this.#claudeFacts, authority, fact, "managed");
  }

  /** Facts from the dedicated personal-home Claude controller. */
  async observePersonalClaudeFact(
    authority: ProfileAuthority,
    fact: ClaudeSessionFact,
  ): Promise<void> {
    const translator = this.#personalClaudeFacts;
    if (translator === undefined) return;
    await this.#observeTranslatedClaudeFact(translator, authority, fact, "personal");
  }

  async #observeTranslatedClaudeFact(
    translator: ClaudeSessionFactTranslator,
    authority: ProfileAuthority,
    fact: ClaudeSessionFact,
    source: ProviderFactSource,
  ): Promise<void> {
    let translated: readonly CodexFact[];
    try {
      translated = translator.translate(fact);
    } catch (error: unknown) {
      // A control request whose authority the runtime can no longer prove is
      // a dropped fact, never a fault on a live session.
      this.recordBackgroundDiagnostic("claude_fact_untranslatable", error);
      return;
    }
    for (const neutral of translated) {
      await this.#observeProviderFact(authority, neutral, "claude", source);
    }
  }

  /** The port that runs one provider's sessions, turns, and interactions. */
  #sessionRuntime(provider: Provider): SessionRuntimePort<ReviewedRuntimeProfile> {
    return provider === "claude" ? this.#claude : this.#codex;
  }

  #personalSessionRuntime(provider: Provider): SessionRuntimePort<ReviewedRuntimeProfile> {
    const runtime = provider === "claude" ? this.#personalClaude : this.#personalCodex;
    if (runtime !== undefined) return runtime;
    throw new ProviderRuntimeUnavailableError(
      `Personal-home ${provider} session control is unavailable on this daemon.`,
    );
  }

  #personalAccountAttestationKey(
    provider: Provider,
    profileId: ProfileRecord["id"],
    runtimeScope: RuntimeAccountScope = "personal",
  ): string {
    return `${runtimeScope}:${provider}:${profileId}`;
  }

  #clearPersonalAccountAttestations(profileId: ProfileRecord["id"]): void {
    this.#personalAccountAttestations.delete(
      this.#personalAccountAttestationKey("codex", profileId),
    );
    this.#personalAccountAttestations.delete(
      this.#personalAccountAttestationKey("claude", profileId),
    );
    this.#personalAccountAttestations.delete(
      this.#personalAccountAttestationKey("codex", profileId, "managed"),
    );
    this.#personalAccountAttestations.delete(
      this.#personalAccountAttestationKey("claude", profileId, "managed"),
    );
    this.#clearProfileFactAuthorities(profileId);
  }

  #scheduleProviderRuntimeAccountRevocation(
    profile: Pick<ProfileRecord, "id" | "processGeneration">,
    provider: Provider,
    runtimeScope: RuntimeAccountScope,
    currentAccountKey: string | null,
  ): void {
    this.#beginProviderRuntimeAccountRevocationFence(
      profile,
      provider,
      runtimeScope,
      currentAccountKey,
    );
    const revocationKey = `${runtimeScope}:${provider}:${profile.id}`;
    // Staging is deliberately above this in-memory dedupe. A second B -> C
    // observation must durably advance the same job even while its B release
    // worker is awaiting the provider.
    if (this.#providerAccountRevocationTasks.has(revocationKey)) return;
    const task = Promise.resolve().then(async () => {
      await this.#serialize(`session-adoption:${provider}`, async () =>
        await this.#serialize(`account:${profile.id}`, async () =>
          await this.#runProviderRuntimeAccountRevocation({
            profileId: profile.id,
            profileGeneration: profile.processGeneration,
            provider,
            runtimeScope,
          }, this.#backgroundAbort.signal)));
    });
    const tracked = task.catch((error: unknown) => {
      if (this.#backgroundAbort.signal.aborted) return;
      this.recordBackgroundDiagnostic(
        "provider_account_authority_revocation_failed",
        error,
      );
    });
    this.#providerAccountRevocationTasks.set(revocationKey, tracked);
    this.#background.add(tracked);
    void tracked.then(() => {
      if (this.#providerAccountRevocationTasks.get(revocationKey) === tracked) {
        this.#providerAccountRevocationTasks.delete(revocationKey);
      }
      this.#background.delete(tracked);
    });
  }

  #beginProviderRuntimeAccountRevocationFence(
    profile: Pick<ProfileRecord, "id" | "processGeneration">,
    provider: Provider,
    runtimeScope: RuntimeAccountScope,
    currentAccountKey: string | null,
  ): ReturnType<StateStore["beginProviderRuntimeAccountRevocation"]> {
    const attestationKey = this.#personalAccountAttestationKey(
      provider,
      profile.id,
      runtimeScope,
    );
    this.#personalAccountAttestations.delete(attestationKey);
    this.#clearProfileFactAuthorities(profile.id, provider, runtimeScope);
    const begun = this.#store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider,
      runtimeScope,
      currentAccountKey,
      workStore: this.#work,
    });
    this.#notifyAffectedWork(begun.affectedWorkIds);
    for (const interaction of begun.interactions) {
      if (interaction.sessionId !== null) this.#eventWaiters.notify(interaction.sessionId);
    }
    for (const sessionId of begun.sessionIds) {
      this.#sessionProviderConnections.delete(sessionId);
      this.#clearSessionFactAuthority(sessionId);
      this.#sessionObservationFailures.delete(sessionId);
      this.#sessionResubscriptionConnections.delete(sessionId);
      this.#sessionsAwaitingResubscription.delete(sessionId);
      this.#eventWaiters.notify(sessionId);
    }
    return begun;
  }

  async #runProviderRuntimeAccountRevocation(
    selector: Pick<
      ProviderRuntimeAccountRevocationRecord,
      "profileId" | "profileGeneration" | "provider" | "runtimeScope"
    >,
    signal: AbortSignal,
    options: Readonly<{ allowEmptyPersonalCodexScope?: boolean }> = {},
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const current = this.#store.readProviderRuntimeAccountRevocation({
        profileId: selector.profileId,
        provider: selector.provider,
        runtimeScope: selector.runtimeScope,
      });
      if (current === null || current.state === "completed") return;
      if (current.profileGeneration !== selector.profileGeneration) {
        throw new Error("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_STALE");
      }
      const exact = this.#store.requireProfileById(selector.profileId, {
        includeRemoved: true,
      });
      if (exact.processGeneration !== selector.profileGeneration) {
        throw new Error("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_STALE");
      }
      const restaged = this.#store.beginProviderRuntimeAccountRevocation({
        profileId: current.profileId,
        expectedGeneration: current.profileGeneration,
        provider: current.provider,
        runtimeScope: current.runtimeScope,
        currentAccountKey: current.currentAccountKey,
        workStore: this.#work,
      });
      this.#notifyAffectedWork(restaged.affectedWorkIds);
      for (const interaction of restaged.interactions) {
        if (interaction.sessionId !== null) this.#eventWaiters.notify(interaction.sessionId);
      }
      for (const sessionId of restaged.sessionIds) {
        this.#sessionProviderConnections.delete(sessionId);
        this.#clearSessionFactAuthority(sessionId);
        this.#sessionObservationFailures.delete(sessionId);
        this.#sessionResubscriptionConnections.delete(sessionId);
        this.#sessionsAwaitingResubscription.delete(sessionId);
        this.#eventWaiters.notify(sessionId);
      }
      const revision = restaged.revocation.revision;
      if (current.provider === "codex") {
        // The account callback durably stages the exact observed identity
        // before it returns. The real Codex barrier also retires this exact
        // generation before this worker can run, so any ordinary account read
        // here would either fail AUTHORITY_STALE or incorrectly relaunch the
        // authority we are releasing. Await only the nonlaunching close
        // custody. A concurrent B -> C callback advances the durable revision
        // synchronously and the completion read below covers that latest key.
        const runtime = current.runtimeScope === "personal"
          ? this.#personalCodex
          : this.#codex;
        const emptyPersonalScopeMayCloseWithoutRuntime =
          options.allowEmptyPersonalCodexScope === true
          && current.runtimeScope === "personal"
          && restaged.bindings.length === 0;
        if (!emptyPersonalScopeMayCloseWithoutRuntime) {
          if (runtime?.releaseOwnedAuthority === undefined) {
            throw new ProviderRuntimeUnavailableError(
              `The ${current.runtimeScope} Codex runtime cannot safely release account authority.`,
            );
          }
          await runtime.releaseOwnedAuthority({
            authority: current.runtimeScope === "personal"
              ? this.#personalAuthorityForProfile(exact)
              : authorityFor(this.#paths, exact),
            signal,
          });
        }
      } else {
        // Include unbound claimed/releasing processes: the exact PID/start
        // custody record, not a session lookup, is the release authority.
        let afterProviderThreadId: string | null = null;
        for (;;) {
          const page = this.#store.listUnreleasedClaudeProcessAuthorityPage({
            profileId: current.profileId,
            profileGeneration: current.profileGeneration,
            runtimeScope: current.runtimeScope,
            afterProviderThreadId,
            limit: 100,
          });
          for (const process of page.authorities) {
            signal.throwIfAborted();
            await this.#releaseClaudeProcessAuthority(process, signal);
          }
          if (page.continueAfterProviderThreadId === null) break;
          afterProviderThreadId = page.continueAfterProviderThreadId;
        }
      }
      if (current.runtimeScope === "personal") {
        let afterSessionId: string | null = null;
        for (;;) {
          const page = this.#store.listProfileDetachingPersonalRuntimeBindingPage({
            profileId: current.profileId,
            provider: current.provider,
            afterSessionId,
            limit: 500,
          });
          for (const binding of page.bindings) {
            this.#clearSessionFactAuthority(binding.sessionId);
            this.#store.completePersonalSessionDetach({
              sessionId: binding.sessionId,
              archive: false,
            });
          }
          if (page.continueAfterSessionId === null) break;
          afterSessionId = page.continueAfterSessionId;
        }
      }

      if (current.provider === "codex") {
        // A replacement observed while release was in flight was staged
        // synchronously before its callback returned. Since release completed
        // afterward, the same controller retirement covers that latest
        // revision without trying to reopen a retired generation for a read.
        const released = this.#store.readProviderRuntimeAccountRevocation({
          profileId: current.profileId,
          provider: current.provider,
          runtimeScope: current.runtimeScope,
        });
        if (released === null || released.state === "completed") return;
        if (released.profileGeneration !== current.profileGeneration) {
          throw new Error("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_STALE");
        }
        this.#store.completeProviderRuntimeAccountRevocation({
          profileId: released.profileId,
          expectedGeneration: released.profileGeneration,
          provider: released.provider,
          runtimeScope: released.runtimeScope,
          expectedRevision: released.revision,
        });
        return;
      }

      const observedAccountKey = await this.#readClaudeRuntimeAccountKeyForRevocation(
        current,
        exact,
        signal,
      );
      const latest = this.#store.readProviderRuntimeAccountRevocation({
        profileId: current.profileId,
        provider: current.provider,
        runtimeScope: current.runtimeScope,
      });
      if (latest === null || latest.state === "completed") return;
      if (
        latest.revision !== revision
        || latest.currentAccountKey !== current.currentAccountKey
      ) continue;
      if (observedAccountKey !== current.currentAccountKey) {
        const advanced = this.#store.beginProviderRuntimeAccountRevocation({
          profileId: current.profileId,
          expectedGeneration: current.profileGeneration,
          provider: current.provider,
          runtimeScope: current.runtimeScope,
          currentAccountKey: observedAccountKey,
          workStore: this.#work,
        });
        this.#notifyAffectedWork(advanced.affectedWorkIds);
        continue;
      }
      this.#store.completeProviderRuntimeAccountRevocation({
        profileId: current.profileId,
        expectedGeneration: current.profileGeneration,
        provider: current.provider,
        runtimeScope: current.runtimeScope,
        expectedRevision: revision,
      });
      return;
    }
  }

  async #releaseCodexAuthorityForAccountMutationLocked(
    profile: Pick<ProfileRecord, "id" | "processGeneration">,
    signal: AbortSignal,
    options: Readonly<{ deferManagedRelease?: boolean }> = {},
  ): Promise<void> {
    for (const runtimeScope of ["personal", "managed"] as const) {
      const existing = this.#store.readProviderRuntimeAccountRevocation({
        profileId: profile.id,
        provider: "codex",
        runtimeScope,
      });
      if (
        existing?.state === "completed"
        && existing.profileGeneration === profile.processGeneration
        && existing.currentAccountKey === null
      ) {
        if (runtimeScope === "managed" && options.deferManagedRelease === true) {
          throw new ProviderRuntimeUnavailableError(
            "Managed Codex authority already ended in this profile generation. Restart HRA before reconciling or retrying account logout.",
          );
        }
        continue;
      }
      if (runtimeScope === "managed" && options.deferManagedRelease === true) {
        // Logout must durably fence every session before provider dispatch,
        // while retaining the one exact managed client that owns account/logout.
        // Unlike the ordinary scheduler, this intentionally creates no worker
        // that could race and close that client before the effect begins.
        this.#beginProviderRuntimeAccountRevocationFence(
          profile,
          "codex",
          runtimeScope,
          null,
        );
        continue;
      }
      // A null replacement key is an intentional complete-scope fence: login
      // and logout retire every Codex session/controller, native or adopted,
      // even when its stored key names the account being changed.
      this.#scheduleProviderRuntimeAccountRevocation(
        profile,
        "codex",
        runtimeScope,
        null,
      );
      await this.#runProviderRuntimeAccountRevocation({
        profileId: profile.id,
        profileGeneration: profile.processGeneration,
        provider: "codex",
        runtimeScope,
      }, signal, { allowEmptyPersonalCodexScope: true });
      const completed = this.#store.readProviderRuntimeAccountRevocation({
        profileId: profile.id,
        provider: "codex",
        runtimeScope,
      });
      if (
        completed?.state !== "completed"
        || completed.profileGeneration !== profile.processGeneration
        || completed.currentAccountKey !== null
      ) {
        throw new ProviderRuntimeUnavailableError(
          `${runtimeScope === "personal" ? "Personal-home" : "Managed"} Codex authority did not finish releasing before the account mutation.`,
        );
      }
    }
  }

  async #completeManagedCodexLogoutAuthorityReleaseLocked(
    profile: Pick<ProfileRecord, "id" | "processGeneration">,
  ): Promise<void> {
    // Once account/logout crossed its durable effect boundary, request
    // cancellation no longer owns cleanup. Retire the exact client with an
    // independent signal, while retaining daemon-fence checks around the
    // nonlaunching release and its durable completion.
    const releaseSignal = new AbortController().signal;
    await this.#daemonAuthority.assertCurrent();
    let releaseFailure: unknown;
    try {
      await this.#runProviderRuntimeAccountRevocation({
        profileId: profile.id,
        profileGeneration: profile.processGeneration,
        provider: "codex",
        runtimeScope: "managed",
      }, releaseSignal);
    } catch (error: unknown) {
      releaseFailure = error;
    }
    await this.#daemonAuthority.assertCurrent();
    if (releaseFailure !== undefined) {
      throw releaseFailure instanceof Error
        ? releaseFailure
        : new Error("Managed Codex controller release failed.", { cause: releaseFailure });
    }
    const completed = this.#store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "codex",
      runtimeScope: "managed",
    });
    if (
      completed?.state !== "completed"
      || completed.profileGeneration !== profile.processGeneration
      || completed.currentAccountKey !== null
    ) {
      throw new ProviderRuntimeUnavailableError(
        "Managed Codex authority did not finish releasing after account logout dispatch.",
      );
    }
  }

  async #readClaudeRuntimeAccountKeyForRevocation(
    revocation: ProviderRuntimeAccountRevocationRecord,
    profile: ProfileRecord,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (revocation.provider !== "claude") {
      throw new Error("CODEX_REVOCATION_MUST_NOT_REREAD_RETIRED_AUTHORITY");
    }
    const authority = revocation.runtimeScope === "personal"
      ? this.#personalAuthorityForProfile(profile)
      : authorityFor(this.#paths, profile);
    const runtime = revocation.runtimeScope === "personal"
      ? this.#personalClaude
      : this.#claude;
    if (runtime === undefined) {
      throw new ProviderRuntimeUnavailableError(
        `The ${revocation.runtimeScope} ${revocation.provider} runtime cannot reread account identity.`,
      );
    }
    const account = await this.#fencedEffect(async () =>
      await runtime.readAccount({ authority, signal }));
    await this.#daemonAuthority.assertCurrent();
    return providerAccountAuthorityKey("claude", account);
  }

  async #assertProviderRuntimeAccountAuthority(
    profile: ProfileRecord,
    provider: Provider,
    runtimeScope: RuntimeAccountScope,
    signal: AbortSignal,
    force: boolean,
  ): Promise<string> {
    if (provider === "codex") {
      this.#assertSignedIn(profile);
      this.#assertIdentifiableAccountAuthority(profile);
    } else {
      if (profile.state !== "signed_in" && profile.state !== "signed_out") {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          `The HRA profile authority for ${profile.label} is unsettled. Resolve its Codex account transition before another Claude provider operation.`,
        );
      }
      if (this.#profileAuthorityRevocationIsPending(profile.id, profile.processGeneration)) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          `Account authority for ${profile.label} is being revoked; wait for controller release before another provider operation.`,
        );
      }
      if (runtimeScope === "managed") this.#assertClaudeIsolationAccepted();
    }
    if (this.#providerRuntimeAccountRevocationIsPending(
      profile.id,
      profile.processGeneration,
      provider,
      runtimeScope,
    )) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        `The ${runtimeScope} ${provider} account authority is being released.`,
        { accountId: profile.id, provider, runtimeScope },
      );
    }
    const expectedCodexKey = profileCodexAccountAuthorityKey(profile);
    const key = this.#personalAccountAttestationKey(provider, profile.id, runtimeScope);
    const cached = this.#personalAccountAttestations.get(key);
    const durableRevocation = this.#store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider,
      runtimeScope,
    });
    if (
      !force
      && cached?.generation === profile.processGeneration
      && (provider !== "codex" || cached.accountKey === expectedCodexKey)
      && durableRevocation?.profileGeneration !== profile.processGeneration
      && this.#now() - cached.checkedAt <= PERSONAL_ACCOUNT_ATTESTATION_TTL_MS
    ) return cached.accountKey;

    const existing = this.#personalAccountChecks.get(key);
    if (existing !== undefined && !force) return await existing;
    const check = (async (): Promise<string> => {
      // A forced check is a post-effect fence. It must begin a provider read
      // after every check that was already admitted when the caller crossed
      // the effect boundary; joining an older read would collapse the account
      // sandwich into a single pre-effect observation. Chaining onto the
      // current per-account tail also makes concurrent forced checks each earn
      // their own causally fresh observation.
      if (existing !== undefined) {
        try {
          await existing;
        } catch {
          // The older caller owns its failure. This caller still needs a fresh
          // observation so it can prove (or independently revoke) its effect.
        }
        signal.throwIfAborted();
      }
      const authority = runtimeScope === "personal"
        ? this.#personalAuthorityForProfile(profile)
        : authorityFor(this.#paths, profile);
      const account = await this.#fencedEffect(async () => {
        if (provider === "claude") {
          const runtime = runtimeScope === "personal" ? this.#personalClaude : this.#claude;
          return await runtime?.readAccount({ authority, signal });
        }
        const runtime = runtimeScope === "personal" ? this.#personalCodex : this.#codex;
        return await runtime?.readAccount({ authority, signal });
      });
      if (account === undefined) {
        throw new ProviderRuntimeUnavailableError(
          `${runtimeScope === "personal" ? "Personal-home" : "Managed"} ${provider} account identity is unavailable on this daemon.`,
        );
      }
      signal.throwIfAborted();
      await this.#daemonAuthority.assertCurrent();
      const exact = this.#store.requireProfileById(profile.id);
      if (exact.processGeneration !== profile.processGeneration) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The HRA account authority changed during provider identity verification.",
        );
      }
      if (provider === "codex") {
        this.#assertSignedIn(exact);
        this.#assertIdentifiableAccountAuthority(exact);
      } else {
        if (exact.state !== "signed_in" && exact.state !== "signed_out") {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            `The HRA profile authority for ${exact.label} changed during Claude identity verification.`,
          );
        }
        if (this.#profileAuthorityRevocationIsPending(exact.id, exact.processGeneration)) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            `Account authority for ${exact.label} is being revoked; wait for controller release before another provider operation.`,
          );
        }
        if (runtimeScope === "managed") this.#assertClaudeIsolationAccepted();
      }
      const accountKey = providerAccountAuthorityKey(provider, account);
      const exactExpectedCodexKey = profileCodexAccountAuthorityKey(exact);
      const mismatchesSelectedCodexAccount = provider === "codex"
        && (accountKey === null || accountKey !== exactExpectedCodexKey);
      if (accountKey === null || mismatchesSelectedCodexAccount) {
        this.#personalAccountAttestations.delete(key);
        if (provider === "codex" && runtimeScope === "managed") {
          this.#scheduleProfilePersonalAuthorityRevocation(exact);
        } else {
          this.#scheduleProviderRuntimeAccountRevocation(
            exact,
            provider,
            runtimeScope,
            accountKey,
          );
        }
        throw new ProviderAccountAuthorityMismatchError(provider, runtimeScope, exact);
      }
      const currentRevocation = this.#store.readProviderRuntimeAccountRevocation({
        profileId: exact.id,
        provider,
        runtimeScope,
      });
      if (currentRevocation?.profileGeneration === exact.processGeneration) {
        if (
          currentRevocation.state !== "completed"
          || currentRevocation.currentAccountKey !== accountKey
        ) {
          this.#scheduleProviderRuntimeAccountRevocation(
            exact,
            provider,
            runtimeScope,
            accountKey,
          );
          throw new ProviderAccountAuthorityMismatchError(provider, runtimeScope, exact);
        }
        this.#store.clearCompletedProviderRuntimeAccountRevocation({
          profileId: exact.id,
          expectedGeneration: exact.processGeneration,
          provider,
          runtimeScope,
          currentAccountKey: accountKey,
        });
      }
      this.#personalAccountAttestations.set(key, {
        checkedAt: this.#now(),
        accountKey,
        generation: exact.processGeneration,
      });
      return accountKey;
    })();
    this.#personalAccountChecks.set(key, check);
    try {
      return await check;
    } finally {
      if (this.#personalAccountChecks.get(key) === check) {
        this.#personalAccountChecks.delete(key);
      }
    }
  }

  async #assertPersonalProviderAccountAuthority(
    profile: ProfileRecord,
    provider: Provider,
    signal: AbortSignal,
    force: boolean,
  ): Promise<string> {
    return await this.#assertProviderRuntimeAccountAuthority(
      profile,
      provider,
      "personal",
      signal,
      force,
    );
  }

  async #assertPersonalSessionAccountAuthority(
    session: SessionRecord,
    profile: ProfileRecord,
    signal: AbortSignal,
    force = true,
  ): Promise<void> {
    const runtimeScope: RuntimeAccountScope = this.#sessionHasActivePersonalBinding(session)
      ? "personal"
      : "managed";
    const recorded = this.#store.readSessionProviderAccountAuthority(session.id);
    if (
      recorded === null
      || recorded.provider !== session.provider
      || recorded.runtimeScope !== runtimeScope
    ) {
      this.#quarantineSession(session.id);
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The session has no exact provider-account authority for its current runtime.",
        { sessionId: session.id },
      );
    }
    const currentAccountKey = await this.#assertProviderRuntimeAccountAuthority(
      profile,
      session.provider,
      runtimeScope,
      signal,
      force,
    );
    if (recorded.accountKey !== currentAccountKey) {
      if (session.provider === "codex" && runtimeScope === "managed") {
        this.#scheduleProfilePersonalAuthorityRevocation(profile);
      } else {
        this.#scheduleProviderRuntimeAccountRevocation(
          profile,
          session.provider,
          runtimeScope,
          currentAccountKey,
        );
      }
      throw new ProviderAccountAuthorityMismatchError(
        session.provider,
        runtimeScope,
        profile,
      );
    }
    const exact = this.#store.requireSession(session.id);
    const exactRecorded = this.#store.readSessionProviderAccountAuthority(session.id);
    if (
      exact.profileId !== profile.id
      || exact.provider !== session.provider
      || exact.providerThreadId !== session.providerThreadId
      || exactRecorded === null
      || exactRecorded.provider !== recorded.provider
      || exactRecorded.runtimeScope !== recorded.runtimeScope
      || exactRecorded.accountKey !== recorded.accountKey
      || (runtimeScope === "personal" && !this.#sessionHasActivePersonalBinding(exact))
      || (runtimeScope === "managed" && this.#sessionHasActivePersonalBinding(exact))
    ) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The session's provider-account authority changed during verification.",
        { sessionId: session.id },
      );
    }
    const exactProfile = this.#store.requireProfileById(profile.id);
    this.#assertEstablishedSessionAccount(exactProfile, exact);
  }

  async #assertSessionAccountAuthorityAfterProviderEffect(
    session: SessionRecord,
    profile: ProfileRecord,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
    } catch (cause: unknown) {
      if (cause instanceof DaemonAuthoritySafetyError) throw cause;
      throw new IndeterminateLocalCommitError(
        "The provider may have applied the effect while its account authority changed.",
        cause,
      );
    }
  }

  async #assertPersonalInteractionAccountAuthority(
    interaction: Pick<InteractionRecord, "sessionId">,
    profile: ProfileRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (interaction.sessionId === null) return;
    const session = this.#store.requireSession(interaction.sessionId);
    await this.#assertPersonalSessionAccountAuthority(session, profile, signal);
  }

  async #assertInteractionAccountAuthorityAfterProviderEffect(
    interaction: Pick<InteractionRecord, "sessionId">,
    profile: ProfileRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (interaction.sessionId === null) return;
    try {
      const session = this.#store.requireSession(interaction.sessionId);
      await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
    } catch (cause: unknown) {
      if (cause instanceof DaemonAuthoritySafetyError) throw cause;
      throw new CodexError(
        "INDETERMINATE_EFFECT",
        "The provider may have applied the interaction response while its account authority changed.",
        { cause },
      );
    }
  }

  #claudeRuntimeForScope(scope: ClaudeProcessAuthorityRecord["runtimeScope"]): ClaudeRuntimePort {
    if (scope === "managed") return this.#claude;
    if (this.#personalClaude !== undefined) return this.#personalClaude;
    throw new ProviderRuntimeUnavailableError(
      "Personal-home Claude process custody is unavailable on this daemon.",
    );
  }

  #authorityForClaudeProcess(record: ClaudeProcessAuthorityRecord): ProfileAuthority {
    const profile = this.#store.requireProfileById(record.profileId, { includeRemoved: true });
    const exact = { ...profile, processGeneration: record.profileGeneration };
    if (record.runtimeScope === "managed") return authorityFor(this.#paths, exact);
    if (this.#personalCodexHome === undefined) {
      throw new ProviderRuntimeUnavailableError(
        "Personal provider-home authority is unavailable on this daemon.",
      );
    }
    const isolated = profilePaths(this.#paths, profile.id);
    return {
      id: profile.id,
      generation: record.profileGeneration,
      codexHome: this.#personalCodexHome,
      desktopUserData: isolated.desktopUserData,
    };
  }

  #sameClaudeProcessIdentity(
    left: ClaudeProcessIdentity,
    right: ClaudeProcessIdentity,
  ): boolean {
    return left.pid === right.pid
      && left.pidDomain === right.pidDomain
      && left.procStart === right.procStart;
  }

  async #recordClaimedClaudeProcess(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    runtimeScope: ClaudeProcessAuthorityRecord["runtimeScope"];
    sessionId?: SessionRecord["id"];
    launchIntent: ClaudeProcessLaunchIntentRecord;
    identity: ClaudeProcessIdentity;
    signal: AbortSignal;
  }): Promise<ClaudeProcessIdentity> {
    input.signal.throwIfAborted();
    await this.#daemonAuthority.assertCurrent();
    this.#store.recordClaimedClaudeProcessAuthority({
      providerThreadId: input.providerThreadId,
      profileId: input.authority.id,
      profileGeneration: input.authority.generation,
      runtimeScope: input.runtimeScope,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      identity: input.identity,
      expectedLaunchIntentId: input.launchIntent.intentId,
      expectedLaunchIntentRevision: input.launchIntent.revision,
    });
    return input.identity;
  }

  #cancelClaudeProcessLaunchIntent(intent: ClaudeProcessLaunchIntentRecord): void {
    const current = this.#store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    });
    if (current === null) return;
    if (current.intentId !== intent.intentId || current.revision !== intent.revision) {
      throw new Error("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    }
    this.#store.cancelClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      profileGeneration: intent.profileGeneration,
      runtimeScope: intent.runtimeScope,
      intentId: intent.intentId,
      expectedRevision: intent.revision,
    });
  }

  async #probeClaudeProcessLiveness(
    record: ClaudeProcessAuthorityRecord,
    signal: AbortSignal,
  ): Promise<"live" | "not_live" | "unknown"> {
    return await this.#probeClaudeProcessIdentityLiveness(record.identity, signal);
  }

  async #probeClaudeProcessIdentityLiveness(
    identity: ClaudeProcessIdentity,
    signal: AbortSignal,
    deadlineAt = this.#now() + CLAUDE_PROCESS_LIVENESS_DEADLINE_MS,
  ): Promise<"live" | "not_live" | "unknown"> {
    if (this.#claudeProcessLiveness === undefined) return "unknown";
    signal.throwIfAborted();
    return await this.#claudeProcessLiveness(identity, {
      deadlineAt,
      signal,
    });
  }

  async #releaseClaudeProcessAuthority(
    input: ClaudeProcessAuthorityKey,
    signal: AbortSignal,
  ): Promise<ClaudeProcessAuthorityRecord> {
    // Callers often already hold the richer durable authority record. Narrow
    // it before crossing the strict storage boundary so recovery cannot be
    // defeated by structurally valid extra fields.
    const key: ClaudeProcessAuthorityKey = {
      providerThreadId: input.providerThreadId,
      profileId: input.profileId,
      runtimeScope: input.runtimeScope,
    };
    return await this.#serialize(
      `claude-process:${key.runtimeScope}:${key.profileId}:${key.providerThreadId}`,
      async () => await this.#releaseClaudeProcessAuthorityLocked(key, signal),
    );
  }

  async #releaseClaudeProcessAuthorityLocked(
    key: ClaudeProcessAuthorityKey,
    signal: AbortSignal,
  ): Promise<ClaudeProcessAuthorityRecord> {
    let record = this.#store.readClaudeProcessAuthority(key);
    if (record === null) {
      throw new ProviderRuntimeUnavailableError(
        "The Claude process has no durable exact-process custody record.",
      );
    }
    if (record.state === "released") return record;
    const runtime = this.#claudeRuntimeForScope(record.runtimeScope);
    const authority = this.#authorityForClaudeProcess(record);
    let runtimeOwnsExactProcess = false;
    let liveIdentity: ClaudeProcessIdentity | undefined;
    try {
      liveIdentity = await this.#fencedEffect(async () =>
        await runtime.readSessionProcessIdentity({
          authority,
          providerThreadId: key.providerThreadId,
          signal,
        }));
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      if (signal.aborted) throw signal.reason;
      const liveness = await this.#probeClaudeProcessLiveness(record, signal);
      if (liveness !== "not_live") throw error;
    }
    if (liveIdentity !== undefined) {
      if (!this.#sameClaudeProcessIdentity(liveIdentity, record.identity)) {
        throw new ProviderRuntimeUnavailableError(
          "The live Claude controller does not match its durable process authority.",
        );
      }
      runtimeOwnsExactProcess = true;
    }

    if (record.state !== "releasing") {
      record = this.#store.beginClaudeProcessAuthorityRelease({
        ...key,
        expectedRevision: record.revision,
        identity: record.identity,
      });
    }
    if (runtimeOwnsExactProcess) {
      await this.#fencedEffect(async () => await runtime.endSession({
        authority,
        providerThreadId: key.providerThreadId,
        signal: new AbortController().signal,
      }));
    } else {
      const liveness = await this.#probeClaudeProcessLiveness(record, signal);
      if (liveness !== "not_live") {
        throw new ProviderRuntimeUnavailableError(
          "The exact prior Claude process is still live or cannot be proven gone.",
        );
      }
    }
    await this.#daemonAuthority.assertCurrent();
    return this.#store.completeClaudeProcessAuthorityRelease({
      ...key,
      expectedRevision: record.revision,
      identity: record.identity,
    });
  }

  #sessionHasActivePersonalBinding(session: SessionRecord): boolean {
    const binding = this.#store.readSessionPersonalRuntimeBinding(session.id, true);
    if (binding === null) return false;
    const matchesCurrentIdentity = binding.provider === session.provider
      && binding.providerThreadId === session.providerThreadId;
    if (binding.state === "active") {
      if (!matchesCurrentIdentity) {
        throw new ProviderRuntimeUnavailableError(
          "The personal-home session binding no longer matches its durable session identity.",
        );
      }
      return true;
    }
    if (matchesCurrentIdentity) {
      throw new ProviderRuntimeUnavailableError(
        "That session's exact provider controller is no longer available.",
      );
    }
    // A provider switch may retain the mismatched detached row until the old
    // identity is readopted. Runtime-profile history and provider_switched
    // events preserve provenance; the session's current identity is managed.
    return false;
  }

  #sessionHasMatchingActivePersonalBinding(
    session: Pick<SessionRecord, "id" | "provider" | "providerThreadId">,
  ): boolean {
    const binding = this.#store.readSessionPersonalRuntimeBinding(session.id, true);
    return binding !== null
      && binding.state === "active"
      && binding.provider === session.provider
      && binding.providerThreadId === session.providerThreadId;
  }

  #runtimeForSession(
    session: SessionRecord,
  ): SessionRuntimePort<ReviewedRuntimeProfile> {
    return this.#sessionHasActivePersonalBinding(session)
      ? this.#personalSessionRuntime(session.provider)
      : this.#sessionRuntime(session.provider);
  }

  #authorityForSession(session: SessionRecord, profile?: ProfileRecord): ProfileAuthority {
    const owner = profile ?? this.#store.requireProfileById(session.profileId);
    this.#assertEstablishedSessionAccount(owner, session);
    const managed = authorityFor(this.#paths, owner);
    if (!this.#sessionHasActivePersonalBinding(session)) return managed;
    return this.#personalAuthorityForProfile(owner);
  }

  #personalAuthorityForProfile(profile: ProfileRecord): ProfileAuthority {
    if (this.#personalCodexHome === undefined) {
      throw new ProviderRuntimeUnavailableError(
        "Personal-home session authority is unavailable on this daemon.",
      );
    }
    return { ...authorityFor(this.#paths, profile), codexHome: this.#personalCodexHome };
  }

  #assertSessionAccountAuthority(
    session: Pick<SessionRecord, "id" | "profileId">,
    profile: Pick<ProfileRecord, "id" | "label">,
  ): void {
    if (
      session.profileId === profile.id
      && this.#store.sessionAccountAuthorityMatches(session.id, profile.id)
    ) return;
    throw new CommandFailure(
      "RECOVERY_REQUIRED",
      `Session ${session.id} is bound to a different or unprovable provider account identity. Sign in to the original account for ${profile.label} before using it.`,
      { sessionId: session.id, accountId: profile.id },
    );
  }

  #assertSessionAccountAuthorityIfSignedIn(
    session: Pick<SessionRecord, "id" | "profileId" | "provider">,
  ): void {
    if (session.provider === "claude") return;
    const profile = this.#store.requireProfileById(session.profileId);
    if (profile.state === "signed_in") this.#assertSessionAccountAuthority(session, profile);
  }

  #authorityForInteraction(
    record: Readonly<{ sessionId: SessionRecord["id"] | null }>,
    profile: ProfileRecord,
  ): ProfileAuthority {
    if (record.sessionId === null) return authorityFor(this.#paths, profile);
    return this.#authorityForSession(this.#store.requireSession(record.sessionId), profile);
  }

  #providerForInteraction(
    record: Readonly<{
      sessionId: SessionRecord["id"] | null;
      authority: ProviderInteractionAuthority;
    }>,
  ): Provider {
    const provider = record.authority.method.startsWith("claude/")
      ? "claude"
      : "codex";
    if (record.sessionId === null) return provider;
    const session = this.#store.requireSession(record.sessionId);
    if (session.provider !== provider) {
      throw new ProviderRuntimeUnavailableError(
        "The interaction provider no longer matches its durable session authority.",
      );
    }
    return provider;
  }

  #assertProviderProfileState(profile: ProfileRecord, provider: Provider): void {
    if (provider === "codex") {
      this.#assertSignedIn(profile);
      return;
    }
    if (profile.state === "signed_in" || profile.state === "signed_out") return;
    throw new CommandFailure(
      "RECOVERY_REQUIRED",
      "The interaction belongs to an unsettled HRA profile authority.",
    );
  }

  /**
   * The port that owns a brokered interaction. The session it belongs to is
   * the authority; an interaction with no session (a provider-level request)
   * is attributed by the durable method name its authority recorded.
   */
  #runtimeForInteraction(
    record: Readonly<{
      sessionId: SessionRecord["id"] | null;
      authority: ProviderInteractionAuthority;
    }>,
  ): SessionRuntimePort<ReviewedRuntimeProfile> {
    if (record.sessionId !== null) {
      try {
        const session = this.#store.requireSession(record.sessionId);
        if (
          session.provider === "claude"
          && !this.#sessionHasActivePersonalBinding(session)
        ) this.#assertClaudeIsolationAccepted();
        return this.#runtimeForSession(session);
      } catch (error: unknown) {
        if (!(error instanceof SelectionError && error.code === "NOT_FOUND")) throw error;
        // Fall through to the durable method name below.
      }
    }
    const provider = this.#providerForInteraction(record);
    if (provider === "claude") this.#assertClaudeIsolationAccepted();
    return this.#sessionRuntime(provider);
  }

  /** Refuses a Codex-only capability on a session bound to another provider. */
  #requireCodexSession(session: Readonly<{ provider: Provider }>, capability: string): void {
    if (session.provider === "codex") return;
    throw new CommandFailure(
      "INVALID_INPUT",
      `The ${session.provider} provider does not support ${capability}. `
      + "It is available on Codex sessions only.",
    );
  }

  #sessionUsesFactSource(
    session: SessionRecord,
    provider: Provider,
    source: ProviderFactSource,
  ): boolean {
    if (session.provider !== provider) return false;
    if (this.#profileAuthorityRevocationIsPending(session.profileId)) return false;
    const binding = this.#store.readSessionPersonalRuntimeBinding(session.id, true);
    const runtimeScope: RuntimeAccountScope = binding !== null
      && binding.state === "active"
      && binding.provider === provider
      && binding.providerThreadId === session.providerThreadId
      ? "personal"
      : "managed";
    const profile = this.#store.requireProfileById(session.profileId);
    if (this.#providerRuntimeAccountRevocationIsPending(
      profile.id,
      profile.processGeneration,
      provider,
      runtimeScope,
    )) return false;
    if (binding === null) return source === "managed";
    const matchesCurrentIdentity = binding.provider === provider
      && binding.providerThreadId === session.providerThreadId;
    if (source === "managed") {
      // Provider switching keeps a detached historical binding. It must not
      // suppress facts from the session's new ordinary managed identity.
      return binding.state === "detached" && !matchesCurrentIdentity;
    }
    return binding.state === "active" && matchesCurrentIdentity;
  }

  #clearSessionFactAuthority(sessionId: SessionRecord["id"]): void {
    this.#sessionFactAuthorities.delete(sessionId);
  }

  #clearProfileFactAuthorities(
    profileId: ProfileRecord["id"],
    provider?: Provider,
    runtimeScope?: RuntimeAccountScope,
  ): void {
    for (const [sessionId, capability] of this.#sessionFactAuthorities) {
      if (
        capability.profileId === profileId
        && (provider === undefined || capability.provider === provider)
        && (runtimeScope === undefined || capability.runtimeScope === runtimeScope)
      ) this.#sessionFactAuthorities.delete(sessionId);
    }
  }

  #mintSessionFactAuthority(
    authority: ProfileAuthority,
    session: SessionRecord,
    connectionId: string,
  ): void {
    z.string().uuid().parse(connectionId);
    if (session.providerThreadId === undefined) {
      throw new Error("SESSION_FACT_AUTHORITY_THREAD_MISSING");
    }
    const profile = this.#store.requireProfileById(session.profileId);
    if (
      profile.id !== authority.id
      || profile.processGeneration !== authority.generation
      || !this.#profileAllowsEstablishedSession(profile, session)
      || session.state === "terminal"
      || session.state === "recovery_required"
      || (
        session.provider === "codex"
        && !this.#store.sessionAccountAuthorityMatches(session.id, profile.id)
      )
    ) throw new Error("SESSION_FACT_AUTHORITY_PROFILE_STALE");
    const runtimeScope: RuntimeAccountScope = this.#sessionHasActivePersonalBinding(session)
      ? "personal"
      : "managed";
    const recorded = this.#store.readSessionProviderAccountAuthority(session.id);
    const attested = this.#personalAccountAttestations.get(
      this.#personalAccountAttestationKey(session.provider, profile.id, runtimeScope),
    );
    if (
      recorded === null
      || recorded.provider !== session.provider
      || recorded.runtimeScope !== runtimeScope
      || attested?.generation !== profile.processGeneration
      || attested.accountKey !== recorded.accountKey
    ) throw new Error("SESSION_FACT_AUTHORITY_ACCOUNT_UNATTESTED");
    const binding = this.#store.readSessionPersonalRuntimeBinding(session.id, true);
    const personalBindingRevision = runtimeScope === "personal"
      && binding !== null
      && binding.state === "active"
      && binding.provider === session.provider
      && binding.providerThreadId === session.providerThreadId
      ? binding.revision
      : null;
    if (runtimeScope === "personal" && personalBindingRevision === null) {
      throw new Error("SESSION_FACT_AUTHORITY_BINDING_STALE");
    }
    let claudeProcess: SessionFactAuthority["claudeProcess"] = null;
    if (session.provider === "claude") {
      const process = this.#store.readClaudeProcessAuthority({
        providerThreadId: session.providerThreadId,
        profileId: profile.id,
        runtimeScope,
      });
      if (
        process === null
        || process.profileGeneration !== profile.processGeneration
        || process.sessionId !== session.id
        || process.state !== "bound"
      ) throw new Error("SESSION_FACT_AUTHORITY_CLAUDE_PROCESS_STALE");
      claudeProcess = { identity: process.identity, revision: process.revision };
    }
    this.#sessionFactAuthorities.set(session.id, {
      sessionId: session.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      provider: session.provider,
      runtimeScope,
      providerThreadId: session.providerThreadId,
      connectionId,
      accountKey: recorded.accountKey,
      personalBindingRevision,
      claudeProcess,
    });
  }

  #sessionFactAuthorityIsCurrent(
    sessionId: SessionRecord["id"],
    authority: ProfileAuthority,
    provider: Provider,
    source: ProviderFactSource,
    providerThreadId: string,
    connectionId?: string,
    options: Readonly<{ allowRecoveryRequired?: boolean }> = {},
  ): boolean {
    const capability = this.#sessionFactAuthorities.get(sessionId);
    if (capability === undefined) return false;
    try {
      if (
        capability.profileId !== authority.id
        || capability.profileGeneration !== authority.generation
        || capability.provider !== provider
        || capability.providerThreadId !== providerThreadId
        || capability.runtimeScope !== (source === "personal" ? "personal" : "managed")
        || (connectionId !== undefined && capability.connectionId !== connectionId)
        || this.#sessionProviderConnections.get(sessionId) !== capability.connectionId
        || this.#profileAuthorityRevocationIsPending(
          capability.profileId,
          capability.profileGeneration,
        )
        || this.#providerRuntimeAccountRevocationIsPending(
          capability.profileId,
          capability.profileGeneration,
          capability.provider,
          capability.runtimeScope,
        )
      ) throw new Error("SESSION_FACT_AUTHORITY_STALE");
      const profile = this.#store.requireProfileById(capability.profileId);
      const session = this.#store.requireSession(sessionId);
      const recorded = this.#store.readSessionProviderAccountAuthority(sessionId);
      if (
        profile.processGeneration !== capability.profileGeneration
        || !this.#profileAllowsEstablishedSession(profile, session)
        || session.profileId !== capability.profileId
        || session.provider !== capability.provider
        || session.providerThreadId !== capability.providerThreadId
        || session.state === "terminal"
        || (session.state === "recovery_required" && options.allowRecoveryRequired !== true)
        || (
          session.provider === "codex"
          && !this.#store.sessionAccountAuthorityMatches(session.id, profile.id)
        )
        || recorded === null
        || recorded.provider !== capability.provider
        || recorded.runtimeScope !== capability.runtimeScope
        || recorded.accountKey !== capability.accountKey
      ) throw new Error("SESSION_FACT_AUTHORITY_STALE");
      const binding = this.#store.readSessionPersonalRuntimeBinding(sessionId, true);
      if (capability.runtimeScope === "personal") {
        if (
          binding === null
          || binding.state !== "active"
          || binding.revision !== capability.personalBindingRevision
          || binding.provider !== capability.provider
          || binding.providerThreadId !== capability.providerThreadId
        ) throw new Error("SESSION_FACT_AUTHORITY_BINDING_STALE");
      } else if (
        binding !== null
        && binding.state !== "detached"
        && binding.provider === capability.provider
        && binding.providerThreadId === capability.providerThreadId
      ) throw new Error("SESSION_FACT_AUTHORITY_BINDING_STALE");
      if (capability.provider === "claude") {
        const process = this.#store.readClaudeProcessAuthority({
          providerThreadId: capability.providerThreadId,
          profileId: capability.profileId,
          runtimeScope: capability.runtimeScope,
        });
        if (
          process === null
          || process.profileGeneration !== capability.profileGeneration
          || process.sessionId !== capability.sessionId
          || process.state !== "bound"
          || capability.claudeProcess === null
          || process.revision !== capability.claudeProcess.revision
          || !this.#sameClaudeProcessIdentity(process.identity, capability.claudeProcess.identity)
        ) throw new Error("SESSION_FACT_AUTHORITY_CLAUDE_PROCESS_STALE");
      } else if (capability.claudeProcess !== null) {
        throw new Error("SESSION_FACT_AUTHORITY_PROVIDER_STALE");
      }
      return true;
    } catch {
      this.#clearSessionFactAuthority(sessionId);
      return false;
    }
  }

  /**
   * An unknown Codex connection is never allowed to commit its triggering
   * delta. Once existing mutation tails drain, an exact provider observation
   * may mint a capability for later deltas. Claude has no connection-only
   * fallback: its exact process identity must already be claimed and observed.
   */
  async #warmUnknownCodexFactAuthority(
    session: SessionRecord,
    provider: Provider,
  ): Promise<void> {
    if (provider !== "codex") return;
    try {
      await this.#ensureSessionObservedLocked(
        session.id,
        this.#backgroundAbort.signal,
      );
    } catch (error: unknown) {
      if (error instanceof StateSecurityScrubRequiredError) throw error;
      this.recordBackgroundDiagnostic("session_state_tracking_failed", error);
    }
  }

  async #ensureSessionFactAuthority(
    session: SessionRecord,
    authority: ProfileAuthority,
    provider: Provider,
    source: ProviderFactSource,
    providerThreadId: string,
    connectionId?: string,
  ): Promise<boolean> {
    const hadCapability = this.#sessionFactAuthorities.has(session.id);
    if (this.#sessionFactAuthorityIsCurrent(
      session.id,
      authority,
      provider,
      source,
      providerThreadId,
      connectionId,
    )) return true;
    if (hadCapability || provider !== "codex") return false;
    await this.#warmUnknownCodexFactAuthority(session, provider);
    return this.#sessionFactAuthorityIsCurrent(
      session.id,
      authority,
      provider,
      source,
      providerThreadId,
      connectionId,
    );
  }

  #findSessionForProviderFact(
    profileId: ProfileRecord["id"],
    providerThreadId: string,
    provider: Provider,
    source: ProviderFactSource,
  ): SessionRecord | null {
    const session = this.#store.findSessionByProviderThread(profileId, providerThreadId);
    if (session === null || !this.#sessionUsesFactSource(session, provider, source)) {
      return null;
    }
    const profile = this.#store.requireProfileById(profileId);
    if (!this.#profileAllowsEstablishedSession(profile, session)) return null;
    if (
      session.provider === "codex"
      && !this.#store.sessionAccountAuthorityMatches(session.id, profileId)
    ) return null;
    return session;
  }

  async handleConversationAutomationToolCall(
    authority: ProfileAuthority,
    call: ConversationAutomationToolCall,
    source: ProviderFactSource = "managed",
  ): Promise<DynamicToolPublicResult> {
    const finish = this.#beginOperation();
    try {
      await this.#daemonAuthority.assertCurrent();
      if (
        call.authority.profileId !== authority.id
        || call.authority.processGeneration !== authority.generation
      ) throw new Error("CONVERSATION_AUTOMATION_AUTHORITY_MISMATCH");
      const profile = this.#store.requireProfileById(authority.id);
      if (
        profile.processGeneration !== authority.generation
        || profile.state !== "signed_in"
        || this.#profileAuthorityRevocationIsPending(profile.id, authority.generation)
      ) throw new Error("CONVERSATION_AUTOMATION_AUTHORITY_STALE");
      const session = this.#findSessionForProviderFact(
        authority.id,
        call.threadId,
        "codex",
        source,
      );
      if (
        session === null
        || session.state === "terminal"
        || session.state === "recovery_required"
        || !this.#store.isConversationAutomationEnabled(session.id, call.threadId)
      ) {
        throw new Error("CONVERSATION_AUTOMATION_SESSION_UNAVAILABLE");
      }
      const idempotencyKey = conversationAutomationIdempotencyKey(authority, call);
      const result = await this.#serializeSessionAuthority(
        session,
        async () => {
          const currentProfile = this.#store.requireProfileById(authority.id);
          const currentSession = this.#findSessionForProviderFact(
            authority.id,
            call.threadId,
            "codex",
            source,
          );
          if (
            currentProfile.processGeneration !== authority.generation
            || currentProfile.state !== "signed_in"
            || currentSession === null
            || currentSession.id !== session.id
            || currentSession.state === "terminal"
            || currentSession.state === "recovery_required"
            || !this.#store.isConversationAutomationEnabled(currentSession.id, call.threadId)
          ) throw new Error("CONVERSATION_AUTOMATION_AUTHORITY_STALE");
          await this.#assertPersonalSessionAccountAuthority(
            currentSession,
            currentProfile,
            this.#backgroundAbort.signal,
            true,
          );
          switch (call.operation.mode) {
            case "list":
              return this.#sessionTasks.listIdempotent(
                currentSession.id,
                idempotencyKey,
                call.requestDigest,
              );
            case "view":
              return summarizeSessionTask(this.#sessionTasks.requireIdempotent(
                currentSession.id,
                sessionTaskIdSchema.parse(call.operation.id),
                idempotencyKey,
                call.requestDigest,
              ));
            case "create":
              return summarizeSessionTask(this.#sessionTasks.create({
                sessionId: currentSession.id,
                name: call.operation.name,
                prompt: call.operation.prompt,
                minutes: call.operation.schedule.minutes,
                status: call.operation.paused === true ? "paused" : "active",
                idempotencyKey,
                receiptDigest: call.requestDigest,
              }));
            case "update": {
              const patch: SessionTaskPatch = {
                ...(call.operation.name === undefined ? {} : { name: call.operation.name }),
                ...(call.operation.prompt === undefined ? {} : { prompt: call.operation.prompt }),
                ...(call.operation.schedule === undefined
                  ? {}
                  : { minutes: call.operation.schedule.minutes }),
                ...(call.operation.status === undefined ? {} : { status: call.operation.status }),
              };
              return summarizeSessionTask(this.#sessionTasks.edit({
                sessionId: currentSession.id,
                taskId: sessionTaskIdSchema.parse(call.operation.id),
                expectedRevision: call.operation.revision,
                patch,
                idempotencyKey,
                receiptDigest: call.requestDigest,
              }));
            }
            case "delete":
              return this.#sessionTasks.delete({
                sessionId: currentSession.id,
                taskId: sessionTaskIdSchema.parse(call.operation.id),
                expectedRevision: call.operation.revision,
                idempotencyKey,
                receiptDigest: call.requestDigest,
              });
          }
        },
        { allowDuringProjectionRecovery: false },
      );
      await this.#daemonAuthority.assertCurrent();
      return result;
    } finally {
      finish();
    }
  }

  /** Called only after Codex has received a successful dynamic-tool response frame. */
  notifyConversationAutomationToolResponseWritten(
    authority: ProfileAuthority,
    call: ConversationAutomationToolCall,
    source: ProviderFactSource = "managed",
  ): void {
    if (
      this.#state !== "open"
      || call.authority.profileId !== authority.id
      || call.authority.processGeneration !== authority.generation
    ) return;
    try {
      const profile = this.#store.requireProfileById(authority.id);
      const session = this.#findSessionForProviderFact(
        authority.id,
        call.threadId,
        "codex",
        source,
      );
      if (
        profile.processGeneration === authority.generation
        && profile.state === "signed_in"
        && !this.#profileAuthorityRevocationIsPending(profile.id, authority.generation)
        && session !== null
        && session.state !== "terminal"
      ) this.#wakeSessionTaskPump();
    } catch {
      // The mutation was already committed and acknowledged; a later state change simply
      // leaves the durable daemon pump or recovery path to observe it.
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
      ) return;
      this.#assertObservedCodexAccountAuthority(profile, account);
      const recoveryUnsettled = await this.#cloud
        .isCompactProjectionRecoveryUnsettledForProfile(profile.id);
      await this.#daemonAuthority.assertCurrent();
      const afterRecoveryRead = this.#store.requireProfileById(profile.id);
      if (afterRecoveryRead.processGeneration !== authority.generation) return;
      this.#assertObservedCodexAccountAuthority(afterRecoveryRead, account);
      if (recoveryUnsettled || this.#profileHasProjectionRecoveryInFlight(profile.id)) return;
      const apply = async (): Promise<void> => {
        let current: ProfileRecord;
        try {
          current = this.#store.requireProfileById(profile.id);
        } catch (error: unknown) {
          if (error instanceof SelectionError && error.code === "NOT_FOUND") return;
          throw error;
        }
        if (current.processGeneration !== authority.generation) return;
        this.#assertObservedCodexAccountAuthority(current, account);
        if (this.#profileHasProjectionRecoveryInFlight(profile.id)) return;
        const blocked = await this.#cloud
          .isCompactProjectionRecoveryUnsettledForProfile(profile.id);
        await this.#daemonAuthority.assertCurrent();
        current = this.#store.requireProfileById(profile.id);
        if (current.processGeneration !== authority.generation) return;
        this.#assertObservedCodexAccountAuthority(current, account);
        if (blocked || this.#profileHasProjectionRecoveryInFlight(profile.id)) return;
        const accountAuthorityChanged = providerAccountAuthorityChanged(current, account);
        if (this.#profileAuthorityRevocationIsPending(
          current.id,
          current.processGeneration,
        )) {
          if (accountAuthorityChanged) this.#scheduleProfilePersonalAuthorityRevocation(current);
          return;
        }
        if (!account.signedIn && current.state === "login_pending") return;
        // Established-identity mismatches were rejected synchronously before
        // any recovery wait or mutation-tail deferral above.
        // Provider state discovered outside HRA is evidence, not permission to
        // bind a replacement identity to dormant sessions and work. Only the
        // explicit login mutation may move a signed-out profile into signed-in.
        if (current.state === "signed_out") return;
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
        if (account.signedIn) this.#wakeSessionTaskPump();
      };
      const accountKey = `account:${profile.id}`;
      if (!this.#mutationTails.has(accountKey)) {
        await this.#serialize(accountKey, apply);
        return;
      }
      // An account mutation holds the tail, and this callback may be awaited
      // inside that mutation's own provider call, so it cannot wait its turn.
      // Queue the fact behind the tail instead of applying it now: a signed-in
      // fact written mid-login would move the profile out of `login_pending`
      // under a commit that requires that exact state, which quarantined the
      // account for a login that succeeded.
      const queued = this.#serialize(accountKey, apply);
      const tracked = queued.then(
        () => undefined,
        (error: unknown) => {
          if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
          else this.recordBackgroundDiagnostic("account_fact_apply_failed", error);
        },
      );
      this.#background.add(tracked);
      void tracked.then(() => this.#background.delete(tracked));
    } catch (error: unknown) {
      if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
      throw error;
    } finally {
      finish();
    }
  }

  #accountMutationExplainsObservedCodexTransition(
    profile: Pick<ProfileRecord, "id" | "processGeneration" | "state">,
    account: CodexAccountProjection,
  ): boolean {
    if (profile.state === "login_pending") return true;
    const unsettled = this.#store.listUnsettledMutations({ authorityId: profile.id })
      .filter((attempt) => (attempt.originalState ?? attempt.state) !== "reconciled");
    const currentGeneration = unsettled.filter((attempt) =>
      attempt.authorityGeneration === profile.processGeneration);
    const candidates = currentGeneration.length > 0
      ? currentGeneration
      : profile.state === "recovery_required" && !account.signedIn
        ? unsettled.filter((attempt) => {
            if (
              attempt.kind !== "account.logout"
              || attempt.authorityGeneration + 1 !== profile.processGeneration
            ) return false;
            const retired = this.#store.readProviderRuntimeAccountRevocation({
              profileId: profile.id,
              provider: "codex",
              runtimeScope: "managed",
            });
            return retired?.state === "completed"
              && retired.profileGeneration === attempt.authorityGeneration
              && retired.currentAccountKey === null;
          })
        : [];
    if (candidates.length !== 1) return false;
    const [attempt] = candidates;
    if (attempt === undefined) return false;
    if (attempt.kind === "account.logout") return !account.signedIn;
    if (attempt.kind === "account.login") return account.signedIn;
    return attempt.kind === "account.login-cancel" && !account.signedIn;
  }

  /**
   * Reject an unsolicited replacement before an account fact can hide behind
   * projection recovery or the account mutation tail. Login and logout facts
   * backed by their exact durable mutation are expected transitions, not an
   * authority replacement.
   */
  #assertObservedCodexAccountAuthority(
    profile: ProfileRecord,
    account: CodexAccountProjection,
  ): void {
    if (profile.state !== "signed_in" && profile.state !== "recovery_required") return;
    if (!providerAccountAuthorityChanged(profile, account)) return;
    if (this.#accountMutationExplainsObservedCodexTransition(profile, account)) return;
    this.#scheduleProfilePersonalAuthorityRevocation(profile);
    throw new ProviderAccountAuthorityMismatchError("codex", "managed", profile);
  }

  /**
   * A personal-home account fact is evidence only for the dedicated personal
   * controller. It must never rewrite the selected isolated HRA login. A
   * mismatch instead enters the existing durable controller-revocation path
   * before any later personal fact or effect can be admitted.
   */
  async observePersonalCodexAccount(
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
        || (profile.state !== "signed_in" && profile.state !== "recovery_required")
      ) return;
      const key = this.#personalAccountAttestationKey("codex", profile.id);
      const accountKey = providerAccountAuthorityKey("codex", account);
      if (accountKey === null || accountKey !== profileCodexAccountAuthorityKey(profile)) {
        this.#personalAccountAttestations.delete(key);
        const releasing = this.#store.readProviderRuntimeAccountRevocation({
          profileId: profile.id,
          provider: "codex",
          runtimeScope: "personal",
        });
        if (
          releasing?.state === "releasing"
          && releasing.profileGeneration === profile.processGeneration
        ) {
          if (releasing.currentAccountKey !== accountKey) {
            this.#scheduleProviderRuntimeAccountRevocation(
              profile,
              "codex",
              "personal",
              accountKey,
            );
          }
          // The controller is already fenced, but every replacement callback
          // still fails closed. A B -> C observation advances the durable job
          // before throwing, so the in-flight close can complete its newest
          // revision without reopening this retired generation.
          throw new ProviderAccountAuthorityMismatchError("codex", "personal", profile);
        }
        this.#scheduleProviderRuntimeAccountRevocation(
          profile,
          "codex",
          "personal",
          accountKey,
        );
        throw new ProviderAccountAuthorityMismatchError("codex", "personal", profile);
      }
      this.#personalAccountAttestations.set(key, {
        checkedAt: this.#now(),
        accountKey,
        generation: profile.processGeneration,
      });
    } catch (error: unknown) {
      if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
      throw error;
    } finally {
      finish();
    }
  }

  async #observeCodexFactAdmitted(
    authority: ProfileAuthority,
    fact: CodexFact,
    provider: Provider,
    source: ProviderFactSource,
  ): Promise<void> {
    await this.#daemonAuthority.assertCurrent();
    let profile: ProfileRecord;
    try {
      profile = this.#store.requireProfileById(authority.id);
    } catch {
      return;
    }
    if (profile.processGeneration !== authority.generation || profile.state === "removed") return;
    if (
      fact.type !== "providerDisconnected"
      && this.#profileAuthorityRevocationIsPending(profile.id, authority.generation)
    ) return;
    if (fact.type === "providerDisconnected") {
      if (source === "personal") {
        const disconnected = this.#handleProviderDisconnected(
          authority,
          fact.connectionId,
          fact.reason,
          provider,
          source,
        );
        if (provider === "claude") this.#scheduleClaudeDisconnectRecovery(disconnected);
        return;
      }
      await this.#applyOrderedAccountFact(profile.id, () => {
        let current: ProfileRecord;
        try {
          current = this.#store.requireProfileById(authority.id);
        } catch (error: unknown) {
          if (error instanceof SelectionError && error.code === "NOT_FOUND") return;
          throw error;
        }
        if (current.processGeneration !== authority.generation) return;
        const disconnected = this.#handleProviderDisconnected(
          authority,
          fact.connectionId,
          fact.reason,
          provider,
          source,
        );
        if (provider === "claude") this.#scheduleClaudeDisconnectRecovery(disconnected);
        const claudeBlocker = provider === "codex"
          ? this.#store.providerAuthorityAdvanceBlocker(current.id, "claude")
          : null;
        if (claudeBlocker !== null) {
          // A spontaneous Codex disconnect cannot be retried like an explicit
          // login. Stop the daemon instead of rotating live Claude authority.
          this.#state = "closing";
          this.#interactionDeadlineAbort.abort(
            new Error(`Codex disconnected while Claude authority was ${claudeBlocker}.`),
          );
          this.#interactionDeadlineWake?.();
          this.#interactionDeadlineWake = undefined;
          this.#daemonAuthority.close();
          this.#scheduleStop();
          return;
        }
        if (provider === "claude" || this.#profileHasControllingRuntimeAuthority(current)) {
          this.#wakeSessionTaskPump();
          return;
        }
        const retirement = this.#store.advanceProfileGenerationWithWorkRetirement(
          authority.id,
          authority.generation,
          this.#work,
          { preserveSessionMutationAuthorities: true },
        );
        this.#notifyAffectedWork(retirement.affectedWorkIds);
        this.#wakeSessionTaskPump();
      });
      return;
    }
    if (fact.type === "providerConnected") return;
    if (fact.type === "notificationIgnored") return;
    if (fact.type === "rateLimitsUpdated") {
      if (source === "personal" || provider !== "codex") return;
      this.#scheduleUsageRefresh(authority);
      return;
    }
    if (fact.type === "loginCompleted") {
      if (source === "personal" || provider !== "codex") return;
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
    // Codex facts retain the selected Codex-account prerequisite. Claude facts
    // are instead fenced by their exact provider account and process authority,
    // so a profile whose independent Codex login is signed out remains usable.
    if (provider === "codex" && profile.state !== "signed_in") return;
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
        : this.#findSessionForProviderFact(
            authority.id,
            fact.provider.threadId,
            provider,
            source,
          );
      if (session === null || fact.provider.threadId === null) return;
      const providerThreadId = fact.provider.threadId;
      const admit = async (): Promise<void> => {
        const currentProfile = this.#store.requireProfileById(authority.id);
        if (
          currentProfile.processGeneration !== authority.generation
          || (provider === "codex" && currentProfile.state !== "signed_in")
          || this.#profileAuthorityRevocationIsPending(
            currentProfile.id,
            authority.generation,
          )
        ) return;
        const exact = fact.provider.threadId === null
          ? null
          : this.#findSessionForProviderFact(
              authority.id,
              fact.provider.threadId,
              provider,
            source,
          );
        if (exact === null) return;
        if (!await this.#ensureSessionFactAuthority(
          exact,
          authority,
          provider,
          source,
          providerThreadId,
          fact.connectionId,
        )) return;
        if (!this.#sessionFactAuthorityIsCurrent(
          exact.id,
          authority,
          provider,
          source,
          providerThreadId,
          fact.connectionId,
        )) return;
        const admitted = this.#store.admitInteraction({
          publicId: randomUUID(),
          sessionId: exact.id,
          authority: fact.provider,
          kind: fact.kind,
          blocking: fact.blocking,
          display: sanitizeInteractionDisplay(fact.display),
          ...(fact.timeoutMs === undefined ? {} : { timeoutMs: fact.timeoutMs }),
          ...(fact.requestedAt === undefined ? {} : { requestedAt: fact.requestedAt }),
          ...(fact.deadlineAt === undefined ? {} : { deadlineAt: fact.deadlineAt }),
        });
        if (!admitted.replayed && admitted.record.sessionId !== null) {
          if (!this.#sessionFactAuthorityIsCurrent(
            exact.id,
            authority,
            provider,
            source,
            providerThreadId,
            fact.connectionId,
          )) return;
          this.#appendSessionEvent(authority, admitted.record.sessionId, fact.connectionId, {
            type: "interaction_requested",
            interactionId: admitted.record.publicId,
            interactionKind: admitted.record.kind,
            revision: admitted.record.revision,
            blocking: admitted.record.blocking,
            summary: admitted.record.display.summary,
          });
          this.#scheduleAutorespond(admitted.record);
        }
        this.#wakeInteractionDeadlinePump();
      };
      await this.#applyOrderedSessionFact(session, admit);
      return;
    }
    if (fact.type === "interactionResolved") {
      const observed = this.#store.findInteractionByAuthority(fact.provider);
      if (observed === null) return;
      const settle = async (): Promise<void> => {
        const currentProfile = this.#store.requireProfileById(authority.id);
        if (
          currentProfile.processGeneration !== authority.generation
          || (provider === "codex" && currentProfile.state !== "signed_in")
          || this.#profileAuthorityRevocationIsPending(
            currentProfile.id,
            authority.generation,
          )
        ) return;
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
          if (current.sessionId === null || fact.provider.threadId === null) return;
          if (!this.#sessionFactAuthorityIsCurrent(
            current.sessionId,
            authority,
            provider,
            source,
            fact.provider.threadId,
            fact.provider.connectionId,
          )) return;
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
      };
      const ordered = async (): Promise<void> => {
        if (observed.sessionId === null) {
          await this.#applyOrderedAccountFact(authority.id, settle);
          return;
        }
        const session = this.#store.requireSession(observed.sessionId);
        if (!this.#sessionUsesFactSource(session, provider, source)) return;
        await this.#applyOrderedSessionFact(session, async () => {
          const exact = this.#store.requireSession(session.id);
          if (!this.#sessionUsesFactSource(exact, provider, source)) return;
          if (fact.provider.threadId === null) return;
          if (!await this.#ensureSessionFactAuthority(
            exact,
            authority,
            provider,
            source,
            fact.provider.threadId,
            fact.provider.connectionId,
          )) return;
          await settle();
        });
      };
      if (this.#mutationTails.has(`interaction:${observed.publicId}`)) {
        const tracked = ordered().catch((error: unknown) => {
          if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
          else this.recordBackgroundDiagnostic("session_state_tracking_failed", error);
        });
        this.#background.add(tracked);
        void tracked.then(() => this.#background.delete(tracked));
      } else {
        await ordered();
      }
      return;
    }
    if (fact.type === "protocolNotice") {
      if (fact.connectionId === undefined) return;
      const observations: Promise<void>[] = [];
      for (const [sessionId, connectionId] of [...this.#sessionProviderConnections]) {
        if (connectionId !== fact.connectionId) continue;
        const session = this.#store.requireSession(sessionId);
        if (
          session.profileId !== authority.id
          || !this.#sessionUsesFactSource(session, provider, source)
        ) continue;
        observations.push(this.#applyOrderedSessionFact(session, async () => {
          const exact = this.#store.requireSession(session.id);
          if (
            exact.profileId !== authority.id
            || !this.#sessionUsesFactSource(exact, provider, source)
          ) return;
          if (exact.providerThreadId === undefined) return;
          if (!await this.#ensureSessionFactAuthority(
            exact,
            authority,
            provider,
            source,
            exact.providerThreadId,
            connectionId,
          )) return;
          if (!this.#sessionFactAuthorityIsCurrent(
            exact.id,
            authority,
            provider,
            source,
            exact.providerThreadId,
            connectionId,
          )) return;
          this.#appendSessionEvent(authority, exact.id, connectionId, {
            type: "protocol_incompatible",
            method: fact.method,
            payloadDigest: digestText(fact.method),
          });
        }));
      }
      await Promise.all(observations);
      return;
    }
    if (!("threadId" in fact) || typeof fact.threadId !== "string") return;
    const observedSession = this.#findSessionForProviderFact(
      authority.id,
      fact.threadId,
      provider,
      source,
    );
    if (
      observedSession === null
      || (observedSession.state === "terminal" && fact.type !== "threadDeleted")
      || (observedSession.state === "recovery_required" && fact.type !== "threadDeleted")
    ) return;
    // Provider deletion is the terminal authority that supersedes an
    // in-flight compact-projection recovery. It must not queue behind that
    // recovery's session tail, or both sides wait for the other to settle.
    if (fact.type === "threadDeleted") {
      if (fact.connectionId === undefined) return;
      if (!this.#sessionFactAuthorityIsCurrent(
        observedSession.id,
        authority,
        provider,
        source,
        fact.threadId,
        fact.connectionId,
        { allowRecoveryRequired: true },
      )) return;
      await this.#applyProviderThreadDeletion(
        authority,
        fact,
        observedSession,
        provider,
        source,
      );
      return;
    }
    await this.#applyOrderedSessionFact(observedSession, async () => {
      const currentProfile = this.#store.requireProfileById(authority.id);
      if (
        currentProfile.processGeneration !== authority.generation
        || (provider === "codex" && currentProfile.state !== "signed_in")
        || this.#profileAuthorityRevocationIsPending(
          currentProfile.id,
          authority.generation,
        )
      ) return;
      const session = this.#findSessionForProviderFact(
        authority.id,
        fact.threadId,
        provider,
        source,
      );
      if (
        session === null
        || session.state === "terminal"
        || session.state === "recovery_required"
      ) return;
      if (!await this.#ensureSessionFactAuthority(
        session,
        authority,
        provider,
        source,
        fact.threadId,
        fact.connectionId,
      )) return;
      const event = this.#eventBodyForCodexFact(fact, session);
      if (event !== null) {
        if (!this.#sessionFactAuthorityIsCurrent(
          session.id,
          authority,
          provider,
          source,
          fact.threadId,
          fact.connectionId,
        )) return;
        this.#appendSessionEvent(authority, session.id, fact.connectionId ?? null, event);
      }
      const recoveryUnsettled = await this.#cloud
        .isCompactProjectionRecoveryUnsettled(session.id);
      await this.#daemonAuthority.assertCurrent();
      const exact = this.#findSessionForProviderFact(
        authority.id,
        fact.threadId,
        provider,
        source,
      );
      if (
        exact === null
        || recoveryUnsettled
        || this.#projectionRecoveriesInFlight.has(session.id)
      ) return;
      if (!this.#sessionFactAuthorityIsCurrent(
        exact.id,
        authority,
        provider,
        source,
        fact.threadId,
        fact.connectionId,
      )) return;
      const priorRevision = exact.revision;
      const dispatchQueue = this.#applyCodexFact(authority, fact, exact);
      const committed = this.#store.requireSession(exact.id);
      if (committed.revision !== priorRevision) {
        await this.#reconcileCommittedSessionFactsMemory(committed);
      }
      if (dispatchQueue) this.#scheduleIdleQueue(committed);
    });
  }

  async #applyProviderThreadDeletion(
    authority: ProfileAuthority,
    fact: Extract<CodexFact, { type: "threadDeleted" }>,
    expected: SessionRecord,
    provider: Provider,
    source: ProviderFactSource,
  ): Promise<void> {
    const current = this.#store.findSessionByProviderThread(authority.id, fact.threadId);
    if (current === null || current.id !== expected.id) return;
    if (!this.#sessionFactAuthorityIsCurrent(
      current.id,
      authority,
      provider,
      source,
      fact.threadId,
      fact.connectionId,
      { allowRecoveryRequired: true },
    )) return;
    this.#persistSessionEventWrites(this.#eventRedactor.interruptSession({
      sessionId: current.id,
      accountId: authority.id,
      providerGeneration: authority.generation,
      providerConnectionId: fact.connectionId ?? null,
    }));
    this.#bumpSessionFactEpoch(current.id);
    if (!this.#sessionFactAuthorityIsCurrent(
      current.id,
      authority,
      provider,
      source,
      fact.threadId,
      fact.connectionId,
      { allowRecoveryRequired: true },
    )) return;
    const terminal = this.#store.terminalizeSessionFromProviderDeletion({
      accountId: authority.id,
      providerConnectionId: fact.connectionId ?? null,
      providerGeneration: authority.generation,
      sessionId: current.id,
    });
    if (terminal.event !== undefined) this.#eventWaiters.notify(current.id);
    for (const interaction of terminal.interactions) this.#appendInteractionState(interaction);
    const terminalSession = this.#store.requireSession(current.id);
    const personalBinding = this.#store.readSessionPersonalRuntimeBinding(current.id, true);
    if (
      personalBinding !== null
      && personalBinding.state !== "detached"
      && personalBinding.provider === terminalSession.provider
      && personalBinding.providerThreadId === terminalSession.providerThreadId
    ) {
      if (personalBinding.state === "active") {
        this.#clearSessionFactAuthority(terminalSession.id);
        this.#store.beginPersonalSessionDetach({ sessionId: terminalSession.id });
      }
      this.#scheduleTerminalPersonalDetach(terminalSession);
    } else if (
      terminalSession.provider === "claude"
      && terminalSession.providerThreadId !== undefined
    ) {
      this.#scheduleClaudeProcessAuthorityRelease({
        providerThreadId: terminalSession.providerThreadId,
        profileId: terminalSession.profileId,
        runtimeScope: "managed",
      });
    }
    await this.#cleanupTerminalFactsMemory(terminalSession);
    this.#sessionProviderConnections.delete(current.id);
    this.#clearSessionFactAuthority(current.id);
    this.#sessionObservationFailures.delete(current.id);
    this.#sessionResubscriptionConnections.delete(current.id);
    this.#sessionsAwaitingResubscription.delete(current.id);
    await this.#cloud.supersedeCompactProjectionRecoveryForProviderDeletion(current.id);
    await this.#daemonAuthority.assertCurrent();
  }

  /*
   * Autorespond: answer a freshly admitted approval on behalf of the human
   * when the session's approval mode allows it. Runs in the background behind
   * the interaction's own serialization key; the ordinary resolve path enforces
   * revision, deadline, and provider-offered decisions, and every attempt
   * leaves an evidence row whether it accepted or escalated.
   */
  #scheduleAutorespond(record: InteractionRecord): void {
    if (record.sessionId === null) return;
    if (
      record.kind !== "command_approval"
      && record.kind !== "file_change_approval"
      && record.kind !== "permission_approval"
    ) return;
    const sessionId = record.sessionId;
    const tracked = this.#autorespondAdmitted(record, sessionId).then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
        else this.recordBackgroundDiagnostic("autorespond_failed", error);
      },
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  async #autorespondAdmitted(record: InteractionRecord, sessionId: SessionRecord["id"]): Promise<void> {
    const startedAt = this.#now();
    const { mode } = this.#store.readSessionApprovalMode(sessionId);
    const budgets = this.#store.readAutorespondBudgets(sessionId, startedAt);
    const decision = decideAutorespond({ budgets, display: record.display, kind: record.kind, mode });
    const kind = record.kind as "command_approval" | "file_change_approval" | "permission_approval";
    if (decision.action === "escalate") {
      if (decision.code !== "manual_mode" && decision.code !== "not_an_approval") {
        this.#store.recordAutorespondEvidence({
          approvalClass: decision.approvalClass,
          decision: decision.code,
          interactionId: record.publicId,
          kind,
          latencyMs: this.#now() - startedAt,
          mode,
          outcome: "refused",
          sessionId,
          subagent: false,
        });
      }
      return;
    }
    const resolution = record.kind === "permission_approval"
      ? { kind: "permission_grant" as const, permissions: permissionNamesOf(record.display), scope: null }
      : { kind: "approval_decision" as const, decision: decision.decision };
    let outcome: "accepted" | "refused" = "accepted";
    try {
      await this.#resolveInteraction(
        {
          kind: "interaction.resolve",
          interaction: record.publicId,
          expectedRevision: record.revision,
          resolution,
        },
        { signal: this.#backgroundAbort.signal },
      );
      this.#store.markInteractionResolvedBy(record.publicId, "autorespond");
      this.#store.bumpAutorespondCounter(sessionId);
    } catch (error: unknown) {
      outcome = "refused";
      if (!(error instanceof CommandFailure)) throw error;
    } finally {
      this.#store.recordAutorespondEvidence({
        approvalClass: decision.approvalClass,
        decision: decision.decision,
        interactionId: record.publicId,
        kind,
        latencyMs: this.#now() - startedAt,
        mode,
        outcome,
        sessionId,
        subagent: false,
      });
    }
  }

  #requireGatewayKeys(): GatewayKeyPort {
    if (this.#gatewayKeys === undefined) {
      throw new CommandFailure(
        "UNAVAILABLE",
        "Local secret custody for the autorespond gateway key is unavailable in this daemon.",
      );
    }
    return this.#gatewayKeys;
  }

  async #gatewayConfigured(): Promise<boolean> {
    try {
      return await this.#gatewayKeys?.isConfigured() ?? false;
    } catch {
      return false;
    }
  }

  /*
   * Prose autorespond (W2). A completed turn that classified as
   * `needs_approval` through the lexical approval cue — never through a pending
   * provider interaction — may be answered on the human's behalf. Everything
   * below is a refusal path except the last one, and every path leaves one
   * evidence row.
   */
  #scheduleProseAutorespond(
    sessionId: SessionRecord["id"],
    turnId: string,
    classification: SessionStateClassification,
  ): void {
    if (this.#proseResponder === undefined) return;
    if (classification.state !== "needs_approval") return;
    // At most one autoresponse per turn, even if the state is re-emitted.
    if (this.#proseAutorespondedTurns.get(sessionId) === turnId) return;
    this.#proseAutorespondedTurns.set(sessionId, turnId);
    const tracked = this.#autorespondProse(sessionId, classification).then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
        else this.recordBackgroundDiagnostic("prose_autorespond_failed", error);
      },
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  async #autorespondProse(
    sessionId: SessionRecord["id"],
    classification: SessionStateClassification,
  ): Promise<void> {
    const responder = this.#proseResponder;
    if (responder === undefined) return;
    const startedAt = this.#now();
    const { mode } = this.#store.readSessionApprovalMode(sessionId);
    const rule = classification.matchedRule;
    const finalText = this.#sessionStateTracker.finalAssistantText(sessionId);
    const refuse = (code: ProseAutorespondGateFailure): void => {
      this.#store.recordProseAutorespondEvidence({
        decision: "refuse",
        latencyMs: this.#now() - startedAt,
        mode,
        model: null,
        outcome: `gate_failed:${code}`,
        rule,
        sessionId,
      });
    };

    // The positive gate. Each clause must hold before a model is consulted.
    if (rule !== "approval_cue") return refuse("not_an_approval_cue");
    if (this.#store.listInteractions({ sessionId, pendingOnly: true, limit: 1 }).length > 0) {
      return refuse("pending_interaction");
    }
    const prepared = prepareAssistantText(finalText);
    // The classifier reads cues over the stripped text and, for the full
    // human-action list, only over the tail. The gate is stricter on purpose:
    // it scans the whole raw message, fenced code and blockquotes included, so
    // a quoted login step or a destructive command inside a code block still
    // hands the turn back to the human.
    if (
      STRONG_HUMAN_ACTION_CUES.some((cue) => cue.test(finalText))
      || HUMAN_ACTION_CUES.some((cue) => cue.test(finalText))
    ) return refuse("human_action_cue");
    if (DENYLIST_CUES.some((cue) => cue.test(finalText))) return refuse("denylist_cue");
    if (finalText.length >= PROSE_AUTORESPOND_MAX_MESSAGE_CHARACTERS) {
      return refuse("message_too_long");
    }
    if (!await this.#gatewayConfigured()) return refuse("gateway_key_missing");
    const verbatimLiteral = classification.verbatimRequired
      ? classification.verbatimLiteral
      : undefined;
    if (classification.verbatimRequired && verbatimLiteral === undefined) {
      return refuse("verbatim_literal_missing");
    }
    const budgets = this.#store.readAutorespondBudgets(sessionId, startedAt);
    const decision = decideProseAutorespond({ budgets, mode });
    if (decision.action === "escalate") return refuse(decision.code);

    const durable = this.#store.readSessionState(sessionId);
    let result: Awaited<ReturnType<ProseResponder["respond"]>>;
    try {
      result = await responder.respond(
        {
          assistantTail: prepared.tail,
          report: {
            version: 1,
            session: sessionId,
            state: durable?.state ?? classification.state,
            attention: durable?.attention ?? classification.attention,
            reason: durable?.reason ?? classification.reason,
            verbatimRequired: classification.verbatimRequired,
            lastActivityAt: durable?.lastActivityAt ?? null,
            revision: durable?.revision ?? 0,
          },
          ...(verbatimLiteral === undefined ? {} : { verbatimLiteral }),
        },
        this.#backgroundAbort.signal,
      );
    } catch {
      this.#store.recordProseAutorespondEvidence({
        decision: "refuse",
        latencyMs: this.#now() - startedAt,
        mode,
        model: null,
        outcome: "responder_failed",
        rule,
        sessionId,
      });
      return;
    }

    /*
     * The responder is never trusted with free text. A verbatim ask must come
     * back byte-exact from the assistant's own message; every other approval is
     * answered with the one fixed sentence, whatever the model produced.
     */
    let reply = PROSE_APPROVAL_REPLY;
    if (verbatimLiteral !== undefined) {
      if (!finalText.includes(result.reply)) {
        this.#store.recordProseAutorespondEvidence({
          decision: "refuse",
          latencyMs: this.#now() - startedAt,
          mode,
          model: result.model,
          outcome: "verbatim_mismatch",
          rule,
          sessionId,
        });
        this.#escalateSessionState(sessionId, "autorespond_verbatim_mismatch");
        return;
      }
      reply = result.reply;
    }

    let outcome: "sent" | "responder_failed" = "sent";
    try {
      const session = this.#store.requireSession(sessionId);
      await this.#serializeSessionAuthority(session, async () =>
        this.#send(session.id, reply, undefined, this.#backgroundAbort.signal, undefined, "autorespond"));
      this.#store.bumpAutorespondCounter(sessionId);
    } catch (error: unknown) {
      outcome = "responder_failed";
      if (!(error instanceof CommandFailure) && !(error instanceof SelectionError)) throw error;
    } finally {
      this.#store.recordProseAutorespondEvidence({
        decision: outcome === "sent" ? "send" : "refuse",
        latencyMs: this.#now() - startedAt,
        mode,
        model: result.model,
        outcome,
        rule,
        sessionId,
      });
    }
  }

  /*
   * Emit one further `session_state` revision after an autorespond outcome
   * that hands the turn back to the human. A later revision always wins, so
   * the browser and the CLI converge on the escalation.
   */
  #escalateSessionState(sessionId: SessionRecord["id"], reason: string): void {
    try {
      const body = this.#sessionStateTracker.escalate(sessionId, {
        attention: true,
        reason,
        state: "needs_answer",
      });
      const snapshot = this.#sessionStateTracker.snapshot(sessionId);
      if (snapshot === null) return;
      this.#store.upsertSessionState({
        sessionId,
        state: snapshot.state,
        attention: snapshot.attention,
        reason: snapshot.reason,
        verbatimRequired: snapshot.verbatimRequired,
        verbatimLiteral: snapshot.verbatimLiteral,
        lastActivityAt: snapshot.lastActivityAt,
        revision: snapshot.revision,
      });
      const session = this.#store.requireSession(sessionId);
      const profile = this.#store.requireProfile(session.profileId);
      this.#appendSessionEvent(
        authorityFor(this.#paths, profile),
        sessionId,
        this.#sessionProviderConnections.get(sessionId) ?? null,
        body,
      );
    } catch (error: unknown) {
      this.recordBackgroundDiagnostic("session_state_tracking_failed", error);
    }
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
      this.#trackSessionState(write);
    }
  }

  /*
   * Classify the session after every persisted event. The tracker decides
   * whether the state changed; a change is persisted as the session's durable
   * latest state and appended as one `session_state` event. Failures here are
   * background diagnostics, never a reason to drop the originating event.
   */
  #trackSessionState(write: SessionEventWrite): void {
    if (write.body.type === "session_state") return;
    try {
      if (this.#sessionStateTracker.snapshot(write.sessionId) === null) {
        const durable = this.#store.readSessionState(write.sessionId);
        if (durable !== null) {
          this.#sessionStateTracker.seed(write.sessionId, {
            state: durable.state,
            attention: durable.attention,
            reason: durable.reason,
            verbatimRequired: durable.verbatimRequired,
            verbatimLiteral: durable.verbatimLiteral ?? undefined,
            lastActivityAt: durable.lastActivityAt,
            revision: durable.revision,
          });
        }
      }
      const pending = write.body.type === "interaction_requested"
        || write.body.type === "interaction_state"
        || write.body.type === "turn_completed"
        ? this.#store.listInteractions({ sessionId: write.sessionId, pendingOnly: true, limit: 1 })[0]
        : undefined;
      const body = this.#sessionStateTracker.observe(write.sessionId, write.body, {
        ...(pending === undefined ? {} : { pendingInteraction: { kind: pending.kind } }),
      });
      if (body === null) return;
      const snapshot = this.#sessionStateTracker.snapshot(write.sessionId);
      if (snapshot === null) return;
      this.#store.upsertSessionState({
        sessionId: write.sessionId,
        state: snapshot.state,
        attention: snapshot.attention,
        reason: snapshot.reason,
        verbatimRequired: snapshot.verbatimRequired,
        verbatimLiteral: snapshot.verbatimLiteral,
        lastActivityAt: snapshot.lastActivityAt,
        revision: snapshot.revision,
      });
      this.#store.appendPublicSessionEvent({ ...write, body });
      this.#eventWaiters.notify(write.sessionId);
      // A prose approval is only ever answered for a turn that just ended and
      // left no pending provider interaction behind.
      if (
        body.state === "needs_approval"
        && write.body.type === "turn_completed"
        && pending === undefined
      ) {
        const classification = this.#sessionStateTracker.classification(write.sessionId);
        if (classification !== null) {
          this.#scheduleProseAutorespond(write.sessionId, write.body.turnId, classification);
        }
      }
    } catch (error: unknown) {
      this.recordBackgroundDiagnostic("session_state_tracking_failed", error);
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
    if (previous === connectionId) {
      try {
        this.#mintSessionFactAuthority(authority, session, connectionId);
      } catch (error: unknown) {
        this.#clearSessionFactAuthority(session.id);
        throw error;
      }
      return;
    }
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
    try {
      this.#mintSessionFactAuthority(authority, session, connectionId);
    } catch (error: unknown) {
      this.#sessionProviderConnections.delete(session.id);
      this.#clearSessionFactAuthority(session.id);
      throw error;
    }
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
    provider?: Provider,
    source?: ProviderFactSource,
  ): readonly SessionRecord[] {
    const disconnected: SessionRecord[] = [];
    const terminal = this.#store.expireGenerationInteractions({
      profileId: authority.id,
      processGeneration: authority.generation,
      connectionId,
    });
    for (const interaction of terminal) this.#appendInteractionState(interaction);
    for (const [sessionId, activeConnectionId] of [...this.#sessionProviderConnections]) {
      if (activeConnectionId !== connectionId) continue;
      const session = this.#store.requireSession(sessionId);
      if (
        session.profileId !== authority.id
        || (
          provider !== undefined
          && source !== undefined
          && !this.#sessionUsesFactSource(session, provider, source)
        )
      ) continue;
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
      this.#clearSessionFactAuthority(session.id);
      this.#sessionObservationFailures.delete(session.id);
      this.#sessionResubscriptionConnections.delete(session.id);
      this.#sessionsAwaitingResubscription.add(session.id);
      disconnected.push(session);
    }
    return disconnected;
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
      if (session.profileId !== profileId || session.provider !== "codex") continue;
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
      const currentConnection = this.#sessionProviderConnections.get(retirement.sessionId);
      if (
        currentConnection !== undefined
        && currentConnection !== retirement.connectionId
      ) {
        throw new Error("ACCOUNT_LOGIN_RETIREMENT_CONNECTION_CHANGED");
      }
      this.#sessionProviderConnections.delete(retirement.sessionId);
      this.#clearSessionFactAuthority(retirement.sessionId);
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
      // A `subAgentActivity` marker item announces the same activity on both
      // its started and its completed notification, so the projection is the
      // same body twice at most. Every consumer folds by agent id, so the
      // repeat is a no-op rather than a second subagent.
      case "itemStarted":
      case "itemCompleted": {
        if (fact.subagent !== undefined) {
          return {
            type: "subagent_activity",
            turnId: fact.turnId,
            agentId: fact.subagent.agentThreadId,
            kind: fact.subagent.kind,
          };
        }
        // A tool-shaped item carries the stable call identity a later result
        // binds back to, plus a classified one-line summary. Both are built
        // only from fields the protocol layer already reduced to safe labels.
        const toolIdentity = isNeutralToolItemKind(fact.itemKind)
          ? {
              callId: fact.itemId,
              summary: neutralToolSummary(fact),
            }
          : {};
        return fact.type === "itemStarted"
          ? {
              type: "item_started",
              turnId: fact.turnId,
              itemId: fact.itemId,
              itemKind: fact.itemKind,
              ...(fact.server === undefined ? {} : { server: fact.server }),
              ...(fact.tool === undefined ? {} : { tool: fact.tool }),
              ...(fact.liveAcceptanceCommandDigest === undefined
                ? {}
                : { liveAcceptanceCommandDigest: fact.liveAcceptanceCommandDigest }),
              ...toolIdentity,
            }
          : {
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
              ...toolIdentity,
            };
      }
      // Only a spawned subagent thread reaches here, and only its bounded
      // nickname, role, and depth. Without an active turn there is nothing to
      // attach the activity to, so the metadata is dropped.
      case "subagentThreadStarted": {
        const turnId = session.activeTurnId ?? null;
        if (turnId === null) return null;
        return {
          type: "subagent_activity",
          turnId,
          agentId: fact.agentThreadId,
          kind: "started",
          ...(fact.depth === undefined ? {} : { depth: fact.depth }),
          ...(fact.nickname === undefined ? {} : { nickname: fact.nickname }),
          ...(fact.role === undefined ? {} : { role: fact.role }),
        };
      }
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
      case "rateLimitsUpdated":
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
    if (profile.processGeneration !== authority.generation) return false;
    const current = this.#store.findSessionByProviderThread(authority.id, fact.threadId);
    if (
      current === null
      || current.id !== expected.id
      || !this.#profileAllowsEstablishedSession(profile, current)
      || current.state === "terminal"
      || (current.state === "recovery_required" && fact.type !== "threadDeleted")
      || this.#projectionRecoveriesInFlight.has(current.id)
    ) return false;
    this.#bumpSessionFactEpoch(current.id);
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
    const failedRuntimeScopes = new Set<string>();
    try {
      if (this.#interactionDeadlineTask !== undefined) {
        await this.#interactionDeadlineTask.catch(() => undefined);
      }
      if (this.#sessionTaskPumpTask !== undefined) {
        await this.#sessionTaskPumpTask.catch(() => undefined);
      }
      const runtimes = new Map<
        SessionRuntimePort<ReviewedRuntimeProfile>,
        Array<Readonly<{ provider: Provider; runtimeScope: RuntimeAccountScope }>>
      >();
      const registerRuntime = (
        runtime: SessionRuntimePort<ReviewedRuntimeProfile>,
        provider: Provider,
        runtimeScope: RuntimeAccountScope,
      ): void => {
        const authorities = runtimes.get(runtime) ?? [];
        authorities.push({ provider, runtimeScope });
        runtimes.set(runtime, authorities);
      };
      registerRuntime(this.#codex, "codex", "managed");
      registerRuntime(this.#claude, "claude", "managed");
      if (this.#personalCodex !== undefined) {
        registerRuntime(this.#personalCodex, "codex", "personal");
      }
      if (this.#personalClaude !== undefined) {
        registerRuntime(this.#personalClaude, "claude", "personal");
      }
      const runtimeEntries = [...runtimes.entries()];
      const closed = await Promise.allSettled(
        runtimeEntries.map(async ([runtime]) => await runtime.close()),
      );
      for (const [index, outcome] of closed.entries()) {
        if (outcome.status === "rejected") {
          runtimeError ??= outcome.reason;
          const entry = runtimeEntries[index];
          if (entry !== undefined) {
            for (const authority of entry[1]) {
              failedRuntimeScopes.add(
                `${authority.provider}:${authority.runtimeScope}`,
              );
            }
          }
        }
      }
    } catch (error: unknown) {
      runtimeError = error;
    }
    await this.#drainOwnedWork();
    this.#persistSessionEventWrites(this.#eventRedactor.interruptAll());
    if (runtimeError !== undefined) {
      const quarantineErrors: unknown[] = [];
      for (const profile of this.#store.listProfiles()) {
        for (const provider of ["codex", "claude"] as const) {
          for (const session of this.#store.listNonterminalProviderSessions(
            profile.id,
            provider,
          )) {
            const recorded = this.#store.readSessionProviderAccountAuthority(
              session.id,
            );
            const runtimeScope: RuntimeAccountScope = recorded !== null
              && recorded.provider === session.provider
              ? recorded.runtimeScope
              : this.#sessionHasMatchingActivePersonalBinding(session)
                ? "personal"
                : "managed";
            if (!failedRuntimeScopes.has(`${provider}:${runtimeScope}`)) continue;
            try {
              this.#quarantineSession(session.id);
            } catch (error: unknown) {
              quarantineErrors.push(error);
            }
          }
        }
      }
      this.#sessionProviderConnections.clear();
      this.#sessionObservationFailures.clear();
      this.#sessionResubscriptionConnections.clear();
      this.#sessionsAwaitingResubscription.clear();
      this.#state = "closed";
      if (quarantineErrors.length > 0) {
        throw new AggregateError(
          [runtimeError, ...quarantineErrors],
          "A provider runtime failed to close and its matching durable session quarantine was incomplete.",
        );
      }
      throw runtimeError instanceof Error
        ? runtimeError
        : new Error("A provider runtime closed with a non-Error failure.");
    }
    let retirementError: unknown;
    try {
      this.#settleClosedClaudeProcessAuthorities();
      this.#retireClosedRuntimeAuthorities();
    } catch (error: unknown) {
      retirementError = error;
    }
    this.#state = "closed";
    if (retirementError !== undefined) {
      throw retirementError instanceof Error
        ? retirementError
        : new Error("Provider runtime authority retirement failed with a non-Error failure.");
    }
  }

  #settleClosedClaudeProcessAuthorities(): void {
    for (;;) {
      const live = this.#store.listUnreleasedClaudeProcessAuthorities();
      if (live.length === 0) break;
      for (const process of live) {
        const releasing = process.state === "releasing"
          ? process
          : this.#store.beginClaudeProcessAuthorityRelease({
              providerThreadId: process.providerThreadId,
              profileId: process.profileId,
              runtimeScope: process.runtimeScope,
              expectedRevision: process.revision,
              identity: process.identity,
            });
        this.#store.completeClaudeProcessAuthorityRelease({
          providerThreadId: releasing.providerThreadId,
          profileId: releasing.profileId,
          runtimeScope: releasing.runtimeScope,
          expectedRevision: releasing.revision,
          identity: releasing.identity,
        });
      }
    }
    for (;;) {
      const intents = this.#store.listClaudeProcessLaunchIntents();
      if (intents.length === 0) return;
      for (const intent of intents) this.#cancelClaudeProcessLaunchIntent(intent);
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
          this.#clearSessionFactAuthority(sessionId);
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
          this.#clearSessionFactAuthority(sessionId);
          this.#sessionObservationFailures.delete(sessionId);
          this.#sessionResubscriptionConnections.delete(sessionId);
          this.#sessionsAwaitingResubscription.delete(sessionId);
        }
      }
      try {
        const unsettledClaudeLogin = this.#store
          .listUnsettledMutations({ authorityId: profile.id })
          .some((attempt) => attempt.kind === "account.claude-login");
        // The foreground Claude child is owned by the invoking CLI rather than
        // this runtime manager. Preserve its exact completion generation even
        // though the daemon's managed session runtimes have already closed.
        if (unsettledClaudeLogin) continue;
        const retirement = this.#store.advanceProfileGenerationForDaemonShutdown(
          profile.id,
          profile.processGeneration,
          this.#work,
          { preserveSessionMutationAuthorities: true },
        );
        this.#notifyAffectedWork(retirement.affectedWorkIds);
      } catch (error: unknown) {
        projectionErrors.push(error);
      }
    }
    this.#sessionProviderConnections.clear();
    this.#sessionFactAuthorities.clear();
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

  async #fencedRuntimeReview<Profile>(
    runtime: SessionRuntimePort<Profile>,
    operation: () => Promise<RuntimeStartReviewOf<Profile>>,
  ): Promise<RuntimeStartReviewOf<Profile>> {
    await this.#daemonAuthority.assertCurrent();
    const review = await operation();
    try {
      await this.#daemonAuthority.assertCurrent();
      return review;
    } catch (error: unknown) {
      runtime.discardRuntimeReview(review);
      throw error;
    }
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

  #claudeLoginRecovery(attempt: MutationAttemptRecord): Readonly<Record<string, unknown>> {
    const accountId = profileIdSchema.parse(attempt.authorityId);
    return {
      required: true,
      attemptId: attempt.id,
      idempotencyKey: attempt.idempotencyKey,
      providerGeneration: attempt.authorityGeneration,
      statusCommand: `hra account show ${accountId} --provider claude`,
      sameKeyReplayCommand: `hra account login ${accountId} --provider claude --idempotency-key ${attempt.idempotencyKey}`,
      abandonCommand: `hra account login-cancel ${accountId} --provider claude --attempt-id ${attempt.id} --provider-generation ${String(attempt.authorityGeneration)} --idempotency-key ${attempt.idempotencyKey} --acknowledge-child-exited`,
      diagnostic: "The foreground Claude login launch was granted once. Its exact completion can settle after a daemon restart. Status may report credential presence but never proves that the child exited or grants another launch. If the original HRA parent is gone, first confirm its Claude child exited, then run the exact acknowledged local abandon command; abandon does not stop Claude or change or delete credentials.",
    };
  }

  #publicClaudeAccount(profile: ProfileRecord): Readonly<{ id: ProfileRecord["id"]; label: string }> {
    return { id: profile.id, label: profile.label };
  }

  #assertClaudeIsolationAccepted(): void {
    if (this.#platform === "linux") return;
    throw new CommandFailure(
      "UNAVAILABLE",
      `Claude account isolation is acceptance-pending on ${this.#platform}. New Claude authentication, status, and session effects are currently supported only on Linux; run this operation against an HRA daemon on Linux.`,
      {
        platform: this.#platform,
        provider: "claude",
        reason: "claude_isolation_acceptance_pending",
        retryable: false,
        supportedPlatforms: ["linux"],
      },
    );
  }

  #claudePlatformUnavailableObservation(
    profile: ProfileRecord,
  ): PublicProviderObservation {
    return {
      basis: "local_state",
      code: "provider_platform_unavailable",
      coverage: "unavailable",
      freshness: "fresh",
      observedAt: this.#now(),
      profileGeneration: profile.processGeneration,
      source: "codex_app_server",
      state: "unavailable",
    };
  }

  async #readClaudeAccount(profile: ProfileRecord, signal: AbortSignal): Promise<CodexAccountProjection> {
    await this.#daemonAuthority.assertCurrent();
    return await this.#fencedEffect(async () => await this.#claude.readAccount({
      authority: authorityFor(this.#paths, profile),
      signal,
    }));
  }

  #unsettledClaudeLogin(profile: ProfileRecord): MutationAttemptRecord | undefined {
    return this.#store.listUnsettledMutations({ authorityId: profile.id }).find((attempt) =>
      attempt.kind === "account.claude-login");
  }

  async #showClaudeAccount(selector: string, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    const unsettled = this.#unsettledClaudeLogin(profile);
    if (unsettled !== undefined) {
      // The durable child fence is authoritative even when the provider
      // binary is missing, drifts from the pin, or cannot answer. Do not hide
      // the only exact recovery command behind a best-effort status process.
      return {
        account: this.#publicClaudeAccount(profile),
        authentication: { provider: "claude", signedIn: null },
        providerGeneration: profile.processGeneration,
        recovery: this.#claudeLoginRecovery(unsettled),
      };
    }
    this.#assertClaudeIsolationAccepted();
    const account = await this.#readClaudeAccount(profile, signal);
    return {
      account: this.#publicClaudeAccount(profile),
      authentication: { provider: "claude", signedIn: account.signedIn },
      providerGeneration: profile.processGeneration,
      ...(account.signedIn
        ? {}
        : { nextCommand: `hra account login ${profile.id} --provider claude` }),
    };
  }

  async #prepareClaudeLogin(
    selector: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    if (profile.state === "removed") throw new CommandFailure("NOT_FOUND", "That account is removed.");
    const prior = this.#store.readMutation(idempotencyKey);
    if (prior !== null) {
      // Reusing an existing key must validate the canonical request digest
      // before even a no-effect signed-in response may succeed.
      this.#store.prepareMutation({
        kind: "account.claude-login",
        authorityId: profile.id,
        authorityGeneration: prior.authorityGeneration,
        request: { provider: "claude" },
        idempotencyKey,
      });
      if (prior.state === "effect_started" || prior.state === "ambiguous") {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "This Claude login launch was already granted and will not be granted again.",
          this.#claudeLoginRecovery(prior),
        );
      }
      if (prior.state === "reconciled" && prior.resolution?.kind === "abandoned") {
        throw new CommandFailure(
          "CONFLICT",
          "This Claude login fence was explicitly abandoned. Start a fresh login with a new idempotency key.",
        );
      }
      if (prior.state === "applied" || prior.state === "reconciled") {
        const receipt = claudeLoginTerminalReceiptSchema.safeParse(prior.result);
        if (
          !receipt.success
          || receipt.data.accountId !== profile.id
          || receipt.data.attemptId !== prior.id
          || receipt.data.idempotencyKey !== prior.idempotencyKey
          || receipt.data.providerGeneration !== prior.authorityGeneration
        ) throw new CommandFailure("INTERNAL", "The Claude login terminal receipt is invalid.");
        if (!receipt.data.signedIn) {
          throw new CommandFailure(
            "INTERACTION_REQUIRED",
            "This Claude login attempt settled signed out. Start a fresh login with a new idempotency key.",
          );
        }
        return {
          account: this.#publicClaudeAccount(profile),
          authentication: { provider: "claude", signedIn: true },
          login: { status: "signed_in" },
        };
      }
      if (prior.state === "failed" || prior.state === "cancelled") {
        throw new CommandFailure(
          "INTERACTION_REQUIRED",
          "This Claude login attempt is terminal without sign-in. Start a fresh login with a new idempotency key.",
        );
      }
      if (prior.authorityGeneration !== profile.processGeneration) {
        if (!this.#store.transitionMutation(prior.id, "prepared", "cancelled", {
          provider: "claude",
          signedIn: false,
          status: "stale_no_effect",
        })) throw new CommandFailure("CONFLICT", "The Claude login preparation changed concurrently.");
        throw new CommandFailure(
          "CONFLICT",
          "This no-effect Claude login preparation belongs to an older provider generation. Start a fresh login with a new idempotency key.",
        );
      }
    }
    const unsettled = this.#unsettledClaudeLogin(profile);
    if (unsettled !== undefined) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "A Claude login already owns this account, including across provider generations.",
        this.#claudeLoginRecovery(unsettled),
      );
    }
    this.#assertClaudeIsolationAccepted();
    const providerBlocker = this.#store.managedClaudeLoginAuthorityBlocker(
      profile.id,
    );
    if (providerBlocker !== null) {
      throw new CommandFailure(
        providerBlocker === "active_session" ? "CONFLICT" : "RECOVERY_REQUIRED",
        `Claude login cannot replace the shared isolated configuration while Claude session authority is ${providerBlocker.replaceAll("_", " ")}. Inspect \`hra session list --account ${profile.id}\`, stop active turns, and resolve recovery before retrying.`,
        { provider: "claude", reason: providerBlocker, retryable: true },
      );
    }
    const releasableSessions = this.#store.listNonterminalManagedClaudeSessions(
      profile.id,
    );
    if (releasableSessions.some((session) =>
      session.state !== "idle"
      || session.activeTurnId !== undefined
      || session.providerThreadId === undefined)) {
      throw new CommandFailure(
        "CONFLICT",
        `Claude login can release only idle, fully bound Claude sessions. Inspect \`hra session list --account ${profile.id}\`, then finish or recover every other session before retrying.`,
        { provider: "claude", reason: "session_not_idle", retryable: true },
      );
    }
    const observed = await this.#readClaudeAccount(profile, signal);
    if (observed.signedIn) {
      if (prior?.state === "prepared") {
        if (!this.#store.transitionMutation(prior.id, "prepared", "cancelled", {
          provider: "claude",
          signedIn: true,
          status: "no_effect",
        })) throw new CommandFailure("CONFLICT", "The Claude login preparation changed concurrently.");
      }
      return {
        account: this.#publicClaudeAccount(profile),
        authentication: { provider: "claude", signedIn: true },
        login: { status: "signed_in" },
      };
    }
    if (releasableSessions.length > 0) {
      await this.#assertNoCompactProjectionRecoveryForProfile(profile.id);
      for (const candidate of releasableSessions) {
        await this.#serialize(`session:${candidate.id}`, async () => {
          const current = this.#store.requireSession(candidate.id);
          const blocker = this.#store.managedClaudeLoginAuthorityBlocker(
            profile.id,
          );
          if (
            blocker !== null
            || current.profileId !== profile.id
            || current.provider !== "claude"
            || current.state !== "idle"
            || current.activeTurnId !== undefined
            || current.providerThreadId === undefined
            || !this.#store.canReleaseIdleManagedClaudeSessionForAccountLogin({
              profileId: profile.id,
              profileGeneration: profile.processGeneration,
              sessionId: current.id,
            })
          ) {
            throw new CommandFailure(
              blocker === "recovery_required" || blocker === "unsettled_authority"
                ? "RECOVERY_REQUIRED"
                : "CONFLICT",
              "Claude session authority changed before the idle session could be released for login. Inspect the session and retry after it is quiescent.",
              { provider: "claude", reason: blocker ?? "session_not_idle", retryable: true },
            );
          }
          const providerConnectionId = this.#sessionProviderConnections.get(current.id) ?? null;
          // Login is specifically entered because the managed Claude account
          // no longer authenticates. A normal session end requires that stale
          // account key to remain current, which would make safe sign-in
          // impossible. The durable PID/start record is the narrower release
          // authority here: release that exact process without targeting a
          // replacement account, then retire the local session below.
          await this.#releaseClaudeProcessAuthority({
            providerThreadId: current.providerThreadId,
            profileId: current.profileId,
            runtimeScope: "managed",
          }, signal);
          await this.#daemonAuthority.assertCurrent();
          this.#persistSessionEventWrites(this.#eventRedactor.interruptSession({
            accountId: profile.id,
            providerConnectionId,
            providerGeneration: profile.processGeneration,
            sessionId: current.id,
          }));
          this.#appendSessionEvent(authorityFor(this.#paths, profile), current.id, providerConnectionId, {
            type: "connection",
            state: "disconnected",
            reason: "Claude account login",
          });
          this.#sessionProviderConnections.delete(current.id);
          this.#clearSessionFactAuthority(current.id);
          this.#sessionObservationFailures.delete(current.id);
          this.#sessionResubscriptionConnections.delete(current.id);
          this.#sessionsAwaitingResubscription.delete(current.id);
          const terminal = this.#store.terminalizeIdleClaudeSessionForAccountLogin({
            accountId: profile.id,
            providerConnectionId,
            providerGeneration: profile.processGeneration,
            sessionId: current.id,
          });
          if (terminal.event !== undefined) this.#eventWaiters.notify(current.id);
          for (const interaction of terminal.interactions) this.#appendInteractionState(interaction);
          await this.#cleanupTerminalFactsMemory(terminal.session);
          await this.#cloud.supersedeCompactProjectionRecoveryForProviderDeletion(current.id);
          await this.#daemonAuthority.assertCurrent();
        });
      }
    }
    let attempt: ReturnType<StateStore["prepareMutation"]>;
    try {
      attempt = this.#store.prepareMutation({
        kind: "account.claude-login",
        authorityId: profile.id,
        authorityGeneration: profile.processGeneration,
        request: { provider: "claude" },
        idempotencyKey,
      });
      this.#store.beginClaudeLoginMutationEffect({
        attemptId: attempt.id,
        profileId: profile.id,
        profileGeneration: profile.processGeneration,
        evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "UNSETTLED_MUTATION_AUTHORITY") {
        const blocking = this.#unsettledClaudeLogin(profile);
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "Another mutation already owns this account generation.",
          blocking === undefined ? undefined : this.#claudeLoginRecovery(blocking),
        );
      }
      throw error;
    }
    return {
      account: this.#publicClaudeAccount(profile),
      authentication: { provider: "claude", signedIn: false },
      login: {
        status: "launch_granted",
        attemptId: attempt.id,
        idempotencyKey,
        providerGeneration: profile.processGeneration,
      },
    };
  }

  async #completeClaudeLogin(
    command: Extract<LocalCommand, { kind: "account.claude-login.complete" }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const profile = this.#store.requireProfile(command.account);
    const attempt = this.#store.readMutation(command.idempotencyKey);
    if (
      attempt === null
      || attempt.id !== command.attemptId
      || attempt.kind !== "account.claude-login"
      || attempt.authorityId !== profile.id
      || attempt.authorityGeneration !== command.providerGeneration
    ) throw new CommandFailure("CONFLICT", "The Claude login completion does not match its exact launch authority.");
    if (attempt.state === "reconciled" && attempt.resolution?.kind === "abandoned") {
      throw new CommandFailure(
        "CONFLICT",
        "This Claude login fence was explicitly abandoned. Start a fresh login with a new idempotency key.",
      );
    }
    const priorReceipt = attempt.state === "applied"
      || attempt.state === "failed"
      || attempt.state === "reconciled"
      ? claudeLoginTerminalReceiptSchema.safeParse(attempt.result)
      : undefined;
    let signedIn: boolean;
    if (priorReceipt?.success === true) {
      signedIn = priorReceipt.data.signedIn;
    } else if (command.outcome.state === "not_started") {
      // The launch helper proved no child/effect existed. Settle from the
      // recorded signed-out baseline without making this no-effect completion
      // depend on a fallible provider status probe.
      signedIn = false;
    } else {
      signedIn = (await this.#readClaudeAccount(profile, signal)).signedIn;
    }
    try {
      this.#store.settleClaudeLoginMutation({
        attemptId: command.attemptId,
        idempotencyKey: command.idempotencyKey,
        profileId: profile.id,
        profileGeneration: command.providerGeneration,
        signedIn,
        outcome: command.outcome,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error
        && (
          error.message === "CLAUDE_LOGIN_AUTHORITY_MISMATCH"
          || error.message === "CLAUDE_LOGIN_TERMINAL_OUTCOME_CONFLICT"
          || error.message === "MUTATION_RECOVERY_CAS_CONFLICT"
        )
      ) throw new CommandFailure("CONFLICT", "The Claude login completion conflicts with its durable terminal receipt.");
      throw error;
    }
    return {
      account: this.#publicClaudeAccount(profile),
      authentication: { provider: "claude", signedIn },
      login: {
        status: signedIn ? "signed_in" : "signed_out",
        attemptId: command.attemptId,
        idempotencyKey: command.idempotencyKey,
        providerGeneration: command.providerGeneration,
      },
    };
  }

  #abandonClaudeLogin(
    command: Extract<LocalCommand, { kind: "account.claude-login.abandon" }>,
  ): unknown {
    const profile = this.#store.requireProfile(command.account);
    const attempt = this.#store.readMutation(command.idempotencyKey);
    if (
      attempt === null
      || attempt.id !== command.attemptId
      || attempt.kind !== "account.claude-login"
      || attempt.authorityId !== profile.id
      || attempt.authorityGeneration !== command.providerGeneration
    ) throw new CommandFailure("CONFLICT", "The acknowledged Claude login abandon does not match its exact launch authority.");
    try {
      this.#store.abandonClaudeLoginMutation({
        attemptId: command.attemptId,
        idempotencyKey: command.idempotencyKey,
        profileId: profile.id,
        profileGeneration: command.providerGeneration,
        acknowledgeChildExited: command.acknowledgeChildExited,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error
        && (
          error.message === "CLAUDE_LOGIN_AUTHORITY_MISMATCH"
          || error.message === "CLAUDE_LOGIN_NOT_UNSETTLED"
          || error.message === "CLAUDE_LOGIN_TERMINAL_OUTCOME_CONFLICT"
          || error.message === "MUTATION_RECOVERY_CAS_CONFLICT"
        )
      ) throw new CommandFailure("CONFLICT", "The acknowledged Claude login abandon does not match one live unsettled launch fence.");
      throw error;
    }
    return {
      account: this.#publicClaudeAccount(profile),
      login: {
        status: "abandoned",
        attemptId: command.attemptId,
        idempotencyKey: command.idempotencyKey,
        providerGeneration: command.providerGeneration,
        localOnly: true,
        credentialAction: "none",
      },
    };
  }

  async #showAccount(selector: string, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    const revocation = this.#store.readProfilePersonalAuthorityRevocation(profile.id);
    if (
      this.#profileAuthorityRevocationIsPending(profile.id, profile.processGeneration)
      || (revocation?.state === "releasing"
        && revocation.profileGeneration === profile.processGeneration)
    ) {
      return {
        account: this.#publicProfile(profile),
        recovery: {
          required: true,
          cleared: false,
          diagnostic: "Provider account authority changed; HRA is releasing every session controller before completing sign-out.",
        },
      };
    }
    const managedCodexRevocation = this.#store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "codex",
      runtimeScope: "managed",
    });
    const managedCodexGenerationEnded =
      managedCodexRevocation?.state === "completed"
      && managedCodexRevocation.profileGeneration === profile.processGeneration
      && managedCodexRevocation.currentAccountKey === null;
    if (managedCodexGenerationEnded) {
      if (profile.state === "signed_out") {
        return { account: this.#publicProfile(profile) };
      }
      return {
        account: this.#publicProfile(profile),
        recovery: {
          required: true,
          cleared: false,
          restartRequired: true,
          diagnostic: "This Codex generation was exactly retired after account mutation dispatch. Restart HRA so a fresh generation can reread provider state without reopening the retired controller.",
        },
      };
    }
    if (profile.state === "signed_out" && profile.processGeneration === 0) {
      return { account: this.#publicProfile(profile) };
    }
    const projectionRecoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettledForProfile(profile.id);
    await this.#daemonAuthority.assertCurrent();
    const account = await this.#fencedEffect(async () => await this.#codex.readAccount({ authority: authorityFor(this.#paths, profile), signal }));
    const observedProfile = this.#store.requireProfileById(profile.id);
    if (observedProfile.processGeneration !== profile.processGeneration) {
      throw new CommandFailure(
        "CONFLICT",
        "Account authority changed while its provider identity was read.",
      );
    }
    const accountAuthorityChanged = providerAccountAuthorityChanged(observedProfile, account);
    if (
      accountAuthorityChanged
      && (observedProfile.state === "signed_in" || observedProfile.state === "recovery_required")
      && !this.#accountMutationExplainsObservedCodexTransition(observedProfile, account)
    ) {
      this.#scheduleProfilePersonalAuthorityRevocation(observedProfile);
      return {
        account: this.#publicProfile(observedProfile),
        providerProjection: account,
        recovery: {
          required: true,
          cleared: false,
          diagnostic: "Provider account authority changed. HRA is releasing every controller owned by the prior account before accepting another identity.",
        },
      };
    }
    if (projectionRecoveryUnsettled) {
      return {
        account: this.#publicProfile(observedProfile),
        providerProjection: account,
        recovery: {
          cleared: false,
          diagnostic: "Compact-projection recovery preserves this account's exact local authority; provider state was read without changing local custody.",
          required: true,
        },
      };
    }
    if (profile.state === "signed_out") {
      return {
        account: this.#publicProfile(profile),
        providerProjection: account,
        ...(account.signedIn
          ? {
              login: {
                status: "external_identity_unbound",
                next: `hra account login ${profile.id}`,
              },
            }
          : {}),
      };
    }
    if (profile.state === "recovery_required" || profile.state === "login_pending") {
      this.#resolveUnsettledLoginCancellations(profile, account);
    }
    if (profile.state === "recovery_required") {
      const unsettled = this.#store.listUnsettledMutations({ authorityId: profile.id })
        .filter((attempt) => attempt.authorityGeneration === profile.processGeneration && (attempt.kind === "account.login" || attempt.kind === "account.logout"));
      if (unsettled.length === 0) {
        const reconciled = this.#store.reconcileProfileRecoveryFromAccountRead({
          profileId: profile.id,
          expectedGeneration: profile.processGeneration,
          provider: account,
        });
        return {
          account: this.#publicProfile(reconciled),
          providerProjection: account,
          recovery: {
            required: false,
            cleared: true,
            resolution: "provider_state_reconciled",
          },
        };
      }
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

  /**
   * An indeterminate login cancellation changes no local state on its own. The
   * exact account read settles it: a signed-in read proves the login finished,
   * and a signed-out read leaves the pending login for a fresh cancellation.
   */
  #resolveUnsettledLoginCancellations(profile: ProfileRecord, account: CodexAccountProjection): void {
    for (const attempt of this.#store.listUnsettledMutations({ authorityId: profile.id })) {
      if (attempt.kind !== "account.login-cancel" || attempt.authorityGeneration !== profile.processGeneration) continue;
      const originalState = attempt.originalState ?? attempt.state;
      if (originalState !== "effect_started" && originalState !== "ambiguous") continue;
      this.#store.resolveLoginCancelMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        provider: { signedIn: account.signedIn },
      });
    }
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
    if (current.state === "signed_in" && prior === null) {
      return { account: this.#publicProfile(current), login: { status: "signed_in" } };
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
    if (canBegin) {
      if (this.#store.hasUnsettledSessionMutationAuthority(current.id)) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "This account has an unsettled session start or provider switch. Recover or abandon that session mutation before replacing the account login authority.",
          { reason: "unsettled_session_mutation", retryable: true },
        );
      }
      const blocker = this.#store.providerAuthorityAdvanceBlocker(
        current.id,
        "claude",
      );
      if (blocker !== null) {
        throw new CommandFailure(
          "CONFLICT",
          "The Claude runtime for this account is not quiescent. Finish or stop its active work, resolve any recovery, then retry the Codex login.",
          {
            provider: "claude",
            reason: blocker,
            retryable: true,
          },
        );
      }
    }
    try {
      const result = await this.#effect({
        kind: "account.login",
        authorityId: current.id,
        authorityGeneration: targetGeneration,
        request: { deviceCode },
        idempotencyKey: key,
        beginEffect: async (attemptId) => {
          try {
            const retirements = this.#prepareAccountLoginProviderRetirements(
              current.id,
              current.processGeneration,
            );
            await this.#releaseCodexAuthorityForAccountMutationLocked(
              current,
              signal,
            );
            await this.#releaseProfileClaudeControllersLocked(current, signal);
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

  async #cancelLogin(selector: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    await this.#assertNoCompactProjectionRecoveryForProfile(profile.id);
    const key = idempotencyKey ?? randomUUID();
    const prior = this.#store.readMutation(key);
    if (prior !== null && (prior.kind !== "account.login-cancel" || prior.authorityId !== profile.id)) {
      throw new CommandFailure("CONFLICT", "The idempotency key belongs to another mutation authority.");
    }
    if (prior?.state === "applied") {
      // A replay returns the recorded settlement without another provider call.
      const receipt = loginCancelReceiptSchema.parse(prior.result);
      return {
        account: this.#publicProfile(profile),
        loginId: receipt.loginId,
        providerStatus: receipt.providerStatus,
        status: receipt.provider.signedIn ? "signed_in" : "canceled",
        idempotencyKey: key,
      };
    }
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
    const unsettledCancellations = this.#store.listUnsettledMutations({ authorityId: profile.id })
      .filter((attempt) => attempt.kind === "account.login-cancel" && attempt.authorityGeneration === profile.processGeneration);
    if (unsettledCancellations.length > 0) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "An earlier cancellation of this login is indeterminate. Run `hra account show` to reconcile it before canceling again.",
        { idempotencyKey: key },
      );
    }
    const authority = authorityFor(this.#paths, profile);
    // The attempt is recorded before the provider call, like every other Codex
    // mutation, so a crash between dispatch and settlement is visible to
    // restart recovery instead of leaving an unledgered cancellation.
    const receipt = await this.#effect({
      kind: "account.login-cancel",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { loginId: login.loginId },
      idempotencyKey: key,
      beginEffect: (attemptId) => {
        this.#store.beginLoginCancelMutationEffect({
          attemptId,
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          loginId: login.loginId,
        });
      },
      effect: async () => {
        const canceled = await this.#fencedEffect(async () => await this.#codex.cancelLogin({
          authority,
          loginId: login.loginId,
          signal,
        }));
        const provider = await this.#fencedEffect(async () => await this.#codex.readAccount({
          authority,
          signal,
        }));
        return loginCancelReceiptSchema.parse({
          loginId: login.loginId,
          providerStatus: canceled.status,
          provider: {
            signedIn: provider.signedIn,
            ...(provider.email === undefined ? {} : { email: provider.email }),
            ...(provider.plan === undefined ? {} : { plan: provider.plan }),
          },
        });
      },
      receipt: (value) => loginCancelReceiptSchema.parse(value),
      restore: (value) => loginCancelReceiptSchema.parse(value),
      commit: (attemptId, value, recorded) => {
        this.#store.settlePendingLogin({
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          loginId: value.loginId,
          providerStatus: value.providerStatus,
          provider: {
            signedIn: value.provider.signedIn,
            ...(value.provider.email === undefined ? {} : { email: value.provider.email }),
            ...(value.provider.plan === undefined ? {} : { plan: value.provider.plan }),
          },
        });
        if (!this.#store.transitionMutation(attemptId, "effect_started", "applied", recorded)) {
          throw new Error("LOGIN_CANCEL_MUTATION_CAS_CONFLICT");
        }
      },
    });
    return {
      account: this.#publicProfile(this.#store.requireProfileById(profile.id)),
      loginId: receipt.loginId,
      providerStatus: receipt.providerStatus,
      status: receipt.provider.signedIn ? "signed_in" : "canceled",
      idempotencyKey: key,
    };
  }

  async #logout(selector: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    await this.#assertNoCompactProjectionRecoveryForProfile(profile.id);
    this.#work.assertProfileCanChangeAuthority(profile.id, "codex");
    if (this.#store.hasUnsettledSessionMutationAuthority(profile.id, "codex")) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "This account has an unsettled Codex session start or provider switch. Recover or abandon that session mutation before signing out.",
        { provider: "codex", reason: "unsettled_session_mutation", retryable: true },
      );
    }
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
      beginEffect: async (attemptId) => {
        try {
          const retirements = this.#prepareAccountLoginProviderRetirements(
            profile.id,
            profile.processGeneration,
          );
          await this.#releaseCodexAuthorityForAccountMutationLocked(
            profile,
            signal,
            { deferManagedRelease: profile.state !== "signed_out" },
          );
          const begun = this.#store.beginAccountMutationEffect({
            attemptId,
            profileId: profile.id,
            profileGeneration: profile.processGeneration,
            evidence: { kind: "account.logout", baselineSignedIn: profile.state !== "signed_out" },
            providerRetirements: retirements,
            workStore: this.#work,
          });
          this.#notifyAffectedWork(begun.affectedWorkIds);
          this.#applyAccountLoginProviderRetirements(
            retirements,
            begun.retiredSessionIds,
          );
        } catch (error: unknown) {
          let admissionFailure = error;
          const managed = this.#store.readProviderRuntimeAccountRevocation({
            profileId: profile.id,
            provider: "codex",
            runtimeScope: "managed",
          });
          if (
            managed?.state === "releasing"
            && managed.profileGeneration === profile.processGeneration
            && managed.currentAccountKey === null
          ) {
            try {
              // No provider effect was dispatched, but the exact client was
              // deliberately retained for it. Prove that custody released
              // before returning the begin failure; the same generation may
              // not be reopened afterward.
              await this.#completeManagedCodexLogoutAuthorityReleaseLocked(profile);
            } catch (cleanupError: unknown) {
              admissionFailure = cleanupError instanceof DaemonAuthoritySafetyError
                ? cleanupError
                : new AggregateError(
                    [error, cleanupError],
                    "Codex logout admission failed and retained controller release was not proven.",
                  );
            }
          }
          // The generation is now durably fenced even when exact release
          // completed. Do not let another operation in this service attempt
          // to reopen it; the normal daemon close path advances authority for
          // a fresh-process reconciliation.
          this.#state = "closing";
          this.#interactionDeadlineAbort.abort(
            new Error("Codex logout admission did not commit exactly."),
          );
          this.#interactionDeadlineWake?.();
          this.#interactionDeadlineWake = undefined;
          this.#daemonAuthority.close();
          this.#scheduleStop();
          throw admissionFailure;
        }
      },
      effect: async () => {
        if (profile.state === "signed_out") return { loggedOut: true as const };
        let logoutFailure: unknown;
        try {
          await this.#fencedEffect(async () => await this.#codex.logout({
            authority: authorityFor(this.#paths, profile),
            signal,
          }));
        } catch (error: unknown) {
          if (error instanceof DaemonAuthoritySafetyError) throw error;
          logoutFailure = error;
        }
        let releaseFailure: unknown;
        try {
          // The provider call has crossed its durable effect_started boundary.
          // Only now may the exact client be retired; completion is required
          // before any local account settlement can make progress again.
          await this.#completeManagedCodexLogoutAuthorityReleaseLocked(
            profile,
          );
        } catch (error: unknown) {
          if (error instanceof DaemonAuthoritySafetyError) throw error;
          releaseFailure = error;
        }
        if (logoutFailure !== undefined || releaseFailure !== undefined) {
          const causes = [logoutFailure, releaseFailure]
            .filter((cause) => cause !== undefined);
          throw new IndeterminateLocalCommitError(
            "Codex logout was dispatched, but its exact account and controller settlement is not fully proven.",
            causes.length === 1
              ? causes[0]
              : new AggregateError(causes, "Codex logout and controller release did not settle together."),
          );
        }
        return { loggedOut: true as const };
      },
      receipt: (value) => logoutReceiptSchema.parse(value),
      restore: (value) => logoutReceiptSchema.parse(value),
      onAmbiguous: () => this.#quarantineCodexAccountMutation(profile),
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
      this.#quarantineCodexAccountMutation(profile);
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
      let automaticResetRefresh: AutomaticRateLimitResetRefreshStatus | undefined;
      if (refresh) {
        this.#assertSignedIn(profile);
        const observed = await this.#readAndRecordUsage(profile, signal);
        const refreshedProfile = this.#store.requireProfileById(profile.id);
        const reset = await this.#attemptAutomaticRateLimitReset(
          refreshedProfile,
          observed.accountFingerprint,
          observed.snapshot.payload,
          signal,
        );
        automaticResetRefresh = reset.refresh;
        if (reset.authoritativeReread) {
          // Every closed reset outcome is followed by an authoritative read.
          // The provider response itself never substitutes for updated limits.
          await this.#readAndRecordUsage(
            this.#store.requireProfileById(profile.id),
            signal,
          );
        }
      }
      const now = this.#now();
      const currentProfile = this.#store.requireProfileById(profile.id);
      const automaticResetPolicy = this.#store
        .requireAccountRateLimitResetPolicy(profile.id);
      const currentFingerprint = accountFingerprintForProfile(currentProfile);
      const latestRecorded = currentFingerprint === null
        ? null
        : this.#store.latestUsageForAccount(profile.id, currentFingerprint);
      const latestFailure = currentFingerprint === null
        ? null
        : this.#store.latestUsagePollFailure(profile.id, currentFingerprint);
      const parsedLatest = latestRecorded === null
        ? null
        : storedAccountUsageSnapshotSchema.safeParse(latestRecorded.payload);
      const latest = parsedLatest?.success === true
        && currentFingerprint !== null
        && parsedLatest.data.observation.accountFingerprint === currentFingerprint
        ? latestRecorded
        : null;
      const samples = accountUsageCounterSamples(this.#store.usageRange({
        profileId: profile.id,
        fromObservedAt: Math.max(0, now - 30 * 60_000),
        throughObservedAt: now,
        limit: 2_000,
      })).filter((sample) => sample.accountFingerprint === currentFingerprint);
      const windows = ["1m", "5m", "15m"] satisfies readonly UsageVelocityWindow[];
      const velocity = Object.fromEntries(windows.map((window) => [
        window,
        observedAccountTokenVelocity({ samples, window, now }),
      ]));
      const parsedStored = latest === null ? null : parsedLatest;
      const resetObservation = latest === null
        ? { available: false as const, reason: "weekly_window_unavailable" as const }
        : automaticRateLimitResetObservation({
            providerPayload: providerUsagePayload(latest.payload),
            now,
          });
      const automaticResetLastAttempt = publicAutomaticRateLimitResetLastAttempt(
        currentFingerprint === null
          ? null
          : this.#store.latestAccountRateLimitResetAttempt(
              currentProfile.id,
              currentFingerprint,
            ),
      );
      usage.push({
        account: this.#publicProfile(currentProfile),
        automaticReset: automaticRateLimitResetStatusSchema.parse({
          policy: publicAutomaticRateLimitResetPolicy(
            automaticResetPolicy,
            currentFingerprint,
          ),
          threshold: {
            remainingPercent: AUTO_RATE_LIMIT_RESET_REMAINING_PERCENT,
            usedPercent: AUTO_RATE_LIMIT_RESET_USED_PERCENT,
          },
          observation: resetObservation.available
            ? {
                state: "available",
                creditsAvailable: resetObservation.creditsAvailable,
                remainingPercent: Math.max(0, 100 - resetObservation.usedPercent),
                usedPercent: resetObservation.usedPercent,
                weeklyWindowResetsAt: resetObservation.weeklyWindowResetsAt,
              }
            : { state: "unavailable", reason: resetObservation.reason },
          lastAttempt: automaticResetLastAttempt,
          ...(automaticResetRefresh === undefined
            ? {}
            : { refresh: automaticResetRefresh }),
        }),
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

  async #readAndRecordUsage(
    profile: ProfileRecord,
    signal: AbortSignal,
  ): Promise<Readonly<{
    accountFingerprint: string;
    snapshot: Awaited<ReturnType<CodexRuntimePort["readUsage"]>>;
  }>> {
    let verifiedProfile = this.#store.requireProfileById(profile.id);
    const expectedFingerprint = accountFingerprintForProfile(verifiedProfile);
    const accountFingerprint = await this.#proveUsageAccountIdentity({
      profile: verifiedProfile,
      expectedFingerprint,
      signal,
    });
    verifiedProfile = this.#store.requireProfileById(profile.id);
    const sourceSequence = this.#store.allocateNextUsageRevision(profile.id);
    let snapshot: Awaited<ReturnType<CodexRuntimePort["readUsage"]>>;
    try {
      snapshot = await this.#fencedEffect(async () =>
        await this.#codex.readUsage({
          authority: authorityFor(this.#paths, verifiedProfile),
          signal,
        }));
    } catch (error: unknown) {
      if (!signal.aborted) {
        this.#store.recordUsagePollFailure(
          profile.id,
          accountFingerprint,
          sourceSequence,
          this.#now(),
          "account_usage_read_failed",
        );
      }
      throw error;
    }
    const receivedAt = this.#now();
    const confirmedFingerprint = await this.#proveUsageAccountIdentity({
      profile: verifiedProfile,
      expectedFingerprint: accountFingerprint,
      signal,
    });
    if (confirmedFingerprint !== accountFingerprint) {
      throw new Error("ACCOUNT_USAGE_IDENTITY_PROOF_CHANGED_WITHOUT_CONFLICT");
    }
    verifiedProfile = this.#store.requireProfileById(profile.id);
    const previous = this.#store.latestUsageForAccount(
      profile.id,
      accountFingerprint,
    );
    const stored = createStoredAccountUsageSnapshot({
      providerPayload: snapshot.payload,
      sourceSequence,
      observedAt: snapshot.observedAt,
      receivedAt,
      accountFingerprint,
      providerGeneration: verifiedProfile.processGeneration,
      daemonGeneration: this.#daemonGeneration,
      previousPayload: previous?.payload ?? null,
    });
    this.#store.recordUsage(profile.id, sourceSequence, snapshot.observedAt, stored);
    return { accountFingerprint, snapshot };
  }

  async #attemptAutomaticRateLimitReset(
    profile: ProfileRecord,
    accountFingerprint: string,
    providerPayload: unknown,
    signal: AbortSignal,
  ): Promise<AutomaticRateLimitResetAttemptResult> {
    const now = this.#now();
    const observation = automaticRateLimitResetObservation({
      providerPayload,
      now,
    });
    const policyDecision = this.#store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowDurationMinutes: observation.available
        ? CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES
        : null,
      weeklyWindowResetsAt: observation.available
        ? observation.weeklyWindowResetsAt
        : null,
    });
    if (policyDecision.decision !== "allow") {
      const reason = policyDecision.reason === "weekly_window_unavailable"
        && policyDecision.policy.state === "reconciliation_required"
        ? "reconciliation_required" as const
        : policyDecision.reason;
      return {
        authoritativeReread: false,
        refresh: { state: "suppressed", reason },
      };
    }
    if (!observation.available) {
      throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_OBSERVATION_MISMATCH");
    }

    this.#store.recoverAccountRateLimitResetAttempts({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: observation.weeklyWindowResetsAt,
    });
    let attempt = this.#store.readRecoverableAccountRateLimitReset(
      profile.id,
      accountFingerprint,
    );
    if (attempt?.state === "effect_started") {
      return {
        authoritativeReread: false,
        refresh: { state: "recovery_pending" },
      };
    }

    const decisionNow = this.#now();
    const decision = automaticRateLimitResetDecision({
      providerPayload,
      now: decisionNow,
    });
    if (attempt === null && !decision.eligible) {
      return {
        authoritativeReread: false,
        refresh: { state: "not_eligible", reason: decision.reason },
      };
    }
    if (attempt !== null) {
      // An ambiguous attempt represents an upstream effect that may already
      // have succeeded. Reconcile only that durable idempotency key after the
      // policy admits a fresh observation; current credits, usage, and window
      // cannot prove whether the earlier dispatch committed.
      if (attempt.state !== "ambiguous") {
        if (
          decisionNow >= attempt.weeklyWindowResetsAt
          || observation.weeklyWindowResetsAt !== attempt.weeklyWindowResetsAt
        ) {
          this.#store.closeAccountRateLimitReset(
            attempt.idempotencyKey,
            "weekly_window_changed",
          );
          return {
            authoritativeReread: false,
            refresh: { state: "window_changed" },
          };
        }
        if (
          observation.creditsAvailable < 1
          || observation.usedPercent < AUTO_RATE_LIMIT_RESET_USED_PERCENT
        ) {
          return {
            authoritativeReread: false,
            refresh: {
              state: "waiting",
              reason: observation.creditsAvailable < 1
                ? "credits_unavailable"
                : "below_threshold",
            },
          };
        }
      }
    } else {
      if (!decision.eligible) {
        return {
          authoritativeReread: false,
          refresh: { state: "not_eligible", reason: decision.reason },
        };
      }
    }

    await this.#daemonAuthority.assertCurrent();
    if (signal.aborted) throw signal.reason;
    const confirmedFingerprint = await this.#proveUsageAccountIdentity({
      profile,
      expectedFingerprint: accountFingerprint,
      signal,
    });
    if (confirmedFingerprint !== accountFingerprint) {
      throw new Error("ACCOUNT_RATE_LIMIT_RESET_IDENTITY_PROOF_CHANGED_WITHOUT_CONFLICT");
    }
    const dispatchProfile = this.#store.requireProfileById(profile.id);
    if (
      dispatchProfile.processGeneration !== profile.processGeneration
      || accountFingerprintForProfile(dispatchProfile) !== accountFingerprint
    ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_AUTHORITY_CHANGED");
    const dispatchPolicyDecision = this.#store.authorizeAccountRateLimitResetPolicy({
      profileId: dispatchProfile.id,
      processGeneration: dispatchProfile.processGeneration,
      accountFingerprint,
      weeklyWindowDurationMinutes: CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES,
      weeklyWindowResetsAt: observation.weeklyWindowResetsAt,
    });
    if (dispatchPolicyDecision.decision !== "allow") {
      const reason = dispatchPolicyDecision.reason === "weekly_window_unavailable"
        && dispatchPolicyDecision.policy.state === "reconciliation_required"
        ? "reconciliation_required" as const
        : dispatchPolicyDecision.reason;
      return {
        authoritativeReread: false,
        refresh: { state: "suppressed", reason },
      };
    }
    if (
      attempt !== null
      && attempt.currentProcessGeneration !== dispatchProfile.processGeneration
    ) {
      attempt = this.#store.rebindAccountRateLimitReset({
        idempotencyKey: attempt.idempotencyKey,
        expectedCurrentProcessGeneration: attempt.currentProcessGeneration,
        nextProcessGeneration: dispatchProfile.processGeneration,
        accountFingerprint,
      });
    }
    if (attempt === null) {
      if (!decision.eligible) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_DECISION_CHANGED_WITHOUT_ASYNC_GAP");
      }
      attempt = this.#store.prepareAccountRateLimitReset({
        profileId: dispatchProfile.id,
        processGeneration: dispatchProfile.processGeneration,
        accountFingerprint,
        weeklyWindowResetsAt: decision.weeklyWindowResetsAt,
        observedUsedPercent: decision.usedPercent,
      });
    }
    // prepareAccountRateLimitReset returns an existing terminal latch for the
    // same account/window. Re-check here so a settled or locally closed
    // logical redemption can never cross the provider mutation boundary.
    if (attempt.state === "settled") {
      if (attempt.outcome === null) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_SETTLED_OUTCOME_MISSING");
      }
      return {
        authoritativeReread: false,
        refresh: { state: "latched", outcome: attempt.outcome },
      };
    }
    if (attempt.state === "closed") {
      if (attempt.localResolution === null) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_CLOSED_RESOLUTION_MISSING");
      }
      return {
        authoritativeReread: false,
        refresh: { state: "latched", reason: attempt.localResolution },
      };
    }
    if (attempt.state === "effect_started") {
      return {
        authoritativeReread: false,
        refresh: { state: "recovery_pending" },
      };
    }

    signal.throwIfAborted();
    const begun = this.#store.beginAccountRateLimitReset(attempt.idempotencyKey);
    if (begun.state !== "effect_started") {
      throw new Error("ACCOUNT_RATE_LIMIT_RESET_BEGIN_STATE_INVALID");
    }
    let outcome: Awaited<ReturnType<CodexRuntimePort["consumeRateLimitReset"]>>;
    try {
      outcome = await this.#codex.consumeRateLimitReset({
        authority: authorityFor(this.#paths, dispatchProfile),
        idempotencyKey: attempt.idempotencyKey,
        signal,
      });
    } catch (providerError: unknown) {
      const retryState = providerError instanceof IndeterminateCodexEffectError
        ? "ambiguous"
        : "retryable";
      try {
        // Every failure retains the original key. An indeterminate effect can
        // bypass ordinary eligibility only after durable policy authorization;
        // determinate failures return through the ordinary window gates.
        this.#store.deferAccountRateLimitReset(attempt.idempotencyKey, retryState);
      } catch (journalError: unknown) {
        this.#failStopAfterResetJournalFailure(
          "Automatic reset recovery evidence could not be committed.",
        );
        throw new AggregateError(
          [providerError, journalError],
          "An automatic reset may have reached Codex and its recovery state could not be committed.",
        );
      }
      // A successful usage read remains successful. A later refresh can retry
      // only this exact durable upstream key after policy authorization.
      return {
        authoritativeReread: false,
        refresh: {
          state: retryState === "ambiguous" ? "recovery_pending" : "retry_pending",
        },
      };
    }
    try {
      this.#store.settleAccountRateLimitReset(attempt.idempotencyKey, outcome);
    } catch (journalError: unknown) {
      this.#failStopAfterResetJournalFailure(
        "An automatic reset outcome could not be committed.",
      );
      throw new AggregateError(
        [journalError],
        `Codex returned the automatic reset outcome ${outcome}, but HRA could not commit it.`,
      );
    }
    return {
      authoritativeReread: true,
      refresh: { state: "settled", outcome },
    };
  }

  async #proveUsageAccountIdentity(input: {
    profile: ProfileRecord;
    expectedFingerprint: string | null;
    signal: AbortSignal;
  }): Promise<string> {
    const account = await this.#fencedEffect(async () =>
      await this.#codex.readAccount({
        authority: authorityFor(this.#paths, input.profile),
        signal: input.signal,
      }));
    const verifiedEmail = !account.signedIn || account.email === undefined
      ? null
      : account.email;
    if (account.signedIn && verifiedEmail === null) {
      this.#scheduleProfilePersonalAuthorityRevocation(input.profile);
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "Codex is signed in but did not expose a stable account identity. HRA is revoking the unprovable authority before any session or usage operation can continue.",
      );
    }
    const actualFingerprint = verifiedEmail === null
      ? null
      : digestText(verifiedEmail.trim().toLowerCase());
    const persistedFingerprint = accountFingerprintForProfile(input.profile);
    const identityChanged = actualFingerprint === null
      || (input.expectedFingerprint !== null
        && actualFingerprint !== input.expectedFingerprint)
      || (persistedFingerprint !== null
        && actualFingerprint !== persistedFingerprint);
    if (identityChanged) {
      this.#scheduleProfilePersonalAuthorityRevocation(input.profile);
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The provider account identity changed. HRA is releasing every controller and retiring the prior generation before accepting another identity.",
      );
    }
    if (verifiedEmail === null) {
      throw new Error("ACCOUNT_USAGE_IDENTITY_PROOF_INVALID");
    }
    if (input.profile.providerEmail === undefined) {
      this.#scheduleProfilePersonalAuthorityRevocation(input.profile);
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The local account had no prior stable identity. HRA fenced this observation; establish the identity through an explicit account login.",
      );
    }
    return actualFingerprint;
  }

  #usageHistory(
    command: Extract<LocalCommand, { kind: "account.usage-history" }>,
  ): unknown {
    const profile = this.#store.requireProfile(command.account);
    const accountFingerprint = accountFingerprintForProfile(profile);
    const now = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(this.#now());
    let fromObservedAt: number;
    let throughObservedAt: number;
    let afterSourceRevision = 0;
    let issuedAt = now;
    if (command.cursor !== undefined) {
      if (accountFingerprint === null) {
        throw new UsageHistoryCursorError(
          "Usage-history cursor belongs to an account identity that is no longer verified.",
          "account_mismatch",
        );
      }
      const decoded = this.#usageHistoryCursors.decode(command.cursor, {
        accountId: profile.id,
        accountFingerprint,
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

    if (accountFingerprint === null) {
      return accountUsageHistoryPageSchema.parse({
        account: { id: profile.id, label: profile.label },
        range: { fromObservedAt, throughObservedAt },
        entries: [],
        nextCursor: null,
      });
    }

    const listed = this.#store.usageHistoryPage({
      profileId: profile.id,
      accountFingerprint,
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
          accountFingerprint,
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

  async #assertCompactProjectionRecoveryReady(
    expected: Readonly<{
      acknowledgeGap: true;
      idempotencyKey: string;
      processGeneration: number;
      profileId: ProfileRecord["id"];
      providerThreadId: string;
      sessionId: SessionRecord["id"];
    }>,
  ): Promise<void> {
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
    this.#assertEstablishedSessionAccount(profile, session);
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
    await this.#assertCompactProjectionRecoveryReady(expected);
    return await this.#fencedEffect(async () => await this.#cloud.recoverCompactProjection({
      acknowledgeGap: expected.acknowledgeGap,
      idempotencyKey: expected.idempotencyKey,
      sessionPublicId: expected.sessionId,
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
    const admittedAt = Math.max(session.updatedAt, this.#now());
    return Math.min(Number.MAX_SAFE_INTEGER, admittedAt + FACTS_MEMORY_SESSION_TTL_MS);
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

  async #cleanupTerminalFactsMemory(
    session: SessionRecord,
    reason: "abandon" | "archive" = "archive",
  ): Promise<void> {
    // A terminal session dispatches nothing more, so its fact epoch is no
    // longer consulted. Dropping it keeps the map bounded by live sessions.
    this.#forgetSessionFactEpoch(session.id);
    this.#terminalFactsMemoryRevision += 1;
    await this.#cleanupFactsMemory(session, reason);
  }

  async #reconcileCommittedSessionFactsMemory(
    session: SessionRecord,
    terminalReason: "abandon" | "archive" = "archive",
  ): Promise<void> {
    if (session.state === "terminal") {
      await this.#cleanupTerminalFactsMemory(session, terminalReason);
    } else if (session.state !== "recovery_required") {
      await this.#ensureFactsMemory(session);
    }
  }

  async #resumeClaudeSessionAfterExactProcessRelease(
    session: SessionRecord,
    profile: ProfileRecord,
    authority: ProfileAuthority,
    signal: AbortSignal,
  ): Promise<CodexSessionObservation> {
    if (
      session.provider !== "claude"
      || session.providerThreadId === undefined
    ) {
      throw new ClaudeSessionObservationError();
    }
    const runtimeScope = this.#sessionHasActivePersonalBinding(session) ? "personal" : "managed";
    const priorProcess = this.#store.readClaudeProcessAuthority({
      providerThreadId: session.providerThreadId,
      profileId: session.profileId,
      runtimeScope,
    });
    if (
      priorProcess === null
      || priorProcess.state !== "released"
      || (priorProcess.sessionId !== null && priorProcess.sessionId !== session.id)
    ) throw new ClaudeSessionObservationError();
    if (session.projectId === undefined) {
      throw new ProviderRuntimeUnavailableError(
        "A durable project is required to resume this Claude session.",
      );
    }
    const runtime = runtimeScope === "personal"
      ? this.#personalClaude
      : this.#claude;
    if (runtime === undefined) {
      throw new ProviderRuntimeUnavailableError(
        "Claude session control cannot resume this fenced session.",
      );
    }
    const project = this.#store.requireProject(session.projectId);
    const projectRoot = await this.#requireUsableProjectRoot(project.rootPath);
    const providerThreadId = session.providerThreadId;
    const providerAccountAuthority = this.#store.readSessionProviderAccountAuthority(
      session.id,
    );
    if (
      providerAccountAuthority === null
      || providerAccountAuthority.provider !== "claude"
      || providerAccountAuthority.runtimeScope !== runtimeScope
    ) throw new ClaudeSessionObservationError();
    await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
    const exactProviderAccountAuthority = this.#store.readSessionProviderAccountAuthority(
      session.id,
    );
    if (
      exactProviderAccountAuthority === null
      || exactProviderAccountAuthority.provider !== providerAccountAuthority.provider
      || exactProviderAccountAuthority.runtimeScope !== providerAccountAuthority.runtimeScope
      || exactProviderAccountAuthority.accountKey !== providerAccountAuthority.accountKey
    ) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The Claude session account authority changed before its exact-process resume.",
      );
    }
    const launchIntent = this.#store.stageClaudeProcessLaunchIntent({
      providerThreadId,
      profileId: session.profileId,
      profileGeneration: authority.generation,
      runtimeScope,
      providerAccountKey: providerAccountAuthority.accountKey,
      sessionId: session.id,
    });
    let claimedIdentity: ClaudeProcessIdentity | undefined;
    let projection: Awaited<ReturnType<ClaudeRuntimePort["claimSession"]>> | undefined;
    let claimFailure: Readonly<{ error: unknown }> | undefined;
    try {
      projection = await this.#fencedEffect(async () => {
        const value = await runtime.claimSession({
          authority,
          admitProcessIdentity: async (identity) => {
            claimedIdentity = await this.#recordClaimedClaudeProcess({
              authority,
              providerThreadId,
              runtimeScope,
              sessionId: session.id,
              launchIntent,
              identity,
              signal,
            });
          },
          providerThreadId,
          projectRoot,
          title: session.title,
          preset: session.preset,
          fast: session.fastEnabled,
          sourceLiveness: "not_live",
          signal,
        });
        return value;
      });
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      claimFailure = { error };
    }
    let postClaimAccountFailure: Readonly<{ error: unknown }> | undefined;
    try {
      await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      postClaimAccountFailure = { error };
    }
    if (postClaimAccountFailure !== undefined) {
      if (claimedIdentity !== undefined) {
        try {
          await this.#releaseClaudeProcessAuthority(
            { providerThreadId, profileId: session.profileId, runtimeScope },
            new AbortController().signal,
          );
        } catch (releaseError: unknown) {
          if (releaseError instanceof DaemonAuthoritySafetyError) throw releaseError;
          throw new IndeterminateLocalCommitError(
            "The Claude account changed during exact-process resume and its admitted process could not be released.",
            new AggregateError([postClaimAccountFailure.error, releaseError]),
          );
        }
      }
      throw new IndeterminateLocalCommitError(
        "The Claude account changed while its exact-process resume was in flight.",
        claimFailure === undefined
          ? postClaimAccountFailure.error
          : new AggregateError([claimFailure.error, postClaimAccountFailure.error]),
      );
    }
    if (claimedIdentity === undefined) {
      throw new ClaudeProcessExitUnprovenError({
        cause: claimFailure?.error ?? new Error("CLAUDE_PROCESS_IDENTITY_NOT_ADMITTED"),
      });
    }
    if (claimFailure !== undefined) {
      try {
        await this.#releaseClaudeProcessAuthority(
          { providerThreadId, profileId: session.profileId, runtimeScope },
          new AbortController().signal,
        );
        this.#cancelClaudeProcessLaunchIntent(launchIntent);
      } catch (releaseError: unknown) {
        if (releaseError instanceof DaemonAuthoritySafetyError) throw releaseError;
        throw new ClaudeProcessExitUnprovenError({
          cause: new AggregateError([claimFailure.error, releaseError]),
        });
      }
      throw claimFailure.error;
    }
    if (projection === undefined) throw new Error("CLAUDE_RESUME_PROJECTION_MISSING");
    try {
      if (
        projection.providerThreadId !== session.providerThreadId
        || projection.projectRoot !== projectRoot
      ) {
        throw new Error("CLAUDE_FENCED_RESUME_IDENTITY_MISMATCH");
      }
      this.#store.bindClaimedClaudeProcessAuthority({
        providerThreadId,
        profileId: session.profileId,
        sessionId: session.id,
        runtimeScope,
        identity: claimedIdentity,
      });
      this.#store.recordSessionRuntimeProfile({
        sessionId: session.id,
        sourceKind: "session_start",
        sourceId: `resume_${createHash("sha256")
          .update(
            `${session.id}\0${String(profile.processGeneration)}`
            + `\0${String(projection.effectiveRuntimeProfile.observedAt)}`,
          )
          .digest("hex")}`,
        profile: projection.effectiveRuntimeProfile,
      });
      const observation = await this.#fencedEffect(async () => await runtime.observeSession({
        authority,
        providerThreadId,
        signal,
      }));
      return observation;
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      try {
        await this.#releaseClaudeProcessAuthority(
          { providerThreadId, profileId: session.profileId, runtimeScope },
          new AbortController().signal,
        );
        this.#cancelClaudeProcessLaunchIntent(launchIntent);
      } catch (releaseError: unknown) {
        if (releaseError instanceof DaemonAuthoritySafetyError) throw releaseError;
        throw new ClaudeProcessExitUnprovenError({
          cause: new AggregateError([error, releaseError]),
        });
      }
      throw error;
    }
  }

  async #releaseAndResumeClaudeSessionAfterObservationFailure(
    session: SessionRecord,
    authority: ProfileAuthority,
    signal: AbortSignal,
  ): Promise<CodexSessionObservation> {
    if (session.provider !== "claude" || session.providerThreadId === undefined) {
      throw new ClaudeSessionObservationError();
    }
    const runtimeScope = this.#sessionHasActivePersonalBinding(session)
      ? "personal"
      : "managed";
    // Observation can fail after a newly started child was durably bound but
    // before a connection id reached the in-memory routing map. Release by
    // exact persisted PID/start authority, independent of caller cancellation,
    // before attempting the ordinary exact-session resume path.
    await this.#releaseClaudeProcessAuthority(
      {
        providerThreadId: session.providerThreadId,
        profileId: session.profileId,
        runtimeScope,
      },
      new AbortController().signal,
    );
    signal.throwIfAborted();
    await this.#daemonAuthority.assertCurrent();
    const current = this.#currentObservationSession(
      authority,
      session.id,
      session.providerThreadId,
    );
    if (current === null || current.provider !== "claude") {
      throw new ClaudeSessionObservationError();
    }
    const profile = this.#store.requireProfileById(current.profileId);
    return await this.#resumeClaudeSessionAfterExactProcessRelease(
      current,
      profile,
      authority,
      signal,
    );
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
    if (
      session.provider === "claude"
      && this.#platform !== "linux"
      && !this.#sessionHasMatchingActivePersonalBinding(session)
    ) {
      return this.#claudePlatformUnavailableObservation(profile);
    }
    if (!this.#profileAllowsEstablishedSession(profile, session)) {
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
    await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
    if (this.#lastSessionEventIsProviderGap(session.id)) {
      this.#sessionsAwaitingResubscription.add(session.id);
    }
    const projectionRecoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettled(session.id);
    await this.#daemonAuthority.assertCurrent();
    const observationFactEpoch = this.#snapshotSessionFactEpoch(session.id);
    const providerThreadId = session.providerThreadId;
    const authority = this.#authorityForSession(session, profile);
    let observation: CodexSessionObservation;
    try {
      observation = await this.#fencedEffect(async () => await this.#runtimeForSession(session).observeSession({
        authority,
        providerThreadId,
        signal,
      }));
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      if (signal.aborted) throw signal.reason;
      if (error instanceof ClaudeSessionObservationError) {
        try {
          observation = await this.#releaseAndResumeClaudeSessionAfterObservationFailure(
            session,
            authority,
            signal,
          );
        } catch (resumeError: unknown) {
          if (resumeError instanceof DaemonAuthoritySafetyError) throw resumeError;
          await this.#assertSessionAccountAuthorityAfterProviderEffect(
            session,
            profile,
            signal,
          );
          if (!(resumeError instanceof ClaudeProcessExitUnprovenError)) throw resumeError;
          this.#quarantineSession(session.id);
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "Claude session recovery launched a controller whose exit could not be proved. HRA retained its exact launch authority and quarantined the session.",
            { sessionId: session.id },
          );
        }
      } else {
        await this.#assertSessionAccountAuthorityAfterProviderEffect(
          session,
          profile,
          signal,
        );
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
    }
    await this.#daemonAuthority.assertCurrent();
    session = this.#store.requireSession(session.id);
    const currentProfile = this.#store.requireProfileById(profile.id);
    if (
      session.profileId !== profile.id
      || session.providerThreadId === undefined
      || session.providerThreadId !== observation.projection.providerThreadId
      || currentProfile.processGeneration !== profile.processGeneration
      || !this.#profileAllowsEstablishedSession(currentProfile, session)
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
    await this.#assertPersonalSessionAccountAuthority(
      session,
      currentProfile,
      signal,
      true,
    );
    z.string().uuid().parse(observation.connectionId);
    this.#sessionObservationFailures.delete(session.id);
    this.#ensureSessionProviderConnection(authority, session, observation.connectionId);
    const projection = observation.projection;
    if (
      !projectionRecoveryUnsettled
      && !this.#projectionRecoveriesInFlight.has(session.id)
      && this.#currentSessionFactEpoch(session.id) === observationFactEpoch
    ) {
      const beforeState = session.state;
      const beforeActiveTurnId = session.activeTurnId ?? null;
      const reconciled = this.#store.reconcileSessionFromProvider({
        sessionId: session.id,
        state: projection.status,
        activeTurnId: projection.status === "active"
          ? projection.activeTurnId ?? null
          : null,
        // Claude's runtime projection deliberately keeps only a compact
        // display title. The durable HRA title may be longer, so observing a
        // resumed Claude process must not truncate it.
        ...(session.provider === "codex" ? { title: projection.title } : {}),
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
      await this.#reconcileCommittedSessionFactsMemory(reconciled);
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
        && this.#profileAllowsEstablishedSession(profile, session)
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
        observation.code === "provider_platform_unavailable"
          ? `Claude session processes are acceptance-pending on ${this.#platform}. HRA retained the local session but will not contact Claude outside Linux.`
          : "The provider thread is not currently observable; HRA will not use stale session state.",
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
        await this.#queue(session.id, message, effect.nestedMutationKey, signal, beforeEffect);
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
      presentation: computeInteractionPresentation(interaction.display),
      resolvedBy: interaction.resolvedBy ?? null,
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
      const focalProvider = input.focalInteraction.sessionId === null
        ? "codex"
        : this.#store.requireSession(input.focalInteraction.sessionId).provider;
      const blocker = this.#store.providerAuthorityAdvanceBlocker(
        input.focalInteraction.authority.profileId,
        "claude",
      );
      if (focalProvider === "claude" || blocker !== null) {
        throw new Error(
          focalProvider === "claude"
            ? "CLAUDE_INTERACTION_QUARANTINE_REQUIRES_DAEMON_RETIREMENT"
            : `CODEX_INTERACTION_QUARANTINE_BLOCKED_BY_CLAUDE_${blocker}`,
        );
      }
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
      const provider = this.#providerForInteraction(current);
      this.#assertProviderProfileState(profile, provider);
      let authority: Awaited<ReturnType<CodexRuntimePort["inspectInteractionAuthority"]>>;
      try {
        await this.#daemonAuthority.assertCurrent();
        await this.#assertPersonalInteractionAccountAuthority(current, profile, signal);
        authority = await this.#runtimeForInteraction(current).inspectInteractionAuthority({
          authority: this.#authorityForInteraction(current, profile),
          provider: current.authority,
          kind: current.kind,
          signal,
        });
        await this.#daemonAuthority.assertCurrent();
        const exactProfile = this.#store.requireProfileById(profile.id);
        this.#assertProviderProfileState(exactProfile, provider);
        if (exactProfile.processGeneration !== current.authority.processGeneration) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The interaction belongs to a stale account authority.",
          );
        }
      } catch (error: unknown) {
        if (error instanceof CommandFailure) throw error;
        if (providerFailureCode(error) === "UNSUPPORTED_CAPABILITY") {
          throw new CommandFailure("INVALID_INPUT", providerFailureMessage(error));
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
    return await this.#serializeInteractionAuthority(command.interaction, async () =>
      await this.#resolveInteractionLocked(command, context));
  }

  async #resolveInteractionLocked(
    command: Extract<LocalCommand, { kind: "interaction.resolve" }>,
    context: { signal: AbortSignal; afterResponse?: (callback: () => void) => void },
  ): Promise<unknown> {
    const signal = context.signal;
    return await (async () => {
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
      const provider = this.#providerForInteraction(current);
      this.#assertProviderProfileState(profile, provider);
      if (profile.processGeneration !== current.authority.processGeneration) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The interaction belongs to a stale account authority.",
        );
      }
      const runtime = this.#runtimeForInteraction(current);
      let responseDigest: string;
      try {
        await this.#daemonAuthority.assertCurrent();
        await this.#assertPersonalInteractionAccountAuthority(current, profile, signal);
        const validated = await runtime.validateInteractionResolution({
          authority: this.#authorityForInteraction(current, profile),
          provider: current.authority,
          kind: current.kind,
          resolution: command.resolution,
          signal,
        });
        await this.#assertPersonalInteractionAccountAuthority(current, profile, signal);
        responseDigest = validated.responseDigest;
        const exactProfile = this.#store.requireProfileById(profile.id);
        this.#assertProviderProfileState(exactProfile, provider);
        if (exactProfile.processGeneration !== current.authority.processGeneration) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The interaction belongs to a stale account authority.",
          );
        }
      } catch (error: unknown) {
        if (error instanceof CommandFailure) throw error;
        if (this.#now() >= current.deadlineAt) {
          await this.#rejectManualResolutionAtDeadline(current);
        }
        if (providerFailureCode(error) === "INVALID_INPUT") {
          throw new CommandFailure("INVALID_INPUT", providerFailureMessage(error));
        }
        const terminal = providerFailureCode(error) === "INDETERMINATE_EFFECT"
          ? this.#store.markInteractionResolutionUnknown({
              id: current.publicId,
              expectedRevision: current.revision,
            })
          : this.#store.expireInteraction({
              id: current.publicId,
              expectedRevision: current.revision,
            });
        this.#appendInteractionState(terminal);
        if (providerFailureCode(error) === "INDETERMINATE_EFFECT") {
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
      await this.#assertPersonalInteractionAccountAuthority(current, profile, signal);
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
        const exactProfile = this.#store.requireProfileById(profile.id);
        this.#assertProviderProfileState(exactProfile, provider);
        if (exactProfile.processGeneration !== prepared.authority.processGeneration) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The interaction belongs to a stale account authority.",
          );
        }
        if (this.#now() >= prepared.deadlineAt) {
          await this.#rejectPreparedManualResolutionAtDeadline(prepared);
        }
        await this.#assertPersonalInteractionAccountAuthority(prepared, exactProfile, signal);
        await runtime.resolveInteraction({
          authority: this.#authorityForInteraction(prepared, profile),
          provider: prepared.authority,
          kind: prepared.kind,
          resolution: command.resolution,
          deadlineAt: prepared.deadlineAt,
          signal,
        });
        await this.#assertInteractionAccountAuthorityAfterProviderEffect(
          prepared,
          exactProfile,
          signal,
        );
      } catch (error: unknown) {
        if (error instanceof CommandFailure) throw error;
        if (providerFailureCode(error) === "DEADLINE_EXPIRED") {
          await this.#rejectPreparedManualResolutionAtDeadline(prepared);
        }
        const indeterminate = error instanceof IndeterminateLocalCommitError
          || providerFailureCode(error) === "INDETERMINATE_EFFECT";
        const latest = this.#store.requireInteraction(prepared.publicId);
        const terminal = indeterminate
          ? latest.state === "response_prepared"
              && latest.revision === prepared.revision
              && latest.responseDigest === responseDigest
            ? this.#store.markInteractionResolutionUnknown({
                id: prepared.publicId,
                expectedRevision: prepared.revision,
                responseDigest,
              })
            : latest
          : this.#store.expireInteraction({
              id: prepared.publicId,
              expectedRevision: prepared.revision,
            });
        if (terminal !== latest) this.#appendInteractionState(terminal);
        if (indeterminate) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The interaction response may have reached Codex; its resolution is unknown.",
            { interaction: this.#publicInteraction(terminal) },
          );
        }
        if (providerFailureCode(error) === "INVALID_INPUT") {
          throw new CommandFailure("INVALID_INPUT", providerFailureMessage(error));
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
    })();
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
    if (!this.#profileAuthorityIsUsable(
      prepared.authority.profileId,
      prepared.authority.processGeneration,
      prepared.authority.method.startsWith("claude/") ? "claude" : "codex",
      prepared.sessionId ?? undefined,
    )) {
      const terminal = this.#store.expireInteraction({
        id: prepared.publicId,
        expectedRevision: prepared.revision,
      });
      this.#appendInteractionState(terminal);
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The interaction authority was revoked before its timeout response could be dispatched.",
        { interaction: this.#publicInteraction(terminal) },
      );
    }
    const profile = this.#store.requireProfileById(prepared.authority.profileId);
    const runtime = this.#runtimeForInteraction(prepared);
    const signal = this.#interactionDeadlineAbort.signal;
    let timeoutResponseDigest: string;
    try {
      await this.#daemonAuthority.assertCurrent();
      await this.#assertPersonalInteractionAccountAuthority(prepared, profile, signal);
      const validated = await runtime.validateInteractionTimeout({
        authority: this.#authorityForInteraction(prepared, profile),
        provider: prepared.authority,
        signal,
      });
      await this.#assertPersonalInteractionAccountAuthority(prepared, profile, signal);
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
        providerFailureCode(error) === "INDETERMINATE_EFFECT"
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
      await this.#assertPersonalInteractionAccountAuthority(
        timeoutPrepared,
        profile,
        signal,
      );
      await runtime.timeoutInteraction({
        authority: this.#authorityForInteraction(timeoutPrepared, profile),
        provider: timeoutPrepared.authority,
        signal,
      });
      await this.#assertInteractionAccountAuthorityAfterProviderEffect(
        timeoutPrepared,
        profile,
        signal,
      );
    } catch (error: unknown) {
      const latest = this.#store.requireInteraction(timeoutPrepared.publicId);
      const indeterminate = error instanceof IndeterminateLocalCommitError
        || providerFailureCode(error) === "INDETERMINATE_EFFECT";
      const terminal = latest.state === "response_prepared"
        && latest.revision === timeoutPrepared.revision
        && latest.responseDigest === timeoutResponseDigest
        ? indeterminate
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
        indeterminate
          ? "RECOVERY_REQUIRED"
          : "CONFLICT",
        indeterminate
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

  #personalCodexRestartRequired(
    profile: Pick<ProfileRecord, "id" | "processGeneration">,
  ): boolean {
    const revocation = this.#store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "codex",
      runtimeScope: "personal",
    });
    return revocation?.state === "completed"
      && revocation.profileGeneration === profile.processGeneration;
  }

  #sessionAdoptionStatus(provider?: Provider): unknown {
    const providers: readonly Provider[] = provider === undefined
      ? ["codex", "claude"]
      : [provider];
    return {
      version: 1,
      providers: providers.map((candidateProvider) => {
        const policy = this.#store.readSessionAdoptionPolicy(candidateProvider);
        const counts = this.#store.readSessionAdoptionCounts(candidateProvider);
        return {
          provider: candidateProvider,
          enabled: policy?.enabled ?? false,
          accountId: policy?.profileId ?? null,
          ...(candidateProvider === "codex"
            && this.#store.listProfiles().some((profile) =>
              this.#personalCodexRestartRequired(profile))
            ? { restartRequired: true }
            : {}),
          ...counts,
        };
      }),
    };
  }

  async #setSessionAdoption(
    command: Extract<LocalCommand, { kind: "session.adoption.set" }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!command.enabled) {
      this.#store.setSessionAdoptionPolicy({ provider: command.provider, profileId: null });
      return this.#sessionAdoptionStatus(command.provider);
    }
    if (command.account === undefined) {
      throw new CommandFailure(
        "INVALID_INPUT",
        "Enabling personal-home session adoption requires an HRA account.",
      );
    }
    const profile = this.#store.requireProfile(command.account);
    if (command.provider === "codex" && this.#personalCodexRestartRequired(profile)) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The personal-home Codex controller was released after an account change. Restart the HRA daemon before enabling adoption again.",
        { accountId: profile.id, provider: "codex", restartRequired: true },
      );
    }
    if (command.provider === "codex") {
      this.#assertSignedIn(profile);
      this.#assertIdentifiableAccountAuthority(profile);
    }
    const scopedRevocation = this.#store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: command.provider,
      runtimeScope: "personal",
    });
    if (scopedRevocation?.profileGeneration === profile.processGeneration) {
      // Enabling discovery is an authority-bearing admission. Reconcile a
      // completed exact-key fence with a fresh provider read first; releasing,
      // null-key, or changed-key scopes remain fail-closed.
      await this.#assertPersonalProviderAccountAuthority(
        profile,
        command.provider,
        signal,
        true,
      );
    }
    this.#store.setSessionAdoptionPolicy({
      provider: command.provider,
      profileId: profile.id,
    });
    try {
      // The command dispatcher already owns this provider's adoption tail.
      const discovery = await this.#discoverPersonalProviderWithAccountLock(
        command.provider,
        signal,
      );
      return { ...this.#sessionAdoptionStatus(command.provider) as object, discovery };
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      this.recordBackgroundDiagnostic("session_adoption_failed", error);
      return {
        ...this.#sessionAdoptionStatus(command.provider) as object,
        discovery: { provider: command.provider, state: "unavailable" },
      };
    }
  }

  /** One bounded scan, also used by the daemon's single-owner poller. */
  async discoverPersonalSessions(
    provider: Provider | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const finish = this.#beginOperation();
    try {
      await this.#daemonAuthority.assertCurrent();
      const providers: readonly Provider[] = provider === undefined
        ? ["codex", "claude"]
        : [provider];
      const settled = await Promise.all(providers.map(async (candidateProvider) =>
        await this.#serialize(
          `session-adoption:${candidateProvider}`,
          async () => await this.#discoverPersonalProviderWithAccountLock(
            candidateProvider,
            signal,
          ),
        )));
      await this.#daemonAuthority.assertCurrent();
      return { version: 1, providers: settled };
    } finally {
      finish();
    }
  }

  async #projectForPersonalCandidate(
    candidate: DiscoveredPersonalSession,
  ): Promise<ProjectRecord | undefined> {
    if (candidate.projectRoot === undefined) return undefined;
    let root: string | null;
    try {
      root = await resolveUsableCanonicalProjectDirectory(candidate.projectRoot);
    } catch {
      return undefined;
    }
    if (root === null) return undefined;
    return this.#store.listProjects().find((project) => project.rootPath === root);
  }

  #personalCandidateIsRecent(candidate: DiscoveredPersonalSession): boolean {
    if (candidate.updatedAt === undefined) return candidate.liveness === "live";
    const now = this.#now();
    if (candidate.updatedAt > now + PERSONAL_SESSION_ADOPTION_CLOCK_SKEW_MS) return false;
    if (now - candidate.updatedAt <= PERSONAL_SESSION_ADOPTION_RECENCY_MS) return true;
    return candidate.provider === "codex" && candidate.scheduledTaskTarget === true;
  }

  #personalCandidateNeedsScheduledAgeWaiver(
    candidate: DiscoveredPersonalSession,
  ): boolean {
    if (
      candidate.provider !== "codex"
      || candidate.scheduledTaskTarget !== true
      || candidate.updatedAt === undefined
    ) return false;
    const now = this.#now();
    return candidate.updatedAt <= now + PERSONAL_SESSION_ADOPTION_CLOCK_SKEW_MS
      && now - candidate.updatedAt > PERSONAL_SESSION_ADOPTION_RECENCY_MS;
  }

  async #personalCodexScheduledAuthorityForDiscovery(): Promise<
    PersonalCodexScheduledAuthorityBatch
  > {
    const empty: PersonalCodexScheduledAuthorityBatch = {
      providerThreadIds: [],
      sourceDirectoryNamesByProviderThreadId: new Map(),
    };
    const reader = this.#readPersonalCodexAutomations;
    if (reader === undefined) return empty;
    try {
      const scan = await reader({
        kind: "page",
        after: this.#personalCodexAutomationCursor,
        limit: PERSONAL_SESSION_ADOPTION_SCAN_LIMIT,
      });
      if (
        (!scan.complete && scan.nextCursor === null)
        || scan.entries.length > PERSONAL_SESSION_ADOPTION_SCAN_LIMIT
        || scan.entries.length + scan.diagnostics.length
          > PERSONAL_SESSION_ADOPTION_SCAN_LIMIT
      ) {
        throw new Error("Personal Codex automation authority page was unavailable.");
      }
      const sourceNames = new Map<string, string[]>();
      for (const entry of scan.entries) {
        const automation = entry.automation;
        if (
          automation.kind !== "heartbeat"
          || automation.targetThreadId === null
          || !isEligiblePersonalCodexAutomationStatus(automation.status)
        ) continue;
        const existing = sourceNames.get(automation.targetThreadId) ?? [];
        if (!existing.includes(entry.sourceDirectoryName)) {
          existing.push(entry.sourceDirectoryName);
        }
        sourceNames.set(automation.targetThreadId, existing);
      }
      this.#personalCodexAutomationCursor = scan.nextCursor;
      return {
        providerThreadIds: [...sourceNames.keys()].sort(),
        sourceDirectoryNamesByProviderThreadId: new Map(
          [...sourceNames.entries()].map(([providerThreadId, names]) => [
            providerThreadId,
            [...names].sort(),
          ]),
        ),
      };
    } catch (error: unknown) {
      this.recordBackgroundDiagnostic("session_adoption_failed", error);
      return empty;
    }
  }

  async #assertPersonalCodexScheduledTargetStillPresent(
    providerThreadId: string,
    sourceDirectoryNames: readonly string[],
  ): Promise<void> {
    const reader = this.#readPersonalCodexAutomations;
    if (reader === undefined || sourceDirectoryNames.length === 0) {
      throw new Error("SESSION_ADOPTION_SCHEDULED_TARGET_CHANGED");
    }
    const requestedSources = new Set(sourceDirectoryNames);
    const scan = await reader({
      kind: "sources",
      sourceDirectoryNames,
    });
    if (
      !scan.complete
      || scan.nextCursor !== null
      || scan.entries.length > requestedSources.size
      || scan.entries.some((entry) => !requestedSources.has(entry.sourceDirectoryName))
      || !scan.entries.some((entry) =>
        entry.automation.kind === "heartbeat"
        && entry.automation.targetThreadId === providerThreadId
        && isEligiblePersonalCodexAutomationStatus(entry.automation.status))
    ) {
      throw new Error("SESSION_ADOPTION_SCHEDULED_TARGET_CHANGED");
    }
  }

  async #reprobeRetainedClaudeCandidates(
    currentProviderThreadIds: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<readonly RetainedClaudeCandidateObservation[]> {
    if (this.#claudeProcessLiveness === undefined) return [];
    const retained = this.#store
      .listRecentClaudeSessionAdoptionCandidatesWithSourceIdentity({
        providerUpdatedAfter: Math.max(0, this.#now() - PERSONAL_SESSION_ADOPTION_RECENCY_MS),
        // The current bounded registry page can occupy up to one full page in
        // the fair durable query. Read at most two pages, exclude those exact
        // ids, then retain one bounded reprobe page so vanished rows cannot be
        // starved by still-live rows that the registry keeps emitting.
        limit: PERSONAL_SESSION_ADOPTION_SCAN_LIMIT * 2,
      })
      .filter((candidate) => !currentProviderThreadIds.has(candidate.providerThreadId))
      .slice(0, PERSONAL_SESSION_ADOPTION_SCAN_LIMIT);
    if (retained.length === 0) return [];

    const projects = new Map(
      this.#store.listProjects().map((project) => [project.id, project] as const),
    );
    const deadlineAt = this.#now() + CLAUDE_PROCESS_LIVENESS_DEADLINE_MS;
    const observed: RetainedClaudeCandidateObservation[] = [];
    for (
      let offset = 0;
      offset < retained.length;
      offset += CLAUDE_RETAINED_CANDIDATE_PROBE_CONCURRENCY
    ) {
      signal.throwIfAborted();
      const batch = retained.slice(
        offset,
        offset + CLAUDE_RETAINED_CANDIDATE_PROBE_CONCURRENCY,
      );
      const settled = await Promise.all(batch.map(async (candidate) => {
        const sourceProcessIdentity = candidate.sourceProcessIdentity;
        if (sourceProcessIdentity === null) return null;
        try {
          const liveness = await this.#fencedEffect(async () =>
            await this.#probeClaudeProcessIdentityLiveness(
              sourceProcessIdentity,
              signal,
              deadlineAt,
            ));
          signal.throwIfAborted();
          await this.#daemonAuthority.assertCurrent();
          const durableCandidate = this.#store
            .updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
              providerThreadId: candidate.providerThreadId,
              expectedRevision: candidate.revision,
              expectedSourceProcessIdentity: sourceProcessIdentity,
              liveness,
            });
          const syntheticCandidate: DiscoveredPersonalSession = {
            provider: "claude",
            providerThreadId: durableCandidate.providerThreadId,
            title: durableCandidate.title,
            ...(durableCandidate.providerUpdatedAt === null
              ? {}
              : { updatedAt: durableCandidate.providerUpdatedAt }),
            liveness: durableCandidate.liveness,
            sourceProcessIdentity: durableCandidate.sourceProcessIdentity,
          };
          return {
            candidate: syntheticCandidate,
            durableCandidate,
            project: durableCandidate.projectId === null
              ? undefined
              : projects.get(durableCandidate.projectId),
          } satisfies RetainedClaudeCandidateObservation;
        } catch (error: unknown) {
          if (signal.aborted) return { aborted: signal.reason as unknown } as const;
          this.recordBackgroundDiagnostic("session_adoption_failed", error);
          return null;
        }
      }));
      for (const result of settled) {
        if (result === null) continue;
        if ("aborted" in result) throw result.aborted;
        observed.push(result);
      }
    }
    return observed;
  }

  async #discoverPersonalProviderWithAccountLock(
    provider: Provider,
    signal: AbortSignal,
  ): Promise<unknown> {
    // Every caller owns session-adoption:<provider>. Preserve the global lock
    // order used by logout/revocation, then hold the selected account tail for
    // the entire provider claim and durable commit. A managed disconnect may
    // advance the account generation before this lock or observe the committed
    // personal binding afterward, but cannot invalidate authority mid-claim.
    const policy = this.#store.readSessionAdoptionPolicy(provider);
    if (policy === null || !policy.enabled || policy.profileId === null) {
      return await this.#discoverPersonalProviderLocked(provider, signal);
    }
    return await this.#serialize(
      `account:${policy.profileId}`,
      async () => await this.#discoverPersonalProviderLocked(provider, signal),
    );
  }

  async #discoverPersonalProviderLocked(
    provider: Provider,
    signal: AbortSignal,
  ): Promise<unknown> {
    const policy = this.#store.readSessionAdoptionPolicy(provider);
    if (policy === null || !policy.enabled || policy.profileId === null) {
      return { provider, state: "disabled", discovered: 0, adopted: 0, pending: 0 };
    }
    if (this.#personalDiscovery === undefined || this.#personalCodexHome === undefined) {
      throw new ProviderRuntimeUnavailableError(
        `Personal-home ${provider} discovery is unavailable on this daemon.`,
      );
    }
    const profile = this.#store.requireProfileById(policy.profileId);
    if (provider === "codex") {
      this.#assertSignedIn(profile);
      this.#assertIdentifiableAccountAuthority(profile);
    }
    const authority = { ...authorityFor(this.#paths, profile), codexHome: this.#personalCodexHome };
    const discoveryProviderAccountKey = await this.#assertPersonalProviderAccountAuthority(
      profile,
      provider,
      signal,
      true,
    );
    const codexScheduledAuthority = provider === "codex"
      ? await this.#personalCodexScheduledAuthorityForDiscovery()
      : undefined;
    const codexScheduledThreadIds = codexScheduledAuthority?.providerThreadIds;
    let discoveryLimit = provider === "claude"
      ? CLAUDE_REGISTRY_MAX_RECORDS
      : PERSONAL_SESSION_ADOPTION_SCAN_LIMIT;
    if (codexScheduledThreadIds !== undefined && codexScheduledThreadIds.length > 0) {
      discoveryLimit = Math.min(
        PERSONAL_CODEX_DISCOVERY_SCAN_LIMIT,
        PERSONAL_SESSION_ADOPTION_SCAN_LIMIT + codexScheduledThreadIds.length,
      );
    }
    const observed = await this.#fencedEffect(async () => {
      return await this.#personalDiscovery?.discover({
        provider,
        ...(codexScheduledThreadIds === undefined
          ? {}
          : { codexScheduledThreadIds }),
        // A complete Claude registry contains at most this many records. Ask
        // discovery for every observed id so even an ineligible current row
        // fences a retained exact-process reprobe; admission remains bounded
        // separately below.
        limit: discoveryLimit,
        deadlineMs: 5_000,
        signal,
      }) ?? [];
    });
    const retainedClaude = provider === "claude"
      ? await this.#reprobeRetainedClaudeCandidates(
          new Set(observed
            .filter((candidate) => candidate.provider === "claude")
            .map((candidate) => candidate.providerThreadId)),
          signal,
        )
      : [];
    const admissionEligible = observed.filter((candidate) =>
      candidate.admissionEligible !== false);
    const discovered = provider === "codex"
      ? [
          ...admissionEligible
            .filter((candidate) => candidate.scheduledTaskTarget === true)
            .slice(0, PERSONAL_SESSION_ADOPTION_SCAN_LIMIT),
          ...admissionEligible
            .filter((candidate) => candidate.scheduledTaskTarget !== true)
            .slice(0, PERSONAL_SESSION_ADOPTION_SCAN_LIMIT),
        ]
      : admissionEligible.slice(0, PERSONAL_SESSION_ADOPTION_SCAN_LIMIT);
    const admissionCandidates: readonly (
      | Readonly<{ kind: "discovered"; candidate: DiscoveredPersonalSession }>
      | (Readonly<{ kind: "retained" }> & RetainedClaudeCandidateObservation)
    )[] = [
      ...discovered.map((candidate) => ({ kind: "discovered" as const, candidate })),
      ...retainedClaude.map((candidate) => ({ kind: "retained" as const, ...candidate })),
    ];
    let persisted = 0;
    let adopted = 0;
    let pending = 0;
    let failed = 0;
    for (const admissionCandidate of admissionCandidates) {
      const candidate = admissionCandidate.candidate;
      const codexClaimKey = provider === "codex"
        ? JSON.stringify([profile.id, profile.processGeneration, candidate.providerThreadId])
        : null;
      signal.throwIfAborted();
      if (candidate.provider !== provider || !this.#personalCandidateIsRecent(candidate)) continue;
      const project = admissionCandidate.kind === "retained"
        ? admissionCandidate.project
        : await this.#projectForPersonalCandidate(candidate);
      signal.throwIfAborted();
      await this.#daemonAuthority.assertCurrent();
      let durableCandidate = admissionCandidate.kind === "retained"
        ? admissionCandidate.durableCandidate
        : this.#store.upsertSessionAdoptionCandidate({
            provider,
            providerThreadId: candidate.providerThreadId,
            ...(project === undefined ? {} : { projectId: project.id }),
            title: candidate.title,
            state: candidate.liveness === "live" ? "active" : "idle",
            ...(candidate.updatedAt === undefined
              ? {}
              : { providerUpdatedAt: candidate.updatedAt }),
            liveness: candidate.liveness,
            ...(provider === "claude"
              ? { sourceProcessIdentity: candidate.sourceProcessIdentity ?? null }
              : {}),
          });
      if (admissionCandidate.kind === "discovered") persisted += 1;
      if (
        codexClaimKey !== null
        && this.#unprovenCodexAdoptionClaims.has(codexClaimKey)
      ) {
        if (durableCandidate.status === "pending" || durableCandidate.status === "claiming") {
          pending += 1;
        }
        continue;
      }
      if (durableCandidate.status === "claiming" && candidate.liveness === "not_live") {
        try {
          durableCandidate = this.#store.recoverSessionAdoptionClaimAfterObservation({
            provider,
            providerThreadId: candidate.providerThreadId,
            profileId: profile.id,
            expectedRevision: durableCandidate.revision,
          });
        } catch (error: unknown) {
          // A claiming row already contributes to the aggregate pending count.
          // Keep it fenced until a later observation or exact Claude process
          // release makes crash recovery provable.
          this.recordBackgroundDiagnostic("session_adoption_failed", error);
        }
      }
      if (durableCandidate.status !== "pending" || project === undefined) {
        if (durableCandidate.status === "pending" || durableCandidate.status === "claiming") {
          pending += 1;
        }
        continue;
      }
      if (
        (provider === "claude" && candidate.liveness !== "not_live")
        || (provider === "codex" && candidate.liveness !== "not_live")
      ) {
        pending += 1;
        continue;
      }
      if (this.#store.findSessionPersonalRuntimeBinding(
        provider,
        candidate.providerThreadId,
      )?.state === "detaching") {
        pending += 1;
        continue;
      }
      const claimState = { claimed: false, dispatched: false };
      let committedSession: SessionRecord | undefined;
      let claudeProcessIdentity: ClaudeProcessIdentity | undefined;
      let claudeLaunchIntent: ClaudeProcessLaunchIntentRecord | undefined;
      try {
        const projectRoot = await this.#requireUsableProjectRoot(project.rootPath);
        const adoptionPreset = this.#store.readDefaultPreset(provider);
        const adoptionFast = false;
        const needsScheduledAgeWaiver = this.#personalCandidateNeedsScheduledAgeWaiver(
          candidate,
        );
        const scheduledSourceDirectoryNames = needsScheduledAgeWaiver
          ? codexScheduledAuthority?.sourceDirectoryNamesByProviderThreadId.get(
              candidate.providerThreadId,
            ) ?? []
          : [];
        if (needsScheduledAgeWaiver) {
          await this.#assertPersonalCodexScheduledTargetStillPresent(
            candidate.providerThreadId,
            scheduledSourceDirectoryNames,
          );
        }
        durableCandidate = this.#store.fenceSessionAdoptionCandidateForClaim({
          provider,
          providerThreadId: candidate.providerThreadId,
          expectedRevision: durableCandidate.revision,
        });
        let projection: CodexSessionProjection;
        let connectionId: string;
        let effectiveRuntimeProfile: ReviewedRuntimeProfile;
        if (provider === "codex") {
          const personalCodex = this.#personalCodex;
          if (personalCodex === undefined) {
            throw new ProviderRuntimeUnavailableError(
              "Personal-home Codex control is unavailable on this daemon.",
            );
          }
          if (personalCodex.claimSession === undefined) {
            throw new ProviderRuntimeUnavailableError(
              "Personal-home Codex control cannot claim an existing thread.",
            );
          }
          const claimSession = personalCodex.claimSession.bind(personalCodex);
          const observation = await this.#fencedEffect(async () => {
            claimState.dispatched = true;
            const value = await claimSession({
              authority,
              providerThreadId: candidate.providerThreadId,
              projectRoot,
              preset: adoptionPreset,
              fast: adoptionFast,
              signal,
            });
            claimState.claimed = true;
            return value;
          });
          if (inferCodexLiveness({
            status: observation.projection.status,
            ...(observation.projection.activeTurnId === undefined
              ? {}
              : { activeTurnId: observation.projection.activeTurnId }),
            ...(observation.projection.providerUpdatedAt === undefined
              ? {}
              : { updatedAt: observation.projection.providerUpdatedAt }),
            now: this.#now(),
          }) !== "not_live") {
            throw new Error("SESSION_ADOPTION_CLAIM_LIVENESS_CHANGED");
          }
          projection = observation.projection;
          connectionId = observation.connectionId;
          effectiveRuntimeProfile = observation.effectiveRuntimeProfile;
        } else {
          const personalClaude = this.#personalClaude;
          if (personalClaude === undefined) {
            throw new ProviderRuntimeUnavailableError(
              "Personal-home Claude control is unavailable on this daemon.",
            );
          }
          claudeLaunchIntent = this.#store.stageClaudeProcessLaunchIntent({
            providerThreadId: candidate.providerThreadId,
            profileId: profile.id,
            profileGeneration: authority.generation,
            runtimeScope: "personal",
            providerAccountKey: discoveryProviderAccountKey,
          });
          const launchIntent = claudeLaunchIntent;
          const resumed = await this.#fencedEffect(async () => {
            const value = await personalClaude.claimSession({
              authority,
              admitProcessIdentity: async (identity) => {
                claudeProcessIdentity = await this.#recordClaimedClaudeProcess({
                  authority,
                  providerThreadId: candidate.providerThreadId,
                  runtimeScope: "personal",
                  launchIntent,
                  identity,
                  signal,
                });
              },
              providerThreadId: candidate.providerThreadId,
              projectRoot,
              title: candidate.title,
              preset: adoptionPreset,
              fast: adoptionFast,
              sourceLiveness: "not_live",
              signal,
            });
            claimState.claimed = true;
            return value;
          });
          if (claudeProcessIdentity === undefined) {
            throw new Error("CLAUDE_PROCESS_IDENTITY_NOT_ADMITTED");
          }
          projection = resumed;
          effectiveRuntimeProfile = resumed.effectiveRuntimeProfile;
          const observation = await this.#fencedEffect(async () =>
            await personalClaude.observeSession({
              authority,
              providerThreadId: candidate.providerThreadId,
              signal,
            }));
          connectionId = observation.connectionId;
        }
        if (
          projection.providerThreadId !== candidate.providerThreadId
          || projection.status !== "idle"
          || projection.activeTurnId !== undefined
        ) {
          throw new Error("SESSION_ADOPTION_CLAIM_NOT_QUIESCENT");
        }
        const projectionProject = projection.projectRoot === undefined
          ? project
          : await this.#projectForPersonalCandidate({
              ...candidate,
              projectRoot: projection.projectRoot,
            });
        if (projectionProject?.id !== project.id) {
          throw new Error("SESSION_ADOPTION_PROJECT_CHANGED_DURING_CLAIM");
        }
        signal.throwIfAborted();
        await this.#daemonAuthority.assertCurrent();
        const exactProfile = this.#store.requireProfileById(profile.id);
        if (provider === "codex") {
          this.#assertSignedIn(exactProfile);
          this.#assertIdentifiableAccountAuthority(exactProfile);
        } else if (
          exactProfile.state !== "signed_in"
          && exactProfile.state !== "signed_out"
        ) {
          throw new Error("SESSION_ADOPTION_PROFILE_AUTHORITY_CHANGED");
        }
        if (exactProfile.processGeneration !== authority.generation) {
          throw new Error("SESSION_ADOPTION_PROFILE_AUTHORITY_CHANGED");
        }
        // Identity is sandwiched around discovery and controller claim. The
        // selected account, personal provider home, and durable session
        // authority must still name one normalized provider identity at the
        // exact claim-to-commit boundary.
        const providerAccountKey = await this.#assertPersonalProviderAccountAuthority(
          exactProfile,
          provider,
          signal,
          true,
        );
        if (providerAccountKey !== discoveryProviderAccountKey) {
          this.#scheduleProviderRuntimeAccountRevocation(
            exactProfile,
            provider,
            "personal",
            providerAccountKey,
          );
          throw new ProviderAccountAuthorityMismatchError(
            provider,
            "personal",
            exactProfile,
          );
        }
        if (needsScheduledAgeWaiver) {
          await this.#assertPersonalCodexScheduledTargetStillPresent(
            candidate.providerThreadId,
            scheduledSourceDirectoryNames,
          );
        }
        durableCandidate = this.#store.upsertSessionAdoptionCandidate({
          provider,
          providerThreadId: projection.providerThreadId,
          projectId: project.id,
          // The Claude adapter bounds its in-memory display title. Preserve
          // the complete title discovered from the personal registry as the
          // durable session title across claim and later resume.
          title: provider === "claude" ? durableCandidate.title : projection.title,
          state: projection.status,
          ...(projection.providerUpdatedAt === undefined
            ? {}
            : { providerUpdatedAt: projection.providerUpdatedAt }),
          liveness: provider === "claude" ? "not_live" : candidate.liveness,
        });
        const result = this.#store.adoptSessionCandidate({
          provider,
          providerThreadId: projection.providerThreadId,
          expectedCandidateRevision: durableCandidate.revision,
          profileId: profile.id,
          profileGeneration: exactProfile.processGeneration,
          projectId: project.id,
          preset: adoptionPreset,
          fastEnabled: adoptionFast,
          runtimeProfile: effectiveRuntimeProfile,
          providerAccountKey,
          ...(claudeProcessIdentity === undefined ? {} : { claudeProcessIdentity }),
        });
        committedSession = result.session;
        if (codexClaimKey !== null) {
          this.#unprovenCodexAdoptionClaims.delete(codexClaimKey);
        }
        adopted += 1;
        this.#ensureSessionProviderConnection(authority, result.session, connectionId);
        if (provider === "claude") {
          const personalClaude = this.#personalClaude;
          if (personalClaude === undefined) {
            throw new ProviderRuntimeUnavailableError(
              "Personal-home Claude control disappeared after adoption commit.",
            );
          }
          try {
            // Re-prove the controller after the durable commit and provisional
            // connection map are both visible. A child that disconnected in
            // the claim-to-commit gap must not leave a bound dead-process row.
            const confirmation = await this.#fencedEffect(async () =>
              await personalClaude.observeSession({
                authority,
                providerThreadId: candidate.providerThreadId,
                signal,
              }));
            if (
              confirmation.projection.providerThreadId !== candidate.providerThreadId
              || confirmation.projection.status !== "idle"
              || confirmation.projection.activeTurnId !== undefined
            ) {
              throw new ClaudeSessionObservationError();
            }
            this.#ensureSessionProviderConnection(
              authority,
              result.session,
              confirmation.connectionId,
            );
          } catch (error: unknown) {
            await this.#releaseClaudeProcessAuthority(
              {
                providerThreadId: candidate.providerThreadId,
                profileId: profile.id,
                runtimeScope: "personal",
              },
              new AbortController().signal,
            );
            this.recordBackgroundDiagnostic("recovery_observation_failed", error);
            this.#scheduleRecoverySessionObservations([result.session]);
          }
        }
        await this.#reconcileCommittedSessionFactsMemory(result.session);
      } catch (error: unknown) {
        if (
          codexClaimKey !== null
          && error instanceof CodexClaimReleaseUnprovenError
        ) {
          this.#unprovenCodexAdoptionClaims.add(codexClaimKey);
        }
        // Codex's claim seam guarantees that every ordinary rejection has
        // either acquired no subscription or synchronously released/retired
        // the exact controller. Only the closed unproven-release error keeps
        // durable `claiming` custody for restart recovery. Do not target-end a
        // deterministic failed claim a second time: the provider identity may
        // already have been retired along with its connection.
        let releaseProven = provider === "codex"
          && committedSession === undefined
          && claimState.dispatched
          && !claimState.claimed
          && !(error instanceof CodexClaimReleaseUnprovenError);
        if (
          committedSession === undefined
          && !(error instanceof ClaudeProcessExitUnprovenError)
          && (claimState.claimed || claudeLaunchIntent !== undefined)
        ) {
          const release = provider === "claude"
            ? claudeProcessIdentity !== undefined
              ? this.#releaseClaudeProcessAuthority(
                  {
                    providerThreadId: candidate.providerThreadId,
                    profileId: profile.id,
                    runtimeScope: "personal",
                  },
                  new AbortController().signal,
                )
              : claimState.claimed
                ? this.#personalSessionRuntime(provider).endSession({
                    authority,
                    providerThreadId: candidate.providerThreadId,
                    signal: new AbortController().signal,
                  })
                : Promise.resolve()
            : this.#personalSessionRuntime(provider).endSession({
                authority,
                providerThreadId: candidate.providerThreadId,
                signal: new AbortController().signal,
              });
          try {
            await release;
            if (claudeLaunchIntent !== undefined) {
              this.#cancelClaudeProcessLaunchIntent(claudeLaunchIntent);
            }
            releaseProven = true;
          } catch (releaseError: unknown) {
            this.recordBackgroundDiagnostic("session_adoption_failed", releaseError);
          }
        }
        if (releaseProven) {
          if (codexClaimKey !== null) {
            this.#unprovenCodexAdoptionClaims.delete(codexClaimKey);
          }
          try {
            if (error instanceof ProviderAccountAuthorityMismatchError) {
              this.#store.fenceSessionAdoptionCandidateAfterClaimRelease({
                provider,
                providerThreadId: candidate.providerThreadId,
                profileId: profile.id,
              });
            } else {
              this.#store.requeueSessionAdoptionCandidateAfterClaimRelease({
                provider,
                providerThreadId: candidate.providerThreadId,
                profileId: profile.id,
              });
            }
          } catch (requeueError: unknown) {
            this.recordBackgroundDiagnostic("session_adoption_failed", requeueError);
          }
        }
        if (signal.aborted) throw signal.reason;
        if (committedSession === undefined) failed += 1;
        if (committedSession !== undefined) {
          this.#scheduleRecoverySessionObservations([committedSession]);
        }
        this.recordBackgroundDiagnostic("session_adoption_failed", error);
      }
    }
    return {
      provider,
      state: "ready",
      discovered: persisted,
      adopted,
      pending,
      failed,
    };
  }

  async #detachPersonalSession(
    sessionId: SessionRecord["id"],
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const session = this.#store.requireSession(sessionId);
    if (session.providerThreadId === undefined) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The session has no proven provider binding.");
    }
    const providerThreadId = session.providerThreadId;
    const binding = this.#store.readSessionPersonalRuntimeBinding(session.id, true);
    if (binding === null || binding.state === "detached") {
      throw new CommandFailure("CONFLICT", "That session is not controlled from a personal provider home.");
    }
    if (
      binding.provider !== session.provider
      || binding.providerThreadId !== providerThreadId
    ) {
      throw new CommandFailure(
        "CONFLICT",
        "The personal-home binding no longer matches this session's provider identity.",
      );
    }
    if (
      binding.state === "active"
      && (session.state === "active" || session.activeTurnId !== undefined)
    ) {
      throw new CommandFailure(
        "CONFLICT",
        "Stop the active turn before detaching this session.",
      );
    }
    const profile = this.#store.requireProfileById(session.profileId);
    const authority = this.#personalAuthorityForProfile(profile);
    if (binding.state === "active") {
      if (session.state !== "terminal" && session.state !== "recovery_required") {
        const projection = await this.#readExactSessionProjection(
          { ...session, providerThreadId },
          profile,
          false,
          signal,
        );
        signal.throwIfAborted();
        await this.#daemonAuthority.assertCurrent();
        if (projection.status !== "idle" || projection.activeTurnId !== undefined) {
          throw new CommandFailure(
            "CONFLICT",
            "The provider still reports an active turn. Stop it before detaching this session.",
          );
        }
      }
      try {
        this.#clearSessionFactAuthority(session.id);
        this.#store.beginPersonalSessionDetach({ sessionId: session.id });
      } catch (error: unknown) {
        const code = error instanceof Error ? error.message : "";
        if (code.includes("SESSION_ADOPTION_DETACH_ACTIVE_TURN")) {
          throw new CommandFailure(
            "CONFLICT",
            "Stop the active turn before detaching this session.",
          );
        }
        if (code.includes("SESSION_ADOPTION_DETACH_PENDING_INTERACTION")) {
          throw new CommandFailure(
            "CONFLICT",
            "Resolve or wait for the pending provider interaction before detaching this session.",
          );
        }
        if (code.includes("SESSION_ADOPTION_DETACH_UNSETTLED_QUEUE")) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "Wait for queued work to settle before detaching this session.",
          );
        }
        if (code.includes("SESSION_ADOPTION_DETACH_UNSETTLED_MUTATION")) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "Resolve the session's unsettled provider mutation before detaching it.",
          );
        }
        if (code.includes("SESSION_ADOPTION_DETACH_ACTIVE_TASK")) {
          throw new CommandFailure(
            "CONFLICT",
            "Pause or delete active scheduled tasks before detaching this session.",
          );
        }
        throw error;
      }
    }
    try {
      if (session.provider === "claude") {
        await this.#releaseClaudeProcessAuthority(
          {
            providerThreadId,
            profileId: session.profileId,
            runtimeScope: "personal",
          },
          new AbortController().signal,
        );
      } else {
        await this.#fencedEffect(async () =>
          await this.#personalSessionRuntime(session.provider).endSession({
            authority,
            providerThreadId,
            signal: new AbortController().signal,
          }));
      }
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      this.recordBackgroundDiagnostic("session_adoption_failed", error);
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The session is fenced from new work, but provider controller release did not finish. HRA will retry it during recovery.",
      );
    }
    await this.#daemonAuthority.assertCurrent();
    let detached: ReturnType<StateStore["completePersonalSessionDetach"]>;
    try {
      detached = this.#store.completePersonalSessionDetach({ sessionId: session.id });
    } catch (error: unknown) {
      this.recordBackgroundDiagnostic("session_adoption_failed", error);
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The provider controller was released, but durable session cleanup did not finish. HRA will retry it during recovery.",
      );
    }
    this.#sessionProviderConnections.delete(session.id);
    this.#clearSessionFactAuthority(session.id);
    this.#sessionObservationFailures.delete(session.id);
    this.#sessionResubscriptionConnections.delete(session.id);
    this.#sessionsAwaitingResubscription.delete(session.id);
    return {
      version: 1,
      session: detached.session.id,
      detached: true,
      archived: detached.session.archivedAt !== undefined,
    };
  }

  #beginSessionListTraversal(profile: ProfileRecord): Readonly<{
    id: string;
    state: SessionListTraversalReplayState;
  }> {
    while (this.#sessionListTraversals.size >= SESSION_LIST_TRAVERSAL_LIMIT) {
      const oldest = this.#sessionListTraversals.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#sessionListTraversals.delete(oldest);
    }
    const id = randomUUID();
    const state: SessionListTraversalReplayState = {
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      importedSessionIdsByProviderPage: new Map(),
      emittedSessionIds: new Set(),
      importReceiptCount: 0,
    };
    this.#sessionListTraversals.set(id, state);
    return { id, state };
  }

  #requireSessionListTraversal(
    traversalId: string,
    profile: ProfileRecord,
  ): SessionListTraversalReplayState {
    const state = this.#sessionListTraversals.get(traversalId);
    if (
      state === undefined
      || state.accountId !== profile.id
      || state.providerGeneration !== profile.processGeneration
    ) {
      throw new CommandFailure(
        "INVALID_INPUT",
        "This session-list cursor's bounded replay state expired. Restart the account listing without a cursor.",
      );
    }
    // Map insertion order is the traversal LRU. A bounded eviction is explicit
    // on reuse rather than silently changing which provider rows a cursor emits.
    this.#sessionListTraversals.delete(traversalId);
    this.#sessionListTraversals.set(traversalId, state);
    return state;
  }

  #rememberSessionListProviderImport(
    traversalId: string,
    state: SessionListTraversalReplayState,
    providerPage: string,
    sessionId: SessionRecord["id"],
  ): void {
    let receipt = state.importedSessionIdsByProviderPage.get(providerPage);
    if (receipt?.has(sessionId) === true) return;
    if (state.importReceiptCount >= SESSION_LIST_TRAVERSAL_IMPORT_RECEIPT_LIMIT) {
      this.#sessionListTraversals.delete(traversalId);
      throw new CommandFailure(
        "UNAVAILABLE",
        "This session-list traversal exceeded its bounded replay evidence. Restart the account listing without a cursor; imported sessions remain safely local.",
      );
    }
    if (receipt === undefined) {
      receipt = new Set();
      state.importedSessionIdsByProviderPage.set(providerPage, receipt);
    }
    receipt.add(sessionId);
    state.importReceiptCount += 1;
  }

  async #listSessions(
    account: string | undefined,
    limit: number,
    cursor: string | undefined,
    includeArchived: boolean,
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
        sessions: this.#store.listSessions(limit, undefined, includeArchived),
        nextCursor: null,
      };
    }
    const profile = this.#store.requireProfile(account);
    if (profile.state === "signed_out") {
      const cursorFilter = {
        accountId: profile.id,
        accountGeneration: profile.processGeneration,
        limit,
        includeArchived,
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
        includeArchived,
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
          provider: "codex",
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
      includeArchived,
    } as const;
    let decodedCursor: ReturnType<SessionEventCursorCodec["decodeSessionList"]> | undefined;
    let decodedLocalCursor: ReturnType<SessionEventCursorCodec["decodeAccountSessionLocal"]> | undefined;
    if (cursor !== undefined) {
      try {
        decodedCursor = this.#eventCursors.decodeSessionList(cursor, cursorFilter);
      } catch (error: unknown) {
        if (!(error instanceof SessionEventCursorError) || error.reason !== "type_mismatch") {
          throw error;
        }
        decodedLocalCursor = this.#eventCursors.decodeAccountSessionLocal(cursor, cursorFilter);
      }
    }
    const decodedTraversalId = decodedCursor?.traversalId ?? decodedLocalCursor?.traversalId;
    if (cursor !== undefined && decodedTraversalId === undefined) {
      throw new CommandFailure(
        "INVALID_INPUT",
        "This session-list cursor predates bounded replay authority. Restart the account listing without a cursor.",
      );
    }
    const traversal = cursor === undefined
      ? this.#beginSessionListTraversal(profile)
      : {
          id: decodedTraversalId as string,
          state: this.#requireSessionListTraversal(decodedTraversalId as string, profile),
        };
    if (await this.#cloud.isCompactProjectionRecoveryUnsettledForProfile(profile.id)) {
      await this.#daemonAuthority.assertCurrent();
      if (
        decodedCursor !== undefined
        || (decodedLocalCursor !== undefined && decodedLocalCursor.afterCreatedAt === null)
      ) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "Provider session-list continuation is paused while compact-projection recovery preserves exact local authority.",
        );
      }
      const localPage = this.#store.listLocalSessionPage({
        profileId: profile.id,
        after: decodedLocalCursor === undefined
          ? null
          : {
              createdAt: decodedLocalCursor.afterCreatedAt as number,
              sessionId: decodedLocalCursor.afterSessionId as SessionRecord["id"],
            },
        includeArchived,
        limit,
        requireCurrentAccountAuthority: true,
      });
      for (const session of localPage.sessions) {
        traversal.state.emittedSessionIds.add(session.id);
      }
      const nextCursor = localPage.nextPosition === null
        ? null
        : this.#eventCursors.encodeAccountSessionLocal({
            ...cursorFilter,
            traversalId: traversal.id,
            afterCreatedAt: localPage.nextPosition.createdAt,
            afterSessionId: localPage.nextPosition.sessionId,
          });
      if (nextCursor === null) this.#sessionListTraversals.delete(traversal.id);
      return {
        accountId: profile.id,
        sessions: localPage.sessions,
        nextCursor,
        recovery: {
          diagnostic: nextCursor === null
            ? "Every currently authorized local session was listed, but provider reconciliation remains paused while compact-projection recovery preserves exact local authority."
            : "More currently authorized local sessions remain; provider reconciliation is paused while compact-projection recovery preserves exact local authority.",
          required: true,
        },
      };
    }
    const shouldReadLocalPage = decodedCursor === undefined
      && (
        cursor === undefined
        || (
          decodedLocalCursor !== undefined
          && decodedLocalCursor.afterCreatedAt !== null
        )
      );
    if (shouldReadLocalPage) {
      const localAfter = decodedLocalCursor === undefined
        || decodedLocalCursor.afterCreatedAt === null
        || decodedLocalCursor.afterSessionId === null
        ? null
        : {
            createdAt: decodedLocalCursor.afterCreatedAt,
            sessionId: decodedLocalCursor.afterSessionId,
          };
      const localPage = this.#store.listLocalSessionPage({
        profileId: profile.id,
        after: localAfter,
        includeArchived,
        limit,
        requireCurrentAccountAuthority: true,
      });
      if (localPage.sessions.length > 0) {
        for (const session of localPage.sessions) {
          traversal.state.emittedSessionIds.add(session.id);
        }
        return {
          accountId: profile.id,
          sessions: localPage.sessions,
          // null/null is a signed transition into provider discovery. Even an
          // exact-boundary local page must not let the next request repeat the
          // local phase or expose a source-specific ordering arm.
          nextCursor: this.#eventCursors.encodeAccountSessionLocal({
              ...cursorFilter,
              traversalId: traversal.id,
              afterCreatedAt: localPage.nextPosition?.createdAt ?? null,
              afterSessionId: localPage.nextPosition?.sessionId ?? null,
            }),
        };
      }
    }
    this.#assertIdentifiableAccountAuthority(profile);
    const expectedAccountFingerprint = accountFingerprintForProfile(profile);
    await this.#proveUsageAccountIdentity({
      profile,
      expectedFingerprint: expectedAccountFingerprint,
      signal,
    });
    const providerAccountKey = profileCodexAccountAuthorityKey(profile);
    if (providerAccountKey === null) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The selected account has no stable Codex provider identity.",
      );
    }
    const remote = await this.#fencedEffect(async () => await this.#codex.listSessions({
      authority: authorityFor(this.#paths, profile),
      limit,
      ...(decodedCursor === undefined ? {} : { cursor: decodedCursor.providerCursor }),
      signal,
    }));
    // The list response carries no account identity. Re-prove the same account
    // after the read and before importing any row, so an account swap during
    // the provider call cannot bind another identity's thread to this profile.
    await this.#proveUsageAccountIdentity({
      profile,
      expectedFingerprint: expectedAccountFingerprint,
      signal,
    });
    const providerPageReplayKey = decodedCursor === undefined
      ? "provider:first"
      : `provider:cursor:${decodedCursor.providerCursor}`;
    let providerPageImportReceipt = traversal.state.importedSessionIdsByProviderPage
      .get(providerPageReplayKey);
    let nextCursor: string | null = null;
    if (remote.nextCursor !== null) {
      try {
        nextCursor = this.#eventCursors.advanceSessionList({
          ...cursorFilter,
          traversalId: traversal.id,
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
    const remoteSessionIds = new Set<string>();
    for (const projection of remote.sessions.slice(0, limit)) {
      const personalBinding = this.#store.findSessionPersonalRuntimeBinding(
        "codex",
        projection.providerThreadId,
      );
      if (personalBinding !== null) {
        const personalSession = this.#store.requireSession(personalBinding.sessionId);
        if (personalBinding.state !== "detached") {
          // A managed-home listing may expose a thread currently controlled
          // through the personal home. Treat that as an identity collision,
          // never as authority to mutate or emit the personally controlled row
          // from the wrong provider source. Its ordinary row was already part
          // of the source-neutral local phase.
          continue;
        }
        // A detached row with the same account/thread identity remains an
        // explicit personal-home detach fence. A managed-home import must not
        // silently cross that authority boundary or confuse home ownership.
        if (personalSession.profileId === profile.id) continue;
      }
      const localCollision = this.#store.findSessionByProviderThread(
        profile.id,
        projection.providerThreadId,
      );
      if (localCollision !== null && localCollision.provider !== "codex") {
        // Provider-thread ids are opaque within each provider home. A Codex
        // projection must never mutate a local Claude row merely because the
        // two providers selected the same string.
        continue;
      }
      if (
        localCollision !== null
        && !this.#store.sessionAccountAuthorityMatches(localCollision.id, profile.id)
      ) {
        // A provider identity replacement can reuse an opaque thread id. The
        // old identity's row remains recoverable if that identity returns, but
        // the replacement identity cannot mutate or inherit it.
        continue;
      }
      const alreadyEmittedInTraversal = localCollision !== null
        && traversal.state.emittedSessionIds.has(localCollision.id);
      const emittedOnThisProviderPage = localCollision !== null
        && providerPageImportReceipt?.has(localCollision.id) === true;
      const projectId = projection.projectRoot === undefined ? undefined : projects.find((project) => project.rootPath === projection.projectRoot)?.id;
      const session = this.#store.upsertProviderSession({
        profileId: profile.id,
        provider: "codex",
        providerThreadId: projection.providerThreadId,
        ...(projectId === undefined ? {} : { projectId }),
        title: projection.title,
        preset: this.#store.readDefaultPreset("codex"),
        fastEnabled: false,
        state: projection.status,
        ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
        ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
        providerAccountKey,
        conversationAutomationEnabled: true,
      });
      if (!alreadyEmittedInTraversal) {
        this.#rememberSessionListProviderImport(
          traversal.id,
          traversal.state,
          providerPageReplayKey,
          session.id,
        );
        providerPageImportReceipt = traversal.state.importedSessionIdsByProviderPage
          .get(providerPageReplayKey);
        traversal.state.emittedSessionIds.add(session.id);
      }
      if (remoteSessionIds.has(session.id)) continue;
      remoteSessionIds.add(session.id);
      await this.#reconcileCommittedSessionFactsMemory(session);
      if (!alreadyEmittedInTraversal || emittedOnThisProviderPage) sessions.push(session);
    }
    const visibleRemoteSessions = includeArchived
      ? sessions
      : sessions.filter((session) => session.archivedAt === undefined);
    return {
      accountId: profile.id,
      // Archive is a listing filter over locally known sessions: the
      // provider has no archive concept, so its page is filtered here.
      sessions: visibleRemoteSessions,
      nextCursor,
    };
  }

  /*
   * Adds each user message`s attachment manifest to a provider projection.
   * The manifest names the file, its declared media type, its length, and its
   * digest; the bytes stay in local custody and never enter a projection, a
   * rendered result, or a log.
   */
  #withAttachmentManifests(
    sessionId: SessionRecord["id"],
    projection: CodexSessionProjection,
  ): CodexSessionProjection {
    const messages = projection.messages;
    if (messages === undefined || messages.length === 0) return projection;
    const enriched = messages.map((message) => {
      if (message.role !== "user" || message.clientId === undefined) return message;
      const manifest = this.#store.messageAttachmentManifest(sessionId, message.clientId);
      return manifest.length === 0 ? message : { ...message, attachments: manifest };
    });
    const changed = enriched.some((message, index) => message !== messages[index]);
    return changed ? { ...projection, messages: enriched } : projection;
  }

  async #showSession(selector: string, detail: boolean, signal: AbortSignal): Promise<unknown> {
    const session = this.#store.requireSession(selector);
    if (session.providerThreadId === undefined) {
      return {
        session,
        effectiveRuntimeProfile: publicRuntimeProfile(
          this.#store.latestSessionRuntimeProfile(session.id)?.profile,
        ),
      };
    }
    const providerThreadId = session.providerThreadId;
    const profile = this.#store.requireProfile(session.profileId);
    if (
      session.provider === "claude"
      && this.#platform !== "linux"
      && !this.#sessionHasMatchingActivePersonalBinding(session)
    ) {
      return {
        session,
        effectiveRuntimeProfile: this.#store.latestSessionRuntimeProfile(session.id)?.profile ?? null,
        providerObservation: this.#claudePlatformUnavailableObservation(profile),
      };
    }
    this.#assertEstablishedSessionAccount(profile, session);
    if (session.state !== "terminal" && session.state !== "recovery_required") {
      this.#requireLiveProviderObservation(
        await this.#ensureSessionObservedLocked(session.id, signal),
      );
    }
    const projectionRecoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettled(session.id);
    await this.#daemonAuthority.assertCurrent();
    const observed = await this.#readExactSessionProjection(
      { ...session, providerThreadId },
      profile,
      detail,
      signal,
    );
    const projection = this.#withAttachmentManifests(session.id, observed);
    if (projectionRecoveryUnsettled || this.#projectionRecoveriesInFlight.has(session.id)) {
      const runtimeProfile = this.#store.latestSessionRuntimeProfile(session.id)?.profile ?? null;
      const coherentSession = this.#store.requireSession(session.id);
      return {
        session: coherentSession,
        ...(projection.providerThreadId === providerThreadId ? { projection } : {}),
        effectiveRuntimeProfile: publicRuntimeProfile(runtimeProfile),
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
      ? { session: coherentSession, projection, effectiveRuntimeProfile: publicRuntimeProfile(runtimeProfile), recovery: { required: true, cleared: false } }
      : { session: coherentSession, projection, effectiveRuntimeProfile: publicRuntimeProfile(runtimeProfile) };
  }

  async #startSession(command: Extract<LocalCommand, { kind: "session.start" }>, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(command.account);
    await this.#assertNoCompactProjectionRecoveryForProfile(profile.id);
    const provider = command.provider ?? "codex";
    const project = command.project === undefined ? this.#store.listProjects().find((candidate) => candidate.default) : this.#store.requireProject(command.project);
    if (project === undefined) throw new CommandFailure("INTERACTION_REQUIRED", "Add or select a project directory before starting a session.");
    await this.#requireUsableProjectRoot(project.rootPath);
    // A preset the chosen provider cannot run is refused here, before any
    // durable placeholder or provider effect exists.
    if (!isPresetSupportedByProvider(provider, command.preset)) {
      throw new CommandFailure(
        "INVALID_INPUT",
        new PresetProviderMismatchError(provider, command.preset).message,
      );
    }
    // The session binds this provider's port for its whole life: the durable
    // session-start evidence carries whichever provider's reviewed profile the
    // port proves, and every later turn, steer, stop, and interaction on this
    // session is routed back to the same port by `sessions.provider`.
    const runtime = this.#sessionRuntime(provider);
    // Prove authentication under the account serializer before the first
    // durable mutation row or runtime review exists. Storage consumes this
    // exact profile/provider/generation tuple at the effect boundary.
    const providerAuthentication = await this.#assertProviderSignedIn(
      profile,
      provider,
      signal,
    );
    const key = command.idempotencyKey ?? randomUUID();
    let localSessionId: SessionRecord["id"] | undefined;
    let clientMessageId: MutationAttemptRecord["id"] | undefined;
    let review: RuntimeStartReviewOf<ReviewedRuntimeProfile> | undefined;
    let startedProjection:
      | (CodexSessionProjection & { effectiveRuntimeProfile: ReviewedRuntimeProfile })
      | undefined;
    let claudeProcessIdentity: ClaudeProcessIdentity | undefined;
    let claudeLaunchIntent: ClaudeProcessLaunchIntentRecord | undefined;
    let providerAccountKey: string | undefined;
    const reservedClaudeProviderThreadId = provider === "claude" ? randomUUID() : undefined;
    let outcome: z.infer<typeof sessionStartReceiptSchema>;
    try {
      outcome = await this.#effect<z.infer<typeof sessionStartReceiptSchema>>({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: {
        projectId: project.id,
        provider,
        preset: command.preset,
        fast: command.fast,
      },
      idempotencyKey: key,
      beginEffect: async (attemptId) => {
        clientMessageId = attemptId;
        providerAccountKey = await this.#assertProviderRuntimeAccountAuthority(
          profile,
          provider,
          "managed",
          signal,
          true,
        );
        review = await this.#fencedRuntimeReview(runtime, async () => {
          const projectRoot = await this.#requireUsableProjectRoot(project.rootPath);
          return await runtime.reviewSessionStart({
            authority: authorityFor(this.#paths, profile),
            projectRoot,
            preset: command.preset,
            fast: command.fast,
            signal,
          });
        });
        const reviewedAccountKey = await this.#assertProviderRuntimeAccountAuthority(
          this.#store.requireProfileById(profile.id),
          provider,
          "managed",
          signal,
          true,
        );
        if (reviewedAccountKey !== providerAccountKey) {
          throw new ProviderAccountAuthorityMismatchError(provider, "managed", profile);
        }
        const local = this.#store.beginSessionStartEffect({
          attemptId,
          profileId: profile.id,
          profileGeneration: profile.processGeneration,
          projectId: project.id,
          provider,
          providerAuthentication,
          preset: command.preset,
          fastEnabled: command.fast,
          providerAccountKey,
          evidence: {
            kind: "session.start",
            projectId: project.id,
            clientMessageId: null,
            messageDigest: null,
            runtimeProfile: review.effectiveRuntimeProfile,
            conversationAutomationCapability: SESSION_CONVERSATION_AUTOMATION_CAPABILITY,
          },
        });
        localSessionId = local.id;
        if (provider === "claude") {
          if (reservedClaudeProviderThreadId === undefined) {
            throw new Error("CLAUDE_PROVIDER_THREAD_ID_NOT_RESERVED");
          }
          claudeLaunchIntent = this.#store.stageClaudeProcessLaunchIntent({
            providerThreadId: reservedClaudeProviderThreadId,
            profileId: profile.id,
            profileGeneration: profile.processGeneration,
            runtimeScope: "managed",
            providerAccountKey,
            sessionId: local.id,
          });
        }
      },
      effect: async () => {
        if (localSessionId === undefined || clientMessageId === undefined || review === undefined) throw new Error("Session start effect lost its durable placeholder or runtime-review binding.");
        const runtimeReview = review;
        const local = this.#store.requireSession(localSessionId);
        const launchProviderThreadId = provider === "claude"
          ? reservedClaudeProviderThreadId
          : undefined;
        if (provider === "claude" && launchProviderThreadId === undefined) {
          throw new Error("CLAUDE_PROVIDER_THREAD_ID_NOT_RESERVED");
        }
        try {
          await this.#fencedEffect(async () => {
            const projectRoot = await this.#requireUsableProjectRoot(project.rootPath);
            const value = await runtime.startSession({
              authority: authorityFor(this.#paths, profile),
              ...(launchProviderThreadId === undefined
                ? {}
                : {
                    providerThreadId: launchProviderThreadId,
                    admitProcessIdentity: async (identity: ClaudeProcessIdentity) => {
                      if (claudeLaunchIntent === undefined) {
                        throw new Error("CLAUDE_PROCESS_LAUNCH_INTENT_MISSING");
                      }
                      claudeProcessIdentity = await this.#recordClaimedClaudeProcess({
                        authority: authorityFor(this.#paths, profile),
                        providerThreadId: launchProviderThreadId,
                        runtimeScope: "managed",
                        sessionId: local.id,
                        launchIntent: claudeLaunchIntent,
                        identity,
                        signal,
                      });
                    },
                  }),
              projectRoot,
              review: runtimeReview,
              signal,
            });
            startedProjection = value;
            return value;
          });
          if (startedProjection === undefined) {
            throw new Error("Session start returned no exact provider projection.");
          }
          if (provider === "claude") {
            if (
              reservedClaudeProviderThreadId === undefined
              || startedProjection.providerThreadId !== reservedClaudeProviderThreadId
              || claudeProcessIdentity === undefined
            ) throw new Error("CLAUDE_PROCESS_IDENTITY_NOT_ADMITTED");
          }
          await this.#assertSessionAccountAuthorityAfterProviderEffect(
            local,
            this.#store.requireProfileById(profile.id),
            signal,
          );
        } catch (error: unknown) {
          await this.#daemonAuthority.assertCurrent();
          if (
            error instanceof IndeterminateCodexEffectError
            || error instanceof IndeterminateLocalCommitError
          ) {
            this.#quarantineSession(local.id);
            throw error;
          }
          if (provider === "claude" && error instanceof ClaudeProcessExitUnprovenError) {
            this.#quarantineSession(local.id);
            throw new IndeterminateLocalCommitError(
              "Claude session admission failed without proof that its controller exited.",
              error,
            );
          }
          if (startedProjection !== undefined) {
            try {
              if (provider === "claude" && claudeProcessIdentity !== undefined) {
                await this.#releaseClaudeProcessAuthority(
                  {
                    providerThreadId: startedProjection.providerThreadId,
                    profileId: profile.id,
                    runtimeScope: "managed",
                  },
                  new AbortController().signal,
                );
              } else {
                await runtime.endSession({
                  authority: authorityFor(this.#paths, profile),
                  providerThreadId: startedProjection.providerThreadId,
                  signal: new AbortController().signal,
                });
              }
            } catch (releaseError: unknown) {
              this.#quarantineSession(local.id);
              throw new IndeterminateLocalCommitError(
                "The provider created a session, but HRA could not prove its controller was released after admission failed.",
                releaseError,
              );
            }
          } else if (provider === "claude" && claudeProcessIdentity !== undefined) {
            if (launchProviderThreadId === undefined) {
              throw new Error("CLAUDE_PROVIDER_THREAD_ID_NOT_RESERVED");
            }
            try {
              await this.#releaseClaudeProcessAuthority(
                {
                  providerThreadId: launchProviderThreadId,
                  profileId: profile.id,
                  runtimeScope: "managed",
                },
                new AbortController().signal,
              );
            } catch (releaseError: unknown) {
              this.#quarantineSession(local.id);
              throw new IndeterminateLocalCommitError(
                "Claude admission failed after exact process custody, but controller release was not proven.",
                releaseError,
              );
            }
          }
          if (claudeLaunchIntent !== undefined) {
            try {
              this.#cancelClaudeProcessLaunchIntent(claudeLaunchIntent);
            } catch (cancelError: unknown) {
              this.#quarantineSession(local.id);
              throw new IndeterminateLocalCommitError(
                "Claude rejected session creation, but its launch intent could not be retired.",
                cancelError,
              );
            }
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
      commit: async (attemptId, _value, receipt) => {
        if (localSessionId === undefined || startedProjection === undefined) throw new Error("Session start commit lost its exact provider projection.");
        const local = this.#store.requireSession(localSessionId);
        await this.#assertSessionAccountAuthorityAfterProviderEffect(
          local,
          this.#store.requireProfileById(profile.id),
          signal,
        );
        this.#store.completeSessionStartEffect({
          attemptId,
          sessionId: local.id,
          expectedSessionRevision: local.revision,
          providerThreadId: startedProjection.providerThreadId,
          state: startedProjection.status,
          ...(startedProjection.activeTurnId === undefined ? {} : { activeTurnId: startedProjection.activeTurnId }),
          ...(startedProjection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: startedProjection.providerUpdatedAt }),
          runtimeProfile: startedProjection.effectiveRuntimeProfile,
          ...(claudeProcessIdentity === undefined ? {} : { claudeProcessIdentity }),
          receipt,
        });
      },
      onAmbiguous: () => {
        if (localSessionId === undefined) return;
        if (startedProjection !== undefined && clientMessageId !== undefined) {
          try {
            const local = this.#store.requireSession(localSessionId);
            if (local.providerThreadId === undefined && local.state === "starting") {
              this.#store.bindSessionStartRecoveryTarget({
                attemptId: clientMessageId,
                sessionId: local.id,
                expectedSessionRevision: local.revision,
                providerThreadId: startedProjection.providerThreadId,
                title: startedProjection.title,
                ...(startedProjection.providerUpdatedAt === undefined
                  ? {}
                  : { providerUpdatedAt: startedProjection.providerUpdatedAt }),
                runtimeProfile: startedProjection.effectiveRuntimeProfile,
              });
              return;
            }
          } catch {
            // The quarantine below is the last durable fallback if the exact
            // provider binding cannot be persisted after the provider return.
          }
        }
        this.#quarantineSession(localSessionId);
      },
      });
    } finally {
      if (review !== undefined) runtime.discardRuntimeReview(review);
    }
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
      effectiveRuntimeProfile: publicRuntimeProfile(
        outcome.effectiveRuntimeProfile
          ?? this.#store.latestSessionRuntimeProfile(outcome.sessionId)?.profile,
      ),
      idempotencyKey: key,
    };
  }

  /**
   * Read one bounded page of the provider-neutral conversation.
   *
   * Everything here comes from HRA's own event stream. Nothing asks a
   * provider, so a session whose provider thread is gone, whose provider is
   * unavailable, or which has already been switched still answers.
   */
  #readTranscript(
    selector: string,
    after: number | undefined,
    limit: number,
  ): SessionTranscript {
    const session = this.#store.requireSession(selector);
    const events: SessionEvent[] = [];
    let cursor = after ?? null;
    let exhausted = false;
    for (let page = 0; page < TRANSCRIPT_EVENT_PAGE_BUDGET; page += 1) {
      const list = this.#store.listSessionEvents({
        sessionId: session.id,
        afterSequence: cursor,
        limit: SESSION_EVENT_PAGE_LIMIT,
      });
      if (list.events.length === 0) {
        exhausted = true;
        break;
      }
      events.push(...list.events);
      cursor = list.events[list.events.length - 1]?.sequence ?? cursor;
      if (page === TRANSCRIPT_EVENT_PAGE_BUDGET - 1) break;
    }
    const transcript = buildSessionTranscript({ sessionId: session.id, events, limit });
    const nextSequence = transcript.nextSequence !== null
      ? transcript.nextSequence
      : exhausted || transcript.throughSequence === null
        ? null
        : transcript.throughSequence + 1;
    return sessionTranscriptSchema.parse({ ...transcript, nextSequence });
  }

  /**
   * Move one live conversation from its current provider to another one.
   *
   * What this does, in order: refuse an unsafe or impossible switch, build the
   * neutral transcript and render the bounded handoff seed, fence both runtime
   * authorities with immutable evidence, start and receipt the target, persist
   * the seed intent and result around its one provider effect, release and
   * receipt the source, then atomically rebind the session and append the
   * switch boundary plus seed event.
   *
   * What it cannot do is carry the provider's own state across. The target
   * gets HRA's record of the conversation, not the source provider's thread,
   * hidden reasoning, or cached context — `docs/providers/portability.md`
   * states that boundary.
   */
  #settledProviderSwitchReplay(
    command: Extract<LocalCommand, { kind: "session.switch" }>,
  ): Readonly<{ matched: false } | { matched: true; value: unknown }> {
    if (command.idempotencyKey === undefined) return { matched: false };
    const prior = this.#store.readMutation(command.idempotencyKey);
    if (prior === null || (prior.state !== "applied" && prior.state !== "reconciled")) {
      return { matched: false };
    }
    const session = this.#store.requireSession(command.session);
    if (prior.kind !== "session.switch" || prior.authorityId !== session.id) {
      throw new CommandFailure(
        "CONFLICT",
        "That idempotency key belongs to a different mutation authority.",
        { idempotencyKey: command.idempotencyKey },
      );
    }
    if (prior.result === undefined) {
      throw new CommandFailure(
        "CONFLICT",
        "That provider switch was explicitly resolved without a replayable result.",
        { idempotencyKey: command.idempotencyKey },
      );
    }
    const receipt = sessionProviderSwitchDurableReceiptSchema.parse(prior.result);
    const requestedAccountId = command.account === undefined
      ? null
      : command.account === receipt.request.accountId
        ? receipt.request.accountId
        : this.#store.requireProfile(command.account).id;
    if (
      receipt.request.provider !== command.provider
      || receipt.request.accountId !== requestedAccountId
      || receipt.request.preset !== (command.preset ?? null)
    ) {
      throw new CommandFailure(
        "CONFLICT",
        "That idempotency key names a different provider-switch request.",
        { idempotencyKey: command.idempotencyKey },
      );
    }
    return {
      matched: true,
      value: {
        session: receipt.session,
        from: receipt.from,
        to: receipt.to,
        seed: { delivered: true, ...receipt.seed },
        transcriptDigest: receipt.transcriptDigest,
        turnId: receipt.turnId,
        idempotencyKey: command.idempotencyKey,
      },
    };
  }

  async #switchProvider(
    command: Extract<LocalCommand, { kind: "session.switch" }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const replay = this.#settledProviderSwitchReplay(command);
    if (replay.matched) return replay.value;
    const knownSession = this.#store.requireSession(command.session);
    const key = command.idempotencyKey ?? randomUUID();
    const responseFromReceipt = (
      receipt: z.infer<typeof sessionSwitchReceiptSchema>,
      sessionSnapshot: z.infer<typeof sessionProviderSwitchDurableReceiptSchema>["session"]
        = sessionProviderSwitchSnapshotSchema.parse(this.#store.requireSession(receipt.sessionId)),
    ): unknown => ({
      session: sessionSnapshot,
      from: receipt.from,
      to: receipt.to,
      seed: { delivered: true, ...receipt.seed },
      transcriptDigest: receipt.transcriptDigest,
      turnId: receipt.turnId,
      idempotencyKey: key,
    });
    const prior = command.idempotencyKey === undefined
      ? null
      : this.#store.readMutation(command.idempotencyKey);
    if (command.idempotencyKey !== undefined) {
      if (prior !== null) {
        if (prior.kind !== "session.switch" || prior.authorityId !== knownSession.id) {
          throw new CommandFailure(
            "CONFLICT",
            "That idempotency key belongs to a different mutation authority.",
            { idempotencyKey: command.idempotencyKey },
          );
        }
        if (prior.state === "effect_started" || prior.state === "ambiguous") {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "session.switch has an indeterminate earlier attempt and will not be replayed.",
            { idempotencyKey: command.idempotencyKey },
          );
        }
        if (prior.state === "applied" || prior.state === "reconciled") {
          if (prior.result === undefined) {
            throw new CommandFailure(
              "CONFLICT",
              "That provider switch was explicitly resolved without a replayable result.",
              { idempotencyKey: command.idempotencyKey },
            );
          }
          const receipt = sessionProviderSwitchDurableReceiptSchema.parse(prior.result);
          const replayAccountId = command.account === undefined
            ? null
            : command.account === receipt.request.accountId
              ? receipt.request.accountId
              : this.#store.requireProfile(command.account).id;
          if (
            receipt.request.provider !== command.provider
            || receipt.request.accountId !== replayAccountId
            || receipt.request.preset !== (command.preset ?? null)
          ) {
            throw new CommandFailure(
              "CONFLICT",
              "That idempotency key names a different provider-switch request.",
              { idempotencyKey: command.idempotencyKey },
            );
          }
          return responseFromReceipt(receipt, receipt.session);
        }
        if (prior.state !== "prepared") {
          throw new CommandFailure(
            "CONFLICT",
            `session.switch already reached ${prior.state}.`,
            { idempotencyKey: command.idempotencyKey },
          );
        }
      }
    }
    const session = this.#requireBoundSession(knownSession.id);
    if (this.#store.readClaudeProcessLaunchIntentForSession(session.id) !== null) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "This session has an unsettled Claude controller launch. HRA preserved the current provider binding and will not launch another target until restart recovery proves the prior child is gone.",
      );
    }
    const requestedAccountId = command.account === undefined
      ? null
      : this.#store.requireProfile(command.account).id;
    const currentProfile = this.#store.requireProfile(session.profileId);
    const targetProfile = requestedAccountId === null
      ? currentProfile
      : this.#store.requireProfileById(requestedAccountId);
    this.#assertEstablishedSessionAccount(currentProfile, session);
    const providerAuthentication = await this.#assertProviderSignedIn(
      targetProfile,
      command.provider,
      signal,
    );
    if (
      session.provider === command.provider
      && targetProfile.id === currentProfile.id
      && (command.preset === undefined || command.preset === session.preset)
    ) {
      throw new CommandFailure(
        "INVALID_INPUT",
        `That session already runs on ${command.provider} with the \`${session.preset}\` preset.`,
      );
    }
    // A switch mid-turn would strand the running turn on the outgoing
    // provider with no way to attribute its result.
    if (session.state === "active" || session.activeTurnId !== undefined) {
      throw new CommandFailure(
        "CONFLICT",
        "That session has an active turn. Stop it with `hra session stop` before switching provider.",
      );
    }
    if (session.state === "recovery_required" || session.state === "terminal") {
      throw new CommandFailure(
        "CONFLICT",
        `A ${session.state === "terminal" ? "terminal" : "quarantined"} session cannot switch provider.`,
      );
    }
    const preset = command.preset ?? defaultPresetForProviderSwitch(command.provider, session.preset);
    if (!isPresetSupportedByProvider(command.provider, preset)) {
      throw new CommandFailure(
        "INVALID_INPUT",
        new PresetProviderMismatchError(command.provider, preset).message,
      );
    }
    const project = session.projectId === undefined
      ? undefined
      : this.#store.requireProject(session.projectId);
    const projectRoot = project === undefined
      ? undefined
      : await this.#requireUsableProjectRoot(project.rootPath);

    const transcript = this.#readTranscript(session.id, undefined, TRANSCRIPT_PAGE_LIMIT);
    const seed = renderTranscriptSeed({
      transcript,
      fromProvider: session.provider,
      toProvider: command.provider,
    });

    const runtime = this.#sessionRuntime(command.provider);
    const fromProvider = session.provider;
    const fromPreset = session.preset;
    let sessionReview: RuntimeStartReviewOf<ReviewedRuntimeProfile> | undefined;
    let seedReview: RuntimeStartReviewOf<ReviewedRuntimeProfile> | undefined;
    let switchAttemptId: MutationAttemptRecord["id"] | undefined;
    let started:
      | (CodexSessionProjection & { effectiveRuntimeProfile: ReviewedRuntimeProfile })
      | undefined;
    let targetClaudeProcessIdentity: ClaudeProcessIdentity | undefined;
    let targetClaudeLaunchIntent: ClaudeProcessLaunchIntentRecord | undefined;
    let targetProviderAccountKey: string | undefined;
    const reservedTargetClaudeProviderThreadId = command.provider === "claude"
      ? randomUUID()
      : undefined;
    let targetProviderReleaseProven = false;
    let targetReleaseRecorded = false;
    let seeded:
      | Readonly<{
          turnId: string;
          status: "completed" | "interrupted" | "failed" | "inProgress";
          effectiveRuntimeProfile: ReviewedRuntimeProfile;
        }>
      | undefined;
    const requireTargetProviderAccountKey = (): string => {
      if (targetProviderAccountKey !== undefined) return targetProviderAccountKey;
      throw new Error("Provider switch lost its exact target account authority.");
    };
    const assertTargetAccountStable = async (
      accountSignal: AbortSignal = signal,
    ): Promise<void> => {
      const expectedTargetProviderAccountKey = requireTargetProviderAccountKey();
      const exactProfile = this.#store.requireProfileById(targetProfile.id);
      const observedAccountKey = await this.#assertProviderRuntimeAccountAuthority(
        exactProfile,
        command.provider,
        "managed",
        accountSignal,
        true,
      );
      if (observedAccountKey === expectedTargetProviderAccountKey) return;
      if (command.provider === "codex") {
        this.#scheduleProfilePersonalAuthorityRevocation(exactProfile);
      } else {
        this.#scheduleProviderRuntimeAccountRevocation(
          exactProfile,
          command.provider,
          "managed",
          observedAccountKey,
        );
      }
      throw new ProviderAccountAuthorityMismatchError(
        command.provider,
        "managed",
        exactProfile,
      );
    };
    const endStartedTargetExactly = async (
      providerThreadId: string,
      cleanupSignal: AbortSignal,
    ): Promise<void> => {
      await assertTargetAccountStable(cleanupSignal);
      let effectFailure: Readonly<{ error: unknown }> | undefined;
      try {
        await this.#fencedEffect(async () => await runtime.endSession({
          authority: authorityFor(this.#paths, targetProfile),
          providerThreadId,
          signal: cleanupSignal,
        }));
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        effectFailure = { error };
      }
      try {
        await assertTargetAccountStable(cleanupSignal);
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        throw new IndeterminateLocalCommitError(
          "The target account changed while an exact provider-switch cleanup was in flight.",
          error,
        );
      }
      if (effectFailure !== undefined) throw effectFailure.error;
    };
    const releaseExactClaudeTarget = async (
      providerThreadId: string,
      cleanupSignal: AbortSignal,
      accountMismatch: boolean,
    ): Promise<void> => {
      if (accountMismatch) {
        await this.#releaseClaudeProcessAuthority({
          providerThreadId,
          profileId: targetProfile.id,
          runtimeScope: "managed",
        }, cleanupSignal);
        return;
      }
      await assertTargetAccountStable(cleanupSignal);
      let effectFailure: Readonly<{ error: unknown }> | undefined;
      try {
        await this.#releaseClaudeProcessAuthority({
          providerThreadId,
          profileId: targetProfile.id,
          runtimeScope: "managed",
        }, cleanupSignal);
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        effectFailure = { error };
      }
      try {
        await assertTargetAccountStable(cleanupSignal);
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        throw new IndeterminateLocalCommitError(
          "The target account changed while its exact Claude process was being released.",
          error,
        );
      }
      if (effectFailure !== undefined) throw effectFailure.error;
    };
    const releaseStartedTarget = async (
      cleanupSignal: AbortSignal,
      accountMismatch = false,
    ): Promise<void> => {
      const target = started;
      if (targetReleaseRecorded) return;
      if (target === undefined && targetClaudeLaunchIntent === undefined) {
        if (accountMismatch && command.provider === "codex") {
          if (this.#codex.releaseOwnedAuthority === undefined) {
            throw new ProviderRuntimeUnavailableError(
              "The target Codex controller cannot release its exact account authority.",
            );
          }
          await this.#fencedEffect(async () => await this.#codex.releaseOwnedAuthority?.({
            authority: authorityFor(this.#paths, targetProfile),
            signal: cleanupSignal,
          }));
          targetProviderReleaseProven = true;
        }
        return;
      }
      const providerThreadId = command.provider === "claude"
        ? reservedTargetClaudeProviderThreadId
        : target?.providerThreadId;
      if (providerThreadId === undefined) return;
      if (!targetProviderReleaseProven) {
        if (command.provider === "claude") {
          if (targetClaudeProcessIdentity !== undefined) {
            await releaseExactClaudeTarget(
              providerThreadId,
              cleanupSignal,
              accountMismatch,
            );
          } else if (target !== undefined) {
            throw new ProviderRuntimeUnavailableError(
              "The Claude target started without exact process identity; HRA preserved its launch fence for restart recovery.",
            );
          } else if (accountMismatch) {
            throw new ProviderRuntimeUnavailableError(
              "The Claude target account changed before exact process identity was admitted; HRA preserved its launch fence for restart recovery.",
            );
          }
          if (targetClaudeLaunchIntent !== undefined) {
            this.#cancelClaudeProcessLaunchIntent(targetClaudeLaunchIntent);
          }
        } else {
          if (target === undefined) return;
          if (accountMismatch) {
            if (this.#codex.releaseOwnedAuthority === undefined) {
              throw new ProviderRuntimeUnavailableError(
                "The target Codex controller cannot release its exact account authority.",
              );
            }
            await this.#fencedEffect(async () => await this.#codex.releaseOwnedAuthority?.({
              authority: authorityFor(this.#paths, targetProfile),
              signal: cleanupSignal,
            }));
          } else {
            await endStartedTargetExactly(providerThreadId, cleanupSignal);
          }
        }
        targetProviderReleaseProven = true;
      }
      this.#store.recordSessionProviderSwitchTargetReleased({
        attemptId: attemptIdSchema.parse(switchAttemptId),
        sessionId: session.id,
        providerThreadId,
        providerAccountKey: requireTargetProviderAccountKey(),
      });
      targetReleaseRecorded = true;
    };
    let outcome: z.infer<typeof sessionSwitchReceiptSchema>;
    try {
      outcome = await this.#effect<z.infer<typeof sessionSwitchReceiptSchema>>({
        kind: "session.switch",
        authorityId: session.id,
        authorityGeneration: targetProfile.processGeneration,
        request: {
          provider: command.provider,
          preset,
          targetProfileId: targetProfile.id,
          seedDigest: seed.digest,
        },
        idempotencyKey: key,
        beginEffect: async (attemptId) => {
          switchAttemptId = attemptId;
          targetProviderAccountKey = await this.#assertProviderRuntimeAccountAuthority(
            targetProfile,
            command.provider,
            "managed",
            signal,
            true,
          );
          sessionReview = await this.#fencedRuntimeReview(
            runtime,
            async () => await runtime.reviewSessionStart({
              authority: authorityFor(this.#paths, targetProfile),
              ...(projectRoot === undefined ? {} : { projectRoot }),
              preset,
              fast: session.fastEnabled,
              signal,
            }),
          );
          await assertTargetAccountStable();
          this.#store.beginSessionProviderSwitchEffect({
            attemptId,
            sessionId: session.id,
            providerAuthentication,
            evidence: {
              kind: "session.switch",
              daemonGeneration: this.#daemonGeneration,
              requestedAccountId,
              requestedPreset: command.preset ?? null,
              sourceProfileId: currentProfile.id,
              sourceProcessGeneration: currentProfile.processGeneration,
              sourceProvider: session.provider,
              sourceProviderThreadId: session.providerThreadId,
              sourcePreset: session.preset,
              targetProfileId: targetProfile.id,
              targetProcessGeneration: targetProfile.processGeneration,
              targetProvider: command.provider,
              targetProviderAccountKey: requireTargetProviderAccountKey(),
              targetPreset: preset,
              transcriptDigest: transcript.digest,
              seedDigest: seed.digest,
              seedIncludedRecords: seed.includedRecords,
              seedOmittedRecords: seed.omittedRecords,
              runtimeProfile: sessionReview.effectiveRuntimeProfile,
            },
          });
        },
        effect: async (attemptId) => {
          if (sessionReview === undefined || targetProviderAccountKey === undefined) {
            throw new Error("Provider switch lost its reviewed target runtime or exact account authority.");
          }
          const targetSessionReview = sessionReview;
          const launchProviderThreadId = command.provider === "claude"
            ? reservedTargetClaudeProviderThreadId
            : undefined;
          if (command.provider === "claude") {
            if (launchProviderThreadId === undefined) {
              throw new Error("CLAUDE_PROVIDER_THREAD_ID_NOT_RESERVED");
            }
            targetClaudeLaunchIntent = this.#store.stageClaudeProcessLaunchIntent({
              providerThreadId: launchProviderThreadId,
              profileId: targetProfile.id,
              profileGeneration: targetProfile.processGeneration,
              runtimeScope: "managed",
              providerAccountKey: requireTargetProviderAccountKey(),
              sessionId: session.id,
            });
          }
          await assertTargetAccountStable();
          let startFailure: Readonly<{ error: unknown }> | undefined;
          try {
            started = await this.#fencedEffect(async () => await runtime.startSession({
              authority: authorityFor(this.#paths, targetProfile),
              ...(launchProviderThreadId === undefined
                ? {}
                : {
                    providerThreadId: launchProviderThreadId,
                    admitProcessIdentity: async (identity: ClaudeProcessIdentity) => {
                      if (targetClaudeLaunchIntent === undefined) {
                        throw new Error("CLAUDE_PROCESS_LAUNCH_INTENT_MISSING");
                      }
                      targetClaudeProcessIdentity = await this.#recordClaimedClaudeProcess({
                        authority: authorityFor(this.#paths, targetProfile),
                        providerThreadId: launchProviderThreadId,
                        runtimeScope: "managed",
                        sessionId: session.id,
                        launchIntent: targetClaudeLaunchIntent,
                        identity,
                        signal,
                      });
                    },
                  }),
              ...(projectRoot === undefined ? {} : { projectRoot }),
              review: targetSessionReview,
              signal,
            }));
          } catch (error: unknown) {
            if (error instanceof DaemonAuthoritySafetyError) throw error;
            startFailure = { error };
          }
          let postStartAccountFailure: Readonly<{ error: unknown }> | undefined;
          try {
            await assertTargetAccountStable();
          } catch (error: unknown) {
            if (error instanceof DaemonAuthoritySafetyError) throw error;
            postStartAccountFailure = { error };
          }
          if (postStartAccountFailure !== undefined) {
            try {
              await releaseStartedTarget(new AbortController().signal, true);
            } catch (cleanupError: unknown) {
              if (cleanupError instanceof DaemonAuthoritySafetyError) throw cleanupError;
              this.#quarantineSession(session.id);
              throw new IndeterminateLocalCommitError(
                "The target account changed during provider start and its exact controller could not be safely released.",
                new AggregateError([postStartAccountFailure.error, cleanupError]),
              );
            }
            throw new IndeterminateLocalCommitError(
              "The provider-switch target start crossed an account-authority change.",
              startFailure === undefined
                ? postStartAccountFailure.error
                : new AggregateError([
                    startFailure.error,
                    postStartAccountFailure.error,
                  ]),
            );
          }
          if (startFailure !== undefined) {
            if (startFailure.error instanceof ClaudeProcessExitUnprovenError) {
              throw new CommandFailure(
                "RECOVERY_REQUIRED",
                "Claude target admission failed without proof that its controller exited. HRA preserved the source session and fenced this target launch until restart recovery proves the child is gone.",
              );
            }
            try {
              await releaseStartedTarget(new AbortController().signal);
            } catch (cleanupError: unknown) {
              if (cleanupError instanceof DaemonAuthoritySafetyError) throw cleanupError;
              this.#quarantineSession(session.id);
              throw new IndeterminateLocalCommitError(
                "The target provider start failed and its exact cleanup did not settle.",
                new AggregateError([startFailure.error, cleanupError]),
              );
            }
            throw startFailure.error;
          }
          if (started === undefined) throw new Error("PROVIDER_SWITCH_TARGET_START_MISSING");
          if (
            command.provider === "claude"
            && (
              started.providerThreadId !== reservedTargetClaudeProviderThreadId
              || targetClaudeProcessIdentity === undefined
            )
          ) {
            const admissionError = new Error("CLAUDE_PROCESS_IDENTITY_NOT_ADMITTED");
            try {
              await releaseStartedTarget(new AbortController().signal);
            } catch (cleanupError: unknown) {
              if (cleanupError instanceof DaemonAuthoritySafetyError) throw cleanupError;
              this.#quarantineSession(session.id);
              throw new IndeterminateLocalCommitError(
                "The Claude target returned without matching its reserved exact-process custody, and safe cleanup did not settle.",
                new AggregateError([admissionError, cleanupError]),
              );
            }
            throw admissionError;
          }
          const startedTarget = started;
          if (
            targetProfile.id === currentProfile.id
            && command.provider === session.provider
            && startedTarget.providerThreadId === session.providerThreadId
          ) {
            this.#quarantineSession(session.id);
            throw new IndeterminateLocalCommitError(
              "The provider-switch target aliased the exact source thread. HRA left that thread untouched and quarantined the local session.",
              new Error("PROVIDER_SWITCH_TARGET_ALIASED_SOURCE"),
            );
          }
          try {
            this.#store.recordSessionProviderSwitchTarget({
              attemptId,
              sessionId: session.id,
              providerThreadId: startedTarget.providerThreadId,
            });
          } catch (recordError: unknown) {
            try {
              await releaseStartedTarget(new AbortController().signal);
            } catch (cleanupError: unknown) {
              if (cleanupError instanceof DaemonAuthoritySafetyError) throw cleanupError;
              this.#quarantineSession(session.id);
              throw new IndeterminateLocalCommitError(
                "The target provider started, but neither its exact binding nor its cleanup could be durably proven.",
                new AggregateError([recordError, cleanupError]),
              );
            }
            throw recordError;
          }
          try {
            await assertTargetAccountStable();
          } catch (accountError: unknown) {
            if (accountError instanceof DaemonAuthoritySafetyError) throw accountError;
            try {
              await releaseStartedTarget(new AbortController().signal, true);
            } catch (cleanupError: unknown) {
              if (cleanupError instanceof DaemonAuthoritySafetyError) throw cleanupError;
              throw new IndeterminateLocalCommitError(
                "The target account changed and its exact controller could not be safely released.",
                new AggregateError([accountError, cleanupError]),
              );
            }
            throw accountError;
          }
          try {
            seedReview = await this.#fencedRuntimeReview(
              runtime,
              async () => await runtime.reviewTurnStart({
                authority: authorityFor(this.#paths, targetProfile),
                providerThreadId: startedTarget.providerThreadId,
                ...(projectRoot === undefined ? {} : { projectRoot }),
                preset,
                fast: session.fastEnabled,
                signal,
              }),
            );
            await assertTargetAccountStable();
            const targetSeedReview = seedReview;
            this.#store.recordSessionProviderSwitchSeedIntent({
              attemptId,
              sessionId: session.id,
              providerThreadId: startedTarget.providerThreadId,
              seedText: seed.text,
              runtimeProfile: targetSeedReview.effectiveRuntimeProfile,
            });
            seeded = await this.#fencedEffect(async () => await runtime.startTurn({
              authority: authorityFor(this.#paths, targetProfile),
              providerThreadId: startedTarget.providerThreadId,
              ...(projectRoot === undefined ? {} : { projectRoot }),
              review: targetSeedReview,
              message: seed.text,
              clientMessageId: attemptId,
              signal,
            }));
            await assertTargetAccountStable();
            this.#store.recordSessionProviderSwitchSeedResult({
              attemptId,
              sessionId: session.id,
              providerThreadId: startedTarget.providerThreadId,
              runtimeProfile: seeded.effectiveRuntimeProfile,
              turnId: seeded.turnId,
              turnStatus: seeded.status,
            });
          } catch (seedError: unknown) {
            if (seedError instanceof DaemonAuthoritySafetyError) throw seedError;
            try {
              await releaseStartedTarget(
                new AbortController().signal,
                seedError instanceof ProviderAccountAuthorityMismatchError,
              );
            } catch (cleanupError: unknown) {
              if (cleanupError instanceof DaemonAuthoritySafetyError) throw cleanupError;
              this.#quarantineSession(session.id);
              throw new IndeterminateLocalCommitError(
                "The target seed did not settle and the target provider could not be safely cleaned up.",
                new AggregateError([seedError, cleanupError]),
              );
            }
            if (seedError instanceof IndeterminateCodexEffectError) {
              throw new CommandFailure(
                "UNAVAILABLE",
                "The target seed did not settle, but the target was released and the source session remains unchanged.",
              );
            }
            throw seedError;
          }
          try {
            await this.#endProviderSession(session, currentProfile, signal);
          } catch (sourceError: unknown) {
            if (sourceError instanceof DaemonAuthoritySafetyError) throw sourceError;
            this.#quarantineSession(session.id);
            throw new IndeterminateLocalCommitError(
              "The source provider release did not settle; the seeded target was left intact for recovery.",
              sourceError,
            );
          }
          try {
            this.#store.recordSessionProviderSwitchSourceReleased({
              attemptId,
              sessionId: session.id,
            });
          } catch (recordError: unknown) {
            try {
              const current = this.#store.requireSession(session.id);
              this.#store.bindSessionProviderSwitchRecoveryTarget({
                attemptId,
                sessionId: session.id,
                expectedSessionRevision: current.revision,
                providerAccountKey: requireTargetProviderAccountKey(),
                title: startedTarget.title,
                ...(startedTarget.providerUpdatedAt === undefined
                  ? {}
                  : { providerUpdatedAt: startedTarget.providerUpdatedAt }),
                recordSourceReleased: true,
              });
            } catch (fallbackError: unknown) {
              this.#quarantineSession(session.id);
              throw new IndeterminateLocalCommitError(
                "The source provider was released, but its receipt and target recovery binding could not be committed.",
                new AggregateError([recordError, fallbackError]),
              );
            }
            throw new IndeterminateLocalCommitError(
              "The source was released and the seeded target was durably bound for recovery, but the final receipt did not commit.",
              recordError,
            );
          }
          try {
            await assertTargetAccountStable();
          } catch (accountError: unknown) {
            if (accountError instanceof DaemonAuthoritySafetyError) throw accountError;
            try {
              await releaseStartedTarget(new AbortController().signal, true);
            } catch (cleanupError: unknown) {
              if (cleanupError instanceof DaemonAuthoritySafetyError) throw cleanupError;
              this.recordBackgroundDiagnostic(
                "provider_switch_target_release_failed",
                cleanupError,
              );
            }
            throw new IndeterminateLocalCommitError(
              "The target account changed after the source controller was released.",
              accountError,
            );
          }
          return {
            from: { provider: fromProvider, preset: fromPreset, account: currentProfile.id },
            providerThreadId: started.providerThreadId,
            request: {
              accountId: requestedAccountId,
              preset: command.preset ?? null,
              provider: command.provider,
            },
            seed: {
              digest: seed.digest,
              includedRecords: seed.includedRecords,
              omittedRecords: seed.omittedRecords,
              status: seeded.status,
            },
            sessionId: session.id,
            to: { provider: command.provider, preset, account: targetProfile.id },
            transcriptDigest: transcript.digest,
            turnId: seeded.turnId,
          };
        },
        receipt: (value) => sessionSwitchReceiptSchema.parse(value),
        restore: (value) => sessionSwitchReceiptSchema.parse(value),
        commit: async (attemptId, result, receipt) => {
          if (
            started === undefined
            || seeded === undefined
            || targetProviderAccountKey === undefined
          ) {
            throw new Error("Provider switch commit lost its exact provider projection, seed result, or account authority.");
          }
          try {
            await assertTargetAccountStable();
          } catch (accountError: unknown) {
            if (accountError instanceof DaemonAuthoritySafetyError) throw accountError;
            try {
              await releaseStartedTarget(new AbortController().signal, true);
            } catch (cleanupError: unknown) {
              if (cleanupError instanceof DaemonAuthoritySafetyError) throw cleanupError;
              this.recordBackgroundDiagnostic(
                "provider_switch_target_release_failed",
                cleanupError,
              );
            }
            throw accountError;
          }
          const committedTargetAccountKey = targetProviderAccountKey;
          const current = this.#store.requireSession(session.id);
          const state = seeded.status === "inProgress" ? "active" : "idle";
          this.#store.completeSessionProviderSwitch({
            attemptId,
            sessionId: current.id,
            expectedSessionRevision: current.revision,
            expectedTargetProfileGeneration: targetProfile.processGeneration,
            provider: command.provider,
            profileId: targetProfile.id,
            preset,
            providerThreadId: started.providerThreadId,
            state,
            ...(state === "active" ? { activeTurnId: seeded.turnId } : {}),
            ...(started.providerUpdatedAt === undefined
              ? {}
              : { providerUpdatedAt: started.providerUpdatedAt }),
            runtimeProfile: started.effectiveRuntimeProfile,
            providerAccountKey: committedTargetAccountKey,
            ...(targetClaudeProcessIdentity === undefined
              ? {}
              : { claudeProcessIdentity: targetClaudeProcessIdentity }),
            seedTurnId: seeded.turnId,
            receipt: sessionSwitchReceiptSchema.parse(receipt ?? result),
          });
        },
        onAmbiguous: () => {
          if (switchAttemptId !== undefined) {
            const mutation = this.#store.readMutation(switchAttemptId);
            if (mutation?.state === "applied" || mutation?.state === "reconciled") return;
          }
          const current = this.#store.requireSession(session.id);
          if (
            started !== undefined
            && switchAttemptId !== undefined
            && current.profileId === currentProfile.id
            && current.provider === session.provider
            && current.providerThreadId === session.providerThreadId
          ) {
            const progress = this.#store.readSessionProviderSwitchProgress(switchAttemptId);
            if (
              progress.sourceReleased
              && !progress.targetReleased
              && progress.seedTurnId !== undefined
            ) {
              this.#store.bindSessionProviderSwitchRecoveryTarget({
                attemptId: switchAttemptId,
                sessionId: session.id,
                expectedSessionRevision: current.revision,
                providerAccountKey: requireTargetProviderAccountKey(),
                title: started.title,
                ...(started.providerUpdatedAt === undefined
                  ? {}
                  : { providerUpdatedAt: started.providerUpdatedAt }),
              });
              return;
            }
          }
          this.#quarantineSession(session.id);
        },
      });
    } finally {
      if (sessionReview !== undefined) runtime.discardRuntimeReview(sessionReview);
      if (seedReview !== undefined) runtime.discardRuntimeReview(seedReview);
    }

    const switched = this.#store.requireSession(outcome.sessionId);
    await this.#ensureSessionObservedLocked(switched.id, signal);
    return responseFromReceipt(outcome);
  }

  /**
   * Release the outgoing provider's hold on a session's thread and close
   * HRA's live view of it. The thread itself is never deleted.
   */
  async #endProviderSession(
    session: SessionRecord & { providerThreadId: string },
    profile: ProfileRecord,
    signal: AbortSignal,
    reason = "provider switch",
  ): Promise<void> {
    this.#assertEstablishedSessionAccount(profile, session);
    await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
    if (session.provider === "claude") {
      await this.#releaseClaudeProcessAuthority({
        providerThreadId: session.providerThreadId,
        profileId: session.profileId,
        runtimeScope: this.#sessionHasActivePersonalBinding(session) ? "personal" : "managed",
      }, signal);
    } else {
      await this.#fencedEffect(async () => await this.#runtimeForSession(session).endSession({
          authority: this.#authorityForSession(session, profile),
          providerThreadId: session.providerThreadId,
          signal,
        }));
    }
    await this.#assertSessionAccountAuthorityAfterProviderEffect(session, profile, signal);
    const connectionId = this.#sessionProviderConnections.get(session.id) ?? null;
    this.#persistSessionEventWrites(this.#eventRedactor.interruptSession({
      accountId: profile.id,
      providerConnectionId: connectionId,
      providerGeneration: profile.processGeneration,
      sessionId: session.id,
    }));
    this.#appendSessionEvent(authorityFor(this.#paths, profile), session.id, connectionId, {
      type: "connection",
      state: "disconnected",
      reason,
    });
    this.#sessionProviderConnections.delete(session.id);
    this.#clearSessionFactAuthority(session.id);
    this.#sessionObservationFailures.delete(session.id);
    this.#sessionResubscriptionConnections.delete(session.id);
    this.#sessionsAwaitingResubscription.delete(session.id);
    this.#forgetSessionFactEpoch(session.id);
  }

  /*
   * Local attachment custody for one message.
   *
   * The command carries digests, never paths and never bytes. This reads the
   * bytes back from the content-addressed store, re-proves each digest, and
   * re-runs the same admission the ingest path ran. An attachment that is not
   * in custody on this machine, or whose bytes no longer match what its
   * reference claims, refuses the whole command before any provider effect.
   */
  #blobs(): AttachmentBlobStore {
    this.#attachmentBlobs ??= AttachmentBlobStore.forStatePaths(this.#paths);
    return this.#attachmentBlobs;
  }

  /*
   * Bounded attachment custody maintenance. It runs only after a message that
   * actually carried attachments, so a text-only daemon never pays for it.
   *
   * First it drops accounting rows that no message references any more — a
   * session was deleted, or the per-session manifest cap pruned the oldest
   * source — and removes their blobs. Then it removes blob files that local
   * custody does not account for at all, which is how a blob written for a
   * command that never reached the daemon is reclaimed. Blobs younger than
   * the grace window are never touched, so an in-flight command is safe.
   */
  async #sweepAttachmentCustody(active: boolean): Promise<void> {
    if (!active) return;
    try {
      const blobs = this.#blobs();
      for (const row of this.#store.listUnreferencedAttachments(64)) {
        await blobs.remove(row.digest, row.canonicalMediaType);
        this.#store.forgetAttachment(row.digest);
      }
      await blobs.sweepUnaccounted(
        this.#store.accountedAttachmentDigests(),
        ATTACHMENT_BLOB_SWEEP_GRACE_MS,
        Date.now(),
      );
    } catch (error: unknown) {
      this.recordBackgroundDiagnostic("attachment_sweep_failed", error);
    }
  }

  async #prepareAttachments(
    references: readonly AttachmentReference[],
  ): Promise<Readonly<{ stored: readonly StoredMessageAttachment[]; values: readonly PreparedAttachment[] }>> {
    if (references.length === 0) return { stored: [], values: [] };
    const resolved = await resolveMessageAttachments(this.#blobs(), references);
    if (resolved.kind === "refused") throw new CommandFailure("INVALID_INPUT", resolved.message);
    return { stored: resolved.stored, values: resolved.values };
  }

  async #send(
    selector: string,
    message: string,
    idempotencyKey: string | undefined,
    signal: AbortSignal,
    beforeEffect?: (attemptId: MutationAttemptRecord["id"]) => void,
    actor: SessionMessageActor = "human",
    attachmentReferences: readonly AttachmentReference[] = [],
  ): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const attachments = await this.#prepareAttachments(attachmentReferences);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertEstablishedSessionAccount(profile, session);
    const project = session.projectId === undefined ? undefined : this.#store.requireProject(session.projectId);
    if (project !== undefined) await this.#requireUsableProjectRoot(project.rootPath);
    this.#requireLiveProviderObservation(
      await this.#ensureSessionObservedLocked(session.id, signal),
    );
    // A human-authored message is the only thing that resets the consecutive
    // autorespond counter for a session.
    if (actor === "human") this.#store.resetAutorespondCounter(session.id);
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    let review: RuntimeStartReviewOf<ReviewedRuntimeProfile> | undefined;
    let dispatchSessionRevision: number | undefined;
    let dispatchFactEpoch: number | undefined;
    let startedResult: { turnId: string; status: "completed" | "interrupted" | "failed" | "inProgress"; effectiveRuntimeProfile: ReviewedRuntimeProfile } | undefined;
    const result = await this.#effect<z.infer<typeof turnStartReceiptSchema>>({ kind: "session.send", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { message, ...(attachmentReferences.length === 0 ? {} : { attachments: attachmentReferences }) }, idempotencyKey: key, effect: async (attemptId) => {
      if (baseline === undefined || review === undefined) throw new Error("Session send lost its exact pre-effect provider baseline or runtime review.");
      const runtimeReview = review;
      if (baseline.status === "active" || baseline.activeTurnId !== undefined) throw new CommandFailure("CONFLICT", "The session already has an active turn. Use `session steer` or `session queue`.");
      const projectRoot = project === undefined
        ? undefined
        : await this.#requireUsableProjectRoot(project.rootPath);
      await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
      startedResult = await this.#fencedEffect(async () => {
        return await this.#runtimeForSession(session).startTurn({
          authority: this.#authorityForSession(session, profile),
          providerThreadId: session.providerThreadId,
          ...(projectRoot === undefined ? {} : { projectRoot }),
          review: runtimeReview,
          message,
          ...(attachments.values.length === 0 ? {} : { attachments: attachments.values }),
          clientMessageId: attemptId,
          signal,
        });
      });
      await this.#assertSessionAccountAuthorityAfterProviderEffect(
        session,
        profile,
        signal,
      );
      return { ...startedResult, sourceId: attemptId };
    }, beginEffect: async (attemptId) => {
      baseline = await this.#readExactSessionProjection(session, profile, false, signal);
      if (baseline.status === "active" || baseline.activeTurnId !== undefined) throw new CommandFailure("CONFLICT", "The session already has an active turn. Use `session steer` or `session queue`.");
      const projectRoot = project === undefined
        ? undefined
        : await this.#requireUsableProjectRoot(project.rootPath);
      await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
      review = await this.#fencedEffect(async () => {
        return await this.#runtimeForSession(session).reviewTurnStart({
          authority: this.#authorityForSession(session, profile),
          providerThreadId: session.providerThreadId,
          ...(projectRoot === undefined ? {} : { projectRoot }),
          preset: session.preset,
          fast: session.fastEnabled,
          signal,
        });
      });
      // Work authorization and nested begin are one synchronous fence boundary.
      beforeEffect?.(attemptId);
      // The compact projection reads this back to mark the resulting
      // `user_message` with `actor: "autorespond"`.
      if (actor === "autorespond") {
        this.#store.recordAutorespondMessageSource(session.id, attemptId);
      }
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
      if (attachments.stored.length > 0) {
        this.#store.recordMessageAttachments({
          attachments: attachments.stored,
          sessionId: session.id,
          sourceId: attemptId,
        });
      }
      dispatchSessionRevision = this.#store.requireSession(session.id).revision;
      dispatchFactEpoch = this.#snapshotSessionFactEpoch(session.id);
    }, receipt: (value) => turnStartReceiptSchema.parse(value), restore: (value) => turnStartReceiptSchema.parse(value), commit: (attemptId, _value, receipt) => {
      if (startedResult === undefined || dispatchSessionRevision === undefined || dispatchFactEpoch === undefined) throw new Error("Session turn commit lost its exact provider result, local revision, or fact epoch.");
      this.#store.completeSessionTurnEffect({
        attemptId,
        sessionId: session.id,
        expectedSessionRevision: dispatchSessionRevision,
        applyResponseState: this.#currentSessionFactEpoch(session.id) === dispatchFactEpoch,
        turnId: startedResult.turnId,
        turnStatus: startedResult.status,
        runtimeProfile: startedResult.effectiveRuntimeProfile,
        receipt,
      });
    }, onAmbiguous: () => this.#quarantineSession(session.id) });
    await this.#sweepAttachmentCustody(attachments.values.length > 0);
    const reconciled = this.#store.requireSession(session.id);
    this.#recordUserMessage(reconciled.id, profile, result.turnId, actor, message);
    if (reconciled.state === "idle") this.#scheduleQueueDispatch(reconciled);
    return {
      session: reconciled,
      turnId: result.turnId,
      effectiveRuntimeProfile: publicRuntimeProfile(result.effectiveRuntimeProfile),
      ...(attachments.values.length === 0
        ? {}
        : { attachments: attachments.values.map(attachmentReferenceOf) }),
      idempotencyKey: key,
    };
  }

  /**
   * Append the neutral record of one message HRA sent. It is written after the
   * provider accepted the message, so the transcript never claims HRA sent
   * something the provider rejected, and it carries the exact actor that
   * authored it. A failure here is a background diagnostic: an already
   * dispatched turn is never failed for a missing transcript record.
   */
  #recordUserMessage(
    sessionId: SessionRecord["id"],
    profile: ProfileRecord,
    turnId: string | null,
    actor: SessionMessageActor,
    message: string,
  ): void {
    try {
      const text = message.slice(0, SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS);
      this.#appendSessionEvent(
        authorityFor(this.#paths, profile),
        sessionId,
        this.#sessionProviderConnections.get(sessionId) ?? null,
        {
          type: "user_message",
          turnId,
          actor,
          text,
          omittedCharacters: message.length - text.length,
        },
      );
    } catch (error: unknown) {
      this.recordBackgroundDiagnostic("user_message_record_failed", error);
    }
  }

  async #steer(
    selector: string,
    message: string,
    idempotencyKey: string | undefined,
    signal: AbortSignal,
    beforeEffect?: (attemptId: MutationAttemptRecord["id"]) => void,
    attachmentReferences: readonly AttachmentReference[] = [],
  ): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const attachments = await this.#prepareAttachments(attachmentReferences);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertEstablishedSessionAccount(profile, session);
    this.#requireLiveProviderObservation(
      await this.#ensureSessionObservedLocked(session.id, signal),
    );
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    let activeTurnId: string | undefined;
    const result = await this.#effect({ kind: "session.steer", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { message, ...(attachmentReferences.length === 0 ? {} : { attachments: attachmentReferences }) }, idempotencyKey: key, effect: async (attemptId) => {
      if (activeTurnId === undefined) throw new CommandFailure("CONFLICT", "The session has no active turn to steer.");
      const turnId = activeTurnId;
      await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
      await this.#fencedEffect(async () => await this.#runtimeForSession(session).steer({ authority: this.#authorityForSession(session, profile), providerThreadId: session.providerThreadId, activeTurnId: turnId, message, ...(attachments.values.length === 0 ? {} : { attachments: attachments.values }), clientMessageId: attemptId, signal }));
      await this.#assertSessionAccountAuthorityAfterProviderEffect(session, profile, signal);
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
      if (attachments.stored.length > 0) {
        this.#store.recordMessageAttachments({
          attachments: attachments.stored,
          sessionId: session.id,
          sourceId: attemptId,
        });
      }
    }, receipt: (value) => steeredReceiptSchema.parse(value), restore: (value) => steeredReceiptSchema.parse(value), onAmbiguous: () => this.#quarantineSession(session.id) });
    this.#recordUserMessage(session.id, profile, result.activeTurnId, "human", message);
    await this.#sweepAttachmentCustody(attachments.values.length > 0);
    return {
      steered: true,
      turnId: result.activeTurnId,
      ...(attachments.values.length === 0
        ? {}
        : { attachments: attachments.values.map(attachmentReferenceOf) }),
      idempotencyKey: key,
    };
  }

  async #queue(
    selector: string,
    message: string,
    idempotencyKey: string | undefined,
    signal: AbortSignal,
    beforeEffect?: () => void,
    attachmentReferences: readonly AttachmentReference[] = [],
  ): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertEstablishedSessionAccount(profile, session);
    // Custody is proved before anything durable exists, so a queue entry never
    // outlives the attachments it references.
    const attachments = await this.#prepareAttachments(attachmentReferences);
    const key = idempotencyKey ?? randomUUID();
    await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
    // Work authorization and durable enqueue are one synchronous fence boundary.
    beforeEffect?.();
    const queued = this.#store.enqueueIdempotent({ sessionId: session.id, profileGeneration: profile.processGeneration, message, idempotencyKey: key });
    if (attachments.stored.length > 0) {
      this.#store.recordMessageAttachments({
        attachments: attachments.stored,
        sessionId: session.id,
        sourceId: queued.id,
      });
    }
    await this.#sweepAttachmentCustody(attachments.values.length > 0);
    const observed = this.#store.requireSession(session.id);
    if (queued.state === "pending" && observed.state === "idle") {
      this.#scheduleQueueDispatch(observed);
    }
    return {
      queued,
      ...(attachments.values.length === 0
        ? {}
        : { attachments: attachments.values.map(attachmentReferenceOf) }),
      idempotencyKey: key,
    };
  }

  #scheduleQueueDispatch(session: SessionRecord): void {
    if (this.#state !== "open") return;
    const profile = this.#store.requireProfile(session.profileId);
    if (!this.#profileAllowsEstablishedSession(profile, session)) return;
    const task = this.#serializeSessionAuthority(session, async () => this.#dispatchNextQueue(session.id, this.#authorityForSession(session, profile)));
    const tracked = task.then(
      () => undefined,
      (error: unknown) => this.recordBackgroundDiagnostic("queue_dispatch_failed", error),
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
        ).catch((error: unknown) => this.recordBackgroundDiagnostic("recovery_observation_failed", error));
      }
    })();
    const tracked = task.then(
      () => undefined,
      (error: unknown) => this.recordBackgroundDiagnostic("recovery_observation_failed", error),
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #scheduleIdleQueue(session: SessionRecord): void {
    if (session.state === "idle") this.#scheduleQueueDispatch(session);
  }

  #resumeSessionWorkAfterRecovery(session: SessionRecord): void {
    this.#scheduleIdleQueue(session);
    this.#wakeSessionTaskPump();
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
      if (!this.#profileAuthorityIsUsable(
        profile.id,
        profile.processGeneration,
        current.provider,
        current.id,
      )) return;
      await this.#serializeSessionAuthority(current, async () => this.#dispatchNextQueue(current.id, this.#authorityForSession(current, profile)));
      if (this.#store.requireQueue(queueId).state !== "pending") this.#queuePreEffectRetryCounts.delete(queueId);
    })();
    const tracked = task.then(
      () => undefined,
      (error: unknown) => this.recordBackgroundDiagnostic("queue_pre_effect_retry_failed", error),
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
    this.#assertEstablishedSessionAccount(profile, session);
    this.#requireLiveProviderObservation(
      await this.#ensureSessionObservedLocked(session.id, signal),
    );
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    let activeTurnId: string | null = null;
    const result = await this.#effect({ kind: "session.stop", authorityId: session.id, authorityGeneration: profile.processGeneration, request: {}, idempotencyKey: key, effect: async () => {
      if (activeTurnId === null) return { stopped: false as const, activeTurnId: null };
      const turnId = activeTurnId;
      await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
      await this.#fencedEffect(async () => await this.#runtimeForSession(session).interrupt({ authority: this.#authorityForSession(session, profile), providerThreadId: session.providerThreadId, activeTurnId: turnId, signal }));
      await this.#assertSessionAccountAuthorityAfterProviderEffect(session, profile, signal);
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
    this.#requireCodexSession(session, "renaming a provider thread");
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    const codex = this.#runtimeForSession(session) as CodexRuntimePort;
    await this.#effect({ kind: "session.rename", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { name }, idempotencyKey: key, effect: async () => { await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true); await this.#fencedEffect(async () => await codex.rename({ authority: this.#authorityForSession(session, profile), providerThreadId: session.providerThreadId, name, signal })); await this.#assertSessionAccountAuthorityAfterProviderEffect(session, profile, signal); return { renamed: true as const }; }, beginEffect: async (attemptId) => {
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
        await this.#reconcileCommittedSessionFactsMemory(resolved, "abandon");
        this.#resumeSessionWorkAfterRecovery(resolved);
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
      this.#assertEstablishedSessionAccount(profile, session);
      const projection = await this.#readExactSessionProjection({ ...session, providerThreadId: session.providerThreadId }, profile, false, signal);
      const resolved = this.#store.resolveSessionStatusRecovery({
        sessionId: session.id,
        expectedRevision: session.revision,
        resolution: "provider_state_reconciled",
        provider: {
          providerThreadId: projection.providerThreadId,
          title: session.provider === "claude" ? session.title : projection.title,
          status: projection.status,
          ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
          ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
        },
      });
      await this.#reconcileCommittedSessionFactsMemory(resolved);
      this.#resumeSessionWorkAfterRecovery(resolved);
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
    if (attempt.evidence.evidence.kind === "session.switch") {
      return await this.#resolveProviderSwitchRecovery(
        session,
        attempt,
        action,
        signal,
      );
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
      await this.#reconcileCommittedSessionFactsMemory(resolved, "abandon");
      this.#resumeSessionWorkAfterRecovery(resolved);
      return { session: resolved, idempotencyKey: attempt.idempotencyKey, recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false } };
    }

    const profile = this.#store.requireProfile(session.profileId);
    this.#assertEstablishedSessionAccount(profile, session);
    const authorityCurrent = attempt.evidence.evidence.kind === "session.start"
      ? this.#store.isSessionMutationProviderAuthorityCurrent({
          attemptId: attempt.id,
          profileId: profile.id,
          provider: session.provider,
          originGeneration: attempt.authorityGeneration,
        })
      : profile.processGeneration === attempt.authorityGeneration;
    if (!authorityCurrent) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The account generation changed after the uncertain session effect.");
    }
    const projection = await this.#readExactSessionProjection({ ...session, providerThreadId: session.providerThreadId }, profile, false, signal);
    const provider = {
      providerThreadId: projection.providerThreadId,
      title: session.provider === "claude" ? session.title : projection.title,
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
      await this.#reconcileCommittedSessionFactsMemory(resolved, "abandon");
      this.#resumeSessionWorkAfterRecovery(resolved);
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
    await this.#reconcileCommittedSessionFactsMemory(resolved);
      this.#resumeSessionWorkAfterRecovery(resolved);
    return { session: resolved, projection, idempotencyKey: attempt.idempotencyKey, recovery: { resolved: true, resolution: "proven_applied", providerEffectRetried: false } };
  }

  async #resolveProviderSwitchRecovery(
    session: SessionRecord,
    attempt: MutationAttemptRecord,
    action: "recover" | "abandon",
    signal: AbortSignal,
  ): Promise<unknown> {
    const evidenceRecord = attempt.evidence;
    if (evidenceRecord === undefined || evidenceRecord.evidence.kind !== "session.switch") {
      throw new CommandFailure("RECOVERY_REQUIRED", "The provider switch has no exact immutable recovery evidence.");
    }
    const evidence = evidenceRecord.evidence;
    const originalState = attempt.originalState ?? attempt.state;
    if (originalState !== "effect_started" && originalState !== "ambiguous") {
      throw new CommandFailure("CONFLICT", "The provider-switch authority is already settled.");
    }
    for (const authority of [
      {
        profileId: evidence.sourceProfileId,
        provider: evidence.sourceProvider,
        originGeneration: evidence.sourceProcessGeneration,
      },
      {
        profileId: evidence.targetProfileId,
        provider: evidence.targetProvider,
        originGeneration: evidence.targetProcessGeneration,
      },
    ] as const) {
      if (!this.#store.isSessionMutationProviderAuthorityCurrent({
        attemptId: attempt.id,
        ...authority,
      })) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "A provider authority changed without an exact switch-recovery successor receipt.",
        );
      }
    }
    const sourceProfile = this.#store.requireProfileById(evidence.sourceProfileId);
    const targetProfile = this.#store.requireProfileById(evidence.targetProfileId);
    let current = this.#store.requireSession(session.id);
    let progress = this.#store.readSessionProviderSwitchProgress(attempt.id);
    if (progress.targetProviderAccountKey !== evidence.targetProviderAccountKey) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The provider-switch target account authority no longer matches its immutable evidence.",
      );
    }
    const sourceBound = (): boolean =>
      current.profileId === evidence.sourceProfileId
      && current.provider === evidence.sourceProvider
      && current.providerThreadId === evidence.sourceProviderThreadId;
    const targetBound = (): boolean =>
      progress.targetProviderThreadId !== undefined
      && current.profileId === evidence.targetProfileId
      && current.provider === evidence.targetProvider
      && current.providerThreadId === progress.targetProviderThreadId;
    if (!sourceBound() && !targetBound()) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The session binding matches neither immutable side of the provider switch.",
      );
    }
    if (targetBound() && !progress.sourceReleased) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The target is locally bound without a durable source-release receipt.",
      );
    }
    const currentProviderAccountAuthority =
      this.#store.readSessionProviderAccountAuthority(session.id);
    const sourceBinding = this.#store.readSessionPersonalRuntimeBinding(
      session.id,
      true,
    );
    let sourceRuntimeScope: RuntimeAccountScope | undefined;
    let sourceExpectedAccountKey: string | undefined;
    const targetExpectedAccountKey = progress.targetProviderAccountKey;
    if (sourceBound()) {
      if (
        currentProviderAccountAuthority === null
        || currentProviderAccountAuthority.provider !== evidence.sourceProvider
      ) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The provider switch lost its immutable source account authority.",
        );
      }
      sourceRuntimeScope = currentProviderAccountAuthority.runtimeScope;
      sourceExpectedAccountKey = currentProviderAccountAuthority.accountKey;
    } else {
      if (
        targetExpectedAccountKey !== undefined
        && (
          currentProviderAccountAuthority === null
          || currentProviderAccountAuthority.provider !== evidence.targetProvider
          || currentProviderAccountAuthority.runtimeScope !== "managed"
          || currentProviderAccountAuthority.accountKey !== targetExpectedAccountKey
        )
      ) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The provider switch lost its immutable target account authority.",
        );
      }
    }
    if (sourceRuntimeScope === "personal") {
      if (
        sourceBinding === null
        || sourceBinding.state !== "active"
        || sourceBinding.provider !== evidence.sourceProvider
        || sourceBinding.providerThreadId !== evidence.sourceProviderThreadId
      ) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The provider switch lost its exact personal-home source binding.",
        );
      }
    } else if (sourceBound() && (
      sourceBinding !== null
      && sourceBinding.state !== "detached"
    )) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The provider switch source runtime scope conflicts with its personal-home binding.",
      );
    } else if (
      targetBound()
      && sourceBinding !== null
      && sourceBinding.state !== "detached"
    ) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The provider switch target still has controlling personal-home authority.",
      );
    }
    let recoveredTargetProviderAccountKey: string | undefined;
    const requireSourceRuntimeAccountAuthority = (): Readonly<{
      accountKey: string;
      runtimeScope: RuntimeAccountScope;
    }> => {
      if (sourceRuntimeScope !== undefined && sourceExpectedAccountKey !== undefined) {
        return {
          accountKey: sourceExpectedAccountKey,
          runtimeScope: sourceRuntimeScope,
        };
      }
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The provider switch no longer owns the exact source runtime authority.",
      );
    };
    const assertRuntimeAccountStable = async (
      profile: ProfileRecord,
      provider: Provider,
      runtimeScope: RuntimeAccountScope,
      expectedAccountKey: string | undefined,
      missingDiagnostic: string,
    ): Promise<string> => {
      if (expectedAccountKey === undefined) {
        throw new CommandFailure("RECOVERY_REQUIRED", missingDiagnostic);
      }
      const exactProfile = this.#store.requireProfileById(profile.id);
      const observedAccountKey = await this.#assertProviderRuntimeAccountAuthority(
        exactProfile,
        provider,
        runtimeScope,
        signal,
        true,
      );
      if (observedAccountKey === expectedAccountKey) return observedAccountKey;
      if (provider === "codex" && runtimeScope === "managed") {
        this.#scheduleProfilePersonalAuthorityRevocation(exactProfile);
      } else {
        this.#scheduleProviderRuntimeAccountRevocation(
          exactProfile,
          provider,
          runtimeScope,
          observedAccountKey,
        );
      }
      throw new ProviderAccountAuthorityMismatchError(
        provider,
        runtimeScope,
        exactProfile,
      );
    };
    const readDetached = async (
      side: "source" | "target",
      profile: ProfileRecord,
      provider: Provider,
      providerThreadId: string,
      detail: boolean,
    ): Promise<CodexSessionProjection> => {
      const isSource = side === "source";
      const sideMatches = isSource
        ? profile.id === evidence.sourceProfileId
          && provider === evidence.sourceProvider
          && providerThreadId === evidence.sourceProviderThreadId
        : profile.id === evidence.targetProfileId
          && provider === evidence.targetProvider
          && progress.targetProviderThreadId === providerThreadId;
      if (!sideMatches) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The provider-switch detached-read side does not match its immutable evidence.",
        );
      }
      if (
        !isSource
        && evidence.targetProfileId === evidence.sourceProfileId
        && evidence.targetProvider === evidence.sourceProvider
        && providerThreadId === evidence.sourceProviderThreadId
      ) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The provider-switch target aliases its source thread and cannot be inspected.",
        );
      }
      const sourceAuthority = isSource
        ? requireSourceRuntimeAccountAuthority()
        : undefined;
      const runtimeScope: RuntimeAccountScope = isSource
        ? sourceAuthority?.runtimeScope ?? "managed"
        : "managed";
      const expectedAccountKey = isSource
        ? sourceAuthority?.accountKey
        : targetExpectedAccountKey;
      const assertAccountStable = async (): Promise<string> => {
        return await assertRuntimeAccountStable(
          profile,
          provider,
          runtimeScope,
          expectedAccountKey,
          isSource
            ? "The provider switch no longer owns the exact source account authority."
            : "This provider-switch receipt predates durable target account authority and cannot inspect its target.",
        );
      };
      const beforeAccountKey = await assertAccountStable();
      const runtime = runtimeScope === "personal"
        ? this.#personalSessionRuntime(provider)
        : this.#sessionRuntime(provider);
      const authority = runtimeScope === "personal"
        ? this.#personalAuthorityForProfile(profile)
        : authorityFor(this.#paths, profile);
      let projection: CodexSessionProjection | undefined;
      let readFailure: Readonly<{ error: unknown }> | undefined;
      try {
        if (provider === "claude") {
          const process = this.#store.readClaudeProcessAuthority({
            providerThreadId,
            profileId: profile.id,
            runtimeScope,
          });
          if (
            process === null
            || process.profileGeneration !== profile.processGeneration
            || process.sessionId !== session.id
            || (process.state !== "claimed" && process.state !== "bound")
          ) {
            throw new CommandFailure(
              "RECOVERY_REQUIRED",
              "The provider switch no longer owns exact Claude process custody for this detached read.",
            );
          }
          const liveIdentity = await this.#fencedEffect(async () =>
            await (runtime as ClaudeRuntimePort).readSessionProcessIdentity({
              authority,
              providerThreadId,
              signal,
            }));
          if (!this.#sameClaudeProcessIdentity(liveIdentity, process.identity)) {
            throw new CommandFailure(
              "RECOVERY_REQUIRED",
              "The live Claude controller no longer matches the provider switch's durable process custody.",
            );
          }
        }
        projection = await this.#fencedEffect(async () =>
          await runtime.readSession({
            authority,
            providerThreadId,
            detail,
            signal,
          }));
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        readFailure = { error };
      }
      let afterAccountKey: string;
      try {
        afterAccountKey = await assertAccountStable();
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        throw new IndeterminateLocalCommitError(
          "A detached provider-switch read crossed an account-authority change.",
          error,
        );
      }
      if (readFailure !== undefined) throw readFailure.error;
      if (projection === undefined) throw new Error("PROVIDER_SWITCH_DETACHED_READ_MISSING");
      if (afterAccountKey !== beforeAccountKey) {
        throw new ProviderAccountAuthorityMismatchError(
          provider,
          runtimeScope,
          this.#store.requireProfileById(profile.id),
        );
      }
      if (!isSource) recoveredTargetProviderAccountKey = afterAccountKey;
      if (projection.providerThreadId !== providerThreadId) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The provider returned a different thread than the immutable switch receipt names.",
        );
      }
      return projection;
    };
    const requireRecoveredTargetProviderAccountKey = (): string => {
      if (recoveredTargetProviderAccountKey !== undefined) {
        return recoveredTargetProviderAccountKey;
      }
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The provider switch has no fresh target account-authority proof.",
      );
    };
    const endDetachedTarget = async (providerThreadId: string): Promise<void> => {
      if (providerThreadId !== progress.targetProviderThreadId) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The provider-switch cleanup target does not match its durable target receipt.",
        );
      }
      if (
        evidence.targetProfileId === evidence.sourceProfileId
        && evidence.targetProvider === evidence.sourceProvider
        && providerThreadId === evidence.sourceProviderThreadId
      ) {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The provider-switch target aliases its source thread and cannot be ended.",
        );
      }
      const providerAccountKey = await assertRuntimeAccountStable(
        targetProfile,
        evidence.targetProvider,
        "managed",
        targetExpectedAccountKey,
        "This provider-switch receipt predates durable target account authority and cannot end its target.",
      );
      let effectFailure: Readonly<{ error: unknown }> | undefined;
      try {
        if (evidence.targetProvider === "claude") {
          await this.#releaseClaudeProcessAuthority({
            providerThreadId,
            profileId: targetProfile.id,
            runtimeScope: "managed",
          }, signal);
        } else {
          await this.#fencedEffect(async () => await this.#sessionRuntime(evidence.targetProvider).endSession({
            authority: authorityFor(this.#paths, targetProfile),
            providerThreadId,
            signal,
          }));
        }
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        effectFailure = { error };
      }
      try {
        await assertRuntimeAccountStable(
          targetProfile,
          evidence.targetProvider,
          "managed",
          targetExpectedAccountKey,
          "This provider-switch receipt predates durable target account authority and cannot end its target.",
        );
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        throw new IndeterminateLocalCommitError(
          "The provider-switch target account changed while its exact cleanup was in flight.",
          error,
        );
      }
      if (effectFailure !== undefined) throw effectFailure.error;
      this.#store.recordSessionProviderSwitchTargetReleased({
        attemptId: attempt.id,
        sessionId: session.id,
        providerThreadId,
        providerAccountKey,
      });
    };
    const providerState = (projection: CodexSessionProjection) => ({
      providerThreadId: projection.providerThreadId,
      title: projection.title,
      status: projection.status,
      ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
      ...(projection.providerUpdatedAt === undefined
        ? {}
        : { providerUpdatedAt: projection.providerUpdatedAt }),
    } as const);
    const finish = async (
      resolved: SessionRecord,
      resolution: "proven_applied" | "abandoned",
      projection?: CodexSessionProjection,
      extra: Record<string, unknown> = {},
    ): Promise<unknown> => {
      await this.#reconcileCommittedSessionFactsMemory(
        resolved,
        resolution === "abandoned" ? "abandon" : undefined,
      );
      this.#resumeSessionWorkAfterRecovery(resolved);
      return {
        session: resolved,
        ...(projection === undefined ? {} : { projection }),
        idempotencyKey: attempt.idempotencyKey,
        recovery: {
          resolved: true,
          resolution,
          providerEffectRetried: false,
          ...extra,
        },
      };
    };

    const crossedDaemonRestart = evidence.daemonGeneration === undefined
      || evidence.daemonGeneration !== this.#daemonGeneration;
    const sourceClaudeStateUnavailable = crossedDaemonRestart
      && evidence.sourceProvider === "claude"
      && !progress.sourceReleased;
    const targetClaudeStateUnavailable = crossedDaemonRestart
      && evidence.targetProvider === "claude"
      && !progress.targetReleased;
    if (sourceClaudeStateUnavailable || targetClaudeStateUnavailable) {
      if (action === "recover") {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The provider switch crossed a daemon restart with unreleased Claude state. Claude sessions are process-local and the new daemon cannot read, resume, or release that prior process. No provider effect was replayed; run `hra session abandon` only if you accept a provider-state-unknown settlement.",
        );
      }

      const sourceReleased = progress.sourceReleased;
      const targetAddressable = progress.targetProviderThreadId !== undefined;
      let targetReleased = progress.targetReleased;
      let targetStateUnknown = targetClaudeStateUnavailable || (!targetAddressable && !targetReleased);
      let sourceStateUnknown = !sourceReleased;
      let sourceObserved = false;
      let observedSourceProviderUpdatedAt: number | null | undefined;
      if (!sourceReleased && evidence.sourceProvider === "codex") {
        try {
          const sourceProjection = await readDetached(
            "source",
            sourceProfile,
            evidence.sourceProvider,
            evidence.sourceProviderThreadId,
            false,
          );
          sourceStateUnknown = false;
          sourceObserved = true;
          observedSourceProviderUpdatedAt = sourceProjection.providerUpdatedAt ?? null;
        } catch (error: unknown) {
          if (error instanceof DaemonAuthoritySafetyError) throw error;
          this.recordBackgroundDiagnostic("provider_switch_source_abandon_failed", error);
        }
      }
      if (
        progress.targetProviderThreadId !== undefined
        && !targetReleased
        && !targetClaudeStateUnavailable
      ) {
        try {
          await endDetachedTarget(progress.targetProviderThreadId);
          targetReleased = true;
        } catch (error: unknown) {
          if (error instanceof DaemonAuthoritySafetyError) throw error;
          targetStateUnknown = true;
          this.recordBackgroundDiagnostic("provider_switch_target_abandon_failed", error);
        }
      }
      if (!targetReleased) targetStateUnknown = true;
      const providerStateDeleted = sourceReleased && targetReleased;
      const providerStateUnknown = sourceStateUnknown || targetStateUnknown;
      const unaddressableTargetMayExist = !targetAddressable && !targetReleased;
      const resolved = this.#store.resolveSessionMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: evidenceRecord.digest,
        resolution: "abandoned",
        resolutionEvidence: {
          action: "user_abandon",
          source: "claude_process_local_restart_boundary",
          daemonGeneration: this.#daemonGeneration,
          effectDaemonGeneration: evidence.daemonGeneration ?? null,
          providerEffectRetried: false,
          providerStateDeleted,
          providerStateUnknown,
          sourceReleased,
          sourceObserved,
          sourceStateUnknown,
          targetAddressable,
          targetReleased,
          targetStateUnknown,
          unaddressableTargetMayExist,
          ...(observedSourceProviderUpdatedAt === undefined
            ? {}
            : { observedSourceProviderUpdatedAt }),
        },
        acknowledgeProviderStateUnknown: true,
      });
      return await finish(resolved, "abandoned", undefined, {
        providerStateDeleted,
        providerStateUnknown,
        sourceReleased,
        sourceObserved,
        sourceStateUnknown,
        targetAddressable,
        targetReleased,
        targetStateUnknown,
        unaddressableTargetMayExist,
      });
    }
    if (targetBound() && !progress.sourceReleased) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The target is locally bound without a durable source-release receipt.",
      );
    }
    if (progress.sourceReleased && progress.seedTurnId === undefined) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The source-release receipt exists without a durable seeded-turn receipt.",
      );
    }

    if (action === "abandon") {
      let targetReleased = progress.targetReleased;
      const sourceReleased = progress.sourceReleased;
      const targetAddressable = progress.targetProviderThreadId !== undefined;
      if (progress.targetProviderThreadId !== undefined && !targetReleased) {
        try {
          await endDetachedTarget(progress.targetProviderThreadId);
          targetReleased = true;
        } catch (error: unknown) {
          if (error instanceof DaemonAuthoritySafetyError) throw error;
          this.recordBackgroundDiagnostic("provider_switch_target_abandon_failed", error);
        }
      }
      if (sourceBound() && !sourceReleased && targetReleased) {
        try {
          const sourceProjection = await readDetached(
            "source",
            sourceProfile,
            evidence.sourceProvider,
            evidence.sourceProviderThreadId,
            false,
          );
          const resolved = this.#store.resolveSessionMutation({
            attemptId: attempt.id,
            expectedOriginalState: originalState,
            expectedEvidenceDigest: evidenceRecord.digest,
            resolution: "abandoned",
            resolutionEvidence: {
              action: "user_abandon",
              providerEffectRetried: false,
              sourceRetained: true,
              targetReleased: true,
            },
            provider: providerState(sourceProjection),
          });
          return await finish(resolved, "abandoned", sourceProjection, {
            providerStateDeleted: false,
            sourceRetained: true,
            targetAddressable,
          });
        } catch (error: unknown) {
          if (error instanceof DaemonAuthoritySafetyError) throw error;
          this.recordBackgroundDiagnostic("provider_switch_source_abandon_failed", error);
        }
      }
      const providerStateDeleted = targetReleased && sourceReleased;
      const resolved = this.#store.resolveSessionMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: evidenceRecord.digest,
        resolution: "abandoned",
        resolutionEvidence: {
          action: "user_abandon",
          providerEffectRetried: false,
          providerStateDeleted,
          targetAddressable,
          unaddressableTargetMayExist: !targetAddressable,
        },
        acknowledgeProviderStateUnknown: true,
      });
      return await finish(resolved, "abandoned", undefined, {
        providerStateDeleted,
        targetAddressable,
        unaddressableTargetMayExist: !targetAddressable,
      });
    }

    if (progress.targetProviderThreadId === undefined) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The target start has no exact provider-thread receipt. Run `hra session abandon` only if you accept that an unaddressable target may still exist.",
      );
    }
    const targetThreadId = progress.targetProviderThreadId;
    if (progress.targetReleased) {
      if (progress.sourceReleased) {
        const resolved = this.#store.resolveSessionMutation({
          attemptId: attempt.id,
          expectedOriginalState: originalState,
          expectedEvidenceDigest: evidenceRecord.digest,
          resolution: "abandoned",
          resolutionEvidence: {
            source: "durable_release_receipts",
            sourceReleased: true,
            targetReleased: true,
          },
        });
        return await finish(resolved, "abandoned", undefined, { providerStateDeleted: true });
      }
      if (!sourceBound()) {
        throw new CommandFailure("RECOVERY_REQUIRED", "A released target no longer has the expected source binding.");
      }
      const sourceProjection = await readDetached(
        "source",
        sourceProfile,
        evidence.sourceProvider,
        evidence.sourceProviderThreadId,
        false,
      );
      const resolved = this.#store.resolveSessionMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: evidenceRecord.digest,
        resolution: "abandoned",
        resolutionEvidence: {
          source: "target_release_and_source_read",
          targetReleased: true,
          providerUpdatedAt: sourceProjection.providerUpdatedAt ?? null,
        },
        provider: providerState(sourceProjection),
      });
      return await finish(resolved, "abandoned", sourceProjection, { providerStateDeleted: false });
    }

    let targetProjection: CodexSessionProjection | undefined;
    if (progress.seed === undefined) {
      await endDetachedTarget(targetThreadId);
      const sourceProjection = await readDetached(
        "source",
        sourceProfile,
        evidence.sourceProvider,
        evidence.sourceProviderThreadId,
        false,
      );
      const resolved = this.#store.resolveSessionMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: evidenceRecord.digest,
        resolution: "abandoned",
        resolutionEvidence: { source: "target_released_before_seed", targetReleased: true },
        provider: providerState(sourceProjection),
      });
      return await finish(resolved, "abandoned", sourceProjection, { providerStateDeleted: false });
    }
    if (
      progress.seed.clientMessageId !== attempt.id
      || digestTranscriptSeed(progress.seed.text) !== evidence.seedDigest
    ) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The durable target seed intent does not match the immutable switch evidence.");
    }
    if (progress.seedTurnId === undefined) {
      targetProjection = await readDetached(
        "target",
        targetProfile,
        evidence.targetProvider,
        targetThreadId,
        true,
      );
      const matches = (targetProjection.messages ?? []).filter((message) =>
        message.role === "user"
        && message.clientId === attempt.id
        && message.turnId !== undefined);
      if (matches.length === 1) {
        const omission = targetProjection.omission;
        const provesUniqueMatch = omission !== undefined
          && !omission.hasMoreOlderTurns
          && omission.omittedMessages === 0
          && omission.truncatedMessages === 0
          && omission.unreadItemTurnIds.length === 0
          && omission.incompleteTurnIds.length === 0;
        if (!provesUniqueMatch) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The bounded target read cannot prove that the seed match is unique, so the source was left intact.",
          );
        }
        const turnId = matches[0]?.turnId;
        if (turnId === undefined) throw new Error("Provider-switch seed proof lost its turn id.");
        const summaries = (targetProjection.turnSummaries ?? []).filter((turn) => turn.id === turnId);
        const summary = summaries.length === 1 ? summaries[0] : undefined;
        if (summary === undefined) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The target names the seed message but does not provide one exact turn-status proof.",
          );
        }
        this.#store.recordSessionProviderSwitchSeedResult({
          attemptId: attempt.id,
          sessionId: session.id,
          providerThreadId: targetThreadId,
          runtimeProfile: progress.seed.runtimeProfile,
          turnId,
          turnStatus: summary.status,
        });
        progress = this.#store.readSessionProviderSwitchProgress(attempt.id);
      } else if (matches.length === 0) {
        const omission = targetProjection.omission;
        const provesAbsence = omission !== undefined
          && !omission.hasMoreOlderTurns
          && omission.omittedMessages === 0
          && omission.truncatedMessages === 0
          && omission.unreadItemTurnIds.length === 0
          && omission.incompleteTurnIds.length === 0;
        if (!provesAbsence) {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The bounded target read cannot prove that the seed was absent, so it was not replayed or cleaned up.",
          );
        }
        await endDetachedTarget(targetThreadId);
        const sourceProjection = await readDetached(
          "source",
          sourceProfile,
          evidence.sourceProvider,
          evidence.sourceProviderThreadId,
          false,
        );
        const resolved = this.#store.resolveSessionMutation({
          attemptId: attempt.id,
          expectedOriginalState: originalState,
          expectedEvidenceDigest: evidenceRecord.digest,
          resolution: "abandoned",
          resolutionEvidence: { source: "complete_target_read", seedAbsent: true, targetReleased: true },
          provider: providerState(sourceProjection),
        });
        return await finish(resolved, "abandoned", sourceProjection, { providerStateDeleted: false });
      } else {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The target contains multiple messages for one provider-switch seed authority.",
        );
      }
    }
    if (progress.seedTurnId === undefined || progress.seedTurnStatus === undefined) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The target seed result is still not durably proven.");
    }
    if (targetProjection === undefined) {
      targetProjection = await readDetached(
        "target",
        targetProfile,
        evidence.targetProvider,
        targetThreadId,
        false,
      );
    }
    if (!progress.sourceReleased) {
      if (!sourceBound()) {
        throw new CommandFailure("RECOVERY_REQUIRED", "The source release is unproven and the source is no longer bound.");
      }
      try {
        await this.#endProviderSession(
          { ...current, providerThreadId: evidence.sourceProviderThreadId },
          sourceProfile,
          signal,
        );
      } catch {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "The source provider release is still unproven; the seeded target was left intact.",
        );
      }
      try {
        this.#store.recordSessionProviderSwitchSourceReleased({
          attemptId: attempt.id,
          sessionId: session.id,
        });
      } catch {
        current = this.#store.requireSession(session.id);
        targetProjection = await readDetached(
          "target",
          targetProfile,
          evidence.targetProvider,
          targetThreadId,
          false,
        );
        this.#store.bindSessionProviderSwitchRecoveryTarget({
          attemptId: attempt.id,
          sessionId: session.id,
          expectedSessionRevision: current.revision,
          providerAccountKey: requireRecoveredTargetProviderAccountKey(),
          title: targetProjection.title,
          ...(targetProjection.providerUpdatedAt === undefined
            ? {}
            : { providerUpdatedAt: targetProjection.providerUpdatedAt }),
          recordSourceReleased: true,
        });
      }
      progress = this.#store.readSessionProviderSwitchProgress(attempt.id);
      current = this.#store.requireSession(session.id);
    }
    if (!progress.sourceReleased || progress.targetReleased) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The provider-switch release receipts changed before target adoption.");
    }
    if (sourceBound()) {
      targetProjection = await readDetached(
        "target",
        targetProfile,
        evidence.targetProvider,
        targetThreadId,
        false,
      );
      this.#store.bindSessionProviderSwitchRecoveryTarget({
        attemptId: attempt.id,
        sessionId: session.id,
        expectedSessionRevision: current.revision,
        providerAccountKey: requireRecoveredTargetProviderAccountKey(),
        title: targetProjection.title,
        ...(targetProjection.providerUpdatedAt === undefined
          ? {}
          : { providerUpdatedAt: targetProjection.providerUpdatedAt }),
      });
      current = this.#store.requireSession(session.id);
    }
    if (!targetBound()) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The seeded target could not be bound to the recovering session.");
    }
    targetProjection = await readDetached(
      "target",
      targetProfile,
      evidence.targetProvider,
      targetThreadId,
      false,
    );
    const receipt = sessionSwitchReceiptSchema.parse({
      from: {
        account: evidence.sourceProfileId,
        preset: evidence.sourcePreset,
        provider: evidence.sourceProvider,
      },
      providerThreadId: targetThreadId,
      request: {
        accountId: evidence.requestedAccountId,
        preset: evidence.requestedPreset,
        provider: evidence.targetProvider,
      },
      seed: {
        digest: evidence.seedDigest,
        includedRecords: evidence.seedIncludedRecords,
        omittedRecords: evidence.seedOmittedRecords,
        status: progress.seedTurnStatus,
      },
      sessionId: session.id,
      to: {
        account: evidence.targetProfileId,
        preset: evidence.targetPreset,
        provider: evidence.targetProvider,
      },
      transcriptDigest: evidence.transcriptDigest,
      turnId: progress.seedTurnId,
    });
    const resolved = this.#store.resolveSessionMutation({
      attemptId: attempt.id,
      expectedOriginalState: originalState,
      expectedEvidenceDigest: evidenceRecord.digest,
      resolution: "proven_applied",
      resolutionEvidence: {
        source: "target_read_after_source_release",
        providerUpdatedAt: targetProjection.providerUpdatedAt ?? null,
        seedTurnId: progress.seedTurnId,
      },
      receipt,
      provider: providerState(targetProjection),
    });
    return await finish(resolved, "proven_applied", targetProjection);
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
    this.#assertEstablishedSessionAccount(profile, session);
    if (profile.processGeneration !== record.evidence.profileGeneration) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The account generation changed after the uncertain queued effect.");
    }
    const projection = await this.#readExactSessionProjection({ ...session, providerThreadId: session.providerThreadId }, profile, false, signal);
    const provider = {
      providerThreadId: projection.providerThreadId,
      title: session.provider === "claude" ? session.title : projection.title,
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
      await this.#reconcileCommittedSessionFactsMemory(resolved, "abandon");
      this.#resumeSessionWorkAfterRecovery(resolved);
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
    await this.#reconcileCommittedSessionFactsMemory(resolved);
      this.#resumeSessionWorkAfterRecovery(resolved);
    return { session: resolved, projection, queueId: record.queueId, recovery: { resolved: true, resolution: "proven_applied", providerEffectRetried: false } };
  }

  async #readExactSessionProjection(session: BoundSessionRecord, profile: ProfileRecord, detail: boolean, signal: AbortSignal): Promise<CodexSessionProjection> {
    if (
      session.provider === "claude"
      && !this.#sessionHasMatchingActivePersonalBinding(session)
    ) this.#assertClaudeIsolationAccepted();
    await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
    const projection = await this.#fencedEffect(async () => await this.#runtimeForSession(session).readSession({ authority: this.#authorityForSession(session, profile), providerThreadId: session.providerThreadId, detail, signal }));
    await this.#assertPersonalSessionAccountAuthority(
      this.#store.requireSession(session.id),
      this.#store.requireProfileById(profile.id),
      signal,
      true,
    );
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
    this.#requireCodexSession(session, "protected turn inspection");
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    this.#requireLiveProviderObservation(
      await this.#ensureSessionObservedLocked(session.id, signal),
    );
    const codex = this.#runtimeForSession(session) as CodexRuntimePort;
    await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
    const inspected = await this.#fencedEffect(async () => await codex.inspectTurn({ authority: this.#authorityForSession(session, profile), providerThreadId: session.providerThreadId, turnId, signal }));
    await this.#assertPersonalSessionAccountAuthority(
      this.#store.requireSession(session.id),
      this.#store.requireProfileById(profile.id),
      signal,
      true,
    );
    return inspected;
  }

  #requireBoundSession(selector: string): BoundSessionRecord {
    const session = this.#store.requireSession(selector);
    if (session.providerThreadId === undefined) throw new CommandFailure("RECOVERY_REQUIRED", "The session has no proven provider binding.");
    if (session.state === "recovery_required") throw new CommandFailure("RECOVERY_REQUIRED", "The session requires recovery before another mutation.");
    if (session.state === "terminal") throw new CommandFailure("CONFLICT", "The session is terminal and cannot accept another mutation.");
    // This is also the fail-closed admission gate for commands that only write
    // local queue state before they need a provider runtime.
    const profile = this.#store.requireProfileById(session.profileId);
    this.#assertEstablishedSessionAccount(profile, session);
    this.#sessionHasActivePersonalBinding(session);
    return { ...session, providerThreadId: session.providerThreadId };
  }

  #assertSignedIn(profile: ProfileRecord): void {
    if (this.#profileAuthorityRevocationIsPending(
      profile.id,
      profile.processGeneration,
    )) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        `Account authority for ${profile.label} is being revoked; wait for controller release before another provider operation.`,
      );
    }
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

  #assertIdentifiableAccountAuthority(
    profile: Pick<ProfileRecord, "id" | "label" | "providerEmail">,
  ): void {
    if (profile.providerEmail !== undefined) return;
    throw new CommandFailure(
      "UNAVAILABLE",
      `The provider did not expose a stable account identity for ${profile.label}. HRA will not create or adopt sessions under an unprovable API-key or Bedrock credential.`,
      { accountId: profile.id },
    );
  }

  #profileAuthorityIsUsable(
    profileId: ProfileRecord["id"],
    generation: number,
    provider: Provider = "codex",
    sessionId?: SessionRecord["id"],
  ): boolean {
    try {
      const profile = this.#store.requireProfileById(profileId);
      const session = sessionId === undefined
        ? { provider }
        : this.#store.requireSession(sessionId);
      return profile.processGeneration === generation
        && this.#profileAllowsEstablishedSession(profile, session)
        && !this.#profileAuthorityRevocationIsPending(profileId, generation);
    } catch {
      return false;
    }
  }

  /**
   * A profile's durable state is Codex account state. Claude authentication is
   * owned by Claude Code inside the same provider-neutral profile directory,
   * so admitting a new Claude effect must ask that provider without mutating
   * the Codex state machine.
   */
  async #assertProviderSignedIn(
    profile: ProfileRecord,
    provider: Provider,
    signal: AbortSignal,
  ): Promise<Readonly<{
    profileId: ProfileRecord["id"];
    processGeneration: number;
    provider: Provider;
    signedIn: true;
  }>> {
    if (provider === "codex") {
      this.#assertSignedIn(profile);
      this.#assertIdentifiableAccountAuthority(profile);
      return {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider,
        signedIn: true,
      };
    }
    if (profile.state !== "signed_in" && profile.state !== "signed_out") {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "Resolve this profile's unsettled Codex account transition before starting a Claude provider effect.",
      );
    }
    const unsettledLogin = this.#unsettledClaudeLogin(profile);
    if (unsettledLogin !== undefined) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "A foreground Claude login still owns this account. Join or explicitly resolve that exact login before starting another Claude provider effect.",
        this.#claudeLoginRecovery(unsettledLogin),
      );
    }
    this.#assertClaudeIsolationAccepted();
    const account = await this.#fencedEffect(async () => await this.#claude.readAccount({
      authority: authorityFor(this.#paths, profile),
      signal,
    }));
    if (account.signedIn) {
      return {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider,
        signedIn: true,
      };
    }
    const nextCommand = `hra account login ${profile.id} --provider claude`;
    throw new CommandFailure(
      "INTERACTION_REQUIRED",
      `Sign in with \`${nextCommand}\` before using this account's Claude runtime.`,
      {
        accountSelector: profile.id,
        accountState: "signed_out",
        nextCommand,
        provider: "claude",
      },
    );
  }

  /** Provider-touch admission for an established session. */
  #profileAllowsEstablishedSession(
    profile: ProfileRecord,
    session: Pick<SessionRecord, "provider"> & Partial<
      Pick<SessionRecord, "id" | "providerThreadId">
    >,
  ): boolean {
    if (session.provider !== "claude") return profile.state === "signed_in";
    if (profile.state !== "signed_in" && profile.state !== "signed_out") return false;
    if (this.#platform === "linux") return true;
    if (session.id === undefined || session.providerThreadId === undefined) return false;
    return this.#sessionHasMatchingActivePersonalBinding({
      id: session.id,
      provider: session.provider,
      providerThreadId: session.providerThreadId,
    });
  }

  /** Established sessions retain both their HRA profile and runtime-home authority. */
  #assertEstablishedSessionAccount(
    profile: ProfileRecord,
    session: Pick<SessionRecord, "id" | "profileId" | "provider" | "providerThreadId">,
  ): void {
    if (session.provider === "codex") {
      this.#assertSignedIn(profile);
      this.#assertSessionAccountAuthority(session, profile);
      return;
    }
    if (!this.#sessionHasMatchingActivePersonalBinding(session)) {
      this.#assertClaudeIsolationAccepted();
    }
  }

  #quarantineProfile(profile: Pick<ProfileRecord, "id" | "processGeneration" | "providerEmail" | "providerPlan">): ProfileRecord {
    this.#clearProfileFactAuthorities(profile.id);
    const current = this.#store.requireProfile(profile.id);
    if (current.processGeneration !== profile.processGeneration) {
      throw new Error("Account generation changed before recovery quarantine.");
    }
    if (this.#profileHasControllingRuntimeAuthority(current)) {
      this.#scheduleProfilePersonalAuthorityRevocation(current);
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

  #quarantineCodexAccountMutation(
    profile: Pick<ProfileRecord, "id" | "processGeneration" | "providerEmail" | "providerPlan">,
  ): ProfileRecord {
    // The exact Codex scopes were already fenced by the account mutation.
    // Keep independent Claude controllers intact: recovery_required makes
    // their effects temporarily unavailable without confusing a Codex
    // credential outcome with permission to terminate Claude custody.
    this.#clearProfileFactAuthorities(profile.id, "codex");
    const current = this.#store.requireProfile(profile.id);
    if (current.processGeneration !== profile.processGeneration) {
      throw new Error("Account generation changed before Codex recovery quarantine.");
    }
    if (current.state !== "recovery_required") {
      const stateChange = this.#store.setProfileStateWithWorkRetirement(
        profile.id,
        profile.processGeneration,
        "recovery_required",
        this.#work,
        {
          ...(current.providerEmail === undefined ? {} : { email: current.providerEmail }),
          ...(current.providerPlan === undefined ? {} : { plan: current.providerPlan }),
        },
      );
      this.#notifyAffectedWork(stateChange.affectedWorkIds);
      if (!stateChange.changed) {
        throw new Error("Codex account could not be quarantined after an indeterminate mutation.");
      }
    }
    return this.#store.requireProfile(profile.id);
  }

  #quarantineSession(sessionId: SessionRecord["id"]): SessionRecord {
    this.#clearSessionFactAuthority(sessionId);
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
    const targetRevision = this.#terminalFactsMemoryRevision;
    if (
      this.#terminalFactsMemoryReconciledRevision >= targetRevision
      || this.#factsMemory === undefined
    ) {
      this.#terminalFactsMemoryReconciledRevision = targetRevision;
      return;
    }
    let afterId: string | null = null;
    let failed = false;
    for (;;) {
      const page = this.#store.listCloudSessionPage({ afterId, limit: 100 });
      for (const session of page.sessions) {
        if (session.state !== "terminal") continue;
        try {
          await this.#cleanupFactsMemory(session, "archive");
        } catch {
          // A damaged terminal row keeps its retry generation open, but cannot
          // prevent unrelated commands or startup recovery from proceeding.
          failed = true;
        }
      }
      if (page.isDone || page.continueAfterId === null) break;
      afterId = page.continueAfterId;
    }
    if (!failed) {
      this.#terminalFactsMemoryReconciledRevision = Math.max(
        this.#terminalFactsMemoryReconciledRevision,
        targetRevision,
      );
    }
  }

  #publicProfile(profile: ProfileRecord): unknown {
    return { id: profile.id, label: profile.label, state: profile.state, processGeneration: profile.processGeneration, providerEmail: profile.providerEmail, providerPlan: profile.providerPlan, updatedAt: profile.updatedAt };
  }

  async #dispatchNextQueue(sessionId: SessionRecord["id"], authority: ProfileAuthority): Promise<void> {
    const session = this.#store.requireSession(sessionId);
    if (session.state !== "idle" || session.providerThreadId === undefined) return;
    const admittedProfile = this.#store.requireProfile(session.profileId);
    if (!this.#profileAllowsEstablishedSession(admittedProfile, session)) return;
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
      if (!this.#profileAuthorityIsUsable(
        profile.id,
        authority.generation,
        session.provider,
        session.id,
      )) return;
      await this.#requireUsableProjectRoot(project.rootPath);
      this.#requireLiveProviderObservation(
        await this.#ensureSessionObservedLocked(session.id, signal),
      );
      const baseline = await this.#readExactSessionProjection(boundSession, profile, false, signal);
      if (baseline.status === "active" || baseline.activeTurnId !== undefined) return;
      const reviewedProjectRoot = await this.#requireUsableProjectRoot(project.rootPath);
      await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
      const review = await this.#fencedEffect(async () => {
        return await this.#runtimeForSession(session).reviewTurnStart({
          authority,
          providerThreadId: boundSession.providerThreadId,
          projectRoot: reviewedProjectRoot,
          preset: session.preset,
          fast: session.fastEnabled,
          signal,
        });
      });
      // The queued manifest is durable; its bytes are re-proved here, at
      // dispatch, exactly as they were at enqueue.
      const queuedAttachments = await this.#prepareAttachments(
        this.#store.messageAttachmentManifest(session.id, queued.id),
      );
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
      const dispatchFactEpoch = this.#snapshotSessionFactEpoch(session.id);
      const dispatchProjectRoot = await this.#requireUsableProjectRoot(project.rootPath);
      await this.#assertPersonalSessionAccountAuthority(session, profile, signal, true);
      const result = await this.#fencedEffect(async () => {
        return await this.#runtimeForSession(session).startTurn({
          authority,
          providerThreadId: boundSession.providerThreadId,
          projectRoot: dispatchProjectRoot,
          review,
          message: queued.message,
          ...(queuedAttachments.values.length === 0
            ? {}
            : { attachments: queuedAttachments.values }),
          clientMessageId: queued.id,
          signal,
        });
      });
      providerApplied = true;
      await this.#assertSessionAccountAuthorityAfterProviderEffect(
        boundSession,
        profile,
        signal,
      );
      this.#store.completeQueueEffect({
        queueId: queued.id,
        expectedEvidenceDigest: evidence.digest,
        expectedSessionRevision: dispatchRevision,
        applyResponseState: this.#currentSessionFactEpoch(session.id) === dispatchFactEpoch,
        turnId: result.turnId,
        turnStatus: result.status,
        runtimeProfile: result.effectiveRuntimeProfile,
        receipt: { turnId: result.turnId, sourceId: queued.id, status: result.status },
      });
      this.#wakeSessionTaskPump();
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
        this.#wakeSessionTaskPump();
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

  #scheduleUsageRefresh(authority: ProfileAuthority): void {
    if (this.#state !== "open") return;
    if (this.#usageRefreshes.has(authority.id)) {
      this.#usageRefreshDirty.add(authority.id);
      return;
    }
    const task = Promise.resolve().then(async () => {
      for (;;) {
        this.#usageRefreshDirty.delete(authority.id);
        if (this.#state !== "open" || this.#backgroundAbort.signal.aborted) return;
        let profile: ProfileRecord;
        try {
          profile = this.#store.requireProfileById(authority.id);
        } catch {
          return;
        }
        if (
          profile.processGeneration !== authority.generation
          || profile.state !== "signed_in"
          || this.#profileAuthorityRevocationIsPending(profile.id, authority.generation)
        ) return;
        await this.#serialize(`account:${profile.id}`, async () => {
          const current = this.#store.requireProfileById(profile.id);
          if (
            current.processGeneration !== authority.generation
            || current.state !== "signed_in"
            || this.#profileAuthorityRevocationIsPending(current.id, authority.generation)
          ) return;
          await this.#usage(
            current.id,
            true,
            this.#backgroundAbort.signal,
          );
        });
        if (!this.#usageRefreshDirty.has(authority.id)) return;
      }
    });
    const tracked = task.catch((error: unknown) => {
      if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
      else this.recordBackgroundDiagnostic("usage_refresh_failed", error);
    });
    this.#usageRefreshes.set(authority.id, tracked);
    this.#background.add(tracked);
    void tracked.then(() => {
      if (this.#usageRefreshes.get(authority.id) === tracked) {
        this.#usageRefreshes.delete(authority.id);
      }
      this.#background.delete(tracked);
      if (this.#usageRefreshDirty.delete(authority.id) && this.#state === "open") {
        this.#scheduleUsageRefresh(authority);
      }
    });
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

  async #serializeKeys<T>(
    keys: readonly string[],
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const unique = [...new Set(keys)];
    const descend = async (index: number): Promise<T> => {
      const key = unique[index];
      if (key === undefined) return await operation();
      return await this.#serialize(key, async () => await descend(index + 1));
    };
    return await descend(0);
  }

  async #serializeProfileAuthorities<T>(
    profileIds: readonly ProfileRecord["id"][],
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const ordered = [...new Set(profileIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      const profileId = ordered[index];
      if (profileId === undefined) return await operation();
      return await this.#serialize(
        `account:${profileId}`,
        async () => acquire(index + 1),
      );
    };
    return await acquire(0);
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

  async #applyOrderedSessionFact(
    session: Pick<SessionRecord, "id" | "profileId">,
    operation: () => Promise<void> | void,
  ): Promise<void> {
    const accountKey = `account:${session.profileId}`;
    const sessionKey = `session:${session.id}`;
    const ordered = async (): Promise<void> => {
      await this.#serializeSessionAuthority(
        session,
        operation,
        { allowDuringProjectionRecovery: true },
      );
    };
    if (!this.#mutationTails.has(accountKey) && !this.#mutationTails.has(sessionKey)) {
      await ordered();
      return;
    }
    // Provider callbacks can be awaited from inside the provider effect that
    // owns these tails. Queue the entire source revalidation and fact commit,
    // then return the callback so the effect can release its authority.
    const task = ordered();
    const tracked = task.then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof StateSecurityScrubRequiredError) this.#requestStop();
        else this.recordBackgroundDiagnostic("session_state_tracking_failed", error);
      },
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #sessionRecoveryProfileIds(session: Pick<SessionRecord, "id" | "profileId">): readonly ProfileRecord["id"][] {
    const ids = new Set<ProfileRecord["id"]>([session.profileId]);
    for (const attempt of this.#store.listUnsettledMutations({ sessionId: session.id })) {
      const evidence = attempt.evidence?.evidence;
      if (evidence?.kind !== "session.switch") continue;
      ids.add(evidence.sourceProfileId);
      ids.add(evidence.targetProfileId);
    }
    return [...ids];
  }

  async #serializeSessionAuthority<T>(
    session: Pick<SessionRecord, "id" | "profileId">,
    operation: () => Promise<T> | T,
    options: Readonly<{ allowDuringProjectionRecovery?: boolean }> = {},
  ): Promise<T> {
    return await this.#serializeSessionAuthorityAcrossProfiles(
      session,
      [session.profileId],
      operation,
      options,
    );
  }

  async #serializeSessionAuthorityAcrossProfiles<T>(
    session: Pick<SessionRecord, "id" | "profileId">,
    profileIds: readonly ProfileRecord["id"][],
    operation: () => Promise<T> | T,
    options: Readonly<{ allowDuringProjectionRecovery?: boolean }> = {},
  ): Promise<T> {
    const authorityProfileIds = [...new Set(profileIds)];
    const profileRecoveryIsInFlight = (): boolean =>
      authorityProfileIds.some((profileId) =>
        this.#profileHasProjectionRecoveryInFlight(profileId));
    return await this.#serializeProfileAuthorities(authorityProfileIds, async () =>
      this.#serialize(`session:${session.id}`, async () => {
        this.#assertSessionAccountAuthorityIfSignedIn(this.#store.requireSession(session.id));
        if (options.allowDuringProjectionRecovery !== true) {
          if (
            this.#projectionRecoveriesInFlight.has(session.id)
            || profileRecoveryIsInFlight()
          ) {
            throw new CommandFailure(
              "RECOVERY_REQUIRED",
              "This session or account has a compact-projection recovery in flight.",
            );
          }
          const [sessionRecoveryIsUnsettled, ...profileRecoveryStates] = await Promise.all([
            this.#cloud.isCompactProjectionRecoveryUnsettled(session.id),
            ...authorityProfileIds.map(async (profileId) =>
              await this.#cloud.isCompactProjectionRecoveryUnsettledForProfile(profileId)),
          ]);
          await this.#daemonAuthority.assertCurrent();
          if (
            sessionRecoveryIsUnsettled
            || profileRecoveryStates.some(Boolean)
            || this.#projectionRecoveriesInFlight.has(session.id)
            || profileRecoveryIsInFlight()
          ) {
            throw new CommandFailure(
              "RECOVERY_REQUIRED",
              "This session or account has an unsettled compact-projection recovery. Retry that exact recovery before changing local or provider state.",
            );
          }
        }
        return await operation();
      }));
  }

  async #serializeInteractionAuthority<T>(
    interactionId: InteractionRecord["publicId"],
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const selected = this.#store.requireInteraction(interactionId);
    if (selected.sessionId === null) {
      return await this.#serialize(`account:${selected.authority.profileId}`, async () =>
        this.#serialize(`interaction:${selected.publicId}`, async () => {
          await this.#assertNoCompactProjectionRecoveryForProfile(
            selected.authority.profileId,
          );
          return await operation();
        }));
    }
    const session = this.#store.requireSession(selected.sessionId);
    if (session.profileId !== selected.authority.profileId) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "The interaction no longer belongs to its recorded account authority.",
      );
    }
    return await this.#serializeSessionAuthority(session, async () =>
      this.#serialize(`interaction:${selected.publicId}`, operation));
  }

  async #assertNoCompactProjectionRecoveryForProfile(profileId: ProfileRecord["id"]): Promise<void> {
    if (this.#profileHasProjectionRecoveryInFlight(profileId)) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "This account has a compact-projection recovery in flight.",
      );
    }
    const unsettled = await this.#cloud.isCompactProjectionRecoveryUnsettledForProfile(profileId);
    await this.#daemonAuthority.assertCurrent();
    if (unsettled || this.#profileHasProjectionRecoveryInFlight(profileId)) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "This account owns an unsettled compact-projection recovery. Retry that exact recovery before changing provider or account authority.",
      );
    }
  }

  async #effect<T>(input: { kind: string; authorityId: string; authorityGeneration: number; request: unknown; idempotencyKey: string | undefined; beginEffect?(attemptId: MutationAttemptRecord["id"]): Promise<void> | void; effect(attemptId: MutationAttemptRecord["id"]): Promise<T>; receipt(result: T): unknown; restore(receipt: unknown): T; commit?(attemptId: MutationAttemptRecord["id"], result: T, receipt: unknown): Promise<void> | void; onAmbiguous?: (result: T | undefined) => void }): Promise<T> {
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
      // A fence loss reported by the fenced effect itself leaves the provider
      // outcome unknown; restart recovery owns that row. Every other rejection
      // is classified and recorded before the fence is rechecked, so a
      // determinate provider rejection is never stranded as `effect_started`
      // when the fence closed during the call.
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      const terminal = error instanceof IndeterminateCodexEffectError || error instanceof IndeterminateLocalCommitError ? "ambiguous" : "failed";
      if (terminal === "ambiguous") input.onAmbiguous?.(undefined);
      this.#store.transitionMutation(attempt.id, "effect_started", terminal, { code: error instanceof Error ? error.name : "error" });
      await this.#daemonAuthority.assertCurrent();
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
