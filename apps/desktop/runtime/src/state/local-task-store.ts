import type { Database } from "bun:sqlite";
import {
  commandEventKinds,
  derivedReady,
  dispatchRetryAllowed,
  localOwnerTaskCommandSchema,
  localWorkspaceCommandSchema,
  operationReceiptSchema,
  portableWorkspaceEventSchema,
  resolvedAmbiguousDispatchPhase,
  reviewAcceptanceAllowed,
  reviewActorAllowed,
  taskDetailProjectionSchema,
  taskDomain,
  taskListPageSchema,
  taskWorkspaceMutationResultSchema,
  transitionSubmissionLifecycle,
  validateDependencyInsertion,
  validateParentInsertion,
  workspaceSummarySchema,
  type LocalWorkspaceCommand,
  type LocalOwnerTaskCommand,
  type OperationReceipt,
  type PortableActor,
  type PortableWorkspaceEvent,
  type ProjectionActor,
  type TaskDetailProjection,
  type TaskListPage,
  type TaskWorkspaceMutationResult,
  type TaskWorkspaceView,
  type WorkspaceSummary,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { createHash, createHmac } from "node:crypto";
import {
  runtimeTaskMutationSemanticKey,
} from "../../../contracts/runtime";
import { operationReceiptKeyByteLength } from "./operation-receipt-key";

const workspaceRowSchema = z.object({
  workspace_id: taskDomain.workspacePublicIdSchema,
  name: taskDomain.workspaceNameSchema,
  slug: taskDomain.workspaceSlugSchema,
  key_prefix: taskDomain.taskKeyPrefixSchema,
  revision: taskDomain.revisionSchema,
  event_sequence: z.number().int().nonnegative().safe(),
  authority_kind: z.enum(["local", "promoting", "cloud"]),
  owner_installation_id: taskDomain.runnerInstallationIdSchema,
  promotion_id: z.string().nullable(),
  authority_phase: z.enum([
    "snapshot_frozen",
    "staging",
    "uploading",
    "activating",
    "outcome_unknown",
  ]).nullable(),
  cloud_workspace_id: z.string().nullable(),
  created_at: taskDomain.epochMsSchema,
  updated_at: taskDomain.epochMsSchema,
}).strict();

const taskRowSchema = z.object({
  workspace_id: taskDomain.workspacePublicIdSchema,
  task_id: taskDomain.taskPublicIdSchema,
  task_key: taskDomain.taskKeySchema,
  title: taskDomain.taskTitleSchema,
  task_type: taskDomain.taskTypeSchema,
  priority: taskDomain.taskPrioritySchema,
  status: taskDomain.taskStatusSchema,
  available_at: taskDomain.epochMsSchema,
  assignee_agent_id: taskDomain.agentIdSchema.nullable(),
  parent_task_id: taskDomain.taskPublicIdSchema.nullable(),
  repository_id: taskDomain.repositoryIdSchema.nullable(),
  unresolved_blocker_count: z.number().int().nonnegative().safe(),
  cancelled_blocker_count: z.number().int().nonnegative().safe(),
  revision: taskDomain.revisionSchema,
  review_revision: taskDomain.revisionSchema,
  created_at: taskDomain.epochMsSchema,
  updated_at: taskDomain.epochMsSchema,
  completed_at: taskDomain.epochMsSchema.nullable(),
  cancelled_at: taskDomain.epochMsSchema.nullable(),
}).strict();

const graphEdgeRowSchema = taskRowSchema.extend({
  dependency_created_at: taskDomain.epochMsSchema,
});

const projectionTaskRowSchema = taskRowSchema.extend({
  active_claim_id: z.string().min(1).max(128).nullable(),
  active_claim_agent_id: taskDomain.agentIdSchema.nullable(),
  active_claim_fence: taskDomain.positiveGenerationSchema.nullable(),
  active_claim_lease_generation:
    taskDomain.positiveGenerationSchema.nullable(),
  active_claim_lease_until: taskDomain.epochMsSchema.nullable(),
});

const projectionRunSummaryRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  run_id: taskDomain.dispatchIdSchema,
  phase: taskDomain.runPhaseSchema,
  updated_at: taskDomain.epochMsSchema,
  event_kind: taskDomain.publicRunEventKindSchema.nullable(),
  display_text: z.string().nullable(),
  observed_at: taskDomain.epochMsSchema.nullable(),
}).strict();

const projectionPendingInteractionRowSchema = z.object({
  task_id: taskDomain.taskPublicIdSchema,
  request_json: z.string(),
  group_count: z.number().int().positive(),
}).strict();

const projectionSelectedTaskRowSchema = projectionTaskRowSchema.extend({
  description: taskDomain.taskDescriptionSchema,
  parent_task_key: taskDomain.taskKeySchema.nullable(),
  parent_title: taskDomain.taskTitleSchema.nullable(),
  parent_priority: taskDomain.taskPrioritySchema.nullable(),
  parent_revision: taskDomain.revisionSchema.nullable(),
  parent_status: taskDomain.taskStatusSchema.nullable(),
  expired_claim_count: z.number().int().nonnegative(),
  submission_id: taskDomain.taskSubmissionIdSchema.nullable(),
  submitted_by_json: z.string().nullable(),
  submission_review_revision: taskDomain.revisionSchema.nullable(),
  submission_summary: taskDomain.submissionSummarySchema.nullable(),
  submission_evidence_json: z.string().nullable(),
  submission_status:
    z.enum(["pending", "accepted", "rejected", "cancelled"]).nullable(),
  submitted_at: taskDomain.epochMsSchema.nullable(),
  reviewed_at: taskDomain.epochMsSchema.nullable(),
  review_reason: z.string().nullable(),
});

const projectionGraphEdgeRowSchema = graphEdgeRowSchema.extend({
  direction: z.enum(["blockers", "dependents"]),
  group_count: z.number().int().positive(),
});

const projectionCommentRowSchema = z.object({
  comment_id: taskDomain.taskCommentIdSchema,
  actor_json: z.string(),
  body: taskDomain.taskCommentBodySchema,
  created_at: taskDomain.epochMsSchema,
}).strict();

const claimRowSchema = z.object({
  claim_id: z.string().min(1).max(128),
  agent_id: taskDomain.agentIdSchema,
  fence: taskDomain.positiveGenerationSchema,
  lease_generation: taskDomain.positiveGenerationSchema,
  lease_until: taskDomain.epochMsSchema,
}).strict();

const runRowSchema = z.object({
  run_id: taskDomain.dispatchIdSchema,
  task_id: taskDomain.taskPublicIdSchema,
  repository_id: taskDomain.repositoryIdSchema,
  phase: taskDomain.runPhaseSchema,
  desired_state: z.enum(["run", "stop"]),
  source_run_id: z.string().nullable(),
  retried_by_run_id: z.string().nullable(),
  claim_id: z.string().nullable(),
  fence: z.number().int().positive().nullable(),
  boot_generation: z.number().int().positive().nullable(),
  created_at: taskDomain.epochMsSchema,
  updated_at: taskDomain.epochMsSchema,
}).strict();

const runEventRowSchema = z.object({
  event_id: taskDomain.dispatchEventIdSchema,
  sequence: taskDomain.positiveGenerationSchema,
  event_kind: taskDomain.publicRunEventKindSchema,
  display_text: z.string().nullable(),
  observed_at: taskDomain.epochMsSchema,
}).strict();

const interactionRowSchema = z.object({
  interaction_id: taskDomain.runInteractionIdSchema,
  run_id: taskDomain.dispatchIdSchema,
  request_json: z.string(),
  state: z.enum(["pending", "answered", "resolved", "expired"]),
  response_revision: taskDomain.positiveGenerationSchema.nullable(),
  responded_at: taskDomain.epochMsSchema.nullable(),
  resolved_at: taskDomain.epochMsSchema.nullable(),
}).strict();

const projectionRunEventRowSchema = runEventRowSchema.extend({
  run_id: taskDomain.dispatchIdSchema,
});

const projectionRunInteractionRowSchema = interactionRowSchema.extend({
  group_count: z.number().int().positive(),
});

const receiptRowSchema = z.object({
  command_digest: z.string().regex(/^sha256_[a-f0-9]{64}$/u),
  receipt_json: z.string(),
}).strict();

type LocalRendererMutationKind = Exclude<
  z.infer<typeof taskDomain.portableTaskCommandKindSchema>,
  "task.submit" | "interaction.settle"
>;

const localRendererMutationKindSchema: z.ZodType<
  LocalRendererMutationKind
> = taskDomain.portableTaskCommandKindSchema.refine(
  (kind): kind is LocalRendererMutationKind =>
    kind !== "task.submit" &&
    kind !== "interaction.settle",
  "renderer mutation attempts cannot name host-only commands",
);

const mutationFingerprintSchema = z
  .string()
  .regex(/^sha256_[a-f0-9]{64}$/u);

const rendererMutationAttemptRowSchema = z.object({
  attempt_id: taskDomain.operationIdSchema,
  workspace_id: taskDomain.workspacePublicIdSchema,
  command_kind: localRendererMutationKindSchema,
  keyed_fingerprint: mutationFingerprintSchema,
  keyed_command_digest: mutationFingerprintSchema.nullable(),
  state: z.enum(["prepared", "effect_started", "settled"]),
  revision: taskDomain.revisionSchema,
  prepared_at: taskDomain.epochMsSchema,
  effect_started_at: taskDomain.epochMsSchema.nullable(),
  settled_at: taskDomain.epochMsSchema.nullable(),
  terminal_outcome: z
    .enum(["committed", "rejected", "not_applied"])
    .nullable(),
}).strict();

const rendererMutationQuarantineRowSchema = z.object({
  attempt_id: taskDomain.operationIdSchema,
  workspace_id: taskDomain.workspacePublicIdSchema,
  command_kind: localRendererMutationKindSchema,
  source_revision: taskDomain.revisionSchema,
  prepared_at: taskDomain.epochMsSchema,
  effect_started_at: taskDomain.epochMsSchema,
  quarantined_at: taskDomain.epochMsSchema,
  receipt_outcome: z.enum(["committed", "rejected"]),
  reason: z.literal("legacy_unbound_receipt"),
}).strict();

const prepareRendererMutationAttemptSchema = z.object({
  attemptId: taskDomain.operationIdSchema,
  workspaceId: taskDomain.workspacePublicIdSchema,
  commandKind: localRendererMutationKindSchema,
  fingerprint: mutationFingerprintSchema,
}).strict();

const rendererMutationAttemptTransitionSchema = z.object({
  attemptId: taskDomain.operationIdSchema,
  workspaceId: taskDomain.workspacePublicIdSchema,
  expectedRevision: taskDomain.revisionSchema,
}).strict();

const startRendererMutationAttemptSchema =
  rendererMutationAttemptTransitionSchema.extend({
    command: localOwnerTaskCommandSchema,
  }).strict();

const listRendererMutationAttemptsSchema = z.object({
  workspaceId: taskDomain.workspacePublicIdSchema,
  limit: z.number().int().positive().max(32),
}).strict();

const taskWorkspaceProjectionInputSchema = z.object({
  workspaceId: taskDomain.workspacePublicIdSchema,
  expectedWorkspaceRevision: taskDomain.revisionSchema,
  view: taskDomain.taskWorkspaceViewSchema,
  assignedAgentId: taskDomain.agentIdSchema.optional(),
  selectedTaskId: taskDomain.taskPublicIdSchema.nullable(),
  minimumRevision: taskDomain.revisionSchema.nullable(),
  limit: z.number().int().min(1).max(taskDomain.MAX_PORTABLE_PROJECTION_PAGE_SIZE),
}).strict().superRefine((value, context) => {
  if (value.view !== "assigned" && value.assignedAgentId !== undefined) {
    context.addIssue({
      code: "custom",
      message:
        "only assigned task-workspace projections may carry an assigned agent",
      path: ["assignedAgentId"],
    });
  }
});

const recoveryTaskWorkspaceProjectionInputSchema = z.object({
  localWorkspaceId: taskDomain.workspacePublicIdSchema,
  presentedWorkspaceId: taskDomain.workspacePublicIdSchema,
  expectedWorkspaceRevision: taskDomain.revisionSchema,
  view: taskDomain.taskWorkspaceViewSchema,
  assignedAgentId: taskDomain.agentIdSchema.optional(),
  selectedTaskId: taskDomain.taskPublicIdSchema.nullable(),
  minimumRevision: taskDomain.revisionSchema.nullable(),
  limit: z.number().int().min(1).max(taskDomain.MAX_PORTABLE_PROJECTION_PAGE_SIZE),
}).strict().superRefine((value, context) => {
  if (value.view !== "assigned" && value.assignedAgentId !== undefined) {
    context.addIssue({
      code: "custom",
      message:
        "only assigned recovery projections may carry an assigned agent",
      path: ["assignedAgentId"],
    });
  }
});

const eventRowSchema = z.object({
  event_json: z.string(),
}).strict();

const listCursorSchema = z.object({
  version: z.literal(1),
  workspaceId: taskDomain.workspacePublicIdSchema,
  view: taskDomain.taskWorkspaceViewSchema,
  assignedAgentId: taskDomain.agentIdSchema.nullable(),
  projectionRevision: taskDomain.revisionSchema,
  observedAt: taskDomain.epochMsSchema,
  updatedAt: taskDomain.epochMsSchema,
  taskId: taskDomain.taskPublicIdSchema,
}).strict();

const repositoryRegistrationSchema = z.object({
  repositoryId: taskDomain.repositoryIdSchema,
  name: taskDomain.repositoryNameSchema,
  provider: taskDomain.repositoryProviderSchema.optional(),
  publicUrl: taskDomain.absoluteHttpsUrlSchema.optional(),
  canonicalRepositoryPath: z.string().min(1),
  canonicalGitCommonDir: z.string().min(1),
}).strict();

const workspaceCreationSchema = z.object({
  workspaceId: taskDomain.workspacePublicIdSchema,
  installationId: taskDomain.runnerInstallationIdSchema,
  name: taskDomain.workspaceNameSchema,
  slug: taskDomain.workspaceSlugSchema,
  keyPrefix: taskDomain.taskKeyPrefixSchema,
  repositoryIds: z.array(taskDomain.repositoryIdSchema).max(128),
  builtinAgentId: taskDomain.agentIdSchema.default("builtin_local_codex"),
}).strict().superRefine((input, context) => {
  if (new Set(input.repositoryIds).size !== input.repositoryIds.length) {
    context.addIssue({
      code: "custom",
      message: "workspace repositories must be unique",
      path: ["repositoryIds"],
    });
  }
});

const projectOnboardingSchema = z.object({
  installationId: taskDomain.runnerInstallationIdSchema,
  repository: repositoryRegistrationSchema,
  workspace: z.object({
    workspaceId: taskDomain.workspacePublicIdSchema,
    name: taskDomain.workspaceNameSchema,
    slug: taskDomain.workspaceSlugSchema,
    keyPrefix: taskDomain.taskKeyPrefixSchema,
    builtinAgentId: taskDomain.agentIdSchema.default("builtin_local_codex"),
  }).strict(),
}).strict();

const workspaceEventPageRequestSchema = z.object({
  workspaceId: taskDomain.workspacePublicIdSchema,
  afterSequence: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();

export const MAX_LOCAL_WORKSPACE_SUMMARIES = 64;

export interface WorkspaceEventPage {
  readonly workspaceId: string;
  readonly events: readonly PortableWorkspaceEvent[];
  readonly hasMore: boolean;
  readonly nextSequence: number | null;
}

export interface LocalRepositorySafeSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface LocalWorkspaceRepositoryPage {
  readonly workspaceId: string;
  readonly projectionRevision: number;
  readonly repositories: readonly Readonly<{
    id: string;
    name: string;
    ready: boolean;
  }>[];
}

export interface LocalTaskWorkspaceProjection {
  readonly agents: readonly Readonly<{
    id: string;
    name: string;
    status: "active" | "disabled";
  }>[];
  readonly hasReadyRepository: boolean;
  readonly now: number;
  readonly projection: z.infer<
    typeof taskDomain.taskWorkspaceProjectionBundleSchema
  >;
  readonly repositories: LocalWorkspaceRepositoryPage["repositories"];
  readonly viewer: Readonly<{
    id: string;
    kind: "local_owner";
    name: "You";
  }>;
  readonly workspace: WorkspaceSummary;
}

export interface LocalProjectOnboardingResult {
  readonly repository: LocalRepositorySafeSummary;
  readonly workspace: WorkspaceSummary;
}

/** Gateway-private repository authority for an interactive coding pane. */
export interface LocalChatRepositoryRuntime {
  readonly id: string;
  readonly name: string;
  readonly canonicalRepositoryPath: string;
}

export interface LocalTaskExecutionDisposition {
  readonly receipt: OperationReceipt;
  readonly replayed: boolean;
}

interface LocalRendererMutationAttemptBase {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly commandKind: LocalRendererMutationKind;
  readonly revision: number;
  readonly preparedAt: number;
}

export type LocalRendererMutationAttempt =
  | Readonly<LocalRendererMutationAttemptBase & {
      state: "prepared";
    }>
  | Readonly<LocalRendererMutationAttemptBase & {
      state: "effect_started";
      effectStartedAt: number;
    }>
  | Readonly<LocalRendererMutationAttemptBase & {
      state: "settled";
      effectStartedAt: number | null;
      settledAt: number;
      terminalOutcome: "committed" | "rejected" | "not_applied";
    }>;

type LocalRendererMutationQuarantine = Readonly<
  LocalRendererMutationAttemptBase & {
    state: "quarantined";
    effectStartedAt: number;
    quarantinedAt: number;
    terminalOutcome: "ambiguous";
    reason: "legacy_unbound_receipt";
  }
>;

type LocalRendererMutationResolution =
  | Readonly<{
      outcome: "committed";
      mutation: TaskWorkspaceMutationResult;
    }>
  | Readonly<{
      outcome: "rejected";
      code: Extract<OperationReceipt, { outcome: "rejected" }>["code"];
    }>
  | Readonly<{
      outcome: "not_applied";
    }>
  | Readonly<{
      outcome: "ambiguous";
      reason: "legacy_unbound_receipt";
    }>;

export type LocalRendererMutationInspection = Readonly<{
  attempt: LocalRendererMutationAttempt | LocalRendererMutationQuarantine;
  receipt: OperationReceipt | null;
  resolution: LocalRendererMutationResolution;
}>;

export type LocalRendererMutationReconciliation =
  & Omit<LocalRendererMutationInspection, "attempt">
  & Readonly<{
    attempt:
      | Extract<LocalRendererMutationAttempt, { state: "settled" }>
      | LocalRendererMutationQuarantine;
  }>;

export class LocalTaskStoreError extends Error {
  readonly code:
    | "authority_mismatch"
    | "revision_conflict"
    | "invalid_state"
    | "graph_cycle"
    | "graph_limit"
    | "not_found"
    | "terminal"
    | "capacity_full";

  constructor(code: LocalTaskStoreError["code"], message: string) {
    super(message);
    this.name = "LocalTaskStoreError";
    this.code = code;
  }
}

function workspaceAuthority(workspace: z.infer<typeof workspaceRowSchema>): unknown {
  switch (workspace.authority_kind) {
    case "local":
      return {
        kind: "local",
        localWorkspaceId: workspace.workspace_id,
        ownerInstallationId: workspace.owner_installation_id,
      };
    case "promoting":
      if (workspace.promotion_id === null || workspace.authority_phase === null) {
        throw new Error("Promoting workspace is missing durable authority fields");
      }
      return {
        kind: "promoting",
        localWorkspaceId: workspace.workspace_id,
        promotionId: workspace.promotion_id,
        phase: workspace.authority_phase,
      };
    case "cloud":
      if (workspace.cloud_workspace_id === null) {
        throw new Error("Cloud workspace is missing its durable cloud identity");
      }
      return {
        kind: "cloud",
        cloudWorkspaceId: workspace.cloud_workspace_id,
      };
  }
}

function actorForCommand(command: LocalWorkspaceCommand): PortableActor {
  if ("authority" in command) {
    return {
      kind: "local_owner",
      installationId: command.authority.installationId,
    };
  }
  return {
    kind: "system",
    jobKind: taskDomain.systemCommandActorJobKinds[command.kind],
  };
}

function projectionActor(actor: PortableActor): ProjectionActor {
  switch (actor.kind) {
    case "local_owner":
      return taskDomain.projectionActorSchema.parse({
        kind: "local_owner",
        id: actor.installationId,
        name: "Local owner",
      });
    case "agent":
      return taskDomain.projectionActorSchema.parse({
        kind: "agent",
        id: actor.agentId,
        name: "Local Codex",
        status: "active",
      });
    case "system":
      return taskDomain.projectionActorSchema.parse({
        kind: "system",
        id: `system_${actor.jobKind}`,
        jobKind: actor.jobKind,
      });
  }
}

function commandWorkspaceId(command: LocalWorkspaceCommand): string {
  return "authority" in command ? command.authority.workspaceId : command.workspaceId;
}

function digestJson(value: unknown, key: Uint8Array): string {
  return `sha256_${createHmac("sha256", key).update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")}}`;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new TypeError("Local task commands must contain only JSON values");
  }
  throw new TypeError("Local task commands must contain only JSON values");
}

function rendererMutationSemanticFingerprint(
  command: LocalOwnerTaskCommand,
): string {
  const { authority, ...intent } = command;
  void authority;
  return `sha256_${createHash("sha256")
    .update(runtimeTaskMutationSemanticKey(command.kind, intent))
    .digest("hex")}`;
}

function rendererMutationCommandDigest(
  command: LocalOwnerTaskCommand,
  key: Uint8Array,
): string {
  return digestJson({
    actor: actorForCommand(command),
    command,
  }, key);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function deterministicPublicId(prefix: string, seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  let value = BigInt(`0x${hex}`);
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (CROCKFORD[Number(value & 31n)] ?? "0") + locator;
    value >>= 5n;
  }
  return `${prefix}_${locator}`;
}

function deterministicOpaqueId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

function rendererMutationAttempt(
  value: unknown,
): LocalRendererMutationAttempt {
  const row = rendererMutationAttemptRowSchema.parse(value);
  const base = {
    attemptId: row.attempt_id,
    workspaceId: row.workspace_id,
    commandKind: row.command_kind,
    revision: row.revision,
    preparedAt: row.prepared_at,
  } as const;
  switch (row.state) {
    case "prepared":
      if (
        row.effect_started_at !== null ||
        row.settled_at !== null ||
        row.terminal_outcome !== null
      ) {
        throw new Error("Prepared renderer mutation attempt is internally inconsistent");
      }
      return { ...base, state: "prepared" };
    case "effect_started":
      if (
        row.effect_started_at === null ||
        row.settled_at !== null ||
        row.terminal_outcome !== null
      ) {
        throw new Error("Started renderer mutation attempt is internally inconsistent");
      }
      return {
        ...base,
        state: "effect_started",
        effectStartedAt: row.effect_started_at,
      };
    case "settled":
      if (row.settled_at === null || row.terminal_outcome === null) {
        throw new Error("Settled renderer mutation attempt is internally inconsistent");
      }
      return {
        ...base,
        state: "settled",
        effectStartedAt: row.effect_started_at,
        settledAt: row.settled_at,
        terminalOutcome: row.terminal_outcome,
      };
  }
}

function rendererMutationQuarantine(
  value: unknown,
): LocalRendererMutationQuarantine {
  const row = rendererMutationQuarantineRowSchema.parse(value);
  return {
    attemptId: row.attempt_id,
    workspaceId: row.workspace_id,
    commandKind: row.command_kind,
    revision: row.source_revision + 1,
    preparedAt: row.prepared_at,
    state: "quarantined",
    effectStartedAt: row.effect_started_at,
    quarantinedAt: row.quarantined_at,
    terminalOutcome: "ambiguous",
    reason: row.reason,
  };
}

function mutationForCommittedReceipt(
  receipt: Extract<OperationReceipt, { outcome: "committed" }>,
): TaskWorkspaceMutationResult {
  return taskWorkspaceMutationResultSchema.parse({
    operationId: receipt.operationId,
    workspaceId: receipt.workspaceId,
    commandKind: receipt.commandKind,
    workspaceRevision: receipt.workspaceRevision,
    projectionRevision: receipt.workspaceRevision,
    result: receipt.result,
  });
}

function taskListFilterSql(
  view: TaskWorkspaceView,
  assignedAgentId?: string,
): string {
  switch (view) {
    case "all":
      return "1 = 1";
    case "ready":
      return `status = 'open' AND available_at <= ?2
        AND unresolved_blocker_count = 0 AND cancelled_blocker_count = 0`;
    case "blocked":
      return "unresolved_blocker_count + cancelled_blocker_count > 0";
    case "deferred":
      return "status = 'open' AND available_at > ?2";
    case "attention":
      return `cancelled_blocker_count > 0
        OR (status = 'done' AND unresolved_blocker_count > 0)`;
    case "assigned":
      return assignedAgentId === undefined
        ? "assignee_agent_id IS NOT NULL"
        : "assignee_agent_id = ?3";
    case "review":
      return "status = 'in_review'";
  }
}

function encodeListCursor(cursorValue: unknown): string {
  const cursor = listCursorSchema.parse(cursorValue);
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeListCursor(value: string): z.infer<typeof listCursorSchema> {
  try {
    return listCursorSchema.parse(
      parseJson(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new LocalProjectionRevisionConflict(0);
  }
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function boundedCount(value: number): Readonly<{ capped: boolean; value: number }> {
  const maximum = 100_000;
  return value > maximum
    ? { capped: true, value: maximum }
    : { capped: false, value };
}

function projectionTaskClaim(
  task: z.infer<typeof projectionTaskRowSchema>,
): z.infer<typeof claimRowSchema> | null {
  const values = [
    task.active_claim_id,
    task.active_claim_agent_id,
    task.active_claim_fence,
    task.active_claim_lease_generation,
    task.active_claim_lease_until,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) {
    throw new Error("Active local task claim projection is incomplete");
  }
  return claimRowSchema.parse({
    claim_id: task.active_claim_id,
    agent_id: task.active_claim_agent_id,
    fence: task.active_claim_fence,
    lease_generation: task.active_claim_lease_generation,
    lease_until: task.active_claim_lease_until,
  });
}

function projectionTaskView(
  task: z.infer<typeof projectionTaskRowSchema>,
  now: number,
): unknown {
  const base = {
    id: task.task_id,
    key: task.task_key,
    title: task.title,
    type: task.task_type,
    priority: task.priority,
    availableAt: task.available_at,
    isReady: derivedReady({
      status: task.status,
      availableAt: task.available_at,
      now,
      unresolved: task.unresolved_blocker_count,
      cancelled: task.cancelled_blocker_count,
    }),
    unresolvedBlockerCount: task.unresolved_blocker_count,
    cancelledBlockerCount: task.cancelled_blocker_count,
    revision: task.revision,
    reviewRevision: task.review_revision,
    ...(task.assignee_agent_id === null
      ? {}
      : { assigneeAgentId: task.assignee_agent_id }),
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    status: task.status,
  };
  if (task.status !== "in_progress") {
    return taskDomain.taskViewSchema.parse(base);
  }
  const claim = projectionTaskClaim(task);
  if (claim === null) {
    throw new Error("In-progress local task is missing its active claim");
  }
  return taskDomain.taskViewSchema.parse({
    ...base,
    currentClaim: {
      id: claim.claim_id,
      agentId: claim.agent_id,
      fence: claim.fence,
      leaseGeneration: claim.lease_generation,
      leaseUntil: claim.lease_until,
    },
  });
}

function projectionTaskLink(task: z.infer<typeof taskRowSchema>): unknown {
  return {
    id: task.task_id,
    key: task.task_key,
    priority: task.priority,
    revision: task.revision,
    status: task.status,
    title: task.title,
  };
}

function projectionHumanInput(
  requestJsonValues: readonly string[],
): unknown {
  if (requestJsonValues.length === 0) return null;
  if (
    requestJsonValues.length >
      taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT
  ) {
    throw new Error("Task pending interaction projection exceeds its bound");
  }
  const requests = requestJsonValues.map((value) =>
    taskDomain.portableRunInteractionRequestSchema.parse(parseJson(value))
  );
  const first = requests[0];
  if (first === undefined) return null;
  return {
    pendingCount: requests.length,
    oldestRequestedAt: Math.min(...requests.map(({ createdAt }) => createdAt)),
    expiresAt: Math.min(...requests.map(({ expiresAt }) => expiresAt)),
    kind: first.kind === "file_change_approval" ? "approval" : "user_input",
    preview: first.kind === "file_change_approval"
      ? "File change approval requested."
      : first.questions[0]?.prompt ?? "User input requested.",
  };
}

function eventSummary(
  event: Extract<PortableWorkspaceEvent, { kind: "task.changed" }>,
): string {
  const summaries: Record<z.infer<typeof taskDomain.taskEventTypeSchema>, string> = {
    "task.created": "Task created.",
    "task.deferred": "Task deferred.",
    "task.became_ready": "Task became ready.",
    "task.claimed": "Task claimed.",
    "task.claim_renewed": "Task claim renewed.",
    "task.claim_released": "Task claim released.",
    "task.claim_expired": "Task claim expired.",
    "task.reclaimed": "Task reclaimed.",
    "task.submitted": "Task submitted for review.",
    "task.accepted": "Submission accepted.",
    "task.rejected": "Submission rejected.",
    "task.updated": "Task updated.",
    "task.cancelled": "Task cancelled.",
    "task.reopened": "Task reopened.",
    "task.assigned": "Task assignment changed.",
    "task.parent_set": "Parent task set.",
    "task.parent_cleared": "Parent task cleared.",
    "task.label_added": "Task label added.",
    "task.label_removed": "Task label removed.",
    "task.comment_added": "Comment added.",
    "task.reference_added": "Reference added.",
    "task.reference_removed": "Reference removed.",
    "dependency.added": "Blocking dependency added.",
    "dependency.removed": "Blocking dependency removed.",
  };
  return summaries[event.eventType];
}

export class LocalOperationConflict extends Error {
  constructor() {
    super("Operation ID was already committed with another command digest");
    this.name = "LocalOperationConflict";
  }
}

export class LocalMutationAttemptConflict extends Error {
  constructor(message = "Mutation attempt metadata conflicts with durable state") {
    super(message);
    this.name = "LocalMutationAttemptConflict";
  }
}

export class LocalOnboardingConflict extends Error {
  constructor() {
    super("Project onboarding identity conflicts with durable local state");
    this.name = "LocalOnboardingConflict";
  }
}

export class LocalOnboardingIdentifierCollision extends Error {
  readonly retryable = true;

  constructor() {
    super("Project onboarding candidate identifier collides with durable local state");
    this.name = "LocalOnboardingIdentifierCollision";
  }
}

export class LocalProjectionRevisionConflict extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("Task page continuation revision is stale");
    this.name = "LocalProjectionRevisionConflict";
    this.currentRevision = currentRevision;
  }
}

type EventDraft =
  | Readonly<{
      kind: "task.changed";
      taskId: string;
      taskRevision: number;
      eventType: taskDomain.TaskEventType;
    }>
  | Readonly<{
      kind: "workspace.renamed";
    }>
  | Readonly<{
      kind: "run.changed";
      taskId: string;
      runId: string;
      phase: taskDomain.RunPhase;
    }>
  | Readonly<{
      kind: "interaction.changed";
      taskId: string;
      runId: string;
      interactionId: string;
      state: "pending" | "answered" | "resolved" | "expired";
    }>
  | Readonly<{
      kind: "system.defer_woke";
      taskId: string;
      scheduledFor: number;
    }>
  | Readonly<{
      kind: "system.claim_expired";
      taskId: string;
      claimId: string;
      fence: number;
    }>
  | Readonly<{
      kind: "system.run_reconciled";
      runId: string;
      bootGeneration: number;
    }>
  | Readonly<{
      kind: "system.interaction_expired";
      runId: string;
      interactionId: string;
    }>
  | Readonly<{
      kind: "system.workspace_repaired";
    }>;

interface AppliedCommand {
  readonly result: OperationReceipt extends infer Receipt
    ? Receipt extends { outcome: "committed"; result: infer Result }
      ? Result
      : never
    : never;
  readonly events: readonly EventDraft[];
}

export class LocalTaskStore {
  readonly #database: Database;
  readonly #fingerprintKey: Uint8Array;

  constructor(database: Database, fingerprintKey: Uint8Array) {
    if (fingerprintKey.byteLength !== operationReceiptKeyByteLength) {
      throw new Error("Local task operation-receipt key has an invalid length");
    }
    this.#database = database;
    this.#fingerprintKey = Uint8Array.from(fingerprintKey);
  }

  registerInstallation(installationIdValue: string, nowValue = Date.now()): void {
    const installationId = taskDomain.runnerInstallationIdSchema.parse(installationIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    this.#database.query(`
      INSERT INTO local_installations (installation_id, created_at, updated_at)
      VALUES (?1, ?2, ?2)
      ON CONFLICT(installation_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(installationId, now);
  }

  registerRepository(inputValue: unknown, nowValue = Date.now()): void {
    const input = repositoryRegistrationSchema.parse(inputValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    this.#database.query(`
      INSERT INTO local_repositories (
        repository_id, name, provider, public_url, canonical_repository_path,
        canonical_git_common_dir, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
      ON CONFLICT(repository_id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        public_url = excluded.public_url,
        canonical_repository_path = excluded.canonical_repository_path,
        canonical_git_common_dir = excluded.canonical_git_common_dir,
        tombstoned_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      input.repositoryId,
      input.name,
      input.provider ?? null,
      input.publicUrl ?? null,
      input.canonicalRepositoryPath,
      input.canonicalGitCommonDir,
      now,
    );
  }

  chatRepositoryRuntime(repositoryIdValue: string): LocalChatRepositoryRuntime | null {
    const repositoryId = taskDomain.repositoryIdSchema.parse(repositoryIdValue);
    const value: unknown = this.#database.query(`
      SELECT repository_id, name, canonical_repository_path
      FROM local_repositories
      WHERE repository_id = ?1 AND tombstoned_at IS NULL
      LIMIT 1
    `).get(repositoryId);
    const row = z.object({
      repository_id: taskDomain.repositoryIdSchema,
      name: taskDomain.repositoryNameSchema,
      canonical_repository_path: z.string().min(1).max(4_096),
    }).strict().nullable().parse(value);
    return row === null
      ? null
      : {
          id: row.repository_id,
          name: row.name,
          canonicalRepositoryPath: row.canonical_repository_path,
        };
  }

  onboardProject(inputValue: unknown, nowValue = Date.now()):
    LocalProjectOnboardingResult {
    const input = projectOnboardingSchema.parse(inputValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    return this.#database.transaction(() => {
      const installation = this.#database.query(
        "SELECT installation_id FROM local_installations WHERE installation_id = ?1",
      ).get(input.installationId);
      if (installation === null) {
        throw new LocalTaskStoreError("not_found", "Local installation is not registered");
      }
      const repositoryRowSchema = z.object({
        repository_id: taskDomain.repositoryIdSchema,
        name: taskDomain.repositoryNameSchema,
        provider: taskDomain.repositoryProviderSchema.nullable(),
        public_url: taskDomain.absoluteHttpsUrlSchema.nullable(),
        canonical_repository_path: z.string().min(1),
        canonical_git_common_dir: z.string().min(1),
        created_at: taskDomain.epochMsSchema,
        tombstoned_at: taskDomain.epochMsSchema.nullable(),
      }).strict();
      const canonicalValues: unknown[] = this.#database.query(`
        SELECT repository_id, name, provider, public_url, canonical_repository_path,
          canonical_git_common_dir, created_at, tombstoned_at
        FROM local_repositories
        WHERE canonical_repository_path = ?1
          OR canonical_git_common_dir = ?2
        ORDER BY repository_id
      `).all(
        input.repository.canonicalRepositoryPath,
        input.repository.canonicalGitCommonDir,
      );
      const canonicalRows = canonicalValues.map((value) => repositoryRowSchema.parse(value));
      const exact = canonicalRows.filter((row) =>
        row.canonical_repository_path === input.repository.canonicalRepositoryPath &&
        row.canonical_git_common_dir === input.repository.canonicalGitCommonDir);
      if (exact.length === 1) {
        const repository = exact[0];
        if (repository === undefined || repository.tombstoned_at !== null) {
          throw new LocalOnboardingConflict();
        }
        const workspaceValue: unknown = this.#database.query(`
          SELECT local_workspaces.workspace_id, local_workspaces.name,
            local_workspaces.slug, local_workspaces.key_prefix,
            local_workspaces.revision, local_workspaces.event_sequence,
            local_workspaces.authority_kind, local_workspaces.owner_installation_id,
            local_workspaces.promotion_id, local_workspaces.authority_phase,
            local_workspaces.cloud_workspace_id, local_workspaces.created_at,
            local_workspaces.updated_at
          FROM local_workspace_repositories
          JOIN local_workspaces
            ON local_workspaces.workspace_id =
              local_workspace_repositories.workspace_id
          WHERE local_workspace_repositories.repository_id = ?1
            AND local_workspaces.tombstoned_at IS NULL
          ORDER BY local_workspaces.created_at, local_workspaces.workspace_id
          LIMIT 1
        `).get(repository.repository_id);
        const existingWorkspace = workspaceRowSchema.nullable().parse(workspaceValue);
        if (existingWorkspace === null) throw new LocalOnboardingConflict();
        return {
          repository: {
            id: repository.repository_id,
            name: repository.name,
            createdAt: repository.created_at,
          },
          workspace: this.#workspaceSummary(existingWorkspace, now),
        };
      }
      if (canonicalRows.length > 0) {
        throw new LocalOnboardingConflict();
      }
      const identifierCollision: unknown = this.#database.query(`
        SELECT 'repository' AS source FROM local_repositories WHERE repository_id = ?1
        UNION ALL
        SELECT 'workspace' AS source FROM local_workspaces
        WHERE workspace_id = ?2 OR slug = ?3 OR key_prefix = ?4
        LIMIT 1
      `).get(
        input.repository.repositoryId,
        input.workspace.workspaceId,
        input.workspace.slug,
        input.workspace.keyPrefix,
      );
      if (identifierCollision !== null) {
        throw new LocalOnboardingIdentifierCollision();
      }
      this.#requireWorkspaceCapacity();
      try {
        this.#database.query(`
          INSERT INTO local_repositories (
            repository_id, name, provider, public_url, canonical_repository_path,
            canonical_git_common_dir, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
        `).run(
          input.repository.repositoryId,
          input.repository.name,
          input.repository.provider ?? null,
          input.repository.publicUrl ?? null,
          input.repository.canonicalRepositoryPath,
          input.repository.canonicalGitCommonDir,
          now,
        );
        this.#database.query(`
          INSERT INTO local_workspaces (
            workspace_id, name, slug, key_prefix, authority_kind,
            owner_installation_id, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, 'local', ?5, ?6, ?6)
        `).run(
          input.workspace.workspaceId,
          input.workspace.name,
          input.workspace.slug,
          input.workspace.keyPrefix,
          input.installationId,
          now,
        );
        this.#database.query(`
          INSERT INTO local_workspace_repositories (
            workspace_id, repository_id, created_at
          ) VALUES (?1, ?2, ?3)
        `).run(input.workspace.workspaceId, input.repository.repositoryId, now);
        this.#database.query(`
          INSERT INTO local_builtin_executors (
            workspace_id, agent_id, enabled, created_at, updated_at
          ) VALUES (?1, ?2, 1, ?3, ?3)
        `).run(input.workspace.workspaceId, input.workspace.builtinAgentId, now);
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes("constraint failed")) {
          throw new LocalOnboardingIdentifierCollision();
        }
        throw error;
      }
      const repository = {
        repository_id: input.repository.repositoryId,
        name: input.repository.name,
        created_at: now,
      };
      return {
        repository: {
          id: repository.repository_id,
          name: repository.name,
          createdAt: repository.created_at,
        },
        workspace: this.#workspaceSummary(
          this.#workspace(input.workspace.workspaceId),
          now,
        ),
      };
    })();
  }

  createWorkspace(inputValue: unknown, nowValue = Date.now()): WorkspaceSummary {
    const input = workspaceCreationSchema.parse(inputValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    this.#database.transaction(() => {
      this.#requireWorkspaceCapacity();
      const installation = this.#database.query(
        "SELECT installation_id FROM local_installations WHERE installation_id = ?1",
      ).get(input.installationId);
      if (installation === null) {
        throw new LocalTaskStoreError("not_found", "Local installation is not registered");
      }
      for (const repositoryId of input.repositoryIds) {
        const repository = this.#database.query(`
          SELECT repository_id FROM local_repositories
          WHERE repository_id = ?1 AND tombstoned_at IS NULL
        `).get(repositoryId);
        if (repository === null) {
          throw new LocalTaskStoreError("not_found", "Workspace repository is not registered");
        }
      }
      this.#database.query(`
        INSERT INTO local_workspaces (
          workspace_id, name, slug, key_prefix, authority_kind,
          owner_installation_id, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'local', ?5, ?6, ?6)
      `).run(
        input.workspaceId,
        input.name,
        input.slug,
        input.keyPrefix,
        input.installationId,
        now,
      );
      for (const repositoryId of input.repositoryIds) {
        this.#database.query(`
          INSERT INTO local_workspace_repositories (workspace_id, repository_id, created_at)
          VALUES (?1, ?2, ?3)
        `).run(input.workspaceId, repositoryId, now);
      }
      this.#database.query(`
        INSERT INTO local_builtin_executors (
          workspace_id, agent_id, enabled, created_at, updated_at
        ) VALUES (?1, ?2, 1, ?3, ?3)
      `).run(input.workspaceId, input.builtinAgentId, now);
    })();
    return this.#workspaceSummary(this.#workspace(input.workspaceId), now);
  }

  listWorkspaceSummaries(nowValue = Date.now()): readonly WorkspaceSummary[] {
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const values: unknown[] = this.#database.query(`
      SELECT workspace_id, name, slug, key_prefix, revision, event_sequence,
        authority_kind, owner_installation_id, promotion_id, authority_phase,
        cloud_workspace_id, created_at, updated_at
      FROM local_workspaces
      WHERE tombstoned_at IS NULL
      ORDER BY created_at, workspace_id
      LIMIT 65
    `).all();
    if (values.length > MAX_LOCAL_WORKSPACE_SUMMARIES) {
      throw new LocalTaskStoreError(
        "capacity_full",
        "Local workspace summary projection exceeds its bound",
      );
    }
    return values.map((value) => this.#workspaceSummary(workspaceRowSchema.parse(value), now));
  }

  recoveryWorkspaceSummary(
    localWorkspaceIdValue: string,
    presentedWorkspaceIdValue: string,
    nowValue = Date.now(),
  ): WorkspaceSummary {
    const localWorkspaceId = taskDomain.workspacePublicIdSchema.parse(
      localWorkspaceIdValue,
    );
    const presentedWorkspaceId = taskDomain.workspacePublicIdSchema.parse(
      presentedWorkspaceIdValue,
    );
    const summary = this.#workspaceSummary(
      this.#workspace(localWorkspaceId),
      taskDomain.epochMsSchema.parse(nowValue),
    );
    if (summary.id !== presentedWorkspaceId) {
      throw new LocalTaskStoreError(
        "authority_mismatch",
        "Recovery presentation does not match cloud authority",
      );
    }
    return summary;
  }

  recoveryTaskWorkspaceContextBase(
    localWorkspaceIdValue: string,
    presentedWorkspaceIdValue: string,
  ): ReturnType<LocalTaskStore["taskWorkspaceContextBase"]> {
    const localWorkspaceId = taskDomain.workspacePublicIdSchema.parse(
      localWorkspaceIdValue,
    );
    const presentedWorkspaceId = taskDomain.workspacePublicIdSchema.parse(
      presentedWorkspaceIdValue,
    );
    return {
      ...this.taskWorkspaceContextBase(localWorkspaceId),
      workspaceId: presentedWorkspaceId,
    };
  }

  recoveryLookupTask(
    localWorkspaceIdValue: string,
    taskKey: string,
  ): ReturnType<LocalTaskStore["lookupTask"]> {
    return this.lookupTask(
      taskDomain.workspacePublicIdSchema.parse(localWorkspaceIdValue),
      taskKey,
    );
  }

  recoveryWorkspaceRepositories(
    localWorkspaceIdValue: string,
    presentedWorkspaceIdValue: string,
  ): LocalWorkspaceRepositoryPage {
    const page = this.listWorkspaceRepositories(
      taskDomain.workspacePublicIdSchema.parse(localWorkspaceIdValue),
      new Set(),
    );
    return {
      ...page,
      workspaceId: taskDomain.workspacePublicIdSchema.parse(
        presentedWorkspaceIdValue,
      ),
      repositories: page.repositories.map((repository) => ({
        ...repository,
        ready: false,
      })),
    };
  }

  recoveryListTasks(inputValue: Readonly<{
    localWorkspaceId: string;
    presentedWorkspaceId: string;
    view: TaskWorkspaceView;
    assignedAgentId?: string | undefined;
    cursor?: string | null | undefined;
    limit?: number | undefined;
    continuationRevision?: number | undefined;
    now?: number | undefined;
  }>): TaskListPage {
    const localWorkspaceId = taskDomain.workspacePublicIdSchema.parse(
      inputValue.localWorkspaceId,
    );
    const presentedWorkspaceId = taskDomain.workspacePublicIdSchema.parse(
      inputValue.presentedWorkspaceId,
    );
    const page = this.listTasks({
      workspaceId: localWorkspaceId,
      view: inputValue.view,
      ...(inputValue.assignedAgentId === undefined
        ? {}
        : { assignedAgentId: inputValue.assignedAgentId }),
      ...(inputValue.cursor === undefined ? {} : { cursor: inputValue.cursor }),
      ...(inputValue.limit === undefined ? {} : { limit: inputValue.limit }),
      ...(inputValue.continuationRevision === undefined
        ? {}
        : { continuationRevision: inputValue.continuationRevision }),
      ...(inputValue.now === undefined ? {} : { now: inputValue.now }),
    });
    return taskListPageSchema.parse({
      ...page,
      workspaceId: presentedWorkspaceId,
    });
  }

  recoveryTaskDetail(
    localWorkspaceIdValue: string,
    presentedWorkspaceIdValue: string,
    taskIdValue: string,
    nowValue = Date.now(),
  ): TaskDetailProjection {
    const detail = this.taskDetail(
      taskDomain.workspacePublicIdSchema.parse(localWorkspaceIdValue),
      taskIdValue,
      nowValue,
    );
    return taskDetailProjectionSchema.parse({
      ...detail,
      workspaceId: taskDomain.workspacePublicIdSchema.parse(
        presentedWorkspaceIdValue,
      ),
    });
  }

  taskWorkspaceContextBase(workspaceId: string): Readonly<{
    agents: readonly Readonly<{
      id: string;
      name: string;
      status: "active" | "disabled";
    }>[];
    hasRegisteredRepository: boolean;
    projectionRevision: number;
    viewer: Readonly<{
      id: string;
      kind: "local_owner";
      name: "You";
    }>;
    workspaceId: string;
  }> {
    const workspace = this.#workspace(workspaceId);
    const executors = this.#database.query(`
      SELECT agent_id, enabled FROM local_builtin_executors
      WHERE workspace_id = ?1
      ORDER BY agent_id
      LIMIT 65
    `).all(workspaceId) as readonly {
      agent_id: string;
      enabled: number;
    }[];
    if (executors.length > 64) {
      throw new LocalTaskStoreError(
        "capacity_full",
        "Local executor projection exceeds its bound",
      );
    }
    const repository = this.#database.query(`
      SELECT 1 AS present
      FROM local_workspace_repositories
      JOIN local_repositories USING (repository_id)
      WHERE workspace_id = ?1 AND local_repositories.tombstoned_at IS NULL
      LIMIT 1
    `).get(workspaceId);
    return {
      agents: executors.map((executor) => ({
        id: taskDomain.agentIdSchema.parse(executor.agent_id),
        name: executor.agent_id === "builtin_local_codex"
          ? "Codex"
          : executor.agent_id,
        status: executor.enabled === 1 ? "active" : "disabled",
      })),
      hasRegisteredRepository: repository !== null,
      projectionRevision: workspace.revision,
      viewer: {
        id: workspace.owner_installation_id,
        kind: "local_owner",
        name: "You",
      },
      workspaceId: workspace.workspace_id,
    };
  }

  lookupTask(
    workspaceId: string,
    taskKey: string,
  ): Readonly<{
    id: string;
    key: string;
    priority: number;
    revision: number;
    status: "open" | "in_progress" | "in_review" | "done" | "cancelled";
    title: string;
  }> | null {
    this.#workspace(workspaceId);
    const key = taskDomain.taskKeySchema.parse(taskKey);
    const value: unknown = this.#database.query(`
      SELECT task_id, task_key, revision, status, title, priority
      FROM local_tasks WHERE workspace_id = ?1 AND task_key = ?2
    `).get(workspaceId, key);
    const row = z.object({
      task_id: taskDomain.taskPublicIdSchema,
      task_key: taskDomain.taskKeySchema,
      revision: taskDomain.revisionSchema,
      status: taskDomain.taskStatusSchema,
      title: taskDomain.taskTitleSchema,
      priority: taskDomain.taskPrioritySchema,
    }).strict().nullable().parse(value);
    return row === null
      ? null
      : {
          id: row.task_id,
          key: row.task_key,
          priority: row.priority,
          revision: row.revision,
          status: row.status,
          title: row.title,
        };
  }

  workspaceRepositoryProbeCandidates(
    workspaceIdValue: string,
  ): readonly Readonly<{
    repositoryId: string;
    canonicalRepositoryPath: string;
    canonicalGitCommonDir: string;
  }>[] {
    const workspaceId = taskDomain.workspacePublicIdSchema.parse(workspaceIdValue);
    this.#workspace(workspaceId);
    const values: unknown[] = this.#database.query(`
      SELECT local_repositories.repository_id,
        local_repositories.canonical_repository_path,
        local_repositories.canonical_git_common_dir
      FROM local_workspace_repositories
      JOIN local_repositories
        ON local_repositories.repository_id =
          local_workspace_repositories.repository_id
      WHERE local_workspace_repositories.workspace_id = ?1
        AND local_repositories.tombstoned_at IS NULL
      ORDER BY local_repositories.created_at, local_repositories.repository_id
      LIMIT 129
    `).all(workspaceId);
    if (values.length > 128) {
      throw new Error("Workspace repository probe set exceeds its bound");
    }
    return values.map((value) => {
      const row = z.object({
        repository_id: taskDomain.repositoryIdSchema,
        canonical_repository_path: z.string().min(1).max(4_096),
        canonical_git_common_dir: z.string().min(1).max(4_096),
      }).strict().parse(value);
      return {
        repositoryId: row.repository_id,
        canonicalRepositoryPath: row.canonical_repository_path,
        canonicalGitCommonDir: row.canonical_git_common_dir,
      };
    });
  }

  listWorkspaceRepositories(
    workspaceIdValue: string,
    readyRepositoryIds: ReadonlySet<string> = new Set(),
  ): LocalWorkspaceRepositoryPage {
    const workspaceId = taskDomain.workspacePublicIdSchema.parse(workspaceIdValue);
    const workspace = this.#workspace(workspaceId);
    const values: unknown[] = this.#database.query(`
      SELECT local_repositories.repository_id, local_repositories.name,
        local_repositories.tombstoned_at
      FROM local_workspace_repositories
      JOIN local_repositories
        ON local_repositories.repository_id =
          local_workspace_repositories.repository_id
      WHERE local_workspace_repositories.workspace_id = ?1
      ORDER BY local_repositories.created_at, local_repositories.repository_id
      LIMIT 129
    `).all(workspaceId);
    if (values.length > 128) {
      throw new Error("Workspace repository projection exceeds its bound");
    }
    return {
      workspaceId,
      projectionRevision: workspace.revision,
      repositories: values.map((value) => {
        const row = z.object({
          repository_id: taskDomain.repositoryIdSchema,
          name: taskDomain.repositoryNameSchema,
          tombstoned_at: taskDomain.epochMsSchema.nullable(),
        }).strict().parse(value);
        return {
          id: row.repository_id,
          name: row.name,
          ready:
            row.tombstoned_at === null
            && readyRepositoryIds.has(row.repository_id),
        };
      }),
    };
  }

  taskWorkspaceProjection(
    inputValue: Readonly<{
      workspaceId: string;
      expectedWorkspaceRevision: number;
      view: TaskWorkspaceView;
      assignedAgentId?: string | undefined;
      selectedTaskId: string | null;
      minimumRevision: number | null;
      limit: number;
    }>,
    readyRepositoryIdsValue: ReadonlySet<string>,
    nowValue: number,
  ): LocalTaskWorkspaceProjection {
    const input = taskWorkspaceProjectionInputSchema.parse(inputValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const readyRepositoryIds = new Set(
      [...readyRepositoryIdsValue].map((repositoryId) =>
        taskDomain.repositoryIdSchema.parse(repositoryId)
      ),
    );
    if (readyRepositoryIds.size > 128) {
      throw new LocalTaskStoreError(
        "capacity_full",
        "Ready repository projection exceeds its bound",
      );
    }
    return this.#database.transaction(() => {
      const workspace = this.#workspace(input.workspaceId);
      if (
        workspace.revision !== input.expectedWorkspaceRevision ||
        (
          input.minimumRevision !== null &&
          workspace.revision < input.minimumRevision
        )
      ) {
        throw new LocalProjectionRevisionConflict(workspace.revision);
      }

      const workspaceSummary = this.#workspaceSummary(workspace, now);

      const executorValues: unknown[] = this.#database.query(`
        SELECT agent_id, enabled
        FROM local_builtin_executors
        WHERE workspace_id = ?1
        ORDER BY agent_id
        LIMIT 65
      `).all(input.workspaceId);
      if (executorValues.length > 64) {
        throw new LocalTaskStoreError(
          "capacity_full",
          "Local executor projection exceeds its bound",
        );
      }
      const agents = executorValues.map((value) => {
        const executor = z.object({
          agent_id: taskDomain.agentIdSchema,
          enabled: z.number().int().min(0).max(1),
        }).strict().parse(value);
        return {
          id: executor.agent_id,
          name: executor.agent_id === "builtin_local_codex"
            ? "Codex"
            : executor.agent_id,
          status: executor.enabled === 1
            ? "active" as const
            : "disabled" as const,
        };
      });

      const repositoryValues: unknown[] = this.#database.query(`
        SELECT local_repositories.repository_id, local_repositories.name,
          local_repositories.tombstoned_at
        FROM local_workspace_repositories
        JOIN local_repositories
          ON local_repositories.repository_id =
            local_workspace_repositories.repository_id
        WHERE local_workspace_repositories.workspace_id = ?1
        ORDER BY local_repositories.created_at,
          local_repositories.repository_id
        LIMIT 129
      `).all(input.workspaceId);
      if (repositoryValues.length > 128) {
        throw new LocalTaskStoreError(
          "capacity_full",
          "Workspace repository projection exceeds its bound",
        );
      }
      const repositories = repositoryValues.map((value) => {
        const repository = z.object({
          repository_id: taskDomain.repositoryIdSchema,
          name: taskDomain.repositoryNameSchema,
          tombstoned_at: taskDomain.epochMsSchema.nullable(),
        }).strict().parse(value);
        return {
          id: repository.repository_id,
          name: repository.name,
          ready:
            repository.tombstoned_at === null &&
            readyRepositoryIds.has(repository.repository_id),
        };
      });

      const filter = taskListFilterSql(input.view, input.assignedAgentId);
      const assignedAgentId = input.assignedAgentId ?? null;
      const taskValues: unknown[] = this.#database.query(`
        SELECT tasks.workspace_id, tasks.task_id, tasks.task_key, tasks.title,
          tasks.task_type, tasks.priority, tasks.status, tasks.available_at,
          tasks.assignee_agent_id, tasks.parent_task_id, tasks.repository_id,
          tasks.unresolved_blocker_count, tasks.cancelled_blocker_count,
          tasks.revision, tasks.review_revision, tasks.created_at,
          tasks.updated_at, tasks.completed_at, tasks.cancelled_at,
          claims.claim_id AS active_claim_id,
          claims.agent_id AS active_claim_agent_id,
          claims.fence AS active_claim_fence,
          claims.lease_generation AS active_claim_lease_generation,
          claims.lease_until AS active_claim_lease_until
        FROM local_tasks AS tasks
        LEFT JOIN local_task_claims AS claims
          ON claims.workspace_id = tasks.workspace_id
          AND claims.task_id = tasks.task_id
          AND claims.state = 'active'
        WHERE tasks.workspace_id = ?1
          AND ${filter}
        ORDER BY tasks.updated_at DESC, tasks.task_id
        LIMIT ?4
      `).all(
        input.workspaceId,
        now,
        assignedAgentId,
        input.limit + 1,
      );
      const taskRows = taskValues.map((value) =>
        projectionTaskRowSchema.parse(value)
      );
      const hasMore = taskRows.length > input.limit;
      const pageRows = taskRows.slice(0, input.limit);
      const taskIdsJson = JSON.stringify(
        pageRows.map(({ task_id }) => task_id),
      );

      const runSummaryValues: unknown[] = this.#database.query(`
        WITH requested_tasks(task_id) AS (
          SELECT value FROM json_each(?2)
        ),
        ranked_runs AS (
          SELECT local_task_runs.*,
            row_number() OVER (
              PARTITION BY local_task_runs.task_id
              ORDER BY local_task_runs.updated_at DESC,
                local_task_runs.run_id DESC
            ) AS ordinal
          FROM local_task_runs
          JOIN requested_tasks USING (task_id)
          WHERE local_task_runs.workspace_id = ?1
        ),
        latest_runs AS (
          SELECT * FROM ranked_runs WHERE ordinal = 1
        ),
        ranked_events AS (
          SELECT local_run_public_events.*,
            row_number() OVER (
              PARTITION BY local_run_public_events.run_id
              ORDER BY local_run_public_events.sequence DESC
            ) AS ordinal
          FROM local_run_public_events
          JOIN latest_runs USING (workspace_id, run_id)
        )
        SELECT latest_runs.task_id, latest_runs.run_id, latest_runs.phase,
          latest_runs.updated_at, ranked_events.event_kind,
          ranked_events.display_text, ranked_events.observed_at
        FROM latest_runs
        LEFT JOIN ranked_events
          ON ranked_events.workspace_id = latest_runs.workspace_id
          AND ranked_events.run_id = latest_runs.run_id
          AND ranked_events.ordinal = 1
        ORDER BY latest_runs.task_id
      `).all(input.workspaceId, taskIdsJson);
      const runSummaries = new Map(
        runSummaryValues.map((value) => {
          const run = projectionRunSummaryRowSchema.parse(value);
          return [run.task_id, run] as const;
        }),
      );

      const pendingInteractionValues: unknown[] = this.#database.query(`
        WITH requested_tasks(task_id) AS (
          SELECT value FROM json_each(?2)
        ),
        ranked_interactions AS (
          SELECT local_task_runs.task_id,
            local_run_interactions.request_json,
            row_number() OVER (
              PARTITION BY local_task_runs.task_id
              ORDER BY local_run_interactions.created_at,
                local_run_interactions.interaction_id
            ) AS ordinal,
            count(*) OVER (
              PARTITION BY local_task_runs.task_id
            ) AS group_count
          FROM local_run_interactions
          JOIN local_task_runs
            ON local_task_runs.workspace_id =
              local_run_interactions.workspace_id
            AND local_task_runs.run_id = local_run_interactions.run_id
          JOIN requested_tasks
            ON requested_tasks.task_id = local_task_runs.task_id
          WHERE local_run_interactions.workspace_id = ?1
            AND local_run_interactions.state = 'pending'
        )
        SELECT task_id, request_json, group_count
        FROM ranked_interactions
        WHERE ordinal <= ?3
        ORDER BY task_id, ordinal
      `).all(
        input.workspaceId,
        taskIdsJson,
        taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT + 1,
      );
      const pendingInteractions = new Map<string, string[]>();
      for (const value of pendingInteractionValues) {
        const interaction = projectionPendingInteractionRowSchema.parse(value);
        if (
          interaction.group_count >
            taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT
        ) {
          throw new LocalTaskStoreError(
            "capacity_full",
            "Task pending interaction projection exceeds its bound",
          );
        }
        const requests = pendingInteractions.get(interaction.task_id) ?? [];
        requests.push(interaction.request_json);
        pendingInteractions.set(interaction.task_id, requests);
      }

      const last = pageRows.at(-1);
      const cursor = hasMore && last !== undefined
        ? encodeListCursor({
            version: 1,
            workspaceId: input.workspaceId,
            view: input.view,
            assignedAgentId,
            projectionRevision: workspace.revision,
            observedAt: now,
            updatedAt: last.updated_at,
            taskId: last.task_id,
          })
        : null;
      const firstPage = taskListPageSchema.parse({
        workspaceId: input.workspaceId,
        view: input.view,
        ...(input.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: input.assignedAgentId }),
        projectionRevision: workspace.revision,
        items: pageRows.map((task) => {
          const run = runSummaries.get(task.task_id) ?? null;
          let latestDisplay: unknown = null;
          if (run !== null && run.event_kind !== null) {
            if (run.observed_at === null) {
              throw new Error("Latest run display is missing its observation");
            }
            latestDisplay = run.display_text === null
              ? {
                  kind: run.event_kind,
                  observedAt: run.observed_at,
                }
              : {
                  kind: run.event_kind,
                  observedAt: run.observed_at,
                  displayText: run.display_text,
                };
          }
          return {
            task: projectionTaskView(task, now),
            run: run === null
              ? null
              : {
                  latestDisplay,
                  phase: run.phase,
                  updatedAt: run.updated_at,
                },
            humanInput: projectionHumanInput(
              pendingInteractions.get(task.task_id) ?? [],
            ),
          };
        }),
        cursor,
        hasMore,
      });

      const detail = input.selectedTaskId === null
        ? null
        : this.#atomicTaskDetail(workspace, input.selectedTaskId, now);
      const projection = taskDomain.taskWorkspaceProjectionBundleSchema.parse({
        workspaceId: input.workspaceId,
        view: input.view,
        ...(input.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: input.assignedAgentId }),
        selectedTaskId: input.selectedTaskId,
        projectionRevision: workspace.revision,
        // The local store does not currently expose a narrower durable list
        // revision, so continuation stays conservatively pinned to the head.
        continuationRevision: workspace.revision,
        firstPage,
        detail,
      });
      return {
        agents,
        hasReadyRepository: repositories.some(({ ready }) => ready),
        now,
        projection,
        repositories,
        viewer: {
          id: workspace.owner_installation_id,
          kind: "local_owner" as const,
          name: "You" as const,
        },
        workspace: workspaceSummary,
      };
    })();
  }

  recoveryTaskWorkspaceProjection(
    inputValue: Readonly<{
      localWorkspaceId: string;
      presentedWorkspaceId: string;
      expectedWorkspaceRevision: number;
      view: TaskWorkspaceView;
      assignedAgentId?: string | undefined;
      selectedTaskId: string | null;
      minimumRevision: number | null;
      limit: number;
    }>,
    nowValue: number,
  ): LocalTaskWorkspaceProjection {
    const input = recoveryTaskWorkspaceProjectionInputSchema.parse(inputValue);
    const local = this.taskWorkspaceProjection({
      workspaceId: input.localWorkspaceId,
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      view: input.view,
      ...(input.assignedAgentId === undefined
        ? {}
        : { assignedAgentId: input.assignedAgentId }),
      selectedTaskId: input.selectedTaskId,
      minimumRevision: input.minimumRevision,
      limit: input.limit,
    }, new Set(), nowValue);
    if (local.workspace.id !== input.presentedWorkspaceId) {
      throw new LocalTaskStoreError(
        "authority_mismatch",
        "Recovery presentation does not match cloud authority",
      );
    }
    return {
      ...local,
      hasReadyRepository: false,
      repositories: local.repositories.map((repository) => ({
        ...repository,
        ready: false,
      })),
      projection: taskDomain.taskWorkspaceProjectionBundleSchema.parse({
        ...local.projection,
        workspaceId: input.presentedWorkspaceId,
        firstPage: {
          ...local.projection.firstPage,
          workspaceId: input.presentedWorkspaceId,
        },
        detail: local.projection.detail === null
          ? null
          : {
              ...local.projection.detail,
              workspaceId: input.presentedWorkspaceId,
            },
      }),
    };
  }

  listTasks(inputValue: Readonly<{
    workspaceId: string;
    view: TaskWorkspaceView;
    assignedAgentId?: string | undefined;
    cursor?: string | null | undefined;
    limit?: number | undefined;
    continuationRevision?: number | undefined;
    now?: number | undefined;
  }>): TaskListPage {
    const request = z.object({
      workspaceId: taskDomain.workspacePublicIdSchema,
      view: taskDomain.taskWorkspaceViewSchema,
      assignedAgentId: taskDomain.agentIdSchema.optional(),
      cursor: taskDomain.portableProjectionCursorSchema.nullable().optional(),
      limit: z.number().int().min(1).max(taskDomain.MAX_PORTABLE_PROJECTION_PAGE_SIZE)
        .default(taskDomain.MAX_PORTABLE_PROJECTION_PAGE_SIZE),
      continuationRevision: taskDomain.revisionSchema.optional(),
      now: taskDomain.epochMsSchema.optional(),
    }).strict().superRefine((value, context) => {
      if (value.view !== "assigned" && value.assignedAgentId !== undefined) {
        context.addIssue({
          code: "custom",
          message: "only assigned task pages may carry an assigned-agent filter",
          path: ["assignedAgentId"],
        });
      }
    }).parse(inputValue);
    const workspace = this.#workspace(request.workspaceId);
    const decoded = request.cursor === undefined || request.cursor === null
      ? null
      : decodeListCursor(request.cursor);
    if (
      decoded !== null &&
      (
        decoded.workspaceId !== request.workspaceId ||
        decoded.view !== request.view ||
        decoded.assignedAgentId !== (request.assignedAgentId ?? null)
      )
    ) {
      throw new LocalProjectionRevisionConflict(workspace.revision);
    }
    const requiredRevision = request.continuationRevision ?? decoded?.projectionRevision;
    if (requiredRevision !== undefined && requiredRevision !== workspace.revision) {
      throw new LocalProjectionRevisionConflict(workspace.revision);
    }
    const observedAt = decoded?.observedAt ?? request.now ?? Date.now();
    taskDomain.epochMsSchema.parse(observedAt);
    const filter = taskListFilterSql(request.view, request.assignedAgentId);
    const cursorClause = decoded === null
      ? ""
      : "AND (updated_at < ?5 OR (updated_at = ?5 AND task_id > ?6))";
    const assigned = request.assignedAgentId ?? null;
    const values: unknown[] = this.#database.query(`
      SELECT workspace_id, task_id, task_key, title, task_type, priority, status,
        available_at, assignee_agent_id, parent_task_id, repository_id,
        unresolved_blocker_count, cancelled_blocker_count, revision,
        review_revision, created_at, updated_at, completed_at, cancelled_at
      FROM local_tasks
      WHERE workspace_id = ?1
        AND ${filter}
        ${cursorClause}
      ORDER BY updated_at DESC, task_id
      LIMIT ?4
    `).all(
      request.workspaceId,
      observedAt,
      assigned,
      request.limit + 1,
      ...(decoded === null ? [] : [decoded.updatedAt, decoded.taskId]),
    );
    const rows = values.map((value) => taskRowSchema.parse(value));
    const hasMore = rows.length > request.limit;
    const pageRows = rows.slice(0, request.limit);
    const last = pageRows.at(-1);
    const cursor = hasMore && last !== undefined
      ? encodeListCursor({
          version: 1,
          workspaceId: request.workspaceId,
          view: request.view,
          assignedAgentId: assigned,
          projectionRevision: workspace.revision,
          observedAt,
          updatedAt: last.updated_at,
          taskId: last.task_id,
        })
      : null;
    return taskListPageSchema.parse({
      workspaceId: request.workspaceId,
      view: request.view,
      ...(request.assignedAgentId === undefined
        ? {}
        : { assignedAgentId: request.assignedAgentId }),
      projectionRevision: workspace.revision,
      items: pageRows.map((row) => this.#listItem(row, observedAt)),
      cursor,
      hasMore,
    });
  }

  taskDetail(workspaceIdValue: string, taskIdValue: string, nowValue = Date.now()):
    TaskDetailProjection {
    const workspaceId = taskDomain.workspacePublicIdSchema.parse(workspaceIdValue);
    const taskId = taskDomain.taskPublicIdSchema.parse(taskIdValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const workspace = this.#workspace(workspaceId);
    const task = this.#task(workspaceId, taskId);
    return this.#taskDetail(workspace, task, now);
  }

  listWorkspaceEvents(inputValue: unknown): WorkspaceEventPage {
    const input = workspaceEventPageRequestSchema.parse(inputValue);
    this.#workspace(input.workspaceId);
    const values: unknown[] = this.#database.query(`
      SELECT event_json
      FROM local_workspace_events
      WHERE workspace_id = ?1 AND sequence > ?2
      ORDER BY sequence
      LIMIT ?3
    `).all(input.workspaceId, input.afterSequence, input.limit + 1);
    const events = values
      .slice(0, input.limit)
      .map((value) => {
        const row = eventRowSchema.parse(value);
        return portableWorkspaceEventSchema.parse(parseJson(row.event_json));
      });
    const hasMore = values.length > input.limit;
    return {
      workspaceId: input.workspaceId,
      events,
      hasMore,
      nextSequence: hasMore ? events.at(-1)?.sequence ?? null : null,
    };
  }

  prepareRendererMutationAttempt(
    inputValue: unknown,
    nowValue = Date.now(),
  ): LocalRendererMutationAttempt {
    const input = prepareRendererMutationAttemptSchema.parse(inputValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const keyedFingerprint = digestJson({
      fingerprint: input.fingerprint,
      scope: "local-renderer-mutation-attempt",
      workspaceId: input.workspaceId,
    }, this.#fingerprintKey);
    return this.#database.transaction(() => {
      const workspace = this.#workspace(input.workspaceId);
      if (workspace.authority_kind !== "local") {
        throw new LocalTaskStoreError(
          "authority_mismatch",
          "Only local authority accepts renderer mutation attempts",
        );
      }
      const existing = this.#rendererMutationAttemptRow(input.attemptId);
      if (existing !== null) {
        if (
          existing.workspace_id !== input.workspaceId ||
          existing.command_kind !== input.commandKind ||
          existing.keyed_fingerprint !== keyedFingerprint
        ) {
          throw new LocalMutationAttemptConflict();
        }
        return rendererMutationAttempt(existing);
      }
      const openValue: unknown = this.#database.query(`
        SELECT
          attempt_id, workspace_id, command_kind, keyed_fingerprint,
          keyed_command_digest, state, revision, prepared_at,
          effect_started_at, settled_at, terminal_outcome
        FROM local_renderer_mutation_attempts
        WHERE workspace_id = ?1
          AND state != 'settled'
        LIMIT 1
      `).get(input.workspaceId);
      const open = rendererMutationAttemptRowSchema.nullable().parse(openValue);
      if (open !== null) {
        if (
          open.command_kind === input.commandKind &&
          open.keyed_fingerprint === keyedFingerprint
        ) {
          return rendererMutationAttempt(open);
        }
        throw new LocalTaskStoreError(
          "capacity_full",
          "Workspace has an unresolved renderer mutation attempt",
        );
      }
      if (this.#receipt(input.attemptId) !== null) {
        throw new LocalMutationAttemptConflict(
          "Mutation attempt ID already belongs to an operation receipt",
        );
      }
      this.#database.query(`
        INSERT INTO local_renderer_mutation_attempts (
          attempt_id, workspace_id, command_kind, keyed_fingerprint,
          keyed_command_digest, state, revision, prepared_at,
          effect_started_at, settled_at, terminal_outcome
        ) VALUES (
          ?1, ?2, ?3, ?4, NULL, 'prepared', 1, ?5, NULL, NULL, NULL
        )
      `).run(
        input.attemptId,
        input.workspaceId,
        input.commandKind,
        keyedFingerprint,
        now,
      );
      const inserted = this.#rendererMutationAttemptRow(input.attemptId);
      if (inserted === null) {
        throw new Error("Prepared renderer mutation attempt was not persisted");
      }
      return rendererMutationAttempt(inserted);
    })();
  }

  startRendererMutationAttempt(
    inputValue: unknown,
    nowValue = Date.now(),
  ): LocalRendererMutationAttempt {
    const input = startRendererMutationAttemptSchema.parse(inputValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    return this.#database.transaction(() => {
      const workspace = this.#workspace(input.workspaceId);
      if (workspace.authority_kind !== "local") {
        throw new LocalTaskStoreError(
          "authority_mismatch",
          "Only local authority can start a renderer mutation effect",
        );
      }
      const row = this.#rendererMutationAttemptRow(input.attemptId);
      if (row === null) {
        throw new LocalTaskStoreError(
          "not_found",
          "Renderer mutation attempt does not exist",
        );
      }
      if (row.workspace_id !== input.workspaceId) {
        throw new LocalMutationAttemptConflict();
      }
      if (
        input.command.operationId !== input.attemptId ||
        input.command.authority.workspaceId !== input.workspaceId ||
        input.command.kind !== row.command_kind
      ) {
        throw new LocalMutationAttemptConflict(
          "Mutation command does not match its prepared attempt",
        );
      }
      const semanticFingerprint = rendererMutationSemanticFingerprint(
        input.command,
      );
      const keyedFingerprint = digestJson({
        fingerprint: semanticFingerprint,
        scope: "local-renderer-mutation-attempt",
        workspaceId: input.workspaceId,
      }, this.#fingerprintKey);
      if (row.keyed_fingerprint !== keyedFingerprint) {
        throw new LocalMutationAttemptConflict(
          "Mutation command does not match its prepared semantic fingerprint",
        );
      }
      if (row.revision !== input.expectedRevision) {
        throw new LocalTaskStoreError(
          "revision_conflict",
          "Renderer mutation attempt revision changed",
        );
      }
      if (row.state !== "prepared") {
        throw new LocalTaskStoreError(
          "invalid_state",
          "Only a prepared renderer mutation attempt can start",
        );
      }
      const effectStartedAt = Math.max(now, row.prepared_at);
      const keyedCommandDigest = rendererMutationCommandDigest(
        input.command,
        this.#fingerprintKey,
      );
      const updated = this.#database.query(`
        UPDATE local_renderer_mutation_attempts
        SET
          state = 'effect_started',
          revision = revision + 1,
          effect_started_at = ?4,
          keyed_command_digest = ?5
        WHERE attempt_id = ?1
          AND workspace_id = ?2
          AND revision = ?3
          AND state = 'prepared'
      `).run(
        input.attemptId,
        input.workspaceId,
        input.expectedRevision,
        effectStartedAt,
        keyedCommandDigest,
      );
      if (updated.changes !== 1) {
        throw new LocalTaskStoreError(
          "revision_conflict",
          "Renderer mutation attempt changed before its effect started",
        );
      }
      const started = this.#rendererMutationAttemptRow(input.attemptId);
      if (started === null) {
        throw new Error("Started renderer mutation attempt disappeared");
      }
      return rendererMutationAttempt(started);
    })();
  }

  listOpenRendererMutationAttempts(
    inputValue: unknown,
  ): readonly LocalRendererMutationAttempt[] {
    const input = listRendererMutationAttemptsSchema.parse(inputValue);
    this.#workspace(input.workspaceId);
    const values: unknown[] = this.#database.query(`
      SELECT
        attempt_id, workspace_id, command_kind, keyed_fingerprint,
        keyed_command_digest, state, revision, prepared_at,
        effect_started_at, settled_at, terminal_outcome
      FROM local_renderer_mutation_attempts
      WHERE workspace_id = ?1 AND state != 'settled'
      ORDER BY prepared_at, attempt_id
      LIMIT ?2
    `).all(input.workspaceId, input.limit);
    return values.map(rendererMutationAttempt);
  }

  /**
   * The gateway calls this only from its serialized mutation queue. Local
   * projection writes and their receipts share one SQLite transaction, so an
   * absent receipt proves that a started local effect was not applied. This
   * method must not be reused for concurrent or remote authorities.
   */
  inspectSerializedRendererMutationAttempt(
    inputValue: unknown,
    nowValue = Date.now(),
  ): LocalRendererMutationInspection {
    const input = rendererMutationAttemptTransitionSchema.parse(inputValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    return this.#database.transaction(() =>
      this.#inspectSerializedRendererMutationAttempt(input, now)
    )();
  }

  /**
   * Settles a previously inspected attempt. Committed attempts stay open
   * during inspection so a renderer crash cannot erase the only discoverable
   * recovery link before a covering projection is installed.
   */
  reconcileSerializedRendererMutationAttempt(
    inputValue: unknown,
    nowValue = Date.now(),
  ): LocalRendererMutationReconciliation {
    const input = rendererMutationAttemptTransitionSchema.parse(inputValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    return this.#database.transaction(() => {
      const inspection = this.#inspectSerializedRendererMutationAttempt(
        input,
        now,
      );
      if (
        inspection.attempt.state === "settled" ||
        inspection.attempt.state === "quarantined"
      ) {
        return inspection as LocalRendererMutationReconciliation;
      }
      if (inspection.resolution.outcome === "ambiguous") {
        throw new Error("An open mutation attempt cannot be ambiguous.");
      }
      const terminalOutcome = inspection.resolution.outcome;
      const settledAt = Math.max(
        now,
        inspection.attempt.state === "effect_started"
          ? inspection.attempt.effectStartedAt
          : inspection.attempt.preparedAt,
      );
      const updated = this.#database.query(`
        UPDATE local_renderer_mutation_attempts
        SET
          state = 'settled',
          revision = revision + 1,
          settled_at = ?4,
          terminal_outcome = ?5
        WHERE attempt_id = ?1
          AND workspace_id = ?2
          AND revision = ?3
          AND state != 'settled'
      `).run(
        input.attemptId,
        input.workspaceId,
        input.expectedRevision,
        settledAt,
        terminalOutcome,
      );
      if (updated.changes !== 1) {
        throw new LocalTaskStoreError(
          "revision_conflict",
          "Renderer mutation attempt changed during reconciliation",
        );
      }
      const settledRow = this.#rendererMutationAttemptRow(input.attemptId);
      if (settledRow === null) {
        throw new Error("Reconciled renderer mutation attempt disappeared");
      }
      const settled = rendererMutationAttempt(settledRow);
      if (settled.state !== "settled") {
        throw new Error("Reconciled renderer mutation attempt did not settle");
      }
      const reconciliation =
        this.#settledRendererMutationReconciliation(settled);
      this.#compactSettledRendererMutationAttempts(input.workspaceId);
      return reconciliation;
    })();
  }

  assertRendererMutationEffectStarted(commandValue: unknown): void {
    const command = localOwnerTaskCommandSchema.parse(commandValue);
    const workspaceId = command.authority.workspaceId;
    const row = this.#rendererMutationAttemptRow(command.operationId);
    if (row === null) {
      throw new LocalTaskStoreError(
        "invalid_state",
        "Task mutation effect was not prepared",
      );
    }
    if (
      row.workspace_id !== workspaceId ||
      row.command_kind !== command.kind
    ) {
      throw new LocalMutationAttemptConflict();
    }
    if (row.state !== "effect_started") {
      throw new LocalTaskStoreError(
        "invalid_state",
        "Task mutation effect is not in progress",
      );
    }
    const keyedCommandDigest = rendererMutationCommandDigest(
      command,
      this.#fingerprintKey,
    );
    if (
      row.keyed_command_digest === null ||
      row.keyed_command_digest !== keyedCommandDigest
    ) {
      throw new LocalMutationAttemptConflict(
        "Task mutation command does not match its started effect",
      );
    }
  }

  execute(
    commandValue: unknown,
    actorValue?: PortableActor,
    nowValue = Date.now(),
  ): OperationReceipt {
    return this.executeWithDisposition(
      commandValue,
      actorValue,
      nowValue,
    ).receipt;
  }

  executeWithDisposition(
    commandValue: unknown,
    actorValue?: PortableActor,
    nowValue = Date.now(),
  ): LocalTaskExecutionDisposition {
    const command = localWorkspaceCommandSchema.parse(commandValue);
    const now = taskDomain.epochMsSchema.parse(nowValue);
    const actor = taskDomain.portableActorSchema.parse(
      actorValue ?? actorForCommand(command),
    );
    const commandDigest = digestJson({ actor, command }, this.#fingerprintKey);
    const workspaceId = commandWorkspaceId(command);
    return this.#database.transaction(() => {
      const existing = this.#receipt(command.operationId);
      if (existing !== null) {
        if (existing.command_digest !== commandDigest) throw new LocalOperationConflict();
        return {
          receipt: operationReceiptSchema.parse(
            parseJson(existing.receipt_json),
          ),
          replayed: true,
        };
      }
      const workspace = this.#workspace(workspaceId);
      try {
        const receipt = this.#database.transaction(() => {
          this.#assertAuthority(workspace, command);
          const applied = this.#applyCommand(workspace, command, actor, now);
          const rebasedTaskIds = new Set<string>();
          for (const event of applied.events) {
            if (event.kind === "task.changed") {
              for (
                const taskId of this.#queuedRunReadinessTargets(
                  workspace.workspace_id,
                  event.taskId,
                )
              ) {
                if (rebasedTaskIds.has(taskId)) continue;
                this.#synchronizeQueuedRuns(
                  workspace.workspace_id,
                  taskId,
                  now,
                );
                rebasedTaskIds.add(taskId);
              }
            }
          }
          const nextWorkspaceRevision = workspace.revision + 1;
          const firstSequence = workspace.event_sequence + 1;
          const eventKinds = commandEventKinds[command.kind];
          if (
            eventKinds.length !== applied.events.length ||
            eventKinds.some((kind, index) => kind !== applied.events[index]?.kind)
          ) {
            throw new Error("Local command emitted an invalid portable event sequence");
          }
          const events = applied.events.map((draft, index) =>
            this.#event({
              workspace,
              workspaceRevision: nextWorkspaceRevision,
              sequence: firstSequence + index,
              operationId: command.operationId,
              commandKind: command.kind,
              actor,
              draft,
              now,
            }));
          const finalSequence = events.at(-1)?.sequence;
          if (finalSequence === undefined) throw new Error("Local command emitted no event");
          const updated = this.#database.query(`
            UPDATE local_workspaces
            SET revision = ?2, event_sequence = ?3, updated_at = ?4
            WHERE workspace_id = ?1
              AND revision = ?5
              AND event_sequence = ?6
          `).run(
            workspaceId,
            nextWorkspaceRevision,
            finalSequence,
            now,
            workspace.revision,
            workspace.event_sequence,
          );
          if (updated.changes !== 1) {
            throw new LocalTaskStoreError(
              "revision_conflict",
              "Workspace revision changed",
            );
          }
          for (const event of events) this.#insertEvent(event);
          const receipt = operationReceiptSchema.parse({
            receiptId: deterministicPublicId("receipt", command.operationId),
            operationId: command.operationId,
            workspaceId,
            commandKind: command.kind,
            commandDigest,
            recordedAt: now,
            outcome: "committed",
            workspaceRevision: nextWorkspaceRevision,
            eventSequence: finalSequence,
            eventIds: events.map(({ id }) => id),
            eventKinds: events.map(({ kind }) => kind),
            result: applied.result,
          });
          this.#insertReceipt(receipt);
          return receipt;
        })();
        return { receipt, replayed: false };
      } catch (error: unknown) {
        if (!(error instanceof LocalTaskStoreError)) throw error;
        const receipt = operationReceiptSchema.parse({
          receiptId: deterministicPublicId("receipt", command.operationId),
          operationId: command.operationId,
          workspaceId,
          commandKind: command.kind,
          commandDigest,
          recordedAt: now,
          outcome: "rejected",
          code: error.code,
        });
        this.#insertReceipt(receipt);
        return { receipt, replayed: false };
      }
    })();
  }

  #applyCommand(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: LocalWorkspaceCommand,
    actor: PortableActor,
    now: number,
  ): AppliedCommand {
    switch (command.kind) {
      case "workspace.rename": {
        this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
        if (workspace.name === command.name) {
          throw new LocalTaskStoreError("invalid_state", "Workspace name is unchanged");
        }
        this.#database.query(`
          UPDATE local_workspaces SET name = ?2 WHERE workspace_id = ?1
        `).run(workspace.workspace_id, command.name);
        return {
          result: { kind: "workspace", workspaceRevision: workspace.revision + 1 },
          events: [{ kind: "workspace.renamed" }],
        };
      }
      case "task.create":
      case "task.create_and_run":
        return this.#createTask(workspace, command, now);
      case "task.update": {
        this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
        const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
        this.#requireMutable(task);
        const patch = command.patch;
        this.#database.query(`
          UPDATE local_tasks SET
            title = COALESCE(?3, title),
            task_type = COALESCE(?4, task_type),
            priority = COALESCE(?5, priority),
            available_at = COALESCE(?6, available_at),
            revision = revision + 1,
            review_revision = review_revision + 1,
            updated_at = ?7
          WHERE workspace_id = ?1 AND task_id = ?2
        `).run(
          workspace.workspace_id,
          task.task_id,
          patch.title ?? null,
          patch.type ?? null,
          patch.priority ?? null,
          patch.availableAt ?? null,
          now,
        );
        if (patch.description !== undefined) {
          this.#database.query(`
            UPDATE local_task_bodies SET description = ?3, updated_at = ?4
            WHERE workspace_id = ?1 AND task_id = ?2
          `).run(workspace.workspace_id, task.task_id, patch.description, now);
        }
        return this.#taskUpdated(command, task, "task.updated");
      }
      case "task.cancel": {
        this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
        const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
        this.#requireMutable(task);
        const ambiguous = z.object({ present: z.literal(1) }).strict()
          .nullable()
          .parse(this.#database.query(`
            SELECT 1 AS present
            FROM local_task_runs
            WHERE workspace_id = ?1 AND task_id = ?2 AND phase = 'ambiguous'
            LIMIT 1
          `).get(workspace.workspace_id, task.task_id));
        if (ambiguous !== null) {
          throw new LocalTaskStoreError(
            "invalid_state",
            "Resolve the ambiguous run before cancelling its task",
          );
        }
        this.#database.query(`
          UPDATE local_tasks SET status = 'cancelled', revision = revision + 1,
            review_revision = review_revision + 1, cancelled_at = ?3,
            completed_at = NULL, updated_at = ?3
          WHERE workspace_id = ?1 AND task_id = ?2
        `).run(workspace.workspace_id, task.task_id, now);
        this.#database.query(`
          UPDATE local_task_submissions
          SET status = 'cancelled', reviewed_at = ?3
          WHERE workspace_id = ?1 AND task_id = ?2 AND status = 'pending'
        `).run(workspace.workspace_id, task.task_id, now);
        this.#database.query(`
          UPDATE local_task_claims
          SET state = 'released', ended_at = ?3, updated_at = ?3
          WHERE workspace_id = ?1 AND task_id = ?2 AND state = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM local_task_runs
              WHERE local_task_runs.workspace_id = local_task_claims.workspace_id
                AND local_task_runs.claim_id = local_task_claims.claim_id
                AND local_task_runs.phase IN (
                  'leased', 'provisioning', 'starting', 'running',
                  'waiting', 'cancel_requested', 'ambiguous'
                )
            )
        `).run(workspace.workspace_id, task.task_id, now);
        this.#database.query(`
          UPDATE local_task_runs
          SET phase = 'cancelled', desired_state = 'stop', finished_at = ?3, updated_at = ?3
          WHERE workspace_id = ?1 AND task_id = ?2 AND phase = 'queued'
        `).run(workspace.workspace_id, task.task_id, now);
        this.#database.query(`
          UPDATE local_task_runs
          SET phase = 'cancel_requested', desired_state = 'stop', updated_at = ?3
          WHERE workspace_id = ?1 AND task_id = ?2
            AND phase IN (
              'leased', 'provisioning', 'starting', 'running', 'waiting'
            )
        `).run(workspace.workspace_id, task.task_id, now);
        this.#database.query(`
          UPDATE local_queued_run_intents
          SET state = 'abandoned', updated_at = ?3
          WHERE workspace_id = ?1 AND task_id = ?2 AND state IN ('queued', 'claimed')
        `).run(workspace.workspace_id, task.task_id, now);
        this.#recalculateBlockerCounters(workspace.workspace_id);
        return this.#taskUpdated(command, task, "task.cancelled");
      }
      case "task.reopen": {
        this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
        const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
        if (task.status !== "done" && task.status !== "cancelled") {
          throw new LocalTaskStoreError("invalid_state", "Only terminal tasks can be reopened");
        }
        const unsettledRun = z.object({
          run_id: taskDomain.dispatchIdSchema,
        }).strict().nullable().parse(this.#database.query(`
          SELECT run_id
          FROM local_task_runs AS run
          WHERE run.workspace_id = ?1 AND run.task_id = ?2
            AND (
              run.phase NOT IN ('submitted', 'failed', 'cancelled')
              OR EXISTS (
                SELECT 1
                FROM local_run_execution_bindings AS binding
                WHERE binding.workspace_id = run.workspace_id
                  AND binding.run_id = run.run_id
                  AND binding.capacity_released_at IS NULL
              )
            )
          ORDER BY run.created_at, run.run_id
          LIMIT 1
        `).get(workspace.workspace_id, task.task_id));
        if (unsettledRun !== null) {
          throw new LocalTaskStoreError(
            "invalid_state",
            "Finish or resolve every retained run before reopening its task",
          );
        }
        this.#database.query(`
          UPDATE local_tasks SET status = 'open', revision = revision + 1,
            review_revision = review_revision + 1, completed_at = NULL,
            cancelled_at = NULL, updated_at = ?3
          WHERE workspace_id = ?1 AND task_id = ?2
        `).run(workspace.workspace_id, task.task_id, now);
        this.#recalculateBlockerCounters(workspace.workspace_id);
        return this.#taskUpdated(command, task, "task.reopened");
      }
      case "task.assign": {
        this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
        const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
        this.#requireMutable(task);
        if (task.assignee_agent_id === command.assigneeAgentId) {
          throw new LocalTaskStoreError("invalid_state", "Task assignment is unchanged");
        }
        this.#database.query(`
          UPDATE local_tasks SET assignee_agent_id = ?3, revision = revision + 1,
            review_revision = review_revision + 1, updated_at = ?4
          WHERE workspace_id = ?1 AND task_id = ?2
        `).run(workspace.workspace_id, task.task_id, command.assigneeAgentId, now);
        return this.#taskUpdated(command, task, "task.assigned");
      }
      case "task.defer": {
        this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
        const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
        if (task.status !== "open") {
          throw new LocalTaskStoreError("invalid_state", "Only open tasks can be deferred");
        }
        this.#database.query(`
          UPDATE local_tasks SET available_at = ?3, revision = revision + 1,
            review_revision = review_revision + 1, updated_at = ?4
          WHERE workspace_id = ?1 AND task_id = ?2
        `).run(workspace.workspace_id, task.task_id, command.availableAt, now);
        this.#upsertDueWork({
          workspaceId: workspace.workspace_id,
          kind: "defer_wake",
          entityId: task.task_id,
          dueAt: command.availableAt,
          expectedRevision: task.revision + 1,
          now,
        });
        return this.#taskUpdated(command, task, "task.deferred");
      }
      case "task.parent_set":
        return this.#setParent(workspace, command, now);
      case "task.parent_clear": {
        this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
        const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
        this.#requireMutable(task);
        if (task.parent_task_id === null) {
          throw new LocalTaskStoreError("invalid_state", "Task has no parent");
        }
        this.#database.query(`
          UPDATE local_tasks SET parent_task_id = NULL, revision = revision + 1,
            review_revision = review_revision + 1, updated_at = ?3
          WHERE workspace_id = ?1 AND task_id = ?2
        `).run(workspace.workspace_id, task.task_id, now);
        return this.#taskUpdated(command, task, "task.parent_cleared");
      }
      case "task.label_add":
      case "task.label_remove":
        return this.#mutateLabel(workspace, command, now);
      case "task.comment_add":
        return this.#addComment(workspace, command, actor, now);
      case "task.reference_add":
      case "task.reference_remove":
        return this.#mutateReference(workspace, command, now);
      case "dependency.add":
      case "dependency.remove":
        return this.#mutateDependency(workspace, command, now);
      case "task.submit":
        return this.#submitTask(workspace, command, actor, now);
      case "review.accept":
      case "review.reject":
        return this.#reviewSubmission(workspace, command, actor, now);
      case "dispatch.stop":
        return this.#stopDispatch(workspace, command, now);
      case "dispatch.retry":
        return this.#retryDispatch(workspace, command, now);
      case "dispatch.resolve_ambiguity":
        return this.#resolveDispatch(workspace, command, now);
      case "interaction.respond":
        return this.#respondInteraction(workspace, command, now);
      case "interaction.settle":
        return this.#settleInteraction(workspace, command, now);
      case "defer.wake":
        return this.#wakeDeferred(workspace, command, now);
      case "claim.expire":
        return this.#expireClaim(workspace, command, now);
      case "run.reconcile":
        return this.#reconcileRun(workspace, command, now);
      case "interaction.expire":
        return this.#expireInteraction(workspace, command, now);
      case "workspace.repair": {
        this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
        this.#recalculateBlockerCounters(workspace.workspace_id);
        return {
          result: { kind: "workspace", workspaceRevision: workspace.revision + 1 },
          events: [{ kind: "system.workspace_repaired" }],
        };
      }
    }
  }

  #createTask(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "task.create" | "task.create_and_run" }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const activeValue: unknown = this.#database.query(`
      SELECT count(*) AS count FROM local_tasks
      WHERE workspace_id = ?1 AND status NOT IN ('done', 'cancelled')
    `).get(workspace.workspace_id);
    const active = z.object({ count: z.number().int().nonnegative() }).strict().parse(activeValue);
    if (active.count >= taskDomain.WORKSPACE_ACTIVE_TASK_LIMIT) {
      throw new LocalTaskStoreError("capacity_full", "Workspace active-task limit reached");
    }
    const totalValue: unknown = this.#database.query(`
      SELECT count(*) AS count FROM local_tasks WHERE workspace_id = ?1
    `).get(workspace.workspace_id);
    const total = z.object({ count: z.number().int().nonnegative() }).strict().parse(totalValue);
    if (total.count >= taskDomain.WORKSPACE_TOTAL_TASK_LIMIT) {
      throw new LocalTaskStoreError("capacity_full", "Workspace task limit reached");
    }
    if (this.#taskOrNull(workspace.workspace_id, command.taskId) !== null) {
      throw new LocalTaskStoreError("invalid_state", "Task ID already exists");
    }
    if (command.parentTaskId !== undefined) {
      const parent = this.#task(
        workspace.workspace_id,
        command.parentTaskId,
      );
      if (parent.revision !== command.expectedParentRevision) {
        throw new LocalTaskStoreError("revision_conflict", "Parent revision changed");
      }
    }
    if (command.repositoryId !== undefined) {
      this.#requireWorkspaceRepository(workspace.workspace_id, command.repositoryId);
    }
    const taskKey = `${workspace.key_prefix}-${command.taskId.slice(-7)}`;
    taskDomain.taskKeySchema.parse(taskKey);
    try {
      this.#database.query(`
        INSERT INTO local_tasks (
          workspace_id, task_id, task_key, title, task_type, priority, status,
          available_at, parent_task_id, repository_id, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?9, ?10, ?10)
      `).run(
        workspace.workspace_id,
        command.taskId,
        taskKey,
        command.title,
        command.type,
        command.priority,
        command.availableAt,
        command.parentTaskId ?? null,
        command.repositoryId ?? null,
        now,
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new LocalTaskStoreError("invalid_state", "Task identity or key already exists");
      }
      throw error;
    }
    this.#database.query(`
      INSERT INTO local_task_bodies (workspace_id, task_id, description, updated_at)
      VALUES (?1, ?2, ?3, ?4)
    `).run(workspace.workspace_id, command.taskId, command.description ?? "", now);
    for (const label of command.labels) {
      this.#database.query(`
        INSERT INTO local_task_labels (workspace_id, task_id, label, created_at)
        VALUES (?1, ?2, ?3, ?4)
      `).run(workspace.workspace_id, command.taskId, label, now);
    }
    const events: EventDraft[] = [{
      kind: "task.changed",
      taskId: command.taskId,
      taskRevision: 1,
      eventType: "task.created",
    }];
    let runId: string | undefined;
    if (command.kind === "task.create_and_run") {
      runId = deterministicOpaqueId("run", command.operationId);
      this.#database.query(`
        INSERT INTO local_task_runs (
          workspace_id, task_id, run_id, repository_id, phase, desired_state,
          recovery_state, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'queued', 'run', 'none', ?5, ?5)
      `).run(
        workspace.workspace_id,
        command.taskId,
        runId,
        command.repositoryId,
        now,
      );
      this.#database.query(`
        INSERT INTO local_run_public_events (
          workspace_id, run_id, sequence, event_id, event_kind, observed_at
        ) VALUES (?1, ?2, 1, ?3, 'run.queued', ?4)
      `).run(
        workspace.workspace_id,
        runId,
        deterministicOpaqueId("event", `${command.operationId}:queued`),
        now,
      );
      this.#database.query(`
        INSERT INTO local_queued_run_intents (
          workspace_id, run_id, task_id, repository_id, state, available_at,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?6)
      `).run(
        workspace.workspace_id,
        runId,
        command.taskId,
        command.repositoryId,
        Math.max(command.availableAt, now),
        now,
      );
      this.#upsertDueWork({
        workspaceId: workspace.workspace_id,
        kind: "queued_run",
        entityId: runId,
        dueAt: Math.max(command.availableAt, now),
        expectedRevision: 1,
        now,
      });
      events.push({
        kind: "run.changed",
        taskId: command.taskId,
        runId,
        phase: "queued",
      });
    }
    return {
      result: {
        kind: "task_created",
        taskId: command.taskId,
        taskRevision: 1,
        ...(runId === undefined ? {} : { runId }),
      },
      events,
    };
  }

  #setParent(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "task.parent_set" }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
    this.#requireMutable(task);
    const parent = this.#task(workspace.workspace_id, command.parentTaskId);
    if (parent.revision !== command.expectedParentRevision) {
      throw new LocalTaskStoreError("revision_conflict", "Parent revision changed");
    }
    if (task.parent_task_id === parent.task_id) {
      throw new LocalTaskStoreError("invalid_state", "Task already has that parent");
    }
    const values: unknown[] = this.#database.query(`
      SELECT task_id, parent_task_id FROM local_tasks WHERE workspace_id = ?1
    `).all(workspace.workspace_id);
    const rows = values.map((value) =>
      z.object({
        task_id: taskDomain.taskPublicIdSchema,
        parent_task_id: taskDomain.taskPublicIdSchema.nullable(),
      }).strict().parse(value));
    const parents = new Map(rows.map((row) =>
      [row.task_id, row.parent_task_id ?? undefined] as const));
    const validation = validateParentInsertion(parents, task.task_id, parent.task_id);
    if (validation.kind === "cycle") {
      throw new LocalTaskStoreError("graph_cycle", "Parent relation would create a cycle");
    }
    if (validation.kind === "limit") {
      throw new LocalTaskStoreError("graph_limit", "Parent validation exceeded its depth bound");
    }
    this.#database.query(`
      UPDATE local_tasks SET parent_task_id = ?3, revision = revision + 1,
        review_revision = review_revision + 1, updated_at = ?4
      WHERE workspace_id = ?1 AND task_id = ?2
    `).run(workspace.workspace_id, task.task_id, parent.task_id, now);
    return this.#taskUpdated(command, task, "task.parent_set");
  }

  #mutateLabel(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, {
      kind: "task.label_add" | "task.label_remove";
    }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
    this.#requireMutable(task);
    if (command.kind === "task.label_add") {
      const countValue: unknown = this.#database.query(`
        SELECT count(*) AS count FROM local_task_labels
        WHERE workspace_id = ?1 AND task_id = ?2
      `).get(workspace.workspace_id, task.task_id);
      const count = z.object({ count: z.number().int().nonnegative() }).strict().parse(countValue);
      if (count.count >= taskDomain.MAX_TASK_LABELS) {
        throw new LocalTaskStoreError("capacity_full", "Task label limit reached");
      }
      try {
        this.#database.query(`
          INSERT INTO local_task_labels (workspace_id, task_id, label, created_at)
          VALUES (?1, ?2, ?3, ?4)
        `).run(workspace.workspace_id, task.task_id, command.label, now);
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
          throw new LocalTaskStoreError("invalid_state", "Task already has that label");
        }
        throw error;
      }
    } else {
      const removed = this.#database.query(`
        DELETE FROM local_task_labels
        WHERE workspace_id = ?1 AND task_id = ?2 AND label = ?3
      `).run(workspace.workspace_id, task.task_id, command.label);
      if (removed.changes !== 1) {
        throw new LocalTaskStoreError("invalid_state", "Task does not have that label");
      }
    }
    this.#touchTask(workspace.workspace_id, task.task_id, now, true);
    return this.#taskUpdated(
      command,
      task,
      command.kind === "task.label_add" ? "task.label_added" : "task.label_removed",
    );
  }

  #addComment(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "task.comment_add" }>,
    actor: PortableActor,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#task(workspace.workspace_id, command.taskId);
    const commentId = deterministicPublicId("cmt", command.operationId);
    this.#database.query(`
      INSERT INTO local_task_comments (
        workspace_id, task_id, comment_id, actor_json, body, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(
      workspace.workspace_id,
      task.task_id,
      commentId,
      JSON.stringify(projectionActor(actor)),
      command.body,
      now,
    );
    this.#touchTask(workspace.workspace_id, task.task_id, now, false);
    return {
      result: { kind: "comment_added", taskId: task.task_id, commentId },
      events: [{
        kind: "task.changed",
        taskId: task.task_id,
        taskRevision: task.revision + 1,
        eventType: "task.comment_added",
      }],
    };
  }

  #mutateReference(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, {
      kind: "task.reference_add" | "task.reference_remove";
    }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
    this.#requireMutable(task);
    if (command.kind === "task.reference_add") {
      const referenceId = deterministicPublicId("ref", command.operationId);
      const reference = taskDomain.taskReferenceViewSchema.parse({
        ...command.reference,
        id: referenceId,
        createdAt: now,
      });
      this.#database.query(`
        INSERT INTO local_task_references (
          workspace_id, task_id, reference_id, reference_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5)
      `).run(
        workspace.workspace_id,
        task.task_id,
        referenceId,
        JSON.stringify(reference),
        now,
      );
      this.#touchTask(workspace.workspace_id, task.task_id, now, true);
      return {
        result: { kind: "reference_added", taskId: task.task_id, referenceId },
        events: [{
          kind: "task.changed",
          taskId: task.task_id,
          taskRevision: task.revision + 1,
          eventType: "task.reference_added",
        }],
      };
    }
    const removed = this.#database.query(`
      DELETE FROM local_task_references
      WHERE workspace_id = ?1 AND task_id = ?2 AND reference_id = ?3
    `).run(workspace.workspace_id, task.task_id, command.referenceId);
    if (removed.changes !== 1) {
      throw new LocalTaskStoreError("not_found", "Task reference does not exist");
    }
    this.#touchTask(workspace.workspace_id, task.task_id, now, true);
    return {
      result: {
        kind: "reference_removed",
        taskId: task.task_id,
        referenceId: command.referenceId,
      },
      events: [{
        kind: "task.changed",
        taskId: task.task_id,
        taskRevision: task.revision + 1,
        eventType: "task.reference_removed",
      }],
    };
  }

  #mutateDependency(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, {
      kind: "dependency.add" | "dependency.remove";
    }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
    const blocker = this.#task(workspace.workspace_id, command.blockerTaskId);
    if (blocker.revision !== command.expectedBlockerRevision) {
      throw new LocalTaskStoreError("revision_conflict", "Blocker revision changed");
    }
    this.#requireMutable(task);
    if (
      command.kind === "dependency.add" &&
      this.#hasQueuedRun(workspace.workspace_id, task.task_id)
    ) {
      throw new LocalTaskStoreError(
        "invalid_state",
        "Stop the queued run before adding a blocker",
      );
    }
    if (command.kind === "dependency.add") {
      const directValue: unknown = this.#database.query(`
        SELECT count(*) AS count FROM local_task_dependencies
        WHERE workspace_id = ?1 AND blocked_task_id = ?2
      `).get(workspace.workspace_id, task.task_id);
      const direct = z.object({ count: z.number().int().nonnegative() }).strict().parse(directValue);
      if (direct.count >= taskDomain.MAX_DIRECT_BLOCKERS) {
        throw new LocalTaskStoreError("capacity_full", "Direct blocker limit reached");
      }
      const fanoutValue: unknown = this.#database.query(`
        SELECT count(*) AS count FROM local_task_dependencies
        WHERE workspace_id = ?1 AND blocker_task_id = ?2
      `).get(workspace.workspace_id, blocker.task_id);
      const fanout = z.object({ count: z.number().int().nonnegative() }).strict().parse(fanoutValue);
      if (fanout.count >= taskDomain.MAX_BLOCKING_DEPENDENTS) {
        throw new LocalTaskStoreError("capacity_full", "Blocking-dependent limit reached");
      }
      const values: unknown[] = this.#database.query(`
        SELECT blocker_task_id, blocked_task_id
        FROM local_task_dependencies WHERE workspace_id = ?1
      `).all(workspace.workspace_id);
      const edges = values.map((value) =>
        z.object({
          blocker_task_id: taskDomain.taskPublicIdSchema,
          blocked_task_id: taskDomain.taskPublicIdSchema,
        }).strict().parse(value));
      const dependents = new Map<string, string[]>();
      for (const edge of edges) {
        const list = dependents.get(edge.blocker_task_id) ?? [];
        list.push(edge.blocked_task_id);
        dependents.set(edge.blocker_task_id, list);
      }
      const validation = validateDependencyInsertion(
        dependents,
        blocker.task_id,
        task.task_id,
      );
      if (validation.kind === "cycle") {
        throw new LocalTaskStoreError("graph_cycle", "Dependency would create a cycle");
      }
      if (validation.kind === "limit") {
        throw new LocalTaskStoreError("graph_limit", "Dependency validation exceeded its bound");
      }
      try {
        this.#database.query(`
          INSERT INTO local_task_dependencies (
            workspace_id, blocker_task_id, blocked_task_id, created_at
          ) VALUES (?1, ?2, ?3, ?4)
        `).run(workspace.workspace_id, blocker.task_id, task.task_id, now);
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
          throw new LocalTaskStoreError("invalid_state", "Dependency already exists");
        }
        throw error;
      }
    } else {
      const removed = this.#database.query(`
        DELETE FROM local_task_dependencies
        WHERE workspace_id = ?1 AND blocker_task_id = ?2 AND blocked_task_id = ?3
      `).run(workspace.workspace_id, blocker.task_id, task.task_id);
      if (removed.changes !== 1) {
        throw new LocalTaskStoreError("not_found", "Dependency does not exist");
      }
    }
    this.#touchTask(workspace.workspace_id, task.task_id, now, true);
    this.#recalculateBlockerCounters(workspace.workspace_id);
    return this.#taskUpdated(
      command,
      task,
      command.kind === "dependency.add" ? "dependency.added" : "dependency.removed",
    );
  }

  #submitTask(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "task.submit" }>,
    actor: PortableActor,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
    if (
      task.status !== "in_progress" ||
      task.review_revision !== command.expectedReviewRevision ||
      task.unresolved_blocker_count + task.cancelled_blocker_count !== 0
    ) {
      throw new LocalTaskStoreError("invalid_state", "Task is not eligible for submission");
    }
    const claim = this.#activeClaim(workspace.workspace_id, task.task_id);
    if (claim === null || claim.fence !== command.fence) {
      throw new LocalTaskStoreError("invalid_state", "Submission claim fence is stale");
    }
    const submissionId = deterministicPublicId("sub", command.operationId);
    this.#database.query(`
      INSERT INTO local_task_submissions (
        workspace_id, task_id, submission_id, submitted_by_json, review_revision,
        summary, evidence_json, status, submitted_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)
    `).run(
      workspace.workspace_id,
      task.task_id,
      submissionId,
      JSON.stringify(projectionActor(actor)),
      task.review_revision,
      command.summary,
      JSON.stringify(command.evidence),
      now,
    );
    this.#database.query(`
      UPDATE local_task_claims
      SET state = 'submitted', ended_at = ?3, updated_at = ?3
      WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'active'
    `).run(workspace.workspace_id, claim.claim_id, now);
    this.#database.query(`
      UPDATE local_tasks SET status = 'in_review', revision = revision + 1,
        updated_at = ?3
      WHERE workspace_id = ?1 AND task_id = ?2
    `).run(workspace.workspace_id, task.task_id, now);
    return {
      result: {
        kind: "submission_updated",
        taskId: task.task_id,
        submissionId,
        taskRevision: task.revision + 1,
      },
      events: [{
        kind: "task.changed",
        taskId: task.task_id,
        taskRevision: task.revision + 1,
        eventType: "task.submitted",
      }],
    };
  }

  #reviewSubmission(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, {
      kind: "review.accept" | "review.reject";
    }>,
    actor: PortableActor,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#task(workspace.workspace_id, command.taskId);
    if (
      task.status !== "in_review" ||
      task.review_revision !== command.expectedReviewRevision ||
      this.#activeClaim(workspace.workspace_id, task.task_id) !== null
    ) {
      throw new LocalTaskStoreError("revision_conflict", "Task review revision changed");
    }
    const value: unknown = this.#database.query(`
      SELECT submission_id, submitted_by_json, review_revision, status
      FROM local_task_submissions
      WHERE workspace_id = ?1 AND task_id = ?2 AND status = 'pending'
    `).get(workspace.workspace_id, task.task_id);
    const submission = z.object({
      submission_id: taskDomain.taskSubmissionIdSchema,
      submitted_by_json: z.string(),
      review_revision: taskDomain.revisionSchema,
      status: z.literal("pending"),
    }).strict().nullable().parse(value);
    if (
      submission === null ||
      submission.submission_id !== command.submissionId ||
      submission.review_revision !== command.expectedReviewRevision
    ) {
      throw new LocalTaskStoreError("invalid_state", "Pending submission is stale");
    }
    const submittedBy = taskDomain.projectionActorSchema.parse(
      parseJson(submission.submitted_by_json),
    );
    if (
      submittedBy.kind === "agent" &&
      actor.kind === "agent" &&
      !reviewActorAllowed({
        submittedByAgentId: submittedBy.id,
        reviewerAgentId: actor.agentId,
      })
    ) {
      throw new LocalTaskStoreError("invalid_state", "An agent cannot review its own submission");
    }
    const action = command.kind === "review.accept" ? "accept" : "reject";
    if (!reviewAcceptanceAllowed({
      action,
      blockingCount: task.unresolved_blocker_count + task.cancelled_blocker_count,
    })) {
      throw new LocalTaskStoreError("invalid_state", "Blocked task cannot be accepted");
    }
    const nextSubmission = transitionSubmissionLifecycle("pending", action);
    if (nextSubmission === null) {
      throw new LocalTaskStoreError("invalid_state", "Submission is terminal");
    }
    const nextStatus = command.kind === "review.accept" ? "done" : "open";
    this.#database.query(`
      UPDATE local_task_submissions
      SET status = ?3, reviewed_at = ?4
      WHERE workspace_id = ?1 AND submission_id = ?2 AND status = 'pending'
    `).run(workspace.workspace_id, submission.submission_id, nextSubmission, now);
    this.#database.query(`
      INSERT INTO local_task_reviews (
        workspace_id, submission_id, decision, reviewer_json, reason, reviewed_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(
      workspace.workspace_id,
      submission.submission_id,
      nextSubmission,
      JSON.stringify(projectionActor(actor)),
      command.kind === "review.reject" ? command.reason : null,
      now,
    );
    this.#database.query(`
      UPDATE local_tasks SET status = ?3, revision = revision + 1,
        completed_at = ?4, cancelled_at = NULL, updated_at = ?5
      WHERE workspace_id = ?1 AND task_id = ?2
    `).run(
      workspace.workspace_id,
      task.task_id,
      nextStatus,
      nextStatus === "done" ? now : null,
      now,
    );
    this.#recalculateBlockerCounters(workspace.workspace_id);
    return {
      result: {
        kind: "submission_updated",
        taskId: task.task_id,
        submissionId: submission.submission_id,
        taskRevision: task.revision + 1,
      },
      events: [{
        kind: "task.changed",
        taskId: task.task_id,
        taskRevision: task.revision + 1,
        eventType: command.kind === "review.accept" ? "task.accepted" : "task.rejected",
      }],
    };
  }

  #stopDispatch(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "dispatch.stop" }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const run = this.#run(workspace.workspace_id, command.runId);
    if (taskDomain.isTerminalRunPhase(run.phase) || run.phase === "cancel_requested") {
      throw new LocalTaskStoreError("terminal", "Run cannot be stopped");
    }
    const phase = run.phase === "queued" ? "cancelled" : "cancel_requested";
    this.#database.query(`
      UPDATE local_task_runs SET phase = ?3, desired_state = 'stop',
        finished_at = ?4, updated_at = ?5
      WHERE workspace_id = ?1 AND run_id = ?2
    `).run(
      workspace.workspace_id,
      run.run_id,
      phase,
      phase === "cancelled" ? now : null,
      now,
    );
    if (phase === "cancelled") {
      this.#database.query(`
        UPDATE local_queued_run_intents
        SET state = 'abandoned', updated_at = ?3
        WHERE workspace_id = ?1 AND run_id = ?2 AND state IN ('queued', 'claimed')
      `).run(workspace.workspace_id, run.run_id, now);
    }
    return {
      result: { kind: "run_updated", runId: run.run_id, phase },
      events: [{
        kind: "run.changed",
        taskId: run.task_id,
        runId: run.run_id,
        phase,
      }],
    };
  }

  #retryDispatch(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "dispatch.retry" }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
    const source = this.#run(workspace.workspace_id, command.sourceRunId);
    if (source.task_id !== task.task_id) {
      throw new LocalTaskStoreError("not_found", "Source run does not belong to the task");
    }
    if (task.unresolved_blocker_count + task.cancelled_blocker_count !== 0) {
      throw new LocalTaskStoreError(
        "invalid_state",
        "Blocked tasks cannot queue a retry",
      );
    }
    const anotherBlocks = this.#blockingRunCount(
      workspace.workspace_id,
      task.task_id,
      source.run_id,
    ) > 0;
    const sourceSubmissionRejected =
      source.phase === "submitted"
      && this.#sourceSubmissionRejected(
        workspace.workspace_id,
        task.task_id,
        source.run_id,
      );
    const allowed = dispatchRetryAllowed({
      sourcePhase: source.phase,
      sourceSubmissionRejected,
      taskRevision: task.revision,
      expectedTaskRevision: command.expectedTaskRevision,
      taskStatus: task.status,
      taskHasCurrentClaim: this.#activeClaim(workspace.workspace_id, task.task_id) !== null,
      sourceFenceMatches: source.fence !== null,
      anotherDispatchBlocksTask: anotherBlocks,
      sourceAlreadyRetried: source.retried_by_run_id !== null,
    });
    if (!allowed) {
      throw new LocalTaskStoreError("invalid_state", "Run is not eligible for retry");
    }
    const runId = deterministicOpaqueId("run", command.operationId);
    this.#database.query(`
      INSERT INTO local_task_runs (
        workspace_id, task_id, run_id, repository_id, phase, desired_state,
        source_run_id, recovery_state, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'queued', 'run', ?5, 'none', ?6, ?6)
    `).run(
      workspace.workspace_id,
      task.task_id,
      runId,
      source.repository_id,
      source.run_id,
      now,
    );
    this.#database.query(`
      UPDATE local_task_runs SET retried_by_run_id = ?3, updated_at = ?4
      WHERE workspace_id = ?1 AND run_id = ?2 AND retried_by_run_id IS NULL
    `).run(workspace.workspace_id, source.run_id, runId, now);
    this.#database.query(`
      INSERT INTO local_run_public_events (
        workspace_id, run_id, sequence, event_id, event_kind, observed_at
      ) VALUES (?1, ?2, 1, ?3, 'run.queued', ?4)
    `).run(
      workspace.workspace_id,
      runId,
      deterministicOpaqueId("event", `${command.operationId}:queued`),
      now,
    );
    const availableAt = Math.max(task.available_at, now);
    this.#database.query(`
      INSERT INTO local_queued_run_intents (
        workspace_id, run_id, task_id, repository_id, state, available_at,
        created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?6)
    `).run(
      workspace.workspace_id,
      runId,
      task.task_id,
      source.repository_id,
      availableAt,
      now,
    );
    this.#upsertDueWork({
      workspaceId: workspace.workspace_id,
      kind: "queued_run",
      entityId: runId,
      dueAt: availableAt,
      expectedRevision: task.revision,
      now,
    });
    return {
      result: { kind: "run_updated", runId, phase: "queued" },
      events: [{
        kind: "run.changed",
        taskId: task.task_id,
        runId,
        phase: "queued",
      }],
    };
  }

  #sourceSubmissionRejected(
    workspaceId: string,
    taskId: string,
    runId: string,
  ): boolean {
    const value: unknown = this.#database.query(`
      SELECT submission.status,
        submission.review_revision,
        binding.input_review_revision
      FROM local_task_submissions AS submission
      JOIN local_run_execution_bindings AS binding
        ON binding.workspace_id = submission.workspace_id
        AND binding.task_id = submission.task_id
        AND binding.run_id = ?3
      WHERE submission.workspace_id = ?1 AND submission.task_id = ?2
      ORDER BY submission.submitted_at DESC, submission.submission_id DESC
      LIMIT 1
    `).get(workspaceId, taskId, runId);
    const latest = z.object({
      status: z.enum(["pending", "accepted", "rejected", "cancelled"]),
      review_revision: taskDomain.revisionSchema,
      input_review_revision: taskDomain.revisionSchema,
    }).strict().nullable().parse(value);
    return latest !== null
      && latest.status === "rejected"
      && latest.review_revision === latest.input_review_revision;
  }

  #resolveDispatch(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "dispatch.resolve_ambiguity" }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
    const source = this.#run(workspace.workspace_id, command.sourceRunId);
    const claim = this.#activeClaim(workspace.workspace_id, task.task_id);
    const phase = resolvedAmbiguousDispatchPhase({
      sourcePhase: source.phase,
      taskRevision: task.revision,
      expectedTaskRevision: command.expectedTaskRevision,
      taskStatus: task.status,
      taskHasCurrentClaim: claim !== null,
      sourceFenceMatches: claim !== null && source.fence === claim.fence,
      anotherDispatchBlocksTask:
        this.#blockingRunCount(workspace.workspace_id, task.task_id, source.run_id) > 0,
    }, command.reason);
    if (source.task_id !== task.task_id || phase === null) {
      throw new LocalTaskStoreError("invalid_state", "Ambiguous run cannot be resolved");
    }
    this.#database.query(`
      UPDATE local_task_runs SET phase = ?3, desired_state = 'stop',
        recovery_state = 'recovered', finished_at = ?4, updated_at = ?4
      WHERE workspace_id = ?1 AND run_id = ?2
    `).run(workspace.workspace_id, source.run_id, phase, now);
    if (claim !== null) {
      this.#database.query(`
        UPDATE local_task_claims
        SET state = 'released', ended_at = ?3, updated_at = ?3
        WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'active'
      `).run(workspace.workspace_id, claim.claim_id, now);
    }
    this.#database.query(`
      UPDATE local_tasks
      SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'open' END,
        revision = revision + 1, updated_at = ?3
      WHERE workspace_id = ?1 AND task_id = ?2
    `).run(workspace.workspace_id, task.task_id, now);
    return {
      result: { kind: "run_updated", runId: source.run_id, phase },
      events: [{
        kind: "run.changed",
        taskId: task.task_id,
        runId: source.run_id,
        phase,
      }],
    };
  }

  #respondInteraction(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "interaction.respond" }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const run = this.#run(workspace.workspace_id, command.runId);
    const interaction = this.#interaction(workspace.workspace_id, command.interactionId);
    if (
      interaction.run_id !== run.run_id ||
      interaction.state !== "pending" ||
      JSON.stringify(command.request) !== JSON.stringify(
        taskDomain.portableRunInteractionRequestSchema.parse(
          parseJson(interaction.request_json),
        ),
      ) ||
      command.request.expiresAt <= now
    ) {
      throw new LocalTaskStoreError("invalid_state", "Interaction is stale");
    }
    const responseRevision = 1;
    this.#database.query(`
      UPDATE local_run_interactions
      SET state = 'answered', response_revision = ?3, responded_at = ?4
      WHERE workspace_id = ?1 AND interaction_id = ?2 AND state = 'pending'
    `).run(workspace.workspace_id, interaction.interaction_id, responseRevision, now);
    return {
      result: {
        kind: "interaction_updated",
        runId: run.run_id,
        interactionId: interaction.interaction_id,
        state: "answered",
      },
      events: [{
        kind: "interaction.changed",
        taskId: run.task_id,
        runId: run.run_id,
        interactionId: interaction.interaction_id,
        state: "answered",
      }],
    };
  }

  #settleInteraction(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "interaction.settle" }>,
    now: number,
  ): AppliedCommand {
    this.#requireWorkspaceRevision(workspace, command.expectedWorkspaceRevision);
    const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
    const run = this.#run(workspace.workspace_id, command.runId);
    const interaction = this.#interaction(
      workspace.workspace_id,
      command.settlement.interactionId,
    );
    if (run.task_id !== task.task_id || interaction.run_id !== run.run_id) {
      throw new LocalTaskStoreError("not_found", "Interaction does not belong to the task run");
    }
    const state = command.settlement.outcome === "applied" ? "resolved" : "expired";
    if (command.settlement.outcome === "applied") {
      if (
        interaction.state !== "answered" ||
        interaction.response_revision !== command.settlement.responseRevision
      ) {
        throw new LocalTaskStoreError("invalid_state", "Interaction settlement is stale");
      }
    } else if (interaction.state !== "pending") {
      throw new LocalTaskStoreError("invalid_state", "Interaction settlement is stale");
    }
    this.#database.query(`
      UPDATE local_run_interactions
      SET state = ?3, resolved_at = ?4
      WHERE workspace_id = ?1 AND interaction_id = ?2
    `).run(workspace.workspace_id, interaction.interaction_id, state, now);
    return {
      result: {
        kind: "interaction_updated",
        runId: run.run_id,
        interactionId: interaction.interaction_id,
        state,
      },
      events: [{
        kind: "interaction.changed",
        taskId: task.task_id,
        runId: run.run_id,
        interactionId: interaction.interaction_id,
        state,
      }],
    };
  }

  #wakeDeferred(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "defer.wake" }>,
    now: number,
  ): AppliedCommand {
    const task = this.#taskForMutation(workspace, command.taskId, command.expectedTaskRevision);
    if (
      task.status !== "open" ||
      task.available_at !== command.scheduledFor ||
      command.scheduledFor > now
    ) {
      throw new LocalTaskStoreError("invalid_state", "Deferred wake is stale or early");
    }
    this.#database.query(`
      UPDATE local_tasks SET revision = revision + 1, updated_at = ?3
      WHERE workspace_id = ?1 AND task_id = ?2
    `).run(workspace.workspace_id, task.task_id, now);
    this.#completeDueWork(workspace.workspace_id, "defer_wake", task.task_id, now);
    return {
      result: {
        kind: "task_updated",
        taskId: task.task_id,
        taskRevision: task.revision + 1,
      },
      events: [
        {
          kind: "system.defer_woke",
          taskId: task.task_id,
          scheduledFor: command.scheduledFor,
        },
        {
          kind: "task.changed",
          taskId: task.task_id,
          taskRevision: task.revision + 1,
          eventType: "task.became_ready",
        },
      ],
    };
  }

  #expireClaim(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "claim.expire" }>,
    now: number,
  ): AppliedCommand {
    const task = this.#task(workspace.workspace_id, command.taskId);
    const claim = this.#activeClaim(workspace.workspace_id, task.task_id);
    if (
      claim === null ||
      claim.claim_id !== command.claimId ||
      claim.fence !== command.fence ||
      claim.lease_generation !== command.leaseGeneration ||
      claim.lease_until !== command.expectedDeadline ||
      claim.lease_until > now
    ) {
      throw new LocalTaskStoreError("invalid_state", "Claim expiry is stale or early");
    }
    const currentExecution = z.object({ present: z.literal(1) }).strict()
      .nullable()
      .parse(this.#database.query(`
        SELECT 1 AS present
        FROM local_run_execution_bindings AS binding
        JOIN local_task_runs AS run
          ON run.workspace_id = binding.workspace_id
          AND run.run_id = binding.run_id
        JOIN local_runtime_boot_state AS boot ON boot.singleton = 1
        WHERE binding.workspace_id = ?1
          AND binding.claim_id = ?2
          AND binding.capacity_released_at IS NULL
          AND binding.runtime_boot_id = boot.boot_id
          AND run.boot_generation = boot.boot_generation
        LIMIT 1
      `).get(workspace.workspace_id, claim.claim_id));
    if (currentExecution !== null) {
      throw new LocalTaskStoreError(
        "capacity_full",
        "The current execution still owns this claim",
      );
    }
    this.#database.query(`
      UPDATE local_task_claims
      SET state = 'expired', ended_at = ?3, updated_at = ?3
      WHERE workspace_id = ?1 AND claim_id = ?2 AND state = 'active'
    `).run(workspace.workspace_id, claim.claim_id, now);
    this.#database.query(`
      UPDATE local_tasks SET status = 'open', revision = revision + 1, updated_at = ?3
      WHERE workspace_id = ?1 AND task_id = ?2 AND status = 'in_progress'
    `).run(workspace.workspace_id, task.task_id, now);
    this.#completeDueWork(workspace.workspace_id, "claim_expiry", claim.claim_id, now);
    return {
      result: {
        kind: "task_updated",
        taskId: task.task_id,
        taskRevision: task.revision + 1,
      },
      events: [
        {
          kind: "system.claim_expired",
          taskId: task.task_id,
          claimId: claim.claim_id,
          fence: claim.fence,
        },
        {
          kind: "task.changed",
          taskId: task.task_id,
          taskRevision: task.revision + 1,
          eventType: "task.claim_expired",
        },
      ],
    };
  }

  #reconcileRun(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "run.reconcile" }>,
    now: number,
  ): AppliedCommand {
    const run = this.#run(workspace.workspace_id, command.runId);
    if (taskDomain.isTerminalRunPhase(run.phase) || run.boot_generation === command.bootGeneration) {
      throw new LocalTaskStoreError("invalid_state", "Run does not require recovery");
    }
    this.#database.query(`
      UPDATE local_task_runs
      SET phase = 'ambiguous', desired_state = 'stop', recovery_state = 'ambiguous',
        finished_at = ?3, updated_at = ?3
      WHERE workspace_id = ?1 AND run_id = ?2
    `).run(workspace.workspace_id, run.run_id, now);
    const settledIntent = this.#database.query(`
      UPDATE local_queued_run_intents
      SET state = 'abandoned', updated_at = ?4
      WHERE workspace_id = ?1 AND run_id = ?2
        AND state = 'started'
        AND claimed_boot_generation IS NOT NULL
        AND claimed_boot_generation <> ?3
    `).run(
      workspace.workspace_id,
      run.run_id,
      command.bootGeneration,
      now,
    );
    if (settledIntent.changes !== 1) {
      throw new LocalTaskStoreError(
        "invalid_state",
        "Run recovery does not own one abandoned started intent",
      );
    }
    if (run.claim_id !== null) {
      this.#database.query(`
        UPDATE local_due_work
        SET state = 'cancelled', claimed_boot_generation = NULL,
          claimed_at = NULL, updated_at = ?3
        WHERE workspace_id = ?1 AND work_kind = 'claim_expiry'
          AND entity_id = ?2 AND state IN ('pending', 'claimed')
      `).run(workspace.workspace_id, run.claim_id, now);
    }
    this.#completeDueWork(workspace.workspace_id, "run_recovery", run.run_id, now);
    return {
      result: { kind: "run_updated", runId: run.run_id, phase: "ambiguous" },
      events: [
        {
          kind: "system.run_reconciled",
          runId: run.run_id,
          bootGeneration: command.bootGeneration,
        },
        {
          kind: "run.changed",
          taskId: run.task_id,
          runId: run.run_id,
          phase: "ambiguous",
        },
      ],
    };
  }

  #expireInteraction(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: Extract<LocalWorkspaceCommand, { kind: "interaction.expire" }>,
    now: number,
  ): AppliedCommand {
    const run = this.#run(workspace.workspace_id, command.runId);
    const interaction = this.#interaction(workspace.workspace_id, command.interactionId);
    const request = taskDomain.portableRunInteractionRequestSchema.parse(
      parseJson(interaction.request_json),
    );
    if (
      interaction.run_id !== run.run_id ||
      interaction.state !== "pending" ||
      request.expiresAt !== command.expectedDeadline ||
      request.expiresAt > now
    ) {
      throw new LocalTaskStoreError("invalid_state", "Interaction expiry is stale or early");
    }
    this.#database.query(`
      UPDATE local_run_interactions
      SET state = 'expired', resolved_at = ?3
      WHERE workspace_id = ?1 AND interaction_id = ?2 AND state = 'pending'
    `).run(workspace.workspace_id, interaction.interaction_id, now);
    this.#completeDueWork(
      workspace.workspace_id,
      "interaction_expiry",
      interaction.interaction_id,
      now,
    );
    return {
      result: {
        kind: "interaction_updated",
        runId: run.run_id,
        interactionId: interaction.interaction_id,
        state: "expired",
      },
      events: [
        {
          kind: "system.interaction_expired",
          runId: run.run_id,
          interactionId: interaction.interaction_id,
        },
        {
          kind: "interaction.changed",
          taskId: run.task_id,
          runId: run.run_id,
          interactionId: interaction.interaction_id,
          state: "expired",
        },
      ],
    };
  }

  #workspace(workspaceId: string): z.infer<typeof workspaceRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT workspace_id, name, slug, key_prefix, revision, event_sequence,
        authority_kind, owner_installation_id, promotion_id, authority_phase,
        cloud_workspace_id, created_at, updated_at
      FROM local_workspaces
      WHERE workspace_id = ?1 AND tombstoned_at IS NULL
    `).get(workspaceId);
    const row = workspaceRowSchema.nullable().parse(value);
    if (row === null) throw new LocalTaskStoreError("not_found", "Workspace does not exist");
    return row;
  }

  #task(workspaceId: string, taskId: string): z.infer<typeof taskRowSchema> {
    const task = this.#taskOrNull(workspaceId, taskId);
    if (task === null) throw new LocalTaskStoreError("not_found", "Task does not exist");
    return task;
  }

  #taskOrNull(workspaceId: string, taskId: string): z.infer<typeof taskRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT workspace_id, task_id, task_key, title, task_type, priority, status,
        available_at, assignee_agent_id, parent_task_id, repository_id,
        unresolved_blocker_count, cancelled_blocker_count, revision,
        review_revision, created_at, updated_at, completed_at, cancelled_at
      FROM local_tasks WHERE workspace_id = ?1 AND task_id = ?2
    `).get(workspaceId, taskId);
    return taskRowSchema.nullable().parse(value);
  }

  #taskForMutation(
    workspace: z.infer<typeof workspaceRowSchema>,
    taskId: string,
    expectedTaskRevision: number,
  ): z.infer<typeof taskRowSchema> {
    const task = this.#task(workspace.workspace_id, taskId);
    if (task.revision !== expectedTaskRevision) {
      throw new LocalTaskStoreError("revision_conflict", "Task revision changed");
    }
    return task;
  }

  #run(workspaceId: string, runId: string): z.infer<typeof runRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT run_id, task_id, repository_id, phase, desired_state, source_run_id,
        retried_by_run_id, claim_id, fence, boot_generation, created_at, updated_at
      FROM local_task_runs WHERE workspace_id = ?1 AND run_id = ?2
    `).get(workspaceId, runId);
    const row = runRowSchema.nullable().parse(value);
    if (row === null) throw new LocalTaskStoreError("not_found", "Run does not exist");
    return row;
  }

  #interaction(
    workspaceId: string,
    interactionId: string,
  ): z.infer<typeof interactionRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT interaction_id, run_id, request_json, state, response_revision,
        responded_at, resolved_at
      FROM local_run_interactions
      WHERE workspace_id = ?1 AND interaction_id = ?2
    `).get(workspaceId, interactionId);
    const row = interactionRowSchema.nullable().parse(value);
    if (row === null) {
      throw new LocalTaskStoreError("not_found", "Interaction does not exist");
    }
    return row;
  }

  #activeClaim(
    workspaceId: string,
    taskId: string,
  ): z.infer<typeof claimRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT claim_id, agent_id, fence, lease_generation, lease_until
      FROM local_task_claims
      WHERE workspace_id = ?1 AND task_id = ?2 AND state = 'active'
    `).get(workspaceId, taskId);
    return claimRowSchema.nullable().parse(value);
  }

  #workspaceSummary(
    workspace: z.infer<typeof workspaceRowSchema>,
    now: number,
  ): WorkspaceSummary {
    const countsValue: unknown = this.#database.query(`
      SELECT
        count(*) AS all_count,
        coalesce(sum(CASE WHEN status = 'open' AND available_at <= ?2
          AND unresolved_blocker_count = 0 AND cancelled_blocker_count = 0
          THEN 1 ELSE 0 END), 0) AS ready_count,
        coalesce(sum(CASE WHEN unresolved_blocker_count + cancelled_blocker_count > 0
          THEN 1 ELSE 0 END), 0) AS blocked_count,
        coalesce(sum(CASE WHEN status = 'open' AND available_at > ?2
          THEN 1 ELSE 0 END), 0) AS deferred_count,
        coalesce(sum(CASE WHEN cancelled_blocker_count > 0
          OR (status = 'done' AND unresolved_blocker_count > 0)
          THEN 1 ELSE 0 END), 0) AS attention_count,
        coalesce(sum(CASE WHEN assignee_agent_id IS NOT NULL
          THEN 1 ELSE 0 END), 0) AS assigned_count,
        coalesce(sum(CASE WHEN status = 'in_review'
          THEN 1 ELSE 0 END), 0) AS review_count
      FROM local_tasks WHERE workspace_id = ?1
    `).get(workspace.workspace_id, now);
    const counts = z.object({
      all_count: z.number().int().nonnegative(),
      ready_count: z.number().int().nonnegative(),
      blocked_count: z.number().int().nonnegative(),
      deferred_count: z.number().int().nonnegative(),
      attention_count: z.number().int().nonnegative(),
      assigned_count: z.number().int().nonnegative(),
      review_count: z.number().int().nonnegative(),
    }).strict().parse(countsValue);
    const authority = taskDomain.workspaceAuthoritySchema.parse(
      workspaceAuthority(workspace),
    );
    const publicWorkspaceId = authority.kind === "cloud"
      ? authority.cloudWorkspaceId
      : workspace.workspace_id;
    return workspaceSummarySchema.parse({
      id: publicWorkspaceId,
      name: workspace.name,
      slug: workspace.slug,
      keyPrefix: workspace.key_prefix,
      revision: workspace.revision,
      authority,
      counts: {
        all: boundedCount(counts.all_count),
        ready: boundedCount(counts.ready_count),
        blocked: boundedCount(counts.blocked_count),
        deferred: boundedCount(counts.deferred_count),
        attention: boundedCount(counts.attention_count),
        assigned: boundedCount(counts.assigned_count),
        review: boundedCount(counts.review_count),
      },
    });
  }

  #listItem(task: z.infer<typeof taskRowSchema>, now: number): unknown {
    const runValue: unknown = this.#database.query(`
      SELECT run_id, task_id, repository_id, phase, desired_state, source_run_id,
        retried_by_run_id, claim_id, fence, boot_generation, created_at, updated_at
      FROM local_task_runs
      WHERE workspace_id = ?1 AND task_id = ?2
      ORDER BY updated_at DESC, run_id DESC
      LIMIT 1
    `).get(task.workspace_id, task.task_id);
    const run = runRowSchema.nullable().parse(runValue);
    let latestDisplay: unknown = null;
    if (run !== null) {
      const eventValue: unknown = this.#database.query(`
        SELECT event_id, sequence, event_kind, display_text, observed_at
        FROM local_run_public_events
        WHERE workspace_id = ?1 AND run_id = ?2
        ORDER BY sequence DESC LIMIT 1
      `).get(task.workspace_id, run.run_id);
      const event = runEventRowSchema.nullable().parse(eventValue);
      if (event !== null) {
        latestDisplay = event.display_text === null
          ? { kind: event.event_kind, observedAt: event.observed_at }
          : {
              kind: event.event_kind,
              observedAt: event.observed_at,
              displayText: event.display_text,
            };
      }
    }
    return {
      task: this.#taskView(task, now),
      run: run === null
        ? null
        : {
            latestDisplay,
            phase: run.phase,
            updatedAt: run.updated_at,
          },
      humanInput: this.#taskHumanInput(task.workspace_id, task.task_id),
    };
  }

  #taskHumanInput(workspaceId: string, taskId: string): unknown {
    const values: unknown[] = this.#database.query(`
      SELECT local_run_interactions.request_json
      FROM local_run_interactions
      JOIN local_task_runs
        ON local_task_runs.workspace_id = local_run_interactions.workspace_id
        AND local_task_runs.run_id = local_run_interactions.run_id
      WHERE local_run_interactions.workspace_id = ?1
        AND local_task_runs.task_id = ?2
        AND local_run_interactions.state = 'pending'
      ORDER BY local_run_interactions.created_at, local_run_interactions.interaction_id
      LIMIT ?3
    `).all(
      workspaceId,
      taskId,
      taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT + 1,
    );
    if (values.length === 0) return null;
    if (values.length > taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT) {
      throw new Error("Task pending interaction projection exceeds its bound");
    }
    const requests = values.map((value) => {
      const row = z.object({ request_json: z.string() }).strict().parse(value);
      return taskDomain.portableRunInteractionRequestSchema.parse(parseJson(row.request_json));
    });
    const first = requests[0];
    if (first === undefined) return null;
    return {
      pendingCount: requests.length,
      oldestRequestedAt: Math.min(...requests.map(({ createdAt }) => createdAt)),
      expiresAt: Math.min(...requests.map(({ expiresAt }) => expiresAt)),
      kind: first.kind === "file_change_approval" ? "approval" : "user_input",
      preview: first.kind === "file_change_approval"
        ? "File change approval requested."
        : first.questions[0]?.prompt ?? "User input requested.",
    };
  }

  #taskView(task: z.infer<typeof taskRowSchema>, now: number): unknown {
    const base = {
      id: task.task_id,
      key: task.task_key,
      title: task.title,
      type: task.task_type,
      priority: task.priority,
      availableAt: task.available_at,
      isReady: derivedReady({
        status: task.status,
        availableAt: task.available_at,
        now,
        unresolved: task.unresolved_blocker_count,
        cancelled: task.cancelled_blocker_count,
      }),
      unresolvedBlockerCount: task.unresolved_blocker_count,
      cancelledBlockerCount: task.cancelled_blocker_count,
      revision: task.revision,
      reviewRevision: task.review_revision,
      ...(task.assignee_agent_id === null
        ? {}
        : { assigneeAgentId: task.assignee_agent_id }),
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      status: task.status,
    };
    if (task.status !== "in_progress") return taskDomain.taskViewSchema.parse(base);
    const claim = this.#activeClaim(task.workspace_id, task.task_id);
    if (claim === null) throw new Error("In-progress local task is missing its active claim");
    return taskDomain.taskViewSchema.parse({
      ...base,
      currentClaim: {
        id: claim.claim_id,
        agentId: claim.agent_id,
        fence: claim.fence,
        leaseGeneration: claim.lease_generation,
        leaseUntil: claim.lease_until,
      },
    });
  }

  #atomicTaskDetail(
    workspace: z.infer<typeof workspaceRowSchema>,
    taskId: string,
    now: number,
  ): TaskDetailProjection {
    const selectedValue: unknown = this.#database.query(`
      SELECT tasks.workspace_id, tasks.task_id, tasks.task_key, tasks.title,
        tasks.task_type, tasks.priority, tasks.status, tasks.available_at,
        tasks.assignee_agent_id, tasks.parent_task_id, tasks.repository_id,
        tasks.unresolved_blocker_count, tasks.cancelled_blocker_count,
        tasks.revision, tasks.review_revision, tasks.created_at,
        tasks.updated_at, tasks.completed_at, tasks.cancelled_at,
        claims.claim_id AS active_claim_id,
        claims.agent_id AS active_claim_agent_id,
        claims.fence AS active_claim_fence,
        claims.lease_generation AS active_claim_lease_generation,
        claims.lease_until AS active_claim_lease_until,
        (
          SELECT description
          FROM local_task_bodies
          WHERE workspace_id = tasks.workspace_id
            AND task_id = tasks.task_id
        ) AS description,
        parent.task_key AS parent_task_key,
        parent.title AS parent_title,
        parent.priority AS parent_priority,
        parent.revision AS parent_revision,
        parent.status AS parent_status,
        (
          SELECT count(*)
          FROM local_task_claims AS expired_claims
          WHERE expired_claims.workspace_id = tasks.workspace_id
            AND expired_claims.task_id = tasks.task_id
            AND expired_claims.state = 'expired'
        ) AS expired_claim_count,
        submissions.submission_id,
        submissions.submitted_by_json,
        submissions.review_revision AS submission_review_revision,
        submissions.summary AS submission_summary,
        submissions.evidence_json AS submission_evidence_json,
        submissions.status AS submission_status,
        submissions.submitted_at,
        submissions.reviewed_at,
        reviews.reason AS review_reason
      FROM local_tasks AS tasks
      LEFT JOIN local_task_claims AS claims
        ON claims.workspace_id = tasks.workspace_id
        AND claims.task_id = tasks.task_id
        AND claims.state = 'active'
      LEFT JOIN local_tasks AS parent
        ON parent.workspace_id = tasks.workspace_id
        AND parent.task_id = tasks.parent_task_id
      LEFT JOIN local_task_submissions AS submissions
        ON submissions.workspace_id = tasks.workspace_id
        AND submissions.submission_id = (
          SELECT candidate.submission_id
          FROM local_task_submissions AS candidate
          WHERE candidate.workspace_id = tasks.workspace_id
            AND candidate.task_id = tasks.task_id
          ORDER BY candidate.submitted_at DESC,
            candidate.submission_id DESC
          LIMIT 1
        )
      LEFT JOIN local_task_reviews AS reviews
        ON reviews.workspace_id = submissions.workspace_id
        AND reviews.submission_id = submissions.submission_id
      WHERE tasks.workspace_id = ?1 AND tasks.task_id = ?2
    `).get(workspace.workspace_id, taskId);
    const task = projectionSelectedTaskRowSchema.nullable().parse(selectedValue);
    if (task === null) {
      throw new LocalTaskStoreError("not_found", "Task does not exist");
    }

    const labelValues: unknown[] = this.#database.query(`
      SELECT label
      FROM local_task_labels
      WHERE workspace_id = ?1 AND task_id = ?2
      ORDER BY label
      LIMIT ?3
    `).all(
      workspace.workspace_id,
      taskId,
      taskDomain.MAX_TASK_LABELS + 1,
    );
    if (labelValues.length > taskDomain.MAX_TASK_LABELS) {
      throw new LocalTaskStoreError(
        "capacity_full",
        "Task label projection exceeds its bound",
      );
    }
    const labels = labelValues.map((value) =>
      z.object({ label: taskDomain.taskLabelSchema }).strict().parse(value).label
    );

    const graphValues: unknown[] = this.#database.query(`
      WITH raw_edges AS (
        SELECT 'blockers' AS direction,
          dependencies.created_at AS dependency_created_at,
          linked.workspace_id, linked.task_id, linked.task_key, linked.title,
          linked.task_type, linked.priority, linked.status,
          linked.available_at, linked.assignee_agent_id,
          linked.parent_task_id, linked.repository_id,
          linked.unresolved_blocker_count, linked.cancelled_blocker_count,
          linked.revision, linked.review_revision, linked.created_at,
          linked.updated_at, linked.completed_at, linked.cancelled_at
        FROM local_task_dependencies AS dependencies
        JOIN local_tasks AS linked
          ON linked.workspace_id = dependencies.workspace_id
          AND linked.task_id = dependencies.blocker_task_id
        WHERE dependencies.workspace_id = ?1
          AND dependencies.blocked_task_id = ?2
        UNION ALL
        SELECT 'dependents' AS direction,
          dependencies.created_at AS dependency_created_at,
          linked.workspace_id, linked.task_id, linked.task_key, linked.title,
          linked.task_type, linked.priority, linked.status,
          linked.available_at, linked.assignee_agent_id,
          linked.parent_task_id, linked.repository_id,
          linked.unresolved_blocker_count, linked.cancelled_blocker_count,
          linked.revision, linked.review_revision, linked.created_at,
          linked.updated_at, linked.completed_at, linked.cancelled_at
        FROM local_task_dependencies AS dependencies
        JOIN local_tasks AS linked
          ON linked.workspace_id = dependencies.workspace_id
          AND linked.task_id = dependencies.blocked_task_id
        WHERE dependencies.workspace_id = ?1
          AND dependencies.blocker_task_id = ?2
      ),
      numbered_edges AS (
        SELECT raw_edges.*,
          row_number() OVER (
            PARTITION BY direction
            ORDER BY dependency_created_at, task_id
          ) AS ordinal,
          count(*) OVER (PARTITION BY direction) AS group_count
        FROM raw_edges
      )
      SELECT direction, group_count, dependency_created_at,
        workspace_id, task_id, task_key, title, task_type, priority, status,
        available_at, assignee_agent_id, parent_task_id, repository_id,
        unresolved_blocker_count, cancelled_blocker_count, revision,
        review_revision, created_at, updated_at, completed_at, cancelled_at
      FROM numbered_edges
      WHERE ordinal <= ?3
      ORDER BY direction, ordinal
    `).all(
      workspace.workspace_id,
      taskId,
      taskDomain.MAX_PORTABLE_DETAIL_COLLECTION + 1,
    );
    const graph = {
      blockers: [] as unknown[],
      dependents: [] as unknown[],
    };
    const truncatedCollections: string[] = [];
    for (const value of graphValues) {
      const edge = projectionGraphEdgeRowSchema.parse(value);
      if (
        edge.group_count > taskDomain.MAX_PORTABLE_DETAIL_COLLECTION &&
        !truncatedCollections.includes(edge.direction)
      ) {
        truncatedCollections.push(edge.direction);
      }
      if (
        graph[edge.direction].length <
          taskDomain.MAX_PORTABLE_DETAIL_COLLECTION
      ) {
        graph[edge.direction].push({
          createdAt: edge.dependency_created_at,
          task: projectionTaskLink(edge),
        });
      }
    }

    const childValues: unknown[] = this.#database.query(`
      SELECT workspace_id, task_id, task_key, title, task_type, priority,
        status, available_at, assignee_agent_id, parent_task_id,
        repository_id, unresolved_blocker_count, cancelled_blocker_count,
        revision, review_revision, created_at, updated_at, completed_at,
        cancelled_at
      FROM local_tasks
      WHERE workspace_id = ?1 AND parent_task_id = ?2
      ORDER BY updated_at DESC, task_id
      LIMIT ?3
    `).all(
      workspace.workspace_id,
      taskId,
      taskDomain.MAX_PORTABLE_DETAIL_COLLECTION + 1,
    );
    if (childValues.length > taskDomain.MAX_PORTABLE_DETAIL_COLLECTION) {
      truncatedCollections.push("children");
    }
    const children = childValues
      .slice(0, taskDomain.MAX_PORTABLE_DETAIL_COLLECTION)
      .map((value) => projectionTaskLink(taskRowSchema.parse(value)));

    const commentValues: unknown[] = this.#database.query(`
      SELECT comment_id, actor_json, body, created_at
      FROM local_task_comments
      WHERE workspace_id = ?1 AND task_id = ?2
      ORDER BY created_at DESC, comment_id DESC
      LIMIT ?3
    `).all(
      workspace.workspace_id,
      taskId,
      taskDomain.MAX_PORTABLE_DETAIL_COMMENTS + 1,
    );
    if (commentValues.length > taskDomain.MAX_PORTABLE_DETAIL_COMMENTS) {
      truncatedCollections.push("comments");
    }
    const comments = commentValues
      .slice(0, taskDomain.MAX_PORTABLE_DETAIL_COMMENTS)
      .map((value) => {
        const comment = projectionCommentRowSchema.parse(value);
        return taskDomain.taskWorkspaceCommentSchema.parse({
          id: comment.comment_id,
          actor: taskDomain.projectionActorSchema.parse(
            parseJson(comment.actor_json),
          ),
          body: comment.body,
          createdAt: comment.created_at,
        });
      });

    const eventValues: unknown[] = this.#database.query(`
      SELECT event_json
      FROM local_workspace_events
      WHERE workspace_id = ?1 AND task_id = ?2
        AND event_kind = 'task.changed'
      ORDER BY sequence DESC
      LIMIT ?3
    `).all(
      workspace.workspace_id,
      taskId,
      taskDomain.MAX_PORTABLE_DETAIL_EVENTS + 1,
    );
    if (eventValues.length > taskDomain.MAX_PORTABLE_DETAIL_EVENTS) {
      truncatedCollections.push("events");
    }
    const events = eventValues
      .slice(0, taskDomain.MAX_PORTABLE_DETAIL_EVENTS)
      .map((value) => {
        const eventRow = eventRowSchema.parse(value);
        const event = portableWorkspaceEventSchema.parse(
          parseJson(eventRow.event_json),
        );
        if (event.kind !== "task.changed") {
          throw new Error("Task event index returned a non-task event");
        }
        return taskDomain.taskWorkspaceEventProjectionSchema.parse({
          id: event.id,
          actor: projectionActor(event.actor),
          createdAt: event.recordedAt,
          summary: eventSummary(event),
          taskRevision: event.taskRevision,
          type: event.eventType,
        });
      });

    const referenceValues: unknown[] = this.#database.query(`
      SELECT reference_json
      FROM local_task_references
      WHERE workspace_id = ?1 AND task_id = ?2
      ORDER BY created_at DESC, reference_id DESC
      LIMIT ?3
    `).all(
      workspace.workspace_id,
      taskId,
      taskDomain.MAX_PORTABLE_DETAIL_REFERENCES + 1,
    );
    if (referenceValues.length > taskDomain.MAX_PORTABLE_DETAIL_REFERENCES) {
      truncatedCollections.push("references");
    }
    const references = referenceValues
      .slice(0, taskDomain.MAX_PORTABLE_DETAIL_REFERENCES)
      .map((value) => {
        const reference = z.object({
          reference_json: z.string(),
        }).strict().parse(value);
        return taskDomain.taskReferenceViewSchema.parse(
          parseJson(reference.reference_json),
        );
      });

    const runValues: unknown[] = this.#database.query(`
      SELECT run_id, task_id, repository_id, phase, desired_state,
        source_run_id, retried_by_run_id, claim_id, fence, boot_generation,
        created_at, updated_at
      FROM local_task_runs
      WHERE workspace_id = ?1 AND task_id = ?2
      ORDER BY updated_at DESC, run_id DESC
      LIMIT ?3
    `).all(
      workspace.workspace_id,
      taskId,
      taskDomain.MAX_PORTABLE_DETAIL_RUNS + 1,
    );
    if (runValues.length > taskDomain.MAX_PORTABLE_DETAIL_RUNS) {
      truncatedCollections.push("runs");
    }
    const runRows = runValues
      .slice(0, taskDomain.MAX_PORTABLE_DETAIL_RUNS)
      .map((value) => runRowSchema.parse(value));
    const runIdsJson = JSON.stringify(runRows.map(({ run_id }) => run_id));

    const runEventValues: unknown[] = this.#database.query(`
      WITH requested_runs(run_id) AS (
        SELECT value FROM json_each(?2)
      )
      SELECT events.run_id, events.event_id, events.sequence,
        events.event_kind, events.display_text, events.observed_at
      FROM local_run_public_events AS events
      JOIN requested_runs USING (run_id)
      WHERE events.workspace_id = ?1
      ORDER BY events.run_id, events.sequence
    `).all(workspace.workspace_id, runIdsJson);
    const runEvents = new Map<string, z.infer<typeof runEventRowSchema>[]>();
    for (const value of runEventValues) {
      const event = projectionRunEventRowSchema.parse(value);
      const values = runEvents.get(event.run_id) ?? [];
      values.push(event);
      if (values.length > taskDomain.MAX_PORTABLE_RUN_EVENTS) {
        throw new LocalTaskStoreError(
          "capacity_full",
          "Run event projection exceeds its bound",
        );
      }
      runEvents.set(event.run_id, values);
    }

    const runInteractionValues: unknown[] = this.#database.query(`
      WITH requested_runs(run_id) AS (
        SELECT value FROM json_each(?2)
      ),
      ranked_interactions AS (
        SELECT interactions.interaction_id, interactions.run_id,
          interactions.request_json, interactions.state,
          interactions.response_revision, interactions.responded_at,
          interactions.resolved_at,
          row_number() OVER (
            PARTITION BY interactions.run_id
            ORDER BY interactions.created_at, interactions.interaction_id
          ) AS ordinal,
          count(*) OVER (
            PARTITION BY interactions.run_id
          ) AS group_count
        FROM local_run_interactions AS interactions
        JOIN requested_runs USING (run_id)
        WHERE interactions.workspace_id = ?1
      )
      SELECT interaction_id, run_id, request_json, state, response_revision,
        responded_at, resolved_at, group_count
      FROM ranked_interactions
      WHERE ordinal <= ?3
      ORDER BY run_id, ordinal
    `).all(
      workspace.workspace_id,
      runIdsJson,
      taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT + 1,
    );
    const runInteractions =
      new Map<string, z.infer<typeof interactionRowSchema>[]>();
    for (const value of runInteractionValues) {
      const interaction = projectionRunInteractionRowSchema.parse(value);
      if (
        interaction.group_count >
          taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT
      ) {
        throw new LocalTaskStoreError(
          "capacity_full",
          "Run interaction projection exceeds its bound",
        );
      }
      const values = runInteractions.get(interaction.run_id) ?? [];
      values.push(interaction);
      runInteractions.set(interaction.run_id, values);
    }

    let submission: unknown = null;
    if (task.submission_id !== null) {
      if (
        task.submitted_by_json === null ||
        task.submission_review_revision === null ||
        task.submission_summary === null ||
        task.submission_evidence_json === null ||
        task.submission_status === null ||
        task.submitted_at === null
      ) {
        throw new Error("Latest task submission projection is incomplete");
      }
      submission = taskDomain.taskWorkspaceSubmissionSchema.parse({
        id: task.submission_id,
        submittedBy: taskDomain.projectionActorSchema.parse(
          parseJson(task.submitted_by_json),
        ),
        reviewRevision: task.submission_review_revision,
        summary: task.submission_summary,
        evidence: z.array(taskDomain.submissionEvidenceInputSchema)
          .max(taskDomain.MAX_SUBMISSION_EVIDENCE)
          .parse(parseJson(task.submission_evidence_json)),
        status: task.submission_status,
        submittedAt: task.submitted_at,
        taskKey: task.task_key,
        ...(task.reviewed_at === null
          ? {}
          : { reviewedAt: task.reviewed_at }),
        ...(task.review_reason === null
          ? {}
          : { reviewReason: task.review_reason }),
      });
    }

    const recoveries = new Set<string>();
    if (task.status === "cancelled") recoveries.add("task_cancelled");
    if (task.cancelled_blocker_count > 0) {
      recoveries.add("cancelled_blocker");
    }
    const parsedSubmission =
      taskDomain.taskWorkspaceSubmissionSchema.nullable().parse(submission);
    if (parsedSubmission?.status === "rejected") {
      recoveries.add("submission_rejected");
    }
    if (task.expired_claim_count > 0) recoveries.add("claim_expired");

    const parent = task.parent_task_id === null
      ? null
      : (() => {
          if (
            task.parent_task_key === null ||
            task.parent_title === null ||
            task.parent_priority === null ||
            task.parent_revision === null ||
            task.parent_status === null
          ) {
            throw new Error("Parent task projection is incomplete");
          }
          return {
            id: task.parent_task_id,
            key: task.parent_task_key,
            priority: task.parent_priority,
            revision: task.parent_revision,
            status: task.parent_status,
            title: task.parent_title,
          };
        })();

    const runs = runRows.map((run) =>
      taskDomain.portableRunProjectionSchema.parse({
        id: run.run_id,
        taskKey: task.task_key,
        phase: run.phase,
        repositoryId: run.repository_id,
        desiredState: run.desired_state,
        updatedAt: run.updated_at,
        events: (runEvents.get(run.run_id) ?? []).map((event) =>
          event.display_text === null
            ? {
                id: event.event_id,
                sequence: event.sequence,
                kind: event.event_kind,
                observedAt: event.observed_at,
              }
            : {
                id: event.event_id,
                sequence: event.sequence,
                kind: event.event_kind,
                displayText: event.display_text,
                observedAt: event.observed_at,
              }
        ),
        interactions: (runInteractions.get(run.run_id) ?? []).map(
          (interaction) => ({
            runId: run.run_id,
            request: taskDomain.portableRunInteractionRequestSchema.parse(
              parseJson(interaction.request_json),
            ),
            state: interaction.state,
            ...(interaction.response_revision === null
              ? {}
              : { responseRevision: interaction.response_revision }),
            ...(interaction.responded_at === null
              ? {}
              : { respondedAt: interaction.responded_at }),
            ...(interaction.resolved_at === null
              ? {}
              : { resolvedAt: interaction.resolved_at }),
          }),
        ),
      })
    );

    return taskDetailProjectionSchema.parse({
      workspaceId: workspace.workspace_id,
      projectionRevision: workspace.revision,
      task: projectionTaskView(task, now),
      description: task.description,
      labels,
      parent,
      blockers: graph.blockers,
      dependents: graph.dependents,
      children,
      comments,
      events,
      references,
      runs,
      submission,
      recoveries: [...recoveries].sort().map((kind) => ({ kind })),
      truncatedCollections,
    });
  }

  #taskDetail(
    workspace: z.infer<typeof workspaceRowSchema>,
    task: z.infer<typeof taskRowSchema>,
    now: number,
  ): TaskDetailProjection {
    const truncatedCollections: string[] = [];
    const descriptionValue: unknown = this.#database.query(`
      SELECT description FROM local_task_bodies
      WHERE workspace_id = ?1 AND task_id = ?2
    `).get(workspace.workspace_id, task.task_id);
    const description = z.object({ description: z.string() }).strict().parse(
      descriptionValue,
    ).description;
    const labelValues: unknown[] = this.#database.query(`
      SELECT label FROM local_task_labels
      WHERE workspace_id = ?1 AND task_id = ?2 ORDER BY label
    `).all(workspace.workspace_id, task.task_id);
    const labels = labelValues.map((value) =>
      z.object({ label: taskDomain.taskLabelSchema }).strict().parse(value).label);
    const parent = task.parent_task_id === null
      ? null
      : this.#taskLink(this.#task(workspace.workspace_id, task.parent_task_id));
    const blockers = this.#graphEdges(
      workspace.workspace_id,
      task.task_id,
      "blockers",
      truncatedCollections,
    );
    const dependents = this.#graphEdges(
      workspace.workspace_id,
      task.task_id,
      "dependents",
      truncatedCollections,
    );
    const childValues: unknown[] = this.#database.query(`
      SELECT workspace_id, task_id, task_key, title, task_type, priority, status,
        available_at, assignee_agent_id, parent_task_id, repository_id,
        unresolved_blocker_count, cancelled_blocker_count, revision,
        review_revision, created_at, updated_at, completed_at, cancelled_at
      FROM local_tasks
      WHERE workspace_id = ?1 AND parent_task_id = ?2
      ORDER BY updated_at DESC, task_id
      LIMIT ?3
    `).all(
      workspace.workspace_id,
      task.task_id,
      taskDomain.MAX_PORTABLE_DETAIL_COLLECTION + 1,
    );
    if (childValues.length > taskDomain.MAX_PORTABLE_DETAIL_COLLECTION) {
      truncatedCollections.push("children");
    }
    const children = childValues
      .slice(0, taskDomain.MAX_PORTABLE_DETAIL_COLLECTION)
      .map((value) => this.#taskLink(taskRowSchema.parse(value)));
    const comments = this.#comments(
      workspace.workspace_id,
      task.task_id,
      truncatedCollections,
    );
    const events = this.#taskEvents(
      workspace.workspace_id,
      task.task_id,
      truncatedCollections,
    );
    const references = this.#references(
      workspace.workspace_id,
      task.task_id,
      truncatedCollections,
    );
    const runs = this.#runs(
      workspace.workspace_id,
      task,
      truncatedCollections,
    );
    const submission = this.#submission(workspace.workspace_id, task);
    const recoveries = this.#recoveries(workspace.workspace_id, task, submission);
    return taskDetailProjectionSchema.parse({
      workspaceId: workspace.workspace_id,
      projectionRevision: workspace.revision,
      task: this.#taskView(task, now),
      description,
      labels,
      parent,
      blockers,
      dependents,
      children,
      comments,
      events,
      references,
      runs,
      submission,
      recoveries,
      truncatedCollections,
    });
  }

  #taskLink(task: z.infer<typeof taskRowSchema>): unknown {
    return {
      id: task.task_id,
      key: task.task_key,
      priority: task.priority,
      revision: task.revision,
      status: task.status,
      title: task.title,
    };
  }

  #graphEdges(
    workspaceId: string,
    taskId: string,
    direction: "blockers" | "dependents",
    truncatedCollections: string[],
  ): readonly unknown[] {
    const joinId = direction === "blockers" ? "blocker_task_id" : "blocked_task_id";
    const filterId = direction === "blockers" ? "blocked_task_id" : "blocker_task_id";
    const values: unknown[] = this.#database.query(`
      SELECT local_task_dependencies.created_at AS dependency_created_at,
        local_tasks.workspace_id, local_tasks.task_id, local_tasks.task_key,
        local_tasks.title, local_tasks.task_type, local_tasks.priority,
        local_tasks.status, local_tasks.available_at, local_tasks.assignee_agent_id,
        local_tasks.parent_task_id, local_tasks.repository_id,
        local_tasks.unresolved_blocker_count, local_tasks.cancelled_blocker_count,
        local_tasks.revision, local_tasks.review_revision, local_tasks.created_at,
        local_tasks.updated_at, local_tasks.completed_at, local_tasks.cancelled_at
      FROM local_task_dependencies
      JOIN local_tasks
        ON local_tasks.workspace_id = local_task_dependencies.workspace_id
        AND local_tasks.task_id = local_task_dependencies.${joinId}
      WHERE local_task_dependencies.workspace_id = ?1
        AND local_task_dependencies.${filterId} = ?2
      ORDER BY local_task_dependencies.created_at, local_tasks.task_id
      LIMIT ?3
    `).all(workspaceId, taskId, taskDomain.MAX_PORTABLE_DETAIL_COLLECTION + 1);
    if (values.length > taskDomain.MAX_PORTABLE_DETAIL_COLLECTION) {
      truncatedCollections.push(direction);
    }
    return values.slice(0, taskDomain.MAX_PORTABLE_DETAIL_COLLECTION).map((value) => {
      const row = graphEdgeRowSchema.parse(value);
      return {
        createdAt: row.dependency_created_at,
        task: this.#taskLink(row),
      };
    });
  }

  #comments(
    workspaceId: string,
    taskId: string,
    truncatedCollections: string[],
  ): readonly unknown[] {
    const values: unknown[] = this.#database.query(`
      SELECT comment_id, actor_json, body, created_at
      FROM local_task_comments
      WHERE workspace_id = ?1 AND task_id = ?2
      ORDER BY created_at DESC, comment_id DESC
      LIMIT ?3
    `).all(workspaceId, taskId, taskDomain.MAX_PORTABLE_DETAIL_COMMENTS + 1);
    if (values.length > taskDomain.MAX_PORTABLE_DETAIL_COMMENTS) {
      truncatedCollections.push("comments");
    }
    return values.slice(0, taskDomain.MAX_PORTABLE_DETAIL_COMMENTS).map((value) => {
      const row = z.object({
        comment_id: taskDomain.taskCommentIdSchema,
        actor_json: z.string(),
        body: taskDomain.taskCommentBodySchema,
        created_at: taskDomain.epochMsSchema,
      }).strict().parse(value);
      return taskDomain.taskWorkspaceCommentSchema.parse({
        id: row.comment_id,
        actor: taskDomain.projectionActorSchema.parse(parseJson(row.actor_json)),
        body: row.body,
        createdAt: row.created_at,
      });
    });
  }

  #taskEvents(
    workspaceId: string,
    taskId: string,
    truncatedCollections: string[],
  ): readonly unknown[] {
    const values: unknown[] = this.#database.query(`
      SELECT event_json
      FROM local_workspace_events
      WHERE workspace_id = ?1 AND task_id = ?2 AND event_kind = 'task.changed'
      ORDER BY sequence DESC
      LIMIT ?3
    `).all(workspaceId, taskId, taskDomain.MAX_PORTABLE_DETAIL_EVENTS + 1);
    if (values.length > taskDomain.MAX_PORTABLE_DETAIL_EVENTS) {
      truncatedCollections.push("events");
    }
    return values.slice(0, taskDomain.MAX_PORTABLE_DETAIL_EVENTS).map((value) => {
      const row = eventRowSchema.parse(value);
      const event = portableWorkspaceEventSchema.parse(parseJson(row.event_json));
      if (event.kind !== "task.changed") {
        throw new Error("Task event index returned a non-task event");
      }
      return taskDomain.taskWorkspaceEventProjectionSchema.parse({
        id: event.id,
        actor: projectionActor(event.actor),
        createdAt: event.recordedAt,
        summary: eventSummary(event),
        taskRevision: event.taskRevision,
        type: event.eventType,
      });
    });
  }

  #references(
    workspaceId: string,
    taskId: string,
    truncatedCollections: string[],
  ): readonly unknown[] {
    const values: unknown[] = this.#database.query(`
      SELECT reference_json FROM local_task_references
      WHERE workspace_id = ?1 AND task_id = ?2
      ORDER BY created_at DESC, reference_id DESC
      LIMIT ?3
    `).all(workspaceId, taskId, taskDomain.MAX_PORTABLE_DETAIL_REFERENCES + 1);
    if (values.length > taskDomain.MAX_PORTABLE_DETAIL_REFERENCES) {
      truncatedCollections.push("references");
    }
    return values.slice(0, taskDomain.MAX_PORTABLE_DETAIL_REFERENCES).map((value) => {
      const row = z.object({ reference_json: z.string() }).strict().parse(value);
      return taskDomain.taskReferenceViewSchema.parse(parseJson(row.reference_json));
    });
  }

  #runs(
    workspaceId: string,
    task: z.infer<typeof taskRowSchema>,
    truncatedCollections: string[],
  ): readonly unknown[] {
    const values: unknown[] = this.#database.query(`
      SELECT run_id, task_id, repository_id, phase, desired_state, source_run_id,
        retried_by_run_id, claim_id, fence, boot_generation, created_at, updated_at
      FROM local_task_runs
      WHERE workspace_id = ?1 AND task_id = ?2
      ORDER BY updated_at DESC, run_id DESC
      LIMIT ?3
    `).all(workspaceId, task.task_id, taskDomain.MAX_PORTABLE_DETAIL_RUNS + 1);
    if (values.length > taskDomain.MAX_PORTABLE_DETAIL_RUNS) {
      truncatedCollections.push("runs");
    }
    return values.slice(0, taskDomain.MAX_PORTABLE_DETAIL_RUNS).map((value) => {
      const run = runRowSchema.parse(value);
      const eventValues: unknown[] = this.#database.query(`
        SELECT event_id, sequence, event_kind, display_text, observed_at
        FROM local_run_public_events
        WHERE workspace_id = ?1 AND run_id = ?2
        ORDER BY sequence
      `).all(workspaceId, run.run_id);
      const events = eventValues.map((eventValue) => {
        const event = runEventRowSchema.parse(eventValue);
        return event.display_text === null
          ? {
              id: event.event_id,
              sequence: event.sequence,
              kind: event.event_kind,
              observedAt: event.observed_at,
            }
          : {
              id: event.event_id,
              sequence: event.sequence,
              kind: event.event_kind,
              displayText: event.display_text,
              observedAt: event.observed_at,
            };
      });
      const interactionValues: unknown[] = this.#database.query(`
        SELECT interaction_id, run_id, request_json, state, response_revision,
          responded_at, resolved_at
        FROM local_run_interactions
        WHERE workspace_id = ?1 AND run_id = ?2
        ORDER BY created_at, interaction_id
        LIMIT ?3
      `).all(
        workspaceId,
        run.run_id,
        taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT + 1,
      );
      if (interactionValues.length > taskDomain.MAX_TASK_HUMAN_INPUT_PENDING_COUNT) {
        throw new Error("Run interaction projection exceeds its bound");
      }
      const interactions = interactionValues.map((interactionValue) => {
        const interaction = interactionRowSchema.parse(interactionValue);
        return {
          runId: run.run_id,
          request: taskDomain.portableRunInteractionRequestSchema.parse(
            parseJson(interaction.request_json),
          ),
          state: interaction.state,
          ...(interaction.response_revision === null
            ? {}
            : { responseRevision: interaction.response_revision }),
          ...(interaction.responded_at === null
            ? {}
            : { respondedAt: interaction.responded_at }),
          ...(interaction.resolved_at === null
            ? {}
            : { resolvedAt: interaction.resolved_at }),
        };
      });
      return taskDomain.portableRunProjectionSchema.parse({
        id: run.run_id,
        taskKey: task.task_key,
        phase: run.phase,
        repositoryId: run.repository_id,
        desiredState: run.desired_state,
        updatedAt: run.updated_at,
        events,
        interactions,
      });
    });
  }

  #submission(
    workspaceId: string,
    task: z.infer<typeof taskRowSchema>,
  ): unknown {
    const value: unknown = this.#database.query(`
      SELECT local_task_submissions.submission_id,
        local_task_submissions.submitted_by_json,
        local_task_submissions.review_revision,
        local_task_submissions.summary,
        local_task_submissions.evidence_json,
        local_task_submissions.status,
        local_task_submissions.submitted_at,
        local_task_submissions.reviewed_at,
        local_task_reviews.reason
      FROM local_task_submissions
      LEFT JOIN local_task_reviews
        ON local_task_reviews.workspace_id = local_task_submissions.workspace_id
        AND local_task_reviews.submission_id = local_task_submissions.submission_id
      WHERE local_task_submissions.workspace_id = ?1
        AND local_task_submissions.task_id = ?2
      ORDER BY local_task_submissions.submitted_at DESC,
        local_task_submissions.submission_id DESC
      LIMIT 1
    `).get(workspaceId, task.task_id);
    const row = z.object({
      submission_id: taskDomain.taskSubmissionIdSchema,
      submitted_by_json: z.string(),
      review_revision: taskDomain.revisionSchema,
      summary: taskDomain.submissionSummarySchema,
      evidence_json: z.string(),
      status: z.enum(["pending", "accepted", "rejected", "cancelled"]),
      submitted_at: taskDomain.epochMsSchema,
      reviewed_at: taskDomain.epochMsSchema.nullable(),
      reason: z.string().nullable(),
    }).strict().nullable().parse(value);
    if (row === null) return null;
    return taskDomain.taskWorkspaceSubmissionSchema.parse({
      id: row.submission_id,
      submittedBy: taskDomain.projectionActorSchema.parse(
        parseJson(row.submitted_by_json),
      ),
      reviewRevision: row.review_revision,
      summary: row.summary,
      evidence: z.array(taskDomain.submissionEvidenceInputSchema)
        .max(taskDomain.MAX_SUBMISSION_EVIDENCE)
        .parse(parseJson(row.evidence_json)),
      status: row.status,
      submittedAt: row.submitted_at,
      taskKey: task.task_key,
      ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
      ...(row.reason === null ? {} : { reviewReason: row.reason }),
    });
  }

  #recoveries(
    workspaceId: string,
    task: z.infer<typeof taskRowSchema>,
    submission: unknown,
  ): readonly Readonly<{ kind: string }>[] {
    const kinds = new Set<string>();
    if (task.status === "cancelled") kinds.add("task_cancelled");
    if (task.cancelled_blocker_count > 0) kinds.add("cancelled_blocker");
    const parsedSubmission = taskDomain.taskWorkspaceSubmissionSchema.nullable().parse(submission);
    if (parsedSubmission?.status === "rejected") kinds.add("submission_rejected");
    const expiredValue: unknown = this.#database.query(`
      SELECT count(*) AS count FROM local_task_claims
      WHERE workspace_id = ?1 AND task_id = ?2 AND state = 'expired'
    `).get(workspaceId, task.task_id);
    const expired = z.object({ count: z.number().int().nonnegative() }).strict().parse(
      expiredValue,
    );
    if (expired.count > 0) kinds.add("claim_expired");
    return [...kinds].sort().map((kind) => ({ kind }));
  }

  #receipt(operationId: string): z.infer<typeof receiptRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT command_digest, receipt_json
      FROM local_operation_receipts WHERE operation_id = ?1
    `).get(operationId);
    return receiptRowSchema.nullable().parse(value);
  }

  #rendererMutationAttemptRow(
    attemptId: string,
  ): z.infer<typeof rendererMutationAttemptRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT
        attempt_id, workspace_id, command_kind, keyed_fingerprint,
        keyed_command_digest, state, revision, prepared_at,
        effect_started_at, settled_at, terminal_outcome
      FROM local_renderer_mutation_attempts
      WHERE attempt_id = ?1
    `).get(attemptId);
    return rendererMutationAttemptRowSchema.nullable().parse(value);
  }

  #rendererMutationQuarantineRow(
    attemptId: string,
  ): z.infer<typeof rendererMutationQuarantineRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT
        attempt_id, workspace_id, command_kind, source_revision,
        prepared_at, effect_started_at, quarantined_at, receipt_outcome,
        reason
      FROM local_renderer_mutation_quarantines
      WHERE attempt_id = ?1
    `).get(attemptId);
    return rendererMutationQuarantineRowSchema.nullable().parse(value);
  }

  #inspectSerializedRendererMutationAttempt(
    input: z.infer<typeof rendererMutationAttemptTransitionSchema>,
    now: number,
  ): LocalRendererMutationInspection {
    this.#workspace(input.workspaceId);
    const row = this.#rendererMutationAttemptRow(input.attemptId);
    if (row === null) {
      const quarantined = this.#rendererMutationQuarantineRow(input.attemptId);
      if (quarantined === null) {
        throw new LocalTaskStoreError(
          "not_found",
          "Renderer mutation attempt does not exist",
        );
      }
      if (quarantined.workspace_id !== input.workspaceId) {
        throw new LocalMutationAttemptConflict();
      }
      if (
        input.expectedRevision !== quarantined.source_revision &&
        input.expectedRevision !== quarantined.source_revision + 1
      ) {
        throw new LocalTaskStoreError(
          "revision_conflict",
          "Renderer mutation quarantine revision changed",
        );
      }
      return this.#quarantinedRendererMutationReconciliation(quarantined);
    }
    if (row.workspace_id !== input.workspaceId) {
      throw new LocalMutationAttemptConflict();
    }
    if (row.revision !== input.expectedRevision) {
      throw new LocalTaskStoreError(
        "revision_conflict",
        "Renderer mutation attempt revision changed",
      );
    }
    const attempt = rendererMutationAttempt(row);
    if (attempt.state === "settled") {
      return this.#settledRendererMutationReconciliation(attempt);
    }
    const receiptRow = this.#receipt(input.attemptId);
    if (attempt.state === "prepared" && receiptRow !== null) {
      throw new LocalMutationAttemptConflict(
        "A prepared mutation attempt unexpectedly has an operation receipt",
      );
    }
    const receipt = receiptRow === null
      ? null
      : operationReceiptSchema.parse(parseJson(receiptRow.receipt_json));
    if (
      receiptRow !== null &&
      receipt !== null &&
      receipt.commandDigest !== receiptRow.command_digest
    ) {
      throw new LocalMutationAttemptConflict(
        "Mutation receipt digest metadata does not match its payload",
      );
    }
    if (
      receiptRow !== null &&
      row.keyed_command_digest !== null &&
      receiptRow.command_digest !== row.keyed_command_digest
    ) {
      throw new LocalMutationAttemptConflict(
        "Mutation attempt command binding does not match its operation receipt",
      );
    }
    if (
      receipt !== null &&
      (
        receipt.operationId !== attempt.attemptId ||
        receipt.workspaceId !== attempt.workspaceId ||
        receipt.commandKind !== attempt.commandKind
      )
    ) {
      throw new LocalMutationAttemptConflict(
        "Mutation attempt does not match its operation receipt",
      );
    }
    if (
      attempt.state === "effect_started" &&
      row.keyed_command_digest === null &&
      receipt !== null
    ) {
      return this.#quarantineLegacyRendererMutationAttempt(row, receipt, now);
    }
    if (receipt === null) {
      return {
        attempt,
        receipt: null,
        resolution: { outcome: "not_applied" },
      };
    }
    if (receipt.outcome === "rejected") {
      return {
        attempt,
        receipt,
        resolution: {
          outcome: "rejected",
          code: receipt.code,
        },
      };
    }
    return {
      attempt,
      receipt,
      resolution: {
        outcome: "committed",
        mutation: mutationForCommittedReceipt(receipt),
      },
    };
  }

  #quarantineLegacyRendererMutationAttempt(
    row: z.infer<typeof rendererMutationAttemptRowSchema>,
    receipt: OperationReceipt,
    now: number,
  ): LocalRendererMutationReconciliation {
    if (
      row.state !== "effect_started" ||
      row.effect_started_at === null ||
      row.keyed_command_digest !== null
    ) {
      throw new LocalMutationAttemptConflict(
        "Only a legacy unbound started attempt can be quarantined",
      );
    }
    const quarantinedAt = Math.max(now, row.effect_started_at);
    this.#database.query(`
      INSERT INTO local_renderer_mutation_quarantines (
        attempt_id, workspace_id, command_kind, source_revision,
        prepared_at, effect_started_at, quarantined_at, receipt_outcome,
        reason
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'legacy_unbound_receipt'
      )
    `).run(
      row.attempt_id,
      row.workspace_id,
      row.command_kind,
      row.revision,
      row.prepared_at,
      row.effect_started_at,
      quarantinedAt,
      receipt.outcome,
    );
    const removed = this.#database.query(`
      DELETE FROM local_renderer_mutation_attempts
      WHERE attempt_id = ?1
        AND workspace_id = ?2
        AND revision = ?3
        AND state = 'effect_started'
        AND keyed_command_digest IS NULL
    `).run(row.attempt_id, row.workspace_id, row.revision);
    if (removed.changes !== 1) {
      throw new LocalTaskStoreError(
        "revision_conflict",
        "Legacy renderer mutation attempt changed during quarantine",
      );
    }
    const quarantined = this.#rendererMutationQuarantineRow(row.attempt_id);
    if (quarantined === null) {
      throw new Error("Renderer mutation quarantine was not persisted");
    }
    return this.#quarantinedRendererMutationReconciliation(quarantined);
  }

  #quarantinedRendererMutationReconciliation(
    row: z.infer<typeof rendererMutationQuarantineRowSchema>,
  ): LocalRendererMutationReconciliation {
    const quarantine = rendererMutationQuarantine(row);
    const receiptRow = this.#receipt(quarantine.attemptId);
    if (receiptRow === null) {
      throw new LocalMutationAttemptConflict(
        "A quarantined mutation attempt lost its operation receipt",
      );
    }
    const receipt = operationReceiptSchema.parse(
      parseJson(receiptRow.receipt_json),
    );
    if (
      receipt.commandDigest !== receiptRow.command_digest ||
      receipt.outcome !== row.receipt_outcome ||
      receipt.operationId !== quarantine.attemptId ||
      receipt.workspaceId !== quarantine.workspaceId ||
      receipt.commandKind !== quarantine.commandKind
    ) {
      throw new LocalMutationAttemptConflict(
        "A quarantined mutation attempt does not match its receipt",
      );
    }
    return {
      attempt: quarantine,
      receipt,
      resolution: {
        outcome: "ambiguous",
        reason: quarantine.reason,
      },
    };
  }

  #settledRendererMutationReconciliation(
    attempt: Extract<LocalRendererMutationAttempt, { state: "settled" }>,
  ): LocalRendererMutationReconciliation {
    const receiptRow = this.#receipt(attempt.attemptId);
    const receipt = receiptRow === null
      ? null
      : operationReceiptSchema.parse(parseJson(receiptRow.receipt_json));
    if (
      receiptRow !== null &&
      receipt !== null &&
      receipt.commandDigest !== receiptRow.command_digest
    ) {
      throw new LocalMutationAttemptConflict(
        "Settled mutation receipt digest metadata does not match its payload",
      );
    }
    if (attempt.terminalOutcome === "not_applied") {
      if (receipt !== null) {
        throw new LocalMutationAttemptConflict(
          "A not-applied mutation attempt unexpectedly has a receipt",
        );
      }
      return {
        attempt,
        receipt: null,
        resolution: { outcome: "not_applied" },
      };
    }
    if (
      receipt === null ||
      receipt.outcome !== attempt.terminalOutcome ||
      receipt.operationId !== attempt.attemptId ||
      receipt.workspaceId !== attempt.workspaceId ||
      receipt.commandKind !== attempt.commandKind
    ) {
      throw new LocalMutationAttemptConflict(
        "Settled mutation attempt does not match its receipt",
      );
    }
    if (receipt.outcome === "rejected") {
      return {
        attempt,
        receipt,
        resolution: {
          outcome: "rejected",
          code: receipt.code,
        },
      };
    }
    return {
      attempt,
      receipt,
      resolution: {
        outcome: "committed",
        mutation: mutationForCommittedReceipt(receipt),
      },
    };
  }

  #compactSettledRendererMutationAttempts(workspaceId: string): void {
    this.#database.query(`
      DELETE FROM local_renderer_mutation_attempts
      WHERE attempt_id IN (
        SELECT attempt_id
        FROM local_renderer_mutation_attempts
        WHERE workspace_id = ?1 AND state = 'settled'
        ORDER BY settled_at DESC, attempt_id DESC
        LIMIT -1 OFFSET 64
      )
    `).run(workspaceId);
  }

  #insertReceipt(receipt: OperationReceipt): void {
    this.#database.query(`
      INSERT INTO local_operation_receipts (
        operation_id, workspace_id, command_kind, command_digest,
        receipt_json, recorded_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(
      receipt.operationId,
      receipt.workspaceId,
      receipt.commandKind,
      receipt.commandDigest,
      JSON.stringify(receipt),
      receipt.recordedAt,
    );
  }

  #event(input: Readonly<{
    workspace: z.infer<typeof workspaceRowSchema>;
    workspaceRevision: number;
    sequence: number;
    operationId: string;
    commandKind: LocalWorkspaceCommand["kind"];
    actor: PortableActor;
    draft: EventDraft;
    now: number;
  }>): PortableWorkspaceEvent {
    return portableWorkspaceEventSchema.parse({
      id: deterministicPublicId(
        "wevt",
        `${input.operationId}:${String(input.sequence)}`,
      ),
      workspaceId: input.workspace.workspace_id,
      sequence: input.sequence,
      workspaceRevision: input.workspaceRevision,
      operationId: input.operationId,
      commandKind: input.commandKind,
      actor: input.actor,
      recordedAt: input.now,
      ...input.draft,
    });
  }

  #insertEvent(event: PortableWorkspaceEvent): void {
    this.#database.query(`
      INSERT INTO local_workspace_events (
        workspace_id, sequence, event_id, workspace_revision, operation_id,
        event_kind, task_id, event_json, recorded_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).run(
      event.workspaceId,
      event.sequence,
      event.id,
      event.workspaceRevision,
      event.operationId,
      event.kind,
      "taskId" in event ? event.taskId : null,
      JSON.stringify(event),
      event.recordedAt,
    );
  }

  #assertAuthority(
    workspace: z.infer<typeof workspaceRowSchema>,
    command: LocalWorkspaceCommand,
  ): void {
    if (workspace.authority_kind !== "local") {
      throw new LocalTaskStoreError(
        "authority_mismatch",
        "Workspace is not locally writable",
      );
    }
    if ("authority" in command) {
      if (
        command.authority.workspaceId !== workspace.workspace_id ||
        command.authority.installationId !== workspace.owner_installation_id
      ) {
        throw new LocalTaskStoreError(
          "authority_mismatch",
          "Local owner authority does not match the workspace",
        );
      }
    } else if (command.workspaceId !== workspace.workspace_id) {
      throw new LocalTaskStoreError(
        "authority_mismatch",
        "System command workspace does not match",
      );
    }
  }

  #requireWorkspaceRevision(
    workspace: z.infer<typeof workspaceRowSchema>,
    expected: number,
  ): void {
    if (workspace.revision !== expected) {
      throw new LocalTaskStoreError("revision_conflict", "Workspace revision changed");
    }
  }

  #requireMutable(task: z.infer<typeof taskRowSchema>): void {
    if (task.status === "done" || task.status === "cancelled") {
      throw new LocalTaskStoreError("terminal", "Task is terminal");
    }
  }

  #touchTask(
    workspaceId: string,
    taskId: string,
    now: number,
    changesReviewInput: boolean,
  ): void {
    this.#database.query(`
      UPDATE local_tasks
      SET revision = revision + 1,
        review_revision = review_revision + ?3,
        updated_at = ?4
      WHERE workspace_id = ?1 AND task_id = ?2
    `).run(workspaceId, taskId, changesReviewInput ? 1 : 0, now);
  }

  #taskUpdated(
    _command: Extract<LocalWorkspaceCommand, { taskId: string }>,
    task: z.infer<typeof taskRowSchema>,
    eventType: taskDomain.TaskEventType,
  ): AppliedCommand {
    return {
      result: {
        kind: "task_updated",
        taskId: task.task_id,
        taskRevision: task.revision + 1,
      },
      events: [{
        kind: "task.changed",
        taskId: task.task_id,
        taskRevision: task.revision + 1,
        eventType,
      }],
    };
  }

  #recalculateBlockerCounters(workspaceId: string): void {
    this.#database.query(`
      UPDATE local_tasks
      SET unresolved_blocker_count = (
        SELECT count(*)
        FROM local_task_dependencies
        JOIN local_tasks AS blocker
          ON blocker.workspace_id = local_task_dependencies.workspace_id
          AND blocker.task_id = local_task_dependencies.blocker_task_id
        WHERE local_task_dependencies.workspace_id = local_tasks.workspace_id
          AND local_task_dependencies.blocked_task_id = local_tasks.task_id
          AND blocker.status NOT IN ('done', 'cancelled')
      ),
      cancelled_blocker_count = (
        SELECT count(*)
        FROM local_task_dependencies
        JOIN local_tasks AS blocker
          ON blocker.workspace_id = local_task_dependencies.workspace_id
          AND blocker.task_id = local_task_dependencies.blocker_task_id
        WHERE local_task_dependencies.workspace_id = local_tasks.workspace_id
          AND local_task_dependencies.blocked_task_id = local_tasks.task_id
          AND blocker.status = 'cancelled'
      )
      WHERE workspace_id = ?1
    `).run(workspaceId);
  }

  #requireWorkspaceRepository(workspaceId: string, repositoryId: string): void {
    const value: unknown = this.#database.query(`
      SELECT repository_id FROM local_workspace_repositories
      WHERE workspace_id = ?1 AND repository_id = ?2
    `).get(workspaceId, repositoryId);
    if (value === null) {
      throw new LocalTaskStoreError(
        "not_found",
        "Repository is not bound to this workspace",
      );
    }
  }

  #requireWorkspaceCapacity(): void {
    const value: unknown = this.#database.query(`
      SELECT count(*) AS count FROM local_workspaces WHERE tombstoned_at IS NULL
    `).get();
    const count = z.object({ count: z.number().int().nonnegative() })
      .strict().parse(value).count;
    if (count >= MAX_LOCAL_WORKSPACE_SUMMARIES) {
      throw new LocalTaskStoreError(
        "capacity_full",
        "Local workspace limit reached",
      );
    }
  }

  #blockingRunCount(workspaceId: string, taskId: string, exceptRunId: string): number {
    const value: unknown = this.#database.query(`
      SELECT count(*) AS count FROM local_task_runs
      WHERE workspace_id = ?1 AND task_id = ?2 AND run_id <> ?3
        AND phase IN (
          'queued', 'leased', 'provisioning', 'starting', 'running',
          'waiting', 'cancel_requested', 'ambiguous'
        )
    `).get(workspaceId, taskId, exceptRunId);
    return z.object({ count: z.number().int().nonnegative() }).strict().parse(value).count;
  }

  #upsertDueWork(input: Readonly<{
    workspaceId: string;
    kind: "defer_wake" | "queued_run" | "claim_expiry" | "run_recovery"
      | "interaction_expiry" | "repair";
    entityId: string;
    dueAt: number;
    expectedRevision?: number | undefined;
    expectedFence?: number | undefined;
    now: number;
  }>): void {
    this.#database.query(`
      INSERT INTO local_due_work (
        due_work_id, workspace_id, work_kind, entity_id, due_at, not_before_at,
        expected_revision, expected_fence, state, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, 'pending', ?8, ?8)
      ON CONFLICT(workspace_id, work_kind, entity_id) DO UPDATE SET
        due_at = excluded.due_at,
        not_before_at = excluded.not_before_at,
        expected_revision = excluded.expected_revision,
        expected_fence = excluded.expected_fence,
        state = 'pending',
        claimed_boot_generation = NULL,
        claimed_at = NULL,
        attempt_count = 0,
        last_error_code = NULL,
        work_generation = work_generation + 1,
        updated_at = excluded.updated_at
    `).run(
      deterministicOpaqueId(
        "due",
        `${input.workspaceId}:${input.kind}:${input.entityId}`,
      ),
      input.workspaceId,
      input.kind,
      input.entityId,
      input.dueAt,
      input.expectedRevision ?? null,
      input.expectedFence ?? null,
      input.now,
    );
  }

  #completeDueWork(
    workspaceId: string,
    kind: string,
    entityId: string,
    now: number,
  ): void {
    this.#database.query(`
      UPDATE local_due_work
      SET state = 'done', claimed_boot_generation = NULL, claimed_at = NULL,
        updated_at = ?4
      WHERE workspace_id = ?1 AND work_kind = ?2 AND entity_id = ?3
    `).run(workspaceId, kind, entityId, now);
  }

  #hasQueuedRun(workspaceId: string, taskId: string): boolean {
    const value: unknown = this.#database.query(`
      SELECT 1 AS present
      FROM local_task_runs
      JOIN local_queued_run_intents
        ON local_queued_run_intents.workspace_id = local_task_runs.workspace_id
        AND local_queued_run_intents.run_id = local_task_runs.run_id
      WHERE local_task_runs.workspace_id = ?1
        AND local_task_runs.task_id = ?2
        AND local_task_runs.phase = 'queued'
        AND local_queued_run_intents.state = 'queued'
      LIMIT 1
    `).get(workspaceId, taskId);
    return z.object({ present: z.literal(1) }).strict().nullable().parse(value) !==
      null;
  }

  #queuedRunReadinessTargets(
    workspaceId: string,
    changedTaskId: string,
  ): readonly string[] {
    const values: unknown[] = this.#database.query(`
      SELECT blocked_task_id
      FROM local_task_dependencies
      WHERE workspace_id = ?1 AND blocker_task_id = ?2
      ORDER BY blocked_task_id
    `).all(workspaceId, changedTaskId);
    return [
      changedTaskId,
      ...values.map((value) =>
        z.object({
          blocked_task_id: taskDomain.taskPublicIdSchema,
        }).strict().parse(value).blocked_task_id),
    ];
  }

  #synchronizeQueuedRuns(
    workspaceId: string,
    taskId: string,
    now: number,
  ): void {
    const values: unknown[] = this.#database.query(`
      SELECT local_queued_run_intents.run_id,
        max(local_tasks.available_at, ?3) AS available_at,
        local_tasks.status, local_tasks.revision,
        local_tasks.unresolved_blocker_count,
        local_tasks.cancelled_blocker_count
      FROM local_queued_run_intents
      JOIN local_task_runs
        ON local_task_runs.workspace_id = local_queued_run_intents.workspace_id
        AND local_task_runs.run_id = local_queued_run_intents.run_id
      JOIN local_tasks
        ON local_tasks.workspace_id = local_queued_run_intents.workspace_id
        AND local_tasks.task_id = local_queued_run_intents.task_id
      WHERE local_queued_run_intents.workspace_id = ?1
        AND local_queued_run_intents.task_id = ?2
        AND local_queued_run_intents.state = 'queued'
        AND local_task_runs.phase = 'queued'
    `).all(workspaceId, taskId, now);
    const rows = values.map((value) =>
      z.object({
        run_id: taskDomain.dispatchIdSchema,
        available_at: taskDomain.epochMsSchema,
        status: taskDomain.taskStatusSchema,
        revision: taskDomain.revisionSchema,
        unresolved_blocker_count: z.number().int().nonnegative().safe(),
        cancelled_blocker_count: z.number().int().nonnegative().safe(),
      }).strict().parse(value));
    for (const row of rows) {
      this.#database.query(`
        UPDATE local_queued_run_intents
        SET available_at = ?3, updated_at = ?4
        WHERE workspace_id = ?1 AND run_id = ?2 AND state = 'queued'
      `).run(workspaceId, row.run_id, row.available_at, now);
      if (
        row.status !== "open" ||
        row.unresolved_blocker_count + row.cancelled_blocker_count !== 0
      ) {
        this.#database.query(`
          UPDATE local_due_work
          SET state = 'cancelled', claimed_boot_generation = NULL,
            claimed_at = NULL, attempt_count = 0,
            last_error_code = 'task_not_ready',
            work_generation = work_generation + 1, updated_at = ?3
          WHERE workspace_id = ?1 AND work_kind = 'queued_run'
            AND entity_id = ?2 AND state IN ('pending', 'claimed')
        `).run(workspaceId, row.run_id, now);
        continue;
      }
      this.#upsertDueWork({
        workspaceId,
        kind: "queued_run",
        entityId: row.run_id,
        dueAt: row.available_at,
        expectedRevision: row.revision,
        now,
      });
    }
  }
}
