import { createHash } from "node:crypto";

import { z } from "zod";

import {
  WORK_ACTIVE_LIMIT,
  WORK_ARTIFACT_MAX_BYTES,
  WORK_ARTIFACT_PATH_MAX_BYTES,
  WORK_CRITERIA_LIMIT,
  WORK_CRITERIA_MAX_BYTES,
  WORK_DEPENDENCY_PREVIEW_MAX_BYTES,
  WORK_EFFECT_RESOLUTION_LIMIT,
  WORK_EVENT_MAX_BYTES,
  WORK_EVENT_PAGE_LIMIT,
  WORK_EVENT_PAGE_MAX_BYTES,
  WORK_EVENT_STREAM_LINE_MAX_BYTES,
  WORK_EVIDENCE_LIMIT,
  WORK_HISTORY_EVENT_LIMIT,
  WORK_HISTORY_RECOVERY_RESERVE,
  WORK_INLINE_RESULT_MAX_BYTES,
  WORK_JSON_DEPTH_LIMIT,
  WORK_JSON_KEY_MAX_BYTES,
  WORK_JSON_NODE_LIMIT,
  WORK_LEASE_MAX_MS,
  WORK_LEASE_MIN_MS,
  WORK_MEMBER_LIMIT,
  WORK_OPERATION_BATCH_LIMIT,
  WORK_OPERATION_KINDS,
  WORK_OPERATION_MAX_BYTES,
  WORK_PLAN_TASK_LIMIT,
  WORK_POLL_ITEM_LIMIT,
  WORK_POLL_MAX_BYTES,
  WORK_PREPARED_EFFECT_MAX_BYTES,
  WORK_PROTOCOL,
  WORK_PROTOCOL_REQUEST_MAX_BYTES,
  WORK_PROTOCOL_VERSION,
  WORK_READ_HISTORY_LIMIT,
  WORK_RETAINED_LIMIT,
  WORK_ROUTE_LIMIT,
  WORK_SIGNAL_MAX_BYTES,
  WORK_SNAPSHOT_MAX_BYTES,
  WORK_STREAM_FAILURE_MAX_BYTES,
  WORK_TASK_DEPENDENCY_LIMIT,
  WORK_TASK_DEPTH_LIMIT,
  WORK_TASK_DETAIL_MAX_BYTES,
  WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
  WORK_TASK_HISTORY_ITEM_LIMIT,
  WORK_TASK_HISTORY_MEMBERSHIP_LIMIT,
  WORK_TASK_HISTORY_PAGE_MAX_BYTES,
  WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT,
  WORK_TASK_HISTORY_VERSION_LIMIT,
  WORK_TOMBSTONE_LIMIT,
  WORK_TOMBSTONE_MAX_AGE_MS,
  WORK_TOMBSTONE_MAX_BYTES,
  WORK_WAITER_LIMIT,
  WORK_WAIT_MAX_MS,
  WORK_WORKER_BRIEF_MAX_BYTES,
  workAttemptIdSchema,
  workIdSchema,
  workOperationResultSchema,
  workReviewIdSchema,
  workSignalIdSchema,
  workSubmissionIdSchema,
  workTaskIdSchema,
} from "./work";
import { terminalSafeJson } from "./terminal-json";
import { sessionIdSchema, utf8Bytes } from "./values";

export const WORK_PROTOCOL_DOCUMENT_MAX_BYTES = 64 * 1024;

export const WORK_PROTOCOL_TOPICS = [
  "envelopes",
  "errors",
  "events",
  "limits",
  "semantics",
  "types",
] as const;

export const WORK_PROTOCOL_TYPE_NAMES = [
  "AccountId",
  "ActionCursor",
  "ArtifactPath",
  "ArtifactBytes",
  "Boolean",
  "AttemptCount",
  "AttemptId",
  "AttemptLimit",
  "AttemptRecord",
  "AttemptReportRecord",
  "AttemptRecoveryReason",
  "AttemptStatus",
  "Capability",
  "AccountGeneration",
  "ClaimRequest",
  "ClaimResult",
  "ClientRef",
  "CommandError",
  "CommandErrorCode",
  "CommandErrorMessage",
  "Criterion",
  "DependencyRecordCount",
  "DispatchMode",
  "DiscardedRecordCounts",
  "EffectState",
  "EffectOutcome",
  "EffectResolutionRecordCount",
  "EffectStatus",
  "Event",
  "EventBoundedRecordCount",
  "EventBody",
  "EventCursor",
  "EventGap",
  "EventGapReason",
  "EventSequence",
  "EventPage",
  "Evidence",
  "EvidenceCount",
  "ExecutionRoute",
  "ExitCode",
  "Fence",
  "GitCommit",
  "IdempotencyKey",
  "Instructions",
  "JsonValue",
  "LeaseMilliseconds",
  "MemberCount",
  "MutationAttemptId",
  "NestedEffectReceipt",
  "NonemptyTaskCount",
  "Objective",
  "NonnegativeSafeInteger",
  "Poll",
  "PollOmittedCounts",
  "Preset",
  "PreparedEffectState",
  "PositiveReviewCount",
  "ProjectId",
  "ProviderId",
  "QueueId",
  "Priority",
  "ReconcileOutcome",
  "ReconcileOutcomeKind",
  "RecoveryDirective",
  "Report",
  "ReportKind",
  "RequestId",
  "Result",
  "ResultKind",
  "ResultText",
  "RetryAfterMilliseconds",
  "ReviewDecision",
  "ReviewId",
  "ReviewInput",
  "ReviewRecord",
  "ReviewableSubmission",
  "Revision",
  "ReviewCount",
  "RouteCount",
  "Route",
  "RouteRecordCount",
  "SessionId",
  "Sha256",
  "SignalBody",
  "SignalId",
  "SignalMode",
  "SignalRecord",
  "SignalDeliveryState",
  "SignalReceiptRecordCount",
  "StreamEpoch",
  "SubmissionRecord",
  "SubmissionId",
  "SubmissionStatus",
  "Summary",
  "TaskDepth",
  "TaskAttemptRecordCount",
  "TaskCount",
  "TaskFailureReason",
  "TaskDetail",
  "TaskHistoryCount",
  "TaskHistoryCounts",
  "TaskHistoryCursor",
  "TaskHistoryItem",
  "TaskHistoryMembershipCount",
  "TaskHistoryPage",
  "TaskHistoryTotalCount",
  "TaskHistoryVersionCount",
  "TaskId",
  "TaskSpec",
  "TaskStatus",
  "TaskSummary",
  "TerminalProjection",
  "TerminalKind",
  "TerminalState",
  "UnixMilliseconds",
  "WorkError",
  "WorkErrorCode",
  "WorkEntityId",
  "WorkEventStreamLine",
  "WorkId",
  "WorkRecord",
  "WorkReleaseTombstone",
  "WorkSnapshot",
  "WorkStatus",
] as const;

export const workProtocolTopicSchema = z.enum(WORK_PROTOCOL_TOPICS);
export const workProtocolTypeNameSchema = z.enum(WORK_PROTOCOL_TYPE_NAMES);

export const workProtocolQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("index") }).strict(),
  z.object({
    kind: z.literal("operation"),
    operation: z.enum(WORK_OPERATION_KINDS),
  }).strict(),
  z.object({
    kind: z.literal("type"),
    name: workProtocolTypeNameSchema,
  }).strict(),
  z.object({
    kind: z.literal("topic"),
    topic: workProtocolTopicSchema,
  }).strict(),
]);
export type WorkProtocolQuery = z.infer<typeof workProtocolQuerySchema>;

const jsonScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const listUseSchema = z.object({
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
  unique: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (value.max < value.min) {
    context.addIssue({ code: "custom", path: ["max"], message: "List maximum cannot precede its minimum." });
  }
});

const typeUseSchema = z.union([
  workProtocolTypeNameSchema,
  z.object({ const: jsonScalarSchema }).strict(),
  z.object({
    ref: workProtocolTypeNameSchema,
    nullable: z.literal(true).optional(),
    list: listUseSchema.optional(),
  }).strict(),
]);

const fieldMapSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/u), typeUseSchema);
const ruleIdSchema = z.string().regex(/^[a-z][a-z0-9_.-]*$/u).max(96);

const scalarTypeDefinitionSchema = z.object({
  kind: z.literal("scalar"),
  wire: z.enum(["string", "integer", "boolean", "json"]),
  format: z.string().min(1).max(96),
  pattern: z.string().min(1).max(256).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  minBytes: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().nonnegative().optional(),
  sensitive: z.literal(true).optional(),
}).strict();

const enumTypeDefinitionSchema = z.object({
  kind: z.literal("enum"),
  values: z.array(jsonScalarSchema).min(1).max(64),
}).strict();

const objectTypeDefinitionSchema = z.object({
  kind: z.literal("object"),
  closed: z.literal(true),
  required: fieldMapSchema,
  optional: fieldMapSchema,
  rules: z.array(ruleIdSchema).max(32),
}).strict().superRefine((definition, context) => {
  const overlap = Object.keys(definition.optional).find((field) => Object.hasOwn(definition.required, field));
  if (overlap !== undefined) {
    context.addIssue({ code: "custom", path: ["optional", overlap], message: "Required and optional fields must be disjoint." });
  }
});

const unionVariantSchema = z.object({
  required: fieldMapSchema,
  optional: fieldMapSchema,
  rules: z.array(ruleIdSchema).max(16),
}).strict();

const unionTypeDefinitionSchema = z.object({
  kind: z.literal("union"),
  closed: z.literal(true),
  discriminator: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/u),
  variants: z.record(z.string().min(1).max(96), unionVariantSchema),
}).strict();

export const workProtocolTypeDefinitionSchema = z.discriminatedUnion("kind", [
  scalarTypeDefinitionSchema,
  enumTypeDefinitionSchema,
  objectTypeDefinitionSchema,
  unionTypeDefinitionSchema,
]);
export type WorkProtocolTypeDefinition = z.infer<typeof workProtocolTypeDefinitionSchema>;

const required = (fields: Record<string, z.input<typeof typeUseSchema>>) => fields;
const optional = (fields: Record<string, z.input<typeof typeUseSchema>> = {}) => fields;
const list = (
  ref: z.infer<typeof workProtocolTypeNameSchema>,
  min: number,
  max: number,
  unique = false,
) => ({ ref, list: { min, max, ...(unique ? { unique: true as const } : {}) } });
const nullable = (ref: z.infer<typeof workProtocolTypeNameSchema>) => ({ ref, nullable: true as const });
const literal = (value: string | number | boolean | null) => ({ const: value });

const typeDefinitions = {
  AccountId: { kind: "scalar", wire: "string", format: "acct_<32-lower-hex>", pattern: "^acct_[0-9a-f]{32}$" },
  AccountGeneration: { kind: "scalar", wire: "integer", format: "nonnegative-safe-integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  ActionCursor: { kind: "scalar", wire: "string", format: "opaque-authenticated-hra1-action-cursor", maxBytes: 2_048 },
  ArtifactPath: { kind: "scalar", wire: "string", format: "canonical-workspace-relative-posix-path", minBytes: 1, maxBytes: WORK_ARTIFACT_PATH_MAX_BYTES },
  ArtifactBytes: { kind: "scalar", wire: "integer", format: "artifact-byte-count", minimum: 0, maximum: WORK_ARTIFACT_MAX_BYTES },
  AttemptLimit: { kind: "scalar", wire: "integer", format: "attempt-limit", minimum: 1, maximum: WORK_OPERATION_BATCH_LIMIT },
  AttemptCount: { kind: "scalar", wire: "integer", format: "attempt-count", minimum: 0, maximum: WORK_OPERATION_BATCH_LIMIT },
  AttemptId: { kind: "scalar", wire: "string", format: "watt_<32-lower-hex>", pattern: "^watt_[0-9a-f]{32}$" },
  Capability: { kind: "scalar", wire: "string", format: "hrac1_<canonical-base64url-256-bit>", pattern: "^hrac1_[A-Za-z0-9_-]{43}$", sensitive: true },
  Boolean: { kind: "scalar", wire: "boolean", format: "json-boolean" },
  ClientRef: { kind: "scalar", wire: "string", format: "client-reference", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", minBytes: 1, maxBytes: 128 },
  CommandErrorMessage: { kind: "scalar", wire: "string", format: "terminal-safe-diagnostic", minBytes: 1, maxBytes: 8 * 1_024 },
  Criterion: { kind: "scalar", wire: "string", format: "nonempty-utf8", minBytes: 1, maxBytes: 2 * 1_024 },
  DependencyRecordCount: { kind: "scalar", wire: "integer", format: "per-work-task-dependency-record-count", minimum: 0, maximum: WORK_PLAN_TASK_LIMIT * WORK_TASK_DEPENDENCY_LIMIT },
  EffectResolutionRecordCount: { kind: "scalar", wire: "integer", format: "per-work-combined-effect-resolution-record-count", minimum: 0, maximum: WORK_EFFECT_RESOLUTION_LIMIT },
  EventBoundedRecordCount: { kind: "scalar", wire: "integer", format: "per-work-event-bounded-record-count", minimum: 0, maximum: WORK_HISTORY_EVENT_LIMIT },
  EventCursor: { kind: "scalar", wire: "string", format: "opaque-authenticated-hra1-event-cursor", maxBytes: 2_048 },
  EventSequence: { kind: "scalar", wire: "integer", format: "positive-safe-integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  EvidenceCount: { kind: "scalar", wire: "integer", format: "evidence-count", minimum: 0, maximum: WORK_EVIDENCE_LIMIT },
  Fence: { kind: "scalar", wire: "integer", format: "positive-safe-integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  GitCommit: { kind: "scalar", wire: "string", format: "lower-hex-git-object-id", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
  IdempotencyKey: { kind: "scalar", wire: "string", format: "canonical-uuidv7", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
  Instructions: { kind: "scalar", wire: "string", format: "nonempty-utf8", minBytes: 1, maxBytes: 16 * 1_024 },
  JsonValue: { kind: "scalar", wire: "json", format: `acyclic-finite-json-depth-${WORK_JSON_DEPTH_LIMIT}-nodes-${WORK_JSON_NODE_LIMIT}-key-bytes-${WORK_JSON_KEY_MAX_BYTES}`, maxBytes: WORK_INLINE_RESULT_MAX_BYTES },
  LeaseMilliseconds: { kind: "scalar", wire: "integer", format: "lease-duration-milliseconds", minimum: WORK_LEASE_MIN_MS, maximum: WORK_LEASE_MAX_MS },
  MemberCount: { kind: "scalar", wire: "integer", format: "per-work-member-count", minimum: 0, maximum: WORK_MEMBER_LIMIT },
  MutationAttemptId: { kind: "scalar", wire: "string", format: "attempt_<32-lower-hex>", pattern: "^attempt_[0-9a-f]{32}$" },
  NonnegativeSafeInteger: { kind: "scalar", wire: "integer", format: "nonnegative-safe-integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  NonemptyTaskCount: { kind: "scalar", wire: "integer", format: "nonempty-task-count", minimum: 1, maximum: WORK_PLAN_TASK_LIMIT },
  Objective: { kind: "scalar", wire: "string", format: "nonempty-utf8", minBytes: 1, maxBytes: 8 * 1_024 },
  ProjectId: { kind: "scalar", wire: "string", format: "proj_<32-lower-hex>", pattern: "^proj_[0-9a-f]{32}$" },
  Priority: { kind: "scalar", wire: "integer", format: "task-priority", minimum: -100, maximum: 100 },
  PositiveReviewCount: { kind: "scalar", wire: "integer", format: "positive-review-count", minimum: 1, maximum: WORK_EVIDENCE_LIMIT },
  ProviderId: { kind: "scalar", wire: "string", format: "opaque_v2_<64-lower-hex>", pattern: "^opaque_v2_[0-9a-f]{64}$", minBytes: 74, maxBytes: 74 },
  QueueId: { kind: "scalar", wire: "string", format: "queue_<32-lower-hex>", pattern: "^queue_[0-9a-f]{32}$" },
  RequestId: { kind: "scalar", wire: "string", format: "uuid" },
  Revision: { kind: "scalar", wire: "integer", format: "positive-safe-integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  SessionId: { kind: "scalar", wire: "string", format: "sess_<32-lower-hex>", pattern: "^sess_[0-9a-f]{32}$" },
  Sha256: { kind: "scalar", wire: "string", format: "lower-hex-sha256", pattern: "^[0-9a-f]{64}$" },
  SignalBody: { kind: "scalar", wire: "string", format: "nonempty-utf8", minBytes: 1, maxBytes: WORK_SIGNAL_MAX_BYTES },
  StreamEpoch: { kind: "scalar", wire: "string", format: "uuid" },
  Summary: { kind: "scalar", wire: "string", format: "nonempty-utf8", minBytes: 1, maxBytes: 8 * 1_024 },
  ResultText: { kind: "scalar", wire: "string", format: "nonempty-utf8", minBytes: 1, maxBytes: WORK_INLINE_RESULT_MAX_BYTES },
  RetryAfterMilliseconds: { kind: "scalar", wire: "integer", format: "retry-delay-milliseconds", minimum: 0, maximum: WORK_LEASE_MAX_MS },
  ReviewCount: { kind: "scalar", wire: "integer", format: "review-count", minimum: 0, maximum: WORK_EVIDENCE_LIMIT },
  RouteCount: { kind: "scalar", wire: "integer", format: "route-count", minimum: 1, maximum: WORK_ROUTE_LIMIT },
  RouteRecordCount: { kind: "scalar", wire: "integer", format: "per-work-route-record-count", minimum: 0, maximum: WORK_ROUTE_LIMIT },
  ReviewId: { kind: "scalar", wire: "string", format: "review_<32-lower-hex>", pattern: "^review_[0-9a-f]{32}$" },
  SignalId: { kind: "scalar", wire: "string", format: "sig_<32-lower-hex>", pattern: "^sig_[0-9a-f]{32}$" },
  SignalReceiptRecordCount: { kind: "scalar", wire: "integer", format: "per-work-signal-receipt-record-count", minimum: 0, maximum: WORK_HISTORY_EVENT_LIMIT * 3 },
  SubmissionId: { kind: "scalar", wire: "string", format: "sub_<32-lower-hex>", pattern: "^sub_[0-9a-f]{32}$" },
  TaskId: { kind: "scalar", wire: "string", format: "task_<32-lower-hex>", pattern: "^task_[0-9a-f]{32}$" },
  TaskAttemptRecordCount: { kind: "scalar", wire: "integer", format: "per-work-task-attempt-record-count", minimum: 0, maximum: WORK_PLAN_TASK_LIMIT * WORK_OPERATION_BATCH_LIMIT },
  TaskCount: { kind: "scalar", wire: "integer", format: "task-count", minimum: 0, maximum: WORK_PLAN_TASK_LIMIT },
  TaskDepth: { kind: "scalar", wire: "integer", format: "task-depth", minimum: 1, maximum: WORK_TASK_DEPTH_LIMIT },
  TaskHistoryCount: { kind: "scalar", wire: "integer", format: "task-history-count", minimum: 0, maximum: WORK_HISTORY_EVENT_LIMIT },
  TaskHistoryCursor: { kind: "scalar", wire: "string", format: "opaque-authenticated-hra1-task-history-cursor", maxBytes: 2_048 },
  TaskHistoryMembershipCount: { kind: "scalar", wire: "integer", format: "per-work-task-history-membership-count", minimum: 0, maximum: WORK_TASK_HISTORY_MEMBERSHIP_LIMIT },
  TaskHistoryTotalCount: { kind: "scalar", wire: "integer", format: "task-history-total-count", minimum: 0, maximum: WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT },
  TaskHistoryVersionCount: { kind: "scalar", wire: "integer", format: "per-work-task-history-public-version-count", minimum: 0, maximum: WORK_TASK_HISTORY_VERSION_LIMIT },
  UnixMilliseconds: { kind: "scalar", wire: "integer", format: "nonnegative-unix-milliseconds", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  WorkId: { kind: "scalar", wire: "string", format: "work_<32-lower-hex>", pattern: "^work_[0-9a-f]{32}$" },
  WorkEntityId: { kind: "scalar", wire: "string", format: "one-of-work-task-attempt-submission-review-signal-session-id" },

  CommandErrorCode: { kind: "enum", values: ["INVALID_INPUT", "NOT_FOUND", "AMBIGUOUS", "CONFLICT", "INTERACTION_REQUIRED", "UNAVAILABLE", "RECOVERY_REQUIRED", "INTERNAL"] },
  EffectState: { kind: "enum", values: ["prepared", "effect_started", "accepted", "failed", "unknown"] },
  DispatchMode: { kind: "enum", values: ["send"] },
  EventGapReason: { kind: "enum", values: ["retention_count", "retention_age", "retention_bytes", "stream_reset"] },
  ExitCode: { kind: "enum", values: [0, 1, 2, 4, 5, 6, 7] },
  Preset: { kind: "enum", values: ["low", "high", "ultra"] },
  PreparedEffectState: { kind: "enum", values: ["prepared", "effect_started", "accepted", "failed", "unknown"] },
  AttemptStatus: { kind: "enum", values: ["claimed", "dispatching", "active", "submitted", "blocked", "failed", "unknown", "released", "expired", "reconciled"] },
  AttemptRecoveryReason: { kind: "enum", values: ["lease_expired_after_dispatch", "effect_unknown", "custodian_restart"] },
  EffectOutcome: { kind: "enum", values: ["accepted", "failed", "unknown"] },
  ReportKind: { kind: "enum", values: ["checkpoint", "submit", "blocked", "failed", "unknown"] },
  RecoveryDirective: { kind: "enum", values: ["none", "replay_exact_request", "retry_same_request", "refresh_state_then_new_request"] },
  ReconcileOutcomeKind: { kind: "enum", values: ["completed", "failed", "no_effect", "still_unknown"] },
  ResultKind: { kind: "enum", values: ["text", "json"] },
  ReviewDecision: { kind: "enum", values: ["accept", "revise", "reject"] },
  SignalMode: { kind: "enum", values: ["queue", "steer"] },
  SignalDeliveryState: { kind: "enum", values: ["pending", "accepted", "unknown", "failed"] },
  SubmissionStatus: { kind: "enum", values: ["pending_review", "accepted", "revision_requested", "rejected"] },
  TaskFailureReason: { kind: "enum", values: ["claim_window_elapsed", "completion_deadline_elapsed", "attempts_exhausted"] },
  TaskStatus: { kind: "enum", values: ["waiting", "ready", "claimed", "dispatched", "submitted", "blocked", "completed", "failed", "cancelled"] },
  WorkStatus: { kind: "enum", values: ["open", "cancel_pending", "fail_pending", "completed", "failed", "cancelled"] },
  WorkErrorCode: { kind: "enum", values: ["invalid_request", "not_found", "conflict", "fence_mismatch", "lease_expired", "not_owner", "route_mismatch", "invalid_state", "limit_exceeded", "effect_unknown", "internal"] },
  TerminalKind: { kind: "enum", values: ["work.complete", "work.fail", "work.cancel"] },
  TerminalState: { kind: "enum", values: ["requested", "settled"] },

  CommandError: {
    kind: "object", closed: true,
    required: required({ code: "CommandErrorCode", message: "CommandErrorMessage" }),
    optional: optional({ details: "JsonValue" }), rules: ["command-error.details-are-sanitized"],
  },
  Route: {
    kind: "object", closed: true,
    required: required({ accountId: "AccountId", projectId: "ProjectId" }), optional: optional(), rules: [],
  },
  ExecutionRoute: {
    kind: "object", closed: true,
    required: required({ accountId: "AccountId", projectId: "ProjectId", preset: "Preset", fast: "Boolean" }),
    optional: optional(), rules: [],
  },
  TaskSpec: {
    kind: "object", closed: true,
    required: required({
      clientRef: "ClientRef",
      dependsOnRefs: list("ClientRef", 0, WORK_TASK_DEPENDENCY_LIMIT, true),
      dependsOnTaskIds: list("TaskId", 0, WORK_TASK_DEPENDENCY_LIMIT, true),
      objective: "Objective",
      instructions: "Instructions",
      criteria: list("Criterion", 0, WORK_CRITERIA_LIMIT, true),
      route: "Route",
      preset: "Preset",
      fast: "Boolean",
      priority: "Priority",
      maxAttempts: "AttemptLimit",
      requiredReviews: "ReviewCount",
      resultKind: "ResultKind",
      minEvidence: "EvidenceCount",
    }),
    optional: optional({
      parentRef: "ClientRef", parentTaskId: "TaskId", notBefore: "UnixMilliseconds",
      claimBy: "UnixMilliseconds", deadline: "UnixMilliseconds",
    }),
    rules: ["task.parent-xor", "task.dependencies-combined-max", "task.time-order", "task.numeric-bounds", "task.criteria-byte-bound"],
  },
  Result: {
    kind: "union", closed: true, discriminator: "kind",
    variants: {
      text: { required: required({ text: "ResultText" }), optional: optional(), rules: [] },
      json: { required: required({ value: "JsonValue" }), optional: optional(), rules: [] },
    },
  },
  Report: {
    kind: "union", closed: true, discriminator: "kind",
    variants: {
      checkpoint: { required: required({ summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: [] },
      submit: { required: required({ summary: "Summary", result: "Result", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: [] },
      blocked: { required: required({ summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional({ retryAt: "UnixMilliseconds" }), rules: [] },
      failed: { required: required({ summary: "Summary", retryable: "Boolean", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: [] },
      unknown: { required: required({ summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: [] },
    },
  },
  Evidence: {
    kind: "union", closed: true, discriminator: "kind",
    variants: {
      session: { required: required({ sessionId: "SessionId" }), optional: optional(), rules: [] },
      turn: { required: required({ sessionId: "SessionId", turnId: "ProviderId" }), optional: optional(), rules: [] },
      artifact: { required: required({ projectId: "ProjectId", path: "ArtifactPath", bytes: "ArtifactBytes", sha256: "Sha256" }), optional: optional(), rules: [] },
      git_commit: { required: required({ projectId: "ProjectId", commit: "GitCommit" }), optional: optional(), rules: [] },
    },
  },
  ReconcileOutcome: {
    kind: "union", closed: true, discriminator: "kind",
    variants: {
      completed: { required: required({ summary: "Summary", result: "Result", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: ["reconcile.completed-observed-original-effect"] },
      failed: { required: required({ summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: ["reconcile.failed-observed-original-effect"] },
      no_effect: { required: required({ summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: ["reconcile.no-effect-requires-durable-failure"] },
      still_unknown: { required: required({ summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: ["reconcile.still-unknown-preserves-quarantine"] },
    },
  },
  ReviewInput: {
    kind: "union", closed: true, discriminator: "decision",
    variants: {
      accept: { required: required({ summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: [] },
      revise: { required: required({ feedback: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: [] },
      reject: { required: required({ summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }), optional: optional(), rules: [] },
    },
  },
  ClaimRequest: {
    kind: "object", closed: true,
    required: required({ taskId: "TaskId", expectedTaskRevision: "Revision", actorSessionId: "SessionId", actorCapability: "Capability", leaseMs: "LeaseMilliseconds" }),
    optional: optional(), rules: [],
  },
  ClaimResult: {
    kind: "object", closed: true,
    required: required({ task: "TaskSummary", attempt: "AttemptRecord", attemptCapability: "Capability" }),
    optional: optional(), rules: ["claim-result.attempt-binds-task"],
  },
  WorkRecord: {
    kind: "object", closed: true,
    required: required({
      id: "WorkId", clientRef: "ClientRef", coordinatorSessionId: "SessionId", objective: "Objective", status: "WorkStatus",
      revision: "Revision", taskCount: "NonemptyTaskCount", waitingTaskCount: "TaskCount", readyTaskCount: "TaskCount",
      activeTaskCount: "TaskCount", completedTaskCount: "TaskCount", failedTaskCount: "TaskCount", cancelledTaskCount: "TaskCount",
      createdAt: "UnixMilliseconds", updatedAt: "UnixMilliseconds", terminalAt: nullable("UnixMilliseconds"),
    }), optional: optional(), rules: ["work.task-count-partition", "work.terminal-time-correlates-status"],
  },
  TaskSummary: {
    kind: "object", closed: true,
    required: required({
      id: "TaskId", clientRef: "ClientRef", status: "TaskStatus", revision: "Revision", route: "Route", preset: "Preset",
      fast: "Boolean", priority: "Priority", depth: "TaskDepth", attemptCount: "AttemptCount",
      activeAttemptId: nullable("AttemptId"), latestSubmissionId: nullable("SubmissionId"),
    }), optional: optional(), rules: ["task-summary.numeric-bounds"],
  },
  NestedEffectReceipt: {
    kind: "union", closed: true, discriminator: "kind",
    variants: {
      turn_started: { required: required({ mutationAttemptId: "MutationAttemptId", accountGeneration: "AccountGeneration", turnId: "ProviderId", runtimeProfileDigest: "Sha256" }), optional: optional(), rules: [] },
      queue_created: { required: required({ mutationAttemptId: "MutationAttemptId", accountGeneration: "AccountGeneration", queueId: "QueueId" }), optional: optional(), rules: [] },
      turn_steered: { required: required({ mutationAttemptId: "MutationAttemptId", accountGeneration: "AccountGeneration", turnId: "ProviderId" }), optional: optional(), rules: [] },
    },
  },
  AttemptRecord: {
    kind: "object", closed: true,
    required: required({
      id: "AttemptId", taskId: "TaskId", actorSessionId: "SessionId", accountGeneration: "AccountGeneration", status: "AttemptStatus",
      revision: "Revision", fence: "Fence", leaseExpiresAt: nullable("UnixMilliseconds"), targetSessionId: nullable("SessionId"),
      dispatchMode: nullable("DispatchMode"), dispatchReceipt: nullable("NestedEffectReceipt"), submissionId: nullable("SubmissionId"),
      createdAt: "UnixMilliseconds", updatedAt: "UnixMilliseconds",
    }), optional: optional(), rules: ["attempt.dispatch-fields-correlate", "attempt.owner-equals-target"],
  },
  AttemptReportRecord: {
    kind: "object", closed: true,
    required: required({ idempotencyKey: "IdempotencyKey", taskId: "TaskId", attemptId: "AttemptId", reportKind: "ReportKind", report: "Report", reportDigest: "Sha256", createdAt: "UnixMilliseconds" }),
    optional: optional(), rules: ["attempt-report.kind-correlates-report", "attempt-report.idempotency-key-is-stable-public-identity"],
  },
  SubmissionRecord: {
    kind: "object", closed: true,
    required: required({
      id: "SubmissionId", taskId: "TaskId", attemptId: "AttemptId", status: "SubmissionStatus", revision: "Revision",
      summary: "Summary", result: "Result", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true), contentDigest: "Sha256",
      requiredReviews: "ReviewCount", acceptedReviews: "ReviewCount", createdAt: "UnixMilliseconds", updatedAt: "UnixMilliseconds",
    }), optional: optional(), rules: ["submission.accepted-reviews-lte-required"],
  },
  ReviewRecord: {
    kind: "object", closed: true,
    required: required({ id: "ReviewId", submissionId: "SubmissionId", reviewerSessionId: "SessionId", decision: "ReviewDecision", summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true), createdAt: "UnixMilliseconds" }),
    optional: optional(), rules: [],
  },
  SignalRecord: {
    kind: "object", closed: true,
    required: required({
      id: "SignalId", senderSessionId: "SessionId", targetSessionId: "SessionId", accountGeneration: "AccountGeneration", taskId: nullable("TaskId"),
      replyToSignalId: nullable("SignalId"), mode: "SignalMode", deliveryState: "SignalDeliveryState", deliveryReceipt: nullable("NestedEffectReceipt"),
      body: "SignalBody", revision: "Revision", createdAt: "UnixMilliseconds", acknowledgedAt: nullable("UnixMilliseconds"),
    }), optional: optional(), rules: ["signal.acknowledgement-correlates-time", "signal.receipt-correlates-mode"],
  },
  TaskDetail: {
    kind: "object", closed: true,
    required: required({
      version: literal(1), workId: "WorkId", task: "TaskSummary", spec: "TaskSpec", parentTaskId: nullable("TaskId"),
      dependencyTaskIds: list("TaskId", 0, WORK_TASK_DEPENDENCY_LIMIT, true), unmetDependencyTaskIds: list("TaskId", 0, WORK_TASK_DEPENDENCY_LIMIT, true),
      activeAttempt: nullable("AttemptRecord"), latestAttempt: nullable("AttemptRecord"), latestAttemptReport: nullable("AttemptReportRecord"),
      latestSubmission: nullable("SubmissionRecord"), latestSubmissionReviews: list("ReviewRecord", 0, WORK_EVIDENCE_LIMIT, true),
      omittedLatestSubmissionReviews: "NonnegativeSafeInteger",
      recentSignals: list("SignalRecord", 0, WORK_READ_HISTORY_LIMIT, true), omittedSignals: "NonnegativeSafeInteger", createdAt: "UnixMilliseconds", updatedAt: "UnixMilliseconds",
    }), optional: optional(), rules: ["task-detail.latest-lineage-correlates", "task-detail.history-newest-first"],
  },
  TaskHistoryCounts: {
    kind: "object", closed: true,
    required: required({ attempts: "TaskHistoryCount", attemptReports: "TaskHistoryCount", submissions: "TaskHistoryCount", reviews: "TaskHistoryCount", signals: "TaskHistoryCount" }),
    optional: optional(), rules: [],
  },
  TaskHistoryItem: {
    kind: "union", closed: true, discriminator: "kind",
    variants: {
      attempt: { required: required({ value: "AttemptRecord" }), optional: optional(), rules: [] },
      attempt_report: { required: required({ value: "AttemptReportRecord" }), optional: optional(), rules: [] },
      submission: { required: required({ value: "SubmissionRecord" }), optional: optional(), rules: [] },
      review: { required: required({ taskId: "TaskId", value: "ReviewRecord" }), optional: optional(), rules: [] },
      signal: { required: required({ value: "SignalRecord" }), optional: optional(), rules: [] },
    },
  },
  TaskHistoryPage: {
    kind: "object", closed: true,
    required: required({
      version: literal(1), kind: literal("history"), workId: "WorkId", taskId: "TaskId", taskRevision: "Revision",
      projectionAt: "UnixMilliseconds", requestedCursor: nullable("TaskHistoryCursor"), observedThroughCursor: "EventCursor",
      offset: "TaskHistoryTotalCount", totalItems: "TaskHistoryTotalCount", counts: "TaskHistoryCounts",
      items: list("TaskHistoryItem", 0, WORK_TASK_HISTORY_ITEM_LIMIT), remainingItems: "TaskHistoryTotalCount",
      remainingCounts: "TaskHistoryCounts", nextCursor: nullable("TaskHistoryCursor"),
    }),
    optional: optional(),
    rules: [
      "task-history.fixed-point-in-time-public-projection",
      "task-history.immutable-membership-ordinal-desc",
      "task-history.counts-partition",
      "task-history.cursor-progress",
      "task-history.byte-bound",
    ],
  },
  WorkSnapshot: {
    kind: "object", closed: true,
    required: required({
      version: literal(1), work: "WorkRecord", routes: list("ExecutionRoute", 1, WORK_ROUTE_LIMIT, true), cursor: "EventCursor",
      tasks: list("TaskSummary", 1, WORK_PLAN_TASK_LIMIT, true), joinedSessionIds: list("SessionId", 1, WORK_MEMBER_LIMIT, true),
      recentSignals: list("SignalRecord", 0, WORK_READ_HISTORY_LIMIT, true), omittedSignals: "NonnegativeSafeInteger", terminal: nullable("TerminalProjection"),
    }), optional: optional(), rules: ["snapshot.complete-task-plan", "snapshot.coordinator-is-member", "snapshot.history-newest-first"],
  },
  DiscardedRecordCounts: {
    kind: "object", closed: true,
    required: required({
      routes: "RouteRecordCount", members: "MemberCount", tasks: "TaskCount", dependencies: "DependencyRecordCount",
      attempts: "TaskAttemptRecordCount", reports: "EventBoundedRecordCount", submissions: "TaskAttemptRecordCount",
      reviews: "EventBoundedRecordCount", signals: "EventBoundedRecordCount", receipts: "SignalReceiptRecordCount",
      events: "EventBoundedRecordCount", intents: "EventBoundedRecordCount", effects: "EventBoundedRecordCount",
      unresolvedSignalEffects: "EventBoundedRecordCount", effectResolutions: "EffectResolutionRecordCount",
      historyIndex: "TaskHistoryMembershipCount", historyVersions: "TaskHistoryVersionCount",
    }),
    optional: optional(), rules: ["release.count-bounds"],
  },
  WorkReleaseTombstone: {
    kind: "object", closed: true,
    required: required({ version: literal(1), workId: "WorkId", clientRefDigest: "Sha256", coordinatorSessionId: "SessionId", terminalKind: "TerminalKind", terminalRequestDigest: "Sha256", releaseRequestDigest: "Sha256", finalRevision: "Revision", finalHeadHash: "Sha256", discardedRecordCounts: "DiscardedRecordCounts", discardedRecordsDigest: "Sha256", releasedAt: "UnixMilliseconds", retentionUpperBoundAt: "UnixMilliseconds", priorOperationReplayGuaranteesEnded: literal(true), releaseReplayPolicy: literal("retained_tombstone_only") }),
    optional: optional(), rules: ["release.retention-upper-bound"],
  },
  EffectStatus: {
    kind: "union", closed: true, discriminator: "kind",
    variants: {
      dispatch: { required: required({ idempotencyKey: "IdempotencyKey", subjectId: "AttemptId", targetSessionId: "SessionId", instructionDigest: "Sha256", state: "PreparedEffectState" }), optional: optional(), rules: [] },
      signal: { required: required({ idempotencyKey: "IdempotencyKey", subjectId: "SignalId", targetSessionId: "SessionId", instructionDigest: "Sha256", state: "PreparedEffectState" }), optional: optional(), rules: [] },
    },
  },
  ReviewableSubmission: {
    kind: "object", closed: true,
    required: required({ id: "SubmissionId", taskId: "TaskId", attemptId: "AttemptId", status: literal("pending_review"), revision: "Revision", contentDigest: "Sha256", requiredReviews: "PositiveReviewCount", acceptedReviews: "ReviewCount", createdAt: "UnixMilliseconds", updatedAt: "UnixMilliseconds" }),
    optional: optional(), rules: ["reviewable.accepted-reviews-lt-required"],
  },
  PollOmittedCounts: {
    kind: "object", closed: true,
    required: required({ readyTasks: "NonnegativeSafeInteger", ownedAttempts: "NonnegativeSafeInteger", recoveryAttempts: "NonnegativeSafeInteger", reviewableSubmissions: "NonnegativeSafeInteger", signals: "NonnegativeSafeInteger", preparedEffects: "NonnegativeSafeInteger" }),
    optional: optional(), rules: [],
  },
  EventGap: {
    kind: "object", closed: true,
    required: required({ reason: "EventGapReason", requestedSequence: nullable("NonnegativeSafeInteger"), retainedFromSequence: "EventSequence" }), optional: optional(), rules: [],
  },
  EventBody: {
    kind: "union", closed: true, discriminator: "type",
    variants: {
      "work.created": { required: required({ coordinatorSessionId: "SessionId", routeCount: "RouteCount", routesDigest: "Sha256", taskIds: list("TaskId", 1, WORK_OPERATION_BATCH_LIMIT, true) }), optional: optional(), rules: [] },
      "task.batch_added": { required: required({ taskIds: list("TaskId", 1, WORK_OPERATION_BATCH_LIMIT, true) }), optional: optional(), rules: [] },
      "work.joined": { required: required({ coordinatorSessionId: "SessionId", actorSessionId: "SessionId" }), optional: optional(), rules: [] },
      "task.state_changed": { required: required({ taskId: "TaskId", from: "TaskStatus", to: "TaskStatus" }), optional: optional(), rules: [] },
      "task.failed": { required: required({ taskId: "TaskId", reason: "TaskFailureReason" }), optional: optional(), rules: [] },
      "task.claimed": { required: required({ taskId: "TaskId", attemptId: "AttemptId", actorSessionId: "SessionId", fence: "Fence", leaseExpiresAt: "UnixMilliseconds" }), optional: optional(), rules: [] },
      "task.claim_next_empty": { required: required({ actorSessionId: "SessionId", route: "Route" }), optional: optional(), rules: [] },
      "attempt.renewed": { required: required({ attemptId: "AttemptId", fence: "Fence", leaseExpiresAt: "UnixMilliseconds" }), optional: optional(), rules: [] },
      "attempt.released": { required: required({ attemptId: "AttemptId", summaryDigest: "Sha256" }), optional: optional(), rules: [] },
      "attempt.expired": { required: required({ attemptId: "AttemptId", fence: "Fence" }), optional: optional(), rules: [] },
      "attempt.recovery_required": { required: required({ attemptId: "AttemptId", fence: "Fence", reason: "AttemptRecoveryReason" }), optional: optional(), rules: [] },
      "attempt.dispatch_requested": { required: required({ attemptId: "AttemptId", targetSessionId: "SessionId", mode: literal("send") }), optional: optional(), rules: [] },
      "attempt.dispatch_started": { required: required({ attemptId: "AttemptId" }), optional: optional(), rules: [] },
      "attempt.dispatch_finalized": { required: required({ attemptId: "AttemptId", outcome: "EffectOutcome" }), optional: optional(), rules: [] },
      "attempt.reported": { required: required({ attemptId: "AttemptId", reportKind: "ReportKind", submissionId: nullable("SubmissionId"), reportDigest: "Sha256", evidenceCount: "EvidenceCount" }), optional: optional(), rules: [] },
      "submission.reviewed": { required: required({ submissionId: "SubmissionId", reviewId: "ReviewId", reviewerSessionId: "SessionId", decision: "ReviewDecision", reviewDigest: "Sha256", evidenceCount: "EvidenceCount" }), optional: optional(), rules: [] },
      "signal.delivery_requested": { required: required({ signalId: "SignalId", senderSessionId: "SessionId", targetSessionId: "SessionId", taskId: nullable("TaskId"), replyToSignalId: nullable("SignalId"), mode: "SignalMode", bodyDigest: "Sha256" }), optional: optional(), rules: [] },
      "signal.delivery_started": { required: required({ signalId: "SignalId" }), optional: optional(), rules: [] },
      "signal.acknowledged": { required: required({ signalId: "SignalId", actorSessionId: "SessionId" }), optional: optional(), rules: [] },
      "signal.delivery_updated": { required: required({ signalId: "SignalId", outcome: "EffectOutcome" }), optional: optional(), rules: [] },
      "work.completed": { required: required({ requestDigest: "Sha256", evidenceCount: "EvidenceCount", resultKind: nullable("ResultKind") }), optional: optional(), rules: [] },
      "work.failed": { required: required({ requestDigest: "Sha256", evidenceCount: "EvidenceCount" }), optional: optional(), rules: [] },
      "work.failure_requested": { required: required({ requestDigest: "Sha256", evidenceCount: "EvidenceCount" }), optional: optional(), rules: [] },
      "work.cancellation_requested": { required: required({ requestDigest: "Sha256", evidenceCount: "EvidenceCount" }), optional: optional(), rules: [] },
      "work.cancelled": { required: required({ requestDigest: "Sha256", evidenceCount: "EvidenceCount" }), optional: optional(), rules: [] },
      "attempt.reconciled": { required: required({ attemptId: "AttemptId", outcome: "ReconcileOutcomeKind", submissionId: nullable("SubmissionId"), outcomeDigest: "Sha256", evidenceCount: "EvidenceCount" }), optional: optional(), rules: [] },
    },
  },
  Event: {
    kind: "object", closed: true,
    required: required({ version: literal(1), workId: "WorkId", streamEpoch: "StreamEpoch", sequence: "EventSequence", occurredAt: "UnixMilliseconds", actorSessionId: nullable("SessionId"), body: "EventBody" }),
    optional: optional(), rules: ["event.byte-bound"],
  },
  EventPage: {
    kind: "object", closed: true,
    required: required({ version: literal(1), workId: "WorkId", streamEpoch: "StreamEpoch", requestedCursor: nullable("EventCursor"), retentionFloorCursor: "EventCursor", observedThroughCursor: "EventCursor", nextCursor: "EventCursor", gap: nullable("EventGap"), events: list("Event", 0, WORK_EVENT_PAGE_LIMIT) }),
    optional: optional(), rules: ["event-page.contiguous", "event-page.checkpoint-advances", "event-page.byte-bound"],
  },
  Poll: {
    kind: "object", closed: true,
    required: required({
      version: literal(1), workId: "WorkId", actorSessionId: nullable("SessionId"), workRevision: "Revision", status: "WorkStatus", nextWakeAt: nullable("UnixMilliseconds"),
      requestedActionCursor: nullable("ActionCursor"), nextActionCursor: nullable("ActionCursor"), readyTasks: list("TaskSummary", 0, WORK_POLL_ITEM_LIMIT),
      ownedAttempts: list("AttemptRecord", 0, WORK_POLL_ITEM_LIMIT), recoveryAttempts: list("AttemptRecord", 0, WORK_POLL_ITEM_LIMIT),
      reviewableSubmissions: list("ReviewableSubmission", 0, WORK_POLL_ITEM_LIMIT), signals: list("SignalRecord", 0, WORK_POLL_ITEM_LIMIT),
      preparedEffects: list("EffectStatus", 0, WORK_POLL_ITEM_LIMIT), omitted: "PollOmittedCounts", eventPage: "EventPage",
    }), optional: optional(), rules: ["poll.actor-scope", "poll.action-continuation-correlates-omission", "poll.byte-bound"],
  },
  TerminalProjection: {
    kind: "object", closed: true,
    required: required({ kind: "TerminalKind", state: "TerminalState", actorSessionId: "SessionId", summary: "Summary", result: nullable("Result"), evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true), requestDigest: "Sha256", requestedAt: "UnixMilliseconds", settledAt: nullable("UnixMilliseconds") }),
    optional: optional(), rules: ["terminal.state-correlates-settlement", "terminal.result-only-completion"],
  },
  WorkEventStreamLine: {
    kind: "union", closed: true, discriminator: "kind",
    variants: {
      gap: { required: required({ version: literal(1), workId: "WorkId", streamEpoch: "StreamEpoch", requestedCursor: nullable("EventCursor"), retentionFloorCursor: "EventCursor", observedThroughCursor: "EventCursor", gap: "EventGap" }), optional: optional(), rules: ["stream.gap-first"] },
      event: { required: required({ version: literal(1), workId: "WorkId", event: "Event" }), optional: optional(), rules: ["stream.events-contiguous"] },
      checkpoint: { required: required({ version: literal(1), workId: "WorkId", streamEpoch: "StreamEpoch", nextCursor: "EventCursor", retentionFloorCursor: "EventCursor", observedThroughCursor: "EventCursor", eventCount: "NonnegativeSafeInteger" }), optional: optional(), rules: ["stream.checkpoint-last"] },
    },
  },
  WorkError: {
    kind: "object", closed: true,
    required: required({ code: "WorkErrorCode", message: "CommandErrorMessage", retryable: "Boolean", recovery: "RecoveryDirective", exitCode: "ExitCode" }),
    optional: optional({ entityId: "WorkEntityId", expectedRevision: "Revision", actualRevision: "Revision", retryAfterMs: "RetryAfterMilliseconds" }),
    rules: ["error.recovery-exit-matrix"],
  },
} as const satisfies Readonly<Record<z.infer<typeof workProtocolTypeNameSchema>, z.input<typeof workProtocolTypeDefinitionSchema>>>;

type FieldSpec = z.infer<typeof fieldMapSchema>;
type OperationContract = Readonly<{
  kind: typeof WORK_OPERATION_KINDS[number];
  input: Readonly<{ required: FieldSpec; optional: FieldSpec; rules: readonly string[] }>;
  output: Readonly<{ required: FieldSpec; optional: FieldSpec; rules: readonly string[] }>;
}>;

const mutationOutput = (kind: typeof WORK_OPERATION_KINDS[number], fields: FieldSpec, rules: readonly string[] = []): OperationContract["output"] => ({
  required: { kind: literal(kind), workId: "WorkId", workRevision: "Revision", ...fields },
  optional: {},
  rules,
});

const operationContracts = [
  {
    kind: "work.create",
    input: { required: { kind: literal("work.create"), idempotencyKey: "IdempotencyKey", clientRef: "ClientRef", coordinatorSessionId: "SessionId", objective: "Objective", routes: list("ExecutionRoute", 1, WORK_ROUTE_LIMIT, true), tasks: list("TaskSpec", 1, WORK_OPERATION_BATCH_LIMIT, true) }, optional: {}, rules: ["create.references-resolve-in-batch", "create.tasks-use-declared-routes"] },
    output: mutationOutput("work.create", { work: "WorkRecord", coordinatorCapability: "Capability", memberCapability: "Capability", routes: list("ExecutionRoute", 1, WORK_ROUTE_LIMIT, true), tasks: list("TaskSummary", 1, WORK_OPERATION_BATCH_LIMIT, true) }),
  },
  {
    kind: "task.addBatch",
    input: { required: { kind: literal("task.addBatch"), idempotencyKey: "IdempotencyKey", workId: "WorkId", expectedWorkRevision: "Revision", coordinatorSessionId: "SessionId", coordinatorCapability: "Capability", tasks: list("TaskSpec", 1, WORK_OPERATION_BATCH_LIMIT, true) }, optional: {}, rules: ["task-batch.graph-acyclic"] },
    output: mutationOutput("task.addBatch", { tasks: list("TaskSummary", 1, WORK_OPERATION_BATCH_LIMIT, true) }),
  },
  {
    kind: "work.join",
    input: { required: { kind: literal("work.join"), idempotencyKey: "IdempotencyKey", workId: "WorkId", coordinatorSessionId: "SessionId", coordinatorCapability: "Capability", actorSessionId: "SessionId" }, optional: {}, rules: [] },
    output: mutationOutput("work.join", { actorSessionId: "SessionId", memberCapability: "Capability" }),
  },
  {
    kind: "task.claim",
    input: { required: { kind: literal("task.claim"), idempotencyKey: "IdempotencyKey", workId: "WorkId", taskId: "TaskId", expectedTaskRevision: "Revision", actorSessionId: "SessionId", actorCapability: "Capability", leaseMs: "LeaseMilliseconds" }, optional: {}, rules: [] },
    output: mutationOutput("task.claim", { task: "TaskSummary", attempt: "AttemptRecord", attemptCapability: "Capability" }),
  },
  {
    kind: "task.claimNext",
    input: { required: { kind: literal("task.claimNext"), idempotencyKey: "IdempotencyKey", workId: "WorkId", actorSessionId: "SessionId", actorCapability: "Capability", route: "Route", leaseMs: "LeaseMilliseconds" }, optional: {}, rules: ["claim-next.exact-route"] },
    output: mutationOutput("task.claimNext", { task: nullable("TaskSummary"), attempt: nullable("AttemptRecord"), attemptCapability: nullable("Capability") }, ["claim-next.nullable-trio-correlates"]),
  },
  {
    kind: "task.claimBatch",
    input: { required: { kind: literal("task.claimBatch"), idempotencyKey: "IdempotencyKey", workId: "WorkId", claims: list("ClaimRequest", 1, WORK_OPERATION_BATCH_LIMIT, true) }, optional: {}, rules: ["claim-batch.unique-tasks-and-actors"] },
    output: mutationOutput("task.claimBatch", { claims: list("ClaimResult", 1, WORK_OPERATION_BATCH_LIMIT, true) }, ["claim-batch.results-bind-input"]),
  },
  ...(["attempt.renew", "attempt.release", "attempt.dispatch", "attempt.report", "attempt.reconcile"] as const).map((kind): OperationContract => {
    const common: FieldSpec = { kind: literal(kind), idempotencyKey: "IdempotencyKey", workId: "WorkId", attemptId: "AttemptId", expectedAttemptRevision: "Revision", fence: "Fence", actorSessionId: "SessionId", attemptCapability: "Capability" };
    if (kind === "attempt.renew") return { kind, input: { required: { ...common, leaseMs: "LeaseMilliseconds" }, optional: {}, rules: [] }, output: mutationOutput(kind, { attempt: "AttemptRecord" }) };
    if (kind === "attempt.release") return { kind, input: { required: { ...common, reason: "Summary" }, optional: {}, rules: [] }, output: mutationOutput(kind, { attempt: "AttemptRecord" }) };
    if (kind === "attempt.dispatch") return { kind, input: { required: { ...common, targetSessionId: "SessionId", mode: literal("send") }, optional: {}, rules: ["dispatch.target-is-owner", "dispatch.send-only"] }, output: mutationOutput(kind, { attempt: "AttemptRecord", effect: "EffectStatus" }) };
    if (kind === "attempt.report") return { kind, input: { required: { ...common, report: "Report" }, optional: {}, rules: ["report.matches-task-contract"] }, output: mutationOutput(kind, { attempt: "AttemptRecord", submission: nullable("SubmissionRecord") }) };
    return { kind, input: { required: { ...common, outcome: "ReconcileOutcome" }, optional: {}, rules: ["reconcile.never-redispatches"] }, output: mutationOutput(kind, { attempt: "AttemptRecord", submission: nullable("SubmissionRecord") }) };
  }),
  {
    kind: "submission.review",
    input: { required: { kind: literal("submission.review"), idempotencyKey: "IdempotencyKey", workId: "WorkId", submissionId: "SubmissionId", expectedSubmissionRevision: "Revision", expectedContentDigest: "Sha256", reviewerSessionId: "SessionId", reviewerCapability: "Capability", review: "ReviewInput" }, optional: {}, rules: ["review.no-self-review", "review.binds-content-digest"] },
    output: mutationOutput("submission.review", { submission: "SubmissionRecord", review: "ReviewRecord" }),
  },
  {
    kind: "signal.send",
    input: { required: { kind: literal("signal.send"), idempotencyKey: "IdempotencyKey", workId: "WorkId", senderSessionId: "SessionId", senderCapability: "Capability", targetSessionId: "SessionId", mode: "SignalMode", body: "SignalBody" }, optional: { taskId: "TaskId", replyToSignalId: "SignalId" }, rules: ["signal.target-must-be-member"] },
    output: mutationOutput("signal.send", { signal: "SignalRecord", effect: "EffectStatus" }),
  },
  {
    kind: "signal.ack",
    input: { required: { kind: literal("signal.ack"), idempotencyKey: "IdempotencyKey", workId: "WorkId", signalId: "SignalId", expectedSignalRevision: "Revision", actorSessionId: "SessionId", actorCapability: "Capability" }, optional: {}, rules: ["signal.ack-target-only"] },
    output: mutationOutput("signal.ack", { signal: "SignalRecord" }),
  },
  ...(["work.complete", "work.fail", "work.cancel"] as const).map((kind): OperationContract => ({
    kind,
    input: { required: { kind: literal(kind), idempotencyKey: "IdempotencyKey", workId: "WorkId", expectedWorkRevision: "Revision", actorSessionId: "SessionId", coordinatorCapability: "Capability", summary: "Summary", evidence: list("Evidence", 0, WORK_EVIDENCE_LIMIT, true) }, optional: kind === "work.complete" ? { result: "Result" } : {}, rules: ["work-terminal.coordinator-only", "work-terminal.known-dispatch-effects"] },
    output: mutationOutput(kind, { work: "WorkRecord" }),
  })),
  {
    kind: "work.release",
    input: { required: { kind: literal("work.release"), idempotencyKey: "IdempotencyKey", workId: "WorkId", expectedWorkRevision: "Revision", actorSessionId: "SessionId", coordinatorCapability: "Capability", acknowledgeDataLoss: literal(true) }, optional: {}, rules: ["release.terminal-only", "release.no-unresolved-effects"] },
    output: mutationOutput("work.release", { tombstone: "WorkReleaseTombstone" }),
  },
] as const satisfies readonly OperationContract[];

const operationContractByKind = new Map<typeof WORK_OPERATION_KINDS[number], OperationContract>(
  operationContracts.map((contract): [typeof WORK_OPERATION_KINDS[number], OperationContract] => [
    contract.kind,
    contract,
  ]),
);

const commands = {
  "work.protocol": {
    argv: ["hra", "work", "protocol"], positionals: [], output: "json",
    options: {
      "--operation": { type: "operation-kind" }, "--type": { type: "protocol-type-name" }, "--topic": { type: "protocol-topic" }, "--json": { type: "flag", redundant: true },
    },
    rules: ["at-most-one(--operation,--type,--topic)", "unknown-and-duplicate-options-rejected"], result: "ProtocolDocument",
  },
  "work.apply": {
    argv: ["hra", "work", "apply"], positionals: [], output: "json",
    options: { "--input-stdin": { type: "flag" }, "--input-fd": { type: "integer", minimum: 0, maximum: 1_048_575, excluded: [1, 2] }, "--json": { type: "flag", redundant: true } },
    rules: ["exactly-one(--input-stdin,--input-fd)", "input-must-be-non-terminal", "one-bounded-json-document", "global-idempotency-key-forbidden"], result: "ApplyResponse",
  },
  "work.snapshot": {
    argv: ["hra", "work", "snapshot"], positionals: [{ name: "work", type: "WorkId" }], output: "json",
    options: { "--actor": { type: "SessionId" }, "--json": { type: "flag", redundant: true } }, rules: ["exact-identifiers-only"], result: "WorkSnapshot",
  },
  "work.task": {
    argv: ["hra", "work", "task"], positionals: [{ name: "task", type: "TaskId" }], output: "json",
    options: {
      "--history-limit": { type: "integer", minimum: 1, maximum: WORK_TASK_HISTORY_ITEM_LIMIT, defaultWhenHistoryMode: WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT },
      "--history-cursor": { type: "TaskHistoryCursor" },
      "--json": { type: "flag", redundant: true },
    },
    rules: ["exact-identifiers-only", "either-history-option-selects-standalone-history-page", "no-history-options-selects-task-detail", "history-cursor-resumes-signed-point-in-time-cut"],
    result: "TaskDetail|TaskHistoryPage",
  },
  "work.poll": {
    argv: ["hra", "work", "poll"], positionals: [{ name: "work", type: "WorkId" }], output: "json",
    options: { "--actor": { type: "SessionId" }, "--cursor": { type: "EventCursor" }, "--action-cursor": { type: "ActionCursor" }, "--limit": { type: "integer", minimum: 1, maximum: WORK_POLL_ITEM_LIMIT, default: 20 }, "--wait-ms": { type: "integer", minimum: 0, maximum: WORK_WAIT_MAX_MS, default: 0 }, "--json": { type: "flag", redundant: true } },
    rules: ["action-cursor-implies-wait-ms-zero", "exact-identifiers-only"], result: "Poll",
  },
  "work.events": {
    argv: ["hra", "work", "events"], positionals: [{ name: "work", type: "WorkId" }], output: "json-or-jsonl-follow",
    options: { "--cursor": { type: "EventCursor" }, "--limit": { type: "integer", minimum: 1, maximum: WORK_EVENT_PAGE_LIMIT, default: WORK_EVENT_PAGE_LIMIT }, "--wait-ms": { type: "integer", minimum: 0, maximum: WORK_WAIT_MAX_MS, default: 0 }, "--json": { type: "flag" }, "--jsonl": { type: "flag" }, "--follow": { type: "flag" } },
    rules: ["json-mutually-exclusive-with-jsonl-or-follow", "jsonl-and-follow-may-be-combined", "jsonl-or-follow-selects-stream", "stream-wait-ms-positive-default-30000"], result: "EventPage|WorkEventStreamLine",
  },
  "work.watch": {
    argv: ["hra", "work", "watch"], positionals: [{ name: "work", type: "WorkId" }], output: "jsonl",
    options: { "--cursor": { type: "EventCursor" }, "--jsonl": { type: "flag", redundant: true } },
    rules: ["fixed-limit-200", "fixed-wait-ms-30000", "stdout-stream-errors-on-stderr"], result: "WorkEventStreamLine",
  },
} as const;

const errorTopic = {
  codes: ["invalid_request", "not_found", "conflict", "fence_mismatch", "lease_expired", "not_owner", "route_mismatch", "invalid_state", "limit_exceeded", "effect_unknown", "internal"],
  recoveryDirectives: ["none", "replay_exact_request", "retry_same_request", "refresh_state_then_new_request"],
  matrix: {
    invalid_request: [{ recovery: "none", retryable: false, exitCode: 2 }],
    not_found: [{ recovery: "refresh_state_then_new_request", retryable: false, exitCode: 4 }],
    conflict: [{ recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 }],
    fence_mismatch: [{ recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 }],
    lease_expired: [{ recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 }],
    not_owner: [{ recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 }],
    route_mismatch: [{ recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 }],
    invalid_state: [{ recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 }, { recovery: "none", retryable: false, exitCode: 6 }],
    limit_exceeded: [{ recovery: "none", retryable: false, exitCode: 1 }, { recovery: "none", retryable: false, exitCode: 2 }],
    effect_unknown: [{ recovery: "replay_exact_request", retryable: true, exitCode: 7 }],
    internal: [{ recovery: "none", retryable: false, exitCode: 1 }, { recovery: "retry_same_request", retryable: true, exitCode: 5 }],
  },
  invariants: [
    "effect_unknown always means replay the canonical-equivalent closed operation with the same idempotencyKey; JSON member order is immaterial",
    "retry_same_request certifies that no provider effect occurred",
    "refresh_state_then_new_request certifies the rejected request had no effect and requires a new idempotencyKey",
    "error.exitCode equals the process exit status",
  ],
} as const;

const topicValues = {
  envelopes: {
    applyRequest: { closed: true, required: { protocol: { const: WORK_PROTOCOL }, version: { const: WORK_PROTOCOL_VERSION }, requestId: "RequestId", operation: "operation selected by operation.kind" }, optional: {} },
    applySuccess: { closed: true, required: { protocol: { const: WORK_PROTOCOL }, version: { const: WORK_PROTOCOL_VERSION }, requestId: "RequestId", ok: { const: true }, result: "result selected by operation.kind" }, rules: ["requestId is non-null and exactly echoed", "result.kind equals operation.kind"] },
    applyFailure: { closed: true, required: { protocol: { const: WORK_PROTOCOL }, version: { const: WORK_PROTOCOL_VERSION }, requestId: "RequestId|null", ok: { const: false }, error: "WorkError" }, rules: ["requestId may be null only before request admission"] },
    readSuccess: { closed: true, required: { ok: { const: true }, version: { const: 1 }, command: "exact work command kind", data: "command-selected result" }, rules: ["bounded-read caps cover this exact terminal-safe compact JSON document plus LF"] },
    readFailure: { closed: true, required: { ok: { const: false }, version: { const: 1 }, error: "CommandError" }, optional: {} },
    stream: {
      stdout: "WorkEventStreamLine JSON Lines only",
      failure: "one terminal-safe compact readFailure JSON document plus LF on stderr",
      frameBytes: "limits.eventStreamLineBytes",
      failureBytes: "limits.streamFailureBytes",
      validation: "all exact safeJson-plus-LF frames for a page are bounded before its first write; cursor state advances only after every frame is written",
      gracefulExit: ["SIGINT", "SIGTERM", "closed stdout"],
      gracefulExitCode: 0,
    },
  },
  errors: errorTopic,
  events: {
    lineType: "WorkEventStreamLine",
    ordering: ["optional gap", "zero or more contiguous event lines", "one checkpoint"],
    emptyUnchangedPages: "emit no lines",
    resume: "pass checkpoint.nextCursor verbatim as --cursor",
    cursorRule: "event, action, and task-history cursors are opaque, authenticated, scope-bound, and never decoded or synthesized by callers",
    frameCommit: "validate every exact terminal-safe JSON-plus-LF frame in a page before writing any; advance the observer cursor only after all frames are written",
    gapRecovery: "refresh work.snapshot before treating the retained suffix as a complete projection, then resume from checkpoint.nextCursor",
  },
  limits: {
    activeWorks: WORK_ACTIVE_LIMIT, retainedWorks: WORK_RETAINED_LIMIT, releaseTombstones: WORK_TOMBSTONE_LIMIT,
    releaseTombstoneMaxAgeMs: WORK_TOMBSTONE_MAX_AGE_MS, releaseTombstoneBytes: WORK_TOMBSTONE_MAX_BYTES,
    planTasks: WORK_PLAN_TASK_LIMIT, membersPerWork: WORK_MEMBER_LIMIT, routesPerWork: WORK_ROUTE_LIMIT,
    historyEventsPerWork: WORK_HISTORY_EVENT_LIMIT, historyRecoveryReservePerWork: WORK_HISTORY_RECOVERY_RESERVE,
    operationTasks: WORK_OPERATION_BATCH_LIMIT, taskDependencies: WORK_TASK_DEPENDENCY_LIMIT, taskDepth: WORK_TASK_DEPTH_LIMIT,
    criteria: WORK_CRITERIA_LIMIT, criteriaBytes: WORK_CRITERIA_MAX_BYTES, evidence: WORK_EVIDENCE_LIMIT,
    inlineResultBytes: WORK_INLINE_RESULT_MAX_BYTES, artifactPathBytes: WORK_ARTIFACT_PATH_MAX_BYTES, artifactBytes: WORK_ARTIFACT_MAX_BYTES,
    operationBytes: WORK_OPERATION_MAX_BYTES, protocolRequestBytes: WORK_PROTOCOL_REQUEST_MAX_BYTES,
    preparedEffectBytes: WORK_PREPARED_EFFECT_MAX_BYTES, workerBriefBytes: WORK_WORKER_BRIEF_MAX_BYTES,
    dependencyPreviewBytes: WORK_DEPENDENCY_PREVIEW_MAX_BYTES, signalBytes: WORK_SIGNAL_MAX_BYTES,
    eventBytes: WORK_EVENT_MAX_BYTES, eventPageEvents: WORK_EVENT_PAGE_LIMIT, eventPageBytes: WORK_EVENT_PAGE_MAX_BYTES,
    eventStreamLineBytes: WORK_EVENT_STREAM_LINE_MAX_BYTES, streamFailureBytes: WORK_STREAM_FAILURE_MAX_BYTES,
    pollItems: WORK_POLL_ITEM_LIMIT, pollBytes: WORK_POLL_MAX_BYTES, readHistoryItems: WORK_READ_HISTORY_LIMIT,
    snapshotBytes: WORK_SNAPSHOT_MAX_BYTES, taskDetailBytes: WORK_TASK_DETAIL_MAX_BYTES,
    taskHistoryItems: WORK_TASK_HISTORY_ITEM_LIMIT, taskHistoryPageBytes: WORK_TASK_HISTORY_PAGE_MAX_BYTES,
    taskHistoryMembershipPerWork: WORK_TASK_HISTORY_MEMBERSHIP_LIMIT,
    taskHistoryVersionsPerWork: WORK_TASK_HISTORY_VERSION_LIMIT,
    effectResolutionsPerWork: WORK_EFFECT_RESOLUTION_LIMIT,
    waitMs: WORK_WAIT_MAX_MS, concurrentWaiters: WORK_WAITER_LIMIT, leaseMinMs: WORK_LEASE_MIN_MS, leaseMaxMs: WORK_LEASE_MAX_MS,
    jsonDepth: WORK_JSON_DEPTH_LIMIT, jsonNodes: WORK_JSON_NODE_LIMIT, jsonKeyBytes: WORK_JSON_KEY_MAX_BYTES,
    protocolDocumentBytes: WORK_PROTOCOL_DOCUMENT_MAX_BYTES,
  },
  semantics: {
    authority: { actor: "exact session ID plus scoped bearer capability", attempt: "capability plus renewable lease plus monotonically fenced revision", route: "exact accountId/projectId/preset/fast", writer: "one local SQLite execution custodian" },
    transaction: ["durably record request", "atomically begin effect", "perform provider call", "durably finalize or quarantine unknown"],
    idempotency: "same UUIDv7 plus canonical-equivalent closed operation preserves the durable decision and stable identities/capabilities, performs no new mutation or event, and reprojects mutable public records and workRevision from current state; replay is not byte-identical; retained work.release tombstone replay is the exact stored-result exception",
    sensitivity: { capability: "bearer authority; never log or expose", attemptReportIdempotencyKey: "stable public correlation identity; not authority and not a bearer secret" },
    readWireCaps: "protocolDocumentBytes, snapshotBytes, taskDetailBytes, taskHistoryPageBytes, pollBytes, and eventPageBytes bound the exact terminal-safe compact readSuccess envelope plus trailing LF; Unicode terminal-safety expansion counts",
    reconcile: { completed: "observed successful terminal outcome of the original accepted dispatch", failed: "observed failed or interrupted terminal outcome of the original accepted dispatch", no_effect: "durable proof dispatch failed before provider acceptance", still_unknown: "preserve quarantine; never speculate or redispatch" },
    polling: "event cursor and action cursor advance independently; action continuation must bind the same work, epoch, and actor and cannot long-poll",
    taskHistory: {
      cut: "the first page signs the work event sequence, membership high-water ordinal, task revision, projection time, and next offset",
      projection: "every page returns each included identity's newest append-only public record version at or before the signed event sequence",
      isolation: "later identities and later record transitions are excluded while the signed stream epoch remains retained",
      ordering: "immutable history membership ordinal descending; continuation preserves membership, order, counts, task revision, projection time, and observed-through cursor",
      progress: "a nonterminal page returns at least one item and a distinct next cursor; the full wire-response byte cap may shorten the requested page",
    },
    release: "terminal coordinator-only explicit logical destructive purge with bounded replay tombstone; history membership and public versions become unavailable, with no promise of immediate physical WAL or storage-media sanitization",
  },
  types: { names: [...WORK_PROTOCOL_TYPE_NAMES], query: "hra work protocol --type <name>" },
} as const;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

const contractSource = {
  protocol: WORK_PROTOCOL,
  version: WORK_PROTOCOL_VERSION,
  commands,
  operationContracts,
  typeDefinitions,
  topicValues,
};

export const WORK_PROTOCOL_CONTRACT_DIGEST = createHash("sha256")
  .update(canonicalJson(contractSource))
  .digest("hex");

const referencesIn = (value: unknown, output = new Set<string>()): Set<string> => {
  if (typeof value === "string") {
    if ((WORK_PROTOCOL_TYPE_NAMES as readonly string[]).includes(value)) output.add(value);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) referencesIn(item, output);
    return output;
  }
  for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) referencesIn(nested, output);
  return output;
};

const rawProtocolDocument = (query: WorkProtocolQuery) => {
  const common = {
    protocol: WORK_PROTOCOL,
    version: WORK_PROTOCOL_VERSION,
    contractDigest: WORK_PROTOCOL_CONTRACT_DIGEST,
    query,
  } as const;
  if (query.kind === "index") {
    return {
      ...common,
      result: {
        commands,
        query: {
          selectors: ["--operation", "--type", "--topic"],
          mutuallyExclusive: true,
          topics: [...WORK_PROTOCOL_TOPICS],
          operationKinds: [...WORK_OPERATION_KINDS],
          typeEntryPoints: ["TaskSpec", "Result", "Evidence", "ReconcileOutcome", "ReviewInput", "WorkRecord", "TaskDetail", "TaskHistoryPage", "Poll", "EventPage", "WorkEventStreamLine", "WorkError"],
        },
        recoveryDirectives: [...errorTopic.recoveryDirectives],
        effectUnknownRecovery: "replay_exact_request",
        applyFailureRequestId: "nullable_only_pre_admission",
        applyErrorRequiredFields: ["code", "message", "retryable", "recovery", "exitCode"],
        responseByteLimit: WORK_PROTOCOL_DOCUMENT_MAX_BYTES,
        responseByteLimitScope: "exact terminal-safe compact readSuccess envelope plus LF",
      },
    };
  }
  if (query.kind === "operation") {
    const contract = operationContractByKind.get(query.operation);
    if (contract === undefined) throw new Error("WORK_PROTOCOL_OPERATION_MISSING");
    return { ...common, result: { contract, references: [...referencesIn(contract)].sort() } };
  }
  if (query.kind === "type") {
    const definition = workProtocolTypeDefinitionSchema.parse(typeDefinitions[query.name]);
    return { ...common, result: { name: query.name, definition, references: [...referencesIn(definition)].filter((name) => name !== query.name).sort() } };
  }
  return { ...common, result: { topic: query.topic, value: topicValues[query.topic], references: [...referencesIn(topicValues[query.topic])].sort() } };
};

export type WorkProtocolDocument = ReturnType<typeof rawProtocolDocument>;

const protocolReadSuccessWireBytes = (document: WorkProtocolDocument): number =>
  utf8Bytes(`${terminalSafeJson({
    ok: true,
    version: 1,
    command: "work.protocol",
    data: document,
  })}\n`);

export const workProtocolDocumentSchema = z.object({
  protocol: z.literal(WORK_PROTOCOL),
  version: z.literal(WORK_PROTOCOL_VERSION),
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  query: workProtocolQuerySchema,
  result: z.unknown(),
}).strict().superRefine((document, context) => {
  const expected = rawProtocolDocument(document.query);
  if (canonicalJson(document) !== canonicalJson(expected)) {
    context.addIssue({ code: "custom", message: "Protocol document does not match its exact deterministic query shard." });
  }
  if (protocolReadSuccessWireBytes(expected) > WORK_PROTOCOL_DOCUMENT_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "Protocol read response exceeds its terminal-safe wire byte bound." });
  }
});

export const describeWorkProtocol = (query: WorkProtocolQuery): WorkProtocolDocument => {
  const parsedQuery = workProtocolQuerySchema.parse(query);
  return structuredClone(rawProtocolDocument(parsedQuery));
};

export const WORK_PROTOCOL_RECOVERY_DIRECTIVES = [
  "none",
  "replay_exact_request",
  "retry_same_request",
  "refresh_state_then_new_request",
] as const;

export const workProtocolRecoveryDirectiveSchema = z.enum(WORK_PROTOCOL_RECOVERY_DIRECTIVES);
export const workProtocolExitCodeSchema = z.union([
  z.literal(1), z.literal(2), z.literal(4), z.literal(5), z.literal(6), z.literal(7),
]);
export const workAgentProtocolErrorCodeSchema = z.enum([
  "invalid_request",
  "not_found",
  "conflict",
  "fence_mismatch",
  "lease_expired",
  "not_owner",
  "route_mismatch",
  "invalid_state",
  "limit_exceeded",
  "effect_unknown",
  "internal",
]);

const workErrorEntityIdSchema = z.union([
  workIdSchema,
  workTaskIdSchema,
  workAttemptIdSchema,
  workSubmissionIdSchema,
  workReviewIdSchema,
  workSignalIdSchema,
  sessionIdSchema,
]);

export const workAgentProtocolErrorSchema = z.object({
  code: workAgentProtocolErrorCodeSchema,
  message: z.string().min(1).max(2_048),
  retryable: z.boolean(),
  recovery: workProtocolRecoveryDirectiveSchema,
  exitCode: workProtocolExitCodeSchema,
  entityId: workErrorEntityIdSchema.optional(),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  actualRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  retryAfterMs: z.number().int().min(0).max(WORK_LEASE_MAX_MS).optional(),
}).strict().superRefine((error, context) => {
  const expectedRetryable = error.recovery === "replay_exact_request" || error.recovery === "retry_same_request";
  if (error.retryable !== expectedRetryable) {
    context.addIssue({ code: "custom", path: ["retryable"], message: "Retryability must match the recovery directive." });
  }
  const allowed = errorTopic.matrix[error.code];
  if (!allowed.some((entry) => entry.recovery === error.recovery && entry.retryable === error.retryable && entry.exitCode === error.exitCode)) {
    context.addIssue({ code: "custom", message: "Error code, recovery directive, retryability, and exit code do not form a published combination." });
  }
  if ((error.expectedRevision === undefined) !== (error.actualRevision === undefined)) {
    context.addIssue({ code: "custom", path: ["actualRevision"], message: "Revision conflict fields must appear together." });
  }
  if (error.expectedRevision !== undefined && error.code !== "conflict") {
    context.addIssue({ code: "custom", path: ["expectedRevision"], message: "Only conflict errors carry revision details." });
  }
  if (error.retryAfterMs !== undefined && error.recovery !== "retry_same_request") {
    context.addIssue({ code: "custom", path: ["retryAfterMs"], message: "Only a known-no-effect retry may carry retryAfterMs." });
  }
});
export type WorkAgentProtocolError = z.infer<typeof workAgentProtocolErrorSchema>;

export const workAgentProtocolResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    protocol: z.literal(WORK_PROTOCOL),
    version: z.literal(WORK_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    result: workOperationResultSchema,
  }).strict(),
  z.object({
    protocol: z.literal(WORK_PROTOCOL),
    version: z.literal(WORK_PROTOCOL_VERSION),
    requestId: z.string().uuid().nullable(),
    ok: z.literal(false),
    error: workAgentProtocolErrorSchema,
  }).strict().superRefine((response, context) => {
    if (
      response.requestId === null
      && !(
        response.error.code === "invalid_request"
        || (
          response.error.code === "invalid_state"
          && response.error.recovery === "none"
          && response.error.exitCode === 6
        )
      )
    ) {
      context.addIssue({ code: "custom", path: ["requestId"], message: "A null request ID is allowed only before request admission." });
    }
  }),
]);
export type WorkAgentProtocolResponse = z.infer<typeof workAgentProtocolResponseSchema>;
