import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";

import { Database, constants as sqliteConstants } from "bun:sqlite";
import { z } from "zod";

import { redactAbsolutePaths } from "../domain/text-safety";
import {
  INTERACTION_MAX_PENDING_MS,
  interactionDisplaySchema,
  interactionIntendedTerminalStateSchema,
  interactionKindSchema,
  interactionRecordSchema,
  interactionStateSchema,
  providerInteractionAuthoritySchema,
  type InteractionDisplay,
  type InteractionIntendedTerminalState,
  type InteractionKind,
  type InteractionRecord,
  type ApprovalMode,
  approvalModeSchema,
  type ProviderInteractionAuthority,
} from "../domain/interactions";
import {
  ROOT_STATUS_ATTENTION_LIMIT,
  SESSION_STATUS_PENDING_SUMMARY_LIMIT,
  assertRootStatusBound,
  rootStatusSchema,
  sessionLocalObservationSnapshotSchema,
  type RootStatus,
  type RootStatusAttentionRecord,
  type SessionLocalObservationSnapshot,
} from "../domain/observation";
import { presetSchema, type Preset } from "../domain/presets";
import {
  effectiveRuntimeProfileSchema,
  type EffectiveRuntimeProfile,
} from "../domain/runtime-profile";
import {
  ACCOUNT_USAGE_HISTORY_PAGE_LIMIT,
  CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES,
  accountRateLimitResetOutcomeSchema,
  storedAccountUsageSnapshotSchema,
  type AccountRateLimitResetOutcome,
} from "../domain/usage-metrics";
import {
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_PAGE_BYTES,
  SESSION_EVENT_PAGE_LIMIT,
  SESSION_EVENT_RETAIN_AGE_MS,
  SESSION_EVENT_RETAIN_BYTES,
  SESSION_EVENT_RETAIN_COUNT,
  sessionEventBodySchema,
  sessionEventGapReasonSchema,
  sessionEventSchema,
  type SessionEvent,
  type SessionEventBody,
  type SessionEventGapReason,
} from "../domain/session-events";
import { SESSION_CONVERSATION_AUTOMATION_CAPABILITY } from "../domain/session-tasks";
import {
  canTransitionQueue,
  mutationStateSchema,
  queueStateSchema,
  type MutationState,
  type QueueState,
} from "../domain/transitions";
import {
  createEphemeralPublicProviderIdentifierProjector,
  PUBLIC_MCP_FORM_SUMMARY,
  projectPublicSessionEventBody,
  type PublicProviderIdentifier,
  type PublicProviderIdentifierProjector,
} from "../public-provider-identifier";
import { redactCompleteSensitiveText } from "../sensitive-text";
import {
  attemptIdSchema,
  canonicalLabelKey,
  createAttemptId,
  createProfileId,
  createProjectId,
  createQueueId,
  createSessionId,
  labelSchema,
  noteSchema,
  profileIdSchema,
  projectIdSchema,
  queueIdSchema,
  selectByIdOrLabel,
  sessionIdSchema,
  titleSchema,
  unixMillisecondsSchema,
  utf8Bytes,
  type AttemptId,
  type ProfileId,
  type ProjectId,
  type QueueId,
  type SessionId,
} from "../domain/values";
import { resolveUsableCanonicalProjectDirectory } from "./project-directory";
import {
  WORK_SCHEMA_SQL,
  WorkStore,
  assertReadonlyWorkSchema,
  assertWorkSchema,
  type WorkCapabilityIssuer,
  type WorkCapabilityVerifier,
  type WorkCursorEncoder,
} from "./work-store";
import {
  SESSION_TASK_SCHEMA_SQL,
  SessionTaskStore,
  assertSessionTaskSchema,
} from "./session-task-store";
import type { StatePaths } from "./paths";
import type {
  DesktopRecoveryBinding,
  DesktopRecoveryResolution,
  DesktopSwitchGeneration,
  DesktopSwitchJournalEntry,
  DesktopSwitchStage,
} from "../domain/desktop-switch";

const processLocalPublicProviderIdentifierProjector =
  createEphemeralPublicProviderIdentifierProjector();

const profileStateSchema = z.enum(["signed_out", "login_pending", "signed_in", "recovery_required", "removed"]);
const sessionStateSchema = z.enum(["starting", "active", "idle", "terminal", "recovery_required"]);
const runtimeProfileSourceKindSchema = z.enum(["session_start", "turn_start", "queue_start"]);
const interactionListPositionSchema = z.object({
  requestedAt: unixMillisecondsSchema,
  publicId: z.string().uuid(),
}).strict();

export type InteractionListPosition = z.infer<typeof interactionListPositionSchema>;

export type InteractionListPage = Readonly<{
  interactions: readonly InteractionRecord[];
  nextPosition: InteractionListPosition | null;
}>;

export type InteractionPersistenceBoundaryEffect = "known_unsent" | "possibly_sent";

export type InteractionPersistenceBoundaryQuarantine = Readonly<{
  focalInteraction: InteractionRecord;
  profile: ProfileRecord;
  terminalInteractions: readonly InteractionRecord[];
}>;

const profileRowSchema = z.object({
  id: profileIdSchema,
  label: labelSchema,
  label_key: z.string().min(1),
  state: profileStateSchema,
  process_generation: z.number().int().nonnegative(),
  provider_email: z.string().nullable(),
  provider_plan: z.string().nullable(),
  created_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const projectRowSchema = z.object({
  id: projectIdSchema,
  label: labelSchema,
  label_key: z.string().min(1),
  root_path: z.string().min(1),
  is_default: z.union([z.literal(0), z.literal(1)]),
  created_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const sessionRowSchema = z.object({
  id: sessionIdSchema,
  profile_id: profileIdSchema,
  project_id: projectIdSchema.nullable(),
  provider_thread_id: z.string().nullable(),
  title: z.string(),
  note: z.string(),
  preset: presetSchema,
  fast_enabled: z.union([z.literal(0), z.literal(1)]),
  state: sessionStateSchema,
  active_turn_id: z.string().nullable(),
  provider_updated_at: z.number().nonnegative().nullable(),
  revision: z.number().int().positive(),
  created_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const sessionRuntimeProfileRowSchema = z.object({
  session_id: sessionIdSchema,
  revision: z.number().int().positive(),
  source_kind: runtimeProfileSourceKindSchema,
  source_id: z.string().min(1).max(200),
  profile_id: profileIdSchema,
  process_generation: z.number().int().nonnegative(),
  observed_at: unixMillisecondsSchema,
  profile_json: z.string().min(2).max(262_144),
  recorded_at: unixMillisecondsSchema,
}).strict();

const sessionTurnRuntimeProfileRowSchema = z.object({
  session_id: sessionIdSchema,
  turn_id: z.string().min(1).max(200),
  source_kind: runtimeProfileSourceKindSchema.exclude(["session_start"]),
  source_id: z.string().min(1).max(200),
  profile_id: profileIdSchema,
  process_generation: z.number().int().nonnegative(),
  observed_at: unixMillisecondsSchema,
  profile_json: z.string().min(2).max(262_144),
  profile_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  recorded_at: unixMillisecondsSchema,
}).strict();

export type ProfileRecord = {
  id: ProfileId;
  label: string;
  state: z.infer<typeof profileStateSchema>;
  processGeneration: number;
  providerEmail?: string;
  providerPlan?: string;
  createdAt: number;
  updatedAt: number;
};

export type ProfileAuthorityChangeResult = Readonly<{
  profile: ProfileRecord;
  affectedWorkIds: readonly string[];
}>;

export type ProfileStateChangeResult = ProfileAuthorityChangeResult & Readonly<{
  changed: boolean;
}>;

export type ProjectRecord = {
  id: ProjectId;
  label: string;
  rootPath: string;
  default: boolean;
  createdAt: number;
  updatedAt: number;
};

export const sessionStateRowSchema = z.object({
  sessionId: sessionIdSchema,
  state: z.enum([
    "working",
    "needs_approval",
    "needs_answer",
    "needs_action",
    "done",
    "done_followups",
    "done_caveats",
    "aborted",
  ]),
  attention: z.boolean(),
  reason: z.string().max(256),
  verbatimRequired: z.boolean(),
  verbatimLiteral: z.string().max(200).nullable(),
  lastActivityAt: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export type SessionStateRow = z.infer<typeof sessionStateRowSchema>;
const autorespondEvidenceRowSchema = z.object({
  id: z.number().int(),
  session_id: z.string(),
  interaction_id: z.string().uuid(),
  kind: z.enum(["command_approval", "file_change_approval", "permission_approval"]),
  class: z.string().max(256),
  decision: z.string().max(64),
  mode: z.enum(["auto:all", "auto:workspace", "manual"]),
  outcome: z.enum(["accepted", "refused"]),
  latency_ms: z.number().int().nonnegative(),
  subagent: z.number().int(),
  occurred_at: z.number().int().nonnegative(),
}).strict();

export type AutorespondEvidenceRow = Readonly<{
  approvalClass: string;
  decision: string;
  interactionId: string;
  kind: "command_approval" | "file_change_approval" | "permission_approval";
  latencyMs: number;
  mode: "auto:all" | "auto:workspace" | "manual";
  occurredAt: number;
  outcome: "accepted" | "refused";
  sessionId: string;
  subagent: boolean;
}>;

export type SessionRecord = {
  id: SessionId;
  profileId: ProfileId;
  projectId?: ProjectId;
  providerThreadId?: string;
  title: string;
  note: string;
  preset: Preset;
  fastEnabled: boolean;
  state: z.infer<typeof sessionStateSchema>;
  activeTurnId?: string;
  providerUpdatedAt?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type SessionRuntimeProfileRecord = {
  sessionId: SessionId;
  revision: number;
  sourceKind: z.infer<typeof runtimeProfileSourceKindSchema>;
  sourceId: string;
  profile: EffectiveRuntimeProfile;
  recordedAt: number;
};

export type SessionEventStreamPosition = {
  streamEpoch: string;
  floorSequence: number;
  observedThroughSequence: number;
};

export type SessionEventList = SessionEventStreamPosition & {
  gapReason: SessionEventGapReason | null;
  events: readonly SessionEvent[];
};

export type SessionSnapshotWithEventPosition = SessionEventStreamPosition & {
  session: SessionRecord;
};

export type UsageSnapshotRecord = {
  sourceRevision: number;
  observedAt: number;
  payload: unknown;
};

export type UsagePollFailureRecord = {
  sourceRevision: number;
  observedAt: number;
  reasonCode: "account_usage_read_failed";
};

export type UsageHistoryLedgerEntry =
  | Readonly<{
    state: "observed";
    sourceRevision: number;
    observedAt: number;
    payload: unknown;
  }>
  | Readonly<{
    state: "failed";
    sourceRevision: number;
    observedAt: number;
    reasonCode: UsagePollFailureRecord["reasonCode"];
  }>;

export type UsageHistoryLedgerPage = Readonly<{
  entries: readonly UsageHistoryLedgerEntry[];
  nextSourceRevision: number | null;
}>;

const accountRateLimitResetAttemptStateSchema = z.enum([
  "prepared",
  "effect_started",
  "ambiguous",
  "retryable",
  "settled",
  "closed",
]);

const accountRateLimitResetLocalResolutionSchema = z.enum([
  "weekly_window_changed",
  "account_identity_changed",
]);

export type AccountRateLimitResetAttemptRecord = Readonly<{
  attemptSequence: number;
  idempotencyKey: string;
  profileId: ProfileId;
  originProcessGeneration: number;
  currentProcessGeneration: number;
  accountFingerprint: string;
  weeklyWindowResetsAt: number;
  observedUsedPercent: number;
  state: z.infer<typeof accountRateLimitResetAttemptStateSchema>;
  outcome: AccountRateLimitResetOutcome | null;
  localResolution: z.infer<typeof accountRateLimitResetLocalResolutionSchema> | null;
  createdAt: number;
  updatedAt: number;
}>;

export type AccountRateLimitResetRebindRecord = Readonly<{
  sequence: number;
  idempotencyKey: string;
  fromProcessGeneration: number;
  toProcessGeneration: number;
  accountFingerprint: string;
  createdAt: number;
}>;

const accountRateLimitResetPolicyStateSchema = z.enum([
  "active_unbound",
  "reconciliation_required",
  "window_suppressed",
  "active_bound",
]);

export type AccountRateLimitResetPolicyRecord = Readonly<{
  profileId: ProfileId;
  state: z.infer<typeof accountRateLimitResetPolicyStateSchema>;
  accountFingerprint: string | null;
  weeklyWindowResetsAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}>;

export type AccountRateLimitResetPolicyDecision =
  | Readonly<{
      decision: "allow";
      reason: "active";
      policy: AccountRateLimitResetPolicyRecord;
    }>
  | Readonly<{
      decision: "suppress";
      reason: "reconciliation_window";
      policy: AccountRateLimitResetPolicyRecord;
    }>
  | Readonly<{
      decision: "block";
      reason:
        | "weekly_window_unavailable"
        | "weekly_window_nonmonotonic"
        | "account_identity_changed";
      policy: AccountRateLimitResetPolicyRecord;
    }>;

const accountRateLimitResetAttemptRowSchema = z.object({
  attempt_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotency_key: z.string().uuid(),
  profile_id: profileIdSchema,
  origin_process_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  current_process_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  account_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  weekly_window_resets_at: unixMillisecondsSchema,
  observed_used_percent: z.number().finite().min(99).max(100),
  state: accountRateLimitResetAttemptStateSchema,
  outcome: accountRateLimitResetOutcomeSchema.nullable(),
  local_resolution: accountRateLimitResetLocalResolutionSchema.nullable(),
  created_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const accountRateLimitResetRebindRowSchema = z.object({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotency_key: z.string().uuid(),
  from_process_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  to_process_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  account_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  created_at: unixMillisecondsSchema,
}).strict();

const accountRateLimitResetPolicyRowSchema = z.object({
  profile_id: profileIdSchema,
  state: accountRateLimitResetPolicyStateSchema,
  account_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  weekly_window_resets_at: unixMillisecondsSchema.nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  created_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const mapAccountRateLimitResetAttempt = (
  value: unknown,
): AccountRateLimitResetAttemptRecord => {
  const row = accountRateLimitResetAttemptRowSchema.parse(value);
  return {
    attemptSequence: row.attempt_sequence,
    idempotencyKey: row.idempotency_key,
    profileId: row.profile_id,
    originProcessGeneration: row.origin_process_generation,
    currentProcessGeneration: row.current_process_generation,
    accountFingerprint: row.account_fingerprint,
    weeklyWindowResetsAt: row.weekly_window_resets_at,
    observedUsedPercent: row.observed_used_percent,
    state: row.state,
    outcome: row.outcome,
    localResolution: row.local_resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const mapAccountRateLimitResetRebind = (
  value: unknown,
): AccountRateLimitResetRebindRecord => {
  const row = accountRateLimitResetRebindRowSchema.parse(value);
  return {
    sequence: row.sequence,
    idempotencyKey: row.idempotency_key,
    fromProcessGeneration: row.from_process_generation,
    toProcessGeneration: row.to_process_generation,
    accountFingerprint: row.account_fingerprint,
    createdAt: row.created_at,
  };
};

const mapAccountRateLimitResetPolicy = (
  value: unknown,
): AccountRateLimitResetPolicyRecord => {
  const row = accountRateLimitResetPolicyRowSchema.parse(value);
  const isUnbound = row.state === "active_unbound"
    || row.state === "reconciliation_required";
  const hasNoBinding = row.account_fingerprint === null
    && row.weekly_window_resets_at === null;
  const hasCompleteBinding = row.account_fingerprint !== null
    && row.weekly_window_resets_at !== null;
  if (
    (isUnbound && !hasNoBinding)
    || (!isUnbound && !hasCompleteBinding)
    || row.updated_at < row.created_at
  ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_SHAPE_INVALID");
  return {
    profileId: row.profile_id,
    state: row.state,
    accountFingerprint: row.account_fingerprint,
    weeklyWindowResetsAt: row.weekly_window_resets_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export type QueueRecord = {
  id: QueueId;
  sessionId: SessionId;
  message: string;
  state: QueueState;
  createdAt: number;
  updatedAt: number;
};

export type MutationAttemptRecord = {
  id: AttemptId;
  idempotencyKey: string;
  kind: string;
  authorityId: string;
  authorityGeneration: number;
  requestDigest: string;
  state: MutationState;
  result?: unknown;
  originalState?: Exclude<MutationState, "reconciled">;
  resolution?: MutationResolutionRecord;
  evidence?: MutationEffectEvidenceRecord;
  sessionStartId?: SessionId;
};

export type PendingLoginAuthority = {
  attemptId: AttemptId;
  idempotencyKey: string;
  profileId: ProfileId;
  processGeneration: number;
  loginId: string;
};

export type SessionProviderBaseline = {
  providerUpdatedAt: number | null;
  status: "active" | "idle" | "terminal";
  activeTurnId: string | null;
};

export type MutationEffectEvidence =
  | { kind: "session.send"; providerThreadId: string; baseline: SessionProviderBaseline; clientMessageId: string; messageDigest: string; runtimeProfile?: EffectiveRuntimeProfile }
  | { kind: "session.steer"; providerThreadId: string; baseline: SessionProviderBaseline; activeTurnId: string | null; clientMessageId: string; messageDigest: string }
  | { kind: "session.stop"; providerThreadId: string; baseline: SessionProviderBaseline; activeTurnId: string | null }
  | { kind: "session.rename"; providerThreadId: string; baseline: SessionProviderBaseline; requestedName: string }
  | { kind: "session.start"; projectId: ProjectId; clientMessageId: string | null; messageDigest: string | null; runtimeProfile?: EffectiveRuntimeProfile; conversationAutomationCapability?: typeof SESSION_CONVERSATION_AUTOMATION_CAPABILITY }
  | { kind: "account.login"; method: "browser" | "device_code" }
  | { kind: "account.logout"; baselineSignedIn: boolean }
  | { kind: "account.login-cancel"; loginId: string };

export type MutationEffectEvidenceRecord = {
  attemptId: AttemptId;
  digest: string;
  evidence: MutationEffectEvidence;
  recordedAt: number;
};

export type MutationResolutionRecord = {
  kind: "proven_applied" | "provider_state_reconciled" | "abandoned";
  evidence: unknown;
  receipt?: unknown;
  createdAt: number;
};

export type QueueEffectEvidence = {
  kind: "queue.dispatch";
  queueId: QueueId;
  sessionId: SessionId;
  providerThreadId: string;
  profileGeneration: number;
  baseline: SessionProviderBaseline;
  clientMessageId: string;
  messageDigest: string;
  runtimeProfile: EffectiveRuntimeProfile;
};

export type QueueEffectEvidenceRecord = {
  queueId: QueueId;
  digest: string;
  evidence: QueueEffectEvidence;
  recordedAt: number;
  resolution?: { kind: "proven_applied" | "abandoned"; evidence: unknown; receipt?: unknown; createdAt: number };
};

const desktopSwitchPhaseSchema = z.enum([
  "prepared",
  "quit_started",
  "quit_confirmed",
  "launch_started",
  "verify_started",
  "applied",
  "failed",
  "ambiguous",
]);
const desktopSwitchStageSchema = z.enum([
  "prepared",
  "quit-requested",
  "source-quiesced",
  "launch-requested",
  "target-observed",
  "verified",
  "recovery-required",
]);
const desktopDiagnosticSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u);
const desktopAccountKeySchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.normalize("NFKC").toLocaleLowerCase("en-US"));
const positiveGenerationSchema = z.number().int().positive();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const canonicalAccountFingerprint = (email: string): string =>
  sha256Schema.parse(createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex"));
const providerThreadIdSchema = z.string().min(1).max(200);
const providerLoginIdSchema = z.string().min(1).max(512).refine(
  (value) => !/\p{Cc}/u.test(value),
  "Provider login ID contains control characters.",
);
const pendingLoginReceiptAuthoritySchema = z.object({
  status: z.literal("pending"),
  loginId: providerLoginIdSchema,
}).passthrough();
const providerBaselineSchema = z.object({
  providerUpdatedAt: z.number().nonnegative().nullable(),
  status: z.enum(["active", "idle", "terminal"]),
  activeTurnId: z.string().min(1).max(200).nullable(),
}).strict();
const mutationEffectEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session.send"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, clientMessageId: z.string().min(1).max(512), messageDigest: sha256Schema, runtimeProfile: effectiveRuntimeProfileSchema.optional() }).strict(),
  z.object({ kind: z.literal("session.steer"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, activeTurnId: z.string().min(1).max(200).nullable(), clientMessageId: z.string().min(1).max(512), messageDigest: sha256Schema }).strict(),
  z.object({ kind: z.literal("session.stop"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, activeTurnId: z.string().min(1).max(200).nullable() }).strict(),
  z.object({ kind: z.literal("session.rename"), providerThreadId: providerThreadIdSchema, baseline: providerBaselineSchema, requestedName: titleSchema }).strict(),
  z.object({ kind: z.literal("session.start"), projectId: projectIdSchema, clientMessageId: z.string().min(1).max(512).nullable(), messageDigest: sha256Schema.nullable(), runtimeProfile: effectiveRuntimeProfileSchema.optional(), conversationAutomationCapability: z.literal(SESSION_CONVERSATION_AUTOMATION_CAPABILITY).optional() }).strict(),
  z.object({ kind: z.literal("account.login"), method: z.enum(["browser", "device_code"]) }).strict(),
  z.object({ kind: z.literal("account.logout"), baselineSignedIn: z.boolean() }).strict(),
  z.object({ kind: z.literal("account.login-cancel"), loginId: providerLoginIdSchema }).strict(),
]);
const queueEffectEvidenceSchema = z.object({
  kind: z.literal("queue.dispatch"),
  queueId: queueIdSchema,
  sessionId: sessionIdSchema,
  providerThreadId: providerThreadIdSchema,
  profileGeneration: z.number().int().nonnegative(),
  baseline: providerBaselineSchema,
  clientMessageId: z.string().min(1).max(512),
  messageDigest: sha256Schema,
  runtimeProfile: effectiveRuntimeProfileSchema,
}).strict();
const mutationResolutionKindSchema = z.enum(["proven_applied", "provider_state_reconciled", "abandoned"]);
const desktopRecoveryResolutionSchema = z.enum(["resolved_applied", "resolved_not_applied"]);
const desktopSwitchBeginSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    requestedSource: z
      .object({
        profileId: profileIdSchema,
        processGeneration: positiveGenerationSchema,
      })
      .strict()
      .optional(),
    target: z
      .object({
        profileId: profileIdSchema,
        processGeneration: positiveGenerationSchema,
      })
      .strict(),
  })
  .strict();

type DesktopSwitchPlan =
  | {
      status: "ready";
      idempotencyKey: string;
      switchGeneration: number;
      sourceProfileId: ProfileId | null;
      sourceProcessGeneration: number | null;
      targetProfileId: ProfileId;
      targetProcessGeneration: number;
      journalStage: "new" | "prepared";
      expectedAccountKey: string;
    }
  | {
      status: "applied";
      idempotencyKey: string;
      switchGeneration: number;
      sourceProfileId: ProfileId | null;
      sourceProcessGeneration: number | null;
      targetProfileId: ProfileId;
      targetProcessGeneration: number;
      expectedAccountKey: string;
      activeAccount: { signedIn: true; email: string; plan?: string };
    }
  | {
      status: "recovery_required";
      idempotencyKey: string;
      switchGeneration: number;
      sourceProfileId: ProfileId | null;
      sourceProcessGeneration: number | null;
      targetProfileId: ProfileId;
      targetProcessGeneration: number;
      diagnostic: string;
    };

const currentSchemaVersion = 30;
const observationTitleMaximumBytes = 320;

const safeObservationTitle = (value: string): string => {
  const redacted = redactAbsolutePaths(redactCompleteSensitiveText(value, "[protected]"));
  if (utf8Bytes(redacted) <= observationTitleMaximumBytes) return titleSchema.parse(redacted);
  const marker = " [truncated]";
  const availableBytes = observationTitleMaximumBytes - utf8Bytes(marker);
  let prefix = "";
  let prefixBytes = 0;
  for (const scalar of redacted) {
    const scalarBytes = utf8Bytes(scalar);
    if (prefixBytes + scalarBytes > availableBytes) break;
    prefix += scalar;
    prefixBytes += scalarBytes;
  }
  return titleSchema.parse(`${prefix.trimEnd()}${marker}`);
};
const stateBusyTimeoutMs = 5_000;

// The scrub checkpoint waits inside SQLite's busy handler for readers that
// still hold an older WAL snapshot, then retries with doubling backoff. The
// default uses the connection's normal 5 s wait for each of three attempts.
// Only tests pass a shorter policy; CLI and daemon composition never do, and
// the schema forbids a longer wait or more attempts than the default.
export type SecurityScrubCheckpointPolicy = Readonly<{
  busyTimeoutMs: number;
  attempts: number;
  backoffMs: number;
}>;
const securityScrubCheckpointPolicySchema = z.object({
  busyTimeoutMs: z.number().int().min(1).max(stateBusyTimeoutMs),
  attempts: z.number().int().min(1).max(3),
  backoffMs: z.number().int().min(0).max(1_000),
}).strict();
const defaultSecurityScrubCheckpointPolicy: SecurityScrubCheckpointPolicy = {
  busyTimeoutMs: stateBusyTimeoutMs,
  attempts: 3,
  backoffMs: 100,
};

type StateDatabaseFileIdentity = Readonly<{ device: number; inode: number }>;

const stateDatabaseFileIsSafe = (metadata: Stats): boolean => {
  const owner = process.getuid?.();
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (metadata.mode & 0o777) === 0o600
    && (owner === undefined || metadata.uid === owner);
};

const assertStateDatabaseFile = (
  path: string,
  expected?: StateDatabaseFileIdentity,
): StateDatabaseFileIdentity => {
  try {
    const metadata = lstatSync(path);
    if (
      !stateDatabaseFileIsSafe(metadata)
      || realpathSync(path) !== resolve(path)
      || (expected !== undefined
        && (metadata.dev !== expected.device || metadata.ino !== expected.inode))
    ) throw new Error("STATE_DATABASE_FILE_UNSAFE");
    return { device: metadata.dev, inode: metadata.ino };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "STATE_DATABASE_FILE_UNSAFE") throw error;
    throw new Error("STATE_DATABASE_FILE_UNSAFE", { cause: error });
  }
};

const prepareStateDatabaseFile = (
  path: string,
  readonly: boolean,
): StateDatabaseFileIdentity => {
  let descriptor: number | undefined;
  let created = false;
  try {
    if (!readonly) {
      try {
        descriptor = openSync(
          path,
          constants.O_CREAT
            | constants.O_EXCL
            | constants.O_RDWR
            | constants.O_NOFOLLOW
            | constants.O_NONBLOCK,
          0o600,
        );
        created = true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    descriptor ??= openSync(
      path,
      (readonly ? constants.O_RDONLY : constants.O_RDWR)
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
    );
    if (created) fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor);
    if (!stateDatabaseFileIsSafe(opened)) throw new Error("STATE_DATABASE_FILE_UNSAFE");
    const identity = { device: opened.dev, inode: opened.ino };
    assertStateDatabaseFile(path, identity);
    return identity;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "STATE_DATABASE_FILE_UNSAFE") throw error;
    throw new Error("STATE_DATABASE_FILE_UNSAFE", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const stateDatabaseOpenFlags = (readonly: boolean): number =>
  sqliteConstants.SQLITE_OPEN_NOFOLLOW
  | (readonly
    ? sqliteConstants.SQLITE_OPEN_READONLY
    : sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_CREATE);

export const USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS = 24 * 60 * 60_000;
export const USAGE_CLOUD_UPLOAD_ANCHOR_COUNT = 128;
export const USAGE_LOCAL_RETAIN_AGE_MS = 24 * 60 * 60_000;
export const USAGE_LOCAL_RETAIN_SUCCESS_COUNT = 2_048;
export const USAGE_LOCAL_RETAIN_FAILURE_COUNT = 2_048;
export const USAGE_LOCAL_RETAIN_BYTES = 16 * 1_024 * 1_024;
export const USAGE_LOCAL_SNAPSHOT_MAX_BYTES = 262_144;

const schemaVersion1 = `
CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL CHECK(applied_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS daemon_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  boot_id TEXT,
  started_at INTEGER,
  stopped_at INTEGER
) STRICT;
INSERT OR IGNORE INTO daemon_state(singleton, generation) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY CHECK(id GLOB 'acct_[0-9a-f]*' AND length(id) = 37),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
  state TEXT NOT NULL CHECK(state IN ('signed_out','login_pending','signed_in','recovery_required','removed')),
  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
  provider_email TEXT,
  provider_plan TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_label_active ON profiles(lower(label)) WHERE state != 'removed';
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY CHECK(id GLOB 'proj_[0-9a-f]*' AND length(id) = 37),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
  root_path TEXT NOT NULL UNIQUE,
  is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_default_project ON projects(is_default) WHERE is_default = 1;
CREATE UNIQUE INDEX IF NOT EXISTS projects_label_unique ON projects(lower(label));
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY CHECK(id GLOB 'sess_[0-9a-f]*' AND length(id) = 37),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  project_id TEXT REFERENCES projects(id),
  provider_thread_id TEXT,
  title TEXT NOT NULL CHECK(length(title) <= 320),
  note TEXT NOT NULL DEFAULT '' CHECK(length(CAST(note AS BLOB)) <= 16384),
  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),
  fast_enabled INTEGER NOT NULL CHECK(fast_enabled IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('starting','active','idle','terminal','recovery_required')),
  active_turn_id TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(profile_id, provider_thread_id)
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_recent ON sessions(updated_at DESC, id);
CREATE TABLE IF NOT EXISTS session_states (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('working','needs_approval','needs_answer','needs_action','done','done_followups','done_caveats','aborted')),
  attention INTEGER NOT NULL CHECK(attention IN (0,1)),
  reason TEXT NOT NULL CHECK(length(reason) <= 256),
  verbatim_required INTEGER NOT NULL CHECK(verbatim_required IN (0,1)),
  verbatim_literal TEXT CHECK(verbatim_literal IS NULL OR length(verbatim_literal) <= 200),
  last_activity_at INTEGER NOT NULL CHECK(last_activity_at >= 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS queue_entries (
  id TEXT PRIMARY KEY CHECK(id GLOB 'queue_[0-9a-f]*' AND length(id) = 38),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK(length(CAST(message AS BLOB)) BETWEEN 1 AND 262144),
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','applied','failed','ambiguous','cancelled')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
CREATE INDEX IF NOT EXISTS queue_pending ON queue_entries(session_id, created_at, id) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS mutation_attempts (
  id TEXT PRIMARY KEY CHECK(id GLOB 'attempt_[0-9a-f]*' AND length(id) = 40),
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
  authority_id TEXT NOT NULL CHECK(length(authority_id) BETWEEN 1 AND 200),
  authority_generation INTEGER NOT NULL CHECK(authority_generation >= 0),
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','applied','failed','ambiguous','cancelled')),
  result_json TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_snapshots (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) <= 262144),
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  PRIMARY KEY(profile_id, source_revision)
) STRICT;
CREATE TABLE IF NOT EXISTS turn_summaries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  summary_json TEXT NOT NULL CHECK(length(CAST(summary_json AS BLOB)) <= 1048576),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(session_id, turn_id),
  UNIQUE(session_id, sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS desktop_switches (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  source_profile_id TEXT REFERENCES profiles(id),
  target_profile_id TEXT NOT NULL REFERENCES profiles(id),
  source_generation INTEGER,
  target_generation INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','quit_started','quit_confirmed','launch_started','verify_started','applied','failed','ambiguous')),
  diagnostic_code TEXT,
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE TRIGGER IF NOT EXISTS mutation_transition_guard BEFORE UPDATE OF state ON mutation_attempts
WHEN NOT (
  (OLD.state = 'prepared' AND NEW.state IN ('effect_started','cancelled')) OR
  (OLD.state = 'effect_started' AND NEW.state IN ('applied','failed','ambiguous')) OR
  OLD.state = NEW.state
)
BEGIN SELECT RAISE(ABORT, 'illegal mutation transition'); END;
`;

const schemaVersion3 = `
CREATE TABLE IF NOT EXISTS desktop_switch_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  current_generation INTEGER NOT NULL CHECK(current_generation >= 0),
  current_attempt_id TEXT REFERENCES mutation_attempts(id),
  CHECK(
    (current_generation = 0 AND current_attempt_id IS NULL) OR
    (current_generation > 0 AND current_attempt_id IS NOT NULL)
  )
) STRICT;
INSERT OR IGNORE INTO desktop_switch_authority(singleton,current_generation,current_attempt_id)
VALUES (1,0,NULL);
CREATE UNIQUE INDEX IF NOT EXISTS desktop_switch_generation_unique
  ON desktop_switches(switch_generation) WHERE switch_generation IS NOT NULL;
DROP TRIGGER IF EXISTS queue_transition_guard;
CREATE TRIGGER queue_transition_guard BEFORE UPDATE OF state ON queue_entries
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('dispatching','cancelled')) OR
  (OLD.state = 'dispatching' AND NEW.state IN ('applied','failed','ambiguous'))
)
BEGIN SELECT RAISE(ABORT, 'illegal queue transition'); END;
DROP TRIGGER IF EXISTS desktop_switch_transition_guard;
CREATE TRIGGER desktop_switch_transition_guard BEFORE UPDATE OF phase ON desktop_switches
WHEN NOT (
  (OLD.phase = 'prepared' AND NEW.phase IN ('prepared','quit_started','launch_started','ambiguous')) OR
  (OLD.phase = 'quit_started' AND NEW.phase IN ('quit_started','quit_confirmed','ambiguous')) OR
  (OLD.phase = 'quit_confirmed' AND NEW.phase IN ('quit_confirmed','launch_started','ambiguous')) OR
  (OLD.phase = 'launch_started' AND NEW.phase IN ('launch_started','verify_started','ambiguous')) OR
  (OLD.phase = 'verify_started' AND NEW.phase IN ('verify_started','applied','ambiguous')) OR
  OLD.phase = NEW.phase
)
BEGIN SELECT RAISE(ABORT, 'illegal desktop switch transition'); END;
`;

const schemaVersion4 = `
CREATE TABLE IF NOT EXISTS mutation_effect_evidence (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS session_start_attempts (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  session_id TEXT NOT NULL UNIQUE CHECK(session_id GLOB 'sess_[0-9a-f]*' AND length(session_id) = 37),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS mutation_resolutions (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('proven_applied','provider_state_reconciled','abandoned')),
  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
  receipt_json TEXT CHECK(receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= 262144),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TRIGGER IF NOT EXISTS mutation_effect_evidence_immutable_update
BEFORE UPDATE ON mutation_effect_evidence
BEGIN SELECT RAISE(ABORT, 'mutation effect evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS mutation_effect_evidence_immutable_delete
BEFORE DELETE ON mutation_effect_evidence
BEGIN SELECT RAISE(ABORT, 'mutation effect evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_start_attempts_immutable_update
BEFORE UPDATE ON session_start_attempts
BEGIN SELECT RAISE(ABORT, 'session start binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_start_attempts_immutable_delete
BEFORE DELETE ON session_start_attempts
BEGIN SELECT RAISE(ABORT, 'session start binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS mutation_resolutions_immutable_update
BEFORE UPDATE ON mutation_resolutions
BEGIN SELECT RAISE(ABORT, 'mutation resolution is immutable'); END;
CREATE TRIGGER IF NOT EXISTS mutation_resolutions_immutable_delete
BEFORE DELETE ON mutation_resolutions
BEGIN SELECT RAISE(ABORT, 'mutation resolution is immutable'); END;
`;

const schemaVersion5 = `
CREATE TABLE IF NOT EXISTS desktop_switch_resolutions (
  attempt_id TEXT PRIMARY KEY REFERENCES desktop_switches(attempt_id),
  switch_generation INTEGER NOT NULL CHECK(switch_generation > 0),
  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('resolved_applied','resolved_not_applied')),
  diagnostic_code TEXT NOT NULL CHECK(diagnostic_code GLOB '[A-Z]*' AND length(diagnostic_code) BETWEEN 1 AND 80),
  observation_digest TEXT NOT NULL CHECK(length(observation_digest) = 64),
  receipt_json TEXT NOT NULL CHECK(length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 262144),
  resolved_at INTEGER NOT NULL CHECK(resolved_at >= 0)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS desktop_switch_resolution_generation_unique
  ON desktop_switch_resolutions(switch_generation);
CREATE TRIGGER IF NOT EXISTS desktop_switch_resolutions_immutable_update
BEFORE UPDATE ON desktop_switch_resolutions
BEGIN SELECT RAISE(ABORT, 'desktop switch resolution is immutable'); END;
CREATE TRIGGER IF NOT EXISTS desktop_switch_resolutions_immutable_delete
BEFORE DELETE ON desktop_switch_resolutions
BEGIN SELECT RAISE(ABORT, 'desktop switch resolution is immutable'); END;
DROP TRIGGER IF EXISTS desktop_switch_transition_guard;
CREATE TRIGGER desktop_switch_transition_guard BEFORE UPDATE OF phase ON desktop_switches
WHEN NOT (
  (OLD.phase = 'prepared' AND NEW.phase IN ('prepared','quit_started','launch_started','failed','ambiguous')) OR
  (OLD.phase = 'quit_started' AND NEW.phase IN ('quit_started','quit_confirmed','ambiguous')) OR
  (OLD.phase = 'quit_confirmed' AND NEW.phase IN ('quit_confirmed','launch_started','ambiguous')) OR
  (OLD.phase = 'launch_started' AND NEW.phase IN ('launch_started','verify_started','ambiguous')) OR
  (OLD.phase = 'verify_started' AND NEW.phase IN ('verify_started','applied','ambiguous')) OR
  OLD.phase = NEW.phase
)
BEGIN SELECT RAISE(ABORT, 'illegal desktop switch transition'); END;
`;

const schemaVersion6 = `
CREATE TABLE IF NOT EXISTS session_runtime_profiles (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('session_start','turn_start','queue_start')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  profile_json TEXT NOT NULL CHECK(length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 262144),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(session_id, revision),
  UNIQUE(source_kind, source_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS session_runtime_profile_authority_guard
BEFORE INSERT ON session_runtime_profiles
WHEN NOT EXISTS(
  SELECT 1 FROM sessions s
  WHERE s.id=NEW.session_id AND s.profile_id=NEW.profile_id
)
BEGIN SELECT RAISE(ABORT, 'runtime profile session authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS session_runtime_profiles_immutable_update
BEFORE UPDATE ON session_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'session runtime profile is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_runtime_profiles_immutable_delete
BEFORE DELETE ON session_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'session runtime profile is immutable'); END;
`;

const schemaVersion7 = `
CREATE TABLE IF NOT EXISTS queue_effect_evidence (
  queue_id TEXT PRIMARY KEY REFERENCES queue_entries(id),
  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS queue_effect_resolutions (
  queue_id TEXT PRIMARY KEY REFERENCES queue_effect_evidence(queue_id),
  resolution_kind TEXT NOT NULL CHECK(resolution_kind IN ('proven_applied','abandoned')),
  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 262144),
  receipt_json TEXT CHECK(receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= 262144),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TRIGGER IF NOT EXISTS queue_effect_evidence_immutable_update
BEFORE UPDATE ON queue_effect_evidence
BEGIN SELECT RAISE(ABORT, 'queue effect evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_effect_evidence_immutable_delete
BEFORE DELETE ON queue_effect_evidence
BEGIN SELECT RAISE(ABORT, 'queue effect evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_effect_resolutions_immutable_update
BEFORE UPDATE ON queue_effect_resolutions
BEGIN SELECT RAISE(ABORT, 'queue effect resolution is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_effect_resolutions_immutable_delete
BEFORE DELETE ON queue_effect_resolutions
BEGIN SELECT RAISE(ABORT, 'queue effect resolution is immutable'); END;
`;

const schemaVersion8 = `
CREATE TABLE IF NOT EXISTS session_turn_runtime_profiles (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 200),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('turn_start','queue_start')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  profile_json TEXT NOT NULL CHECK(length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 262144),
  profile_digest TEXT NOT NULL CHECK(length(profile_digest) = 64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(session_id, turn_id),
  UNIQUE(source_kind, source_id),
  FOREIGN KEY(source_kind, source_id)
    REFERENCES session_runtime_profiles(source_kind, source_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS session_turn_runtime_profile_authority_guard
BEFORE INSERT ON session_turn_runtime_profiles
WHEN NOT EXISTS(
  SELECT 1 FROM session_runtime_profiles p
  WHERE p.session_id=NEW.session_id
    AND p.source_kind=NEW.source_kind
    AND p.source_id=NEW.source_id
    AND p.profile_id=NEW.profile_id
    AND p.process_generation=NEW.process_generation
    AND p.observed_at=NEW.observed_at
    AND p.profile_json=NEW.profile_json
)
BEGIN SELECT RAISE(ABORT, 'turn runtime profile source authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS session_turn_runtime_profiles_immutable_update
BEFORE UPDATE ON session_turn_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'turn runtime profile is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_turn_runtime_profiles_immutable_delete
BEFORE DELETE ON session_turn_runtime_profiles
BEGIN SELECT RAISE(ABORT, 'turn runtime profile is immutable'); END;
`;

const schemaVersion9 = `
CREATE TABLE IF NOT EXISTS session_event_streams (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  stream_epoch TEXT NOT NULL CHECK(
    length(stream_epoch) = 36
    AND substr(stream_epoch,9,1) = '-'
    AND substr(stream_epoch,14,1) = '-'
    AND substr(stream_epoch,19,1) = '-'
    AND substr(stream_epoch,24,1) = '-'
  ),
  next_sequence INTEGER NOT NULL CHECK(next_sequence BETWEEN 1 AND 9007199254740991),
  floor_sequence INTEGER NOT NULL CHECK(floor_sequence BETWEEN 1 AND next_sequence),
  observed_through_sequence INTEGER NOT NULL CHECK(
    observed_through_sequence BETWEEN 0 AND 9007199254740991
    AND observed_through_sequence = next_sequence - 1
  ),
  retained_count INTEGER NOT NULL CHECK(retained_count >= 0),
  retained_bytes INTEGER NOT NULL CHECK(retained_bytes >= 0),
  retention_gap_reason TEXT CHECK(retention_gap_reason IS NULL OR retention_gap_reason IN (
    'retention_count','retention_age','retention_bytes'
  )),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(session_id, stream_epoch)
) STRICT;
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  account_id TEXT NOT NULL REFERENCES profiles(id),
  provider_generation INTEGER NOT NULL CHECK(provider_generation >= 0),
  provider_connection_id TEXT CHECK(provider_connection_id IS NULL OR length(provider_connection_id) = 36),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  event_bytes INTEGER NOT NULL CHECK(
    event_bytes = length(CAST(event_json AS BLOB))
    AND event_bytes BETWEEN 2 AND ${SESSION_EVENT_MAX_BYTES}
  ),
  PRIMARY KEY(session_id, sequence),
  FOREIGN KEY(session_id, stream_epoch)
    REFERENCES session_event_streams(session_id, stream_epoch) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS session_events_age
  ON session_events(session_id, recorded_at, sequence);
CREATE TRIGGER IF NOT EXISTS session_events_immutable_update
BEFORE UPDATE ON session_events
BEGIN SELECT RAISE(ABORT, 'session event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS session_events_account_authority_guard
BEFORE INSERT ON session_events
WHEN NOT EXISTS(
  SELECT 1 FROM sessions s JOIN profiles p ON p.id=s.profile_id
  WHERE s.id=NEW.session_id
    AND s.profile_id=NEW.account_id
    AND p.process_generation=NEW.provider_generation
)
BEGIN SELECT RAISE(ABORT, 'session event account authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS session_events_accounting_insert
AFTER INSERT ON session_events
BEGIN
  UPDATE session_event_streams
  SET retained_count=retained_count+1,
      retained_bytes=retained_bytes+NEW.event_bytes
  WHERE session_id=NEW.session_id AND stream_epoch=NEW.stream_epoch;
END;
CREATE TRIGGER IF NOT EXISTS session_events_accounting_delete
AFTER DELETE ON session_events
BEGIN
  UPDATE session_event_streams
  SET retained_count=retained_count-1,
      retained_bytes=retained_bytes-OLD.event_bytes
  WHERE session_id=OLD.session_id AND stream_epoch=OLD.stream_epoch;
END;

CREATE TABLE IF NOT EXISTS provider_interactions (
  public_id TEXT PRIMARY KEY CHECK(length(public_id) = 36),
  session_id TEXT REFERENCES sessions(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
  connection_id TEXT NOT NULL CHECK(length(connection_id) = 36),
  request_id_type TEXT NOT NULL CHECK(request_id_type IN ('number','string')),
  request_id_number INTEGER CHECK(request_id_number IS NULL OR request_id_number BETWEEN -9007199254740991 AND 9007199254740991),
  request_id_text TEXT CHECK(request_id_text IS NULL OR length(request_id_text) BETWEEN 1 AND 512),
  method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 512),
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  thread_id TEXT CHECK(thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 512),
  turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 512),
  item_id TEXT CHECK(item_id IS NULL OR length(item_id) BETWEEN 1 AND 512),
  approval_id TEXT CHECK(approval_id IS NULL OR length(approval_id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK(kind IN (
    'command_approval','file_change_approval','permission_approval','user_input','mcp_elicitation'
  )),
  state TEXT NOT NULL CHECK(state IN (
    'pending','response_prepared','response_written','resolved','declined','canceled','expired','resolution_unknown'
  )),
  revision INTEGER NOT NULL CHECK(revision > 0),
  blocking INTEGER NOT NULL CHECK(blocking IN (0,1)),
  display_json TEXT NOT NULL CHECK(json_valid(display_json) AND length(CAST(display_json AS BLOB)) BETWEEN 2 AND 65536),
  response_digest TEXT CHECK(response_digest IS NULL OR length(response_digest) = 64),
  response_expected_revision INTEGER CHECK(response_expected_revision IS NULL OR response_expected_revision > 0),
  requested_at INTEGER NOT NULL CHECK(requested_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= requested_at),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= requested_at),
  CHECK(
    (request_id_type='number' AND request_id_number IS NOT NULL AND request_id_text IS NULL)
    OR
    (request_id_type='string' AND request_id_number IS NULL AND request_id_text IS NOT NULL)
  ),
  CHECK(
    (state='pending' AND response_digest IS NULL AND response_expected_revision IS NULL)
    OR
    (state!='pending' AND (
      (response_digest IS NOT NULL AND response_expected_revision IS NOT NULL)
      OR state IN ('resolved','canceled','expired','resolution_unknown')
    ))
  ),
  CHECK(
    (state IN ('pending','response_prepared','response_written') AND terminal_at IS NULL)
    OR
    (state IN ('resolved','declined','canceled','expired','resolution_unknown') AND terminal_at IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS provider_interactions_numeric_request
  ON provider_interactions(profile_id,process_generation,connection_id,request_id_number)
  WHERE request_id_type='number';
CREATE UNIQUE INDEX IF NOT EXISTS provider_interactions_string_request
  ON provider_interactions(profile_id,process_generation,connection_id,request_id_text)
  WHERE request_id_type='string';
CREATE INDEX IF NOT EXISTS provider_interactions_pending
  ON provider_interactions(profile_id,process_generation,requested_at,public_id)
  WHERE state IN ('pending','response_prepared','response_written');
CREATE INDEX IF NOT EXISTS provider_interactions_session
  ON provider_interactions(session_id,requested_at DESC,public_id);
CREATE TRIGGER IF NOT EXISTS provider_interactions_authority_guard
BEFORE INSERT ON provider_interactions
WHEN NOT EXISTS(
  SELECT 1 FROM profiles p
  WHERE p.id=NEW.profile_id
    AND p.process_generation=NEW.process_generation
    AND p.state!='removed'
    AND (
      NEW.session_id IS NULL
      OR EXISTS(
        SELECT 1 FROM sessions s
        WHERE s.id=NEW.session_id AND s.profile_id=NEW.profile_id
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'provider interaction authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_authority_immutable
BEFORE UPDATE OF session_id,profile_id,process_generation,connection_id,
  request_id_type,request_id_number,request_id_text,method,request_digest,
  thread_id,turn_id,item_id,approval_id,kind,blocking,display_json,requested_at
ON provider_interactions
BEGIN SELECT RAISE(ABORT, 'provider interaction authority is immutable'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_current_generation_prepare
BEFORE UPDATE OF state ON provider_interactions
WHEN NEW.state='response_prepared' AND NOT EXISTS(
  SELECT 1 FROM profiles p
  WHERE p.id=OLD.profile_id
    AND p.process_generation=OLD.process_generation
    AND p.state!='removed'
)
BEGIN SELECT RAISE(ABORT, 'provider interaction generation is stale'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_transition_guard
BEFORE UPDATE OF state ON provider_interactions
WHEN NOT (
  NEW.revision=OLD.revision+1
  AND (
    (OLD.state='pending' AND NEW.state IN ('response_prepared','resolved','declined','canceled','expired','resolution_unknown'))
    OR (OLD.state='response_prepared' AND NEW.state IN ('response_written','resolved','declined','canceled','expired','resolution_unknown'))
    OR (OLD.state='response_written' AND NEW.state IN ('resolved','declined','canceled','resolution_unknown'))
  )
)
BEGIN SELECT RAISE(ABORT, 'illegal provider interaction transition'); END;

CREATE TABLE IF NOT EXISTS provider_interaction_transitions (
  public_id TEXT NOT NULL REFERENCES provider_interactions(public_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN (
    'pending','response_prepared','response_written','resolved','declined','canceled','expired','resolution_unknown'
  )),
  response_digest TEXT CHECK(response_digest IS NULL OR length(response_digest) = 64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(public_id, revision)
) STRICT;
CREATE TRIGGER IF NOT EXISTS provider_interaction_transitions_immutable_update
BEFORE UPDATE ON provider_interaction_transitions
BEGIN SELECT RAISE(ABORT, 'provider interaction transition is immutable'); END;
CREATE TRIGGER IF NOT EXISTS provider_interaction_transitions_immutable_delete
BEFORE DELETE ON provider_interaction_transitions
BEGIN SELECT RAISE(ABORT, 'provider interaction transition is immutable'); END;

CREATE TABLE IF NOT EXISTS usage_revision_authority (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  next_revision INTEGER NOT NULL CHECK(next_revision BETWEEN 0 AND 9007199254740991)
) STRICT;
`;

const schemaVersion10 = `
CREATE TABLE IF NOT EXISTS usage_poll_failures (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  reason_code TEXT NOT NULL CHECK(reason_code IN ('account_usage_read_failed')),
  PRIMARY KEY(profile_id, source_revision)
) STRICT;
CREATE INDEX IF NOT EXISTS usage_poll_failures_recent
  ON usage_poll_failures(profile_id, observed_at DESC, source_revision DESC);
`;

const schemaVersion11 = `
CREATE TRIGGER IF NOT EXISTS provider_interactions_mcp_url_guard_insert
BEFORE INSERT ON provider_interactions
WHEN NEW.kind='mcp_elicitation' AND (
  json_extract(NEW.display_json,'$.mode')='url'
  OR COALESCE(json_type(NEW.display_json,'$.url'),'null')!='null'
)
BEGIN SELECT RAISE(ABORT, 'MCP URL interaction cannot enter durable state'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_mcp_url_guard_update
BEFORE UPDATE OF kind,display_json ON provider_interactions
WHEN NEW.kind='mcp_elicitation' AND (
  json_extract(NEW.display_json,'$.mode')='url'
  OR COALESCE(json_type(NEW.display_json,'$.url'),'null')!='null'
)
BEGIN SELECT RAISE(ABORT, 'MCP URL interaction cannot enter durable state'); END;
`;

const schemaVersion12 = `
CREATE TABLE IF NOT EXISTS usage_cloud_upload_anchors (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  received_at INTEGER NOT NULL CHECK(received_at >= 0),
  PRIMARY KEY(profile_id, source_revision)
) STRICT;
CREATE INDEX IF NOT EXISTS usage_cloud_upload_anchors_recent
  ON usage_cloud_upload_anchors(profile_id, source_revision DESC);
`;

const schemaVersion13 = `
CREATE TABLE IF NOT EXISTS security_scrub_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  reason TEXT NOT NULL CHECK(reason='mcp_url_redaction'),
  required_at INTEGER NOT NULL CHECK(required_at >= 0)
) STRICT;
`;

const schemaVersion14 = `
CREATE TABLE IF NOT EXISTS queue_sequence_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  next_sequence INTEGER NOT NULL CHECK(next_sequence BETWEEN 1 AND 9007199254740991)
) STRICT;
INSERT INTO queue_sequence_authority(singleton,next_sequence)
SELECT 1,1 WHERE NOT EXISTS(SELECT 1 FROM queue_sequence_authority WHERE singleton=1);
CREATE UNIQUE INDEX IF NOT EXISTS queue_enqueue_sequence_unique
  ON queue_entries(enqueue_sequence);
CREATE INDEX IF NOT EXISTS queue_pending_sequence
  ON queue_entries(session_id,enqueue_sequence) WHERE state='pending';
CREATE TRIGGER IF NOT EXISTS queue_enqueue_sequence_required
BEFORE INSERT ON queue_entries
WHEN NEW.enqueue_sequence IS NULL
BEGIN SELECT RAISE(ABORT, 'queue enqueue sequence required'); END;
CREATE TRIGGER IF NOT EXISTS queue_enqueue_identity_insert_once
BEFORE INSERT ON queue_entries
WHEN EXISTS(
  SELECT 1 FROM queue_entries
  WHERE id=NEW.id OR enqueue_sequence=NEW.enqueue_sequence
)
BEGIN SELECT RAISE(ABORT, 'queue enqueue identity already exists'); END;
CREATE TRIGGER IF NOT EXISTS queue_enqueue_sequence_immutable
BEFORE UPDATE OF enqueue_sequence ON queue_entries
WHEN NEW.enqueue_sequence IS NOT OLD.enqueue_sequence
BEGIN SELECT RAISE(ABORT, 'queue enqueue sequence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_sequence_authority_no_delete
BEFORE DELETE ON queue_sequence_authority
BEGIN SELECT RAISE(ABORT, 'queue sequence authority cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS queue_sequence_authority_insert_once
BEFORE INSERT ON queue_sequence_authority
WHEN EXISTS(SELECT 1 FROM queue_sequence_authority WHERE singleton=1)
BEGIN SELECT RAISE(ABORT, 'queue sequence authority already exists'); END;
CREATE TRIGGER IF NOT EXISTS queue_sequence_authority_singleton_immutable
BEFORE UPDATE OF singleton ON queue_sequence_authority
WHEN NEW.singleton IS NOT OLD.singleton
BEGIN SELECT RAISE(ABORT, 'queue sequence authority singleton is immutable'); END;
CREATE TRIGGER IF NOT EXISTS queue_sequence_authority_monotonic
BEFORE UPDATE OF next_sequence ON queue_sequence_authority
WHEN NEW.next_sequence<OLD.next_sequence
BEGIN SELECT RAISE(ABORT, 'queue sequence authority cannot regress'); END;
`;

const schemaVersion15 = `
CREATE TRIGGER IF NOT EXISTS provider_interactions_permission_value_guard_insert
BEFORE INSERT ON provider_interactions
WHEN NEW.kind='permission_approval' AND EXISTS(
  SELECT 1 FROM json_each(json_extract(NEW.display_json,'$.requested'))
  WHERE json_type(value,'$.value') IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'permission values cannot enter durable interaction display state'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_permission_value_guard_update
BEFORE UPDATE OF kind,display_json ON provider_interactions
WHEN NEW.kind='permission_approval' AND EXISTS(
  SELECT 1 FROM json_each(json_extract(NEW.display_json,'$.requested'))
  WHERE json_type(value,'$.value') IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'permission values cannot enter durable interaction display state'); END;
`;

const schemaVersion16 = `
CREATE INDEX IF NOT EXISTS provider_interactions_due
  ON provider_interactions(deadline_at,public_id)
  WHERE state='pending';
DROP TRIGGER IF EXISTS provider_interactions_authority_immutable;
CREATE TRIGGER provider_interactions_authority_immutable
BEFORE UPDATE OF session_id,profile_id,process_generation,connection_id,
  request_id_type,request_id_number,request_id_text,method,request_digest,
  thread_id,turn_id,item_id,approval_id,kind,blocking,display_json,requested_at,deadline_at
ON provider_interactions
BEGIN SELECT RAISE(ABORT, 'provider interaction authority is immutable'); END;
DROP TRIGGER IF EXISTS provider_interactions_transition_guard;
CREATE TRIGGER provider_interactions_transition_guard
BEFORE UPDATE OF state ON provider_interactions
WHEN NOT (
  NEW.revision=OLD.revision+1
  AND (
    (OLD.state='pending' AND NEW.state IN ('response_prepared','resolved','declined','canceled','expired','resolution_unknown'))
    OR (OLD.state='response_prepared' AND NEW.state IN ('response_written','resolved','declined','canceled','expired','resolution_unknown'))
    OR (OLD.state='response_written' AND NEW.state IN ('resolved','declined','canceled','expired','resolution_unknown'))
  )
)
BEGIN SELECT RAISE(ABORT, 'illegal provider interaction transition'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_intent_insert_guard
BEFORE INSERT ON provider_interactions
WHEN NEW.intended_terminal_state IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'pending provider interaction cannot have terminal intent'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_intent_immutable
BEFORE UPDATE OF intended_terminal_state ON provider_interactions
WHEN OLD.intended_terminal_state IS NOT NULL
  OR NEW.intended_terminal_state IS NULL
  OR OLD.state!='pending'
BEGIN SELECT RAISE(ABORT, 'provider interaction terminal intent is immutable'); END;
CREATE TRIGGER IF NOT EXISTS provider_interactions_intent_state_guard
BEFORE UPDATE OF state,intended_terminal_state ON provider_interactions
WHEN
  (NEW.state IN ('response_prepared','response_written') AND NEW.intended_terminal_state IS NULL)
  OR (
    OLD.state='response_written'
    AND NEW.state IN ('resolved','declined','canceled','expired')
    AND NEW.state IS NOT OLD.intended_terminal_state
  )
BEGIN SELECT RAISE(ABORT, 'provider interaction terminal state contradicts prepared intent'); END;
`;

const schemaVersion17 = `
CREATE TABLE IF NOT EXISTS provider_login_authorities (
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  process_generation INTEGER NOT NULL CHECK(process_generation > 0),
  login_id TEXT NOT NULL CHECK(length(login_id) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK(state IN ('active','settled')),
  settlement TEXT CHECK(settlement IS NULL OR settlement IN ('canceled','not_found','signed_in','provider_disconnected')),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= recorded_at),
  CHECK((state='active' AND settlement IS NULL) OR (state='settled' AND settlement IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS provider_login_authority_active_profile
  ON provider_login_authorities(profile_id) WHERE state='active';
CREATE TRIGGER IF NOT EXISTS provider_login_authority_identity_immutable
BEFORE UPDATE OF attempt_id,profile_id,login_id,recorded_at ON provider_login_authorities
BEGIN SELECT RAISE(ABORT, 'provider login identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS provider_login_authority_generation_guard
BEFORE UPDATE OF process_generation ON provider_login_authorities
WHEN OLD.state!='active' OR NEW.state!='active' OR NEW.process_generation!=OLD.process_generation+1
BEGIN SELECT RAISE(ABORT, 'illegal provider login generation transition'); END;
CREATE TRIGGER IF NOT EXISTS provider_login_authority_state_guard
BEFORE UPDATE OF state,settlement ON provider_login_authorities
WHEN NOT (
  OLD.state='active' AND NEW.state='settled' AND OLD.settlement IS NULL AND NEW.settlement IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'illegal provider login settlement transition'); END;
CREATE TRIGGER IF NOT EXISTS provider_login_authority_immutable_delete
BEFORE DELETE ON provider_login_authorities
BEGIN SELECT RAISE(ABORT, 'provider login authority is append-only'); END;
`;

const schemaVersion19 = `
DROP TRIGGER IF EXISTS provider_interactions_intent_immutable;
CREATE TRIGGER provider_interactions_intent_immutable
BEFORE UPDATE OF intended_terminal_state ON provider_interactions
WHEN NOT (
  (
    OLD.state='pending'
    AND NEW.state='response_prepared'
    AND OLD.intended_terminal_state IS NULL
    AND NEW.intended_terminal_state IS NOT NULL
    AND OLD.response_digest IS NULL
    AND NEW.response_digest IS NOT NULL
    AND OLD.response_expected_revision IS NULL
    AND NEW.response_expected_revision=OLD.revision
    AND NEW.revision=OLD.revision+1
  )
  OR
  (
    OLD.state='response_prepared'
    AND NEW.state='response_prepared'
    AND OLD.intended_terminal_state IN ('resolved','declined','canceled')
    AND NEW.intended_terminal_state='expired'
    AND OLD.response_digest IS NOT NULL
    AND NEW.response_digest IS NOT NULL
    AND NEW.response_digest!=OLD.response_digest
    AND NEW.response_expected_revision=OLD.response_expected_revision
    AND NEW.revision=OLD.revision+1
    AND NEW.terminal_at IS NULL
    AND NEW.updated_at>=OLD.deadline_at
  )
)
BEGIN SELECT RAISE(ABORT, 'provider interaction terminal intent is immutable'); END;
DROP TRIGGER IF EXISTS provider_interactions_response_fields_guard;
CREATE TRIGGER provider_interactions_response_fields_guard
BEFORE UPDATE OF response_digest,response_expected_revision ON provider_interactions
WHEN NOT (
  (
    OLD.state='pending'
    AND NEW.state='response_prepared'
    AND OLD.response_digest IS NULL
    AND NEW.response_digest IS NOT NULL
    AND OLD.response_expected_revision IS NULL
    AND NEW.response_expected_revision=OLD.revision
    AND OLD.intended_terminal_state IS NULL
    AND NEW.intended_terminal_state IS NOT NULL
    AND NEW.revision=OLD.revision+1
  )
  OR
  (
    OLD.state='response_prepared'
    AND NEW.state='response_prepared'
    AND OLD.intended_terminal_state IN ('resolved','declined','canceled')
    AND NEW.intended_terminal_state='expired'
    AND OLD.response_digest IS NOT NULL
    AND NEW.response_digest IS NOT NULL
    AND NEW.response_digest!=OLD.response_digest
    AND NEW.response_expected_revision=OLD.response_expected_revision
    AND NEW.revision=OLD.revision+1
    AND NEW.terminal_at IS NULL
    AND NEW.updated_at>=OLD.deadline_at
  )
)
BEGIN SELECT RAISE(ABORT, 'provider interaction response authority is immutable'); END;
DROP TRIGGER IF EXISTS provider_interactions_revision_guard;
CREATE TRIGGER provider_interactions_revision_guard
BEFORE UPDATE OF revision ON provider_interactions
WHEN NOT (
  NEW.revision=OLD.revision+1
  AND (
    NEW.state IS NOT OLD.state
    OR (
      OLD.state='response_prepared'
      AND NEW.state='response_prepared'
      AND OLD.intended_terminal_state IN ('resolved','declined','canceled')
      AND NEW.intended_terminal_state='expired'
      AND OLD.response_digest IS NOT NULL
      AND NEW.response_digest IS NOT NULL
      AND NEW.response_digest!=OLD.response_digest
      AND NEW.response_expected_revision=OLD.response_expected_revision
      AND NEW.terminal_at IS NULL
      AND NEW.updated_at>=OLD.deadline_at
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'illegal provider interaction revision transition'); END;
`;

const schemaVersion20 = `
CREATE INDEX IF NOT EXISTS provider_interactions_listing_global
  ON provider_interactions(requested_at DESC,public_id ASC);
CREATE INDEX IF NOT EXISTS provider_interactions_listing_session
  ON provider_interactions(session_id,requested_at DESC,public_id ASC);
CREATE INDEX IF NOT EXISTS provider_interactions_listing_pending_global
  ON provider_interactions(requested_at DESC,public_id ASC)
  WHERE state IN ('pending','response_prepared','response_written');
CREATE INDEX IF NOT EXISTS provider_interactions_listing_pending_session
  ON provider_interactions(session_id,requested_at DESC,public_id ASC)
  WHERE state IN ('pending','response_prepared','response_written');
`;

const settledQueueMessage = "[queue message removed after settlement]";

const schemaVersion21 = `
DROP TRIGGER IF EXISTS queue_message_settlement_guard;
CREATE TRIGGER queue_message_settlement_guard
BEFORE UPDATE OF message ON queue_entries
WHEN NOT (
  NEW.message='[queue message removed after settlement]'
  AND (
    NEW.state IN ('applied','failed','cancelled')
    OR EXISTS(
      SELECT 1 FROM queue_effect_resolutions r WHERE r.queue_id=OLD.id
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'queue message is immutable except for settlement removal'); END;
DROP TRIGGER IF EXISTS queue_message_terminal_insert_scrub;
CREATE TRIGGER queue_message_terminal_insert_scrub
AFTER INSERT ON queue_entries
WHEN NEW.state IN ('applied','failed','cancelled')
  AND NEW.message!='[queue message removed after settlement]'
BEGIN
  UPDATE queue_entries
  SET message='[queue message removed after settlement]'
  WHERE id=NEW.id;
END;
DROP TRIGGER IF EXISTS queue_message_terminal_transition_scrub;
CREATE TRIGGER queue_message_terminal_transition_scrub
AFTER UPDATE OF state ON queue_entries
WHEN NEW.state IN ('applied','failed','cancelled')
  AND NEW.message!='[queue message removed after settlement]'
BEGIN
  UPDATE queue_entries
  SET message='[queue message removed after settlement]'
  WHERE id=NEW.id;
END;
DROP TRIGGER IF EXISTS queue_message_resolution_scrub;
CREATE TRIGGER queue_message_resolution_scrub
AFTER INSERT ON queue_effect_resolutions
WHEN EXISTS(
  SELECT 1 FROM queue_entries q
  WHERE q.id=NEW.queue_id
    AND q.message!='[queue message removed after settlement]'
)
BEGIN
  UPDATE queue_entries
  SET message='[queue message removed after settlement]'
  WHERE id=NEW.queue_id;
END;
`;

const schemaVersion22 = `
CREATE TABLE IF NOT EXISTS queue_message_scrub_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  required_at INTEGER NOT NULL CHECK(required_at >= 0),
  requires_vacuum INTEGER NOT NULL CHECK(requires_vacuum IN (0,1)),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991)
) STRICT;
DROP TRIGGER IF EXISTS queue_message_terminal_insert_scrub;
CREATE TRIGGER queue_message_terminal_insert_scrub
AFTER INSERT ON queue_entries
WHEN NEW.state IN ('applied','failed','cancelled')
BEGIN
  INSERT INTO queue_message_scrub_authority(singleton,required_at,requires_vacuum,generation)
  VALUES (1,NEW.updated_at,0,1)
  ON CONFLICT(singleton) DO UPDATE SET
    required_at=MIN(required_at,excluded.required_at),
    requires_vacuum=MAX(requires_vacuum,excluded.requires_vacuum),
    generation=CASE
      WHEN generation<9007199254740991 THEN generation+1
      ELSE RAISE(ABORT, 'queue message scrub generation exhausted')
    END;
END;
DROP TRIGGER IF EXISTS queue_message_terminal_transition_scrub;
CREATE TRIGGER queue_message_terminal_transition_scrub
AFTER UPDATE OF state ON queue_entries
WHEN NEW.state IN ('applied','failed','cancelled')
BEGIN
  INSERT INTO queue_message_scrub_authority(singleton,required_at,requires_vacuum,generation)
  VALUES (1,NEW.updated_at,0,1)
  ON CONFLICT(singleton) DO UPDATE SET
    required_at=MIN(required_at,excluded.required_at),
    requires_vacuum=MAX(requires_vacuum,excluded.requires_vacuum),
    generation=CASE
      WHEN generation<9007199254740991 THEN generation+1
      ELSE RAISE(ABORT, 'queue message scrub generation exhausted')
    END;
END;
DROP TRIGGER IF EXISTS queue_message_resolution_scrub;
CREATE TRIGGER queue_message_resolution_scrub
AFTER INSERT ON queue_effect_resolutions
BEGIN
  INSERT INTO queue_message_scrub_authority(singleton,required_at,requires_vacuum,generation)
  VALUES (1,NEW.created_at,0,1)
  ON CONFLICT(singleton) DO UPDATE SET
    required_at=MIN(required_at,excluded.required_at),
    requires_vacuum=MAX(requires_vacuum,excluded.requires_vacuum),
    generation=CASE
      WHEN generation<9007199254740991 THEN generation+1
      ELSE RAISE(ABORT, 'queue message scrub generation exhausted')
    END;
END;
DROP TRIGGER IF EXISTS queue_message_scrub_authority_record;
DROP TRIGGER IF EXISTS queue_message_settlement_guard;
CREATE TRIGGER queue_message_settlement_guard
BEFORE UPDATE OF message ON queue_entries
WHEN NOT (
  NEW.message='[queue message removed after settlement]'
  AND (
    NEW.state IN ('applied','failed','cancelled')
    OR EXISTS(
      SELECT 1 FROM queue_effect_resolutions r WHERE r.queue_id=OLD.id
    )
  )
  AND EXISTS(
    SELECT 1 FROM queue_message_scrub_authority a WHERE a.singleton=1
  )
)
BEGIN SELECT RAISE(ABORT, 'queue message is immutable except for settlement removal'); END;
DROP TRIGGER IF EXISTS queue_effect_resolution_authority_guard;
CREATE TRIGGER queue_effect_resolution_authority_guard
BEFORE INSERT ON queue_effect_resolutions
WHEN NOT EXISTS(
  SELECT 1
  FROM queue_entries q
  JOIN queue_effect_evidence e ON e.queue_id=q.id
  JOIN sessions s ON s.id=q.session_id
  WHERE q.id=NEW.queue_id
    AND q.state='ambiguous'
    AND s.state!='recovery_required'
)
OR json_valid(NEW.evidence_json)!=1
OR (
  NEW.resolution_kind='proven_applied'
  AND (
    NEW.receipt_json IS NULL
    OR json_valid(NEW.receipt_json)!=1
    OR json_type(NEW.receipt_json)!='object'
    OR json_type(NEW.receipt_json,'$.turnId')!='text'
    OR length(json_extract(NEW.receipt_json,'$.turnId')) NOT BETWEEN 1 AND 200
    OR NOT EXISTS(
      SELECT 1
      FROM queue_entries q
      JOIN session_turn_runtime_profiles t
        ON t.session_id=q.session_id
       AND t.source_kind='queue_start'
       AND t.source_id=q.id
       AND t.turn_id=json_extract(NEW.receipt_json,'$.turnId')
      WHERE q.id=NEW.queue_id
    )
  )
)
OR (NEW.resolution_kind='abandoned' AND NEW.receipt_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'queue effect resolution authority mismatch'); END;
`;

const schemaVersion23 = `
CREATE INDEX IF NOT EXISTS queue_entries_message_scrub_candidates
  ON queue_entries(id)
  WHERE message!='[queue message removed after settlement]';
`;

const schemaVersion27 = `
CREATE TABLE IF NOT EXISTS account_rate_limit_reset_attempts (
  attempt_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(attempt_sequence BETWEEN 1 AND 9007199254740991),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) = 36),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  origin_process_generation INTEGER NOT NULL CHECK(origin_process_generation BETWEEN 1 AND 9007199254740991),
  current_process_generation INTEGER NOT NULL CHECK(current_process_generation BETWEEN origin_process_generation AND 9007199254740991),
  account_fingerprint TEXT NOT NULL CHECK(length(account_fingerprint) = 64 AND account_fingerprint NOT GLOB '*[^a-f0-9]*'),
  weekly_window_resets_at INTEGER NOT NULL CHECK(weekly_window_resets_at BETWEEN 0 AND 9007199254740991),
  observed_used_percent REAL NOT NULL CHECK(observed_used_percent BETWEEN 99 AND 100),
  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','ambiguous','retryable','settled','closed')),
  outcome TEXT CHECK(outcome IN ('reset','alreadyRedeemed','nothingToReset','noCredit')),
  local_resolution TEXT CHECK(local_resolution IN ('weekly_window_changed','account_identity_changed')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  CHECK(
    (state='settled' AND outcome IS NOT NULL AND local_resolution IS NULL) OR
    (state='closed' AND outcome IS NULL AND local_resolution IS NOT NULL) OR
    (state NOT IN ('settled','closed') AND outcome IS NULL AND local_resolution IS NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS account_rate_limit_reset_attempts_identity_window
  ON account_rate_limit_reset_attempts(
    profile_id,account_fingerprint,weekly_window_resets_at,attempt_sequence
  );
CREATE UNIQUE INDEX IF NOT EXISTS account_rate_limit_reset_attempts_one_recoverable
  ON account_rate_limit_reset_attempts(profile_id,account_fingerprint)
  WHERE state IN ('prepared','effect_started','ambiguous','retryable');
CREATE UNIQUE INDEX IF NOT EXISTS account_rate_limit_reset_attempts_one_success
  ON account_rate_limit_reset_attempts(
    profile_id,account_fingerprint,weekly_window_resets_at
  ) WHERE outcome IN ('reset','alreadyRedeemed');
CREATE TABLE IF NOT EXISTS account_rate_limit_reset_rebinds (
  sequence INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL REFERENCES account_rate_limit_reset_attempts(idempotency_key) ON DELETE CASCADE,
  from_process_generation INTEGER NOT NULL CHECK(from_process_generation BETWEEN 1 AND 9007199254740991),
  to_process_generation INTEGER NOT NULL CHECK(to_process_generation BETWEEN 1 AND 9007199254740991),
  account_fingerprint TEXT NOT NULL CHECK(length(account_fingerprint) = 64 AND account_fingerprint NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK(to_process_generation > from_process_generation),
  UNIQUE(idempotency_key,to_process_generation)
) STRICT;
CREATE INDEX IF NOT EXISTS account_rate_limit_reset_rebinds_attempt
  ON account_rate_limit_reset_rebinds(idempotency_key,sequence);
DROP TRIGGER IF EXISTS account_rate_limit_reset_attempt_transition_guard;
CREATE TRIGGER account_rate_limit_reset_attempt_transition_guard
BEFORE UPDATE OF state ON account_rate_limit_reset_attempts
WHEN NOT (
  (OLD.state='prepared' AND NEW.state='effect_started') OR
  (OLD.state='effect_started' AND NEW.state IN ('ambiguous','retryable','settled')) OR
  (OLD.state IN ('ambiguous','retryable') AND NEW.state='effect_started') OR
  (OLD.state IN ('prepared','retryable') AND NEW.state='closed') OR
  (
    OLD.state='ambiguous'
    AND NEW.state='closed'
    AND NEW.local_resolution='account_identity_changed'
  ) OR
  OLD.state=NEW.state
)
BEGIN SELECT RAISE(ABORT, 'illegal account rate-limit reset transition'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_attempt_terminal_evidence_guard;
CREATE TRIGGER account_rate_limit_reset_attempt_terminal_evidence_guard
BEFORE UPDATE OF outcome,local_resolution ON account_rate_limit_reset_attempts
WHEN OLD.state IN ('settled','closed')
  AND (
    OLD.outcome IS NOT NEW.outcome
    OR OLD.local_resolution IS NOT NEW.local_resolution
  )
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset terminal evidence is immutable'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_attempt_identity_guard;
CREATE TRIGGER account_rate_limit_reset_attempt_identity_guard
BEFORE UPDATE OF profile_id,origin_process_generation,account_fingerprint,
  weekly_window_resets_at,observed_used_percent,created_at
ON account_rate_limit_reset_attempts
WHEN OLD.profile_id!=NEW.profile_id
  OR OLD.origin_process_generation!=NEW.origin_process_generation
  OR OLD.account_fingerprint!=NEW.account_fingerprint
  OR OLD.weekly_window_resets_at!=NEW.weekly_window_resets_at
  OR OLD.observed_used_percent!=NEW.observed_used_percent
  OR OLD.created_at!=NEW.created_at
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset identity is immutable'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_attempt_rebind_guard;
CREATE TRIGGER account_rate_limit_reset_attempt_rebind_guard
BEFORE UPDATE OF current_process_generation ON account_rate_limit_reset_attempts
WHEN OLD.current_process_generation!=NEW.current_process_generation
  AND NOT EXISTS (
    SELECT 1 FROM account_rate_limit_reset_rebinds r
    WHERE r.idempotency_key=OLD.idempotency_key
      AND r.from_process_generation=OLD.current_process_generation
      AND r.to_process_generation=NEW.current_process_generation
      AND r.account_fingerprint=OLD.account_fingerprint
  )
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset rebind evidence is missing'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_rebind_insert_guard;
CREATE TRIGGER account_rate_limit_reset_rebind_insert_guard
BEFORE INSERT ON account_rate_limit_reset_rebinds
WHEN NOT EXISTS (
  SELECT 1 FROM account_rate_limit_reset_attempts a
  WHERE a.idempotency_key=NEW.idempotency_key
    AND a.current_process_generation=NEW.from_process_generation
    AND a.account_fingerprint=NEW.account_fingerprint
    AND a.state IN ('prepared','ambiguous','retryable')
)
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset rebind authority is invalid'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_rebind_update_guard;
CREATE TRIGGER account_rate_limit_reset_rebind_update_guard
BEFORE UPDATE ON account_rate_limit_reset_rebinds
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset rebind evidence is append-only'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_rebind_delete_guard;
CREATE TRIGGER account_rate_limit_reset_rebind_delete_guard
BEFORE DELETE ON account_rate_limit_reset_rebinds
WHEN EXISTS (
  SELECT 1 FROM account_rate_limit_reset_attempts a
  WHERE a.idempotency_key=OLD.idempotency_key
)
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset rebind evidence is append-only'); END;
`;

const schemaVersion28 = `
CREATE TABLE IF NOT EXISTS account_rate_limit_reset_policies (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN (
    'active_unbound','reconciliation_required','window_suppressed','active_bound'
  )),
  account_fingerprint TEXT CHECK(
    account_fingerprint IS NULL OR (
      length(account_fingerprint)=64
      AND account_fingerprint NOT GLOB '*[^a-f0-9]*'
    )
  ),
  weekly_window_resets_at INTEGER CHECK(
    weekly_window_resets_at IS NULL
    OR weekly_window_resets_at BETWEEN 0 AND 9007199254740991
  ),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  CHECK(
    (
      state IN ('active_unbound','reconciliation_required')
      AND account_fingerprint IS NULL
      AND weekly_window_resets_at IS NULL
    ) OR (
      state IN ('window_suppressed','active_bound')
      AND account_fingerprint IS NOT NULL
      AND weekly_window_resets_at IS NOT NULL
    )
  )
) STRICT;
DROP TRIGGER IF EXISTS account_rate_limit_reset_policy_insert_guard;
CREATE TRIGGER account_rate_limit_reset_policy_insert_guard
BEFORE INSERT ON account_rate_limit_reset_policies
WHEN NEW.state NOT IN ('active_unbound','reconciliation_required')
  OR NOT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.id=NEW.profile_id AND p.state!='removed'
  )
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy insert is invalid'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_policy_transition_guard;
CREATE TRIGGER account_rate_limit_reset_policy_transition_guard
BEFORE UPDATE ON account_rate_limit_reset_policies
WHEN NEW.profile_id!=OLD.profile_id
  OR NEW.created_at!=OLD.created_at
  OR NEW.revision!=OLD.revision+1
  OR NEW.updated_at<OLD.updated_at
  OR NOT (
    (
      OLD.state='active_unbound'
      AND NEW.state='active_bound'
    ) OR (
      OLD.state='reconciliation_required'
      AND NEW.state='window_suppressed'
    ) OR (
      OLD.state='window_suppressed'
      AND NEW.state='active_bound'
      AND NEW.account_fingerprint=OLD.account_fingerprint
      AND NEW.weekly_window_resets_at>OLD.weekly_window_resets_at
      AND NEW.updated_at>=OLD.weekly_window_resets_at
    ) OR (
      OLD.state IN (
        'active_unbound','reconciliation_required','window_suppressed','active_bound'
      )
      AND NEW.state='reconciliation_required'
    ) OR (
      OLD.state='active_bound'
      AND NEW.state='active_bound'
      AND NEW.account_fingerprint=OLD.account_fingerprint
      AND NEW.weekly_window_resets_at>OLD.weekly_window_resets_at
    )
  )
BEGIN SELECT RAISE(ABORT, 'illegal account rate-limit reset policy transition'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_policy_delete_guard;
CREATE TRIGGER account_rate_limit_reset_policy_delete_guard
BEFORE DELETE ON account_rate_limit_reset_policies
WHEN EXISTS (
  SELECT 1 FROM profiles p WHERE p.id=OLD.profile_id AND p.state!='removed'
)
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy is required'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_attempt_transition_guard;
CREATE TRIGGER account_rate_limit_reset_attempt_transition_guard
BEFORE UPDATE OF state ON account_rate_limit_reset_attempts
WHEN NOT (
  (OLD.state='prepared' AND NEW.state='effect_started') OR
  (OLD.state='effect_started' AND NEW.state IN ('ambiguous','retryable','settled')) OR
  (OLD.state IN ('ambiguous','retryable') AND NEW.state='effect_started') OR
  (OLD.state IN ('prepared','retryable') AND NEW.state='closed') OR
  (
    OLD.state='ambiguous'
    AND NEW.state='closed'
    AND NEW.local_resolution='account_identity_changed'
  ) OR
  OLD.state=NEW.state
)
BEGIN SELECT RAISE(ABORT, 'illegal account rate-limit reset transition'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_attempt_policy_insert_guard;
CREATE TRIGGER account_rate_limit_reset_attempt_policy_insert_guard
BEFORE INSERT ON account_rate_limit_reset_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM account_rate_limit_reset_policies p
  WHERE p.profile_id=NEW.profile_id
    AND p.state='active_bound'
    AND p.account_fingerprint=NEW.account_fingerprint
    AND p.weekly_window_resets_at=NEW.weekly_window_resets_at
)
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy does not authorize preparation'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_attempt_policy_begin_guard;
CREATE TRIGGER account_rate_limit_reset_attempt_policy_begin_guard
BEFORE UPDATE OF state ON account_rate_limit_reset_attempts
WHEN NEW.state='effect_started'
  AND OLD.state!='effect_started'
  AND NOT EXISTS (
    SELECT 1 FROM account_rate_limit_reset_policies p
    WHERE p.profile_id=OLD.profile_id
      AND p.state='active_bound'
      AND p.account_fingerprint=OLD.account_fingerprint
      AND (
        (
          OLD.state IN ('prepared','retryable')
          AND p.weekly_window_resets_at=OLD.weekly_window_resets_at
        ) OR (
          OLD.state='ambiguous'
          AND p.weekly_window_resets_at>=OLD.weekly_window_resets_at
        )
      )
  )
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy does not authorize dispatch'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_attempt_policy_close_guard;
CREATE TRIGGER account_rate_limit_reset_attempt_policy_close_guard
BEFORE UPDATE OF state ON account_rate_limit_reset_attempts
WHEN NEW.state='closed'
  AND OLD.state!='closed'
  AND NOT EXISTS (
    SELECT 1 FROM account_rate_limit_reset_policies p
    WHERE p.profile_id=OLD.profile_id
      AND (
        (
          p.state='active_bound'
          AND p.account_fingerprint=OLD.account_fingerprint
          AND p.weekly_window_resets_at>=OLD.weekly_window_resets_at
        ) OR (
          NEW.local_resolution='account_identity_changed'
          AND p.state='window_suppressed'
        ) OR (
          NEW.local_resolution='weekly_window_changed'
          AND p.state='window_suppressed'
          AND p.account_fingerprint=OLD.account_fingerprint
          AND p.weekly_window_resets_at>OLD.weekly_window_resets_at
        )
      )
  )
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy does not authorize closure'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_rebind_policy_guard;
CREATE TRIGGER account_rate_limit_reset_rebind_policy_guard
BEFORE INSERT ON account_rate_limit_reset_rebinds
WHEN NOT EXISTS (
  SELECT 1
  FROM account_rate_limit_reset_attempts a
  JOIN account_rate_limit_reset_policies p ON p.profile_id=a.profile_id
  WHERE a.idempotency_key=NEW.idempotency_key
    AND p.state='active_bound'
    AND p.account_fingerprint=a.account_fingerprint
    AND (
      (
        a.state IN ('prepared','retryable')
        AND p.weekly_window_resets_at=a.weekly_window_resets_at
      ) OR (
        a.state='ambiguous'
        AND p.weekly_window_resets_at>=a.weekly_window_resets_at
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset policy does not authorize rebind'); END;
DROP TRIGGER IF EXISTS account_rate_limit_reset_rebind_insert_guard;
CREATE TRIGGER account_rate_limit_reset_rebind_insert_guard
BEFORE INSERT ON account_rate_limit_reset_rebinds
WHEN NOT EXISTS (
  SELECT 1 FROM account_rate_limit_reset_attempts a
  WHERE a.idempotency_key=NEW.idempotency_key
    AND a.current_process_generation=NEW.from_process_generation
    AND a.account_fingerprint=NEW.account_fingerprint
    AND a.state IN ('prepared','ambiguous','retryable')
)
BEGIN SELECT RAISE(ABORT, 'account rate-limit reset rebind authority is invalid'); END;
`;

// Approval mode, autorespond evidence, and the consecutive-autorespond
// counter (W1 autorespond). Kept as auxiliary side tables rather than columns
// on `sessions`, matching the existing convention for per-session runtime
// state (e.g. session_runtime_profiles).
const schemaVersion30 = `
CREATE TABLE IF NOT EXISTS session_approval_modes (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('auto:all','auto:workspace','manual')),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS session_autorespond_counters (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  consecutive_count INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_count >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS autorespond_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('command_approval','file_change_approval','permission_approval')),
  class TEXT NOT NULL CHECK(length(class) BETWEEN 1 AND 256),
  decision TEXT NOT NULL CHECK(length(decision) BETWEEN 1 AND 64),
  mode TEXT NOT NULL CHECK(mode IN ('auto:all','auto:workspace','manual')),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','refused')),
  latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
  subagent INTEGER NOT NULL CHECK(subagent IN (0,1)),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS autorespond_evidence_session ON autorespond_evidence(session_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS autorespond_evidence_recent ON autorespond_evidence(occurred_at DESC, id DESC);
`;
const schemaVersion30DefaultApprovalModeColumn =
  "ALTER TABLE daemon_state ADD COLUMN default_approval_mode TEXT NOT NULL DEFAULT 'auto:all' "
  + "CHECK(default_approval_mode IN ('auto:all','auto:workspace','manual'))";
const schemaVersion30ResolvedByColumn =
  "ALTER TABLE provider_interactions ADD COLUMN resolved_by TEXT "
  + "CHECK(resolved_by IS NULL OR resolved_by = 'autorespond')";
/** Per-session evidence rows kept for `hra autorespond status`; oldest rows past this cap are pruned on insert. */
export const AUTORESPOND_EVIDENCE_PER_SESSION_CAP = 500;

const schemaVersion28Objects = [
  {
    name: "account_rate_limit_reset_policies",
    table: "account_rate_limit_reset_policies",
    type: "table",
  },
  {
    name: "account_rate_limit_reset_policy_insert_guard",
    table: "account_rate_limit_reset_policies",
    type: "trigger",
  },
  {
    name: "account_rate_limit_reset_policy_transition_guard",
    table: "account_rate_limit_reset_policies",
    type: "trigger",
  },
  {
    name: "account_rate_limit_reset_policy_delete_guard",
    table: "account_rate_limit_reset_policies",
    type: "trigger",
  },
  {
    name: "account_rate_limit_reset_attempt_transition_guard",
    table: "account_rate_limit_reset_attempts",
    type: "trigger",
  },
  {
    name: "account_rate_limit_reset_attempt_policy_insert_guard",
    table: "account_rate_limit_reset_attempts",
    type: "trigger",
  },
  {
    name: "account_rate_limit_reset_attempt_policy_begin_guard",
    table: "account_rate_limit_reset_attempts",
    type: "trigger",
  },
  {
    name: "account_rate_limit_reset_attempt_policy_close_guard",
    table: "account_rate_limit_reset_attempts",
    type: "trigger",
  },
  {
    name: "account_rate_limit_reset_rebind_policy_guard",
    table: "account_rate_limit_reset_rebinds",
    type: "trigger",
  },
  {
    name: "account_rate_limit_reset_rebind_insert_guard",
    table: "account_rate_limit_reset_rebinds",
    type: "trigger",
  },
] as const;

const schemaVersion28ObjectSql = (
  object: (typeof schemaVersion28Objects)[number],
): string => {
  const marker = object.type === "table"
    ? `CREATE TABLE IF NOT EXISTS ${object.name}`
    : `CREATE TRIGGER ${object.name}`;
  const start = schemaVersion28.indexOf(marker);
  const terminator = object.type === "table" ? ") STRICT;" : "END;";
  const end = schemaVersion28.indexOf(terminator, start);
  if (start < 0 || end < 0) throw new Error("STATE_SCHEMA_V28_DEFINITION_INVALID");
  return schemaVersion28.slice(start, end + terminator.length);
};

const schemaVersion24Objects = [
  {
    name: "profiles_label_key_active",
    table: "profiles",
    type: "index",
    sql: `CREATE UNIQUE INDEX profiles_label_key_active
  ON profiles(label_key) WHERE state!='removed'`,
  },
  {
    name: "projects_label_key_unique",
    table: "projects",
    type: "index",
    sql: `CREATE UNIQUE INDEX projects_label_key_unique
  ON projects(label_key)`,
  },
  {
    name: "profiles_label_key_insert_guard",
    table: "profiles",
    type: "trigger",
    sql: `CREATE TRIGGER profiles_label_key_insert_guard
BEFORE INSERT ON profiles
WHEN NEW.label_key IS NULL
  OR length(CAST(NEW.label_key AS BLOB)) NOT BETWEEN 1 AND 4096
BEGIN SELECT RAISE(ABORT, 'invalid profile label key'); END`,
  },
  {
    name: "profiles_label_key_immutable",
    table: "profiles",
    type: "trigger",
    sql: `CREATE TRIGGER profiles_label_key_immutable
BEFORE UPDATE OF label,label_key ON profiles
WHEN NEW.label IS NOT OLD.label OR NEW.label_key IS NOT OLD.label_key
BEGIN SELECT RAISE(ABORT, 'profile label identity is immutable'); END`,
  },
  {
    name: "projects_label_key_insert_guard",
    table: "projects",
    type: "trigger",
    sql: `CREATE TRIGGER projects_label_key_insert_guard
BEFORE INSERT ON projects
WHEN NEW.label_key IS NULL
  OR length(CAST(NEW.label_key AS BLOB)) NOT BETWEEN 1 AND 4096
BEGIN SELECT RAISE(ABORT, 'invalid project label key'); END`,
  },
  {
    name: "projects_label_key_immutable",
    table: "projects",
    type: "trigger",
    sql: `CREATE TRIGGER projects_label_key_immutable
BEFORE UPDATE OF label,label_key ON projects
WHEN NEW.label IS NOT OLD.label OR NEW.label_key IS NOT OLD.label_key
BEGIN SELECT RAISE(ABORT, 'project label identity is immutable'); END`,
  },
] as const;

const schemaVersion24 = schemaVersion24Objects
  .map((object) => `${object.sql};`)
  .join("\n");

const dropSchemaVersion24 = [...schemaVersion24Objects]
  .reverse()
  .map((object) => `DROP ${object.type.toUpperCase()} IF EXISTS ${object.name};`)
  .join("\n");

const rebuildSchemaVersion24 = (database: Database): void => {
  database.exec(dropSchemaVersion24);
  database.exec(schemaVersion24);
};

const sqliteSchemaObjectRowSchema = z.object({
  name: z.string(),
  sql: z.string(),
  tbl_name: z.string(),
  type: z.enum(["index", "table", "trigger"]),
}).strict();

const normalizeSqlStructure = (sql: string): string =>
  sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "");

const assertSchemaVersion24Objects = (database: Database): void => {
  const names = schemaVersion24Objects.map((object) => `'${object.name}'`).join(",");
  const rows = database.query(
    `SELECT type,name,tbl_name,sql FROM sqlite_master
     WHERE name IN (${names}) ORDER BY name`,
  ).all().map((row) => sqliteSchemaObjectRowSchema.parse(row));
  if (rows.length !== schemaVersion24Objects.length) {
    throw new Error("STATE_SCHEMA_V24_STRUCTURE_INVALID");
  }
  for (const expected of schemaVersion24Objects) {
    const observed = rows.find((row) => row.name === expected.name);
    if (
      observed === undefined
      || observed.type !== expected.type
      || observed.tbl_name !== expected.table
      || normalizeSqlStructure(observed.sql) !== normalizeSqlStructure(expected.sql)
    ) throw new Error("STATE_SCHEMA_V24_STRUCTURE_INVALID");
  }
};

const assertSchemaVersion28Objects = (database: Database): void => {
  const names = schemaVersion28Objects.map((object) => `'${object.name}'`).join(",");
  const rows = database.query(
    `SELECT type,name,tbl_name,sql FROM sqlite_master
     WHERE name IN (${names}) ORDER BY name`,
  ).all().map((row) => sqliteSchemaObjectRowSchema.parse(row));
  if (rows.length !== schemaVersion28Objects.length) {
    throw new Error("STATE_SCHEMA_V28_STRUCTURE_INVALID");
  }
  for (const expected of schemaVersion28Objects) {
    const observed = rows.find((row) => row.name === expected.name);
    const observedSql = observed?.sql.replace(/\bIF NOT EXISTS\b/giu, "");
    const expectedSql = schemaVersion28ObjectSql(expected)
      .replace(/\bIF NOT EXISTS\b/giu, "");
    if (
      observed === undefined
      || observed.type !== expected.type
      || observed.tbl_name !== expected.table
      || normalizeSqlStructure(observedSql ?? "")
        !== normalizeSqlStructure(expectedSql)
    ) throw new Error("STATE_SCHEMA_V28_STRUCTURE_INVALID");
  }
};

const assertAccountRateLimitResetPolicies = (database: Database): void => {
  assertSchemaVersion28Objects(database);
  let policies: readonly AccountRateLimitResetPolicyRecord[];
  try {
    policies = database.query(
      "SELECT * FROM account_rate_limit_reset_policies ORDER BY profile_id",
    ).all().map(mapAccountRateLimitResetPolicy);
  } catch (error: unknown) {
    throw new Error("STATE_ACCOUNT_RATE_LIMIT_RESET_POLICY_INVALID", { cause: error });
  }
  const policyProfileIds = new Set(policies.map((policy) => policy.profileId));
  const activeProfileIds = database.query(
    "SELECT id FROM profiles WHERE state!='removed' ORDER BY id",
  ).all().map((row) => z.object({ id: profileIdSchema }).strict().parse(row).id);
  if (activeProfileIds.some((profileId) => !policyProfileIds.has(profileId))) {
    throw new Error("STATE_ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
  }
  const activeProfileIdSet = new Set(activeProfileIds);
  if (policies.some((policy) => !activeProfileIdSet.has(policy.profileId))) {
    throw new Error("STATE_ACCOUNT_RATE_LIMIT_RESET_POLICY_ORPHANED");
  }
};

const ensureQueueMessageScrubGeneration = (database: Database): void => {
  if (!hasTableColumn(database, "queue_message_scrub_authority", "generation")) {
    database.exec(
      "ALTER TABLE queue_message_scrub_authority ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991)",
    );
  }
};

const hasSettledQueueMessagesToScrub = (database: Database): boolean =>
  database.query(
    `SELECT 1
     FROM queue_entries
     WHERE message!=?
       AND (
         state IN ('applied','failed','cancelled')
         OR EXISTS(
           SELECT 1 FROM queue_effect_resolutions r
           WHERE r.queue_id=queue_entries.id
         )
       )
     LIMIT 1`,
  ).get(settledQueueMessage) !== null;

const scrubSettledQueueMessages = (database: Database): boolean => {
  const terminal = database.query(
    `UPDATE queue_entries
     SET message=?
     WHERE message!=?
       AND state IN ('applied','failed','cancelled')`,
  ).run(settledQueueMessage, settledQueueMessage);
  const resolved = database.query(
    `UPDATE queue_entries
     SET message=?
     WHERE message!=?
       AND EXISTS(
         SELECT 1 FROM queue_effect_resolutions r
         WHERE r.queue_id=queue_entries.id
       )`,
  ).run(settledQueueMessage, settledQueueMessage);
  return terminal.changes + resolved.changes > 0;
};

const userVersionSchema = z.object({ user_version: z.number().int().nonnegative() }).strict();

const securityScrubAuthorityRowSchema = z.object({
  reason: z.literal("mcp_url_redaction"),
  required_at: unixMillisecondsSchema,
}).strict();

const queueMessageScrubAuthorityRowSchema = z.object({
  required_at: unixMillisecondsSchema,
  requires_vacuum: z.union([z.literal(0), z.literal(1)]),
  generation: z.number().int().positive().safe(),
}).strict();

const walCheckpointRowSchema = z.object({
  busy: z.number().int().min(0).max(1),
  log: z.number().int().nonnegative(),
  checkpointed: z.number().int().nonnegative(),
}).strict();

const journalModeRowSchema = z.object({ journal_mode: z.string() }).strict();

const requireWalMode = (database: Database, configure = false): void => {
  const row = journalModeRowSchema.parse(
    database.query(configure ? "PRAGMA journal_mode=WAL" : "PRAGMA journal_mode").get(),
  );
  if (row.journal_mode.toLowerCase() !== "wal") throw new Error("STATE_WAL_REQUIRED");
};

const readUserVersion = (database: Database): number =>
  userVersionSchema.parse(database.query("PRAGMA user_version").get()).user_version;

const hasPendingSecurityScrub = (database: Database): boolean => {
  const row = database.query(
    "SELECT reason,required_at FROM security_scrub_authority WHERE singleton=1",
  ).get();
  if (row !== null) {
    securityScrubAuthorityRowSchema.parse(row);
    return true;
  }
  const queueRow = database.query(
    "SELECT required_at,requires_vacuum,generation FROM queue_message_scrub_authority WHERE singleton=1",
  ).get();
  if (queueRow === null) return false;
  queueMessageScrubAuthorityRowSchema.parse(queueRow);
  return true;
};

const requireSecurityScrub = (database: Database, requiredAt: number): void => {
  database.query(
    `INSERT OR IGNORE INTO security_scrub_authority(singleton,reason,required_at)
     VALUES (1,'mcp_url_redaction',?)`,
  ).run(unixMillisecondsSchema.parse(requiredAt));
};

const requireQueueMessageScrub = (
  database: Database,
  requiredAt: number,
  requiresVacuum: boolean,
): void => {
  const recorded = database.query(
    `INSERT INTO queue_message_scrub_authority(singleton,required_at,requires_vacuum,generation)
     VALUES (1,?,?,1)
     ON CONFLICT(singleton) DO UPDATE SET
       required_at=MIN(required_at,excluded.required_at),
       requires_vacuum=MAX(requires_vacuum,excluded.requires_vacuum),
       generation=generation+1
     WHERE generation<9007199254740991`,
  ).run(
    unixMillisecondsSchema.parse(requiredAt),
    requiresVacuum ? 1 : 0,
  );
  if (recorded.changes !== 1) {
    throw new Error("QUEUE_MESSAGE_SCRUB_GENERATION_EXHAUSTED");
  }
};

const completePendingSecurityScrub = (
  database: Database,
  operationCommitted = false,
  policy: SecurityScrubCheckpointPolicy = defaultSecurityScrubCheckpointPolicy,
): void => {
  if (!hasPendingSecurityScrub(database)) return;
  database.exec(`PRAGMA busy_timeout = ${policy.busyTimeoutMs}`);
  try {
    const truncateWal = (): void => {
      // A readonly status read releases its snapshot well inside one attempt.
      // A reader that outlives the whole bounded schedule still fails the
      // scrub, so a settled body is never reported purged while frames remain.
      for (let attempt = 1; ; attempt += 1) {
        requireWalMode(database);
        const checkpoint = walCheckpointRowSchema.parse(
          database.query("PRAGMA wal_checkpoint(TRUNCATE)").get(),
        );
        if (checkpoint.busy === 0 && checkpoint.log === 0 && checkpoint.checkpointed === 0) return;
        if (attempt >= policy.attempts) {
          throw new Error("SQLite could not truncate every WAL frame.");
        }
        Bun.sleepSync(policy.backoffMs * 2 ** (attempt - 1));
      }
    };

    for (;;) {
      const snapshot = database.transaction(() => {
        const legacyRow = database.query(
          "SELECT reason,required_at FROM security_scrub_authority WHERE singleton=1",
        ).get();
        const legacySecurityScrub = legacyRow === null
          ? null
          : securityScrubAuthorityRowSchema.parse(legacyRow);
        const queueRow = database.query(
          "SELECT required_at,requires_vacuum,generation FROM queue_message_scrub_authority WHERE singleton=1",
        ).get();
        if (queueRow === null) {
          return { legacySecurityScrub, queueAuthority: null };
        }
        // The authority marker is committed before plaintext removal. This
        // connection owns secure_delete=ON, so every body rewrite has known
        // physical-deletion semantics even if the settling writer did not.
        scrubSettledQueueMessages(database);
        const queueAuthority = queueMessageScrubAuthorityRowSchema.parse(database.query(
          "SELECT required_at,requires_vacuum,generation FROM queue_message_scrub_authority WHERE singleton=1",
        ).get());
        return { legacySecurityScrub, queueAuthority };
      }).immediate();
      const { legacySecurityScrub, queueAuthority } = snapshot;

      if (legacySecurityScrub === null && queueAuthority === null) return;

      // The first truncation removes superseded runtime frames. A legacy
      // security migration or an explicitly uncertain queue migration also
      // rebuilds the main file so bytes left in free pages cannot survive.
      truncateWal();
      if (legacySecurityScrub !== null || queueAuthority?.requires_vacuum === 1) {
        database.exec("VACUUM");
        truncateWal();
      }
      const cleared = database.transaction(() => {
        if (legacySecurityScrub !== null) {
          database.query("DELETE FROM security_scrub_authority WHERE singleton=1").run();
        }
        if (queueAuthority === null) return true;
        return database.query(
          "DELETE FROM queue_message_scrub_authority WHERE singleton=1 AND generation=?",
        ).run(queueAuthority.generation).changes === 1;
      }).immediate();
      // A concurrent settlement advanced the generation after our checkpoint.
      // Its authority remains durable and must be scrubbed in the next pass.
      if (!cleared) continue;
      if (!hasPendingSecurityScrub(database)) return;
    }
  } catch (cause) {
    throw new StateSecurityScrubRequiredError(operationCommitted, cause);
  } finally {
    database.exec(`PRAGMA busy_timeout = ${stateBusyTimeoutMs}`);
  }
};

const hasTableColumn = (database: Database, table: string, column: string): boolean => {
  const columnSchema = z.object({ name: z.string() }).passthrough();
  if (!/^[a-z_]+$/u.test(table)) throw new Error("Unsafe SQLite table identifier.");
  return database.query(`PRAGMA table_info(${table})`).all().some((row) => columnSchema.parse(row).name === column);
};

const ensureSessionEventProjectionVersion = (database: Database): void => {
  if (!hasTableColumn(database, "session_events", "projection_version")) {
    database.exec(
      "ALTER TABLE session_events ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 1 CHECK(projection_version IN (1,2))",
    );
  }
};

const ensureUsagePollFailureAccountFingerprint = (database: Database): void => {
  if (!hasTableColumn(database, "usage_poll_failures", "account_fingerprint")) {
    database.exec(
      `ALTER TABLE usage_poll_failures ADD COLUMN account_fingerprint TEXT
       CHECK(
         account_fingerprint IS NULL OR (
           length(account_fingerprint)=64
           AND account_fingerprint NOT GLOB '*[^a-f0-9]*'
         )
       )`,
    );
  }
  database.exec(
    `CREATE INDEX IF NOT EXISTS usage_poll_failures_identity_recent
     ON usage_poll_failures(
       profile_id,account_fingerprint,source_revision DESC
     )`,
  );
};

type LabelIdentityKind = "ACCOUNT" | "PROJECT";

class StateLabelInvariantError extends Error {
  constructor(kind: LabelIdentityKind, reason: "COLLISION" | "INVALID" | "KEY_INVALID") {
    super(`STATE_${kind}_LABEL_${reason}`);
    this.name = "StateLabelInvariantError";
  }
}

const canonicalLabelIdentity = (
  value: unknown,
  kind: LabelIdentityKind,
): Readonly<{ key: string; label: string }> => {
  const parsed = labelSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value) {
    throw new StateLabelInvariantError(kind, "INVALID");
  }
  const key = canonicalLabelKey(parsed.data);
  if (key.length === 0 || utf8Bytes(key) > 4_096) {
    throw new StateLabelInvariantError(kind, "KEY_INVALID");
  }
  return { key, label: parsed.data };
};

const assertUniqueLabelKeys = (
  keys: readonly string[],
  kind: LabelIdentityKind,
): void => {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new StateLabelInvariantError(kind, "COLLISION");
    seen.add(key);
  }
};

const profileLabelMigrationRowSchema = z.object({
  id: profileIdSchema,
  label: z.unknown(),
  state: profileStateSchema,
}).strict();
const projectLabelMigrationRowSchema = z.object({
  id: projectIdSchema,
  label: z.unknown(),
}).strict();
const profileLabelInvariantRowSchema = profileLabelMigrationRowSchema.extend({
  label_key: z.unknown(),
}).strict();
const projectLabelInvariantRowSchema = projectLabelMigrationRowSchema.extend({
  label_key: z.unknown(),
}).strict();

const backfillCanonicalLabelKeys = (database: Database): void => {
  if (!hasTableColumn(database, "profiles", "label_key")) {
    database.exec("ALTER TABLE profiles ADD COLUMN label_key TEXT");
  }
  if (!hasTableColumn(database, "projects", "label_key")) {
    database.exec("ALTER TABLE projects ADD COLUMN label_key TEXT");
  }

  const profiles = database.query(
    "SELECT id,label,state FROM profiles ORDER BY id",
  ).all().map((row) => {
    const parsed = profileLabelMigrationRowSchema.parse(row);
    return { ...parsed, ...canonicalLabelIdentity(parsed.label, "ACCOUNT") };
  });
  assertUniqueLabelKeys(
    profiles.filter((profile) => profile.state !== "removed").map((profile) => profile.key),
    "ACCOUNT",
  );

  const projects = database.query(
    "SELECT id,label FROM projects ORDER BY id",
  ).all().map((row) => {
    const parsed = projectLabelMigrationRowSchema.parse(row);
    return { ...parsed, ...canonicalLabelIdentity(parsed.label, "PROJECT") };
  });
  assertUniqueLabelKeys(projects.map((project) => project.key), "PROJECT");

  const updateProfile = database.query("UPDATE profiles SET label_key=? WHERE id=?");
  for (const profile of profiles) updateProfile.run(profile.key, profile.id);
  const updateProject = database.query("UPDATE projects SET label_key=? WHERE id=?");
  for (const project of projects) updateProject.run(project.key, project.id);
};

const assertCanonicalLabelKeys = (database: Database): void => {
  if (!hasTableColumn(database, "profiles", "label_key")) {
    throw new StateLabelInvariantError("ACCOUNT", "KEY_INVALID");
  }
  if (!hasTableColumn(database, "projects", "label_key")) {
    throw new StateLabelInvariantError("PROJECT", "KEY_INVALID");
  }

  const profileKeys = database.query(
    "SELECT label,label_key,state FROM profiles ORDER BY id",
  ).all().map((row) => {
    const parsed = profileLabelInvariantRowSchema.omit({ id: true }).parse(row);
    const identity = canonicalLabelIdentity(parsed.label, "ACCOUNT");
    if (parsed.label_key !== identity.key) {
      throw new StateLabelInvariantError("ACCOUNT", "KEY_INVALID");
    }
    return { key: identity.key, state: parsed.state };
  });
  assertUniqueLabelKeys(
    profileKeys.filter((profile) => profile.state !== "removed").map((profile) => profile.key),
    "ACCOUNT",
  );

  const projectKeys = database.query(
    "SELECT label,label_key FROM projects ORDER BY id",
  ).all().map((row) => {
    const parsed = projectLabelInvariantRowSchema.omit({ id: true }).parse(row);
    const identity = canonicalLabelIdentity(parsed.label, "PROJECT");
    if (parsed.label_key !== identity.key) {
      throw new StateLabelInvariantError("PROJECT", "KEY_INVALID");
    }
    return identity.key;
  });
  assertUniqueLabelKeys(projectKeys, "PROJECT");
};

const ensureStableQueueSequence = (database: Database): void => {
  if (!hasTableColumn(database, "queue_entries", "enqueue_sequence")) {
    database.exec(
      "ALTER TABLE queue_entries ADD COLUMN enqueue_sequence INTEGER CHECK(enqueue_sequence IS NULL OR enqueue_sequence BETWEEN 1 AND 9007199254740990)",
    );
  }
  database.exec(`
    WITH ordered AS (
      SELECT rowid,ROW_NUMBER() OVER (ORDER BY rowid) AS enqueue_sequence
      FROM queue_entries
    )
    UPDATE queue_entries
    SET enqueue_sequence=(
      SELECT ordered.enqueue_sequence FROM ordered WHERE ordered.rowid=queue_entries.rowid
    )
    WHERE enqueue_sequence IS NULL;
  `);
  database.exec(schemaVersion14);
  const exhausted = database.query(
    "SELECT 1 FROM queue_entries WHERE enqueue_sequence>=9007199254740991 LIMIT 1",
  ).get();
  if (exhausted !== null) throw new Error("QUEUE_SEQUENCE_EXHAUSTED");
  database.query(
    `UPDATE queue_sequence_authority
     SET next_sequence=MAX(
       next_sequence,
       COALESCE((SELECT MAX(enqueue_sequence) FROM queue_entries),0)+1
     )
     WHERE singleton=1`,
  ).run();
};

const backfillExactTurnRuntimeProfiles = (database: Database, now: number): void => {
  const rows = [
    ...database.query(`SELECT p.*,CASE
        WHEN m.state='applied' THEN json_extract(m.result_json,'$.turnId')
        WHEN r.resolution_kind='proven_applied' THEN json_extract(r.receipt_json,'$.turnId')
        ELSE NULL END AS turn_id
      FROM session_runtime_profiles p
      JOIN mutation_attempts m ON m.id=p.source_id AND p.source_kind='turn_start'
      LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id`).all(),
    ...database.query(`SELECT p.*,CASE
        WHEN r.resolution_kind='proven_applied' THEN json_extract(r.receipt_json,'$.turnId')
        ELSE NULL END AS turn_id
      FROM session_runtime_profiles p
      JOIN queue_entries q ON q.id=p.source_id AND p.source_kind='queue_start'
      LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id`).all(),
  ];
  for (const row of rows) {
    const parsed = sessionRuntimeProfileRowSchema.extend({
      turn_id: z.string().min(1).max(200).nullable(),
    }).parse(row);
    if (parsed.turn_id === null || parsed.source_kind === "session_start") continue;
    const profile = effectiveRuntimeProfileSchema.parse(JSON.parse(parsed.profile_json) as unknown);
    if (
      profile.profileId !== parsed.profile_id
      || profile.processGeneration !== parsed.process_generation
      || profile.observedAt !== parsed.observed_at
    ) throw new Error("Stored runtime profile authority is incoherent.");
    database.query(
      `INSERT INTO session_turn_runtime_profiles(
         session_id,turn_id,source_kind,source_id,profile_id,process_generation,
         observed_at,profile_json,profile_digest,recorded_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      parsed.session_id,
      parsed.turn_id,
      parsed.source_kind,
      parsed.source_id,
      parsed.profile_id,
      parsed.process_generation,
      parsed.observed_at,
      parsed.profile_json,
      createHash("sha256").update(parsed.profile_json).digest("hex"),
      now,
    );
  }
};

const backfillSchemaVersion9 = (database: Database, now: number): void => {
  const sessions = database.query(
    "SELECT id FROM sessions WHERE NOT EXISTS(SELECT 1 FROM session_event_streams e WHERE e.session_id=sessions.id) ORDER BY id",
  ).all();
  for (const row of sessions) {
    const sessionId = z.object({ id: sessionIdSchema }).strict().parse(row).id;
    database.query(
      `INSERT OR IGNORE INTO session_event_streams(
         session_id,stream_epoch,next_sequence,floor_sequence,observed_through_sequence,
         retained_count,retained_bytes,retention_gap_reason,created_at,updated_at
       ) VALUES (?,?,1,1,0,0,0,NULL,?,?)`,
    ).run(sessionId, randomUUID(), now, now);
  }
  database.exec(`INSERT OR IGNORE INTO usage_revision_authority(profile_id,next_revision)
                 SELECT p.id,CASE
                   WHEN MAX(u.source_revision) IS NULL THEN 1
                   WHEN MAX(u.source_revision)>=9007199254740991 THEN 9007199254740991
                   ELSE MAX(u.source_revision)+1
                 END
                 FROM profiles p LEFT JOIN usage_snapshots u ON u.profile_id=p.id
                 GROUP BY p.id`);
};

const backfillSchemaVersion10 = (database: Database): void => {
  database.exec(`UPDATE usage_revision_authority
                 SET next_revision=MAX(
                   next_revision,
                   COALESCE((
                     SELECT CASE
                       WHEN MAX(f.source_revision)>=9007199254740991 THEN 9007199254740991
                       ELSE MAX(f.source_revision)+1
                     END
                     FROM usage_poll_failures f
                     WHERE f.profile_id=usage_revision_authority.profile_id
                   ),1)
                 )`);
};

const migratedMcpUrlDisplayJson = JSON.stringify(interactionDisplaySchema.parse({
  kind: "mcp_elicitation",
  summary: "Unsupported MCP browser handoff canceled during security migration",
  serverName: "redacted",
  mode: "form",
  url: null,
  mayContainSecrets: true,
}));

const legacyMcpUrlInteractionRowSchema = z.object({
  public_id: z.string().uuid(),
  state: interactionStateSchema,
  revision: z.number().int().positive(),
  requested_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
}).strict();

const redactLegacyMcpUrlInteractions = (database: Database, migratedAt: number): boolean => {
  const rows = database.query(
    `SELECT public_id,state,revision,requested_at,updated_at
     FROM provider_interactions
     WHERE kind='mcp_elicitation' AND (
       json_extract(display_json,'$.mode')='url'
       OR COALESCE(json_type(display_json,'$.url'),'null')!='null'
     )
     ORDER BY public_id`,
  ).all().map((row) => legacyMcpUrlInteractionRowSchema.parse(row));
  if (rows.length === 0) return false;

  database.exec("DROP TRIGGER IF EXISTS provider_interactions_authority_immutable");
  for (const row of rows) {
    const terminalAt = Math.max(migratedAt, row.requested_at, row.updated_at);
    if (row.state === "pending" || row.state === "response_prepared" || row.state === "response_written") {
      database.query(
        `UPDATE provider_interactions
         SET state='resolution_unknown',revision=revision+1,display_json=?,updated_at=?,terminal_at=?
         WHERE public_id=? AND revision=?`,
      ).run(migratedMcpUrlDisplayJson, terminalAt, terminalAt, row.public_id, row.revision);
      const migrated = legacyMcpUrlInteractionRowSchema.parse(database.query(
        `SELECT public_id,state,revision,requested_at,updated_at
         FROM provider_interactions WHERE public_id=?`,
      ).get(row.public_id));
      database.query(
        `INSERT INTO provider_interaction_transitions(
           public_id,revision,state,response_digest,recorded_at
         ) SELECT public_id,revision,state,response_digest,?
           FROM provider_interactions WHERE public_id=?`,
      ).run(migrated.updated_at, migrated.public_id);
    } else {
      database.query(
        "UPDATE provider_interactions SET display_json=? WHERE public_id=? AND revision=?",
      ).run(migratedMcpUrlDisplayJson, row.public_id, row.revision);
    }
  }
  database.exec(schemaVersion9);
  return true;
};

const legacyPermissionDisplaySchema = z.object({
  kind: z.literal("permission_approval"),
  summary: z.string().max(4_096),
  reason: z.string().max(4_096).nullable(),
  requested: z.array(z.object({
    name: z.string().min(1).max(256),
    value: z.unknown(),
  }).strict()).max(100),
  allowsSessionScope: z.boolean(),
}).strict();

const legacyPermissionInteractionRowSchema = z.object({
  public_id: z.string().uuid(),
  display_json: z.string(),
}).strict();

const redactLegacyPermissionValues = (database: Database): boolean => {
  const rows = database.query(
    `SELECT public_id,display_json
     FROM provider_interactions
     WHERE kind='permission_approval' AND EXISTS(
       SELECT 1 FROM json_each(json_extract(display_json,'$.requested'))
       WHERE json_type(value,'$.value') IS NOT NULL
     )
     ORDER BY public_id`,
  ).all().map((row) => legacyPermissionInteractionRowSchema.parse(row));
  if (rows.length === 0) return false;

  database.exec("DROP TRIGGER IF EXISTS provider_interactions_authority_immutable");
  for (const row of rows) {
    const legacy = legacyPermissionDisplaySchema.parse(JSON.parse(row.display_json));
    const display = interactionDisplaySchema.parse({
      ...legacy,
      requested: legacy.requested.map(({ name }) => ({ name })),
    });
    database.query(
      "UPDATE provider_interactions SET display_json=? WHERE public_id=?",
    ).run(JSON.stringify(display), row.public_id);
  }
  database.exec(schemaVersion9);
  return true;
};

const legacyApprovalDisplaySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command_approval"),
    summary: z.string().max(4_096),
    reason: z.string().max(4_096).nullable(),
    commandClass: z.string().min(1).max(256),
    workingDirectory: z.string().max(1_024).nullable(),
    allowsSessionApproval: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("file_change_approval"),
    summary: z.string().max(4_096),
    reason: z.string().max(4_096).nullable(),
    grantRoot: z.string().max(1_024).nullable(),
    allowsSessionApproval: z.boolean(),
  }).strict(),
]);

const backfillExactApprovalDecisions = (database: Database): void => {
  const rows = database.query(
    `SELECT public_id,display_json FROM provider_interactions
     WHERE kind IN ('command_approval','file_change_approval')
       AND json_type(display_json,'$.availableDecisions') IS NULL
     ORDER BY public_id`,
  ).all().map((row) => z.object({
    public_id: z.string().uuid(),
    display_json: z.string(),
  }).strict().parse(row));
  if (rows.length === 0) return;

  database.exec("DROP TRIGGER IF EXISTS provider_interactions_authority_immutable");
  for (const row of rows) {
    const legacy = legacyApprovalDisplaySchema.parse(JSON.parse(row.display_json) as unknown);
    const { allowsSessionApproval, ...display } = legacy;
    const availableDecisions = [
      "once" as const,
      ...(allowsSessionApproval ? ["session" as const] : []),
      "decline" as const,
      "cancel" as const,
    ];
    const migrated = interactionDisplaySchema.parse({ ...display, availableDecisions });
    database.query(
      "UPDATE provider_interactions SET display_json=? WHERE public_id=?",
    ).run(JSON.stringify(migrated), row.public_id);
  }
  database.exec(schemaVersion9);
};

const usageSnapshotReceivedAt = (snapshot: UsageSnapshotRecord): number => {
  const parsed = storedAccountUsageSnapshotSchema.safeParse(snapshot.payload);
  return parsed.success ? parsed.data.observation.receivedAt : snapshot.observedAt;
};

const recordUsageCloudUploadAnchor = (
  database: Database,
  profileId: ProfileId,
  sourceRevision: number,
  receivedAt: number,
): void => {
  const latest = database.query(
    `SELECT source_revision,received_at FROM usage_cloud_upload_anchors
     WHERE profile_id=? ORDER BY source_revision DESC LIMIT 1`,
  ).get(profileId) as { source_revision: number; received_at: number } | null;
  if (
    latest !== null
    && (
      sourceRevision <= latest.source_revision
      || receivedAt < latest.received_at + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS
    )
  ) return;
  database.query(
    `INSERT OR IGNORE INTO usage_cloud_upload_anchors(
       profile_id,source_revision,received_at
     ) VALUES (?,?,?)`,
  ).run(profileId, sourceRevision, receivedAt);
  database.query(
    `DELETE FROM usage_cloud_upload_anchors WHERE rowid IN (
       SELECT rowid FROM usage_cloud_upload_anchors WHERE profile_id=?
       ORDER BY source_revision DESC
       LIMIT -1 OFFSET ${USAGE_CLOUD_UPLOAD_ANCHOR_COUNT}
     )`,
  ).run(profileId);
};

const backfillUsageCloudUploadAnchors = (database: Database): void => {
  const profiles = database.query("SELECT id FROM profiles ORDER BY id").all();
  for (const row of profiles) {
    const profileId = z.object({ id: profileIdSchema }).strict().parse(row).id;
    const snapshots = database.query(
      `SELECT source_revision,observed_at,payload_json FROM usage_snapshots
       WHERE profile_id=? ORDER BY source_revision`,
    ).all(profileId);
    for (const snapshotRow of snapshots) {
      const parsed = z.object({
        source_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        observed_at: unixMillisecondsSchema,
        payload_json: z.string(),
      }).strict().parse(snapshotRow);
      recordUsageCloudUploadAnchor(
        database,
        profileId,
        parsed.source_revision,
        usageSnapshotReceivedAt({
          observedAt: parsed.observed_at,
          payload: JSON.parse(parsed.payload_json) as unknown,
          sourceRevision: parsed.source_revision,
        }),
      );
    }
  }
};

const pruneProfileUsageHistory = (
  database: Database,
  profileId: ProfileId,
  now: number,
): void => {
  const cutoff = Math.max(0, now - USAGE_LOCAL_RETAIN_AGE_MS);
  database.query(
    `DELETE FROM usage_snapshots
     WHERE profile_id=?
       AND CASE
         WHEN json_type(payload_json,'$.observation.receivedAt')='integer'
           THEN json_extract(payload_json,'$.observation.receivedAt')
         ELSE observed_at
       END<?`,
  ).run(profileId, cutoff);
  database.query(
    "DELETE FROM usage_poll_failures WHERE profile_id=? AND observed_at<?",
  ).run(profileId, cutoff);
  database.query(
    `DELETE FROM usage_snapshots WHERE rowid IN (
       SELECT rowid FROM usage_snapshots WHERE profile_id=?
       ORDER BY CASE
         WHEN json_type(payload_json,'$.observation.receivedAt')='integer'
           THEN json_extract(payload_json,'$.observation.receivedAt')
         ELSE observed_at
       END DESC,source_revision DESC
       LIMIT -1 OFFSET ${USAGE_LOCAL_RETAIN_SUCCESS_COUNT}
     )`,
  ).run(profileId);
  database.query(
    `DELETE FROM usage_poll_failures WHERE rowid IN (
       SELECT rowid FROM usage_poll_failures WHERE profile_id=?
       ORDER BY observed_at DESC,source_revision DESC
       LIMIT -1 OFFSET ${USAGE_LOCAL_RETAIN_FAILURE_COUNT}
     )`,
  ).run(profileId);
  database.query(
    `DELETE FROM usage_snapshots WHERE rowid IN (
       SELECT rowid FROM (
         SELECT
           rowid,
           SUM(length(CAST(payload_json AS BLOB))) OVER (
             ORDER BY CASE
               WHEN json_type(payload_json,'$.observation.receivedAt')='integer'
                 THEN json_extract(payload_json,'$.observation.receivedAt')
               ELSE observed_at
             END DESC,source_revision DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS retained_bytes
         FROM usage_snapshots
         WHERE profile_id=?
       )
       WHERE retained_bytes>?
     )`,
  ).run(profileId, USAGE_LOCAL_RETAIN_BYTES);
};

const pruneAllUsageHistory = (database: Database, now: number): void => {
  const rows = database.query("SELECT id FROM profiles ORDER BY id").all();
  for (const row of rows) {
    const profileId = z.object({ id: profileIdSchema }).strict().parse(row).id;
    pruneProfileUsageHistory(database, profileId, now);
  }
};

const migrateWritableDatabase = (
  database: Database,
  now: () => number,
  securityScrubCheckpoint: SecurityScrubCheckpointPolicy = defaultSecurityScrubCheckpointPolicy,
): void => {
  const initialVersion = readUserVersion(database);
  if (initialVersion > currentSchemaVersion) {
    throw new Error(`STATE_SCHEMA_NEWER:${initialVersion}:${currentSchemaVersion}`);
  }
  if (initialVersion === currentSchemaVersion) assertCanonicalLabelKeys(database);

  // Security migrations may replace secret-bearing legacy records. SQLite must
  // overwrite superseded cell content instead of leaving it in free pages.
  database.exec("PRAGMA secure_delete = ON");
  const securityScrubPending = database.transaction(() => {
    let redacted = false;
    let version = initialVersion;
    // v9-v12 databases may have committed URL-bearing MCP records or their
    // superseded bytes without retaining evidence that WAL truncation finished.
    // Materializing the v13 authority inside this transaction makes the byte
    // purge independently retryable from the interaction state transition.
    // v14 also forces previously stamped v13 databases through this authority
    // and installs stable queue ordering before the physical rebuild.
    database.exec(schemaVersion13);
    if (initialVersion >= 9 && initialVersion < 14) requireSecurityScrub(database, now());
    if (version < 1) {
      database.exec(schemaVersion1);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(1, now());
      database.exec("PRAGMA user_version = 1");
      version = 1;
    }

    // A few pre-release v1 fixtures contained only the then-reachable subset
    // of the schema. Reapplying the canonical CREATE IF NOT EXISTS statements
    // materializes the omitted tables without rewriting existing objects.
    database.exec(schemaVersion1);

    if (version < 2) {
      // Early development builds accidentally stamped this column as schema v1.
      // Accept those databases without weakening the canonical append-only v1→v2 path.
      if (!hasTableColumn(database, "sessions", "provider_updated_at")) {
        database.exec("ALTER TABLE sessions ADD COLUMN provider_updated_at REAL CHECK(provider_updated_at IS NULL OR provider_updated_at >= 0)");
      }
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(2, now());
      database.exec("PRAGMA user_version = 2");
      version = 2;
    }

    if (version < 3) {
      const desktopColumns = [
        ["switch_generation", "INTEGER CHECK(switch_generation IS NULL OR switch_generation > 0)"],
        ["journal_prepared", "INTEGER NOT NULL DEFAULT 1 CHECK(journal_prepared IN (0,1))"],
        ["journal_digest", "TEXT CHECK(journal_digest IS NULL OR length(journal_digest) = 64)"],
        ["bundle_cd_hash", "TEXT"],
        ["source_pid", "INTEGER CHECK(source_pid IS NULL OR source_pid > 0)"],
        ["expected_account_key", "TEXT"],
        ["launched_pid", "INTEGER CHECK(launched_pid IS NULL OR launched_pid > 0)"],
      ] as const;
      for (const [name, declaration] of desktopColumns) {
        if (!hasTableColumn(database, "desktop_switches", name)) {
          database.exec(`ALTER TABLE desktop_switches ADD COLUMN ${name} ${declaration}`);
        }
      }
      database.exec(schemaVersion3);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(3, now());
      database.exec("PRAGMA user_version = 3");
      version = 3;
    }

    if (version < 4) {
      database.exec(schemaVersion4);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(4, now());
      database.exec("PRAGMA user_version = 4");
      version = 4;
    }

    if (version < 5) {
      const desktopRecoveryColumns = [
        ["ambiguous_from_phase", "TEXT CHECK(ambiguous_from_phase IS NULL OR ambiguous_from_phase IN ('prepared','quit_started','quit_confirmed','launch_started','verify_started'))"],
        ["recovery_deadline_at", "INTEGER CHECK(recovery_deadline_at IS NULL OR recovery_deadline_at >= 0)"],
      ] as const;
      for (const [name, declaration] of desktopRecoveryColumns) {
        if (!hasTableColumn(database, "desktop_switches", name)) {
          database.exec(`ALTER TABLE desktop_switches ADD COLUMN ${name} ${declaration}`);
        }
      }
      if (!hasTableColumn(database, "desktop_switch_authority", "released_generation")) {
        database.exec("ALTER TABLE desktop_switch_authority ADD COLUMN released_generation INTEGER NOT NULL DEFAULT 0 CHECK(released_generation >= 0 AND released_generation <= current_generation)");
      }
      database.exec(schemaVersion5);
      database.exec("UPDATE desktop_switches SET recovery_deadline_at=updated_at+30000 WHERE journal_prepared=1 AND recovery_deadline_at IS NULL");
      database.exec(`UPDATE desktop_switch_authority
                     SET released_generation=current_generation
                     WHERE current_attempt_id IS NOT NULL
                       AND EXISTS(
                         SELECT 1 FROM mutation_attempts m
                         JOIN desktop_switches d ON d.attempt_id=m.id
                         WHERE m.id=desktop_switch_authority.current_attempt_id
                           AND ((m.state='applied' AND d.phase='applied') OR m.state='cancelled' OR (m.state='failed' AND d.phase='failed'))
                       )`);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(5, now());
      database.exec("PRAGMA user_version = 5");
      version = 5;
    }

    if (version < 6) {
      database.exec(schemaVersion6);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(6, now());
      database.exec("PRAGMA user_version = 6");
      version = 6;
    }

    if (version < 7) {
      database.exec(schemaVersion7);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(7, now());
      database.exec("PRAGMA user_version = 7");
      version = 7;
    }

    if (version < 8) {
      database.exec(schemaVersion8);
      const migratedAt = now();
      backfillExactTurnRuntimeProfiles(database, migratedAt);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(8, migratedAt);
      database.exec("PRAGMA user_version = 8");
      version = 8;
    }

    if (version < 9) {
      database.exec(schemaVersion9);
      const migratedAt = now();
      backfillSchemaVersion9(database, migratedAt);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(9, migratedAt);
      database.exec("PRAGMA user_version = 9");
      version = 9;
    }

    if (version < 10) {
      database.exec(schemaVersion10);
      backfillSchemaVersion10(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(10, now());
      database.exec("PRAGMA user_version = 10");
      version = 10;
    }

    if (version < 11) {
      const migratedAt = now();
      redacted = redactLegacyMcpUrlInteractions(database, migratedAt);
      database.exec(schemaVersion11);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(11, migratedAt);
      database.exec("PRAGMA user_version = 11");
      version = 11;
    }

    if (version < 12) {
      database.exec(schemaVersion12);
      backfillUsageCloudUploadAnchors(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(12, now());
      database.exec("PRAGMA user_version = 12");
      version = 12;
    }

    if (version < 13) {
      database.exec(schemaVersion13);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(13, now());
      database.exec("PRAGMA user_version = 13");
      version = 13;
    }

    if (version < 14) {
      ensureStableQueueSequence(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(14, now());
      database.exec("PRAGMA user_version = 14");
      version = 14;
    }

    if (version < 15) {
      redacted = redactLegacyPermissionValues(database) || redacted;
      if (redacted) requireSecurityScrub(database, now());
      database.exec(schemaVersion15);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(15, now());
      database.exec("PRAGMA user_version = 15");
      version = 15;
    }

    if (version < 16) {
      if (!hasTableColumn(database, "provider_interactions", "deadline_at")) {
        database.exec("ALTER TABLE provider_interactions ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 9007199254740991 CHECK(deadline_at>=requested_at AND deadline_at<=9007199254740991)");
      }
      if (!hasTableColumn(database, "provider_interactions", "intended_terminal_state")) {
        database.exec("ALTER TABLE provider_interactions ADD COLUMN intended_terminal_state TEXT CHECK(intended_terminal_state IS NULL OR intended_terminal_state IN ('resolved','declined','canceled','expired'))");
      }
      database.query(
        "UPDATE provider_interactions SET deadline_at=MIN(requested_at+?,9007199254740991) WHERE deadline_at=9007199254740991",
      ).run(INTERACTION_MAX_PENDING_MS);
      database.exec(
        "UPDATE provider_interactions SET intended_terminal_state=state WHERE intended_terminal_state IS NULL AND state IN ('resolved','declined','canceled','expired')",
      );
      database.exec(schemaVersion16);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(16, now());
      database.exec("PRAGMA user_version = 16");
      version = 16;
    }

    if (version < 17) {
      database.exec(schemaVersion17);
      const legacyLoginResolutionEvidence = JSON.stringify({
        source: "schema17",
        reason: "missing_provider_login_id",
      });
      database.query(`INSERT OR IGNORE INTO mutation_resolutions(
                        attempt_id,resolution_kind,evidence_json,receipt_json,created_at
                      )
                      SELECT m.id,'abandoned',?,NULL,?
                      FROM mutation_attempts m
                      JOIN profiles p ON p.id=m.authority_id
                      LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                      WHERE m.kind='account.login'
                        AND m.state='applied'
                        AND p.state='login_pending'
                        AND p.process_generation=m.authority_generation
                        AND r.attempt_id IS NULL
                        AND json_extract(
                          CASE WHEN json_valid(m.result_json) THEN m.result_json ELSE '{}' END,
                          '$.status'
                        )='pending'
                        AND json_extract(
                          CASE WHEN json_valid(m.result_json) THEN m.result_json ELSE '{}' END,
                          '$.loginId'
                        ) IS NULL`).run(
        legacyLoginResolutionEvidence,
        now(),
      );
      database.query(`UPDATE profiles
                      SET state='signed_out',provider_email=NULL,provider_plan=NULL,updated_at=MAX(updated_at,?)
                      WHERE state='login_pending'
                        AND EXISTS(
                          SELECT 1
                          FROM mutation_attempts m
                          JOIN mutation_resolutions r ON r.attempt_id=m.id
                          WHERE m.kind='account.login'
                            AND m.authority_id=profiles.id
                            AND m.authority_generation=profiles.process_generation
                            AND r.resolution_kind='abandoned'
                            AND r.evidence_json=?
                        )`).run(now(), legacyLoginResolutionEvidence);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(17, now());
      database.exec("PRAGMA user_version = 17");
      version = 17;
    }

    if (version < 18) {
      backfillExactApprovalDecisions(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(18, now());
      database.exec("PRAGMA user_version = 18");
      version = 18;
    }

    if (version < 19) {
      database.exec(schemaVersion19);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(19, now());
      database.exec("PRAGMA user_version = 19");
      version = 19;
    }

    if (version < 20) {
      database.exec(schemaVersion20);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(20, now());
      database.exec("PRAGMA user_version = 20");
      version = 20;
    }

    if (version < 21) {
      database.exec(schemaVersion21);
      scrubSettledQueueMessages(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(21, now());
      database.exec("PRAGMA user_version = 21");
      version = 21;
    }

    if (version < 22) {
      database.exec(schemaVersion22);
      // A pre-v22 database may already contain only tombstones while the
      // superseded bodies remain in free pages or WAL. The durable marker makes
      // the required rebuild independently retryable from the schema stamp.
      if (initialVersion > 0) requireQueueMessageScrub(database, now(), true);
      if (scrubSettledQueueMessages(database)) {
        requireQueueMessageScrub(database, now(), true);
      }
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(22, now());
      database.exec("PRAGMA user_version = 22");
      version = 22;
    }

    if (version < 23) {
      ensureQueueMessageScrubGeneration(database);
      database.exec(schemaVersion22);
      database.exec(schemaVersion23);
      // v22 shipped only in development, but its singleton authority had no
      // generation fence and its trigger definitions could be stale. Rebuild
      // every nonempty predecessor once, then let the generation-CAS loop own
      // all future runtime purges.
      if (initialVersion > 0) requireQueueMessageScrub(database, now(), true);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(23, now());
      database.exec("PRAGMA user_version = 23");
      version = 23;
    }

    if (version < 24) {
      database.exec(dropSchemaVersion24);
      backfillCanonicalLabelKeys(database);
      rebuildSchemaVersion24(database);
      assertSchemaVersion24Objects(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(24, now());
      database.exec("PRAGMA user_version = 24");
      version = 24;
    }

    if (version < 25) {
      ensureSessionEventProjectionVersion(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(25, now());
      database.exec("PRAGMA user_version = 25");
      version = 25;
    }

    if (version < 26) {
      database.exec(WORK_SCHEMA_SQL);
      assertWorkSchema(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(26, now());
      database.exec("PRAGMA user_version = 26");
      version = 26;
    }

    if (version < 27) {
      database.exec(schemaVersion27);
      ensureUsagePollFailureAccountFingerprint(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(27, now());
      database.exec("PRAGMA user_version = 27");
      version = 27;
    }

    if (version < 28) {
      database.exec(schemaVersion28);
      const migratedAt = unixMillisecondsSchema.parse(now());
      database.query(
        `INSERT INTO account_rate_limit_reset_policies(
           profile_id,state,account_fingerprint,weekly_window_resets_at,
           revision,created_at,updated_at
         )
         SELECT id,'reconciliation_required',NULL,NULL,1,?,?
         FROM profiles WHERE state!='removed' ORDER BY id
         ON CONFLICT(profile_id) DO UPDATE SET
           state='reconciliation_required',
           account_fingerprint=NULL,
           weekly_window_resets_at=NULL,
           revision=account_rate_limit_reset_policies.revision+1,
           updated_at=MAX(account_rate_limit_reset_policies.updated_at,excluded.updated_at)`,
      ).run(migratedAt, migratedAt);
      database.query(
        `DELETE FROM account_rate_limit_reset_policies
         WHERE NOT EXISTS (
           SELECT 1 FROM profiles p
           WHERE p.id=account_rate_limit_reset_policies.profile_id
             AND p.state!='removed'
         )`,
      ).run();
      assertAccountRateLimitResetPolicies(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(28, migratedAt);
      database.exec("PRAGMA user_version = 28");
      version = 28;
    }

    if (version < 29) {
      database.exec(SESSION_TASK_SCHEMA_SQL);
      assertSessionTaskSchema(database);
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(29, now());
      database.exec("PRAGMA user_version = 29");
      version = 29;
    }

    if (version < 30) {
      database.exec(schemaVersion30);
      if (!hasTableColumn(database, "daemon_state", "default_approval_mode")) {
        database.exec(schemaVersion30DefaultApprovalModeColumn);
      }
      if (!hasTableColumn(database, "provider_interactions", "resolved_by")) {
        database.exec(schemaVersion30ResolvedByColumn);
      }
      database.query("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (?, ?)").run(30, now());
      database.exec("PRAGMA user_version = 30");
      version = 30;
    }

    // Reapplying additive objects and idempotent authority backfills makes a
    // restart after any pre-release partial fixture safe without changing rows.
    database.exec(schemaVersion9);
    database.exec(schemaVersion10);
    backfillSchemaVersion9(database, now());
    backfillSchemaVersion10(database);
    redacted = redactLegacyMcpUrlInteractions(database, now()) || redacted;
    redacted = redactLegacyPermissionValues(database) || redacted;
    if (redacted) requireSecurityScrub(database, now());
    database.exec(schemaVersion11);
    database.exec(schemaVersion12);
    database.exec(schemaVersion13);
    ensureStableQueueSequence(database);
    database.exec(schemaVersion15);
    database.exec(schemaVersion16);
    database.exec(schemaVersion17);
    backfillExactApprovalDecisions(database);
    database.exec(schemaVersion19);
    database.exec(schemaVersion20);
    database.exec(schemaVersion21);
    ensureQueueMessageScrubGeneration(database);
    database.exec(schemaVersion22);
    database.exec(schemaVersion23);
    rebuildSchemaVersion24(database);
    assertSchemaVersion24Objects(database);
    ensureSessionEventProjectionVersion(database);
    database.exec(WORK_SCHEMA_SQL);
    assertWorkSchema(database);
    database.exec(schemaVersion27);
    ensureUsagePollFailureAccountFingerprint(database);
    database.exec(schemaVersion28);
    assertAccountRateLimitResetPolicies(database);
    database.exec(SESSION_TASK_SCHEMA_SQL);
    assertSessionTaskSchema(database);
    database.exec(schemaVersion30);
    if (hasSettledQueueMessagesToScrub(database)) {
      requireQueueMessageScrub(database, now(), true);
    }
    pruneAllUsageHistory(database, now());
    return hasPendingSecurityScrub(database);
  })();
  if (securityScrubPending) completePendingSecurityScrub(database, false, securityScrubCheckpoint);
};

const mapProfile = (row: unknown): ProfileRecord => {
  const parsed = profileRowSchema.parse(row);
  if (parsed.label_key !== canonicalLabelIdentity(parsed.label, "ACCOUNT").key) {
    throw new StateLabelInvariantError("ACCOUNT", "KEY_INVALID");
  }
  return {
    id: parsed.id,
    label: parsed.label,
    state: parsed.state,
    processGeneration: parsed.process_generation,
    ...(parsed.provider_email === null ? {} : { providerEmail: parsed.provider_email }),
    ...(parsed.provider_plan === null ? {} : { providerPlan: parsed.provider_plan }),
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
};

const mapProject = (row: unknown): ProjectRecord => {
  const parsed = projectRowSchema.parse(row);
  if (parsed.label_key !== canonicalLabelIdentity(parsed.label, "PROJECT").key) {
    throw new StateLabelInvariantError("PROJECT", "KEY_INVALID");
  }
  return { id: parsed.id, label: parsed.label, rootPath: parsed.root_path, default: parsed.is_default === 1, createdAt: parsed.created_at, updatedAt: parsed.updated_at };
};

const mapSession = (row: unknown): SessionRecord => {
  const parsed = sessionRowSchema.parse(row);
  return {
    id: parsed.id,
    profileId: parsed.profile_id,
    ...(parsed.project_id === null ? {} : { projectId: parsed.project_id }),
    ...(parsed.provider_thread_id === null ? {} : { providerThreadId: parsed.provider_thread_id }),
    title: parsed.title,
    note: parsed.note,
    preset: parsed.preset,
    fastEnabled: parsed.fast_enabled === 1,
    state: parsed.state,
    ...(parsed.active_turn_id === null ? {} : { activeTurnId: parsed.active_turn_id }),
    ...(parsed.provider_updated_at === null ? {} : { providerUpdatedAt: parsed.provider_updated_at }),
    revision: parsed.revision,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
};

const sessionEventStreamRowSchema = z.object({
  stream_epoch: z.string().uuid(),
  floor_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observed_through_sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retained_count: z.number().int().nonnegative(),
  retained_bytes: z.number().int().nonnegative(),
  retention_gap_reason: sessionEventGapReasonSchema.nullable(),
}).strict();

const mapSessionEventStreamPosition = (row: unknown): SessionEventStreamPosition => {
  const parsed = sessionEventStreamRowSchema.parse(row);
  return {
    streamEpoch: parsed.stream_epoch,
    floorSequence: parsed.floor_sequence,
    observedThroughSequence: parsed.observed_through_sequence,
  };
};

const interactionRowSchema = z.object({
  public_id: z.string().uuid(),
  session_id: sessionIdSchema.nullable(),
  profile_id: profileIdSchema,
  process_generation: z.number().int().nonnegative(),
  connection_id: z.string().uuid(),
  request_id_type: z.enum(["number", "string"]),
  request_id_number: z.number().int().safe().nullable(),
  request_id_text: z.string().min(1).max(512).nullable(),
  method: z.string().min(1).max(512),
  request_digest: sha256Schema,
  thread_id: z.string().min(1).max(512).nullable(),
  turn_id: z.string().min(1).max(512).nullable(),
  item_id: z.string().min(1).max(512).nullable(),
  approval_id: z.string().min(1).max(512).nullable(),
  kind: interactionKindSchema,
  state: interactionStateSchema,
  revision: z.number().int().positive(),
  blocking: z.union([z.literal(0), z.literal(1)]),
  display_json: z.string().min(2).max(65_536),
  response_digest: sha256Schema.nullable(),
  response_expected_revision: z.number().int().positive().nullable(),
  intended_terminal_state: interactionIntendedTerminalStateSchema.nullable(),
  resolved_by: z.enum(["autorespond"]).nullable(),
  requested_at: unixMillisecondsSchema,
  deadline_at: unixMillisecondsSchema,
  updated_at: unixMillisecondsSchema,
  terminal_at: unixMillisecondsSchema.nullable(),
}).strict();

const mapInteraction = (row: unknown): InteractionRecord => {
  const parsed = interactionRowSchema.parse(row);
  const requestId = parsed.request_id_type === "number"
    ? { type: "number" as const, value: z.number().int().safe().parse(parsed.request_id_number) }
    : { type: "string" as const, value: z.string().min(1).max(512).parse(parsed.request_id_text) };
  const storedDisplay = interactionDisplaySchema.parse(JSON.parse(parsed.display_json) as unknown);
  const display: InteractionDisplay = storedDisplay.kind === "mcp_elicitation"
    ? { ...storedDisplay, summary: PUBLIC_MCP_FORM_SUMMARY }
    : storedDisplay;
  return interactionRecordSchema.parse({
    version: 1,
    publicId: parsed.public_id,
    sessionId: parsed.session_id,
    authority: {
      profileId: parsed.profile_id,
      processGeneration: parsed.process_generation,
      connectionId: parsed.connection_id,
      requestId,
      method: parsed.method,
      requestDigest: parsed.request_digest,
      threadId: parsed.thread_id,
      turnId: parsed.turn_id,
      itemId: parsed.item_id,
      approvalId: parsed.approval_id,
    },
    kind: parsed.kind,
    state: parsed.state,
    revision: parsed.revision,
    blocking: parsed.blocking === 1,
    display,
    responseDigest: parsed.response_digest,
    intendedTerminalState: parsed.intended_terminal_state,
    resolvedBy: parsed.resolved_by,
    requestedAt: parsed.requested_at,
    deadlineAt: parsed.deadline_at,
    updatedAt: parsed.updated_at,
    terminalAt: parsed.terminal_at,
  });
};

const storedSessionEventEnvelopeSchema = z.object({
  body: z.unknown(),
}).passthrough();

const parseStoredSessionEvent = (
  value: string,
  projectionVersion: 1 | 2,
  projector: PublicProviderIdentifierProjector,
): SessionEvent => {
  const stored = storedSessionEventEnvelopeSchema.parse(JSON.parse(value) as unknown);
  return sessionEventSchema.parse({
    ...stored,
    body: projectionVersion === 2
      ? stored.body
      : projectPublicSessionEventBody(stored.body, projector),
  });
};

const mapSessionRuntimeProfile = (row: unknown): SessionRuntimeProfileRecord => {
  const parsed = sessionRuntimeProfileRowSchema.parse(row);
  const profile = effectiveRuntimeProfileSchema.parse(JSON.parse(parsed.profile_json) as unknown);
  if (
    profile.profileId !== parsed.profile_id
    || profile.processGeneration !== parsed.process_generation
    || profile.observedAt !== parsed.observed_at
  ) throw new Error("Stored runtime profile authority is incoherent.");
  return {
    sessionId: parsed.session_id,
    revision: parsed.revision,
    sourceKind: parsed.source_kind,
    sourceId: parsed.source_id,
    profile,
    recordedAt: parsed.recorded_at,
  };
};

const mapSessionTurnRuntimeProfile = (row: unknown): Readonly<{
  profile: EffectiveRuntimeProfile;
  sessionId: SessionId;
  sourceId: string;
  sourceKind: "turn_start" | "queue_start";
  turnId: string;
}> => {
  const parsed = sessionTurnRuntimeProfileRowSchema.parse(row);
  const profile = effectiveRuntimeProfileSchema.parse(JSON.parse(parsed.profile_json) as unknown);
  if (
    profile.profileId !== parsed.profile_id
    || profile.processGeneration !== parsed.process_generation
    || profile.observedAt !== parsed.observed_at
    || digestJson(profile) !== parsed.profile_digest
  ) throw new Error("Stored turn runtime profile authority is incoherent.");
  return {
    profile,
    sessionId: parsed.session_id,
    sourceId: parsed.source_id,
    sourceKind: parsed.source_kind,
    turnId: parsed.turn_id,
  };
};

const desktopSwitchRowSchema = z
  .object({
    attempt_id: attemptIdSchema,
    idempotency_key: z.string().uuid(),
    mutation_state: mutationStateSchema,
    result_json: z.string().nullable(),
    source_profile_id: profileIdSchema.nullable(),
    target_profile_id: profileIdSchema,
    source_generation: positiveGenerationSchema.nullable(),
    target_generation: positiveGenerationSchema,
    phase: desktopSwitchPhaseSchema,
    diagnostic_code: desktopDiagnosticSchema.nullable(),
    switch_generation: positiveGenerationSchema,
    journal_prepared: z.union([z.literal(0), z.literal(1)]),
    journal_digest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
    bundle_cd_hash: z.string().regex(/^[a-f0-9]{40,128}$/u).nullable(),
    source_pid: z.number().int().positive().nullable(),
    expected_account_key: desktopAccountKeySchema,
    launched_pid: z.number().int().positive().nullable(),
    ambiguous_from_phase: z.enum(["prepared", "quit_started", "quit_confirmed", "launch_started", "verify_started"]).nullable(),
    recovery_deadline_at: unixMillisecondsSchema.nullable(),
    resolution_kind: desktopRecoveryResolutionSchema.nullable(),
    resolution_diagnostic_code: desktopDiagnosticSchema.nullable(),
    resolution_observation_digest: sha256Schema.nullable(),
    resolution_receipt_json: z.string().nullable(),
    resolution_resolved_at: unixMillisecondsSchema.nullable(),
  })
  .strict();

type DesktopSwitchRow = z.infer<typeof desktopSwitchRowSchema>;

const desktopRecoveryReceiptSchema = z
  .object({
    status: desktopRecoveryResolutionSchema,
    attemptId: attemptIdSchema,
    idempotencyKey: z.string().uuid(),
    switchGeneration: positiveGenerationSchema,
    sourceProfileId: profileIdSchema.nullable(),
    sourceProcessGeneration: positiveGenerationSchema.nullable(),
    targetProfileId: profileIdSchema,
    targetProcessGeneration: positiveGenerationSchema,
    diagnostic: desktopDiagnosticSchema,
    observationDigest: sha256Schema,
    resolvedAt: unixMillisecondsSchema,
    activeAccount: z
      .object({
        signedIn: z.boolean(),
        email: z.string().trim().email().max(320).optional(),
        plan: z.string().trim().min(1).max(160).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const desktopSwitchSelect = `SELECT d.attempt_id,m.idempotency_key,m.state AS mutation_state,m.result_json,
  d.source_profile_id,d.target_profile_id,d.source_generation,d.target_generation,d.phase,d.diagnostic_code,
  d.switch_generation,d.journal_prepared,d.journal_digest,d.bundle_cd_hash,d.source_pid,d.expected_account_key,
  d.launched_pid,d.ambiguous_from_phase,d.recovery_deadline_at,
  r.resolution_kind,r.diagnostic_code AS resolution_diagnostic_code,
  r.observation_digest AS resolution_observation_digest,r.receipt_json AS resolution_receipt_json,
  r.resolved_at AS resolution_resolved_at
  FROM desktop_switches d
  JOIN mutation_attempts m ON m.id=d.attempt_id
  LEFT JOIN desktop_switch_resolutions r ON r.attempt_id=d.attempt_id`;

const switchPhaseByStage: Readonly<Record<DesktopSwitchStage, z.infer<typeof desktopSwitchPhaseSchema>>> = {
  prepared: "prepared",
  "quit-requested": "quit_started",
  "source-quiesced": "quit_confirmed",
  "launch-requested": "launch_started",
  "target-observed": "verify_started",
  verified: "applied",
  "recovery-required": "ambiguous",
};

const effectAdjacentPhases = new Set<z.infer<typeof desktopSwitchPhaseSchema>>([
  "quit_started",
  "quit_confirmed",
  "launch_started",
  "verify_started",
]);
const desktopRecoverySettlementMs = 30_000;

const digestJson = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const parseOptionalPlan = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const parsed = z.string().trim().min(1).max(160).safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export class SelectionError extends Error {
  constructor(readonly code: "NOT_FOUND" | "AMBIGUOUS", readonly candidates: readonly { id: string; label: string }[] = []) {
    super(code === "NOT_FOUND" ? "No matching object was found." : "The selector matches more than one object.");
    this.name = "SelectionError";
  }
}

export class StateSecurityScrubRequiredError extends Error {
  constructor(
    readonly operationCommitted: boolean,
    cause?: unknown,
  ) {
    super("STATE_SECURITY_SCRUB_REQUIRED", { cause });
    this.name = "StateSecurityScrubRequiredError";
  }
}

export class UnusableProjectRootError extends Error {
  constructor() {
    super("Project root must be an existing readable, writable, traversable canonical directory without symbolic links.");
    this.name = "UnusableProjectRootError";
  }
}

export class StateStore {
  readonly #database: Database;
  readonly #now: () => number;
  readonly #readonly: boolean;
  readonly #securityScrubCheckpoint: SecurityScrubCheckpointPolicy;
  #publicProviderIdentifierProjector: PublicProviderIdentifierProjector;
  readonly paths: StatePaths;

  constructor(paths: StatePaths, options: {
    readonly?: boolean;
    now?: () => number;
    beforeDatabaseOpen?: (input: Readonly<{ flags: number; path: string }>) => void;
    publicProviderIdentifierProjector?: PublicProviderIdentifierProjector;
    // Test-only. Shortens the scrub checkpoint wait so a pinned-reader test
    // does not spend the production 5 s budget. Never passed by the CLI or daemon.
    securityScrubCheckpoint?: SecurityScrubCheckpointPolicy;
  } = {}) {
    this.paths = paths;
    this.#now = options.now ?? Date.now;
    this.#readonly = options.readonly === true;
    this.#securityScrubCheckpoint = options.securityScrubCheckpoint === undefined
      ? defaultSecurityScrubCheckpointPolicy
      : securityScrubCheckpointPolicySchema.parse(options.securityScrubCheckpoint);
    this.#publicProviderIdentifierProjector = options.publicProviderIdentifierProjector
      ?? processLocalPublicProviderIdentifierProjector;
    const databaseFile = prepareStateDatabaseFile(paths.database, this.#readonly);
    const databaseOpenFlags = stateDatabaseOpenFlags(this.#readonly);
    options.beforeDatabaseOpen?.({ flags: databaseOpenFlags, path: paths.database });
    // Bun's object options do not expose SQLITE_OPEN_NOFOLLOW. Numeric flags are
    // therefore the actual SQLite open boundary. This store binds positionally,
    // so dropping Bun's JavaScript-only `strict` binding option does not change
    // its statement contract; SQLite STRICT tables remain schema-enforced.
    this.#database = new Database(paths.database, databaseOpenFlags);
    try {
      assertStateDatabaseFile(paths.database, databaseFile);
      this.#database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${stateBusyTimeoutMs};`);
      if (!options.readonly) {
        requireWalMode(this.#database, true);
        this.#database.exec("PRAGMA synchronous = FULL;");
        migrateWritableDatabase(this.#database, this.#now, this.#securityScrubCheckpoint);
      } else {
        const version = readUserVersion(this.#database);
        if (version > currentSchemaVersion) throw new Error(`STATE_SCHEMA_NEWER:${version}:${currentSchemaVersion}`);
        if (version < currentSchemaVersion) throw new Error(`STATE_SCHEMA_MIGRATION_REQUIRED:${version}:${currentSchemaVersion}`);
        if (hasPendingSecurityScrub(this.#database)) throw new Error("STATE_SECURITY_SCRUB_REQUIRED");
      }
      assertSchemaVersion24Objects(this.#database);
      // A readonly open skips the O(rows) foreign_key_check so `hra status`
      // never pins a WAL snapshot long enough to block the writer's scrub.
      if (this.#readonly) assertReadonlyWorkSchema(this.#database);
      else assertWorkSchema(this.#database);
      assertCanonicalLabelKeys(this.#database);
      assertAccountRateLimitResetPolicies(this.#database);
      assertSessionTaskSchema(this.#database);
      assertStateDatabaseFile(paths.database, databaseFile);
    } catch (error) {
      this.#database.close(false);
      throw error;
    }
  }

  close(): void {
    this.#database.close(false);
  }

  createWorkStore(
    daemonGeneration: number,
    encodeCursor: WorkCursorEncoder,
    capabilities: Readonly<{
      issue: WorkCapabilityIssuer;
      verify: WorkCapabilityVerifier;
    }>,
  ): WorkStore {
    return new WorkStore(this.#database, {
      daemonGeneration,
      encodeCursor,
      issueCapability: capabilities.issue,
      verifyCapability: capabilities.verify,
      projectProviderIdentifier: (value) => this.#publicProviderIdentifierProjector(value),
      now: this.#now,
    });
  }

  createSessionTaskStore(): SessionTaskStore {
    return new SessionTaskStore(this.#database, { now: this.#now });
  }

  isConversationAutomationEnabled(
    sessionId: SessionId,
    providerThreadId: string,
  ): boolean {
    const row = this.#database.query(
      `SELECT 1
       FROM session_conversation_automation
       WHERE session_id=? AND provider_thread_id=?`,
    ).get(
      sessionIdSchema.parse(sessionId),
      providerThreadIdSchema.parse(providerThreadId),
    );
    return row !== null;
  }

  isSessionTaskQueueSource(sessionId: SessionId, queueId: QueueId): boolean {
    const row = this.#database.query(
      `SELECT 1
       FROM session_task_occurrences
       WHERE session_id=? AND queue_id=?`,
    ).get(sessionIdSchema.parse(sessionId), queueIdSchema.parse(queueId));
    return row !== null;
  }

  isSessionTaskTurnSource(sessionId: SessionId, turnId: string): boolean {
    const row = this.#database.query(
      `SELECT 1
       FROM session_task_occurrences o
       JOIN session_turn_runtime_profiles p
         ON p.session_id=o.session_id
        AND p.source_kind='queue_start'
        AND p.source_id=o.queue_id
       WHERE o.session_id=? AND p.turn_id=?`,
    ).get(
      sessionIdSchema.parse(sessionId),
      z.string().min(1).max(200).parse(turnId),
    );
    return row !== null;
  }

  configurePublicProviderIdentifierProjector(
    projector: PublicProviderIdentifierProjector,
  ): void {
    this.#publicProviderIdentifierProjector = projector;
  }

  projectPublicProviderIdentifier(value: string): PublicProviderIdentifier {
    return this.#publicProviderIdentifierProjector(value);
  }

  createProfile(label: string): ProfileRecord {
    const id = createProfileId();
    const parsedLabel = labelSchema.parse(label);
    const labelKey = canonicalLabelIdentity(parsedLabel, "ACCOUNT").key;
    const now = unixMillisecondsSchema.parse(this.#now());
    const create = this.#database.transaction(() => {
      this.#database.query("INSERT INTO profiles(id,label,label_key,state,process_generation,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, parsedLabel, labelKey, "signed_out", 0, now, now);
      this.#database.query(
        `INSERT INTO account_rate_limit_reset_policies(
           profile_id,state,account_fingerprint,weekly_window_resets_at,
           revision,created_at,updated_at
         ) VALUES (?,'active_unbound',NULL,NULL,1,?,?)`,
      ).run(id, now, now);
      return mapProfile(this.#database.query("SELECT * FROM profiles WHERE id=?").get(id));
    });
    return create.immediate();
  }

  listProfiles(options: { includeRemoved?: boolean } = {}): readonly ProfileRecord[] {
    const rows = options.includeRemoved
      ? this.#database.query("SELECT * FROM profiles ORDER BY label_key, id").all()
      : this.#database.query("SELECT * FROM profiles WHERE state != 'removed' ORDER BY label_key, id").all();
    return rows.map(mapProfile);
  }

  requireProfile(selector: string): ProfileRecord {
    const selected = selectByIdOrLabel(this.listProfiles(), selector);
    if (selected.kind === "found") return selected.value;
    throw new SelectionError(selected.kind === "missing" ? "NOT_FOUND" : "AMBIGUOUS", selected.kind === "ambiguous" ? selected.values : []);
  }

  requireProfileById(profileId: ProfileId, options: { includeRemoved?: boolean } = {}): ProfileRecord {
    const parsedId = profileIdSchema.parse(profileId);
    const row = options.includeRemoved
      ? this.#database.query("SELECT * FROM profiles WHERE id=?").get(parsedId)
      : this.#database.query("SELECT * FROM profiles WHERE id=? AND state!='removed'").get(parsedId);
    if (row === null) throw new SelectionError("NOT_FOUND");
    return mapProfile(row);
  }

  nextProfileGeneration(profileId: ProfileId): ProfileRecord {
    const now = this.#now();
    const update = this.#database.transaction(() => {
      const current = mapProfile(this.#database.query("SELECT * FROM profiles WHERE id = ? AND state != 'removed'").get(profileId));
      this.#database.query("UPDATE profiles SET process_generation = ?, updated_at = ? WHERE id = ? AND process_generation = ?").run(current.processGeneration + 1, now, profileId, current.processGeneration);
    });
    update.immediate();
    return this.requireProfile(profileId);
  }

  advanceProfileGeneration(profileId: ProfileId, expectedGeneration: number): ProfileRecord {
    return this.#advanceProfileGeneration(profileId, expectedGeneration).profile;
  }

  advanceProfileGenerationWithWorkRetirement(
    profileId: ProfileId,
    expectedGeneration: number,
    workStore: WorkStore,
  ): ProfileAuthorityChangeResult {
    return this.#advanceProfileGeneration(profileId, expectedGeneration, workStore);
  }

  #advanceProfileGeneration(
    profileId: ProfileId,
    expectedGeneration: number,
    workStore?: WorkStore,
  ): ProfileAuthorityChangeResult {
    const now = this.#now();
    const advance = this.#database.transaction(() => {
      const current = mapProfile(this.#database.query("SELECT * FROM profiles WHERE id=? AND state!='removed'").get(profileId));
      if (current.processGeneration !== expectedGeneration) {
        throw new Error("Profile generation authority changed.");
      }
      const activeLogin = this.#database.query(`SELECT attempt_id,process_generation
                                                FROM provider_login_authorities
                                                WHERE profile_id=? AND state='active'`).all(profileId) as {
        attempt_id: string;
        process_generation: number;
      }[];
      if (activeLogin.length > 1) throw new Error("LOGIN_GENERATION_AUTHORITY_AMBIGUOUS");
      if (activeLogin.length === 1) {
        if (
          current.state !== "login_pending"
          || activeLogin[0]?.process_generation !== expectedGeneration
        ) throw new Error("LOGIN_GENERATION_AUTHORITY_MISMATCH");
        const rebound = this.#database.query(`UPDATE provider_login_authorities
                                              SET process_generation=?,updated_at=MAX(updated_at,?)
                                              WHERE attempt_id=? AND process_generation=? AND state='active'`).run(
          expectedGeneration + 1,
          now,
          activeLogin[0].attempt_id,
          expectedGeneration,
        );
        if (rebound.changes !== 1) throw new Error("LOGIN_GENERATION_AUTHORITY_CAS_CONFLICT");
      }
      const state = current.state === "login_pending" && activeLogin.length === 0
        ? "recovery_required"
        : current.state;
      const affectedWorkIds = workStore?.prepareProfileAuthorityChange(
        profileId,
        expectedGeneration,
      ) ?? [];
      const result = this.#database
        .query("UPDATE profiles SET process_generation = ?, state=?, updated_at = ? WHERE id = ? AND process_generation = ? AND state != 'removed'")
        .run(expectedGeneration + 1, state, now, profileId, expectedGeneration);
      if (result.changes !== 1) throw new Error("Profile generation authority changed.");
      return [...affectedWorkIds];
    });
    const affectedWorkIds = advance.immediate();
    return { profile: this.requireProfile(profileId), affectedWorkIds };
  }

  setProfileState(profileId: ProfileId, expectedGeneration: number, state: z.infer<typeof profileStateSchema>, identity?: { email?: string; plan?: string }): boolean {
    return this.#setProfileState(profileId, expectedGeneration, state, identity).changed;
  }

  setProfileStateWithWorkRetirement(
    profileId: ProfileId,
    expectedGeneration: number,
    state: z.infer<typeof profileStateSchema>,
    workStore: WorkStore,
    identity?: { email?: string; plan?: string },
  ): ProfileStateChangeResult {
    const result = this.#setProfileState(
      profileId,
      expectedGeneration,
      state,
      identity,
      workStore,
    );
    return {
      ...result,
      profile: this.requireProfileById(profileId, { includeRemoved: true }),
    };
  }

  #closeRecoverableAccountRateLimitResetIdentityAttempts(input: {
    profileId: ProfileId;
    accountFingerprint: string;
    selection: "matching" | "different";
    now: number;
  }): void {
    const fingerprintPredicate = input.selection === "matching" ? "=" : "!=";
    this.#database.query(
      `UPDATE account_rate_limit_reset_attempts
       SET state='ambiguous',updated_at=MAX(updated_at,?)
       WHERE profile_id=? AND account_fingerprint${fingerprintPredicate}?
         AND state='effect_started'`,
    ).run(input.now, input.profileId, input.accountFingerprint);
    this.#database.query(
      `UPDATE account_rate_limit_reset_attempts
       SET state='closed',local_resolution='account_identity_changed',
         updated_at=MAX(updated_at,?)
       WHERE profile_id=? AND account_fingerprint${fingerprintPredicate}?
         AND state IN ('prepared','ambiguous','retryable')`,
    ).run(input.now, input.profileId, input.accountFingerprint);
  }

  #setProfileState(
    profileId: ProfileId,
    expectedGeneration: number,
    state: z.infer<typeof profileStateSchema>,
    identity?: { email?: string; plan?: string },
    workStore?: WorkStore,
  ): Omit<ProfileStateChangeResult, "profile"> {
    const now = this.#now();
    const update = this.#database.transaction(() => {
      const current = this.#database.query(
        "SELECT process_generation,state,provider_email FROM profiles WHERE id=? AND state!='removed'",
      ).get(profileId) as {
        process_generation: number;
        provider_email: string | null;
        state: z.infer<typeof profileStateSchema>;
      } | null;
      if (
        current === null
        || current.process_generation !== expectedGeneration
        || (current.state === "recovery_required" && state !== "recovery_required")
      ) {
        return { affectedWorkIds: [] as string[], changed: false };
      }
      const policy = this.requireAccountRateLimitResetPolicy(profileId);
      const nextAccountFingerprint = state === "signed_in" && identity?.email !== undefined
        ? canonicalAccountFingerprint(identity.email)
        : null;
      const previousProviderFingerprint = current.provider_email === null
        ? null
        : canonicalAccountFingerprint(current.provider_email);
      const changedProviderIdentity = nextAccountFingerprint !== null
        && previousProviderFingerprint !== null
        && previousProviderFingerprint !== nextAccountFingerprint;
      const changedPolicyIdentity = nextAccountFingerprint !== null
        && policy.accountFingerprint !== null
        && policy.accountFingerprint !== nextAccountFingerprint;
      const affectedWorkIds = state === "signed_in"
        ? []
        : [...(workStore?.prepareProfileAuthorityChange(profileId, expectedGeneration) ?? [])];
      const result = this.#database.query(
        `UPDATE profiles
         SET state=?,provider_email=?,provider_plan=?,updated_at=?
         WHERE id=?
           AND process_generation=?
           AND state!='removed'
           AND (state!='recovery_required' OR ?='recovery_required')`,
      )
      .run(state, identity?.email ?? null, identity?.plan ?? null, now, profileId, expectedGeneration, state);
      if (result.changes !== 1) throw new Error("Profile state authority changed.");
      if (changedProviderIdentity || changedPolicyIdentity) {
        if (policy.accountFingerprint !== null) {
          this.#closeRecoverableAccountRateLimitResetIdentityAttempts({
            profileId,
            accountFingerprint: policy.accountFingerprint,
            selection: "matching",
            now,
          });
        }
        const policyChanged = this.#database.query(
          `UPDATE account_rate_limit_reset_policies
           SET state='reconciliation_required',account_fingerprint=NULL,
             weekly_window_resets_at=NULL,revision=revision+1,
             updated_at=MAX(updated_at,?)
           WHERE profile_id=? AND revision=?
             AND state=?
             AND account_fingerprint IS ?
             AND weekly_window_resets_at IS ?`,
        ).run(
          now,
          profileId,
          policy.revision,
          policy.state,
          policy.accountFingerprint,
          policy.weeklyWindowResetsAt,
        );
        if (policyChanged.changes !== 1) {
          throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_CONFLICT");
        }
      }
      if (state === "signed_in" || state === "signed_out") {
        this.#database.query(`UPDATE provider_login_authorities
                              SET state='settled',settlement=?,updated_at=?
                              WHERE profile_id=? AND process_generation=? AND state='active'`).run(
          state === "signed_in" ? "signed_in" : "provider_disconnected",
          now,
          profileId,
          expectedGeneration,
        );
      }
      return { affectedWorkIds, changed: true };
    });
    return update.immediate();
  }

  reconcileProfileRecoveryFromAccountRead(input: {
    profileId: ProfileId;
    expectedGeneration: number;
    provider: { signedIn: boolean; email?: string; plan?: string };
  }): ProfileRecord {
    const profileId = profileIdSchema.parse(input.profileId);
    const expectedGeneration = z.number().int().nonnegative()
      .max(Number.MAX_SAFE_INTEGER).parse(input.expectedGeneration);
    const provider = z.object({
      signedIn: z.boolean(),
      email: z.string().email().optional(),
      plan: z.string().max(128).optional(),
    }).strict().parse(input.provider);
    const reconcile = this.#database.transaction(() => {
      const generic = z.object({ count: z.number().int().nonnegative() }).strict().parse(
        this.#database.query(
          `SELECT COUNT(*) AS count FROM mutation_attempts m
           LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
           WHERE m.authority_id=? AND m.authority_generation=?
             AND m.state IN ('effect_started','ambiguous')
             AND r.attempt_id IS NULL`,
        ).get(profileId, expectedGeneration),
      );
      const resets = z.object({ count: z.number().int().nonnegative() }).strict().parse(
        this.#database.query(
          `SELECT COUNT(*) AS count FROM account_rate_limit_reset_attempts
           WHERE profile_id=? AND current_process_generation=?
             AND state IN ('prepared','effect_started','ambiguous','retryable')`,
        ).get(profileId, expectedGeneration),
      );
      if (generic.count !== 0 || resets.count !== 0) {
        throw new Error("PROFILE_RECOVERY_AUTHORITY_UNSETTLED");
      }
      const state = provider.signedIn ? "signed_in" : "signed_out";
      const now = unixMillisecondsSchema.parse(this.#now());
      const changed = this.#database.query(
        `UPDATE profiles SET state=?,provider_email=?,provider_plan=?,updated_at=?
         WHERE id=? AND process_generation=? AND state='recovery_required'`,
      ).run(
        state,
        provider.signedIn ? provider.email ?? null : null,
        provider.signedIn ? provider.plan ?? null : null,
        now,
        profileId,
        expectedGeneration,
      );
      if (changed.changes !== 1) {
        throw new Error("PROFILE_RECOVERY_AUTHORITY_CHANGED");
      }
      this.#database.query(
        `UPDATE provider_login_authorities
         SET state='settled',settlement=?,updated_at=?
         WHERE profile_id=? AND process_generation=? AND state='active'`,
      ).run(
        state === "signed_in" ? "signed_in" : "provider_disconnected",
        now,
        profileId,
        expectedGeneration,
      );
    });
    reconcile.immediate();
    return this.requireProfileById(profileId);
  }

  removeProfile(profileId: ProfileId): void {
    const id = profileIdSchema.parse(profileId);
    const remove = this.#database.transaction(() => {
      const active = this.#database.query(
        "SELECT COUNT(*) AS count FROM sessions WHERE profile_id=? AND state NOT IN ('terminal')",
      ).get(id) as { count: number } | null;
      if ((active?.count ?? 0) !== 0) {
        throw new Error("Profile still owns active sessions.");
      }
      const now = unixMillisecondsSchema.parse(this.#now());
      const result = this.#database.query(
        `UPDATE profiles
         SET state='removed',provider_email=NULL,provider_plan=NULL,updated_at=?
         WHERE id=? AND state!='removed'`,
      ).run(now, id);
      if (result.changes !== 1) throw new SelectionError("NOT_FOUND");
      const policy = this.#database.query(
        "DELETE FROM account_rate_limit_reset_policies WHERE profile_id=?",
      ).run(id);
      if (policy.changes !== 1) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
      }
    });
    remove.immediate();
  }

  async createProject(label: string, requestedRoot: string, makeDefault = false): Promise<ProjectRecord> {
    const canonical = await resolveUsableCanonicalProjectDirectory(requestedRoot);
    if (canonical === null) {
      throw new UnusableProjectRootError();
    }
    const id = createProjectId();
    const parsedLabel = labelSchema.parse(label);
    const labelKey = canonicalLabelIdentity(parsedLabel, "PROJECT").key;
    const now = this.#now();
    const insert = this.#database.transaction(() => {
      if (makeDefault) this.#database.query("UPDATE projects SET is_default=0, updated_at=? WHERE is_default=1").run(now);
      this.#database.query("INSERT INTO projects(id,label,label_key,root_path,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, parsedLabel, labelKey, canonical, makeDefault ? 1 : 0, now, now);
    });
    insert.immediate();
    return this.requireProject(id);
  }

  listProjects(): readonly ProjectRecord[] {
    return this.#database.query("SELECT * FROM projects ORDER BY is_default DESC, label_key, id").all().map(mapProject);
  }

  requireProject(selector: string): ProjectRecord {
    const selected = selectByIdOrLabel(this.listProjects(), selector);
    if (selected.kind === "found") return selected.value;
    throw new SelectionError(selected.kind === "missing" ? "NOT_FOUND" : "AMBIGUOUS", selected.kind === "ambiguous" ? selected.values : []);
  }

  setDefaultProject(projectId: ProjectId): ProjectRecord {
    const now = this.#now();
    const transaction = this.#database.transaction(() => {
      this.#database.query("UPDATE projects SET is_default=0,updated_at=? WHERE is_default=1").run(now);
      const result = this.#database.query("UPDATE projects SET is_default=1,updated_at=? WHERE id=?").run(now, projectId);
      if (result.changes !== 1) throw new SelectionError("NOT_FOUND");
    });
    transaction.immediate();
    return this.requireProject(projectId);
  }

  removeProject(projectId: ProjectId): void {
    const result = this.#database.query("DELETE FROM projects WHERE id=? AND NOT EXISTS(SELECT 1 FROM sessions WHERE project_id=?)").run(projectId, projectId);
    if (result.changes !== 1) throw new Error("Project is missing or still used by a session.");
  }

  #insertSessionEventStream(sessionId: SessionId, now: number): void {
    this.#database.query(
      `INSERT OR IGNORE INTO session_event_streams(
         session_id,stream_epoch,next_sequence,floor_sequence,observed_through_sequence,
         retained_count,retained_bytes,retention_gap_reason,created_at,updated_at
       ) VALUES (?,?,1,1,0,0,0,NULL,?,?)`,
    ).run(sessionId, randomUUID(), now, now);
  }

  #ensureSessionEventStream(sessionId: SessionId): void {
    if (this.#database.query("SELECT 1 FROM session_event_streams WHERE session_id=?").get(sessionId) !== null) return;
    if (this.#readonly) throw new Error("SESSION_EVENT_STREAM_MISSING");
    const now = this.#now();
    this.#insertSessionEventStream(sessionId, now);
  }

  createSession(input: { profileId: ProfileId; projectId?: ProjectId; title?: string; preset: Preset; fastEnabled: boolean }): SessionRecord {
    const id = createSessionId();
    const now = this.#now();
    const title = input.title === undefined ? "Untitled session" : titleSchema.parse(input.title);
    const create = this.#database.transaction(() => {
      this.#database.query("INSERT INTO sessions(id,profile_id,project_id,title,preset,fast_enabled,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, input.profileId, input.projectId ?? null, title, presetSchema.parse(input.preset), input.fastEnabled ? 1 : 0, "starting", 1, now, now);
      this.#insertSessionEventStream(id, now);
    });
    create.immediate();
    return this.requireSession(id);
  }

  listSessions(limit = 50, profileId?: ProfileId): readonly SessionRecord[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = profileId === undefined
      ? this.#database.query("SELECT * FROM sessions ORDER BY updated_at DESC,id LIMIT ?").all(bounded)
      : this.#database.query("SELECT * FROM sessions WHERE profile_id=? ORDER BY updated_at DESC,id LIMIT ?").all(profileId, bounded);
    return rows.map(mapSession);
  }

  listLocalSessionPage(input: Readonly<{
    profileId: ProfileId;
    after: Readonly<{ createdAt: number; sessionId: SessionId }> | null;
    limit: number;
  }>): Readonly<{
    sessions: readonly SessionRecord[];
    nextPosition: Readonly<{ createdAt: number; sessionId: SessionId }> | null;
  }> {
    const profileId = profileIdSchema.parse(input.profileId);
    const limit = z.number().int().min(1).max(100).parse(input.limit);
    const after = input.after === null
      ? null
      : {
          createdAt: unixMillisecondsSchema.max(Number.MAX_SAFE_INTEGER).parse(input.after.createdAt),
          sessionId: sessionIdSchema.parse(input.after.sessionId),
        };
    const rows = (after === null
      ? this.#database.query(
        `SELECT * FROM sessions
         WHERE profile_id=?
         ORDER BY created_at DESC,id ASC
         LIMIT ?`,
      ).all(profileId, limit + 1)
      : this.#database.query(
        `SELECT * FROM sessions
         WHERE profile_id=?
           AND (created_at < ? OR (created_at = ? AND id > ?))
         ORDER BY created_at DESC,id ASC
         LIMIT ?`,
      ).all(profileId, after.createdAt, after.createdAt, after.sessionId, limit + 1))
      .map(mapSession);
    const sessions = rows.slice(0, limit);
    const last = sessions.at(-1);
    return {
      sessions,
      nextPosition: rows.length > limit && last !== undefined
        ? { createdAt: last.createdAt, sessionId: last.id }
        : null,
    };
  }

  /*
   * True while any non-terminal session is mid-turn. This is a cadence hint
   * for the cloud sync loop, so it reads one indexless existence row and
   * never projects session content.
   */
  hasSessionWithActiveTurn(): boolean {
    return this.#database.query(
      "SELECT 1 AS present FROM sessions WHERE active_turn_id IS NOT NULL AND state='active' LIMIT 1",
    ).get() !== null;
  }

  listCloudSessionPage(input: Readonly<{
    afterId: string | null;
    limit: number;
  }>): Readonly<{
    continueAfterId: string | null;
    isDone: boolean;
    sessions: readonly SessionRecord[];
  }> {
    const limit = z.number().int().min(1).max(100).parse(input.limit);
    const afterId = input.afterId === null ? null : sessionIdSchema.parse(input.afterId);
    const rows = (afterId === null
      ? this.#database.query(
        "SELECT * FROM sessions ORDER BY id ASC LIMIT ?",
      ).all(limit + 1)
      : this.#database.query(
        "SELECT * FROM sessions WHERE id > ? ORDER BY id ASC LIMIT ?",
      ).all(afterId, limit + 1)).map(mapSession);
    const isDone = rows.length <= limit;
    const sessions = rows.slice(0, limit);
    const last = sessions.at(-1);
    return {
      continueAfterId: isDone ? null : last?.id ?? null,
      isDone,
      sessions,
    };
  }

  requireSession(selector: string): SessionRecord {
    if (sessionIdSchema.safeParse(selector).success) {
      const exact = this.#database.query("SELECT * FROM sessions WHERE id=?").get(selector);
      if (exact !== null) return mapSession(exact);
    }
    const rows = this.#database.query("SELECT * FROM sessions WHERE title = ? COLLATE NOCASE ORDER BY updated_at DESC,id LIMIT 101").all(selector).map(mapSession);
    if (rows.length === 1) {
      const only = rows[0];
      if (only === undefined) throw new Error("Session selection cardinality changed unexpectedly.");
      return only;
    }
    if (rows.length === 0) throw new SelectionError("NOT_FOUND");
    throw new SelectionError("AMBIGUOUS", rows.map((session) => ({ id: session.id, label: session.title })));
  }

  findSessionByProviderThread(profileId: ProfileId, providerThreadId: string): SessionRecord | null {
    const row = this.#database.query("SELECT * FROM sessions WHERE profile_id=? AND provider_thread_id=?").get(profileId, providerThreadId);
    return row === null ? null : mapSession(row);
  }

  recordSessionRuntimeProfile(input: {
    sessionId: SessionId;
    sourceKind: z.infer<typeof runtimeProfileSourceKindSchema>;
    sourceId: string;
    profile: EffectiveRuntimeProfile;
  }): SessionRuntimeProfileRecord {
    let record: SessionRuntimeProfileRecord | undefined;
    const transaction = this.#database.transaction(() => {
      record = this.#insertSessionRuntimeProfile(input, this.#now());
    });
    transaction.immediate();
    if (record === undefined) throw new Error("Effective runtime profile was not recorded.");
    return record;
  }

  #insertSessionRuntimeProfile(input: {
    sessionId: SessionId;
    sourceKind: z.infer<typeof runtimeProfileSourceKindSchema>;
    sourceId: string;
    profile: EffectiveRuntimeProfile;
  }, now: number): SessionRuntimeProfileRecord {
    const sourceKind = runtimeProfileSourceKindSchema.parse(input.sourceKind);
    const sourceId = z.string().min(1).max(200).parse(input.sourceId);
    const profile = effectiveRuntimeProfileSchema.parse(input.profile);
    const profileJson = JSON.stringify(profile);
    const existing = this.#database.query(
      "SELECT * FROM session_runtime_profiles WHERE source_kind=? AND source_id=?",
    ).get(sourceKind, sourceId);
    if (existing !== null) {
      const record = mapSessionRuntimeProfile(existing);
      if (record.sessionId !== input.sessionId || JSON.stringify(record.profile) !== profileJson) {
        throw new Error("Effective runtime profile source authority changed.");
      }
      return record;
    }
    const nextRow = z.object({ revision: z.number().int().nonnegative() }).strict().parse(
      this.#database.query(
        "SELECT COALESCE(MAX(revision),0) AS revision FROM session_runtime_profiles WHERE session_id=?",
      ).get(input.sessionId),
    );
    this.#database.query(
      `INSERT INTO session_runtime_profiles(
         session_id,revision,source_kind,source_id,profile_id,process_generation,
         observed_at,profile_json,recorded_at
       ) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.sessionId,
      nextRow.revision + 1,
      sourceKind,
      sourceId,
      profile.profileId,
      profile.processGeneration,
      profile.observedAt,
      profileJson,
      now,
    );
    const inserted = this.#database.query(
      "SELECT * FROM session_runtime_profiles WHERE source_kind=? AND source_id=?",
    ).get(sourceKind, sourceId);
    if (inserted === null) throw new Error("Effective runtime profile was not recorded.");
    return mapSessionRuntimeProfile(inserted);
  }

  #bindSessionTurnRuntimeProfile(input: {
    sessionId: SessionId;
    sourceKind: "turn_start" | "queue_start";
    sourceId: string;
    turnId: string;
    profile: EffectiveRuntimeProfile;
  }, now: number): EffectiveRuntimeProfile {
    const turnId = z.string().min(1).max(200).parse(input.turnId);
    const profileRecord = this.#insertSessionRuntimeProfile(input, now);
    const profileJson = JSON.stringify(profileRecord.profile);
    const profileDigest = digestJson(profileRecord.profile);
    const existing = this.#database.query(
      "SELECT * FROM session_turn_runtime_profiles WHERE session_id=? AND turn_id=?",
    ).get(input.sessionId, turnId);
    if (existing !== null) {
      const bound = mapSessionTurnRuntimeProfile(existing);
      if (
        bound.sourceKind !== input.sourceKind
        || bound.sourceId !== input.sourceId
        || JSON.stringify(bound.profile) !== profileJson
      ) throw new Error("Completed turn runtime profile authority changed.");
      return bound.profile;
    }
    this.#database.query(
      `INSERT INTO session_turn_runtime_profiles(
         session_id,turn_id,source_kind,source_id,profile_id,process_generation,
         observed_at,profile_json,profile_digest,recorded_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.sessionId,
      turnId,
      input.sourceKind,
      input.sourceId,
      profileRecord.profile.profileId,
      profileRecord.profile.processGeneration,
      profileRecord.profile.observedAt,
      profileJson,
      profileDigest,
      now,
    );
    const inserted = this.#database.query(
      "SELECT * FROM session_turn_runtime_profiles WHERE session_id=? AND turn_id=?",
    ).get(input.sessionId, turnId);
    if (inserted === null) throw new Error("Completed turn runtime profile was not bound.");
    return mapSessionTurnRuntimeProfile(inserted).profile;
  }

  runtimeProfileForTurn(sessionId: SessionId, turnId: string): EffectiveRuntimeProfile | null {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedTurnId = z.string().min(1).max(200).parse(turnId);
    const row = this.#database.query(
      "SELECT * FROM session_turn_runtime_profiles WHERE session_id=? AND turn_id=?",
    ).get(parsedSessionId, parsedTurnId);
    return row === null ? null : mapSessionTurnRuntimeProfile(row).profile;
  }

  runtimeProfileSourceRequiresSettlement(sessionId: SessionId, sourceId: string): boolean {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedSourceId = z.string().min(1).max(200).parse(sourceId);
    const mutation = this.#database.query(`SELECT 1 FROM mutation_attempts m
      JOIN mutation_effect_evidence e ON e.attempt_id=m.id
      LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
      WHERE m.id=? AND m.authority_id=? AND m.kind='session.send'
        AND m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL
      LIMIT 1`).get(parsedSourceId, parsedSessionId);
    if (mutation !== null) return true;
    return this.#database.query(`SELECT 1 FROM queue_entries q
      JOIN queue_effect_evidence e ON e.queue_id=q.id
      LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
      WHERE q.id=? AND q.session_id=? AND q.state IN ('dispatching','ambiguous')
        AND r.queue_id IS NULL
      LIMIT 1`).get(parsedSourceId, parsedSessionId) !== null;
  }

  completeSessionStartEffect(input: {
    attemptId: AttemptId;
    sessionId: SessionId;
    expectedSessionRevision: number;
    providerThreadId: string;
    state: "active" | "idle" | "terminal";
    activeTurnId?: string;
    providerUpdatedAt?: number;
    runtimeProfile: EffectiveRuntimeProfile;
    receipt: unknown;
  }): void {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const profile = effectiveRuntimeProfileSchema.parse(input.runtimeProfile);
    const receiptJson = JSON.stringify(input.receipt);
    const now = this.#now();
    const transaction = this.#database.transaction(() => {
      const row = z.object({
        state: z.literal("effect_started"),
        session_id: sessionIdSchema,
        evidence_json: z.string(),
      }).strict().parse(this.#database.query(`SELECT m.state,s.session_id,e.evidence_json
                                              FROM mutation_attempts m
                                              JOIN session_start_attempts s ON s.attempt_id=m.id
                                              JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                                              WHERE m.id=? AND m.kind='session.start'`).get(attemptId));
      const evidence = mutationEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
      if (
        row.session_id !== sessionId
        || evidence.kind !== "session.start"
        || evidence.runtimeProfile === undefined
        || JSON.stringify(evidence.runtimeProfile) !== JSON.stringify(profile)
      ) throw new Error("SESSION_START_EFFECT_EVIDENCE_MISMATCH");
      const bound = this.#database.query(`UPDATE sessions SET provider_thread_id=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=?
                                          WHERE id=? AND revision=? AND state='starting' AND provider_thread_id IS NULL`).run(
        providerThreadIdSchema.parse(input.providerThreadId),
        input.state,
        input.activeTurnId ?? null,
        input.providerUpdatedAt ?? null,
        now,
        sessionId,
        z.number().int().positive().parse(input.expectedSessionRevision),
      );
      if (bound.changes !== 1) throw new Error("SESSION_START_BINDING_CAS_CONFLICT");
      if (
        evidence.conversationAutomationCapability
        === SESSION_CONVERSATION_AUTOMATION_CAPABILITY
      ) {
        this.#database.query(
          `INSERT INTO session_conversation_automation(
             session_id,provider_thread_id,enabled_at
           ) VALUES (?,?,?)`,
        ).run(sessionId, providerThreadIdSchema.parse(input.providerThreadId), now);
      }
      this.#insertSessionRuntimeProfile({ sessionId, sourceKind: "session_start", sourceId: attemptId, profile }, now);
      const applied = this.#database.query("UPDATE mutation_attempts SET state='applied',result_json=?,updated_at=? WHERE id=? AND state='effect_started'").run(receiptJson, now, attemptId);
      if (applied.changes !== 1) throw new Error("SESSION_START_RECEIPT_CAS_CONFLICT");
    });
    transaction.immediate();
  }

  completeSessionTurnEffect(input: {
    attemptId: AttemptId;
    sessionId: SessionId;
    expectedSessionRevision: number;
    applyResponseState: boolean;
    turnId: string;
    turnStatus: "completed" | "interrupted" | "failed" | "inProgress";
    runtimeProfile: EffectiveRuntimeProfile;
    receipt: unknown;
  }): void {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const profile = effectiveRuntimeProfileSchema.parse(input.runtimeProfile);
    const now = this.#now();
    const transaction = this.#database.transaction(() => {
      const row = z.object({ authority_id: sessionIdSchema, evidence_json: z.string() }).strict().parse(
        this.#database.query(`SELECT m.authority_id,e.evidence_json FROM mutation_attempts m
                              JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                              WHERE m.id=? AND m.kind='session.send' AND m.state='effect_started'`).get(attemptId),
      );
      const evidence = mutationEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
      if (
        row.authority_id !== sessionId
        || evidence.kind !== "session.send"
        || evidence.runtimeProfile === undefined
        || JSON.stringify(evidence.runtimeProfile) !== JSON.stringify(profile)
      ) throw new Error("SESSION_TURN_EFFECT_EVIDENCE_MISMATCH");
      this.#bindSessionTurnRuntimeProfile({
        sessionId,
        sourceKind: "turn_start",
        sourceId: attemptId,
        turnId: input.turnId,
        profile,
      }, now);
      const nextState = input.turnStatus === "inProgress" ? "active" : "idle";
      if (input.applyResponseState) {
        const sessionChanged = this.#database.query(`UPDATE sessions SET state=?,active_turn_id=?,revision=revision+1,updated_at=?
                                                     WHERE id=? AND revision=? AND state NOT IN ('recovery_required','terminal')`).run(
          nextState,
          nextState === "active" ? z.string().min(1).max(200).parse(input.turnId) : null,
          now,
          sessionId,
          z.number().int().positive().parse(input.expectedSessionRevision),
        );
        if (sessionChanged.changes !== 1) throw new Error("SESSION_TURN_STATE_CAS_CONFLICT");
      }
      const applied = this.#database.query("UPDATE mutation_attempts SET state='applied',result_json=?,updated_at=? WHERE id=? AND state='effect_started'").run(JSON.stringify(input.receipt), now, attemptId);
      if (applied.changes !== 1) throw new Error("SESSION_TURN_RECEIPT_CAS_CONFLICT");
    });
    transaction.immediate();
  }

  latestSessionRuntimeProfile(sessionId: SessionId): SessionRuntimeProfileRecord | null {
    const row = this.#database.query(
      "SELECT * FROM session_runtime_profiles WHERE session_id=? ORDER BY revision DESC LIMIT 1",
    ).get(sessionId);
    return row === null ? null : mapSessionRuntimeProfile(row);
  }

  upsertProviderSession(input: { profileId: ProfileId; providerThreadId: string; projectId?: ProjectId; title: string; state: "active" | "idle" | "terminal"; activeTurnId?: string; providerUpdatedAt?: number }): SessionRecord {
    const current = this.findSessionByProviderThread(input.profileId, input.providerThreadId);
    const now = this.#now();
    if (current === null) {
      const id = createSessionId();
      const create = this.#database.transaction(() => {
        this.#database.query("INSERT INTO sessions(id,profile_id,project_id,provider_thread_id,title,preset,fast_enabled,state,active_turn_id,provider_updated_at,revision,created_at,updated_at) VALUES (?,?,?,?,?,'high',0,?,?,?,1,?,?)").run(id, input.profileId, input.projectId ?? null, input.providerThreadId, titleSchema.parse(input.title), input.state, input.activeTurnId ?? null, input.providerUpdatedAt ?? null, now, now);
        this.#insertSessionEventStream(id, now);
      });
      create.immediate();
      return this.requireSession(id);
    }
    if (current.state === "recovery_required") return current;
    if (input.providerUpdatedAt === undefined || input.providerUpdatedAt <= (current.providerUpdatedAt ?? -1)) return current;
    const result = this.#database.query("UPDATE sessions SET project_id=COALESCE(project_id,?),title=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND (provider_updated_at IS NULL OR provider_updated_at < ?)").run(input.projectId ?? null, titleSchema.parse(input.title), input.state, input.activeTurnId ?? null, input.providerUpdatedAt, now, current.id, current.revision, input.providerUpdatedAt);
    if (result.changes !== 1) throw new Error("Session changed while importing the provider projection.");
    return this.requireSession(current.id);
  }

  upsertSessionState(input: {
    sessionId: SessionId;
    state: SessionStateRow["state"];
    attention: boolean;
    reason: string;
    verbatimRequired: boolean;
    verbatimLiteral: string | undefined;
    lastActivityAt: number;
    revision: number;
  }): SessionStateRow {
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const parsed = sessionStateRowSchema.parse({
      sessionId,
      state: input.state,
      attention: input.attention,
      reason: input.reason,
      verbatimRequired: input.verbatimRequired,
      verbatimLiteral: input.verbatimLiteral ?? null,
      lastActivityAt: input.lastActivityAt,
      revision: input.revision,
      updatedAt: this.#now(),
    });
    const write = this.#database.transaction(() => {
      if (this.#database.query("SELECT 1 FROM sessions WHERE id=?").get(sessionId) === null) {
        throw new SelectionError("NOT_FOUND");
      }
      const result = this.#database.query(
        `INSERT INTO session_states(session_id,state,attention,reason,verbatim_required,verbatim_literal,last_activity_at,revision,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           state=excluded.state,attention=excluded.attention,reason=excluded.reason,
           verbatim_required=excluded.verbatim_required,verbatim_literal=excluded.verbatim_literal,
           last_activity_at=excluded.last_activity_at,revision=excluded.revision,updated_at=excluded.updated_at
         WHERE excluded.revision > session_states.revision`,
      ).run(
        parsed.sessionId,
        parsed.state,
        parsed.attention ? 1 : 0,
        parsed.reason,
        parsed.verbatimRequired ? 1 : 0,
        parsed.verbatimLiteral,
        parsed.lastActivityAt,
        parsed.revision,
        parsed.updatedAt,
      );
      if (result.changes !== 1) throw new Error("SESSION_STATE_REVISION_STALE");
      return parsed;
    });
    return write.immediate();
  }

  // --- Autorespond: approval modes, counters, evidence ----------------------

  readDefaultApprovalMode(): ApprovalMode {
    const row = this.#database.query("SELECT default_approval_mode FROM daemon_state WHERE singleton=1").get();
    const parsed = z.object({ default_approval_mode: approvalModeSchema }).strict().parse(row);
    return parsed.default_approval_mode;
  }

  setDefaultApprovalMode(mode: ApprovalMode): void {
    const parsed = approvalModeSchema.parse(mode);
    const result = this.#database.query("UPDATE daemon_state SET default_approval_mode=? WHERE singleton=1").run(parsed);
    if (result.changes !== 1) throw new Error("DAEMON_STATE_MISSING");
  }

  readSessionApprovalMode(sessionId: SessionId): Readonly<{ mode: ApprovalMode; source: "session" | "default" }> {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const row = this.#database.query("SELECT mode FROM session_approval_modes WHERE session_id=?").get(parsedSessionId);
    if (row !== null) {
      return { mode: z.object({ mode: approvalModeSchema }).strict().parse(row).mode, source: "session" };
    }
    return { mode: this.readDefaultApprovalMode(), source: "default" };
  }

  setSessionApprovalMode(sessionId: SessionId, mode: ApprovalMode | null): void {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    if (mode === null) {
      this.#database.query("DELETE FROM session_approval_modes WHERE session_id=?").run(parsedSessionId);
      return;
    }
    const parsed = approvalModeSchema.parse(mode);
    const write = this.#database.transaction(() => {
      if (this.#database.query("SELECT 1 FROM sessions WHERE id=?").get(parsedSessionId) === null) {
        throw new SelectionError("NOT_FOUND");
      }
      this.#database.query(
        `INSERT INTO session_approval_modes(session_id,mode,updated_at) VALUES (?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at`,
      ).run(parsedSessionId, parsed, this.#now());
    });
    write.immediate();
  }

  readAutorespondBudgets(sessionId: SessionId, now: number = this.#now()): Readonly<{
    consecutive: number;
    lastDay: number;
    lastHour: number;
  }> {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const counter = this.#database.query(
      "SELECT consecutive_count FROM session_autorespond_counters WHERE session_id=?",
    ).get(parsedSessionId);
    const consecutive = counter === null
      ? 0
      : z.object({ consecutive_count: z.number().int().nonnegative() }).strict().parse(counter).consecutive_count;
    const count = (since: number): number => {
      const row = this.#database.query(
        "SELECT COUNT(*) AS total FROM autorespond_evidence WHERE session_id=? AND outcome='accepted' AND occurred_at>=?",
      ).get(parsedSessionId, since);
      return z.object({ total: z.number().int().nonnegative() }).strict().parse(row).total;
    };
    return {
      consecutive,
      lastDay: count(now - 24 * 60 * 60 * 1_000),
      lastHour: count(now - 60 * 60 * 1_000),
    };
  }

  bumpAutorespondCounter(sessionId: SessionId): number {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const now = this.#now();
    const write = this.#database.transaction(() => {
      this.#database.query(
        `INSERT INTO session_autorespond_counters(session_id,consecutive_count,updated_at) VALUES (?,1,?)
         ON CONFLICT(session_id) DO UPDATE SET consecutive_count=consecutive_count+1,updated_at=excluded.updated_at`,
      ).run(parsedSessionId, now);
      const row = this.#database.query(
        "SELECT consecutive_count FROM session_autorespond_counters WHERE session_id=?",
      ).get(parsedSessionId);
      return z.object({ consecutive_count: z.number().int().nonnegative() }).strict().parse(row).consecutive_count;
    });
    return write.immediate();
  }

  readSessionState(sessionId: SessionId): SessionStateRow | null {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const row = this.#database.query("SELECT * FROM session_states WHERE session_id=?").get(parsedSessionId);
    if (row === null) return null;
    const record = z.object({
      session_id: z.string(),
      state: z.string(),
      attention: z.number().int(),
      reason: z.string(),
      verbatim_required: z.number().int(),
      verbatim_literal: z.string().nullable(),
      last_activity_at: z.number().int(),
      revision: z.number().int(),
      updated_at: z.number().int(),
    }).strict().parse(row);
    return sessionStateRowSchema.parse({
      sessionId: record.session_id,
      state: record.state,
      attention: record.attention === 1,
      reason: record.reason,
      verbatimRequired: record.verbatim_required === 1,
      verbatimLiteral: record.verbatim_literal,
      lastActivityAt: record.last_activity_at,
      revision: record.revision,
      updatedAt: record.updated_at,
    });
  }

  resetAutorespondCounter(sessionId: SessionId): void {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    this.#database.query(
      "UPDATE session_autorespond_counters SET consecutive_count=0,updated_at=? WHERE session_id=?",
    ).run(this.#now(), parsedSessionId);
  }

  recordAutorespondEvidence(input: {
    approvalClass: string;
    decision: string;
    interactionId: string;
    kind: "command_approval" | "file_change_approval" | "permission_approval";
    latencyMs: number;
    mode: ApprovalMode;
    outcome: "accepted" | "refused";
    sessionId: SessionId;
    subagent: boolean;
  }): void {
    const parsedSessionId = sessionIdSchema.parse(input.sessionId);
    const now = this.#now();
    const write = this.#database.transaction(() => {
      this.#database.query(
        `INSERT INTO autorespond_evidence(session_id,interaction_id,kind,class,decision,mode,outcome,latency_ms,subagent,occurred_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        parsedSessionId,
        z.string().uuid().parse(input.interactionId),
        input.kind,
        input.approvalClass.slice(0, 256),
        input.decision.slice(0, 64),
        approvalModeSchema.parse(input.mode),
        input.outcome,
        Math.max(0, Math.floor(input.latencyMs)),
        input.subagent ? 1 : 0,
        now,
      );
      this.#database.query(
        `DELETE FROM autorespond_evidence WHERE session_id=? AND id NOT IN (
           SELECT id FROM autorespond_evidence WHERE session_id=? ORDER BY occurred_at DESC, id DESC LIMIT ?)`,
      ).run(parsedSessionId, parsedSessionId, AUTORESPOND_EVIDENCE_PER_SESSION_CAP);
    });
    write.immediate();
  }

  listAutorespondEvidence(input: { sessionId?: SessionId; limit?: number } = {}): readonly AutorespondEvidenceRow[] {
    const limit = z.number().int().min(1).max(200).parse(input.limit ?? 20);
    const rows = input.sessionId === undefined
      ? this.#database.query(
          "SELECT * FROM autorespond_evidence ORDER BY occurred_at DESC, id DESC LIMIT ?",
        ).all(limit)
      : this.#database.query(
          "SELECT * FROM autorespond_evidence WHERE session_id=? ORDER BY occurred_at DESC, id DESC LIMIT ?",
        ).all(sessionIdSchema.parse(input.sessionId), limit);
    return rows.map((row) => {
      const parsed = autorespondEvidenceRowSchema.parse(row);
      return {
        approvalClass: parsed.class,
        decision: parsed.decision,
        interactionId: parsed.interaction_id,
        kind: parsed.kind,
        latencyMs: parsed.latency_ms,
        mode: parsed.mode,
        occurredAt: parsed.occurred_at,
        outcome: parsed.outcome,
        sessionId: parsed.session_id,
        subagent: parsed.subagent === 1,
      };
    });
  }

  countAutorespondEvidence(input: { sessionId?: SessionId } = {}): Readonly<{ accepted: number; refused: number }> {
    const rows = input.sessionId === undefined
      ? this.#database.query("SELECT outcome, COUNT(*) AS total FROM autorespond_evidence GROUP BY outcome").all()
      : this.#database.query(
          "SELECT outcome, COUNT(*) AS total FROM autorespond_evidence WHERE session_id=? GROUP BY outcome",
        ).all(sessionIdSchema.parse(input.sessionId));
    const counts = { accepted: 0, refused: 0 };
    for (const row of rows) {
      const parsed = z.object({ outcome: z.enum(["accepted", "refused"]), total: z.number().int().nonnegative() }).strict().parse(row);
      counts[parsed.outcome] = parsed.total;
    }
    return counts;
  }

  markInteractionResolvedBy(publicId: string, resolvedBy: "autorespond"): void {
    this.#database.query("UPDATE provider_interactions SET resolved_by=? WHERE public_id=?").run(resolvedBy, z.string().uuid().parse(publicId));
  }

  bindSession(input: { sessionId: SessionId; expectedRevision: number; providerThreadId: string; state: "active" | "idle"; activeTurnId?: string; providerUpdatedAt?: number }): SessionRecord {
    const now = this.#now();
    const result = this.#database.query("UPDATE sessions SET provider_thread_id=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state='starting'").run(input.providerThreadId, input.state, input.activeTurnId ?? null, input.providerUpdatedAt ?? null, now, input.sessionId, input.expectedRevision);
    if (result.changes !== 1) throw new Error("Session authority changed before the provider binding committed.");
    return this.requireSession(input.sessionId);
  }

  deleteUnboundStartingSession(sessionId: SessionId, expectedRevision: number): boolean {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedRevision = z.number().int().positive().parse(expectedRevision);
    const remove = this.#database.transaction(() => {
      const deleted = this.#database
        .query(
          `DELETE FROM sessions
           WHERE id=?
             AND revision=?
             AND state='starting'
             AND provider_thread_id IS NULL
             AND active_turn_id IS NULL
             AND provider_updated_at IS NULL
             AND NOT EXISTS(SELECT 1 FROM queue_entries WHERE session_id=sessions.id)
             AND NOT EXISTS(SELECT 1 FROM turn_summaries WHERE session_id=sessions.id)
           RETURNING id`,
        )
        .get(parsedSessionId, parsedRevision);
      return deleted !== null;
    });
    return remove.immediate();
  }

  updateSessionMetadata(input: { sessionId: SessionId; expectedRevision: number; title?: string; note?: string; preset?: Preset; fastEnabled?: boolean; projectId?: ProjectId | null }): SessionRecord {
    const current = this.requireSession(input.sessionId);
    if (current.revision !== input.expectedRevision) throw new Error("Session metadata revision conflict.");
    const title = input.title === undefined ? current.title : titleSchema.parse(input.title);
    const note = input.note === undefined ? current.note : noteSchema.parse(input.note);
    const preset = input.preset === undefined ? current.preset : presetSchema.parse(input.preset);
    const fast = input.fastEnabled === undefined ? current.fastEnabled : input.fastEnabled;
    const project = input.projectId === undefined ? current.projectId ?? null : input.projectId;
    const now = this.#now();
    const result = this.#database.query("UPDATE sessions SET title=?,note=?,preset=?,fast_enabled=?,project_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(title, note, preset, fast ? 1 : 0, project, now, current.id, current.revision);
    if (result.changes !== 1) throw new Error("Session metadata revision conflict.");
    return this.requireSession(current.id);
  }

  setSessionTurnState(input: { sessionId: SessionId; expectedRevision: number; state: "active" | "idle" | "terminal" | "recovery_required"; activeTurnId?: string }): SessionRecord {
    const now = this.#now();
    const result = this.#database.query("UPDATE sessions SET state=?,active_turn_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(input.state, input.activeTurnId ?? null, now, input.sessionId, input.expectedRevision);
    if (result.changes !== 1) throw new Error("Session state revision conflict.");
    return this.requireSession(input.sessionId);
  }

  reconcileSessionFromProvider(input: { sessionId: SessionId; state?: "active" | "idle" | "terminal" | "recovery_required"; activeTurnId?: string | null; title?: string }): SessionRecord {
    const current = this.requireSession(input.sessionId);
    if (current.state === "recovery_required" || current.state === "terminal") return current;
    const state = input.state ?? current.state;
    const activeTurnId = input.activeTurnId === undefined ? current.activeTurnId ?? null : input.activeTurnId;
    const title = input.title === undefined ? current.title : titleSchema.parse(input.title);
    if (state === current.state && activeTurnId === (current.activeTurnId ?? null) && title === current.title) return current;
    const result = this.#database.query("UPDATE sessions SET state=?,active_turn_id=?,title=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(state, activeTurnId, title, this.#now(), current.id, current.revision);
    if (result.changes !== 1) return this.requireSession(current.id);
    return this.requireSession(current.id);
  }

  terminalizeSessionFromProviderDeletion(input: Readonly<{
    accountId: ProfileId;
    providerConnectionId: string | null;
    providerGeneration: number;
    sessionId: SessionId;
  }>): Readonly<{
    changed: boolean;
    event?: SessionEvent;
    interactions: readonly InteractionRecord[];
    session: SessionRecord;
  }> {
    completePendingSecurityScrub(this.#database, false, this.#securityScrubCheckpoint);
    const parsedSessionId = sessionIdSchema.parse(input.sessionId);
    const accountId = profileIdSchema.parse(input.accountId);
    const providerGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      .parse(input.providerGeneration);
    const providerConnectionId = z.string().uuid().nullable().parse(input.providerConnectionId);
    const now = unixMillisecondsSchema.parse(this.#now());
    const terminalize = this.#database.transaction(() => {
      const current = this.requireSession(parsedSessionId);
      let sessionChanged = false;
      let event: SessionEvent | undefined;
      if (current.state !== "terminal") {
        const changed = this.#database.query(
          `UPDATE sessions
           SET state='terminal',active_turn_id=NULL,revision=revision+1,updated_at=?
           WHERE id=? AND revision=? AND state!='terminal'`,
        ).run(now, current.id, current.revision);
        if (changed.changes !== 1) throw new Error("SESSION_PROVIDER_DELETION_CONFLICT");
        sessionChanged = true;
        event = this.appendSessionEvent({
          accountId,
          body: {
            activeTurnId: null,
            status: "terminal",
            type: "session_status",
          },
          providerConnectionId,
          providerGeneration,
          sessionId: current.id,
        });
      }
      this.#database.query(
        "UPDATE queue_entries SET state='cancelled',updated_at=? WHERE session_id=? AND state='pending'",
      ).run(now, current.id);
      this.#database.query(
        "UPDATE queue_entries SET state='ambiguous',updated_at=? WHERE session_id=? AND state='dispatching'",
      ).run(now, current.id);
      const providerDeletionEvidence = JSON.stringify({ source: "provider_thread_deleted" });
      this.#database.query(
        `INSERT OR IGNORE INTO queue_effect_resolutions(
           queue_id,resolution_kind,evidence_json,receipt_json,created_at
         )
         SELECT q.id,'abandoned',?,NULL,?
         FROM queue_entries q
         JOIN queue_effect_evidence e ON e.queue_id=q.id
         LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
         WHERE q.session_id=? AND q.state='ambiguous' AND r.queue_id IS NULL`,
      ).run(providerDeletionEvidence, now, current.id);
      this.#database.query(
        `UPDATE mutation_attempts
         SET state='cancelled',updated_at=?
         WHERE state='prepared'
           AND (
             authority_id=? OR id IN (
               SELECT attempt_id FROM session_start_attempts WHERE session_id=?
             )
           )`,
      ).run(now, current.id, current.id);
      this.#database.query(
        `INSERT OR IGNORE INTO mutation_resolutions(
           attempt_id,resolution_kind,evidence_json,receipt_json,created_at
         )
         SELECT m.id,'abandoned',?,NULL,?
         FROM mutation_attempts m
         LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
         LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
         WHERE (m.authority_id=? OR s.session_id=?)
           AND m.state IN ('effect_started','ambiguous')
           AND r.attempt_id IS NULL`,
      ).run(providerDeletionEvidence, now, current.id, current.id);
      const rows = this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE session_id=? AND state IN ('pending','response_prepared','response_written')
         ORDER BY requested_at,public_id`,
      ).all(current.id);
      const interactions: InteractionRecord[] = [];
      for (const value of rows) {
        const interaction = interactionRowSchema.parse(value);
        const state = interaction.state === "pending" ? "expired" : "resolution_unknown";
        const settled = this.#database.query(
          `UPDATE provider_interactions
           SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
           WHERE public_id=? AND revision=? AND state=?`,
        ).run(state, now, now, interaction.public_id, interaction.revision, interaction.state);
        if (settled.changes !== 1) throw new Error("INTERACTION_PROVIDER_DELETION_CONFLICT");
        const terminal = this.#requireInteractionRow(interaction.public_id);
        this.#recordInteractionTransition(terminal, now);
        interactions.push(mapInteraction(terminal));
      }
      return {
        changed: sessionChanged,
        ...(event === undefined ? {} : { event }),
        interactions,
        session: this.requireSession(current.id),
      };
    });
    const result = terminalize.immediate();
    completePendingSecurityScrub(this.#database, true, this.#securityScrubCheckpoint);
    return result;
  }

  quarantineSession(sessionId: SessionId): SessionRecord {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const now = this.#now();
    this.#database
      .query(
        `UPDATE sessions
         SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=?
         WHERE id=? AND state NOT IN ('recovery_required','terminal')`,
      )
      .run(now, parsedSessionId);
    return this.requireSession(parsedSessionId);
  }

  resolveSessionStatusRecovery(input:
    | {
      sessionId: SessionId;
      expectedRevision: number;
      resolution: "provider_state_reconciled";
      provider: {
        providerThreadId: string;
        title: string;
        status: "active" | "idle" | "terminal";
        activeTurnId?: string;
        providerUpdatedAt?: number;
      };
    }
    | {
      sessionId: SessionId;
      expectedRevision: number;
      resolution: "abandoned";
    }): SessionRecord {
    completePendingSecurityScrub(this.#database, false, this.#securityScrubCheckpoint);
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const now = this.#now();
    const resolveRecovery = this.#database.transaction(() => {
      const session = mapSession(this.#database.query("SELECT * FROM sessions WHERE id=?").get(sessionId));
      if (session.state !== "recovery_required" || session.revision !== expectedRevision) {
        throw new Error("SESSION_STATUS_RECOVERY_CAS_CONFLICT");
      }
      const unsettledMutationCount = z.object({ count: z.number().int().nonnegative() }).strict().parse(
        this.#database.query(`SELECT COUNT(*) AS count
                              FROM mutation_attempts m
                              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                              LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
                              WHERE (m.authority_id=? OR s.session_id=?)
                                AND m.state IN ('effect_started','ambiguous')
                                AND r.attempt_id IS NULL`).get(sessionId, sessionId),
      ).count;
      const unsettledQueueCount = z.object({ count: z.number().int().nonnegative() }).strict().parse(
        this.#database.query(`SELECT COUNT(*) AS count
                              FROM queue_entries q
                              LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
                              WHERE q.session_id=? AND q.state IN ('dispatching','ambiguous') AND r.queue_id IS NULL`).get(sessionId),
      ).count;
      if (unsettledMutationCount !== 0 || unsettledQueueCount !== 0) {
        throw new Error("SESSION_STATUS_RECOVERY_HAS_UNSETTLED_EFFECT");
      }
      if (input.resolution === "abandoned") {
        const changed = this.#database.query(`UPDATE sessions
                                              SET state='terminal',active_turn_id=NULL,revision=revision+1,updated_at=?
                                              WHERE id=? AND revision=? AND state='recovery_required'`).run(
          now,
          sessionId,
          expectedRevision,
        );
        if (changed.changes !== 1) throw new Error("SESSION_STATUS_RECOVERY_CAS_CONFLICT");
        this.#database.query("UPDATE queue_entries SET state='cancelled',updated_at=? WHERE session_id=? AND state='pending'").run(now, sessionId);
        return;
      }
      const providerThreadId = providerThreadIdSchema.parse(input.provider.providerThreadId);
      if (session.providerThreadId !== providerThreadId) throw new Error("SESSION_STATUS_RECOVERY_THREAD_MISMATCH");
      const status = sessionStateSchema.exclude(["starting", "recovery_required"]).parse(input.provider.status);
      if (status === "active" && input.provider.activeTurnId === undefined) {
        throw new Error("SESSION_STATUS_RECOVERY_ACTIVE_TURN_MISSING");
      }
      const activeTurnId = status === "active" && input.provider.activeTurnId !== undefined
        ? z.string().min(1).max(200).parse(input.provider.activeTurnId)
        : null;
      const observedProviderUpdatedAt = input.provider.providerUpdatedAt === undefined
        ? session.providerUpdatedAt ?? null
        : unixMillisecondsSchema.parse(input.provider.providerUpdatedAt);
      const providerUpdatedAt = session.providerUpdatedAt === undefined || observedProviderUpdatedAt === null
        ? observedProviderUpdatedAt
        : Math.max(session.providerUpdatedAt, observedProviderUpdatedAt);
      const changed = this.#database.query(`UPDATE sessions
                                            SET title=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=?
                                            WHERE id=? AND revision=? AND state='recovery_required' AND provider_thread_id=?`).run(
        titleSchema.parse(input.provider.title),
        status,
        activeTurnId,
        providerUpdatedAt,
        now,
        sessionId,
        expectedRevision,
        providerThreadId,
      );
      if (changed.changes !== 1) throw new Error("SESSION_STATUS_RECOVERY_CAS_CONFLICT");
    });
    resolveRecovery.immediate();
    completePendingSecurityScrub(this.#database, true, this.#securityScrubCheckpoint);
    return this.requireSession(sessionId);
  }

  #enqueuePrepared(sessionId: SessionId, message: string): QueueRecord {
    const id = createQueueId();
    const now = this.#now();
    const sequenceRow = this.#database.query(
      `UPDATE queue_sequence_authority
       SET next_sequence=next_sequence+1
       WHERE singleton=1 AND next_sequence<9007199254740991
       RETURNING next_sequence-1 AS enqueue_sequence`,
    ).get();
    if (sequenceRow === null) throw new Error("QUEUE_SEQUENCE_EXHAUSTED");
    const enqueueSequence = z.object({
      enqueue_sequence: z.number().int().positive().safe(),
    }).strict().parse(sequenceRow).enqueue_sequence;
    this.#database.query("INSERT INTO queue_entries(id,session_id,message,state,enqueue_sequence,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, sessionId, message, "pending", enqueueSequence, now, now);
    return { id, sessionId, message, state: "pending", createdAt: now, updatedAt: now };
  }

  enqueue(sessionId: SessionId, message: string): QueueRecord {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedMessage = z.string().min(1).max(262_144).parse(message);
    let queued: QueueRecord | undefined;
    this.#database.transaction(() => {
      queued = this.#enqueuePrepared(parsedSessionId, parsedMessage);
    }).immediate();
    if (queued === undefined) throw new Error("Queue transaction lost its durable row.");
    return queued;
  }

  enqueueIdempotent(input: { sessionId: SessionId; profileGeneration: number; message: string; idempotencyKey?: string }): QueueRecord {
    const parsedSessionId = sessionIdSchema.parse(input.sessionId);
    const parsedGeneration = z.number().int().nonnegative().parse(input.profileGeneration);
    const parsedMessage = z.string().min(1).max(262_144).parse(input.message);
    let queueId: QueueId | undefined;
    const enqueue = this.#database.transaction(() => {
      const attempt = this.prepareMutation({
        kind: "session.queue",
        authorityId: parsedSessionId,
        authorityGeneration: parsedGeneration,
        request: { message: parsedMessage },
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      if (attempt.replay) {
        if (attempt.state !== "applied" && attempt.state !== "reconciled") {
          throw new Error(`QUEUE_MUTATION_${attempt.state.toUpperCase()}`);
        }
        queueId = z.object({ queueId: queueIdSchema }).strict().parse(attempt.result).queueId;
        return;
      }
      const authority = z.object({ process_generation: z.number().int().nonnegative(), session_state: sessionStateSchema }).strict().parse(
        this.#database.query(`SELECT p.process_generation,s.state AS session_state FROM sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.id=?`).get(parsedSessionId),
      );
      if (authority.process_generation !== parsedGeneration || authority.session_state === "recovery_required" || authority.session_state === "terminal") {
        throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      }
      const queued = this.#enqueuePrepared(parsedSessionId, parsedMessage);
      queueId = queued.id;
      if (!this.transitionMutation(attempt.id, "prepared", "effect_started")) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      if (!this.transitionMutation(attempt.id, "effect_started", "applied", { queueId: queued.id })) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
    });
    enqueue.immediate();
    if (queueId === undefined) throw new Error("Queue transaction lost its durable receipt.");
    return this.requireQueue(queueId);
  }

  listQueue(sessionId: SessionId): readonly QueueRecord[] {
    const rows = this.#database.query("SELECT id,session_id,message,state,created_at,updated_at FROM queue_entries WHERE session_id=? ORDER BY enqueue_sequence").all(sessionId);
    return rows.map((row) => {
      const parsed = z.object({ id: queueIdSchema, session_id: sessionIdSchema, message: z.string(), state: queueStateSchema, created_at: unixMillisecondsSchema, updated_at: unixMillisecondsSchema }).strict().parse(row);
      return { id: parsed.id, sessionId: parsed.session_id, message: parsed.message, state: parsed.state, createdAt: parsed.created_at, updatedAt: parsed.updated_at };
    });
  }

  requireQueue(id: QueueId): QueueRecord {
    const row = this.#database.query("SELECT id,session_id,message,state,created_at,updated_at FROM queue_entries WHERE id=?").get(id);
    if (row === null) throw new SelectionError("NOT_FOUND");
    const parsed = z.object({ id: queueIdSchema, session_id: sessionIdSchema, message: z.string(), state: queueStateSchema, created_at: unixMillisecondsSchema, updated_at: unixMillisecondsSchema }).strict().parse(row);
    return { id: parsed.id, sessionId: parsed.session_id, message: parsed.message, state: parsed.state, createdAt: parsed.created_at, updatedAt: parsed.updated_at };
  }

  nextPendingQueue(sessionId: SessionId): QueueRecord | null {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const row = this.#database.query(
      `SELECT id,session_id,message,state,created_at,updated_at
       FROM queue_entries
       WHERE session_id=? AND state='pending'
       ORDER BY enqueue_sequence LIMIT 1`,
    ).get(parsedSessionId);
    if (row === null) return null;
    const parsed = z.object({
      id: queueIdSchema,
      session_id: sessionIdSchema,
      message: z.string(),
      state: z.literal("pending"),
      created_at: unixMillisecondsSchema,
      updated_at: unixMillisecondsSchema,
    }).strict().parse(row);
    return {
      id: parsed.id,
      sessionId: parsed.session_id,
      message: parsed.message,
      state: parsed.state,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    };
  }

  listRecoverableQueue(): readonly QueueRecord[] {
    const rows = this.#database
      .query("SELECT id,session_id,message,state,created_at,updated_at FROM queue_entries WHERE state IN ('pending','dispatching') ORDER BY enqueue_sequence")
      .all();
    return rows.map((row) => {
      const parsed = z.object({ id: queueIdSchema, session_id: sessionIdSchema, message: z.string(), state: queueStateSchema, created_at: unixMillisecondsSchema, updated_at: unixMillisecondsSchema }).strict().parse(row);
      return { id: parsed.id, sessionId: parsed.session_id, message: parsed.message, state: parsed.state, createdAt: parsed.created_at, updatedAt: parsed.updated_at };
    });
  }

  transitionQueue(id: QueueId, from: QueueState, to: QueueState): boolean {
    completePendingSecurityScrub(this.#database, false, this.#securityScrubCheckpoint);
    const parsedFrom = queueStateSchema.parse(from);
    const parsedTo = queueStateSchema.parse(to);
    if (!canTransitionQueue(parsedFrom, parsedTo)) {
      throw new Error(`Illegal queue transition: ${parsedFrom} -> ${parsedTo}`);
    }
    const now = this.#now();
    const changed = z.object({ id: queueIdSchema }).strict().nullable().parse(
      this.#database.query(
        "UPDATE queue_entries SET state=?,updated_at=? WHERE id=? AND state=? RETURNING id",
      ).get(parsedTo, now, id, parsedFrom),
    );
    if (changed !== null && (parsedTo === "applied" || parsedTo === "failed" || parsedTo === "cancelled")) {
      completePendingSecurityScrub(this.#database, true, this.#securityScrubCheckpoint);
    }
    return changed !== null;
  }

  beginQueueEffect(input: {
    queueId: QueueId;
    sessionId: SessionId;
    profileGeneration: number;
    evidence: QueueEffectEvidence;
  }): QueueEffectEvidenceRecord {
    const queueId = queueIdSchema.parse(input.queueId);
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const generation = z.number().int().nonnegative().parse(input.profileGeneration);
    const evidence = queueEffectEvidenceSchema.parse(input.evidence);
    if (evidence.queueId !== queueId || evidence.sessionId !== sessionId || evidence.profileGeneration !== generation) {
      throw new Error("QUEUE_EFFECT_REQUEST_MISMATCH");
    }
    const canonical = JSON.stringify(evidence);
    const digest = digestJson(evidence);
    const now = this.#now();
    const begin = this.#database.transaction(() => {
      const authority = z.object({
        queue_state: z.literal("pending"),
        queue_session_id: sessionIdSchema,
        queue_message: z.string().min(1).max(262_144),
        profile_id: profileIdSchema,
        provider_thread_id: providerThreadIdSchema,
        session_state: z.literal("idle"),
        process_generation: z.number().int().nonnegative(),
      }).strict().parse(this.#database.query(`SELECT q.state AS queue_state,q.session_id AS queue_session_id,q.message AS queue_message,
                                                     s.profile_id,s.provider_thread_id,s.state AS session_state,p.process_generation
                                              FROM queue_entries q
                                              JOIN sessions s ON s.id=q.session_id
                                              JOIN profiles p ON p.id=s.profile_id
                                              WHERE q.id=?`).get(queueId));
      if (
        authority.queue_session_id !== sessionId
        || authority.provider_thread_id !== evidence.providerThreadId
        || authority.process_generation !== generation
        || createHash("sha256").update(authority.queue_message).digest("hex") !== evidence.messageDigest
        || evidence.runtimeProfile.profileId !== authority.profile_id
        || evidence.runtimeProfile.processGeneration !== generation
      ) throw new Error("QUEUE_EFFECT_AUTHORITY_CHANGED");
      this.#database.query("INSERT INTO queue_effect_evidence(queue_id,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?)").run(queueId, canonical, digest, now);
      const changed = this.#database.query("UPDATE queue_entries SET state='dispatching',updated_at=? WHERE id=? AND state='pending'").run(now, queueId);
      if (changed.changes !== 1) throw new Error("QUEUE_EFFECT_AUTHORITY_CHANGED");
    });
    begin.immediate();
    return { queueId, digest, evidence, recordedAt: now };
  }

  readQueueEffect(queueId: QueueId): QueueEffectEvidenceRecord | null {
    const parsedQueueId = queueIdSchema.parse(queueId);
    const row = this.#database.query(`SELECT e.evidence_json,e.evidence_digest,e.recorded_at,
                                             r.resolution_kind,r.evidence_json AS resolution_evidence_json,
                                             r.receipt_json,r.created_at AS resolution_created_at
                                      FROM queue_effect_evidence e
                                      LEFT JOIN queue_effect_resolutions r ON r.queue_id=e.queue_id
                                      WHERE e.queue_id=?`).get(parsedQueueId) as {
      evidence_json: string;
      evidence_digest: string;
      recorded_at: number;
      resolution_kind: "proven_applied" | "abandoned" | null;
      resolution_evidence_json: string | null;
      receipt_json: string | null;
      resolution_created_at: number | null;
    } | null;
    if (row === null) return null;
    const evidence = queueEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
    const digest = sha256Schema.parse(row.evidence_digest);
    if (evidence.queueId !== parsedQueueId || digestJson(evidence) !== digest) throw new Error("QUEUE_EFFECT_EVIDENCE_MISMATCH");
    return {
      queueId: parsedQueueId,
      digest,
      evidence,
      recordedAt: unixMillisecondsSchema.parse(row.recorded_at),
      ...(row.resolution_kind === null ? {} : {
        resolution: {
          kind: row.resolution_kind,
          evidence: JSON.parse(z.string().parse(row.resolution_evidence_json)) as unknown,
          ...(row.receipt_json === null ? {} : { receipt: JSON.parse(row.receipt_json) as unknown }),
          createdAt: unixMillisecondsSchema.parse(row.resolution_created_at),
        },
      }),
    };
  }

  listUnsettledQueueEffects(sessionId: SessionId): readonly QueueEffectEvidenceRecord[] {
    const rows = this.#database.query(`SELECT q.id FROM queue_entries q
                                       JOIN queue_effect_evidence e ON e.queue_id=q.id
                                       LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
                                       WHERE q.session_id=? AND q.state IN ('dispatching','ambiguous') AND r.queue_id IS NULL
                                       ORDER BY q.enqueue_sequence`).all(sessionId);
    return rows.map((row) => {
      const id = z.object({ id: queueIdSchema }).strict().parse(row).id;
      const record = this.readQueueEffect(id);
      if (record === null) throw new Error("Queue effect disappeared during unsettled read.");
      return record;
    });
  }

  recoverDispatchingQueueEffects(): { recovered: readonly QueueId[]; unresolved: readonly QueueId[] } {
    const recovered: QueueId[] = [];
    const unresolved: QueueId[] = [];
    const recover = this.#database.transaction(() => {
      const rows = this.#database.query("SELECT id,session_id FROM queue_entries WHERE state='dispatching' ORDER BY enqueue_sequence").all();
      for (const row of rows) {
        const parsed = z.object({ id: queueIdSchema, session_id: sessionIdSchema }).strict().parse(row);
        const record = this.readQueueEffect(parsed.id);
        if (record === null || record.evidence.sessionId !== parsed.session_id) {
          unresolved.push(parsed.id);
          continue;
        }
        const binding = z.object({ provider_thread_id: providerThreadIdSchema.nullable(), process_generation: z.number().int().nonnegative() }).strict().parse(
          this.#database.query(`SELECT s.provider_thread_id,p.process_generation FROM sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.id=?`).get(parsed.session_id),
        );
        if (binding.provider_thread_id !== record.evidence.providerThreadId || binding.process_generation !== record.evidence.profileGeneration) {
          unresolved.push(parsed.id);
          continue;
        }
        const now = this.#now();
        const queueChanged = this.#database.query("UPDATE queue_entries SET state='ambiguous',updated_at=? WHERE id=? AND state='dispatching'").run(now, parsed.id);
        if (queueChanged.changes !== 1) throw new Error("QUEUE_RECOVERY_CAS_CONFLICT");
        this.#database.query(`UPDATE sessions SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=?
                              WHERE id=? AND state NOT IN ('recovery_required','terminal')`).run(now, parsed.session_id);
        recovered.push(parsed.id);
      }
    });
    recover.immediate();
    return { recovered, unresolved };
  }

  completeQueueEffect(input: {
    queueId: QueueId;
    expectedEvidenceDigest: string;
    expectedSessionRevision: number;
    applyResponseState: boolean;
    turnId: string;
    turnStatus: "completed" | "interrupted" | "failed" | "inProgress";
    runtimeProfile: EffectiveRuntimeProfile;
    receipt: unknown;
  }): void {
    completePendingSecurityScrub(this.#database, false, this.#securityScrubCheckpoint);
    const queueId = queueIdSchema.parse(input.queueId);
    const evidenceDigest = sha256Schema.parse(input.expectedEvidenceDigest);
    const profile = effectiveRuntimeProfileSchema.parse(input.runtimeProfile);
    const now = this.#now();
    const complete = this.#database.transaction(() => {
      const row = z.object({ session_id: sessionIdSchema, state: z.literal("dispatching"), evidence_json: z.string(), evidence_digest: sha256Schema }).strict().parse(
        this.#database.query(`SELECT q.session_id,q.state,e.evidence_json,e.evidence_digest
                              FROM queue_entries q JOIN queue_effect_evidence e ON e.queue_id=q.id WHERE q.id=?`).get(queueId),
      );
      const evidence = queueEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
      if (row.evidence_digest !== evidenceDigest || digestJson(evidence) !== evidenceDigest || JSON.stringify(evidence.runtimeProfile) !== JSON.stringify(profile)) {
        throw new Error("QUEUE_EFFECT_EVIDENCE_MISMATCH");
      }
      this.#bindSessionTurnRuntimeProfile({
        sessionId: row.session_id,
        sourceKind: "queue_start",
        sourceId: queueId,
        turnId: input.turnId,
        profile,
      }, now);
      const queueChanged = z.object({ id: queueIdSchema }).strict().nullable().parse(
        this.#database.query(
          "UPDATE queue_entries SET state='applied',updated_at=? WHERE id=? AND state='dispatching' RETURNING id",
        ).get(now, queueId),
      );
      if (queueChanged === null) throw new Error("QUEUE_EFFECT_CAS_CONFLICT");
      const nextState = input.turnStatus === "inProgress" ? "active" : "idle";
      if (input.applyResponseState) {
        const sessionChanged = this.#database.query(`UPDATE sessions SET state=?,active_turn_id=?,revision=revision+1,updated_at=?
                                                     WHERE id=? AND revision=? AND state NOT IN ('recovery_required','terminal')`).run(
          nextState,
          nextState === "active" ? z.string().min(1).max(200).parse(input.turnId) : null,
          now,
          row.session_id,
          z.number().int().positive().parse(input.expectedSessionRevision),
        );
        if (sessionChanged.changes !== 1) throw new Error("QUEUE_EFFECT_SESSION_CAS_CONFLICT");
      }
    });
    complete.immediate();
    completePendingSecurityScrub(this.#database, true, this.#securityScrubCheckpoint);
  }

  failQueueEffect(queueId: QueueId): boolean {
    return this.transitionQueue(queueId, "dispatching", "failed");
  }

  markQueueEffectAmbiguous(queueId: QueueId, expectedEvidenceDigest: string): SessionRecord {
    const parsedQueueId = queueIdSchema.parse(queueId);
    const digest = sha256Schema.parse(expectedEvidenceDigest);
    let sessionId: SessionId | undefined;
    const mark = this.#database.transaction(() => {
      const row = z.object({ session_id: sessionIdSchema, state: z.literal("dispatching"), evidence_digest: sha256Schema }).strict().parse(
        this.#database.query(`SELECT q.session_id,q.state,e.evidence_digest FROM queue_entries q
                              JOIN queue_effect_evidence e ON e.queue_id=q.id WHERE q.id=?`).get(parsedQueueId),
      );
      if (row.evidence_digest !== digest) throw new Error("QUEUE_EFFECT_EVIDENCE_MISMATCH");
      sessionId = row.session_id;
      const now = this.#now();
      const changed = this.#database.query("UPDATE queue_entries SET state='ambiguous',updated_at=? WHERE id=? AND state='dispatching'").run(now, parsedQueueId);
      if (changed.changes !== 1) throw new Error("QUEUE_EFFECT_CAS_CONFLICT");
      this.#database.query(`UPDATE sessions SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=?
                            WHERE id=? AND state NOT IN ('recovery_required','terminal')`).run(now, row.session_id);
    });
    mark.immediate();
    if (sessionId === undefined) throw new Error("Queue ambiguity lost its session authority.");
    return this.requireSession(sessionId);
  }

  resolveQueueEffect(input: {
    queueId: QueueId;
    expectedEvidenceDigest: string;
    resolution: "proven_applied" | "abandoned";
    resolutionEvidence: unknown;
    receipt?: unknown;
    provider: { providerThreadId: string; title: string; status: "active" | "idle" | "terminal"; activeTurnId?: string; providerUpdatedAt?: number };
  }): SessionRecord {
    completePendingSecurityScrub(this.#database, false, this.#securityScrubCheckpoint);
    const queueId = queueIdSchema.parse(input.queueId);
    const expectedDigest = sha256Schema.parse(input.expectedEvidenceDigest);
    const now = this.#now();
    let sessionId: SessionId | undefined;
    const resolve = this.#database.transaction(() => {
      const row = z.object({ session_id: sessionIdSchema, state: z.literal("ambiguous"), evidence_json: z.string(), evidence_digest: sha256Schema }).strict().parse(
        this.#database.query(`SELECT q.session_id,q.state,e.evidence_json,e.evidence_digest
                              FROM queue_entries q JOIN queue_effect_evidence e ON e.queue_id=q.id
                              LEFT JOIN queue_effect_resolutions r ON r.queue_id=q.id
                              WHERE q.id=? AND r.queue_id IS NULL`).get(queueId),
      );
      const evidence = queueEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown);
      if (row.evidence_digest !== expectedDigest || digestJson(evidence) !== expectedDigest) throw new Error("QUEUE_RECOVERY_EVIDENCE_MISMATCH");
      sessionId = row.session_id;
      const session = mapSession(this.#database.query("SELECT * FROM sessions WHERE id=?").get(row.session_id));
      if (session.providerThreadId !== input.provider.providerThreadId || evidence.providerThreadId !== input.provider.providerThreadId) {
        throw new Error("QUEUE_RECOVERY_THREAD_MISMATCH");
      }
      const changed = this.#database.query(`UPDATE sessions SET title=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=?
                                            WHERE id=? AND revision=? AND state='recovery_required'`).run(
        titleSchema.parse(input.provider.title),
        input.provider.status,
        input.provider.activeTurnId ?? null,
        input.provider.providerUpdatedAt ?? session.providerUpdatedAt ?? null,
        now,
        row.session_id,
        session.revision,
      );
      if (changed.changes !== 1) throw new Error("QUEUE_RECOVERY_SESSION_CAS_CONFLICT");
      if (input.resolution === "proven_applied") {
        const recoveredTurn = z.object({ turnId: z.string().min(1).max(200) }).passthrough().parse(input.receipt);
        this.#bindSessionTurnRuntimeProfile({
          sessionId: row.session_id,
          sourceKind: "queue_start",
          sourceId: queueId,
          turnId: recoveredTurn.turnId,
          profile: evidence.runtimeProfile,
        }, now);
      }
      this.#database.query("INSERT INTO queue_effect_resolutions(queue_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,?,?,?,?)").run(
        queueId,
        input.resolution,
        JSON.stringify(input.resolutionEvidence),
        input.receipt === undefined ? null : JSON.stringify(input.receipt),
        now,
      );
    });
    resolve.immediate();
    completePendingSecurityScrub(this.#database, true, this.#securityScrubCheckpoint);
    if (sessionId === undefined) throw new Error("Queue recovery lost its session authority.");
    return this.requireSession(sessionId);
  }

  readMutation(idempotencyKey: string): MutationAttemptRecord | null {
    const row = this.#database
      .query(`SELECT m.id,m.idempotency_key,m.kind,m.authority_id,m.authority_generation,m.request_digest,m.state,m.result_json,
                     e.evidence_json,e.evidence_digest,e.recorded_at,
                     r.resolution_kind,r.evidence_json AS resolution_evidence_json,r.receipt_json,r.created_at AS resolution_created_at,
                     s.session_id AS session_start_id
              FROM mutation_attempts m
              LEFT JOIN mutation_effect_evidence e ON e.attempt_id=m.id
              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
              LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
              WHERE m.idempotency_key=?`)
      .get(idempotencyKey) as {
        id: AttemptId;
        idempotency_key: string;
        kind: string;
        authority_id: string;
        authority_generation: number;
        request_digest: string;
        state: Exclude<MutationState, "reconciled">;
        result_json: string | null;
        evidence_json: string | null;
        evidence_digest: string | null;
        recorded_at: number | null;
        resolution_kind: MutationResolutionRecord["kind"] | null;
        resolution_evidence_json: string | null;
        receipt_json: string | null;
        resolution_created_at: number | null;
        session_start_id: SessionId | null;
      } | null;
    if (row === null) return null;
    const originalState = mutationStateSchema.exclude(["reconciled"]).parse(row.state);
    let evidence: MutationEffectEvidenceRecord | undefined;
    if (row.evidence_json !== null) {
      const parsedEvidence = mutationEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown) as MutationEffectEvidence;
      const parsedDigest = sha256Schema.parse(row.evidence_digest);
      if (digestJson(parsedEvidence) !== parsedDigest) throw new Error("MUTATION_EFFECT_EVIDENCE_DIGEST_MISMATCH");
      evidence = {
        attemptId: attemptIdSchema.parse(row.id),
        digest: parsedDigest,
        evidence: parsedEvidence,
        recordedAt: unixMillisecondsSchema.parse(row.recorded_at),
      };
    }
    const resolution = row.resolution_kind === null
      ? undefined
      : {
          kind: mutationResolutionKindSchema.parse(row.resolution_kind),
          evidence: JSON.parse(z.string().parse(row.resolution_evidence_json)) as unknown,
          ...(row.receipt_json === null ? {} : { receipt: JSON.parse(row.receipt_json) as unknown }),
          createdAt: unixMillisecondsSchema.parse(row.resolution_created_at),
        } satisfies MutationResolutionRecord;
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      authorityId: row.authority_id,
      authorityGeneration: row.authority_generation,
      requestDigest: row.request_digest,
      state: resolution === undefined ? originalState : "reconciled",
      ...(resolution === undefined
        ? row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }
        : resolution.receipt === undefined ? {} : { result: resolution.receipt }),
      ...(resolution === undefined ? {} : { originalState, resolution }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(row.session_start_id === null ? {} : { sessionStartId: sessionIdSchema.parse(row.session_start_id) }),
    };
  }

  readPendingLoginAuthority(profileId: ProfileId, processGeneration: number): PendingLoginAuthority | null {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedGeneration = z.number().int().nonnegative().parse(processGeneration);
    const rows = this.#database.query(`SELECT a.attempt_id,m.idempotency_key,a.login_id
                                       FROM provider_login_authorities a
                                       JOIN mutation_attempts m ON m.id=a.attempt_id
                                       WHERE a.profile_id=? AND a.process_generation=? AND a.state='active'
                                       ORDER BY a.recorded_at,a.attempt_id`).all(parsedProfileId, parsedGeneration) as {
      attempt_id: string;
      idempotency_key: string;
      login_id: string;
    }[];
    const pending = rows.map((row) => ({
        attemptId: attemptIdSchema.parse(row.attempt_id),
        idempotencyKey: z.string().uuid().parse(row.idempotency_key),
        profileId: parsedProfileId,
        processGeneration: parsedGeneration,
        loginId: providerLoginIdSchema.parse(row.login_id),
      } satisfies PendingLoginAuthority));
    if (pending.length > 1) throw new Error("LOGIN_CANCEL_AUTHORITY_AMBIGUOUS");
    return pending[0] ?? null;
  }

  completeAccountLoginMutation(input: {
    attemptId: AttemptId;
    profileId: ProfileId;
    processGeneration: number;
    receipt:
      | { status: "pending"; loginId: string }
      | { status: "signed_in"; account: { signedIn: true; email?: string | undefined; plan?: string | undefined } };
  }): ProfileRecord {
    const attemptId = attemptIdSchema.parse(input.attemptId);
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().positive().parse(input.processGeneration);
    const receipt = z.discriminatedUnion("status", [
      pendingLoginReceiptAuthoritySchema.strict(),
      z.object({
        status: z.literal("signed_in"),
        account: z.object({
          signedIn: z.literal(true),
          email: z.string().max(1_024).optional(),
          plan: z.string().max(128).optional(),
        }).strict(),
      }).strict(),
    ]).parse(input.receipt);
    const now = this.#now();
    const complete = this.#database.transaction(() => {
      const authority = z.object({
        kind: z.literal("account.login"),
        authority_id: profileIdSchema,
        authority_generation: z.number().int().positive(),
        mutation_state: z.literal("effect_started"),
        profile_generation: z.number().int().positive(),
        profile_state: z.literal("login_pending"),
        evidence_kind: z.literal("account.login"),
      }).strict().parse(this.#database.query(`SELECT m.kind,m.authority_id,m.authority_generation,m.state AS mutation_state,
                                                     p.process_generation AS profile_generation,p.state AS profile_state,
                                                     e.kind AS evidence_kind
                                              FROM mutation_attempts m
                                              JOIN profiles p ON p.id=m.authority_id
                                              JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                                              WHERE m.id=?`).get(attemptId));
      if (
        authority.authority_id !== profileId
        || authority.authority_generation !== processGeneration
        || authority.profile_generation !== processGeneration
      ) throw new Error("LOGIN_MUTATION_AUTHORITY_CHANGED");
      if (receipt.status === "pending") {
        this.#database.query(`INSERT INTO provider_login_authorities(
          attempt_id,profile_id,process_generation,login_id,state,recorded_at,updated_at
        ) VALUES (?,?,?,?,'active',?,?)`).run(
          attemptId,
          profileId,
          processGeneration,
          receipt.loginId,
          now,
          now,
        );
      } else {
        const profileChanged = this.#database.query(`UPDATE profiles
                                                     SET state='signed_in',provider_email=?,provider_plan=?,updated_at=?
                                                     WHERE id=? AND process_generation=? AND state='login_pending'`).run(
          receipt.account.email ?? null,
          receipt.account.plan ?? null,
          now,
          profileId,
          processGeneration,
        );
        if (profileChanged.changes !== 1) throw new Error("LOGIN_MUTATION_PROFILE_CAS_CONFLICT");
      }
      const changed = this.#database.query("UPDATE mutation_attempts SET state='applied',result_json=?,updated_at=? WHERE id=? AND state='effect_started'").run(
        JSON.stringify(receipt),
        now,
        attemptId,
      );
      if (changed.changes !== 1) throw new Error("LOGIN_MUTATION_CAS_CONFLICT");
    });
    complete.immediate();
    return this.requireProfileById(profileId);
  }

  settlePendingLogin(input: {
    profileId: ProfileId;
    processGeneration: number;
    loginId: string;
    providerStatus: "canceled" | "not_found";
    provider: { signedIn: boolean; email?: string; plan?: string };
  }): ProfileRecord {
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().nonnegative().parse(input.processGeneration);
    const loginId = providerLoginIdSchema.parse(input.loginId);
    const providerStatus = z.enum(["canceled", "not_found"]).parse(input.providerStatus);
    const provider = z.object({
      signedIn: z.boolean(),
      email: z.string().max(1_024).optional(),
      plan: z.string().max(128).optional(),
    }).strict().parse(input.provider);
    const settle = this.#database.transaction(() => {
      const current = mapProfile(this.#database.query("SELECT * FROM profiles WHERE id=?").get(profileId));
      if (current.processGeneration !== processGeneration) {
        throw new Error("LOGIN_CANCEL_GENERATION_MISMATCH");
      }
      if (current.state === "signed_in" || current.state === "signed_out") return current;
      if (current.state !== "login_pending") throw new Error("LOGIN_CANCEL_PROFILE_STATE_MISMATCH");
      const authority = this.readPendingLoginAuthority(profileId, processGeneration);
      if (authority === null || authority.loginId !== loginId) {
        throw new Error("LOGIN_CANCEL_AUTHORITY_MISMATCH");
      }
      const now = this.#now();
      const changed = this.#database.query(`UPDATE profiles
                                            SET state=?,provider_email=?,provider_plan=?,updated_at=?
                                            WHERE id=? AND process_generation=? AND state='login_pending'`).run(
        provider.signedIn ? "signed_in" : "signed_out",
        provider.signedIn ? provider.email ?? null : null,
        provider.signedIn ? provider.plan ?? null : null,
        now,
        profileId,
        processGeneration,
      );
      if (changed.changes !== 1) throw new Error("LOGIN_CANCEL_PROFILE_CAS_CONFLICT");
      const authorityChanged = this.#database.query(`UPDATE provider_login_authorities
                                                     SET state='settled',settlement=?,updated_at=?
                                                     WHERE attempt_id=? AND profile_id=? AND process_generation=? AND login_id=? AND state='active'`).run(
        provider.signedIn ? "signed_in" : providerStatus,
        now,
        authority.attemptId,
        profileId,
        processGeneration,
        loginId,
      );
      if (authorityChanged.changes !== 1) throw new Error("LOGIN_CANCEL_AUTHORITY_CAS_CONFLICT");
      return mapProfile(this.#database.query("SELECT * FROM profiles WHERE id=?").get(profileId));
    });
    return settle.immediate();
  }

  /**
   * Records the effect evidence for an `account.login-cancel` attempt and moves
   * it to `effect_started` in one transaction, bound to the exact pending login
   * it will cancel. Restart recovery reads this evidence like every other kind.
   */
  beginLoginCancelMutationEffect(input: {
    attemptId: AttemptId;
    profileId: ProfileId;
    processGeneration: number;
    loginId: string;
  }): void {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const parsedProfileId = profileIdSchema.parse(input.profileId);
    const parsedGeneration = z.number().int().nonnegative().parse(input.processGeneration);
    const evidence = mutationEffectEvidenceSchema.parse({
      kind: "account.login-cancel",
      loginId: input.loginId,
    } satisfies MutationEffectEvidence) as Extract<MutationEffectEvidence, { kind: "account.login-cancel" }>;
    const canonical = JSON.stringify(evidence);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const now = this.#now();
    const begin = this.#database.transaction(() => {
      const row = z.object({
        kind: z.literal("account.login-cancel"),
        authority_id: profileIdSchema,
        authority_generation: z.number().int().nonnegative(),
        state: z.literal("prepared"),
        process_generation: z.number().int().nonnegative(),
        profile_state: z.literal("login_pending"),
      }).strict().parse(
        this.#database.query(`SELECT m.kind,m.authority_id,m.authority_generation,m.state,p.process_generation,p.state AS profile_state
                              FROM mutation_attempts m JOIN profiles p ON p.id=m.authority_id WHERE m.id=?`).get(parsedAttemptId),
      );
      if (
        row.authority_id !== parsedProfileId
        || row.authority_generation !== parsedGeneration
        || row.process_generation !== parsedGeneration
      ) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      const authority = this.readPendingLoginAuthority(parsedProfileId, parsedGeneration);
      if (authority === null || authority.loginId !== evidence.loginId) {
        throw new Error("LOGIN_CANCEL_AUTHORITY_MISMATCH");
      }
      this.#database.query("INSERT INTO mutation_effect_evidence(attempt_id,kind,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?,?)").run(parsedAttemptId, evidence.kind, canonical, digest, now);
      const changed = this.#database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'").run(now, parsedAttemptId);
      if (changed.changes !== 1) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
    });
    begin.immediate();
  }

  /**
   * Resolves an indeterminate `account.login-cancel` attempt from an exact
   * provider account read. The cancellation changes no local state on its
   * own: a signed-in read proves the login completed, and a signed-out read
   * leaves the pending login where a fresh cancellation can settle it. The
   * attempt is never replayed.
   */
  resolveLoginCancelMutation(input: {
    attemptId: AttemptId;
    expectedOriginalState: "effect_started" | "ambiguous";
    provider: { signedIn: boolean };
  }): void {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const expectedState = z.enum(["effect_started", "ambiguous"]).parse(input.expectedOriginalState);
    const provider = z.object({ signedIn: z.boolean() }).strict().parse(input.provider);
    const now = this.#now();
    const resolveAttempt = this.#database.transaction(() => {
      const row = z.object({
        kind: z.literal("account.login-cancel"),
        state: z.enum(["effect_started", "ambiguous"]),
      }).strict().parse(
        this.#database.query(`SELECT m.kind,m.state FROM mutation_attempts m
                              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                              WHERE m.id=? AND r.attempt_id IS NULL`).get(parsedAttemptId),
      );
      if (row.state !== expectedState) throw new Error("MUTATION_RECOVERY_CAS_CONFLICT");
      const inserted = this.#database.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,?,?,?,?)").run(
        parsedAttemptId,
        "provider_state_reconciled",
        JSON.stringify({ source: "account/read", signedIn: provider.signedIn }),
        null,
        now,
      );
      if (inserted.changes !== 1) throw new Error("MUTATION_RECOVERY_CAS_CONFLICT");
    });
    resolveAttempt.immediate();
  }

  prepareMutation(input: { kind: string; authorityId: string; authorityGeneration: number; request: unknown; idempotencyKey?: string | undefined }): { id: AttemptId; state: MutationState; replay: boolean; result?: unknown } {
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const canonical = JSON.stringify({ kind: input.kind, authorityId: input.authorityId, authorityGeneration: input.authorityGeneration, request: input.request });
    const digest = createHash("sha256").update(canonical).digest("hex");
    const existing = this.readMutation(idempotencyKey);
    if (existing !== null) {
      if (
        existing.kind !== input.kind
        || existing.authorityId !== input.authorityId
        || existing.authorityGeneration !== input.authorityGeneration
        || existing.requestDigest !== digest
      ) throw new Error("IDEMPOTENCY_CONFLICT");
      return { id: existing.id, state: existing.state, replay: true, ...(existing.result === undefined ? {} : { result: existing.result }) };
    }
    const unsettled = this.#database
      .query(`SELECT m.id FROM mutation_attempts m
              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
              LEFT JOIN desktop_switch_resolutions dr ON dr.attempt_id=m.id
              WHERE m.authority_id=? AND m.authority_generation=?
                AND m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL AND dr.attempt_id IS NULL
              LIMIT 1`)
      .get(input.authorityId, input.authorityGeneration);
    if (unsettled !== null) throw new Error("UNSETTLED_MUTATION_AUTHORITY");
    const id = createAttemptId();
    const now = this.#now();
    this.#database.query("INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, idempotencyKey, input.kind, input.authorityId, input.authorityGeneration, digest, "prepared", now, now);
    return { id, state: "prepared", replay: false };
  }

  transitionMutation(id: AttemptId, from: MutationState, to: MutationState, result?: unknown): boolean {
    if (from === "reconciled" || to === "reconciled") {
      throw new Error("Reconciliation is append-only and cannot rewrite a mutation attempt.");
    }
    const now = this.#now();
    const resultJson = result === undefined ? null : JSON.stringify(result);
    const update = this.#database.query("UPDATE mutation_attempts SET state=?,result_json=?,updated_at=? WHERE id=? AND state=?").run(to, resultJson, now, id, from);
    return update.changes === 1;
  }

  beginSessionMutationEffect(input: {
    attemptId: AttemptId;
    sessionId: SessionId;
    profileGeneration: number;
    evidence: Extract<MutationEffectEvidence, { kind: "session.send" | "session.steer" | "session.stop" | "session.rename" }>;
  }): MutationEffectEvidenceRecord {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const parsedSessionId = sessionIdSchema.parse(input.sessionId);
    const parsedGeneration = z.number().int().nonnegative().parse(input.profileGeneration);
    const evidence = mutationEffectEvidenceSchema.parse(input.evidence) as typeof input.evidence;
    const canonical = JSON.stringify(evidence);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const now = this.#now();
    const begin = this.#database.transaction(() => {
      const authority = z.object({
        kind: z.string(),
        authority_id: sessionIdSchema,
        authority_generation: z.number().int().nonnegative(),
        state: z.literal("prepared"),
        profile_id: profileIdSchema,
        provider_thread_id: providerThreadIdSchema,
        process_generation: z.number().int().nonnegative(),
        session_state: sessionStateSchema,
      }).strict().parse(this.#database.query(`SELECT m.kind,m.authority_id,m.authority_generation,m.state,
                                                      s.profile_id,s.provider_thread_id,p.process_generation,s.state AS session_state
                                               FROM mutation_attempts m
                                               JOIN sessions s ON s.id=m.authority_id
                                               JOIN profiles p ON p.id=s.profile_id
                                               WHERE m.id=?`).get(parsedAttemptId));
      if (
        authority.kind !== evidence.kind
        || authority.authority_id !== parsedSessionId
        || authority.authority_generation !== parsedGeneration
        || authority.process_generation !== parsedGeneration
        || authority.provider_thread_id !== evidence.providerThreadId
        || (evidence.kind === "session.send" && evidence.runtimeProfile !== undefined && (
          evidence.runtimeProfile.profileId !== authority.profile_id
          || evidence.runtimeProfile.processGeneration !== parsedGeneration
        ))
        || authority.session_state === "recovery_required"
        || authority.session_state === "terminal"
      ) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      this.#database.query("INSERT INTO mutation_effect_evidence(attempt_id,kind,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?,?)").run(parsedAttemptId, evidence.kind, canonical, digest, now);
      const changed = this.#database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'").run(now, parsedAttemptId);
      if (changed.changes !== 1) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
    });
    begin.immediate();
    return { attemptId: parsedAttemptId, digest, evidence, recordedAt: now };
  }

  beginSessionStartEffect(input: {
    attemptId: AttemptId;
    profileId: ProfileId;
    profileGeneration: number;
    projectId: ProjectId;
    preset: Preset;
    fastEnabled: boolean;
    evidence: Extract<MutationEffectEvidence, { kind: "session.start" }>;
  }): SessionRecord {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const parsedProfileId = profileIdSchema.parse(input.profileId);
    const parsedGeneration = z.number().int().nonnegative().parse(input.profileGeneration);
    const parsedProjectId = projectIdSchema.parse(input.projectId);
    const parsedPreset = presetSchema.parse(input.preset);
    const evidence = mutationEffectEvidenceSchema.parse(input.evidence) as typeof input.evidence;
    if (evidence.projectId !== parsedProjectId) throw new Error("MUTATION_EFFECT_REQUEST_MISMATCH");
    if (evidence.runtimeProfile !== undefined && (
      evidence.runtimeProfile.profileId !== parsedProfileId
      || evidence.runtimeProfile.processGeneration !== parsedGeneration
      || evidence.runtimeProfile.preset !== parsedPreset
      || evidence.runtimeProfile.fast !== input.fastEnabled
    )) throw new Error("MUTATION_EFFECT_RUNTIME_PROFILE_MISMATCH");
    const canonical = JSON.stringify(evidence);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const sessionId = createSessionId();
    const now = this.#now();
    const begin = this.#database.transaction(() => {
      const authority = z.object({ kind: z.literal("session.start"), authority_id: profileIdSchema, authority_generation: z.number().int().nonnegative(), state: z.literal("prepared"), process_generation: z.number().int().nonnegative(), profile_state: profileStateSchema }).strict().parse(
        this.#database.query(`SELECT m.kind,m.authority_id,m.authority_generation,m.state,p.process_generation,p.state AS profile_state
                              FROM mutation_attempts m JOIN profiles p ON p.id=m.authority_id WHERE m.id=?`).get(parsedAttemptId),
      );
      if (
        authority.authority_id !== parsedProfileId
        || authority.authority_generation !== parsedGeneration
        || authority.process_generation !== parsedGeneration
        || authority.profile_state !== "signed_in"
      ) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      this.#database.query("INSERT INTO sessions(id,profile_id,project_id,title,preset,fast_enabled,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(sessionId, parsedProfileId, parsedProjectId, "Untitled session", parsedPreset, input.fastEnabled ? 1 : 0, "starting", 1, now, now);
      this.#insertSessionEventStream(sessionId, now);
      this.#database.query("INSERT INTO session_start_attempts(attempt_id,session_id,created_at) VALUES (?,?,?)").run(parsedAttemptId, sessionId, now);
      this.#database.query("INSERT INTO mutation_effect_evidence(attempt_id,kind,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?,?)").run(parsedAttemptId, evidence.kind, canonical, digest, now);
      const changed = this.#database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'").run(now, parsedAttemptId);
      if (changed.changes !== 1) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
    });
    begin.immediate();
    return this.requireSession(sessionId);
  }

  beginAccountMutationEffect(input: {
    attemptId: AttemptId;
    profileId: ProfileId;
    profileGeneration: number;
    evidence: Extract<MutationEffectEvidence, { kind: "account.login" | "account.logout" }>;
    providerRetirements?: readonly Readonly<{
      connectionId: string;
      releasedEvents: readonly Readonly<Pick<
        SessionEvent,
        | "accountId"
        | "body"
        | "providerConnectionId"
        | "providerGeneration"
        | "sessionId"
      >>[];
      sessionId: SessionId;
    }>[];
    workStore?: WorkStore;
  }): Readonly<{
    profile: ProfileRecord;
    retiredSessionIds: readonly SessionId[];
    affectedWorkIds: readonly string[];
  }> {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const parsedProfileId = profileIdSchema.parse(input.profileId);
    const parsedGeneration = z.number().int().nonnegative().parse(input.profileGeneration);
    const evidence = mutationEffectEvidenceSchema.parse(input.evidence) as typeof input.evidence;
    const expectedCurrentGeneration = evidence.kind === "account.login"
      ? parsedGeneration - 1
      : parsedGeneration;
    const seenRetirementSessions = new Set<SessionId>();
    const providerRetirements = (input.providerRetirements ?? []).map((retirement) => {
      const sessionId = sessionIdSchema.parse(retirement.sessionId);
      if (seenRetirementSessions.has(sessionId)) {
        throw new Error("ACCOUNT_LOGIN_RETIREMENT_SESSION_DUPLICATED");
      }
      seenRetirementSessions.add(sessionId);
      const connectionId = z.string().uuid().parse(retirement.connectionId);
      const releasedEvents = retirement.releasedEvents.map((event) => {
        const parsed = {
          accountId: profileIdSchema.parse(event.accountId),
          body: sessionEventBodySchema.parse(event.body),
          providerConnectionId: z.string().uuid().nullable().parse(event.providerConnectionId),
          providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
            .parse(event.providerGeneration),
          sessionId: sessionIdSchema.parse(event.sessionId),
        };
        const connectionMatches = parsed.providerConnectionId === connectionId
          || (
            parsed.providerConnectionId === null
            && (parsed.body.type === "warning" || parsed.body.type === "error")
          );
        if (
          parsed.accountId !== parsedProfileId
          || parsed.providerGeneration !== expectedCurrentGeneration
          || !connectionMatches
          || parsed.sessionId !== sessionId
          || parsed.body.type === "connection"
          || parsed.body.type === "gap"
          || parsed.body.type === "interaction_state"
        ) throw new Error("ACCOUNT_LOGIN_RETIREMENT_EVENT_AUTHORITY_MISMATCH");
        return parsed;
      });
      return { connectionId, releasedEvents, sessionId };
    });
    if (evidence.kind !== "account.login" && providerRetirements.length > 0) {
      throw new Error("ACCOUNT_LOGOUT_CANNOT_RETIRE_PROVIDER_GENERATION");
    }
    const canonical = JSON.stringify(evidence);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const now = this.#now();
    const begin = this.#database.transaction(() => {
      const row = z.object({ kind: z.string(), authority_id: profileIdSchema, authority_generation: z.number().int().nonnegative(), state: z.literal("prepared"), process_generation: z.number().int().nonnegative(), profile_state: profileStateSchema }).strict().parse(
        this.#database.query(`SELECT m.kind,m.authority_id,m.authority_generation,m.state,p.process_generation,p.state AS profile_state
                              FROM mutation_attempts m JOIN profiles p ON p.id=m.authority_id WHERE m.id=?`).get(parsedAttemptId),
      );
      if (
        row.kind !== evidence.kind
        || row.authority_id !== parsedProfileId
        || row.authority_generation !== parsedGeneration
        || row.process_generation !== expectedCurrentGeneration
        || row.profile_state === "removed"
        || row.profile_state === "recovery_required"
      ) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      const retiredSessionIds = new Set<SessionId>();
      let affectedWorkIds: readonly string[] = [];
      if (evidence.kind === "account.login") {
        for (const retirement of providerRetirements) {
          const session = z.object({
            profile_id: profileIdSchema,
          }).strict().parse(this.#database.query(
            "SELECT profile_id FROM sessions WHERE id=?",
          ).get(retirement.sessionId));
          if (session.profile_id !== parsedProfileId) {
            throw new Error("ACCOUNT_LOGIN_RETIREMENT_SESSION_AUTHORITY_MISMATCH");
          }
          for (const event of retirement.releasedEvents) {
            this.#appendSessionEventInTransaction({ ...event, recordedAt: now });
          }
        }
        const openInteractions = this.#database.query(
          `SELECT * FROM provider_interactions
           WHERE profile_id=? AND process_generation=?
             AND state IN ('pending','response_prepared','response_written')
           ORDER BY requested_at,public_id`,
        ).all(parsedProfileId, expectedCurrentGeneration);
        for (const value of openInteractions) {
          const current = interactionRowSchema.parse(value);
          const state = current.state === "pending" ? "expired" : "resolution_unknown";
          const changed = this.#database.query(
            `UPDATE provider_interactions
             SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
             WHERE public_id=? AND revision=? AND state=?`,
          ).run(state, now, now, current.public_id, current.revision, current.state);
          if (changed.changes !== 1) {
            throw new Error("ACCOUNT_LOGIN_INTERACTION_RETIREMENT_CONFLICT");
          }
          const terminal = this.#requireInteractionRow(current.public_id);
          this.#recordInteractionTransition(terminal, now);
          const interaction = mapInteraction(terminal);
          this.#ensureInteractionStateEventInTransaction(interaction, now);
          if (interaction.sessionId !== null) retiredSessionIds.add(interaction.sessionId);
        }
        for (const retirement of providerRetirements) {
          this.#appendSessionEventInTransaction({
            accountId: parsedProfileId,
            body: { type: "connection", state: "disconnected", reason: "closed" },
            providerConnectionId: retirement.connectionId,
            providerGeneration: expectedCurrentGeneration,
            recordedAt: now,
            sessionId: retirement.sessionId,
          });
          const position = this.#readSessionEventStream(retirement.sessionId);
          const missingSequence = position.observed_through_sequence + 1;
          this.#appendSessionEventInTransaction({
            accountId: parsedProfileId,
            body: {
              type: "gap",
              reason: "provider_disconnect",
              fromSequence: missingSequence,
              throughSequence: missingSequence,
            },
            providerConnectionId: retirement.connectionId,
            providerGeneration: expectedCurrentGeneration,
            recordedAt: now,
            sessionId: retirement.sessionId,
          });
          retiredSessionIds.add(retirement.sessionId);
        }
        affectedWorkIds = input.workStore?.prepareProfileAuthorityChange(
          parsedProfileId,
          expectedCurrentGeneration,
        ) ?? [];
        const advanced = this.#database.query("UPDATE profiles SET process_generation=?,state='login_pending',provider_email=NULL,provider_plan=NULL,updated_at=? WHERE id=? AND process_generation=?").run(parsedGeneration, now, parsedProfileId, expectedCurrentGeneration);
        if (advanced.changes !== 1) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      }
      this.#database.query("INSERT INTO mutation_effect_evidence(attempt_id,kind,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?,?)").run(parsedAttemptId, evidence.kind, canonical, digest, now);
      const changed = this.#database.query("UPDATE mutation_attempts SET state='effect_started',updated_at=? WHERE id=? AND state='prepared'").run(now, parsedAttemptId);
      if (changed.changes !== 1) throw new Error("MUTATION_EFFECT_AUTHORITY_CHANGED");
      return {
        profile: this.requireProfile(parsedProfileId),
        retiredSessionIds: [...retiredSessionIds].sort(),
        affectedWorkIds: [...affectedWorkIds].sort(),
      };
    });
    return begin.immediate();
  }

  listUnsettledMutations(input: { authorityId?: string; sessionId?: SessionId } = {}): readonly MutationAttemptRecord[] {
    const rows = input.sessionId === undefined
      ? input.authorityId === undefined
        ? this.#database.query(`SELECT m.idempotency_key FROM mutation_attempts m LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id WHERE m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL ORDER BY m.created_at,m.id`).all()
        : this.#database.query(`SELECT m.idempotency_key FROM mutation_attempts m LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id WHERE m.authority_id=? AND m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL ORDER BY m.created_at,m.id`).all(input.authorityId)
      : this.#database.query(`SELECT m.idempotency_key FROM mutation_attempts m
                              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                              LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
                              WHERE (m.authority_id=? OR s.session_id=?)
                                AND m.state IN ('effect_started','ambiguous') AND r.attempt_id IS NULL
                              ORDER BY m.created_at,m.id`).all(input.sessionId, input.sessionId);
    return rows.map((row) => {
      const key = z.object({ idempotency_key: z.string().uuid() }).strict().parse(row).idempotency_key;
      const attempt = this.readMutation(key);
      if (attempt === null) throw new Error("Mutation disappeared during unsettled read.");
      return attempt;
    });
  }

  resolveSessionMutation(input: {
    attemptId: AttemptId;
    expectedOriginalState: "effect_started" | "ambiguous";
    expectedEvidenceDigest: string;
    resolution: MutationResolutionRecord["kind"];
    resolutionEvidence: unknown;
    receipt?: unknown;
    provider?: { providerThreadId: string; title: string; status: "active" | "idle" | "terminal"; activeTurnId?: string; providerUpdatedAt?: number };
  }): SessionRecord {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const expectedDigest = sha256Schema.parse(input.expectedEvidenceDigest);
    const resolution = mutationResolutionKindSchema.parse(input.resolution);
    const resolutionJson = JSON.stringify(input.resolutionEvidence);
    const receiptJson = input.receipt === undefined ? null : JSON.stringify(input.receipt);
    const now = this.#now();
    let resolvedSessionId: SessionId | undefined;
    const resolveAttempt = this.#database.transaction(() => {
      const row = z.object({
        authority_id: z.string(),
        kind: z.string(),
        state: z.enum(["effect_started", "ambiguous"]),
        evidence_digest: sha256Schema,
        evidence_json: z.string(),
        session_start_id: sessionIdSchema.nullable(),
      }).strict().parse(this.#database.query(`SELECT m.authority_id,m.kind,m.state,e.evidence_digest,e.evidence_json,s.session_id AS session_start_id
                                              FROM mutation_attempts m
                                              JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                                              LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
                                              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                                              WHERE m.id=? AND r.attempt_id IS NULL`).get(parsedAttemptId));
      if (row.state !== input.expectedOriginalState || row.evidence_digest !== expectedDigest) {
        throw new Error("MUTATION_RECOVERY_CAS_CONFLICT");
      }
      const effectEvidence = mutationEffectEvidenceSchema.parse(JSON.parse(row.evidence_json) as unknown) as MutationEffectEvidence;
      if (effectEvidence.kind !== row.kind || digestJson(effectEvidence) !== row.evidence_digest) {
        throw new Error("MUTATION_RECOVERY_EVIDENCE_MISMATCH");
      }
      const sessionId = row.session_start_id ?? sessionIdSchema.parse(row.authority_id);
      resolvedSessionId = sessionId;
      const session = mapSession(this.#database.query("SELECT * FROM sessions WHERE id=?").get(sessionId));
      if (input.provider !== undefined) {
        if (session.providerThreadId === undefined || session.providerThreadId !== input.provider.providerThreadId) {
          throw new Error("MUTATION_RECOVERY_THREAD_MISMATCH");
        }
        const changed = this.#database.query(`UPDATE sessions SET title=?,state=?,active_turn_id=?,provider_updated_at=?,revision=revision+1,updated_at=?
                                              WHERE id=? AND revision=? AND state='recovery_required'`).run(
          titleSchema.parse(input.provider.title),
          input.provider.status,
          input.provider.activeTurnId ?? null,
          input.provider.providerUpdatedAt ?? session.providerUpdatedAt ?? null,
          now,
          session.id,
          session.revision,
        );
        if (changed.changes !== 1) throw new Error("MUTATION_RECOVERY_SESSION_CAS_CONFLICT");
      } else {
        if (row.kind !== "session.start" || session.providerThreadId !== undefined || resolution !== "abandoned") {
          throw new Error("MUTATION_RECOVERY_PROVIDER_PROJECTION_REQUIRED");
        }
        const changed = this.#database.query("UPDATE sessions SET state='terminal',active_turn_id=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state='recovery_required'").run(now, session.id, session.revision);
        if (changed.changes !== 1) throw new Error("MUTATION_RECOVERY_SESSION_CAS_CONFLICT");
      }
      if (resolution === "proven_applied" && (effectEvidence.kind === "session.start" || effectEvidence.kind === "session.send")) {
        if (effectEvidence.runtimeProfile === undefined) throw new Error("MUTATION_RECOVERY_RUNTIME_PROFILE_MISSING");
        if (effectEvidence.kind === "session.start") {
          this.#insertSessionRuntimeProfile({
            sessionId,
            sourceKind: "session_start",
            sourceId: parsedAttemptId,
            profile: effectEvidence.runtimeProfile,
          }, now);
        } else {
          const recoveredTurn = z.object({ turnId: z.string().min(1).max(200) }).passthrough().parse(input.receipt);
          this.#bindSessionTurnRuntimeProfile({
            sessionId,
            sourceKind: "turn_start",
            sourceId: parsedAttemptId,
            turnId: recoveredTurn.turnId,
            profile: effectEvidence.runtimeProfile,
          }, now);
        }
      }
      if (
        resolution === "proven_applied"
        && effectEvidence.kind === "session.start"
        && effectEvidence.conversationAutomationCapability
          === SESSION_CONVERSATION_AUTOMATION_CAPABILITY
        && input.provider !== undefined
        && input.provider.status !== "terminal"
      ) {
        this.#database.query(
          `INSERT INTO session_conversation_automation(
             session_id,provider_thread_id,enabled_at
           ) VALUES (?,?,?)
           ON CONFLICT(session_id) DO NOTHING`,
        ).run(sessionId, providerThreadIdSchema.parse(input.provider.providerThreadId), now);
        const capability = this.#database.query(
          `SELECT 1 FROM session_conversation_automation
           WHERE session_id=? AND provider_thread_id=?`,
        ).get(sessionId, input.provider.providerThreadId);
        if (capability === null) {
          throw new Error("CONVERSATION_AUTOMATION_SESSION_BINDING_CONFLICT");
        }
      }
      const inserted = this.#database.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,?,?,?,?)").run(parsedAttemptId, resolution, resolutionJson, receiptJson, now);
      if (inserted.changes !== 1) throw new Error("MUTATION_RECOVERY_CAS_CONFLICT");
    });
    resolveAttempt.immediate();
    if (resolvedSessionId === undefined) throw new Error("Mutation recovery lost its session binding.");
    return this.requireSession(resolvedSessionId);
  }

  resolveAccountMutation(input: {
    attemptId: AttemptId;
    expectedOriginalState: "effect_started" | "ambiguous";
    expectedEvidenceDigest: string;
    resolution: "proven_applied" | "provider_state_reconciled";
    resolutionEvidence: unknown;
    receipt?: unknown;
    provider: { signedIn: boolean; email?: string; plan?: string };
  }): ProfileRecord {
    const parsedAttemptId = attemptIdSchema.parse(input.attemptId);
    const expectedDigest = sha256Schema.parse(input.expectedEvidenceDigest);
    const resolution = mutationResolutionKindSchema.parse(input.resolution);
    const now = this.#now();
    let profileId: ProfileId | undefined;
    const resolveAttempt = this.#database.transaction(() => {
      const row = z.object({ authority_id: profileIdSchema, authority_generation: z.number().int().nonnegative(), state: z.enum(["effect_started", "ambiguous"]), evidence_digest: sha256Schema }).strict().parse(
        this.#database.query(`SELECT m.authority_id,m.authority_generation,m.state,e.evidence_digest
                              FROM mutation_attempts m JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                              LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                              WHERE m.id=? AND r.attempt_id IS NULL`).get(parsedAttemptId),
      );
      if (row.state !== input.expectedOriginalState || row.evidence_digest !== expectedDigest) throw new Error("MUTATION_RECOVERY_CAS_CONFLICT");
      profileId = row.authority_id;
      const changed = this.#database.query(`UPDATE profiles SET state=?,provider_email=?,provider_plan=?,updated_at=?
                                            WHERE id=? AND process_generation=? AND state='recovery_required'`).run(
        input.provider.signedIn ? "signed_in" : "signed_out",
        input.provider.email ?? null,
        input.provider.plan ?? null,
        now,
        row.authority_id,
        row.authority_generation,
      );
      if (changed.changes !== 1) throw new Error("MUTATION_RECOVERY_PROFILE_CAS_CONFLICT");
      this.#database.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,?,?,?,?)").run(
        parsedAttemptId,
        resolution,
        JSON.stringify(input.resolutionEvidence),
        input.receipt === undefined ? null : JSON.stringify(input.receipt),
        now,
      );
    });
    resolveAttempt.immediate();
    if (profileId === undefined) throw new Error("Mutation recovery lost its profile binding.");
    return this.requireProfile(profileId);
  }

  recoverEffectStartedMutations(): {
    recovered: readonly AttemptId[];
    unresolved: readonly { id: AttemptId; kind: string; authorityId: string }[];
  } {
    const recover = this.#database.transaction(() => {
      const rows = this.#database
        .query(`SELECT m.id,m.kind,m.authority_id,m.authority_generation,e.kind AS evidence_kind,e.evidence_json,e.evidence_digest,s.session_id AS session_start_id
                FROM mutation_attempts m
                LEFT JOIN mutation_effect_evidence e ON e.attempt_id=m.id
                LEFT JOIN session_start_attempts s ON s.attempt_id=m.id
                LEFT JOIN mutation_resolutions r ON r.attempt_id=m.id
                WHERE m.state='effect_started' AND r.attempt_id IS NULL
                ORDER BY m.created_at,m.id`)
        .all() as { id: string; kind: string; authority_id: string; authority_generation: number; evidence_kind: string | null; evidence_json: string | null; evidence_digest: string | null; session_start_id: string | null }[];
      const recovered: AttemptId[] = [];
      const unresolved: { id: AttemptId; kind: string; authorityId: string }[] = [];
      for (const raw of rows) {
        const id = attemptIdSchema.parse(raw.id);
        const authorityGeneration = z.number().int().nonnegative().parse(raw.authority_generation);
        const authorityId = z.string().min(1).max(200).parse(raw.authority_id);
        const kind = z.string().min(1).max(80).parse(raw.kind);
        let effectEvidence: MutationEffectEvidence | undefined;
        if (kind !== "desktop.switch") {
          try {
            if (raw.evidence_kind !== kind || raw.evidence_json === null) throw new Error("missing effect evidence");
            effectEvidence = mutationEffectEvidenceSchema.parse(JSON.parse(raw.evidence_json) as unknown) as MutationEffectEvidence;
            if (effectEvidence.kind !== kind || digestJson(effectEvidence) !== sha256Schema.parse(raw.evidence_digest)) throw new Error("effect evidence mismatch");
          } catch {
            unresolved.push({ id, kind, authorityId });
            continue;
          }
        }
        let authorityResolved = false;
        if (["session.send", "session.steer", "session.stop", "session.rename"].includes(kind)) {
          const parsedSession = sessionIdSchema.safeParse(authorityId);
          if (parsedSession.success) {
            const session = this.#database.query("SELECT state FROM sessions WHERE id=?").get(parsedSession.data) as { state: string } | null;
            if (session !== null) {
              if (effectEvidence === undefined || !("providerThreadId" in effectEvidence)) {
                unresolved.push({ id, kind, authorityId });
                continue;
              }
              const binding = this.#database.query("SELECT provider_thread_id FROM sessions WHERE id=?").get(parsedSession.data) as { provider_thread_id: string | null } | null;
              if (binding?.provider_thread_id !== effectEvidence.providerThreadId) {
                unresolved.push({ id, kind, authorityId });
                continue;
              }
              if (session.state !== "terminal" && session.state !== "recovery_required") {
                this.#database
                  .query("UPDATE sessions SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=? WHERE id=?")
                  .run(this.#now(), parsedSession.data);
              }
              authorityResolved = true;
            }
          }
        } else if (["account.login", "account.logout", "account.login-cancel"].includes(kind)) {
          const parsedProfile = profileIdSchema.safeParse(authorityId);
          if (parsedProfile.success) {
            const profile = this.#database
              .query("SELECT state,process_generation FROM profiles WHERE id=?")
              .get(parsedProfile.data) as { state: string; process_generation: number } | null;
            if (profile !== null && profile.process_generation === authorityGeneration) {
              if (profile.state !== "removed" && profile.state !== "recovery_required") {
                this.#database
                  .query("UPDATE profiles SET state='recovery_required',updated_at=? WHERE id=? AND process_generation=?")
                  .run(this.#now(), parsedProfile.data, authorityGeneration);
              }
              authorityResolved = true;
            }
          }
        } else if (kind === "session.start") {
          const parsedProfile = profileIdSchema.safeParse(authorityId);
          const parsedSession = sessionIdSchema.safeParse(raw.session_start_id);
          if (parsedProfile.success && parsedSession.success) {
            const binding = this.#database.query("SELECT profile_id,state FROM sessions WHERE id=?").get(parsedSession.data) as { profile_id: string; state: string } | null;
            const profile = this.#database.query("SELECT process_generation FROM profiles WHERE id=?").get(parsedProfile.data) as { process_generation: number } | null;
            if (binding?.profile_id === parsedProfile.data && profile?.process_generation === authorityGeneration) {
              if (binding.state !== "terminal" && binding.state !== "recovery_required") {
                this.#database.query("UPDATE sessions SET state='recovery_required',active_turn_id=NULL,revision=revision+1,updated_at=? WHERE id=?").run(this.#now(), parsedSession.data);
              }
              authorityResolved = true;
            }
          }
        } else if (kind === "desktop.switch") {
          const desktop = this.#database.query("SELECT 1 AS present FROM desktop_switches WHERE attempt_id=?").get(id);
          if (desktop !== null) {
            this.#markDesktopRecovery(this.#readDesktopSwitchByAttempt(id), "EFFECT_ADJACENT_RESTART");
            authorityResolved = true;
          }
        }
        if (!authorityResolved) {
          unresolved.push({ id, kind, authorityId });
          continue;
        }
        if (kind !== "desktop.switch" && !this.transitionMutation(id, "effect_started", "ambiguous", { code: "DAEMON_RESTART" })) {
          throw new Error("Mutation changed during restart recovery.");
        }
        recovered.push(id);
      }
      return { recovered, unresolved };
    });
    return recover.immediate();
  }

  readDesktopSwitchReplay(input: {
    readonly idempotencyKey: string;
    readonly requestedSource?: Readonly<{
      profileId: string;
      processGeneration: number;
    }>;
    readonly target: Readonly<{
      profileId: string;
      processGeneration: number;
    }>;
  }): DesktopSwitchPlan | null {
    const parsed = desktopSwitchBeginSchema.parse(input);
    const existing = this.#database
      .query("SELECT kind FROM mutation_attempts WHERE idempotency_key=?")
      .get(parsed.idempotencyKey) as { kind: string } | null;
    if (existing === null) return null;
    if (existing.kind !== "desktop.switch") throw new Error("IDEMPOTENCY_CONFLICT");
    const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
    if (
      row.source_profile_id !== (parsed.requestedSource?.profileId ?? null) ||
      row.source_generation !== (parsed.requestedSource?.processGeneration ?? null) ||
      row.target_profile_id !== parsed.target.profileId ||
      row.target_generation !== parsed.target.processGeneration
    ) {
      throw new Error("IDEMPOTENCY_CONFLICT");
    }
    return this.#desktopSwitchPlan(row.attempt_id);
  }

  async beginDesktopSwitch(input: {
    readonly idempotencyKey: string;
    readonly requestedSource?: Readonly<{
      profileId: string;
      processGeneration: number;
    }>;
    readonly target: Readonly<{
      profileId: string;
      processGeneration: number;
    }>;
  }): Promise<DesktopSwitchPlan> {
    const parsed = desktopSwitchBeginSchema.parse(input);
    const request = {
      sourceProfileId: parsed.requestedSource?.profileId ?? null,
      sourceProcessGeneration: parsed.requestedSource?.processGeneration ?? null,
      targetProfileId: parsed.target.profileId,
      targetProcessGeneration: parsed.target.processGeneration,
    } as const;

    const begin = this.#database.transaction((): DesktopSwitchPlan => {
      const attempt = this.prepareMutation({
        kind: "desktop.switch",
        authorityId: "desktop",
        authorityGeneration: parsed.target.processGeneration,
        request,
        idempotencyKey: parsed.idempotencyKey,
      });
      if (attempt.replay) return this.#desktopSwitchPlan(attempt.id);

      const target = this.#requireCurrentDesktopProfile(
        parsed.target.profileId,
        parsed.target.processGeneration,
      );
      if (target.state !== "signed_in" || target.providerEmail === undefined) {
        throw new Error("DESKTOP_TARGET_ACCOUNT_UNVERIFIED");
      }
      const expectedAccountKey = desktopAccountKeySchema.parse(target.providerEmail);
      if (parsed.requestedSource !== undefined) {
        this.#requireCurrentDesktopProfile(
          parsed.requestedSource.profileId,
          parsed.requestedSource.processGeneration,
        );
      }

      const authority = z
        .object({
          current_generation: z.number().int().nonnegative(),
          current_attempt_id: z.string().nullable(),
          released_generation: z.number().int().nonnegative(),
        })
        .strict()
        .parse(
          this.#database
            .query("SELECT current_generation,current_attempt_id,released_generation FROM desktop_switch_authority WHERE singleton=1")
            .get(),
        );
      if (
        authority.current_attempt_id !== null &&
        authority.released_generation !== authority.current_generation
      ) {
        throw new Error("DESKTOP_EFFECTS_UNSETTLED");
      }
      const switchGeneration = authority.current_generation + 1;
      if (!Number.isSafeInteger(switchGeneration)) throw new Error("DESKTOP_SWITCH_GENERATION_EXHAUSTED");
      const now = this.#now();
      this.#database
        .query(
          "INSERT INTO desktop_switches(attempt_id,source_profile_id,target_profile_id,source_generation,target_generation,phase,updated_at,switch_generation,journal_prepared,expected_account_key) VALUES (?,?,?,?,?,'prepared',?,?,0,?)",
        )
        .run(
          attempt.id,
          request.sourceProfileId,
          request.targetProfileId,
          request.sourceProcessGeneration,
          request.targetProcessGeneration,
          now,
          switchGeneration,
          expectedAccountKey,
        );
      const advanced = this.#database
        .query(
          "UPDATE desktop_switch_authority SET current_generation=?,current_attempt_id=? WHERE singleton=1 AND current_generation=? AND current_attempt_id IS ? AND released_generation=?",
        )
        .run(
          switchGeneration,
          attempt.id,
          authority.current_generation,
          authority.current_attempt_id,
          authority.released_generation,
        );
      if (advanced.changes !== 1) throw new Error("DESKTOP_SWITCH_GENERATION_CONFLICT");
      return {
        status: "ready",
        idempotencyKey: parsed.idempotencyKey,
        switchGeneration,
        sourceProfileId: request.sourceProfileId,
        sourceProcessGeneration: request.sourceProcessGeneration,
        targetProfileId: request.targetProfileId,
        targetProcessGeneration: request.targetProcessGeneration,
        journalStage: "new",
        expectedAccountKey,
      };
    });
    return begin.immediate();
  }

  async prepareDesktopSwitchJournal(entry: DesktopSwitchJournalEntry): Promise<void> {
    const parsed = z
      .object({
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
        bundleCdHash: z.string().regex(/^[a-f0-9]{40,128}$/u),
        sourcePid: z.number().int().positive().nullable(),
        targetPaths: z
          .object({
            profileRoot: z.string().min(1).max(4096),
            codexHome: z.string().min(1).max(4096),
            desktopUserData: z.string().min(1).max(4096),
          })
          .strict(),
        expectedAccountKey: desktopAccountKeySchema,
      })
      .strict()
      .parse(entry);
    if ((parsed.sourceProfileId === null) !== (parsed.sourceProcessGeneration === null)) {
      throw new Error("DESKTOP_SOURCE_AUTHORITY_INCOMPLETE");
    }
    const journalDigest = digestJson(parsed);
    const prepare = this.#database.transaction(() => {
      const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
      this.#assertDesktopBinding(row, parsed);
      if (!this.#isDesktopSwitchCurrentParsed(parsed)) throw new Error("DESKTOP_SWITCH_GENERATION_STALE");
      if (row.phase !== "prepared" || row.mutation_state !== "prepared") {
        throw new Error("DESKTOP_SWITCH_NOT_PREPARABLE");
      }
      if (row.journal_prepared === 1) {
        if (
          row.journal_digest !== journalDigest ||
          row.bundle_cd_hash !== parsed.bundleCdHash ||
          row.source_pid !== parsed.sourcePid
        ) {
          throw new Error("DESKTOP_JOURNAL_BINDING_CONFLICT");
        }
        return;
      }
      const now = this.#now();
      const recoveryDeadlineAt = now + desktopRecoverySettlementMs;
      if (!Number.isSafeInteger(recoveryDeadlineAt)) {
        throw new Error("DESKTOP_RECOVERY_DEADLINE_EXHAUSTED");
      }
      const updated = this.#database
        .query(
          "UPDATE desktop_switches SET journal_prepared=1,journal_digest=?,bundle_cd_hash=?,source_pid=?,recovery_deadline_at=?,updated_at=? WHERE attempt_id=? AND phase='prepared' AND journal_prepared=0",
        )
        .run(journalDigest, parsed.bundleCdHash, parsed.sourcePid, recoveryDeadlineAt, now, row.attempt_id);
      if (updated.changes !== 1) throw new Error("DESKTOP_JOURNAL_PREPARE_CONFLICT");
    });
    prepare.immediate();
  }

  async advanceDesktopSwitchJournal(input: {
    readonly idempotencyKey: string;
    readonly switchGeneration: number;
    readonly stage: DesktopSwitchStage;
    readonly launchedPid?: number;
    readonly diagnostic?: string;
  }): Promise<void> {
    const parsed = z
      .object({
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        stage: desktopSwitchStageSchema,
        launchedPid: z.number().int().positive().optional(),
        diagnostic: desktopDiagnosticSchema.optional(),
      })
      .strict()
      .parse(input);
    const advance = this.#database.transaction(() => {
      const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
      if (row.switch_generation !== parsed.switchGeneration) {
        throw new Error("DESKTOP_SWITCH_GENERATION_CONFLICT");
      }
      if (parsed.stage === "recovery-required") {
        this.#markDesktopRecovery(
          row,
          parsed.diagnostic ?? "DESKTOP_SWITCH_RECOVERY_REQUIRED",
        );
        return;
      }
      if (!this.#isDesktopSwitchCurrentRow(row)) throw new Error("DESKTOP_SWITCH_GENERATION_STALE");
      if (row.journal_prepared !== 1) throw new Error("DESKTOP_JOURNAL_NOT_PREPARED");
      const nextPhase = switchPhaseByStage[parsed.stage];
      if (row.phase === nextPhase) {
        if (
          parsed.launchedPid !== undefined &&
          row.launched_pid !== null &&
          row.launched_pid !== parsed.launchedPid
        ) {
          throw new Error("DESKTOP_LAUNCHED_PID_CONFLICT");
        }
        return;
      }
      if (parsed.stage === "prepared") throw new Error("DESKTOP_SWITCH_STAGE_CONFLICT");
      if (
        (parsed.stage === "target-observed" || parsed.stage === "verified") &&
        parsed.launchedPid === undefined
      ) {
        throw new Error("DESKTOP_LAUNCHED_PID_REQUIRED");
      }
      if (
        parsed.stage === "verified" &&
        row.launched_pid !== null &&
        row.launched_pid !== parsed.launchedPid
      ) {
        throw new Error("DESKTOP_LAUNCHED_PID_CONFLICT");
      }

      if (
        (parsed.stage === "quit-requested" || parsed.stage === "launch-requested") &&
        row.mutation_state === "prepared"
      ) {
        if (!this.transitionMutation(row.attempt_id, "prepared", "effect_started")) {
          throw new Error("DESKTOP_MUTATION_START_CONFLICT");
        }
      }
      const now = this.#now();
      const phaseUpdate = this.#database
        .query(
          "UPDATE desktop_switches SET phase=?,launched_pid=COALESCE(?,launched_pid),updated_at=? WHERE attempt_id=? AND phase=?",
        )
        .run(nextPhase, parsed.launchedPid ?? null, now, row.attempt_id, row.phase);
      if (phaseUpdate.changes !== 1) throw new Error("DESKTOP_SWITCH_STAGE_CONFLICT");

      if (parsed.stage === "verified") {
        const target = this.#requireCurrentDesktopProfile(
          row.target_profile_id,
          row.target_generation,
        );
        if (target.state !== "signed_in" || target.providerEmail === undefined) {
          throw new Error("DESKTOP_TARGET_ACCOUNT_UNVERIFIED");
        }
        const email = desktopAccountKeySchema.parse(target.providerEmail);
        if (email !== row.expected_account_key) throw new Error("DESKTOP_TARGET_ACCOUNT_CHANGED");
        const plan = parseOptionalPlan(target.providerPlan);
        const activeAccount = {
          signedIn: true as const,
          email,
          ...(plan === undefined ? {} : { plan }),
        };
        if (
          !this.transitionMutation(
            row.attempt_id,
            "effect_started",
            "applied",
            { activeAccount },
          )
        ) {
          throw new Error("DESKTOP_MUTATION_APPLY_CONFLICT");
        }
        const released = this.#database
          .query("UPDATE desktop_switch_authority SET released_generation=? WHERE singleton=1 AND current_generation=? AND current_attempt_id=? AND released_generation<?")
          .run(row.switch_generation, row.switch_generation, row.attempt_id, row.switch_generation);
        if (released.changes !== 1) throw new Error("DESKTOP_SWITCH_RELEASE_CONFLICT");
      }
    });
    advance.immediate();
  }

  async assertDesktopEffectsSettled(generation: DesktopSwitchGeneration): Promise<void> {
    const parsed = this.#parseDesktopGeneration(generation);
    if (!this.#isDesktopSwitchCurrentParsed(parsed)) {
      throw new Error("DESKTOP_SWITCH_GENERATION_STALE");
    }
    const row = this.#readDesktopSwitchByGeneration(parsed.switchGeneration);
    if (
      row.phase !== "prepared" ||
      row.mutation_state !== "prepared" ||
      row.journal_prepared !== 1
    ) {
      throw new Error("DESKTOP_EFFECTS_UNSETTLED");
    }
    const unresolved = z
      .object({ count: z.number().int().nonnegative() })
      .strict()
      .parse(
        this.#database
          .query(
            "SELECT COUNT(*) AS count FROM desktop_switches d LEFT JOIN desktop_switch_resolutions r ON r.attempt_id=d.attempt_id WHERE (d.switch_generation IS NULL OR d.switch_generation < ?) AND d.phase != 'applied' AND d.phase != 'failed' AND r.attempt_id IS NULL",
          )
          .get(parsed.switchGeneration),
      ).count;
    if (unresolved !== 0) throw new Error("DESKTOP_EFFECTS_UNSETTLED");
  }

  isDesktopSwitchCurrent(generation: DesktopSwitchGeneration): boolean {
    const parsed = this.#parseDesktopGenerationSafe(generation);
    return parsed === null ? false : this.#isDesktopSwitchCurrentParsed(parsed);
  }

  settlePreparedDesktopSwitch(input: DesktopSwitchGeneration & {
    readonly idempotencyKey: string;
    readonly diagnostic: string;
  }): boolean {
    const parsed = z
      .object({
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
        diagnostic: desktopDiagnosticSchema,
      })
      .strict()
      .parse(input);
    const settle = this.#database.transaction(() => {
      const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
      this.#assertDesktopBinding(row, parsed);
      if (
        !this.#isDesktopSwitchCurrentRow(row) ||
        row.phase !== "prepared" ||
        row.mutation_state !== "prepared" ||
        row.resolution_kind !== null
      ) {
        return false;
      }
      const now = this.#now();
      const failed = this.#database
        .query("UPDATE desktop_switches SET phase='failed',diagnostic_code=?,updated_at=? WHERE attempt_id=? AND phase='prepared'")
        .run(parsed.diagnostic, now, row.attempt_id);
      if (failed.changes !== 1) throw new Error("DESKTOP_PRE_EFFECT_SETTLEMENT_CONFLICT");
      if (!this.transitionMutation(row.attempt_id, "prepared", "cancelled")) {
        throw new Error("DESKTOP_PRE_EFFECT_SETTLEMENT_CONFLICT");
      }
      const released = this.#database
        .query("UPDATE desktop_switch_authority SET released_generation=? WHERE singleton=1 AND current_generation=? AND current_attempt_id=? AND released_generation<?")
        .run(row.switch_generation, row.switch_generation, row.attempt_id, row.switch_generation);
      if (released.changes !== 1) throw new Error("DESKTOP_PRE_EFFECT_SETTLEMENT_CONFLICT");
      return true;
    });
    return settle.immediate();
  }

  quarantineDesktopSwitchTargetByGeneration(input: DesktopSwitchGeneration & {
    readonly idempotencyKey: string;
  }): boolean {
    const parsed = z
      .object({
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
      })
      .strict()
      .parse(input);
    const row = this.#readDesktopSwitchByKey(parsed.idempotencyKey);
    this.#assertDesktopBinding(row, parsed);
    return this.#quarantineDesktopTarget(row);
  }

  quarantineDesktopSwitchTarget(input: DesktopRecoveryBinding): boolean {
    const parsed = this.#parseDesktopRecoveryBinding(input);
    const row = this.#readDesktopSwitchByAttempt(parsed.attemptId);
    this.#assertDesktopRecoveryBinding(row, parsed);
    return this.#quarantineDesktopTarget(row);
  }

  readCurrentDesktopSwitchRecovery(): unknown {
    const authority = z
      .object({
        current_generation: z.number().int().nonnegative(),
        current_attempt_id: attemptIdSchema.nullable(),
        released_generation: z.number().int().nonnegative(),
      })
      .strict()
      .parse(
        this.#database
          .query("SELECT current_generation,current_attempt_id,released_generation FROM desktop_switch_authority WHERE singleton=1")
          .get(),
      );
    if (authority.current_attempt_id === null || authority.current_generation === 0) {
      return { status: "none" };
    }
    const row = this.#readDesktopSwitchByAttempt(authority.current_attempt_id);
    if (row.switch_generation !== authority.current_generation) {
      throw new Error("DESKTOP_SWITCH_AUTHORITY_CORRUPT");
    }
    if (row.resolution_kind !== null) {
      if (row.resolution_receipt_json === null) throw new Error("DESKTOP_RECOVERY_RECEIPT_MISSING");
      return desktopRecoveryReceiptSchema.parse(JSON.parse(row.resolution_receipt_json) as unknown);
    }
    if (authority.released_generation === authority.current_generation) {
      return { status: "none" };
    }
    if (row.phase !== "ambiguous") {
      return {
        status: "in_progress",
        idempotencyKey: row.idempotency_key,
        switchGeneration: row.switch_generation,
        targetProfileId: row.target_profile_id,
        phase: row.phase,
      };
    }
    if (
      row.bundle_cd_hash === null ||
      row.recovery_deadline_at === null ||
      row.journal_prepared !== 1
    ) {
      throw new Error("DESKTOP_RECOVERY_EVIDENCE_INCOMPLETE");
    }
    return {
      status: "recovery_required",
      attemptId: row.attempt_id,
      idempotencyKey: row.idempotency_key,
      switchGeneration: row.switch_generation,
      sourceProfileId: row.source_profile_id,
      sourceProcessGeneration: row.source_generation,
      targetProfileId: row.target_profile_id,
      targetProcessGeneration: row.target_generation,
      originalPhase: row.ambiguous_from_phase ?? "prepared",
      diagnostic: row.diagnostic_code ?? "DESKTOP_SWITCH_RECOVERY_REQUIRED",
      recoveryDeadlineAt: row.recovery_deadline_at,
      bundleCdHash: row.bundle_cd_hash,
      sourcePid: row.source_pid,
      launchedPid: row.launched_pid,
      expectedAccountKey: row.expected_account_key,
    };
  }

  resolveDesktopSwitchRecovery(input: DesktopRecoveryBinding & {
    readonly resolution: DesktopRecoveryResolution;
    readonly diagnostic: string;
    readonly observationDigest: string;
    readonly activeAccount?: { signedIn: boolean; email?: string; plan?: string };
  }): unknown {
    const binding = this.#parseDesktopRecoveryBinding(input);
    const parsed = z
      .object({
        resolution: desktopRecoveryResolutionSchema,
        diagnostic: desktopDiagnosticSchema,
        observationDigest: sha256Schema,
        activeAccount: z
          .object({
            signedIn: z.boolean(),
            email: z.string().trim().email().max(320).optional(),
            plan: z.string().trim().min(1).max(160).optional(),
          })
          .strict()
          .optional(),
      })
      .passthrough()
      .parse(input);
    const resolveRecovery = this.#database.transaction(() => {
      const row = this.#readDesktopSwitchByAttempt(binding.attemptId);
      this.#assertDesktopRecoveryBinding(row, binding);
      const authority = z
        .object({
          current_generation: z.number().int().nonnegative(),
          current_attempt_id: attemptIdSchema.nullable(),
          released_generation: z.number().int().nonnegative(),
        })
        .strict()
        .parse(
          this.#database
            .query("SELECT current_generation,current_attempt_id,released_generation FROM desktop_switch_authority WHERE singleton=1")
            .get(),
        );
      if (
        authority.current_generation !== row.switch_generation ||
        authority.current_attempt_id !== row.attempt_id
      ) {
        throw new Error("DESKTOP_RECOVERY_CAS_CONFLICT");
      }
      if (row.resolution_kind !== null) {
        if (
          row.resolution_kind !== parsed.resolution ||
          row.resolution_diagnostic_code !== parsed.diagnostic ||
          row.resolution_observation_digest !== parsed.observationDigest ||
          row.resolution_receipt_json === null
        ) {
          throw new Error("DESKTOP_RECOVERY_REPLAY_CONFLICT");
        }
        const existing = desktopRecoveryReceiptSchema.parse(
          JSON.parse(row.resolution_receipt_json) as unknown,
        );
        const expectedAccount = this.#desktopRecoveryAccount(
          parsed.resolution,
          parsed.activeAccount,
          row.expected_account_key,
        );
        if (JSON.stringify(existing.activeAccount ?? null) !== JSON.stringify(expectedAccount ?? null)) {
          throw new Error("DESKTOP_RECOVERY_REPLAY_CONFLICT");
        }
        return existing;
      }
      if (
        authority.released_generation >= authority.current_generation ||
        row.phase !== "ambiguous" ||
        row.mutation_state !== "ambiguous"
      ) {
        throw new Error("DESKTOP_RECOVERY_CAS_CONFLICT");
      }
      if (
        parsed.resolution === "resolved_not_applied" &&
        (row.recovery_deadline_at === null || this.#now() < row.recovery_deadline_at)
      ) {
        throw new Error("DESKTOP_RECOVERY_DEADLINE_PENDING");
      }
      const activeAccount = this.#desktopRecoveryAccount(
        parsed.resolution,
        parsed.activeAccount,
        row.expected_account_key,
      );
      const resolvedAt = this.#now();
      if (activeAccount !== undefined) {
        const reconciledProfile = this.#database
          .query("UPDATE profiles SET state='signed_in',provider_email=?,provider_plan=?,updated_at=? WHERE id=? AND process_generation=? AND state!='removed'")
          .run(activeAccount.email, activeAccount.plan ?? null, resolvedAt, row.target_profile_id, row.target_generation);
        if (reconciledProfile.changes !== 1) throw new Error("DESKTOP_RECOVERY_PROFILE_CAS_CONFLICT");
      }
      const receipt = desktopRecoveryReceiptSchema.parse({
        status: parsed.resolution,
        attemptId: row.attempt_id,
        idempotencyKey: row.idempotency_key,
        switchGeneration: row.switch_generation,
        sourceProfileId: row.source_profile_id,
        sourceProcessGeneration: row.source_generation,
        targetProfileId: row.target_profile_id,
        targetProcessGeneration: row.target_generation,
        diagnostic: parsed.diagnostic,
        observationDigest: parsed.observationDigest,
        resolvedAt,
        ...(activeAccount === undefined ? {} : { activeAccount }),
      });
      const inserted = this.#database
        .query("INSERT INTO desktop_switch_resolutions(attempt_id,switch_generation,resolution_kind,diagnostic_code,observation_digest,receipt_json,resolved_at) VALUES (?,?,?,?,?,?,?)")
        .run(row.attempt_id, row.switch_generation, parsed.resolution, parsed.diagnostic, parsed.observationDigest, JSON.stringify(receipt), resolvedAt);
      if (inserted.changes !== 1) throw new Error("DESKTOP_RECOVERY_CAS_CONFLICT");
      const released = this.#database
        .query("UPDATE desktop_switch_authority SET released_generation=? WHERE singleton=1 AND current_generation=? AND current_attempt_id=? AND released_generation<?")
        .run(row.switch_generation, row.switch_generation, row.attempt_id, row.switch_generation);
      if (released.changes !== 1) throw new Error("DESKTOP_RECOVERY_CAS_CONFLICT");
      return receipt;
    });
    return resolveRecovery.immediate();
  }

  #parseDesktopRecoveryBinding(input: DesktopRecoveryBinding): DesktopRecoveryBinding {
    return z
      .object({
        attemptId: attemptIdSchema,
        idempotencyKey: z.string().uuid(),
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
      })
      .strict()
      .parse({
        attemptId: input.attemptId,
        idempotencyKey: input.idempotencyKey,
        switchGeneration: input.switchGeneration,
        sourceProfileId: input.sourceProfileId,
        sourceProcessGeneration: input.sourceProcessGeneration,
        targetProfileId: input.targetProfileId,
        targetProcessGeneration: input.targetProcessGeneration,
      });
  }

  #assertDesktopRecoveryBinding(row: DesktopSwitchRow, binding: DesktopRecoveryBinding): void {
    if (
      row.attempt_id !== binding.attemptId ||
      row.idempotency_key !== binding.idempotencyKey ||
      row.switch_generation !== binding.switchGeneration ||
      row.source_profile_id !== binding.sourceProfileId ||
      row.source_generation !== binding.sourceProcessGeneration ||
      row.target_profile_id !== binding.targetProfileId ||
      row.target_generation !== binding.targetProcessGeneration
    ) {
      throw new Error("DESKTOP_RECOVERY_BINDING_CONFLICT");
    }
  }

  #quarantineDesktopTarget(row: DesktopSwitchRow): boolean {
    const quarantine = this.#database.transaction(() => {
      const current = this.#readDesktopSwitchByAttempt(row.attempt_id);
      if (
        !this.#isDesktopSwitchCurrentRow(current) ||
        current.resolution_kind !== null ||
        current.target_profile_id !== row.target_profile_id ||
        current.target_generation !== row.target_generation
      ) {
        return false;
      }
      const profile = this.#database
        .query("SELECT state FROM profiles WHERE id=? AND process_generation=?")
        .get(current.target_profile_id, current.target_generation) as { state: string } | null;
      if (profile === null || profile.state === "removed") return false;
      if (profile.state === "recovery_required") return true;
      const updated = this.#database
        .query("UPDATE profiles SET state='recovery_required',updated_at=? WHERE id=? AND process_generation=? AND state!='removed'")
        .run(this.#now(), current.target_profile_id, current.target_generation);
      return updated.changes === 1;
    });
    return quarantine.immediate();
  }

  #desktopRecoveryAccount(
    resolution: DesktopRecoveryResolution,
    account: { signedIn: boolean; email?: string | undefined; plan?: string | undefined } | undefined,
    expectedAccountKey: string,
  ): { signedIn: true; email: string; plan?: string } | undefined {
    if (resolution === "resolved_not_applied") {
      if (account !== undefined) throw new Error("DESKTOP_RECOVERY_ACCOUNT_UNEXPECTED");
      return undefined;
    }
    if (!account?.signedIn || account.email === undefined) {
      throw new Error("DESKTOP_RECOVERY_ACCOUNT_REQUIRED");
    }
    const email = desktopAccountKeySchema.parse(account.email);
    if (email !== expectedAccountKey) throw new Error("DESKTOP_RECOVERY_ACCOUNT_MISMATCH");
    const plan = parseOptionalPlan(account.plan);
    return { signedIn: true, email, ...(plan === undefined ? {} : { plan }) };
  }

  #desktopSwitchPlan(attemptId: AttemptId): DesktopSwitchPlan {
    const row = this.#readDesktopSwitchByAttempt(attemptId);
    const base = {
      idempotencyKey: row.idempotency_key,
      switchGeneration: row.switch_generation,
      sourceProfileId: row.source_profile_id,
      sourceProcessGeneration: row.source_generation,
      targetProfileId: row.target_profile_id,
      targetProcessGeneration: row.target_generation,
    } as const;
    if (row.resolution_kind !== null) {
      let recoveryReceipt: z.infer<typeof desktopRecoveryReceiptSchema> | null = null;
      try {
        const parsedReceipt = desktopRecoveryReceiptSchema.safeParse(
          row.resolution_receipt_json === null
            ? null
            : (JSON.parse(row.resolution_receipt_json) as unknown),
        );
        if (parsedReceipt.success) recoveryReceipt = parsedReceipt.data;
      } catch {
        recoveryReceipt = null;
      }
      if (
        recoveryReceipt === null ||
        recoveryReceipt.status !== row.resolution_kind ||
        recoveryReceipt.attemptId !== row.attempt_id ||
        recoveryReceipt.idempotencyKey !== row.idempotency_key ||
        recoveryReceipt.switchGeneration !== row.switch_generation ||
        recoveryReceipt.sourceProfileId !== row.source_profile_id ||
        recoveryReceipt.sourceProcessGeneration !== row.source_generation ||
        recoveryReceipt.targetProfileId !== row.target_profile_id ||
        recoveryReceipt.targetProcessGeneration !== row.target_generation ||
        recoveryReceipt.diagnostic !== row.resolution_diagnostic_code ||
        recoveryReceipt.observationDigest !== row.resolution_observation_digest ||
        recoveryReceipt.resolvedAt !== row.resolution_resolved_at
      ) {
        return { status: "recovery_required", ...base, diagnostic: "RECOVERY_RECEIPT_INVALID" };
      }
      if (recoveryReceipt.status === "resolved_not_applied") {
        return { status: "recovery_required", ...base, diagnostic: "SWITCH_RESOLVED_NOT_APPLIED" };
      }
      const active = recoveryReceipt.activeAccount;
      if (
        active === undefined ||
        !active.signedIn ||
        active.email === undefined ||
        desktopAccountKeySchema.parse(active.email) !== row.expected_account_key
      ) {
        return { status: "recovery_required", ...base, diagnostic: "RECOVERY_RECEIPT_INVALID" };
      }
      return {
        status: "applied",
        ...base,
        expectedAccountKey: row.expected_account_key,
        activeAccount: {
          signedIn: true,
          email: active.email,
          ...(active.plan === undefined ? {} : { plan: active.plan }),
        },
      };
    }
    if (row.phase === "applied" && row.mutation_state === "applied") {
      const receiptSchema = z
        .object({
          activeAccount: z
            .object({
              signedIn: z.literal(true),
              email: desktopAccountKeySchema,
              plan: z.string().min(1).max(160).optional(),
            })
            .strict(),
        })
        .strict();
      let receipt: z.infer<typeof receiptSchema> | null = null;
      try {
        const parsedReceipt = receiptSchema.safeParse(
          row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
        );
        if (parsedReceipt.success) receipt = parsedReceipt.data;
      } catch {
        receipt = null;
      }
      if (receipt === null) {
        return {
          status: "recovery_required",
          ...base,
          diagnostic: "APPLIED_RECEIPT_INVALID",
        };
      }
      return {
        status: "applied",
        ...base,
        expectedAccountKey: row.expected_account_key,
        activeAccount: {
          signedIn: true,
          email: receipt.activeAccount.email,
          ...(receipt.activeAccount.plan === undefined
            ? {}
            : { plan: receipt.activeAccount.plan }),
        },
      };
    }
    if (row.phase === "prepared" && row.mutation_state === "prepared") {
      if (!this.#isDesktopSwitchCurrentRow(row)) {
        return { status: "recovery_required", ...base, diagnostic: "SWITCH_GENERATION_STALE" };
      }
      return {
        status: "ready",
        ...base,
        journalStage: row.journal_prepared === 1 ? "prepared" : "new",
        expectedAccountKey: row.expected_account_key,
      };
    }
    if (effectAdjacentPhases.has(row.phase)) {
      this.#markDesktopRecovery(row, "EFFECT_ADJACENT_RESTART");
      return {
        status: "recovery_required",
        ...base,
        diagnostic: "EFFECT_ADJACENT_RESTART",
      };
    }
    if (
      row.phase === "ambiguous" &&
      (row.mutation_state === "prepared" || row.mutation_state === "effect_started")
    ) {
      this.#markDesktopRecovery(
        row,
        row.diagnostic_code ?? "DESKTOP_SWITCH_STATE_INCONSISTENT",
      );
    }
    return {
      status: "recovery_required",
      ...base,
      diagnostic:
        row.diagnostic_code === null
          ? "DESKTOP_SWITCH_STATE_INCONSISTENT"
          : desktopDiagnosticSchema.parse(row.diagnostic_code),
    };
  }

  #markDesktopRecovery(row: DesktopSwitchRow, diagnostic: string): void {
    const parsedDiagnostic = desktopDiagnosticSchema.parse(diagnostic);
    if (row.phase === "applied" || row.mutation_state === "applied") {
      throw new Error("DESKTOP_APPLIED_SWITCH_IMMUTABLE");
    }
    if (row.phase !== "ambiguous") {
      const ambiguousFromPhase = z
        .enum(["prepared", "quit_started", "quit_confirmed", "launch_started", "verify_started"])
        .parse(row.phase);
      const updated = this.#database
        .query(
          "UPDATE desktop_switches SET phase='ambiguous',ambiguous_from_phase=COALESCE(ambiguous_from_phase,?),diagnostic_code=?,updated_at=? WHERE attempt_id=? AND phase=?",
        )
        .run(ambiguousFromPhase, parsedDiagnostic, this.#now(), row.attempt_id, row.phase);
      if (updated.changes !== 1) throw new Error("DESKTOP_RECOVERY_MARK_CONFLICT");
    }
    if (row.mutation_state === "prepared") {
      if (!this.transitionMutation(row.attempt_id, "prepared", "effect_started")) {
        throw new Error("DESKTOP_MUTATION_START_CONFLICT");
      }
      if (!this.transitionMutation(row.attempt_id, "effect_started", "ambiguous")) {
        throw new Error("DESKTOP_MUTATION_RECOVERY_CONFLICT");
      }
    } else if (row.mutation_state === "effect_started") {
      if (!this.transitionMutation(row.attempt_id, "effect_started", "ambiguous")) {
        throw new Error("DESKTOP_MUTATION_RECOVERY_CONFLICT");
      }
    }
  }

  #readDesktopSwitchByKey(idempotencyKey: string): DesktopSwitchRow {
    const row = this.#database
      .query(`${desktopSwitchSelect} WHERE m.idempotency_key=?`)
      .get(idempotencyKey);
    if (row === null) throw new Error("DESKTOP_SWITCH_NOT_FOUND");
    return desktopSwitchRowSchema.parse(row);
  }

  #readDesktopSwitchByAttempt(attemptId: AttemptId): DesktopSwitchRow {
    const row = this.#database
      .query(`${desktopSwitchSelect} WHERE d.attempt_id=?`)
      .get(attemptId);
    if (row === null) throw new Error("DESKTOP_SWITCH_NOT_FOUND");
    return desktopSwitchRowSchema.parse(row);
  }

  #readDesktopSwitchByGeneration(switchGeneration: number): DesktopSwitchRow {
    const row = this.#database
      .query(`${desktopSwitchSelect} WHERE d.switch_generation=?`)
      .get(switchGeneration);
    if (row === null) throw new Error("DESKTOP_SWITCH_NOT_FOUND");
    return desktopSwitchRowSchema.parse(row);
  }

  #assertDesktopBinding(
    row: DesktopSwitchRow,
    binding: DesktopSwitchGeneration,
  ): void {
    if (
      row.switch_generation !== binding.switchGeneration ||
      row.source_profile_id !== binding.sourceProfileId ||
      row.source_generation !== binding.sourceProcessGeneration ||
      row.target_profile_id !== binding.targetProfileId ||
      row.target_generation !== binding.targetProcessGeneration
    ) {
      throw new Error("DESKTOP_SWITCH_BINDING_CONFLICT");
    }
  }

  #parseDesktopGeneration(generation: DesktopSwitchGeneration): DesktopSwitchGeneration {
    const parsed = z
      .object({
        switchGeneration: positiveGenerationSchema,
        sourceProfileId: profileIdSchema.nullable(),
        sourceProcessGeneration: positiveGenerationSchema.nullable(),
        targetProfileId: profileIdSchema,
        targetProcessGeneration: positiveGenerationSchema,
      })
      .parse(generation);
    if ((parsed.sourceProfileId === null) !== (parsed.sourceProcessGeneration === null)) {
      throw new Error("DESKTOP_SOURCE_AUTHORITY_INCOMPLETE");
    }
    return parsed;
  }

  #parseDesktopGenerationSafe(generation: DesktopSwitchGeneration): DesktopSwitchGeneration | null {
    try {
      return this.#parseDesktopGeneration(generation);
    } catch {
      return null;
    }
  }

  #isDesktopSwitchCurrentParsed(generation: DesktopSwitchGeneration): boolean {
    try {
      const row = this.#readDesktopSwitchByGeneration(generation.switchGeneration);
      this.#assertDesktopBinding(row, generation);
      return this.#isDesktopSwitchCurrentRow(row);
    } catch {
      return false;
    }
  }

  #isDesktopSwitchCurrentRow(row: DesktopSwitchRow): boolean {
    const authority = this.#database
      .query(
        "SELECT 1 AS current FROM desktop_switch_authority WHERE singleton=1 AND current_generation=? AND current_attempt_id=? AND released_generation<current_generation",
      )
      .get(row.switch_generation, row.attempt_id);
    if (authority === null) return false;
    const target = this.#database
      .query(
        "SELECT 1 AS current FROM profiles WHERE id=? AND process_generation=? AND state!='removed'",
      )
      .get(row.target_profile_id, row.target_generation);
    if (target === null) return false;
    if (row.source_profile_id === null) return row.source_generation === null;
    return (
      row.source_generation !== null &&
      this.#database
        .query(
          "SELECT 1 AS current FROM profiles WHERE id=? AND process_generation=? AND state!='removed'",
        )
        .get(row.source_profile_id, row.source_generation) !== null
    );
  }

  #requireCurrentDesktopProfile(profileId: ProfileId, generation: number): ProfileRecord {
    const row = this.#database
      .query(
        "SELECT * FROM profiles WHERE id=? AND process_generation=? AND state!='removed'",
      )
      .get(profileId, generation);
    if (row === null) throw new Error("DESKTOP_PROFILE_GENERATION_STALE");
    return mapProfile(row);
  }

  #readSessionEventStream(sessionId: SessionId): z.infer<typeof sessionEventStreamRowSchema> {
    const row = this.#database.query(
      `SELECT stream_epoch,floor_sequence,observed_through_sequence,
              retained_count,retained_bytes,retention_gap_reason
       FROM session_event_streams WHERE session_id=?`,
    ).get(sessionId);
    if (row === null) throw new Error("SESSION_EVENT_STREAM_MISSING");
    return sessionEventStreamRowSchema.parse(row);
  }

  #deleteSessionEventPrefix(
    sessionId: SessionId,
    throughSequence: number,
    reason: Extract<SessionEventGapReason, "retention_count" | "retention_age" | "retention_bytes">,
    now: number,
  ): void {
    const deleted = this.#database.query(
      "DELETE FROM session_events WHERE session_id=? AND sequence<=?",
    ).run(sessionId, throughSequence);
    if (deleted.changes === 0) return;
    const boundary = z.object({
      floor_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict().parse(this.#database.query(
      `SELECT COALESCE(
         (SELECT MIN(sequence) FROM session_events WHERE session_id=?),
         (SELECT next_sequence FROM session_event_streams WHERE session_id=?)
       ) AS floor_sequence`,
    ).get(sessionId, sessionId));
    const updated = this.#database.query(
      `UPDATE session_event_streams
       SET floor_sequence=?,retention_gap_reason=?,updated_at=MAX(updated_at,?)
       WHERE session_id=? AND floor_sequence<=?`,
    ).run(boundary.floor_sequence, reason, now, sessionId, boundary.floor_sequence);
    if (updated.changes !== 1) throw new Error("SESSION_EVENT_RETENTION_AUTHORITY_CHANGED");
  }

  #applySessionEventRetention(sessionId: SessionId, now: number): void {
    let stream = this.#readSessionEventStream(sessionId);
    if (stream.retained_count > SESSION_EVENT_RETAIN_COUNT) {
      const firstKept = z.object({
        sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        `SELECT sequence FROM session_events
         WHERE session_id=? ORDER BY sequence DESC
         LIMIT 1 OFFSET ?`,
      ).get(sessionId, SESSION_EVENT_RETAIN_COUNT - 1));
      this.#deleteSessionEventPrefix(sessionId, firstKept.sequence - 1, "retention_count", now);
      stream = this.#readSessionEventStream(sessionId);
    }

    const ageCutoff = Math.max(0, now - SESSION_EVENT_RETAIN_AGE_MS);
    const ageBoundary = z.object({
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    }).strict().parse(this.#database.query(
      `SELECT MAX(sequence) AS sequence FROM session_events
       WHERE session_id=? AND recorded_at<?`,
    ).get(sessionId, ageCutoff));
    if (ageBoundary.sequence !== null) {
      this.#deleteSessionEventPrefix(sessionId, ageBoundary.sequence, "retention_age", now);
      stream = this.#readSessionEventStream(sessionId);
    }

    if (stream.retained_bytes > SESSION_EVENT_RETAIN_BYTES) {
      const firstKept = z.object({
        sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        `SELECT MIN(sequence) AS sequence FROM (
           SELECT sequence,SUM(event_bytes) OVER (
             ORDER BY sequence DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cumulative_bytes
           FROM session_events WHERE session_id=?
         ) WHERE cumulative_bytes<=?`,
      ).get(sessionId, SESSION_EVENT_RETAIN_BYTES));
      this.#deleteSessionEventPrefix(sessionId, firstKept.sequence - 1, "retention_bytes", now);
    }
  }

  eventStreamPosition(sessionId: SessionId): SessionEventStreamPosition {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const read = this.#database.transaction(() => {
      if (this.#database.query("SELECT 1 FROM sessions WHERE id=?").get(parsedSessionId) === null) {
        throw new SelectionError("NOT_FOUND");
      }
      this.#ensureSessionEventStream(parsedSessionId);
      return mapSessionEventStreamPosition(this.#readSessionEventStream(parsedSessionId));
    });
    return this.#readonly ? read() : read.immediate();
  }

  readSessionSnapshotWithEventPosition(sessionId: SessionId): SessionSnapshotWithEventPosition {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const read = this.#database.transaction(() => {
      const sessionRow = this.#database.query("SELECT * FROM sessions WHERE id=?").get(parsedSessionId);
      if (sessionRow === null) throw new SelectionError("NOT_FOUND");
      this.#ensureSessionEventStream(parsedSessionId);
      return {
        session: mapSession(sessionRow),
        ...mapSessionEventStreamPosition(this.#readSessionEventStream(parsedSessionId)),
      };
    });
    return this.#readonly ? read() : read.immediate();
  }

  readSessionObservationSnapshot(
    sessionId: SessionId,
    pendingLimit = SESSION_STATUS_PENDING_SUMMARY_LIMIT,
  ): SessionLocalObservationSnapshot {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedPendingLimit = z.number().int().min(1)
      .max(SESSION_STATUS_PENDING_SUMMARY_LIMIT).parse(pendingLimit);
    const read = this.#database.transaction(() => {
      const sessionRow = this.#database.query("SELECT * FROM sessions WHERE id=?").get(parsedSessionId);
      if (sessionRow === null) throw new SelectionError("NOT_FOUND");
      const session = mapSession(sessionRow);
      const eventStream = mapSessionEventStreamPosition(this.#readSessionEventStream(parsedSessionId));
      const interactionCounts = z.object({
        pending_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        response_in_flight_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        `SELECT
           COALESCE(SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END),0) AS pending_count,
           COALESCE(SUM(CASE WHEN state IN ('response_prepared','response_written') THEN 1 ELSE 0 END),0)
             AS response_in_flight_count
         FROM provider_interactions WHERE session_id=?`,
      ).get(parsedSessionId));
      const pending = this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE session_id=? AND state='pending'
         ORDER BY deadline_at ASC,requested_at ASC,public_id ASC LIMIT ?`,
      ).all(parsedSessionId, parsedPendingLimit).map((value) => {
        const interaction = mapInteraction(value);
        const safeSummary = redactAbsolutePaths(
          redactCompleteSensitiveText(interaction.display.summary, "[protected]"),
        );
        const summary = safeSummary.length <= 512
          ? safeSummary
          : safeSummary.slice(0, 512);
        return {
          id: interaction.publicId,
          kind: interaction.kind,
          revision: interaction.revision,
          blocking: interaction.blocking,
          summary,
          requestedAt: interaction.requestedAt,
          deadlineAt: interaction.deadlineAt,
        };
      });
      const queue = z.object({
        depth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        dispatching_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        ambiguous_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        failed_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        `SELECT
           COALESCE(SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END),0) AS depth,
           COALESCE(SUM(CASE WHEN state='dispatching' THEN 1 ELSE 0 END),0) AS dispatching_count,
           COALESCE(SUM(CASE WHEN state='ambiguous' THEN 1 ELSE 0 END),0) AS ambiguous_count,
           COALESCE(SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END),0) AS failed_count
         FROM queue_entries WHERE session_id=?`,
      ).get(parsedSessionId));
      const observedAt = unixMillisecondsSchema.parse(this.#now());
      return sessionLocalObservationSnapshotSchema.parse({
        observedAt,
        session: {
          id: session.id,
          accountId: session.profileId,
          projectId: session.projectId ?? null,
          title: safeObservationTitle(session.title),
          execution: session.state,
          activeTurnId: session.activeTurnId === undefined
            ? null
            : this.#publicProviderIdentifierProjector(session.activeTurnId),
          revision: session.revision,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
        eventStream,
        interactions: {
          pendingCount: interactionCounts.pending_count,
          responseInFlightCount: interactionCounts.response_in_flight_count,
          pending,
          truncated: interactionCounts.pending_count > pending.length,
        },
        queue: {
          depth: queue.depth,
          dispatchingCount: queue.dispatching_count,
          ambiguousCount: queue.ambiguous_count,
          failedCount: queue.failed_count,
        },
      });
    });
    return read();
  }

  readRootStatusSnapshot(attentionLimit = ROOT_STATUS_ATTENTION_LIMIT): RootStatus {
    const parsedAttentionLimit = z.number().int().min(1)
      .max(ROOT_STATUS_ATTENTION_LIMIT).parse(attentionLimit);
    const read = this.#database.transaction(() => {
      const accounts = z.object({
        signed_out: z.number().int().nonnegative(),
        login_pending: z.number().int().nonnegative(),
        signed_in: z.number().int().nonnegative(),
        recovery_required: z.number().int().nonnegative(),
      }).strict().parse(this.#database.query(
        `SELECT
           COALESCE(SUM(CASE WHEN state='signed_out' THEN 1 ELSE 0 END),0) AS signed_out,
           COALESCE(SUM(CASE WHEN state='login_pending' THEN 1 ELSE 0 END),0) AS login_pending,
           COALESCE(SUM(CASE WHEN state='signed_in' THEN 1 ELSE 0 END),0) AS signed_in,
           COALESCE(SUM(CASE WHEN state='recovery_required' THEN 1 ELSE 0 END),0) AS recovery_required
         FROM profiles WHERE state!='removed'`,
      ).get());
      const sessions = z.object({
        starting: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        idle: z.number().int().nonnegative(),
        terminal: z.number().int().nonnegative(),
        recovery_required: z.number().int().nonnegative(),
      }).strict().parse(this.#database.query(
        `SELECT
           COALESCE(SUM(CASE WHEN state='starting' THEN 1 ELSE 0 END),0) AS starting,
           COALESCE(SUM(CASE WHEN state='active' THEN 1 ELSE 0 END),0) AS active,
           COALESCE(SUM(CASE WHEN state='idle' THEN 1 ELSE 0 END),0) AS idle,
           COALESCE(SUM(CASE WHEN state='terminal' THEN 1 ELSE 0 END),0) AS terminal,
           COALESCE(SUM(CASE WHEN state='recovery_required' THEN 1 ELSE 0 END),0) AS recovery_required
         FROM sessions`,
      ).get());
      const interactions = z.object({
        pending: z.number().int().nonnegative(),
        response_prepared: z.number().int().nonnegative(),
        response_written: z.number().int().nonnegative(),
        resolved: z.number().int().nonnegative(),
        declined: z.number().int().nonnegative(),
        canceled: z.number().int().nonnegative(),
        expired: z.number().int().nonnegative(),
        resolution_unknown: z.number().int().nonnegative(),
      }).strict().parse(this.#database.query(
        `SELECT
           COALESCE(SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END),0) AS pending,
           COALESCE(SUM(CASE WHEN state='response_prepared' THEN 1 ELSE 0 END),0) AS response_prepared,
           COALESCE(SUM(CASE WHEN state='response_written' THEN 1 ELSE 0 END),0) AS response_written,
           COALESCE(SUM(CASE WHEN state='resolved' THEN 1 ELSE 0 END),0) AS resolved,
           COALESCE(SUM(CASE WHEN state='declined' THEN 1 ELSE 0 END),0) AS declined,
           COALESCE(SUM(CASE WHEN state='canceled' THEN 1 ELSE 0 END),0) AS canceled,
           COALESCE(SUM(CASE WHEN state='expired' THEN 1 ELSE 0 END),0) AS expired,
           COALESCE(SUM(CASE WHEN state='resolution_unknown' THEN 1 ELSE 0 END),0) AS resolution_unknown
         FROM provider_interactions`,
      ).get());
      const queue = z.object({
        pending: z.number().int().nonnegative(),
        dispatching: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        ambiguous: z.number().int().nonnegative(),
        cancelled: z.number().int().nonnegative(),
      }).strict().parse(this.#database.query(
        `SELECT
           COALESCE(SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END),0) AS pending,
           COALESCE(SUM(CASE WHEN state='dispatching' THEN 1 ELSE 0 END),0) AS dispatching,
           COALESCE(SUM(CASE WHEN state='applied' THEN 1 ELSE 0 END),0) AS applied,
           COALESCE(SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END),0) AS failed,
           COALESCE(SUM(CASE WHEN state='ambiguous' THEN 1 ELSE 0 END),0) AS ambiguous,
           COALESCE(SUM(CASE WHEN state='cancelled' THEN 1 ELSE 0 END),0) AS cancelled
         FROM queue_entries`,
      ).get());
      const usage = z.object({
        observed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        missing: z.number().int().nonnegative(),
      }).strict().parse(this.#database.query(
        `WITH outcomes AS (
           SELECT profile_id,source_revision,'observed' AS outcome FROM usage_snapshots
           UNION ALL
           SELECT profile_id,source_revision,'failed' AS outcome FROM usage_poll_failures
         ), ranked AS (
           SELECT profile_id,outcome,
                  ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY source_revision DESC) AS outcome_rank
           FROM outcomes
         )
         SELECT
           COALESCE(SUM(CASE WHEN r.outcome='observed' THEN 1 ELSE 0 END),0) AS observed,
           COALESCE(SUM(CASE WHEN r.outcome='failed' THEN 1 ELSE 0 END),0) AS failed,
           COALESCE(SUM(CASE WHEN r.outcome IS NULL THEN 1 ELSE 0 END),0) AS missing
         FROM profiles p
         LEFT JOIN ranked r ON r.profile_id=p.id AND r.outcome_rank=1
         WHERE p.state!='removed'`,
      ).get());
      const attentionRows = this.#database.query(
        `SELECT attention.*,COUNT(*) OVER () AS total FROM (
           SELECT 0 AS priority,'account_recovery_required' AS kind,p.id AS account_id,
                  p.process_generation AS account_generation,NULL AS session_id,NULL AS session_revision,
                  NULL AS interaction_id,NULL AS interaction_revision,NULL AS interaction_kind,
                  NULL AS interaction_state,NULL AS blocking,NULL AS deadline_at,p.updated_at AS observed_at,
                  p.id AS stable_id
           FROM profiles p WHERE p.state='recovery_required'
           UNION ALL
           SELECT 1,'session_recovery_required',s.profile_id,p.process_generation,s.id,s.revision,
                  NULL,NULL,NULL,NULL,NULL,NULL,s.updated_at,s.id
           FROM sessions s JOIN profiles p ON p.id=s.profile_id
           WHERE s.state='recovery_required' AND p.state!='removed'
           UNION ALL
           SELECT 2,'interaction_pending',i.profile_id,p.process_generation,i.session_id,NULL,
                  i.public_id,i.revision,i.kind,i.state,i.blocking,i.deadline_at,i.requested_at,i.public_id
           FROM provider_interactions i JOIN profiles p ON p.id=i.profile_id
           WHERE i.state='pending' AND p.state!='removed'
           UNION ALL
           SELECT 3,'account_login_pending',p.id,p.process_generation,NULL,NULL,
                  NULL,NULL,NULL,NULL,NULL,NULL,p.updated_at,p.id
           FROM profiles p WHERE p.state='login_pending'
           UNION ALL
           SELECT 4,'interaction_response_in_flight',i.profile_id,p.process_generation,i.session_id,NULL,
                  i.public_id,i.revision,i.kind,i.state,i.blocking,i.deadline_at,i.updated_at,i.public_id
           FROM provider_interactions i JOIN profiles p ON p.id=i.profile_id
           WHERE i.state IN ('response_prepared','response_written') AND p.state!='removed'
         ) AS attention
         ORDER BY priority ASC,observed_at ASC,kind ASC,stable_id ASC LIMIT ?`,
      ).all(parsedAttentionLimit);
      const attentionRowSchema = z.object({
        priority: z.number().int().min(0).max(4),
        kind: z.enum([
          "account_login_pending",
          "account_recovery_required",
          "session_recovery_required",
          "interaction_pending",
          "interaction_response_in_flight",
        ]),
        account_id: profileIdSchema,
        account_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        session_id: sessionIdSchema.nullable(),
        session_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
        interaction_id: z.string().uuid().nullable(),
        interaction_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
        interaction_kind: interactionKindSchema.nullable(),
        interaction_state: interactionStateSchema.nullable(),
        blocking: z.union([z.literal(0), z.literal(1)]).nullable(),
        deadline_at: unixMillisecondsSchema.nullable(),
        observed_at: unixMillisecondsSchema,
        stable_id: z.string().min(1),
        total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }).strict();
      const parsedAttentionRows = attentionRows.map((value) => attentionRowSchema.parse(value));
      const records: RootStatusAttentionRecord[] = parsedAttentionRows.map((row) => {
        if (row.kind === "account_login_pending") {
          return {
            kind: row.kind,
            accountId: row.account_id,
            accountGeneration: row.account_generation,
            observedAt: row.observed_at,
            intent: { kind: "inspect_account", accountId: row.account_id },
          };
        }
        if (row.kind === "account_recovery_required") {
          return {
            kind: row.kind,
            accountId: row.account_id,
            accountGeneration: row.account_generation,
            observedAt: row.observed_at,
            intent: { kind: "inspect_account", accountId: row.account_id },
          };
        }
        if (row.kind === "session_recovery_required") {
          return {
            kind: row.kind,
            accountId: row.account_id,
            sessionId: sessionIdSchema.parse(row.session_id),
            sessionRevision: z.number().int().positive().parse(row.session_revision),
            observedAt: row.observed_at,
            intent: { kind: "inspect_session", sessionId: sessionIdSchema.parse(row.session_id) },
          };
        }
        const interactionId = z.string().uuid().parse(row.interaction_id);
        const interactionRevision = z.number().int().positive().parse(row.interaction_revision);
        const interactionKind = interactionKindSchema.parse(row.interaction_kind);
        const interactionState = interactionStateSchema.parse(row.interaction_state);
        const requiresProtectedInspection = row.kind === "interaction_pending"
          && (
            interactionKind === "command_approval"
            || interactionKind === "permission_approval"
          );
        return {
          kind: row.kind,
          accountId: row.account_id,
          accountGeneration: row.account_generation,
          sessionId: row.session_id,
          interactionId,
          interactionRevision,
          interactionKind,
          interactionState,
          blocking: z.boolean().parse(row.blocking === 1),
          deadlineAt: unixMillisecondsSchema.parse(row.deadline_at),
          observedAt: row.observed_at,
          intent: requiresProtectedInspection
            ? { kind: "inspect_interaction", interactionId, expectedRevision: interactionRevision }
            : { kind: "show_interaction", interactionId },
        };
      });
      const attentionTotal = parsedAttentionRows[0]?.total ?? 0;
      const observedAt = unixMillisecondsSchema.parse(this.#now());
      return assertRootStatusBound(rootStatusSchema.parse({
        version: 1,
        scope: "local_only",
        localObservation: {
          source: "sqlite",
          coverage: "complete",
          freshness: "fresh",
          observedAt,
          tables: [
            "profiles",
            "sessions",
            "provider_interactions",
            "queue_entries",
            "usage_snapshots",
            "usage_poll_failures",
          ],
        },
        providerObservation: {
          source: "codex_app_server",
          coverage: "not_attempted",
          freshness: "unknown",
          observedAt: null,
        },
        cloudObservation: {
          source: "convex",
          coverage: "not_attempted",
          freshness: "unknown",
          observedAt: null,
          devices: { registered: null, online: null },
        },
        counts: {
          accounts: {
            signedOut: accounts.signed_out,
            loginPending: accounts.login_pending,
            signedIn: accounts.signed_in,
            recoveryRequired: accounts.recovery_required,
          },
          sessions: {
            starting: sessions.starting,
            active: sessions.active,
            idle: sessions.idle,
            terminal: sessions.terminal,
            recoveryRequired: sessions.recovery_required,
          },
          interactions: {
            pending: interactions.pending,
            responsePrepared: interactions.response_prepared,
            responseWritten: interactions.response_written,
            resolved: interactions.resolved,
            declined: interactions.declined,
            canceled: interactions.canceled,
            expired: interactions.expired,
            resolutionUnknown: interactions.resolution_unknown,
          },
          queue: {
            pending: queue.pending,
            dispatching: queue.dispatching,
            applied: queue.applied,
            failed: queue.failed,
            ambiguous: queue.ambiguous,
            cancelled: queue.cancelled,
          },
          usage,
        },
        attention: {
          records,
          total: attentionTotal,
          truncated: attentionTotal > records.length,
        },
      }));
    });
    return read();
  }

  #appendSessionEventInTransaction(input: Readonly<{
    sessionId: SessionId;
    accountId: ProfileId;
    providerGeneration: number;
    providerConnectionId: string | null;
    body: SessionEventBody;
    recordedAt: number;
  }>): SessionEvent {
    const authority = z.object({
      profile_id: profileIdSchema,
      process_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).strict().parse(this.#database.query(
      `SELECT s.profile_id,p.process_generation
       FROM sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.id=?`,
    ).get(input.sessionId));
    if (
      authority.profile_id !== input.accountId
      || authority.process_generation !== input.providerGeneration
    ) throw new Error("SESSION_EVENT_AUTHORITY_CHANGED");
    this.#ensureSessionEventStream(input.sessionId);
    const stream = z.object({
      stream_epoch: z.string().uuid(),
      next_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict().parse(this.#database.query(
      "SELECT stream_epoch,next_sequence FROM session_event_streams WHERE session_id=?",
    ).get(input.sessionId));
    if (stream.next_sequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("SESSION_EVENT_SEQUENCE_EXHAUSTED");
    }
    const event = sessionEventSchema.parse({
      version: 1,
      sessionId: input.sessionId,
      streamEpoch: stream.stream_epoch,
      sequence: stream.next_sequence,
      recordedAt: input.recordedAt,
      accountId: input.accountId,
      providerGeneration: input.providerGeneration,
      providerConnectionId: input.providerConnectionId,
      body: input.body,
    });
    const eventJson = JSON.stringify(event);
    const eventBytes = new TextEncoder().encode(eventJson).byteLength;
    if (eventBytes > SESSION_EVENT_MAX_BYTES) throw new Error("SESSION_EVENT_EXCEEDS_BOUND");
    this.#database.query(
      `INSERT INTO session_events(
         session_id,stream_epoch,sequence,recorded_at,account_id,provider_generation,
         provider_connection_id,event_json,event_bytes,projection_version
       ) VALUES (?,?,?,?,?,?,?,?,?,2)`,
    ).run(
      input.sessionId,
      stream.stream_epoch,
      stream.next_sequence,
      input.recordedAt,
      input.accountId,
      input.providerGeneration,
      input.providerConnectionId,
      eventJson,
      eventBytes,
    );
    const advanced = this.#database.query(
      `UPDATE session_event_streams
       SET next_sequence=?,observed_through_sequence=?,updated_at=MAX(updated_at,?)
       WHERE session_id=? AND stream_epoch=? AND next_sequence=?`,
    ).run(
      stream.next_sequence + 1,
      stream.next_sequence,
      input.recordedAt,
      input.sessionId,
      stream.stream_epoch,
      stream.next_sequence,
    );
    if (advanced.changes !== 1) throw new Error("SESSION_EVENT_SEQUENCE_AUTHORITY_CHANGED");
    this.#applySessionEventRetention(input.sessionId, input.recordedAt);
    return event;
  }

  appendSessionEvent(input: {
    sessionId: SessionId;
    accountId: ProfileId;
    providerGeneration: number;
    providerConnectionId: string | null;
    body: SessionEventBody;
  }): SessionEvent {
    const parsed = {
      sessionId: sessionIdSchema.parse(input.sessionId),
      accountId: profileIdSchema.parse(input.accountId),
      providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
        .parse(input.providerGeneration),
      providerConnectionId: z.string().uuid().nullable().parse(input.providerConnectionId),
      body: sessionEventBodySchema.parse(projectPublicSessionEventBody(
        input.body,
        this.#publicProviderIdentifierProjector,
      )),
      recordedAt: unixMillisecondsSchema.parse(this.#now()),
    };
    const append = this.#database.transaction(
      () => this.#appendSessionEventInTransaction(parsed),
    );
    return append.immediate();
  }

  appendPublicSessionEvent(input: {
    sessionId: SessionId;
    accountId: ProfileId;
    providerGeneration: number;
    providerConnectionId: string | null;
    body: SessionEventBody;
  }): SessionEvent {
    const parsed = {
      sessionId: sessionIdSchema.parse(input.sessionId),
      accountId: profileIdSchema.parse(input.accountId),
      providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
        .parse(input.providerGeneration),
      providerConnectionId: z.string().uuid().nullable().parse(input.providerConnectionId),
      body: sessionEventBodySchema.parse(input.body),
      recordedAt: unixMillisecondsSchema.parse(this.#now()),
    };
    const append = this.#database.transaction(
      () => this.#appendSessionEventInTransaction(parsed),
    );
    return append.immediate();
  }

  #ensureInteractionStateEventInTransaction(
    interaction: InteractionRecord,
    recordedAt: number,
  ): void {
    if (interaction.sessionId === null) return;
    const matching = this.#database.query(
      `SELECT event_json,projection_version FROM session_events
       WHERE session_id=?
         AND json_extract(event_json,'$.body.type')='interaction_state'
         AND json_extract(event_json,'$.body.interactionId')=?
         AND json_extract(event_json,'$.body.revision')=?
       ORDER BY sequence LIMIT 2`,
    ).all(interaction.sessionId, interaction.publicId, interaction.revision).map((value) =>
      z.object({
        event_json: z.string(),
        projection_version: z.union([z.literal(1), z.literal(2)]),
      }).strict().parse(value)
    );
    if (matching.length > 1) {
      throw new Error("INTERACTION_STATE_EVENT_DUPLICATED");
    }
    const existing = matching[0];
    if (existing !== undefined) {
      const event = parseStoredSessionEvent(
        existing.event_json,
        existing.projection_version,
        this.#publicProviderIdentifierProjector,
      );
      if (
        event.sessionId !== interaction.sessionId
        || event.accountId !== interaction.authority.profileId
        || event.providerGeneration !== interaction.authority.processGeneration
        || event.providerConnectionId !== interaction.authority.connectionId
        || event.body.type !== "interaction_state"
        || event.body.interactionId !== interaction.publicId
        || event.body.state !== interaction.state
        || event.body.revision !== interaction.revision
      ) throw new Error("INTERACTION_STATE_EVENT_CONFLICT");
      return;
    }
    this.#appendSessionEventInTransaction({
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
      recordedAt,
    });
  }

  maintainSessionEventRetention(sessionId: SessionId, now = this.#now()): SessionEventStreamPosition {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedNow = unixMillisecondsSchema.parse(now);
    const maintain = this.#database.transaction(() => {
      this.#ensureSessionEventStream(parsedSessionId);
      this.#applySessionEventRetention(parsedSessionId, parsedNow);
      return mapSessionEventStreamPosition(this.#readSessionEventStream(parsedSessionId));
    });
    return maintain.immediate();
  }

  listSessionEvents(input: {
    sessionId: SessionId;
    afterSequence: number | null;
    limit?: number;
    now?: number;
  }): SessionEventList {
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const afterSequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().parse(input.afterSequence);
    const limit = z.number().int().min(1).max(SESSION_EVENT_PAGE_LIMIT).parse(input.limit ?? SESSION_EVENT_PAGE_LIMIT);
    const maintenanceNow = this.#readonly
      ? undefined
      : unixMillisecondsSchema.parse(input.now ?? this.#now());
    const read = this.#database.transaction(() => {
      this.#ensureSessionEventStream(sessionId);
      if (maintenanceNow !== undefined && !this.#readonly) {
        this.#applySessionEventRetention(sessionId, maintenanceNow);
      }
      const stream = this.#readSessionEventStream(sessionId);
      if (afterSequence !== null && afterSequence > stream.observed_through_sequence) {
        throw new Error("SESSION_EVENT_CURSOR_AHEAD");
      }
      const fellBehind = afterSequence !== null && afterSequence < stream.floor_sequence - 1;
      const startSequence = Math.max(afterSequence ?? stream.floor_sequence - 1, stream.floor_sequence - 1);
      const rows = this.#database.query(
        `SELECT event_json,event_bytes,projection_version FROM session_events
         WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
      ).all(sessionId, startSequence, limit);
      const events: SessionEvent[] = [];
      let pageBytes = 0;
      for (const row of rows) {
        const parsed = z.object({
          event_json: z.string(),
          event_bytes: z.number().int().positive().max(SESSION_EVENT_MAX_BYTES),
          projection_version: z.union([z.literal(1), z.literal(2)]),
        }).strict().parse(row);
        const next = parseStoredSessionEvent(
          parsed.event_json,
          parsed.projection_version,
          this.#publicProviderIdentifierProjector,
        );
        const nextBytes = utf8Bytes(JSON.stringify(next));
        if (events.length > 0 && pageBytes + nextBytes > SESSION_EVENT_PAGE_BYTES) break;
        if (next.sessionId !== sessionId || next.streamEpoch !== stream.stream_epoch) {
          throw new Error("SESSION_EVENT_STORED_AUTHORITY_MISMATCH");
        }
        events.push(next);
        pageBytes += nextBytes;
      }
      return {
        ...mapSessionEventStreamPosition(stream),
        gapReason: fellBehind ? stream.retention_gap_reason ?? "stream_restored" : null,
        events,
      };
    });
    return maintenanceNow !== undefined && !this.#readonly ? read.immediate() : read();
  }

  #requireInteractionRow(publicId: string): z.infer<typeof interactionRowSchema> {
    const row = this.#database.query("SELECT * FROM provider_interactions WHERE public_id=?").get(publicId);
    if (row === null) throw new SelectionError("NOT_FOUND");
    return interactionRowSchema.parse(row);
  }

  #recordInteractionTransition(row: z.infer<typeof interactionRowSchema>, now: number): void {
    this.#database.query(
      `INSERT INTO provider_interaction_transitions(
         public_id,revision,state,response_digest,recorded_at
       ) VALUES (?,?,?,?,?)`,
    ).run(row.public_id, row.revision, row.state, row.response_digest, now);
  }

  admitInteraction(input: {
    publicId: string;
    sessionId: SessionId | null;
    authority: ProviderInteractionAuthority;
    kind: InteractionKind;
    blocking: boolean;
    display: InteractionDisplay;
    timeoutMs?: number;
    requestedAt?: number;
    deadlineAt?: number;
  }): { record: InteractionRecord; replayed: boolean } {
    const publicId = z.string().uuid().parse(input.publicId);
    const sessionId = sessionIdSchema.nullable().parse(input.sessionId);
    const authority = providerInteractionAuthoritySchema.parse(input.authority);
    const kind = interactionKindSchema.parse(input.kind);
    const blocking = z.boolean().parse(input.blocking);
    const display = interactionDisplaySchema.parse(input.display);
    const timeoutMs = z.number().int().min(0).max(INTERACTION_MAX_PENDING_MS)
      .parse(input.timeoutMs ?? INTERACTION_MAX_PENDING_MS);
    if (display.kind !== kind) throw new Error("INTERACTION_DISPLAY_KIND_MISMATCH");
    const displayJson = JSON.stringify(display);
    if (new TextEncoder().encode(displayJson).byteLength > 65_536) {
      throw new Error("INTERACTION_DISPLAY_EXCEEDS_BOUND");
    }
    const now = unixMillisecondsSchema.parse(this.#now());
    const requestedAt = unixMillisecondsSchema.parse(input.requestedAt ?? now);
    const deadlineAt = unixMillisecondsSchema.parse(input.deadlineAt
      ?? Math.min(Number.MAX_SAFE_INTEGER, requestedAt + timeoutMs));
    if (requestedAt > now || deadlineAt < requestedAt) {
      throw new Error("INTERACTION_DEADLINE_AUTHORITY_INVALID");
    }
    let result: { record: InteractionRecord; replayed: boolean } | undefined;
    const admit = this.#database.transaction(() => {
      const profile = z.object({
        process_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        state: profileStateSchema,
      }).strict().parse(this.#database.query(
        "SELECT process_generation,state FROM profiles WHERE id=?",
      ).get(authority.profileId));
      if (profile.process_generation !== authority.processGeneration || profile.state === "removed") {
        throw new Error("INTERACTION_AUTHORITY_CHANGED");
      }
      if (sessionId !== null) {
        const owner = z.object({ profile_id: profileIdSchema }).strict().parse(
          this.#database.query("SELECT profile_id FROM sessions WHERE id=?").get(sessionId),
        );
        if (owner.profile_id !== authority.profileId) throw new Error("INTERACTION_SESSION_AUTHORITY_MISMATCH");
      }
      const existingByRequest = authority.requestId.type === "number"
        ? this.#database.query(
          `SELECT * FROM provider_interactions
           WHERE profile_id=? AND process_generation=? AND connection_id=?
             AND request_id_type='number' AND request_id_number=?`,
        ).get(authority.profileId, authority.processGeneration, authority.connectionId, authority.requestId.value)
        : this.#database.query(
          `SELECT * FROM provider_interactions
           WHERE profile_id=? AND process_generation=? AND connection_id=?
             AND request_id_type='string' AND request_id_text=?`,
        ).get(authority.profileId, authority.processGeneration, authority.connectionId, authority.requestId.value);
      if (existingByRequest !== null) {
        const existing = mapInteraction(existingByRequest);
        if (
          existing.sessionId !== sessionId
          || JSON.stringify(existing.authority) !== JSON.stringify(authority)
          || existing.kind !== kind
          || existing.blocking !== blocking
          || (input.requestedAt !== undefined && existing.requestedAt !== requestedAt)
          || (input.deadlineAt !== undefined && existing.deadlineAt !== deadlineAt)
        ) throw new Error("INTERACTION_REQUEST_REPLAY_CONFLICT");
        result = { record: existing, replayed: true };
        return;
      }
      if (this.#database.query("SELECT 1 FROM provider_interactions WHERE public_id=?").get(publicId) !== null) {
        throw new Error("INTERACTION_PUBLIC_ID_CONFLICT");
      }
      this.#database.query(
        `INSERT INTO provider_interactions(
           public_id,session_id,profile_id,process_generation,connection_id,
           request_id_type,request_id_number,request_id_text,method,request_digest,
           thread_id,turn_id,item_id,approval_id,kind,state,revision,blocking,
           display_json,response_digest,response_expected_revision,intended_terminal_state,
           requested_at,deadline_at,updated_at,terminal_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,?,?,NULL,NULL,NULL,?,?,?,NULL)`,
      ).run(
        publicId,
        sessionId,
        authority.profileId,
        authority.processGeneration,
        authority.connectionId,
        authority.requestId.type,
        authority.requestId.type === "number" ? authority.requestId.value : null,
        authority.requestId.type === "string" ? authority.requestId.value : null,
        authority.method,
        authority.requestDigest,
        authority.threadId,
        authority.turnId,
        authority.itemId,
        authority.approvalId,
        kind,
        blocking ? 1 : 0,
        displayJson,
        requestedAt,
        deadlineAt,
        now,
      );
      const inserted = this.#requireInteractionRow(publicId);
      this.#recordInteractionTransition(inserted, now);
      result = { record: mapInteraction(inserted), replayed: false };
    });
    admit.immediate();
    if (result === undefined) throw new Error("Interaction admission lost its durable result.");
    return result;
  }

  requireInteraction(publicId: string): InteractionRecord {
    return mapInteraction(this.#requireInteractionRow(z.string().uuid().parse(publicId)));
  }

  findInteractionByAuthority(authorityInput: ProviderInteractionAuthority): InteractionRecord | null {
    const authority = providerInteractionAuthoritySchema.parse(authorityInput);
    const row = authority.requestId.type === "number"
      ? this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE profile_id=? AND process_generation=? AND connection_id=?
           AND request_id_type='number' AND request_id_number=?`,
      ).get(
        authority.profileId,
        authority.processGeneration,
        authority.connectionId,
        authority.requestId.value,
      )
      : this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE profile_id=? AND process_generation=? AND connection_id=?
           AND request_id_type='string' AND request_id_text=?`,
      ).get(
        authority.profileId,
        authority.processGeneration,
        authority.connectionId,
        authority.requestId.value,
      );
    if (row === null) return null;
    const interaction = mapInteraction(row);
    if (JSON.stringify(interaction.authority) !== JSON.stringify(authority)) {
      throw new Error("INTERACTION_AUTHORITY_MISMATCH");
    }
    return interaction;
  }

  listInteractions(input: {
    sessionId?: SessionId;
    pendingOnly?: boolean;
    limit?: number;
  } = {}): readonly InteractionRecord[] {
    return this.listInteractionPage(input).interactions;
  }

  listInteractionPage(input: {
    sessionId?: SessionId;
    pendingOnly?: boolean;
    limit?: number;
    after?: InteractionListPosition;
  } = {}): InteractionListPage {
    const sessionId = input.sessionId === undefined ? undefined : sessionIdSchema.parse(input.sessionId);
    const pendingOnly = input.pendingOnly ?? false;
    const limit = z.number().int().min(1).max(200).parse(input.limit ?? 100);
    const after = input.after === undefined ? undefined : interactionListPositionSchema.parse(input.after);
    const predicates = [
      ...(sessionId === undefined ? [] : ["session_id=?"]),
      ...(pendingOnly ? ["state IN ('pending','response_prepared','response_written')"] : []),
      ...(after === undefined
        ? []
        : ["(requested_at<? OR (requested_at=? AND public_id>?))"]),
    ];
    const where = predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`;
    const parameters: Array<string | number> = [
      ...(sessionId === undefined ? [] : [sessionId]),
      ...(after === undefined ? [] : [after.requestedAt, after.requestedAt, after.publicId]),
      limit + 1,
    ];
    const records = this.#database.query(
      `SELECT * FROM provider_interactions${where}
       ORDER BY requested_at DESC,public_id ASC LIMIT ?`,
    ).all(...parameters).map(mapInteraction);
    const interactions = records.slice(0, limit);
    const last = interactions.at(-1);
    return {
      interactions,
      nextPosition: records.length > limit && last !== undefined
        ? { requestedAt: last.requestedAt, publicId: last.publicId }
        : null,
    };
  }

  listDueInteractions(input: { now?: number; limit?: number } = {}): readonly InteractionRecord[] {
    const now = unixMillisecondsSchema.parse(input.now ?? this.#now());
    const limit = z.number().int().min(1).max(128).parse(input.limit ?? 32);
    return this.#database.query(
      `SELECT * FROM provider_interactions
       WHERE state='pending' AND deadline_at<=?
       ORDER BY deadline_at,public_id LIMIT ?`,
    ).all(now, limit).map(mapInteraction);
  }

  nextInteractionDeadlineAt(): number | null {
    const row = z.object({ deadline_at: unixMillisecondsSchema }).strict().nullable().parse(
      this.#database.query(
        `SELECT deadline_at FROM provider_interactions
         WHERE state='pending' ORDER BY deadline_at,public_id LIMIT 1`,
      ).get(),
    );
    return row?.deadline_at ?? null;
  }

  prepareInteractionResponse(input: {
    id: string;
    expectedRevision: number;
    responseDigest: string;
    intendedTerminalState?: InteractionIntendedTerminalState;
  }): InteractionRecord {
    const id = z.string().uuid().parse(input.id);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const responseDigest = sha256Schema.parse(input.responseDigest);
    const intendedTerminalState = interactionIntendedTerminalStateSchema
      .parse(input.intendedTerminalState ?? "resolved");
    const now = unixMillisecondsSchema.parse(this.#now());
    const prepare = this.#database.transaction(() => {
      const current = this.#requireInteractionRow(id);
      const currentGeneration = z.object({
        process_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        state: profileStateSchema,
      }).strict().parse(this.#database.query(
        "SELECT process_generation,state FROM profiles WHERE id=?",
      ).get(current.profile_id));
      if (
        currentGeneration.process_generation !== current.process_generation
        || currentGeneration.state === "removed"
      ) throw new Error("INTERACTION_AUTHORITY_CHANGED");
      if (current.state !== "pending") {
        if (
          current.response_expected_revision === expectedRevision
          && current.response_digest === responseDigest
          && current.intended_terminal_state === intendedTerminalState
        ) return mapInteraction(current);
        if (current.response_expected_revision === expectedRevision) {
          throw new Error("INTERACTION_RESPONSE_CONFLICT");
        }
        throw new Error("INTERACTION_REVISION_CONFLICT");
      }
      if (current.revision !== expectedRevision) throw new Error("INTERACTION_REVISION_CONFLICT");
      const changed = this.#database.query(
        `UPDATE provider_interactions
         SET state='response_prepared',revision=revision+1,response_digest=?,
             response_expected_revision=?,intended_terminal_state=?,updated_at=MAX(updated_at,?)
         WHERE public_id=? AND revision=? AND state='pending' AND response_digest IS NULL`,
      ).run(responseDigest, expectedRevision, intendedTerminalState, now, id, expectedRevision);
      if (changed.changes !== 1) throw new Error("INTERACTION_REVISION_CONFLICT");
      const prepared = this.#requireInteractionRow(id);
      this.#recordInteractionTransition(prepared, now);
      return mapInteraction(prepared);
    });
    return prepare.immediate();
  }

  supersedePreparedInteractionResponseWithTimeout(input: {
    id: string;
    expectedRevision: number;
    manualResponseDigest: string;
    timeoutResponseDigest: string;
  }): InteractionRecord {
    const id = z.string().uuid().parse(input.id);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const manualResponseDigest = sha256Schema.parse(input.manualResponseDigest);
    const timeoutResponseDigest = sha256Schema.parse(input.timeoutResponseDigest);
    if (manualResponseDigest === timeoutResponseDigest) {
      throw new Error("INTERACTION_RESPONSE_CONFLICT");
    }
    const now = unixMillisecondsSchema.parse(this.#now());
    const supersede = this.#database.transaction(() => {
      const preparedTransition = z.object({
        state: interactionStateSchema,
        response_digest: sha256Schema.nullable(),
      }).strict().nullable().parse(this.#database.query(
        `SELECT state,response_digest FROM provider_interaction_transitions
         WHERE public_id=? AND revision=?`,
      ).get(id, expectedRevision));
      if (
        preparedTransition === null
        || preparedTransition.state !== "response_prepared"
        || preparedTransition.response_digest !== manualResponseDigest
      ) throw new Error("INTERACTION_RESPONSE_CONFLICT");

      const current = this.#requireInteractionRow(id);
      if (
        current.state === "response_prepared"
        && current.revision === expectedRevision + 1
        && current.response_digest === timeoutResponseDigest
        && current.intended_terminal_state === "expired"
      ) return mapInteraction(current);
      if (now < current.deadline_at) throw new Error("INTERACTION_DEADLINE_NOT_ELAPSED");
      if (current.revision !== expectedRevision) throw new Error("INTERACTION_REVISION_CONFLICT");
      if (current.state !== "response_prepared") throw new Error("INTERACTION_STATE_CONFLICT");
      if (
        current.response_digest !== manualResponseDigest
        || current.intended_terminal_state === null
        || current.intended_terminal_state === "expired"
      ) throw new Error("INTERACTION_RESPONSE_CONFLICT");
      const changed = this.#database.query(
        `UPDATE provider_interactions
         SET revision=revision+1,response_digest=?,intended_terminal_state='expired',
             updated_at=MAX(updated_at,?)
         WHERE public_id=? AND revision=? AND state='response_prepared'
           AND response_digest=? AND intended_terminal_state IN ('resolved','declined','canceled')
           AND terminal_at IS NULL AND deadline_at<=?`,
      ).run(
        timeoutResponseDigest,
        now,
        id,
        expectedRevision,
        manualResponseDigest,
        now,
      );
      if (changed.changes !== 1) throw new Error("INTERACTION_REVISION_CONFLICT");
      const replaced = this.#requireInteractionRow(id);
      this.#recordInteractionTransition(replaced, now);
      return mapInteraction(replaced);
    });
    return supersede.immediate();
  }

  markInteractionResponseWritten(input: {
    id: string;
    expectedRevision: number;
    responseDigest: string;
  }): InteractionRecord {
    const id = z.string().uuid().parse(input.id);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const responseDigest = sha256Schema.parse(input.responseDigest);
    const now = unixMillisecondsSchema.parse(this.#now());
    const mark = this.#database.transaction(() => {
      const current = this.#requireInteractionRow(id);
      if (current.response_digest !== responseDigest) throw new Error("INTERACTION_RESPONSE_CONFLICT");
      if (
        current.state === "response_written"
        && current.revision === expectedRevision + 1
      ) return mapInteraction(current);
      if (current.state !== "response_prepared" || current.revision !== expectedRevision) {
        if (
          current.terminal_at !== null
          && current.response_expected_revision !== null
          && expectedRevision === current.response_expected_revision + 1
        ) return mapInteraction(current);
        throw new Error("INTERACTION_REVISION_CONFLICT");
      }
      const changed = this.#database.query(
        `UPDATE provider_interactions
         SET state='response_written',revision=revision+1,updated_at=MAX(updated_at,?)
         WHERE public_id=? AND revision=? AND state='response_prepared' AND response_digest=?`,
      ).run(now, id, expectedRevision, responseDigest);
      if (changed.changes !== 1) throw new Error("INTERACTION_REVISION_CONFLICT");
      const written = this.#requireInteractionRow(id);
      this.#recordInteractionTransition(written, now);
      return mapInteraction(written);
    });
    return mark.immediate();
  }

  settleInteraction(input: {
    id: string;
    expectedRevision: number;
    state: InteractionIntendedTerminalState;
    authority: ProviderInteractionAuthority;
    responseDigest?: string;
  }): InteractionRecord {
    const id = z.string().uuid().parse(input.id);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const state = interactionIntendedTerminalStateSchema.parse(input.state);
    const authority = providerInteractionAuthoritySchema.parse(input.authority);
    const responseDigest = input.responseDigest === undefined ? undefined : sha256Schema.parse(input.responseDigest);
    const now = unixMillisecondsSchema.parse(this.#now());
    const settle = this.#database.transaction(() => {
      const current = this.#requireInteractionRow(id);
      const stored = mapInteraction(current);
      if (JSON.stringify(stored.authority) !== JSON.stringify(authority)) {
        throw new Error("INTERACTION_AUTHORITY_MISMATCH");
      }
      const generation = z.object({
        process_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        state: profileStateSchema,
      }).strict().parse(this.#database.query(
        "SELECT process_generation,state FROM profiles WHERE id=?",
      ).get(current.profile_id));
      if (generation.process_generation !== current.process_generation || generation.state === "removed") {
        throw new Error("INTERACTION_AUTHORITY_CHANGED");
      }
      if (responseDigest !== undefined && current.response_digest !== responseDigest) {
        throw new Error("INTERACTION_RESPONSE_CONFLICT");
      }
      if (
        current.intended_terminal_state !== null
        && current.intended_terminal_state !== state
      ) throw new Error("INTERACTION_TERMINAL_INTENT_CONFLICT");
      if (current.state === state && current.revision === expectedRevision + 1) return mapInteraction(current);
      if (current.revision !== expectedRevision) throw new Error("INTERACTION_REVISION_CONFLICT");
      if (!["pending", "response_prepared", "response_written"].includes(current.state)) {
        throw new Error("INTERACTION_STATE_CONFLICT");
      }
      if (state === "declined" && current.response_digest === null) {
        throw new Error("INTERACTION_RESPONSE_NOT_PREPARED");
      }
      const changed = this.#database.query(
        `UPDATE provider_interactions
         SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
         WHERE public_id=? AND revision=? AND state IN ('pending','response_prepared','response_written')`,
      ).run(state, now, now, id, expectedRevision);
      if (changed.changes !== 1) throw new Error("INTERACTION_REVISION_CONFLICT");
      const terminal = this.#requireInteractionRow(id);
      this.#recordInteractionTransition(terminal, now);
      return mapInteraction(terminal);
    });
    return settle.immediate();
  }

  expireInteraction(input: { id: string; expectedRevision: number }): InteractionRecord {
    return this.#terminalizeInteraction({ ...input, state: "expired" });
  }

  markInteractionResolutionUnknown(input: {
    id: string;
    expectedRevision: number;
    responseDigest?: string;
  }): InteractionRecord {
    return this.#terminalizeInteraction({ ...input, state: "resolution_unknown" });
  }

  /**
   * Atomically retires a provider generation after an interaction write crosses
   * an uncertain local persistence boundary. The profile-wide settlement is
   * intentional: advancing the generation leaves no publicly pending callback
   * carrying the now-stale authority.
   */
  quarantineInteractionPersistenceBoundary(input: {
    profileId: ProfileId;
    processGeneration: number;
    connectionId: string;
    focalInteractionId: string;
    effect: InteractionPersistenceBoundaryEffect;
    responseDigest?: string;
  }): InteractionPersistenceBoundaryQuarantine {
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1).parse(input.processGeneration);
    const connectionId = z.string().uuid().parse(input.connectionId);
    const focalInteractionId = z.string().uuid().parse(input.focalInteractionId);
    const effect = z.enum(["known_unsent", "possibly_sent"]).parse(input.effect);
    const responseDigest = input.responseDigest === undefined
      ? undefined
      : sha256Schema.parse(input.responseDigest);
    const now = unixMillisecondsSchema.parse(this.#now());
    const quarantine = this.#database.transaction((): InteractionPersistenceBoundaryQuarantine => {
      const currentProfile = mapProfile(this.#database.query(
        "SELECT * FROM profiles WHERE id=? AND state!='removed'",
      ).get(profileId));
      if (currentProfile.processGeneration !== processGeneration) {
        throw new Error("INTERACTION_QUARANTINE_PROFILE_AUTHORITY_CHANGED");
      }

      const focal = this.#requireInteractionRow(focalInteractionId);
      if (
        focal.profile_id !== profileId
        || focal.process_generation !== processGeneration
        || focal.connection_id !== connectionId
      ) throw new Error("INTERACTION_QUARANTINE_FOCAL_AUTHORITY_MISMATCH");
      if (responseDigest !== undefined && focal.response_digest !== responseDigest) {
        throw new Error("INTERACTION_QUARANTINE_RESPONSE_CONFLICT");
      }
      if (
        effect === "known_unsent"
        && focal.state === "response_written"
      ) throw new Error("INTERACTION_QUARANTINE_EFFECT_MISMATCH");
      const openRows = this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE profile_id=? AND process_generation=?
           AND state IN ('pending','response_prepared','response_written')
         ORDER BY CASE WHEN public_id=? THEN 0 ELSE 1 END,requested_at,public_id`,
      ).all(profileId, processGeneration, focalInteractionId);
      const terminalInteractions: InteractionRecord[] = [];
      for (const value of openRows) {
        const current = interactionRowSchema.parse(value);
        const terminalState = current.public_id === focalInteractionId
          ? effect === "known_unsent" ? "expired" : "resolution_unknown"
          : current.state === "pending" ? "expired" : "resolution_unknown";
        const changed = this.#database.query(
          `UPDATE provider_interactions
           SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
           WHERE public_id=? AND revision=? AND state=?`,
        ).run(
          terminalState,
          now,
          now,
          current.public_id,
          current.revision,
          current.state,
        );
        if (changed.changes !== 1) throw new Error("INTERACTION_QUARANTINE_TRANSITION_CONFLICT");
        const terminal = this.#requireInteractionRow(current.public_id);
        this.#recordInteractionTransition(terminal, now);
        const interaction = mapInteraction(terminal);
        this.#ensureInteractionStateEventInTransaction(interaction, now);
        terminalInteractions.push(interaction);
      }

      const focalInteraction = terminalInteractions.find(
        (interaction) => interaction.publicId === focalInteractionId,
      ) ?? mapInteraction(focal);
      if (focalInteraction.terminalAt === null) {
        throw new Error("INTERACTION_QUARANTINE_FOCAL_NOT_TERMINAL");
      }
      this.#ensureInteractionStateEventInTransaction(focalInteraction, now);

      const advanced = this.#database.query(
        `UPDATE profiles SET process_generation=process_generation+1,updated_at=MAX(updated_at,?)
         WHERE id=? AND process_generation=? AND state!='removed'`,
      ).run(now, profileId, processGeneration);
      if (advanced.changes !== 1) {
        throw new Error("INTERACTION_QUARANTINE_PROFILE_AUTHORITY_CHANGED");
      }
      const profile = mapProfile(this.#database.query(
        "SELECT * FROM profiles WHERE id=? AND state!='removed'",
      ).get(profileId));
      return {
        focalInteraction,
        profile,
        terminalInteractions: terminalInteractions.some(
          (interaction) => interaction.publicId === focalInteractionId,
        )
          ? terminalInteractions
          : [focalInteraction, ...terminalInteractions],
      };
    });
    return quarantine.immediate();
  }

  #terminalizeInteraction(input: {
    id: string;
    expectedRevision: number;
    state: "expired" | "resolution_unknown";
    responseDigest?: string;
  }): InteractionRecord {
    const id = z.string().uuid().parse(input.id);
    const expectedRevision = z.number().int().positive().parse(input.expectedRevision);
    const responseDigest = input.responseDigest === undefined ? undefined : sha256Schema.parse(input.responseDigest);
    const now = unixMillisecondsSchema.parse(this.#now());
    const terminalize = this.#database.transaction(() => {
      const current = this.#requireInteractionRow(id);
      if (responseDigest !== undefined && current.response_digest !== responseDigest) {
        throw new Error("INTERACTION_RESPONSE_CONFLICT");
      }
      if (current.state === input.state && current.revision === expectedRevision + 1) return mapInteraction(current);
      if (current.revision !== expectedRevision) throw new Error("INTERACTION_REVISION_CONFLICT");
      if (!["pending", "response_prepared", "response_written"].includes(current.state)) {
        throw new Error("INTERACTION_STATE_CONFLICT");
      }
      const changed = this.#database.query(
        `UPDATE provider_interactions
         SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
         WHERE public_id=? AND revision=? AND state IN ('pending','response_prepared','response_written')`,
      ).run(input.state, now, now, id, expectedRevision);
      if (changed.changes !== 1) throw new Error("INTERACTION_REVISION_CONFLICT");
      const terminal = this.#requireInteractionRow(id);
      this.#recordInteractionTransition(terminal, now);
      return mapInteraction(terminal);
    });
    return terminalize.immediate();
  }

  markGenerationInteractionsUnknown(input: {
    profileId: ProfileId;
    processGeneration: number;
    connectionId?: string;
  }): readonly InteractionRecord[] {
    return this.#terminalizeGenerationInteractions(input, true);
  }

  expireGenerationInteractions(input: {
    profileId: ProfileId;
    processGeneration: number;
    connectionId?: string;
  }): readonly InteractionRecord[] {
    return this.#terminalizeGenerationInteractions(input, false);
  }

  expireTurnInteractions(input: {
    sessionId: SessionId;
    profileId: ProfileId;
    processGeneration: number;
    turnId: string;
  }): readonly InteractionRecord[] {
    const sessionId = sessionIdSchema.parse(input.sessionId);
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      .parse(input.processGeneration);
    const turnId = z.string().min(1).max(512).parse(input.turnId);
    const now = unixMillisecondsSchema.parse(this.#now());
    const terminalize = this.#database.transaction(() => {
      const rows = this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE session_id=? AND profile_id=? AND process_generation=? AND turn_id=?
           AND state IN ('pending','response_prepared','response_written')
         ORDER BY requested_at,public_id`,
      ).all(sessionId, profileId, processGeneration, turnId);
      const records: InteractionRecord[] = [];
      for (const value of rows) {
        const current = interactionRowSchema.parse(value);
        const state = current.state === "pending" ? "expired" : "resolution_unknown";
        const changed = this.#database.query(
          `UPDATE provider_interactions
           SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
           WHERE public_id=? AND revision=? AND state=?`,
        ).run(state, now, now, current.public_id, current.revision, current.state);
        if (changed.changes !== 1) throw new Error("INTERACTION_TURN_RECOVERY_CONFLICT");
        const terminal = this.#requireInteractionRow(current.public_id);
        this.#recordInteractionTransition(terminal, now);
        records.push(mapInteraction(terminal));
      }
      return records;
    });
    return terminalize.immediate();
  }

  #terminalizeGenerationInteractions(
    input: { profileId: ProfileId; processGeneration: number; connectionId?: string },
    allUnknown: boolean,
  ): readonly InteractionRecord[] {
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.processGeneration);
    const connectionId = input.connectionId === undefined ? undefined : z.string().uuid().parse(input.connectionId);
    const now = unixMillisecondsSchema.parse(this.#now());
    const terminalize = this.#database.transaction(() => {
      const rows = this.#database.query(
        `SELECT * FROM provider_interactions
         WHERE profile_id=? AND process_generation=?
           ${connectionId === undefined ? "" : "AND connection_id=?"}
           AND state IN ('pending','response_prepared','response_written')
         ORDER BY requested_at,public_id`,
      ).all(...(connectionId === undefined
        ? [profileId, processGeneration]
        : [profileId, processGeneration, connectionId]));
      const records: InteractionRecord[] = [];
      for (const value of rows) {
        const current = interactionRowSchema.parse(value);
        const state = allUnknown || current.state !== "pending" ? "resolution_unknown" : "expired";
        const changed = this.#database.query(
          `UPDATE provider_interactions
           SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
           WHERE public_id=? AND revision=? AND state=?`,
        ).run(state, now, now, current.public_id, current.revision, current.state);
        if (changed.changes !== 1) throw new Error("INTERACTION_GENERATION_RECOVERY_CONFLICT");
        const terminal = this.#requireInteractionRow(current.public_id);
        this.#recordInteractionTransition(terminal, now);
        records.push(mapInteraction(terminal));
      }
      return records;
    });
    return terminalize.immediate();
  }

  requireAccountRateLimitResetPolicy(
    profileId: ProfileId,
  ): AccountRateLimitResetPolicyRecord {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const row = this.#database.query(
      "SELECT * FROM account_rate_limit_reset_policies WHERE profile_id=?",
    ).get(parsedProfileId);
    if (row === null) throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
    try {
      return mapAccountRateLimitResetPolicy(row);
    } catch (error: unknown) {
      throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_INVALID", { cause: error });
    }
  }

  authorizeAccountRateLimitResetPolicy(input: {
    profileId: ProfileId;
    processGeneration: number;
    accountFingerprint: string;
    weeklyWindowDurationMinutes: number | null;
    weeklyWindowResetsAt: number | null;
  }): AccountRateLimitResetPolicyDecision {
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
      .parse(input.processGeneration);
    const accountFingerprint = sha256Schema.parse(input.accountFingerprint);
    const weeklyWindowDurationMinutes = input.weeklyWindowDurationMinutes === null
      ? null
      : z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
        .parse(input.weeklyWindowDurationMinutes);
    const weeklyWindowResetsAt = input.weeklyWindowResetsAt === null
      ? null
      : unixMillisecondsSchema.parse(input.weeklyWindowResetsAt);
    const authorize = this.#database.transaction((): AccountRateLimitResetPolicyDecision => {
      const authority = z.object({
        process_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        state: z.literal("signed_in"),
        provider_email: z.string().email(),
      }).strict().parse(this.#database.query(
        "SELECT process_generation,state,provider_email FROM profiles WHERE id=?",
      ).get(profileId));
      if (
        authority.process_generation !== processGeneration
        || canonicalAccountFingerprint(authority.provider_email) !== accountFingerprint
      ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_AUTHORITY_CHANGED");

      let policy = this.requireAccountRateLimitResetPolicy(profileId);
      const transition = (input: {
        state: AccountRateLimitResetPolicyRecord["state"];
        accountFingerprint: string | null;
        weeklyWindowResetsAt: number | null;
      }): AccountRateLimitResetPolicyRecord => {
        const changed = this.#database.query(
          `UPDATE account_rate_limit_reset_policies
           SET state=?,account_fingerprint=?,weekly_window_resets_at=?,
             revision=revision+1,updated_at=MAX(updated_at,?)
           WHERE profile_id=? AND revision=?`,
        ).run(
          input.state,
          input.accountFingerprint,
          input.weeklyWindowResetsAt,
          unixMillisecondsSchema.parse(this.#now()),
          profileId,
          policy.revision,
        );
        if (changed.changes !== 1) {
          throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_CONFLICT");
        }
        return this.requireAccountRateLimitResetPolicy(profileId);
      };

      const now = unixMillisecondsSchema.parse(this.#now());
      const weeklyWindowMaximum = Math.min(
        Number.MAX_SAFE_INTEGER,
        now + CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES * 60_000,
      );
      const hasFreshExactWeeklyWindow = weeklyWindowDurationMinutes
        === CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES
        && weeklyWindowResetsAt !== null
        && weeklyWindowResetsAt > now
        && weeklyWindowResetsAt <= weeklyWindowMaximum;
      if (
        policy.accountFingerprint !== null
        && policy.accountFingerprint !== accountFingerprint
      ) {
        this.#closeRecoverableAccountRateLimitResetIdentityAttempts({
          profileId,
          accountFingerprint: policy.accountFingerprint,
          selection: "matching",
          now,
        });
        policy = transition({
          state: "reconciliation_required",
          accountFingerprint: null,
          weeklyWindowResetsAt: null,
        });
        return { decision: "block", reason: "account_identity_changed", policy };
      }

      if (!hasFreshExactWeeklyWindow) {
        return {
          decision: "block",
          reason: "weekly_window_unavailable",
          policy,
        };
      }

      switch (policy.state) {
        case "active_unbound": {
          policy = transition({
            state: "active_bound",
            accountFingerprint,
            weeklyWindowResetsAt,
          });
          return { decision: "allow", reason: "active", policy };
        }
        case "reconciliation_required": {
          policy = transition({
            state: "window_suppressed",
            accountFingerprint,
            weeklyWindowResetsAt,
          });
          this.#closeRecoverableAccountRateLimitResetIdentityAttempts({
            profileId,
            accountFingerprint,
            selection: "different",
            now,
          });
          return {
            decision: "suppress",
            reason: "reconciliation_window",
            policy,
          };
        }
        case "window_suppressed": {
          if (policy.weeklyWindowResetsAt === null) {
            throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_INVALID");
          }
          if (weeklyWindowResetsAt < policy.weeklyWindowResetsAt) {
            return {
              decision: "block",
              reason: "weekly_window_nonmonotonic",
              policy,
            };
          }
          if (weeklyWindowResetsAt === policy.weeklyWindowResetsAt) {
            return {
              decision: "suppress",
              reason: "reconciliation_window",
              policy,
            };
          }
          if (now < policy.weeklyWindowResetsAt) {
            return {
              decision: "block",
              reason: "weekly_window_nonmonotonic",
              policy,
            };
          }
          policy = transition({
            state: "active_bound",
            accountFingerprint,
            weeklyWindowResetsAt,
          });
          return { decision: "allow", reason: "active", policy };
        }
        case "active_bound": {
          if (policy.weeklyWindowResetsAt === null) {
            throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_INVALID");
          }
          if (weeklyWindowResetsAt < policy.weeklyWindowResetsAt) {
            return {
              decision: "block",
              reason: "weekly_window_nonmonotonic",
              policy,
            };
          }
          if (weeklyWindowResetsAt > policy.weeklyWindowResetsAt) {
            policy = transition({
              state: "active_bound",
              accountFingerprint,
              weeklyWindowResetsAt,
            });
          }
          return { decision: "allow", reason: "active", policy };
        }
      }
    });
    return authorize.immediate();
  }

  prepareAccountRateLimitReset(input: {
    profileId: ProfileId;
    processGeneration: number;
    accountFingerprint: string;
    weeklyWindowResetsAt: number;
    observedUsedPercent: number;
  }): AccountRateLimitResetAttemptRecord {
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
      .parse(input.processGeneration);
    const accountFingerprint = sha256Schema.parse(input.accountFingerprint);
    const weeklyWindowResetsAt = unixMillisecondsSchema.parse(input.weeklyWindowResetsAt);
    const observedUsedPercent = z.number().finite().min(99).max(100)
      .parse(input.observedUsedPercent);
    const prepare = this.#database.transaction(() => {
      const authority = z.object({
        process_generation: z.number().int().positive(),
        state: z.literal("signed_in"),
        provider_email: z.string().email(),
      }).strict().parse(this.#database.query(
        "SELECT process_generation,state,provider_email FROM profiles WHERE id=?",
      ).get(profileId));
      if (
        authority.process_generation !== processGeneration
        || canonicalAccountFingerprint(authority.provider_email) !== accountFingerprint
      ) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_AUTHORITY_CHANGED");
      }
      const policy = this.requireAccountRateLimitResetPolicy(profileId);
      if (
        policy.state !== "active_bound"
        || policy.accountFingerprint !== accountFingerprint
        || policy.weeklyWindowResetsAt !== weeklyWindowResetsAt
      ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
      const recoverable = this.#database.query(
        `SELECT * FROM account_rate_limit_reset_attempts
         WHERE profile_id=? AND account_fingerprint=?
           AND state IN ('prepared','effect_started','ambiguous','retryable')
         ORDER BY attempt_sequence LIMIT 2`,
      ).all(profileId, accountFingerprint).map(mapAccountRateLimitResetAttempt);
      if (recoverable.length > 1) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_ATTEMPT_AMBIGUOUS");
      }
      const pending = recoverable[0];
      if (pending !== undefined) {
        if (pending.weeklyWindowResetsAt === weeklyWindowResetsAt) return pending;
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_ATTEMPT_UNRESOLVED");
      }
      const rows = this.#database.query(
        `SELECT * FROM account_rate_limit_reset_attempts
         WHERE profile_id=? AND account_fingerprint=? AND weekly_window_resets_at=?
         ORDER BY attempt_sequence DESC`,
      ).all(profileId, accountFingerprint, weeklyWindowResetsAt)
        .map(mapAccountRateLimitResetAttempt);
      const successful = rows.find((row) =>
        row.outcome === "reset" || row.outcome === "alreadyRedeemed");
      if (successful !== undefined) return successful;
      const closed = rows.find((row) => row.state === "closed");
      if (closed !== undefined) return closed;
      const latestNothingToReset = rows.find((row) => row.outcome === "nothingToReset");
      if (
        latestNothingToReset !== undefined
        && Math.floor(observedUsedPercent)
          <= Math.floor(latestNothingToReset.observedUsedPercent)
      ) return latestNothingToReset;
      const noCreditAtCurrentWholePercent = rows.filter((row) =>
        row.outcome === "noCredit"
        && Math.floor(row.observedUsedPercent) === Math.floor(observedUsedPercent));
      if (noCreditAtCurrentWholePercent.length >= 2) {
        return noCreditAtCurrentWholePercent[0] as AccountRateLimitResetAttemptRecord;
      }

      const now = unixMillisecondsSchema.parse(this.#now());
      const idempotencyKey = randomUUID();
      this.#database.query(
        `INSERT INTO account_rate_limit_reset_attempts(
           idempotency_key,profile_id,origin_process_generation,
           current_process_generation,account_fingerprint,weekly_window_resets_at,
           observed_used_percent,state,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,'prepared',?,?)`,
      ).run(
        idempotencyKey,
        profileId,
        processGeneration,
        processGeneration,
        accountFingerprint,
        weeklyWindowResetsAt,
        observedUsedPercent,
        now,
        now,
      );
      // A live provider window can still rely on every terminal row as a
      // success or retry latch. Bound only expired history; unresolved recovery
      // evidence and every still-live window remain untouched.
      this.#database.query(
        `DELETE FROM account_rate_limit_reset_attempts
         WHERE profile_id=? AND state IN ('settled','closed')
           AND weekly_window_resets_at<=?
           AND idempotency_key NOT IN (
           SELECT idempotency_key FROM account_rate_limit_reset_attempts
           WHERE profile_id=? AND state IN ('settled','closed')
             AND weekly_window_resets_at<=?
           ORDER BY attempt_sequence DESC LIMIT 128
         )`,
      ).run(profileId, now, profileId, now);
      return mapAccountRateLimitResetAttempt(this.#database.query(
        "SELECT * FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(idempotencyKey));
    });
    return prepare.immediate();
  }

  readRecoverableAccountRateLimitReset(
    profileId: ProfileId,
    accountFingerprint: string,
  ): AccountRateLimitResetAttemptRecord | null {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedFingerprint = sha256Schema.parse(accountFingerprint);
    const rows = this.#database.query(
      `SELECT * FROM account_rate_limit_reset_attempts
       WHERE profile_id=? AND account_fingerprint=?
         AND state IN ('prepared','effect_started','ambiguous','retryable')
       ORDER BY attempt_sequence LIMIT 2`,
    ).all(parsedProfileId, parsedFingerprint).map(mapAccountRateLimitResetAttempt);
    if (rows.length > 1) throw new Error("ACCOUNT_RATE_LIMIT_RESET_ATTEMPT_AMBIGUOUS");
    return rows[0] ?? null;
  }

  latestAccountRateLimitResetAttempt(
    profileId: ProfileId,
    accountFingerprint: string,
  ): AccountRateLimitResetAttemptRecord | null {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedFingerprint = sha256Schema.parse(accountFingerprint);
    const row = this.#database.query(
      `SELECT * FROM account_rate_limit_reset_attempts
       WHERE profile_id=? AND account_fingerprint=?
       ORDER BY attempt_sequence DESC LIMIT 1`,
    ).get(parsedProfileId, parsedFingerprint);
    return row === null ? null : mapAccountRateLimitResetAttempt(row);
  }

  rebindAccountRateLimitReset(input: {
    idempotencyKey: string;
    expectedCurrentProcessGeneration: number;
    nextProcessGeneration: number;
    accountFingerprint: string;
  }): AccountRateLimitResetAttemptRecord {
    const idempotencyKey = z.string().uuid().parse(input.idempotencyKey);
    const expectedCurrentProcessGeneration = z.number().int().positive()
      .max(Number.MAX_SAFE_INTEGER).parse(input.expectedCurrentProcessGeneration);
    const nextProcessGeneration = z.number().int().positive()
      .max(Number.MAX_SAFE_INTEGER).parse(input.nextProcessGeneration);
    const accountFingerprint = sha256Schema.parse(input.accountFingerprint);
    const rebind = this.#database.transaction(() => {
      const row = mapAccountRateLimitResetAttempt(this.#database.query(
        "SELECT * FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(idempotencyKey));
      if (
        row.accountFingerprint !== accountFingerprint
        || row.currentProcessGeneration !== expectedCurrentProcessGeneration
      ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_REBIND_AUTHORITY_CHANGED");
      if (!["prepared", "ambiguous", "retryable"].includes(row.state)) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_REBIND_STATE_INVALID");
      }
      const policy = this.requireAccountRateLimitResetPolicy(row.profileId);
      const policyWindowAuthorizesAttempt = policy.weeklyWindowResetsAt !== null
        && (row.state === "ambiguous"
          ? policy.weeklyWindowResetsAt >= row.weeklyWindowResetsAt
          : policy.weeklyWindowResetsAt === row.weeklyWindowResetsAt);
      if (
        policy.state !== "active_bound"
        || policy.accountFingerprint !== row.accountFingerprint
        || !policyWindowAuthorizesAttempt
      ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
      const authority = z.object({
        process_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        provider_email: z.string().email(),
        state: z.literal("signed_in"),
      }).strict().parse(this.#database.query(
        "SELECT process_generation,provider_email,state FROM profiles WHERE id=?",
      ).get(row.profileId));
      if (
        authority.process_generation !== nextProcessGeneration
        || canonicalAccountFingerprint(authority.provider_email) !== accountFingerprint
      ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_REBIND_IDENTITY_MISMATCH");
      if (row.currentProcessGeneration === nextProcessGeneration) return row;
      if (nextProcessGeneration < row.currentProcessGeneration) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_REBIND_GENERATION_REGRESSION");
      }
      const now = unixMillisecondsSchema.parse(this.#now());
      this.#database.query(
        `INSERT INTO account_rate_limit_reset_rebinds(
           idempotency_key,from_process_generation,to_process_generation,
           account_fingerprint,created_at
         ) VALUES (?,?,?,?,?)`,
      ).run(
        idempotencyKey,
        row.currentProcessGeneration,
        nextProcessGeneration,
        accountFingerprint,
        now,
      );
      const changed = this.#database.query(
        `UPDATE account_rate_limit_reset_attempts
         SET current_process_generation=?,updated_at=MAX(updated_at,?)
         WHERE idempotency_key=? AND current_process_generation=?`,
      ).run(
        nextProcessGeneration,
        now,
        idempotencyKey,
        row.currentProcessGeneration,
      );
      if (changed.changes !== 1) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_REBIND_CONFLICT");
      }
      return mapAccountRateLimitResetAttempt(this.#database.query(
        "SELECT * FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(idempotencyKey));
    });
    return rebind.immediate();
  }

  closeAccountRateLimitReset(
    idempotencyKey: string,
    localResolution: z.infer<typeof accountRateLimitResetLocalResolutionSchema>,
  ): AccountRateLimitResetAttemptRecord {
    const key = z.string().uuid().parse(idempotencyKey);
    const resolution = accountRateLimitResetLocalResolutionSchema.parse(localResolution);
    const close = this.#database.transaction(() => {
      const row = mapAccountRateLimitResetAttempt(this.#database.query(
        "SELECT * FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(key));
      if (row.state === "closed" && row.localResolution === resolution) return row;
      if (!["prepared", "ambiguous", "retryable"].includes(row.state)) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_CLOSE_STATE_INVALID");
      }
      if (row.state === "ambiguous" && resolution !== "account_identity_changed") {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_CLOSE_RESOLUTION_INVALID");
      }
      const changed = this.#database.query(
        `UPDATE account_rate_limit_reset_attempts
         SET state='closed',local_resolution=?,updated_at=MAX(updated_at,?)
         WHERE idempotency_key=? AND state=?`,
      ).run(resolution, unixMillisecondsSchema.parse(this.#now()), key, row.state);
      if (changed.changes !== 1) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_CLOSE_CONFLICT");
      }
      return mapAccountRateLimitResetAttempt(this.#database.query(
        "SELECT * FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(key));
    });
    return close.immediate();
  }

  listAccountRateLimitResetRebinds(
    idempotencyKey: string,
  ): readonly AccountRateLimitResetRebindRecord[] {
    const key = z.string().uuid().parse(idempotencyKey);
    return this.#database.query(
      `SELECT * FROM account_rate_limit_reset_rebinds
       WHERE idempotency_key=? ORDER BY sequence`,
    ).all(key).map(mapAccountRateLimitResetRebind);
  }

  beginAccountRateLimitReset(
    idempotencyKey: string,
  ): AccountRateLimitResetAttemptRecord {
    const key = z.string().uuid().parse(idempotencyKey);
    const begin = this.#database.transaction(() => {
      const row = mapAccountRateLimitResetAttempt(this.#database.query(
        `SELECT r.* FROM account_rate_limit_reset_attempts r
         JOIN profiles p ON p.id=r.profile_id
         JOIN account_rate_limit_reset_policies policy ON policy.profile_id=r.profile_id
         WHERE r.idempotency_key=? AND p.state='signed_in'
           AND p.process_generation=r.current_process_generation
           AND lower(trim(p.provider_email)) IS NOT NULL`,
      ).get(key));
      if (row.state === "effect_started") {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_EFFECT_ALREADY_STARTED");
      }
      if (!["prepared", "ambiguous", "retryable"].includes(row.state)) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_BEGIN_STATE_INVALID");
      }
      const policy = this.requireAccountRateLimitResetPolicy(row.profileId);
      const policyWindowAuthorizesAttempt = policy.weeklyWindowResetsAt !== null
        && (row.state === "ambiguous"
          ? policy.weeklyWindowResetsAt >= row.weeklyWindowResetsAt
          : policy.weeklyWindowResetsAt === row.weeklyWindowResetsAt);
      if (
        policy.state !== "active_bound"
        || policy.accountFingerprint !== row.accountFingerprint
        || !policyWindowAuthorizesAttempt
      ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
      const now = unixMillisecondsSchema.parse(this.#now());
      const authorizedWindowResetsAt = row.state === "ambiguous"
        ? policy.weeklyWindowResetsAt
        : row.weeklyWindowResetsAt;
      const weeklyWindowMaximum = Math.min(
        Number.MAX_SAFE_INTEGER,
        now + CODEX_WEEKLY_RATE_LIMIT_WINDOW_MINUTES * 60_000,
      );
      if (
        authorizedWindowResetsAt <= now
        || authorizedWindowResetsAt > weeklyWindowMaximum
      ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_WINDOW_NOT_FRESH");
      const identity = z.object({ provider_email: z.string().email() }).strict().parse(
        this.#database.query(
          `SELECT p.provider_email FROM account_rate_limit_reset_attempts r
           JOIN profiles p ON p.id=r.profile_id WHERE r.idempotency_key=?`,
        ).get(key),
      );
      if (canonicalAccountFingerprint(identity.provider_email) !== row.accountFingerprint) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_AUTHORITY_CHANGED");
      }
      const changed = this.#database.query(
        `UPDATE account_rate_limit_reset_attempts
         SET state='effect_started',updated_at=MAX(updated_at,?)
         WHERE idempotency_key=? AND state=?`,
      ).run(now, key, row.state);
      if (changed.changes !== 1) {
        throw new Error("ACCOUNT_RATE_LIMIT_RESET_AUTHORITY_CHANGED");
      }
      return mapAccountRateLimitResetAttempt(this.#database.query(
        "SELECT * FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(key));
    });
    return begin.immediate();
  }

  deferAccountRateLimitReset(
    idempotencyKey: string,
    state: "ambiguous" | "retryable",
  ): AccountRateLimitResetAttemptRecord {
    const key = z.string().uuid().parse(idempotencyKey);
    const parsedState = accountRateLimitResetAttemptStateSchema
      .extract(["ambiguous", "retryable"]).parse(state);
    const changed = this.#database.query(
      `UPDATE account_rate_limit_reset_attempts SET state=?,updated_at=MAX(updated_at,?)
       WHERE idempotency_key=? AND state='effect_started'`,
    ).run(parsedState, unixMillisecondsSchema.parse(this.#now()), key);
    if (changed.changes !== 1) {
      throw new Error("ACCOUNT_RATE_LIMIT_RESET_SETTLEMENT_CONFLICT");
    }
    return mapAccountRateLimitResetAttempt(this.#database.query(
      "SELECT * FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
    ).get(key));
  }

  settleAccountRateLimitReset(
    idempotencyKey: string,
    outcome: AccountRateLimitResetOutcome,
  ): AccountRateLimitResetAttemptRecord {
    const key = z.string().uuid().parse(idempotencyKey);
    const parsedOutcome = accountRateLimitResetOutcomeSchema.parse(outcome);
    const changed = this.#database.query(
      `UPDATE account_rate_limit_reset_attempts
       SET state='settled',outcome=?,updated_at=MAX(updated_at,?)
       WHERE idempotency_key=? AND state='effect_started'`,
    ).run(parsedOutcome, unixMillisecondsSchema.parse(this.#now()), key);
    if (changed.changes !== 1) {
      throw new Error("ACCOUNT_RATE_LIMIT_RESET_SETTLEMENT_CONFLICT");
    }
    return mapAccountRateLimitResetAttempt(this.#database.query(
      "SELECT * FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
    ).get(key));
  }

  recoverAccountRateLimitResetAttempts(input: {
    profileId: ProfileId;
    processGeneration: number;
    accountFingerprint: string;
    weeklyWindowResetsAt: number;
  }): readonly string[] {
    const profileId = profileIdSchema.parse(input.profileId);
    const processGeneration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
      .parse(input.processGeneration);
    const accountFingerprint = sha256Schema.parse(input.accountFingerprint);
    const weeklyWindowResetsAt = unixMillisecondsSchema
      .parse(input.weeklyWindowResetsAt);
    const recover = this.#database.transaction(() => {
      const authority = z.object({
        process_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        provider_email: z.string().email(),
        state: z.literal("signed_in"),
      }).strict().parse(this.#database.query(
        "SELECT process_generation,provider_email,state FROM profiles WHERE id=?",
      ).get(profileId));
      if (
        authority.process_generation !== processGeneration
        || canonicalAccountFingerprint(authority.provider_email) !== accountFingerprint
      ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_RECOVERY_AUTHORITY_CHANGED");
      const policy = this.requireAccountRateLimitResetPolicy(profileId);
      if (
        policy.state !== "active_bound"
        || policy.accountFingerprint !== accountFingerprint
        || policy.weeklyWindowResetsAt !== weeklyWindowResetsAt
      ) throw new Error("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
      const keys = this.#database.query(
        `SELECT idempotency_key FROM account_rate_limit_reset_attempts
         WHERE profile_id=? AND account_fingerprint=?
           AND weekly_window_resets_at<=? AND state='effect_started'
         ORDER BY attempt_sequence`,
      ).all(profileId, accountFingerprint, weeklyWindowResetsAt)
        .map((row) => z.object({ idempotency_key: z.string().uuid() })
        .strict().parse(row).idempotency_key);
      for (const key of keys) {
        const changed = this.#database.query(
          `UPDATE account_rate_limit_reset_attempts
           SET state='ambiguous',updated_at=MAX(updated_at,?)
           WHERE idempotency_key=? AND state='effect_started'`,
        ).run(unixMillisecondsSchema.parse(this.#now()), key);
        if (changed.changes !== 1) {
          throw new Error("ACCOUNT_RATE_LIMIT_RESET_RECOVERY_CONFLICT");
        }
      }
      return keys;
    });
    return recover.immediate();
  }

  recordUsage(profileId: ProfileId, sourceRevision: number, observedAt: number, payload: unknown): void {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(sourceRevision);
    const parsedObservedAt = unixMillisecondsSchema.parse(observedAt);
    const json = JSON.stringify(payload);
    if (new TextEncoder().encode(json).byteLength > USAGE_LOCAL_SNAPSHOT_MAX_BYTES) {
      throw new Error("Usage snapshot exceeds the local bound.");
    }
    const digest = createHash("sha256").update(json).digest("hex");
    const record = this.#database.transaction(() => {
      const existing = this.#database.query("SELECT digest FROM usage_snapshots WHERE profile_id=? AND source_revision=?").get(parsedProfileId, parsedRevision) as { digest: string } | null;
      if (existing !== null && existing.digest !== digest) throw new Error("Usage source revision conflict.");
      const failed = this.#database.query(
        "SELECT 1 FROM usage_poll_failures WHERE profile_id=? AND source_revision=?",
      ).get(parsedProfileId, parsedRevision);
      if (failed !== null) throw new Error("Usage source revision is already a failed observation.");
      this.#database.query("INSERT OR IGNORE INTO usage_snapshots(profile_id,source_revision,observed_at,payload_json,digest) VALUES (?,?,?,?,?)").run(parsedProfileId, parsedRevision, parsedObservedAt, json, digest);
      this.#database.query(
        `INSERT INTO usage_revision_authority(profile_id,next_revision) VALUES (?,?)
         ON CONFLICT(profile_id) DO UPDATE SET next_revision=MAX(next_revision,excluded.next_revision)`,
      ).run(parsedProfileId, Math.min(Number.MAX_SAFE_INTEGER, parsedRevision + 1));
      recordUsageCloudUploadAnchor(
        this.#database,
        parsedProfileId,
        parsedRevision,
        usageSnapshotReceivedAt({
          observedAt: parsedObservedAt,
          payload,
          sourceRevision: parsedRevision,
        }),
      );
      pruneProfileUsageHistory(this.#database, parsedProfileId, this.#now());
    });
    record.immediate();
  }

  recordUsagePollFailure(
    profileId: ProfileId,
    accountFingerprint: string | null,
    sourceRevision: number,
    observedAt: number,
    reasonCode: UsagePollFailureRecord["reasonCode"] = "account_usage_read_failed",
  ): void {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedFingerprint = sha256Schema.nullable().parse(accountFingerprint);
    const parsedRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(sourceRevision);
    const parsedObservedAt = unixMillisecondsSchema.parse(observedAt);
    const parsedReason = z.literal("account_usage_read_failed").parse(reasonCode);
    const record = this.#database.transaction(() => {
      const observed = this.#database.query(
        "SELECT 1 FROM usage_snapshots WHERE profile_id=? AND source_revision=?",
      ).get(parsedProfileId, parsedRevision);
      if (observed !== null) throw new Error("Usage source revision is already a successful observation.");
      const existing = this.#database.query(
        `SELECT account_fingerprint,observed_at,reason_code FROM usage_poll_failures
         WHERE profile_id=? AND source_revision=?`,
      ).get(parsedProfileId, parsedRevision) as {
        account_fingerprint: string | null;
        observed_at: number;
        reason_code: string;
      } | null;
      if (
        existing !== null
        && (
          existing.account_fingerprint !== parsedFingerprint
          || existing.observed_at !== parsedObservedAt
          || existing.reason_code !== parsedReason
        )
      ) throw new Error("Usage failure source revision conflict.");
      this.#database.query(
        `INSERT OR IGNORE INTO usage_poll_failures(
           profile_id,account_fingerprint,source_revision,observed_at,reason_code
         ) VALUES (?,?,?,?,?)`,
      ).run(
        parsedProfileId,
        parsedFingerprint,
        parsedRevision,
        parsedObservedAt,
        parsedReason,
      );
      this.#database.query(
        `INSERT INTO usage_revision_authority(profile_id,next_revision) VALUES (?,?)
         ON CONFLICT(profile_id) DO UPDATE SET next_revision=MAX(next_revision,excluded.next_revision)`,
      ).run(parsedProfileId, Math.min(Number.MAX_SAFE_INTEGER, parsedRevision + 1));
      pruneProfileUsageHistory(this.#database, parsedProfileId, this.#now());
    });
    record.immediate();
  }

  allocateNextUsageRevision(profileId: ProfileId): number {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const allocate = this.#database.transaction(() => {
      const exists = this.#database.query("SELECT 1 FROM profiles WHERE id=?").get(parsedProfileId);
      if (exists === null) throw new SelectionError("NOT_FOUND");
      this.#database.query(
        `INSERT OR IGNORE INTO usage_revision_authority(profile_id,next_revision)
         SELECT ?,CASE
           WHEN MAX(source_revision) IS NULL THEN 1
           WHEN MAX(source_revision)>=9007199254740991 THEN 9007199254740991
           ELSE MAX(source_revision)+1
         END FROM (
           SELECT source_revision FROM usage_snapshots WHERE profile_id=?
           UNION ALL
           SELECT source_revision FROM usage_poll_failures WHERE profile_id=?
         )`,
      ).run(parsedProfileId, parsedProfileId, parsedProfileId);
      const current = z.object({
        next_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }).strict().parse(this.#database.query(
        "SELECT next_revision FROM usage_revision_authority WHERE profile_id=?",
      ).get(parsedProfileId));
      if (current.next_revision >= Number.MAX_SAFE_INTEGER) throw new Error("USAGE_REVISION_EXHAUSTED");
      const advanced = this.#database.query(
        `UPDATE usage_revision_authority SET next_revision=?
         WHERE profile_id=? AND next_revision=?`,
      ).run(current.next_revision + 1, parsedProfileId, current.next_revision);
      if (advanced.changes !== 1) throw new Error("USAGE_REVISION_AUTHORITY_CHANGED");
      return current.next_revision;
    });
    return allocate.immediate();
  }

  usageRange(input: {
    profileId: ProfileId;
    fromObservedAt?: number;
    throughObservedAt?: number;
    limit?: number;
  }): readonly UsageSnapshotRecord[] {
    const profileId = profileIdSchema.parse(input.profileId);
    const fromObservedAt = input.fromObservedAt === undefined ? undefined : unixMillisecondsSchema.parse(input.fromObservedAt);
    const throughObservedAt = input.throughObservedAt === undefined ? undefined : unixMillisecondsSchema.parse(input.throughObservedAt);
    if (fromObservedAt !== undefined && throughObservedAt !== undefined && fromObservedAt > throughObservedAt) {
      throw new Error("USAGE_RANGE_INVALID");
    }
    const limit = z.number().int().min(1).max(10_000).parse(input.limit ?? 1_000);
    const predicates = ["profile_id=?"];
    const parameters: Array<string | number> = [profileId];
    if (fromObservedAt !== undefined) {
      predicates.push("observed_at>=?");
      parameters.push(fromObservedAt);
    }
    if (throughObservedAt !== undefined) {
      predicates.push("observed_at<=?");
      parameters.push(throughObservedAt);
    }
    parameters.push(limit);
    const rows = this.#database.query(
      `SELECT source_revision,observed_at,payload_json FROM usage_snapshots
       WHERE ${predicates.join(" AND ")}
       ORDER BY observed_at,source_revision LIMIT ?`,
    ).all(...parameters);
    return rows.map((row) => {
      const parsed = z.object({
        source_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        observed_at: unixMillisecondsSchema,
        payload_json: z.string(),
      }).strict().parse(row);
      return {
        sourceRevision: parsed.source_revision,
        observedAt: parsed.observed_at,
        payload: JSON.parse(parsed.payload_json) as unknown,
      };
    });
  }

  usageHistoryPage(input: {
    profileId: ProfileId;
    accountFingerprint: string;
    fromObservedAt: number;
    throughObservedAt: number;
    afterSourceRevision?: number;
    limit: number;
  }): UsageHistoryLedgerPage {
    const profileId = profileIdSchema.parse(input.profileId);
    const accountFingerprint = sha256Schema.parse(input.accountFingerprint);
    const fromObservedAt = unixMillisecondsSchema.parse(input.fromObservedAt);
    const throughObservedAt = unixMillisecondsSchema.parse(input.throughObservedAt);
    if (fromObservedAt > throughObservedAt) throw new Error("USAGE_RANGE_INVALID");
    const afterSourceRevision = z.number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(input.afterSourceRevision ?? 0);
    const limit = z.number()
      .int()
      .min(1)
      .max(ACCOUNT_USAGE_HISTORY_PAGE_LIMIT)
      .parse(input.limit);
    const rows = this.#database.query(
      `SELECT source_revision,observed_at,state,payload_json,reason_code FROM (
         SELECT source_revision,observed_at,'observed' AS state,payload_json,NULL AS reason_code
         FROM usage_snapshots
         WHERE profile_id=?
           AND json_type(payload_json,'$.observation.accountFingerprint')='text'
           AND json_extract(payload_json,'$.observation.accountFingerprint')=?
           AND observed_at>=? AND observed_at<=? AND source_revision>?
         UNION ALL
         SELECT source_revision,observed_at,'failed' AS state,NULL AS payload_json,reason_code
         FROM usage_poll_failures
         WHERE profile_id=? AND account_fingerprint=?
           AND observed_at>=? AND observed_at<=? AND source_revision>?
       )
       ORDER BY source_revision
       LIMIT ?`,
    ).all(
      profileId,
      accountFingerprint,
      fromObservedAt,
      throughObservedAt,
      afterSourceRevision,
      profileId,
      accountFingerprint,
      fromObservedAt,
      throughObservedAt,
      afterSourceRevision,
      limit + 1,
    ).map((row): UsageHistoryLedgerEntry => {
      const parsed = z.object({
        source_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        observed_at: unixMillisecondsSchema,
        state: z.enum(["observed", "failed"]),
        payload_json: z.string().nullable(),
        reason_code: z.literal("account_usage_read_failed").nullable(),
      }).strict().parse(row);
      if (parsed.state === "observed") {
        if (parsed.payload_json === null || parsed.reason_code !== null) {
          throw new Error("USAGE_HISTORY_ROW_INVALID");
        }
        return {
          state: "observed",
          sourceRevision: parsed.source_revision,
          observedAt: parsed.observed_at,
          payload: JSON.parse(parsed.payload_json) as unknown,
        };
      }
      if (parsed.payload_json !== null || parsed.reason_code === null) {
        throw new Error("USAGE_HISTORY_ROW_INVALID");
      }
      return {
        state: "failed",
        sourceRevision: parsed.source_revision,
        observedAt: parsed.observed_at,
        reasonCode: parsed.reason_code,
      };
    });
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (
        previous === undefined
        || current === undefined
        || previous.sourceRevision >= current.sourceRevision
      ) {
        throw new Error("USAGE_HISTORY_SOURCE_ORDER_INVALID");
      }
    }
    const entries = rows.slice(0, limit);
    return {
      entries,
      nextSourceRevision: rows.length > limit
        ? entries.at(-1)?.sourceRevision ?? null
        : null,
    };
  }

  usageAfterRevision(input: {
    profileId: ProfileId;
    accountFingerprint: string;
    afterSourceRevision: number;
    limit: number;
  }): readonly UsageSnapshotRecord[] {
    const profileId = profileIdSchema.parse(input.profileId);
    const accountFingerprint = sha256Schema.parse(input.accountFingerprint);
    const afterSourceRevision = z.number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(input.afterSourceRevision);
    const limit = z.number().int().min(1).max(10_000).parse(input.limit);
    const rows = this.#database.query(
      `SELECT u.source_revision,u.observed_at,u.payload_json
       FROM usage_cloud_upload_anchors a
       JOIN usage_snapshots u
         ON u.profile_id=a.profile_id AND u.source_revision=a.source_revision
       WHERE a.profile_id=? AND a.source_revision>?
         AND json_type(u.payload_json,'$.observation.accountFingerprint')='text'
         AND json_extract(u.payload_json,'$.observation.accountFingerprint')=?
       ORDER BY a.source_revision LIMIT ?`,
    ).all(profileId, afterSourceRevision, accountFingerprint, limit);
    const mapRow = (row: unknown): UsageSnapshotRecord => {
      const parsed = z.object({
        source_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        observed_at: unixMillisecondsSchema,
        payload_json: z.string(),
      }).strict().parse(row);
      return {
        sourceRevision: parsed.source_revision,
        observedAt: parsed.observed_at,
        payload: JSON.parse(parsed.payload_json) as unknown,
      };
    };
    return rows.map(mapRow);
  }

  latestUsage(profileId: ProfileId): UsageSnapshotRecord | null {
    const row = this.#database.query("SELECT source_revision,observed_at,payload_json FROM usage_snapshots WHERE profile_id=? ORDER BY source_revision DESC LIMIT 1").get(profileId) as { source_revision: number; observed_at: number; payload_json: string } | null;
    return row === null ? null : { sourceRevision: row.source_revision, observedAt: row.observed_at, payload: JSON.parse(row.payload_json) as unknown };
  }

  latestUsageForAccount(
    profileId: ProfileId,
    accountFingerprint: string,
  ): UsageSnapshotRecord | null {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedFingerprint = sha256Schema.parse(accountFingerprint);
    const row = this.#database.query(
      `SELECT source_revision,observed_at,payload_json FROM usage_snapshots
       WHERE profile_id=?
         AND json_type(payload_json,'$.observation.accountFingerprint')='text'
         AND json_extract(payload_json,'$.observation.accountFingerprint')=?
       ORDER BY source_revision DESC LIMIT 1`,
    ).get(parsedProfileId, parsedFingerprint) as {
      source_revision: number;
      observed_at: number;
      payload_json: string;
    } | null;
    return row === null ? null : {
      sourceRevision: row.source_revision,
      observedAt: row.observed_at,
      payload: JSON.parse(row.payload_json) as unknown,
    };
  }

  latestUsagePollFailure(
    profileId: ProfileId,
    accountFingerprint: string,
  ): UsagePollFailureRecord | null {
    const parsedProfileId = profileIdSchema.parse(profileId);
    const parsedFingerprint = sha256Schema.parse(accountFingerprint);
    const row = this.#database.query(
      `SELECT source_revision,observed_at,reason_code FROM usage_poll_failures
       WHERE profile_id=? AND account_fingerprint=?
       ORDER BY source_revision DESC LIMIT 1`,
    ).get(parsedProfileId, parsedFingerprint) as {
      source_revision: number;
      observed_at: number;
      reason_code: UsagePollFailureRecord["reasonCode"];
    } | null;
    return row === null ? null : {
      observedAt: row.observed_at,
      reasonCode: row.reason_code,
      sourceRevision: row.source_revision,
    };
  }

  canInitializeDaemonCursorAuthority(): boolean {
    const evidence = z.object({
      daemon_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      profiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      sessions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      events: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      usage_rows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).strict().parse(this.#database.query(
      `SELECT
         (SELECT generation FROM daemon_state WHERE singleton=1) AS daemon_generation,
         (SELECT COUNT(*) FROM profiles) AS profiles,
         (SELECT COUNT(*) FROM sessions) AS sessions,
         (SELECT COUNT(*) FROM session_events) AS events,
         ((SELECT COUNT(*) FROM usage_snapshots)
           +(SELECT COUNT(*) FROM usage_poll_failures)) AS usage_rows`,
    ).get());
    return evidence.daemon_generation === 0
      && evidence.profiles === 0
      && evidence.sessions === 0
      && evidence.events === 0
      && evidence.usage_rows === 0;
  }

  nextDaemonGeneration(bootId: string): number {
    const now = this.#now();
    const transaction = this.#database.transaction(() => {
      const current = this.#database.query("SELECT generation FROM daemon_state WHERE singleton=1").get() as { generation: number };
      const interactions = this.#database.query(
        `SELECT i.* FROM provider_interactions i
         JOIN profiles p ON p.id=i.profile_id AND p.process_generation=i.process_generation
         WHERE i.state IN ('pending','response_prepared','response_written')
         ORDER BY i.requested_at,i.public_id`,
      ).all();
      for (const value of interactions) {
        const interaction = interactionRowSchema.parse(value);
        const state = interaction.state === "pending" ? "expired" : "resolution_unknown";
        const changed = this.#database.query(
          `UPDATE provider_interactions
           SET state=?,revision=revision+1,updated_at=MAX(updated_at,?),terminal_at=MAX(requested_at,?)
           WHERE public_id=? AND revision=? AND state=?`,
        ).run(state, now, now, interaction.public_id, interaction.revision, interaction.state);
        if (changed.changes !== 1) throw new Error("INTERACTION_DAEMON_RESTART_CONFLICT");
        this.#recordInteractionTransition(this.#requireInteractionRow(interaction.public_id), now);
      }
      const invalidLoginAuthority = this.#database.query(`SELECT a.attempt_id
                                                          FROM provider_login_authorities a
                                                          LEFT JOIN profiles p ON p.id=a.profile_id
                                                          WHERE a.state='active'
                                                            AND (p.id IS NULL OR p.state!='login_pending' OR p.process_generation!=a.process_generation)
                                                          LIMIT 1`).get();
      if (invalidLoginAuthority !== null) {
        throw new Error("LOGIN_RESTART_AUTHORITY_MISMATCH");
      }
      this.#database.query(`UPDATE provider_login_authorities
                            SET process_generation=process_generation+1,updated_at=MAX(updated_at,?)
                            WHERE state='active'`).run(now);
      this.#database.query(
        `UPDATE profiles
         SET process_generation=process_generation+1,updated_at=MAX(updated_at,?)
         WHERE state!='removed' AND process_generation>0`,
      ).run(now);
      this.#database.query("UPDATE daemon_state SET generation=?,boot_id=?,started_at=?,stopped_at=NULL WHERE singleton=1 AND generation=?").run(current.generation + 1, bootId, now, current.generation);
      return current.generation + 1;
    });
    const generation = transaction.immediate();
    this.#recordDaemonRestartGaps();
    return generation;
  }

  #recordDaemonRestartGaps(): void {
    const sessions = this.#database.query(
      `SELECT s.id,p.id AS profile_id,p.process_generation
       FROM sessions s JOIN profiles p ON p.id=s.profile_id
       WHERE s.provider_thread_id IS NOT NULL AND s.state!='terminal'
       ORDER BY s.id`,
    ).all().map((row) => z.object({
      id: sessionIdSchema,
      profile_id: profileIdSchema,
      process_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict().parse(row));
    for (const session of sessions) {
      const position = this.eventStreamPosition(session.id);
      this.appendSessionEvent({
        sessionId: session.id,
        accountId: session.profile_id,
        providerGeneration: session.process_generation,
        providerConnectionId: null,
        body: {
          type: "gap",
          reason: "provider_restart",
          fromSequence: position.observedThroughSequence + 1,
          throughSequence: position.observedThroughSequence + 1,
        },
      });
    }
  }

  markDaemonStopped(generation: number, bootId: string): boolean {
    const result = this.#database.query("UPDATE daemon_state SET stopped_at=? WHERE singleton=1 AND generation=? AND boot_id=?").run(this.#now(), generation, bootId);
    return result.changes === 1;
  }
}
