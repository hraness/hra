import {
  acceptTaskRequestSchema,
  addTaskCommentRequestSchema,
  addTaskCommentResponseSchema,
  addTaskReferenceRequestSchema,
  assignTaskRequestSchema,
  cancelTaskRequestSchema,
  clearTaskParentRequestSchema,
  createTaskRequestSchema,
  deferTaskRequestSchema,
  MAX_TASK_LABELS,
  rejectTaskRequestSchema,
  reopenTaskRequestSchema,
  removeTaskReferenceRequestSchema,
  setTaskParentRequestSchema,
  taskDependencyMutationRequestSchema,
  taskKeySchema,
  taskLabelMutationRequestSchema,
  taskReferenceIdSchema,
  uuidV7Schema,
  workspaceIdSchema,
  type OrganizationRole,
  type WorkspaceRole,
} from "@hraness/agent-tasks-protocol";
import {
  epochMsSchema,
  repositoryIdSchema,
  taskDescriptionSchema,
  taskPrioritySchema,
  taskPublicIdSchema,
  taskTitleSchema,
  taskTypeSchema,
  type TaskWorkspaceClientMutationIntentKind,
  type TaskWorkspaceMutationSemanticInput,
} from "@hraness/agent-tasks-domain";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import {
  assertRequestMetadata,
  domainFailure,
  randomCrockford,
  randomPublicId,
  randomRequestId,
  parseTaskData,
  taskView,
  type DomainError,
} from "./domain";
import { loadTaskDispatchGuard } from "./dispatchSafety";
import { appendTaskEvent } from "./events";
import { humanAdminRequestFingerprint } from "./humanAdminFingerprint";
import {
  authorizeWorkspaceHuman,
  type AuthorizedWorkspaceHuman,
} from "./humanAuthorization";
import { lookupHumanReceipt, storeHumanReceipt } from "./humanTenancy";
import {
  linkHostedMutationReceipt,
  resolveHostedMutationReceiptBinding,
  type HostedMutationReceiptBinding,
} from "./hostedMutationAttempts";
import { hostedMutationClientFingerprint } from "./hostedMutationFingerprint";
import {
  MAX_DEFER_MS,
  taskTypeValidator,
} from "./model";
import { workspaceProjectionHead } from "./hraProjection";
import { consumeAuthorizedHumanRateLimit } from "./rateLimits";
import {
  activeClaimMatchesTask,
  activeWorkspaceUsage,
  blockerRows,
  commentResultValidator,
  dependencyResultValidator,
  dependencyView,
  ensureCounterProjection,
  ensureWorkspaceLabel,
  humanActor,
  humanReceiptIdentity,
  pendingSubmissionBase,
  pendingSubmissionsForTask,
  parseDependencyData,
  parseReferenceData,
  parseRemovedReferenceData,
  parseReviewData,
  parseTaskMutationData,
  persistedReferenceValue,
  propagateBlockerTransition,
  queueTaskClaimRepair,
  queueTaskProjectionRepair,
  queueTaskReviewRepair,
  referenceHasSafeUrls,
  referenceRemoveResultValidator,
  referenceResultValidator,
  referenceView,
  reviewResultValidator,
  reviewSubmissionTransition,
  submissionHasTaskOwnership,
  taskByKey,
  taskDetail,
  taskDetailResultValidator,
  taskResultValidator,
  validateDependencyCycleDb,
  validateParentChain,
  type PersistedActor,
  type TaskDoc,
  type TaskDetailData,
} from "./workGraph";
import {
  blockerContribution,
  derivedNeedsAttention,
  derivedReady,
  MAX_BLOCKING_DEPENDENTS,
  MAX_DIRECT_BLOCKERS,
  WORKSPACE_ACTIVE_TASK_LIMIT,
  WORKSPACE_TOTAL_TASK_LIMIT,
} from "./workGraphLaws";

type Capability = "planner" | "reviewer" | "comment" | "dispatch";
type Success<Data> = { readonly ok: true; readonly data: Data };
type Transition<Data> = Success<Data> | { readonly ok: false; readonly error: DomainError };

// This namespace is included in durable idempotency receipt digests. Preserve
// its historical bytes so retries issued before the rename replay exactly.
const LEGACY_STABLE_HUMAN_MUTATION_DIGEST_NAMESPACE = "kitchen";

export type HumanCommandContext = Readonly<{
  authorization: AuthorizedWorkspaceHuman;
  actor: PersistedActor;
  idempotencyKey: string;
  now: number;
  requestId: string;
}>;

export function humanTaskMutationRoleAllowed(
  organizationRole: OrganizationRole,
  workspaceRoles: readonly WorkspaceRole[],
  capability: Capability,
): boolean {
  if (organizationRole === "owner" || organizationRole === "admin") return true;
  if (capability === "dispatch") return workspaceRoles.includes("planner");
  if (capability === "planner") return workspaceRoles.includes("planner");
  if (capability === "reviewer") return workspaceRoles.includes("reviewer");
  return workspaceRoles.includes("planner") || workspaceRoles.includes("reviewer");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, canonicalize(object[key])]),
    );
  }
  return value;
}

export function humanTaskMutationDigest(operation: string, input: unknown): string {
  return humanAdminRequestFingerprint(JSON.stringify([operation, canonicalize(input)]));
}

function parseWithSchema<Data>(schema: {
  safeParse(value: unknown): { readonly success: boolean; readonly data?: Data };
}) {
  return (value: unknown): Data | null => {
    const parsed = schema.safeParse(value);
    return parsed.success && parsed.data !== undefined ? parsed.data : null;
  };
}

const parseCreatedTask = parseTaskData;
const parseTaskMutation = parseTaskMutationData;
const parseComment = parseWithSchema(addTaskCommentResponseSchema);
const parseReference = parseReferenceData;
const parseRemovedReference = parseRemovedReferenceData;
const parseDependency = parseDependencyData;
const parseReview = parseReviewData;

function hostedTargetTaskId(
  binding: HostedMutationReceiptBinding,
): string {
  if (binding.targetTaskId === undefined) {
    throw new Error("Hosted task mutation attempt has no target task.");
  }
  return binding.targetTaskId;
}

function requiredHostedMutationString(
  value: string | undefined,
  field: string,
): string {
  if (value === undefined) {
    throw new Error(`Hosted mutation is missing ${field}.`);
  }
  return value;
}

export function validPublicScope(input: {
  readonly workspaceId: string;
  readonly key?: string;
  readonly idempotencyKey: string;
}): boolean {
  return (
    workspaceIdSchema.safeParse(input.workspaceId).success &&
    (input.key === undefined || taskKeySchema.safeParse(input.key).success) &&
    uuidV7Schema.safeParse(input.idempotencyKey).success
  );
}

export async function runHumanTaskMutation<Data>(
  ctx: MutationCtx,
  args: {
    readonly workspaceId: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly requestId: string;
    readonly hraOperationId?: string;
    readonly expectedProjectionHead?: number;
  },
  config: {
    readonly capability: Capability;
    readonly hostedAttemptOperation?: TaskWorkspaceClientMutationIntentKind;
    readonly hostedAttemptIntent?: (
      binding: HostedMutationReceiptBinding,
    ) => TaskWorkspaceMutationSemanticInput;
    readonly hostedAttemptSuppliedTaskId?: string;
    readonly hostedAttemptTargetRunId?: string;
    readonly hostedAttemptTargetTaskKey?: string;
    readonly operation: string;
    readonly parseReceipt: (value: unknown) => Data | null;
    readonly execute: (command: HumanCommandContext) => Promise<Transition<Data>>;
  },
) {
  const now = Date.now();
  const metadata = assertRequestMetadata({ ...args, now });
  const expiredMetadata =
    !metadata.ok && metadata.error.code === "IDEMPOTENCY_EXPIRED";
  if (!metadata.ok && !expiredMetadata) {
    return { ok: false as const, error: metadata.error };
  }
  const authorized = await authorizeWorkspaceHuman(ctx, {
    workspacePublicId: args.workspaceId,
    requestId: args.requestId,
  });
  if (!authorized.ok) return { ok: false as const, error: authorized.error };
  let requestDigest = args.requestDigest;
  let hostedAttemptBound = false;
  let hostedBinding: HostedMutationReceiptBinding | null = null;
  const hostedAttemptIntent = config.hostedAttemptIntent;
  if (
    args.hraOperationId !== undefined &&
    (
      (config.hostedAttemptOperation === undefined) !==
        (hostedAttemptIntent === undefined)
    )
  ) {
    return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
  }
  if (
    args.hraOperationId !== undefined &&
    config.hostedAttemptOperation !== undefined &&
    hostedAttemptIntent !== undefined
  ) {
    const binding = await resolveHostedMutationReceiptBinding(ctx, {
      idempotencyKey: args.idempotencyKey,
      operation: config.hostedAttemptOperation,
      hraOperationId: args.hraOperationId,
      organizationId: authorized.authorization.organization._id,
      principalId: authorized.authorization.user._id,
      ...(config.hostedAttemptSuppliedTaskId === undefined
        ? {}
        : { suppliedTaskId: config.hostedAttemptSuppliedTaskId }),
      ...(config.hostedAttemptTargetRunId === undefined
        ? {}
        : { targetRunId: config.hostedAttemptTargetRunId }),
      ...(config.hostedAttemptTargetTaskKey === undefined
        ? {}
        : { targetTaskKey: config.hostedAttemptTargetTaskKey }),
      workspaceId: authorized.authorization.workspace._id,
      workspacePublicId: authorized.authorization.workspace.publicId,
    }, async (candidate) =>
      await hostedMutationClientFingerprint(hostedAttemptIntent(candidate)));
    if (binding === null) {
      return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
    }
    hostedAttemptBound = true;
    hostedBinding = binding;
    requestDigest = humanTaskMutationDigest(
      `${LEGACY_STABLE_HUMAN_MUTATION_DIGEST_NAMESPACE}:hosted-attempt:v1`,
      {
        backendOperation: config.operation,
        fingerprint: binding.fingerprint,
        fingerprintKeyVersion: binding.fingerprintKeyVersion,
        operation: binding.operation,
        operationId: binding.hraOperationId,
        sourceId: binding.sourceId,
      },
    );
  } else if (args.hraOperationId !== undefined) {
    requestDigest = humanTaskMutationDigest(
      `${LEGACY_STABLE_HUMAN_MUTATION_DIGEST_NAMESPACE}:${config.operation}`,
      {
        operationId: args.hraOperationId,
        expectedProjectionHead: args.expectedProjectionHead,
        requestDigest: args.requestDigest,
      },
    );
  }
  if (expiredMetadata && !hostedAttemptBound) {
    return { ok: false as const, error: metadata.error };
  }
  const identity = humanReceiptIdentity(authorized.authorization);
  const receipt = await lookupHumanReceipt(ctx, {
    identity,
    operation: config.operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest,
    requestId: args.requestId,
    parse: config.parseReceipt,
  });
  if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
  if (receipt.kind === "replay") {
    if (
      hostedBinding !== null &&
      !await linkHostedMutationReceipt(ctx, hostedBinding, receipt.receiptId)
    ) {
      return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
    }
    return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
  }
  if (expiredMetadata) {
    return { ok: false as const, error: metadata.error };
  }
  if (
    !humanTaskMutationRoleAllowed(
      authorized.authorization.role,
      authorized.authorization.workspaceMembership?.roles ?? [],
      config.capability,
    )
  ) {
    return domainFailure("WORKSPACE_ROLE_REQUIRED", args.requestId);
  }
  const rateLimit = await consumeAuthorizedHumanRateLimit(ctx, {
    userId: authorized.authorization.user._id,
    workspaceId: authorized.authorization.workspace._id,
    routeClass: "human_mutation",
    requestId: args.requestId,
  });
  if (rateLimit.kind === "limited") {
    return domainFailure("RATE_LIMITED", args.requestId, {
      retryAfterMs: rateLimit.retryAfterMs,
    });
  }
  if (rateLimit.kind !== "allowed") {
    return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
  }
  if (
    args.expectedProjectionHead !== undefined &&
    await workspaceProjectionHead(
      ctx,
      authorized.authorization.workspace._id,
    ) !== args.expectedProjectionHead
  ) {
    return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
      currentRevision: await workspaceProjectionHead(
        ctx,
        authorized.authorization.workspace._id,
      ),
    });
  }
  const transitioned = await config.execute({
    authorization: authorized.authorization,
    actor: humanActor(authorized.authorization),
    idempotencyKey: args.idempotencyKey,
    now,
    requestId: args.requestId,
  });
  if (!transitioned.ok) return transitioned;
  const receiptId = await storeHumanReceipt(ctx, {
    identity,
    operation: config.operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest,
    requestId: args.requestId,
    data: transitioned.data,
    now,
  });
  if (
    hostedBinding !== null &&
    !await linkHostedMutationReceipt(ctx, hostedBinding, receiptId)
  ) {
    throw new Error("Hosted mutation receipt lost its authoritative attempt.");
  }
  return { ok: true as const, data: transitioned.data, requestId: args.requestId };
}

async function loadHumanMutableTask(
  ctx: MutationCtx,
  args: {
    readonly workspaceId: Id<"workspaces">;
    readonly key: string;
    readonly revision: number;
    readonly now: number;
    readonly requestId: string;
  },
): Promise<Success<TaskDoc> | { readonly ok: false; readonly error: DomainError }> {
  const task = await taskByKey(ctx, args.workspaceId, args.key);
  if (task === null) return domainFailure("NOT_FOUND", args.requestId);
  if (task.revision !== args.revision) {
    return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  if (task.status === "in_review") {
    return domainFailure("TASK_IN_REVIEW", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  const dispatchGuard = await loadTaskDispatchGuard(ctx, task);
  if (dispatchGuard.kind === "projection_mismatch") {
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  if (dispatchGuard.kind === "blocked") {
    return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  if (task.status === "in_progress" && task.currentClaim === undefined) {
    await queueTaskClaimRepair(ctx, task, args.now);
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  if (task.status !== "in_progress" && task.status !== "open" && task.currentClaim === undefined) {
    return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  const detail = await requireHumanTaskDetail(ctx, task, args.requestId);
  if (!detail.ok) return detail;
  if (task.status === "in_progress" || task.currentClaim !== undefined) {
    const claim = task.currentClaim === undefined ? null : await ctx.db.get(task.currentClaim.claimId);
    if (!activeClaimMatchesTask(task, claim)) {
      await queueTaskClaimRepair(ctx, task, args.now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
  }
  return { ok: true, data: task };
}

async function requireHumanTaskDetail(
  ctx: MutationCtx,
  task: TaskDoc,
  requestId: string,
): Promise<Transition<TaskDetailData>> {
  const detail = await taskDetail(ctx, task);
  return detail === null
    ? domainFailure("PROJECTION_MISMATCH", requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      })
    : { ok: true, data: detail };
}

function clientCommand(command: HumanCommandContext) {
  return {
    kind: "client" as const,
    idempotencyKey: command.idempotencyKey,
    requestId: command.requestId,
  };
}

const referenceInputValidator = v.union(
  v.object({ kind: v.literal("repository"), repositoryId: v.string() }),
  v.object({
    kind: v.literal("pull_request"),
    url: v.string(),
    repositoryId: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("commit"),
    sha: v.string(),
    repositoryId: v.optional(v.string()),
    url: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("artifact"), name: v.string(), url: v.string() }),
  v.object({ kind: v.literal("url"), label: v.string(), url: v.string() }),
);

const baseTaskArgs = {
  workspaceId: v.string(),
  key: v.string(),
  revision: v.number(),
  idempotencyKey: v.string(),
  hraOperationId: v.optional(v.string()),
  expectedProjectionHead: v.optional(v.number()),
} as const;

const hraMutationControlArgs = {
  hraOperationId: v.optional(v.string()),
  expectedProjectionHead: v.optional(v.number()),
} as const;

export type ParsedHumanTaskCreate = Readonly<{
  publicId?: string | undefined;
  title: string;
  description?: string | undefined;
  type: TaskDoc["type"];
  priority: number;
  availableAt?: number | undefined;
  parentKey?: string | undefined;
  labels?: readonly string[] | undefined;
}>;

/** Shared transactional task creation used by ordinary and dispatching humans. */
export async function createHumanTaskRecord(
  ctx: MutationCtx,
  command: HumanCommandContext,
  parsed: ParsedHumanTaskCreate,
): Promise<Transition<{ readonly task: ReturnType<typeof taskView> }>> {
  const availableAt = parsed.availableAt ?? command.now;
  if (availableAt > command.now + MAX_DEFER_MS) {
    return domainFailure("DEFER_HORIZON", command.requestId);
  }
  const scope = {
    organizationId: command.authorization.organization._id,
    workspaceId: command.authorization.workspace._id,
  };
  for (const label of parsed.labels ?? []) {
    const existingLabels = await ctx.db
      .query("workspaceLabels")
      .withIndex("by_workspace_and_name", (query) =>
        query.eq("workspaceId", scope.workspaceId).eq("name", label),
      )
      .take(2);
    if (
      existingLabels.length > 1 ||
      existingLabels.some(
        (existing) =>
          existing.organizationId !== scope.organizationId ||
          existing.workspaceId !== scope.workspaceId ||
          existing.name !== label,
      )
    ) {
      return domainFailure("PROJECTION_MISMATCH", command.requestId);
    }
  }
  const usage = await activeWorkspaceUsage(ctx, scope);
  if (usage === null) return domainFailure("SERVICE_UNAVAILABLE", command.requestId);
  if (
    usage.organizationId !== scope.organizationId ||
    usage.workspaceId !== scope.workspaceId
  ) {
    return domainFailure("INTERNAL_ERROR", command.requestId);
  }
  if (
    usage.activeTasks >= WORKSPACE_ACTIVE_TASK_LIMIT ||
    usage.totalTasks >= WORKSPACE_TOTAL_TASK_LIMIT
  ) {
    return domainFailure("WORKSPACE_TASK_LIMIT", command.requestId);
  }
  let parent: TaskDoc | null = null;
  if (parsed.parentKey !== undefined) {
    parent = await taskByKey(ctx, scope.workspaceId, parsed.parentKey);
    if (
      parent === null ||
      parent.organizationId !== scope.organizationId ||
      parent.workspaceId !== scope.workspaceId
    ) {
      return domainFailure("NOT_FOUND", command.requestId);
    }
    const parentValidation = await validateParentChain(ctx, null, parent);
    if (parentValidation === "limit") {
      return domainFailure("GRAPH_VALIDATION_LIMIT", command.requestId, {
        taskKey: parent.key,
        currentRevision: parent.revision,
        exhaustedLimit: "parent_depth",
      });
    }
    if (parentValidation === "cycle") {
      return domainFailure("HIERARCHY_CYCLE", command.requestId);
    }
  }
  const workspace = command.authorization.workspace;
  let key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
  for (
    let attempt = 0;
    attempt < 5 && (await taskByKey(ctx, scope.workspaceId, key)) !== null;
    attempt += 1
  ) {
    key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
  }
  if ((await taskByKey(ctx, scope.workspaceId, key)) !== null) {
    return domainFailure("SERVICE_UNAVAILABLE", command.requestId);
  }
  const isReady = availableAt <= command.now;
  const publicId = parsed.publicId ?? randomPublicId("tsk");
  if (!taskPublicIdSchema.safeParse(publicId).success) {
    return domainFailure("VALIDATION_ERROR", command.requestId);
  }
  const publicIdCollision = await ctx.db
    .query("tasks")
    .withIndex("by_public_id", (query) => query.eq("publicId", publicId))
    .unique();
  if (publicIdCollision !== null) {
    return domainFailure("TASK_STATE_CONFLICT", command.requestId);
  }
  const taskId = await ctx.db.insert("tasks", {
    ...scope,
    publicId,
    key,
    title: parsed.title,
    type: parsed.type,
    priority: parsed.priority,
    status: "open",
    availableAt,
    isReady,
    isBlocked: false,
    unresolvedBlockerCount: 0,
    cancelledBlockerCount: 0,
    revision: 1,
    reviewRevision: 1,
    createdBy: command.actor,
    lastEditedBy: command.actor,
    ...(parent === null ? {} : { parentTaskId: parent._id }),
    ...(isReady ? { readySince: command.now } : {}),
    needsAttention: false,
    wakeGeneration: availableAt > command.now ? 1 : 0,
    claimFence: 0,
    createdAt: command.now,
    updatedAt: command.now,
  });
  await ctx.db.insert("taskBodies", {
    ...scope,
    taskId,
    description: parsed.description ?? "",
    createdAt: command.now,
    updatedAt: command.now,
  });
  for (const label of parsed.labels ?? []) {
    const workspaceLabel = await ensureWorkspaceLabel(ctx, scope, label, command.now);
    if (workspaceLabel === null || workspaceLabel === undefined) {
      throw new Error("Created task label projection is invalid after a protected write.");
    }
    await ctx.db.insert("taskLabels", {
      ...scope,
      taskId,
      labelId: workspaceLabel._id,
      label,
      createdBy: command.actor,
      createdAt: command.now,
    });
  }
  if (availableAt > command.now) {
    const wakeId = await ctx.db.insert("taskWakes", {
      ...scope,
      taskId,
      generation: 1,
      expectedAvailableAt: availableAt,
      state: "pending",
      createdAt: command.now,
    });
    await ctx.scheduler.runAt(availableAt, internal.schedules.wakeTask, {
      taskId,
      wakeId,
      generation: 1,
      expectedAvailableAt: availableAt,
    });
  }
  await ctx.db.patch(usage._id, {
    activeTasks: usage.activeTasks + 1,
    totalTasks: usage.totalTasks + 1,
    updatedAt: command.now,
  });
  await appendTaskEvent(ctx, {
    ...scope,
    taskId,
    taskPublicId: publicId,
    taskRevision: 1,
    type: "task.created",
    actor: command.actor,
    command: clientCommand(command),
    payload: { availableAt },
    now: command.now,
  });
  const task = await ctx.db.get(taskId);
  if (task === null) throw new Error("Created human task disappeared.");
  return { ok: true, data: { task: taskView(task) } };
}

export const createTask = mutation({
  args: {
    workspaceId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    type: v.optional(taskTypeValidator),
    priority: v.optional(v.number()),
    availableAt: v.optional(v.number()),
    parentKey: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    repositoryId: v.optional(v.string()),
    idempotencyKey: v.string(),
    suppliedTaskId: v.optional(v.string()),
    ...hraMutationControlArgs,
  },
  returns: taskResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !validPublicScope(args) ||
      (
        args.repositoryId !== undefined &&
        !repositoryIdSchema.safeParse(args.repositoryId).success
      )
    ) {
      return domainFailure("VALIDATION_ERROR", requestId);
    }
    const parsed = createTaskRequestSchema.safeParse({
      title: args.title,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.type === undefined ? {} : { type: args.type }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
      ...(args.availableAt === undefined ? {} : { availableAt: args.availableAt }),
      ...(args.parentKey === undefined ? {} : { parentKey: args.parentKey }),
      ...(args.labels === undefined ? {} : { labels: args.labels }),
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
    const operation = "tasks.create";
    const requestDigest = humanTaskMutationDigest(operation, {
      workspaceId: args.workspaceId,
      ...parsed.data,
      ...(args.suppliedTaskId === undefined
        ? {}
        : { suppliedTaskId: args.suppliedTaskId }),
      ...(args.repositoryId === undefined
        ? {}
        : { repositoryId: args.repositoryId }),
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "planner",
        hostedAttemptOperation: "task.create",
        ...(args.suppliedTaskId === undefined
          ? {}
          : { hostedAttemptSuppliedTaskId: args.suppliedTaskId }),
        hostedAttemptIntent: () => ({
          kind: "task.create",
          title: parsed.data.title,
          ...(parsed.data.description === undefined
            ? {}
            : { description: parsed.data.description }),
          type: parsed.data.type,
          priority: parsed.data.priority,
          ...(parsed.data.availableAt === undefined
            ? {}
            : { availableAt: parsed.data.availableAt }),
          labels: parsed.data.labels ?? [],
          ...(parsed.data.parentKey === undefined
            ? {}
            : { parentKey: parsed.data.parentKey }),
          ...(args.repositoryId === undefined
            ? {}
            : { repositoryId: args.repositoryId }),
        }),
        operation,
        parseReceipt: parseCreatedTask,
        execute: async (command) => {
          const repository = args.repositoryId === undefined
            ? null
            : await ctx.db
                .query("workspaceRepositories")
                .withIndex("by_public_id", (query) =>
                  query.eq("publicId", args.repositoryId ?? ""))
                .unique();
          if (
            args.repositoryId !== undefined &&
            (
              repository === null ||
              repository.organizationId !==
                command.authorization.organization._id ||
              repository.workspaceId !==
                command.authorization.workspace._id ||
              repository.status !== "active"
            )
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          const created = await createHumanTaskRecord(ctx, command, {
            ...parsed.data,
            ...(args.suppliedTaskId === undefined
              ? {}
              : { publicId: args.suppliedTaskId }),
          });
          if (!created.ok || repository === null) return created;
          const task = await ctx.db
            .query("tasks")
            .withIndex("by_workspace_and_public_id", (query) =>
              query
                .eq("workspaceId", command.authorization.workspace._id)
                .eq("publicId", created.data.task.id))
            .unique();
          if (
            task === null ||
            task.organizationId !== command.authorization.organization._id
          ) {
            throw new Error("HRA-created task repository link lost its task.");
          }
          await ctx.db.insert("taskRepositoryLinks", {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
            taskId: task._id,
            repositoryId: repository._id,
            createdAt: command.now,
          });
          return created;
        },
      },
    );
  },
});

export const updateTask = mutation({
  args: {
    ...baseTaskArgs,
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    type: v.optional(taskTypeValidator),
    priority: v.optional(v.number()),
    availableAt: v.optional(v.number()),
  },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
    const parsedRevision = Number.isSafeInteger(args.revision) && args.revision >= 1
      ? args.revision
      : null;
    const parsedTitle = args.title === undefined
      ? undefined
      : taskTitleSchema.safeParse(args.title);
    const parsedDescription = args.description === undefined
      ? undefined
      : taskDescriptionSchema.safeParse(args.description);
    const parsedType = args.type === undefined
      ? undefined
      : taskTypeSchema.safeParse(args.type);
    const parsedPriority = args.priority === undefined
      ? undefined
      : taskPrioritySchema.safeParse(args.priority);
    const parsedAvailableAt = args.availableAt === undefined
      ? undefined
      : epochMsSchema.safeParse(args.availableAt);
    if (
      parsedRevision === null ||
      (
        parsedTitle === undefined &&
        parsedDescription === undefined &&
        parsedType === undefined &&
        parsedPriority === undefined &&
        parsedAvailableAt === undefined
      ) ||
      parsedTitle?.success === false ||
      parsedDescription?.success === false ||
      parsedType?.success === false ||
      parsedPriority?.success === false ||
      parsedAvailableAt?.success === false
    ) {
      return domainFailure("VALIDATION_ERROR", requestId);
    }
    const parsed = {
      revision: parsedRevision,
      ...(parsedTitle === undefined ? {} : { title: parsedTitle.data }),
      ...(parsedDescription === undefined
        ? {}
        : { description: parsedDescription.data }),
      ...(parsedType === undefined ? {} : { type: parsedType.data }),
      ...(parsedPriority === undefined
        ? {}
        : { priority: parsedPriority.data }),
      ...(parsedAvailableAt === undefined
        ? {}
        : { availableAt: parsedAvailableAt.data }),
    };
    const operation = "tasks.update";
    const requestDigest = humanTaskMutationDigest(operation, {
      workspaceId: args.workspaceId,
      key: args.key,
      ...parsed,
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "planner",
        hostedAttemptOperation: "task.update",
        hostedAttemptTargetTaskKey: args.key,
        hostedAttemptIntent: (binding) => ({
          kind: "task.update",
          taskId: hostedTargetTaskId(binding),
          expectedTaskRevision: parsed.revision,
          patch: {
            ...(parsed.title === undefined ? {} : { title: parsed.title }),
            ...(parsed.description === undefined
              ? {}
              : { description: parsed.description }),
            ...(parsed.type === undefined ? {} : { type: parsed.type }),
            ...(parsed.priority === undefined
              ? {}
              : { priority: parsed.priority }),
            ...(parsed.availableAt === undefined
              ? {}
              : { availableAt: parsed.availableAt }),
          },
        }),
        operation,
        parseReceipt: parseTaskMutation,
        execute: async (command) => {
          const loaded = await loadHumanMutableTask(ctx, {
            workspaceId: command.authorization.workspace._id,
            key: args.key,
            revision: parsed.revision,
            now: command.now,
            requestId: command.requestId,
          });
          if (!loaded.ok) return loaded;
          const fields: string[] = [];
          const patch: Partial<TaskDoc> = {
            revision: loaded.data.revision + 1,
            reviewRevision: loaded.data.reviewRevision + 1,
            lastEditedBy: command.actor,
            updatedAt: command.now,
          };
          let availabilityPatch: {
            readySince?: number | undefined;
          } = {};
          if (parsed.title !== undefined) {
            patch.title = parsed.title;
            fields.push("title");
          }
          if (parsed.type !== undefined) {
            patch.type = parsed.type;
            fields.push("type");
          }
          if (parsed.priority !== undefined) {
            patch.priority = parsed.priority;
            fields.push("priority");
          }
          if (parsed.description !== undefined) {
            fields.push("description");
            const body = await ctx.db
              .query("taskBodies")
              .withIndex("by_workspace_and_task", (query) =>
                query
                  .eq("workspaceId", loaded.data.workspaceId)
                  .eq("taskId", loaded.data._id),
              )
              .unique();
            if (body === null) {
              await ctx.db.insert("taskBodies", {
                organizationId: loaded.data.organizationId,
                workspaceId: loaded.data.workspaceId,
                taskId: loaded.data._id,
                description: parsed.description,
                createdAt: command.now,
                updatedAt: command.now,
              });
            } else if (
              body.organizationId !== loaded.data.organizationId ||
              body.workspaceId !== loaded.data.workspaceId ||
              body.taskId !== loaded.data._id
            ) {
              return domainFailure("INTERNAL_ERROR", command.requestId);
            } else {
              await ctx.db.patch(body._id, {
                description: parsed.description,
                updatedAt: command.now,
              });
            }
          }
          if (parsed.availableAt !== undefined) {
            if (parsed.availableAt > command.now + MAX_DEFER_MS) {
              return domainFailure("DEFER_HORIZON", command.requestId);
            }
            fields.push("availableAt");
            const generation = (loaded.data.wakeGeneration ?? 0) + 1;
            const ready =
              loaded.data.status === "open" &&
              parsed.availableAt <= command.now &&
              loaded.data.unresolvedBlockerCount === 0 &&
              loaded.data.cancelledBlockerCount === 0;
            patch.availableAt = parsed.availableAt;
            patch.isReady = ready;
            availabilityPatch = ready
              ? { readySince: command.now }
              : { readySince: undefined };
            patch.wakeGeneration = generation;
            if (parsed.availableAt > command.now) {
              const wakeId = await ctx.db.insert("taskWakes", {
                organizationId: loaded.data.organizationId,
                workspaceId: loaded.data.workspaceId,
                taskId: loaded.data._id,
                generation,
                expectedAvailableAt: parsed.availableAt,
                state: "pending",
                createdAt: command.now,
              });
              await ctx.scheduler.runAt(
                parsed.availableAt,
                internal.schedules.wakeTask,
                {
                  taskId: loaded.data._id,
                  wakeId,
                  generation,
                  expectedAvailableAt: parsed.availableAt,
                },
              );
            }
          }
          await ctx.db.patch(loaded.data._id, {
            ...patch,
            ...availabilityPatch,
          });
          await appendTaskEvent(ctx, {
            organizationId: loaded.data.organizationId,
            workspaceId: loaded.data.workspaceId,
            taskId: loaded.data._id,
            taskPublicId: loaded.data.publicId,
            taskRevision: loaded.data.revision + 1,
            type: "task.updated",
            actor: command.actor,
            command: clientCommand(command),
            payload: { fields },
            now: command.now,
          });
          const updated = await ctx.db.get(loaded.data._id);
          if (updated === null) throw new Error("Human-updated task disappeared.");
          return await requireHumanTaskDetail(ctx, updated, command.requestId);
        },
      },
    );
  },
});

export const assignTask = mutation({
  args: {
    ...baseTaskArgs,
    agentId: v.union(v.string(), v.null()),
  },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
    const parsed = assignTaskRequestSchema.safeParse({
      revision: args.revision,
      assigneeAgentId: args.agentId,
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
    const operation = "tasks.assign";
    const requestDigest = humanTaskMutationDigest(operation, {
      workspaceId: args.workspaceId,
      key: args.key,
      ...parsed.data,
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "planner",
        hostedAttemptOperation: "task.assign",
        hostedAttemptTargetTaskKey: args.key,
        hostedAttemptIntent: (binding) => ({
          kind: "task.assign",
          taskId: hostedTargetTaskId(binding),
          expectedTaskRevision: parsed.data.revision,
          assigneeAgentId: parsed.data.assigneeAgentId,
        }),
        operation,
        parseReceipt: parseTaskMutation,
        execute: async (command) => {
          const loaded = await loadHumanMutableTask(ctx, {
            workspaceId: command.authorization.workspace._id,
            key: args.key,
            revision: parsed.data.revision,
            now: command.now,
            requestId: command.requestId,
          });
          if (!loaded.ok) return loaded;
          if (parsed.data.assigneeAgentId !== null) {
            const assignee = await ctx.db
              .query("agents")
              .withIndex("by_public_id", (query) =>
                query.eq("publicId", parsed.data.assigneeAgentId ?? ""),
              )
              .unique();
            if (
              assignee === null ||
              assignee.organizationId !== command.authorization.organization._id ||
              assignee.status !== "active"
            ) {
              return domainFailure("NOT_FOUND", command.requestId);
            }
            const grant = await ctx.db
              .query("agentWorkspaceGrants")
              .withIndex("by_workspace_and_agent", (query) =>
                query
                  .eq("workspaceId", command.authorization.workspace._id)
                  .eq("agentId", assignee._id),
              )
              .unique();
            if (
              grant === null ||
              grant.organizationId !== command.authorization.organization._id ||
              grant.workspaceId !== command.authorization.workspace._id ||
              grant.agentId !== assignee._id ||
              grant.status !== "active"
            ) {
              return domainFailure("NOT_FOUND", command.requestId);
            }
          }
          await ctx.db.patch(loaded.data._id, {
            ...(parsed.data.assigneeAgentId === null
              ? { assigneeAgentPublicId: undefined }
              : { assigneeAgentPublicId: parsed.data.assigneeAgentId }),
            revision: loaded.data.revision + 1,
            reviewRevision: loaded.data.reviewRevision + 1,
            lastEditedBy: command.actor,
            updatedAt: command.now,
          });
          await appendTaskEvent(ctx, {
            organizationId: loaded.data.organizationId,
            workspaceId: loaded.data.workspaceId,
            taskId: loaded.data._id,
            taskPublicId: loaded.data.publicId,
            taskRevision: loaded.data.revision + 1,
            type: "task.assigned",
            actor: command.actor,
            command: clientCommand(command),
            payload: { assigneeAgentId: parsed.data.assigneeAgentId },
            now: command.now,
          });
          const updated = await ctx.db.get(loaded.data._id);
          if (updated === null) throw new Error("Human-assigned task disappeared.");
          return await requireHumanTaskDetail(ctx, updated, command.requestId);
        },
      },
    );
  },
});

export const deferTask = mutation({
  args: { ...baseTaskArgs, availableAt: v.number() },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
    const parsed = deferTaskRequestSchema.safeParse({
      revision: args.revision,
      availableAt: args.availableAt,
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
    const operation = "tasks.defer";
    const requestDigest = humanTaskMutationDigest(operation, {
      workspaceId: args.workspaceId,
      key: args.key,
      ...parsed.data,
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "planner",
        hostedAttemptOperation: "task.defer",
        hostedAttemptTargetTaskKey: args.key,
        hostedAttemptIntent: (binding) => ({
          kind: "task.defer",
          taskId: hostedTargetTaskId(binding),
          expectedTaskRevision: parsed.data.revision,
          availableAt: parsed.data.availableAt,
        }),
        operation,
        parseReceipt: parseTaskMutation,
        execute: async (command) => {
          if (parsed.data.availableAt > command.now + MAX_DEFER_MS) {
            return domainFailure("DEFER_HORIZON", command.requestId);
          }
          const loaded = await loadHumanMutableTask(ctx, {
            workspaceId: command.authorization.workspace._id,
            key: args.key,
            revision: parsed.data.revision,
            now: command.now,
            requestId: command.requestId,
          });
          if (!loaded.ok) return loaded;
          const generation = (loaded.data.wakeGeneration ?? 0) + 1;
          const ready =
            loaded.data.status === "open" &&
            parsed.data.availableAt <= command.now &&
            loaded.data.unresolvedBlockerCount === 0 &&
            loaded.data.cancelledBlockerCount === 0;
          await ctx.db.patch(loaded.data._id, {
            availableAt: parsed.data.availableAt,
            isReady: ready,
            ...(ready ? { readySince: command.now } : { readySince: undefined }),
            wakeGeneration: generation,
            revision: loaded.data.revision + 1,
            reviewRevision: loaded.data.reviewRevision + 1,
            lastEditedBy: command.actor,
            updatedAt: command.now,
          });
          if (parsed.data.availableAt > command.now) {
            const wakeId = await ctx.db.insert("taskWakes", {
              organizationId: loaded.data.organizationId,
              workspaceId: loaded.data.workspaceId,
              taskId: loaded.data._id,
              generation,
              expectedAvailableAt: parsed.data.availableAt,
              state: "pending",
              createdAt: command.now,
            });
            await ctx.scheduler.runAt(parsed.data.availableAt, internal.schedules.wakeTask, {
              taskId: loaded.data._id,
              wakeId,
              generation,
              expectedAvailableAt: parsed.data.availableAt,
            });
          }
          await appendTaskEvent(ctx, {
            organizationId: loaded.data.organizationId,
            workspaceId: loaded.data.workspaceId,
            taskId: loaded.data._id,
            taskPublicId: loaded.data.publicId,
            taskRevision: loaded.data.revision + 1,
            type: "task.deferred",
            actor: command.actor,
            command: clientCommand(command),
            payload: { availableAt: parsed.data.availableAt },
            now: command.now,
          });
          const updated = await ctx.db.get(loaded.data._id);
          if (updated === null) throw new Error("Human-deferred task disappeared.");
          return await requireHumanTaskDetail(ctx, updated, command.requestId);
        },
      },
    );
  },
});

type LabelMutationArgs = Readonly<{
  workspaceId: string;
  key: string;
  revision: number;
  label: string;
  idempotencyKey: string;
}>;

async function mutateTaskLabel(
  ctx: MutationCtx,
  args: LabelMutationArgs,
  remove: boolean,
) {
  const requestId = randomRequestId();
  if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
  const parsed = taskLabelMutationRequestSchema.safeParse({
    revision: args.revision,
    label: args.label,
  });
  if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
  const operation = remove ? "tasks.labels.remove" : "tasks.labels.add";
  const requestDigest = humanTaskMutationDigest(operation, {
    workspaceId: args.workspaceId,
    key: args.key,
    ...parsed.data,
  });
  return await runHumanTaskMutation(
    ctx,
    { ...args, requestDigest, requestId },
    {
      capability: "planner",
      hostedAttemptOperation: remove ? "task.label_remove" : "task.label_add",
      hostedAttemptTargetTaskKey: args.key,
      hostedAttemptIntent: (binding) => ({
        kind: remove ? "task.label_remove" : "task.label_add",
        taskId: hostedTargetTaskId(binding),
        expectedTaskRevision: parsed.data.revision,
        label: parsed.data.label,
      }),
      operation,
      parseReceipt: parseTaskMutation,
      execute: async (command) => {
        const loaded = await loadHumanMutableTask(ctx, {
          workspaceId: command.authorization.workspace._id,
          key: args.key,
          revision: parsed.data.revision,
          now: command.now,
          requestId: command.requestId,
        });
        if (!loaded.ok) return loaded;
        const existing = await ctx.db
          .query("taskLabels")
          .withIndex("by_workspace_task_label", (query) =>
            query
              .eq("workspaceId", loaded.data.workspaceId)
              .eq("taskId", loaded.data._id)
              .eq("label", parsed.data.label),
          )
          .unique();
        if (
          existing !== null &&
          (existing.organizationId !== loaded.data.organizationId ||
            existing.workspaceId !== loaded.data.workspaceId ||
            existing.taskId !== loaded.data._id ||
            existing.label !== parsed.data.label)
        ) {
          return domainFailure("INTERNAL_ERROR", command.requestId);
        }
        if ((!remove && existing !== null) || (remove && existing === null)) {
          return domainFailure("TASK_STATE_CONFLICT", command.requestId, {
            taskKey: loaded.data.key,
            currentRevision: loaded.data.revision,
          });
        }
        if (!remove) {
          const labels = await ctx.db
            .query("taskLabels")
            .withIndex("by_workspace_task_created", (query) =>
              query.eq("workspaceId", loaded.data.workspaceId).eq("taskId", loaded.data._id),
            )
            .take(MAX_TASK_LABELS);
          if (labels.length >= MAX_TASK_LABELS) {
            return domainFailure("VALIDATION_ERROR", command.requestId);
          }
          const scope = {
            organizationId: loaded.data.organizationId,
            workspaceId: loaded.data.workspaceId,
          };
          const existingWorkspaceLabels = await ctx.db
            .query("workspaceLabels")
            .withIndex("by_workspace_and_name", (query) =>
              query
                .eq("workspaceId", scope.workspaceId)
                .eq("name", parsed.data.label),
            )
            .take(2);
          if (
            existingWorkspaceLabels.length > 1 ||
            existingWorkspaceLabels.some(
              (workspaceLabel) =>
                workspaceLabel.organizationId !== scope.organizationId ||
                workspaceLabel.workspaceId !== scope.workspaceId ||
                workspaceLabel.name !== parsed.data.label,
            )
          ) {
            return domainFailure("PROJECTION_MISMATCH", command.requestId, {
              taskKey: loaded.data.key,
              currentRevision: loaded.data.revision,
            });
          }
          const workspaceLabel = await ensureWorkspaceLabel(
            ctx,
            scope,
            parsed.data.label,
            command.now,
          );
          if (workspaceLabel === null || workspaceLabel === undefined) {
            throw new Error("Human task label projection is invalid after label creation.");
          }
          await ctx.db.insert("taskLabels", {
            ...scope,
            taskId: loaded.data._id,
            labelId: workspaceLabel._id,
            label: parsed.data.label,
            createdBy: command.actor,
            createdAt: command.now,
          });
        } else if (existing !== null) {
          await ctx.db.delete(existing._id);
        }
        await ctx.db.patch(loaded.data._id, {
          revision: loaded.data.revision + 1,
          reviewRevision: loaded.data.reviewRevision + 1,
          lastEditedBy: command.actor,
          updatedAt: command.now,
        });
        await appendTaskEvent(ctx, {
          organizationId: loaded.data.organizationId,
          workspaceId: loaded.data.workspaceId,
          taskId: loaded.data._id,
          taskPublicId: loaded.data.publicId,
          taskRevision: loaded.data.revision + 1,
          type: remove ? "task.label_removed" : "task.label_added",
          actor: command.actor,
          command: clientCommand(command),
          payload: { label: parsed.data.label },
          now: command.now,
        });
        const updated = await ctx.db.get(loaded.data._id);
        if (updated === null) throw new Error("Human-labelled task disappeared.");
        return await requireHumanTaskDetail(ctx, updated, command.requestId);
      },
    },
  );
}

const labelArgs = { ...baseTaskArgs, label: v.string() } as const;

export const addTaskLabel = mutation({
  args: labelArgs,
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => await mutateTaskLabel(ctx, args, false),
});

export const removeTaskLabel = mutation({
  args: labelArgs,
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => await mutateTaskLabel(ctx, args, true),
});

export const addTaskComment = mutation({
  args: {
    workspaceId: v.string(),
    key: v.string(),
    body: v.string(),
    idempotencyKey: v.string(),
    ...hraMutationControlArgs,
  },
  returns: commentResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
    const parsed = addTaskCommentRequestSchema.safeParse({ body: args.body });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
    const operation = "tasks.comments.add";
    const requestDigest = humanTaskMutationDigest(operation, {
      workspaceId: args.workspaceId,
      key: args.key,
      ...parsed.data,
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "comment",
        hostedAttemptOperation: "task.comment_add",
        hostedAttemptTargetTaskKey: args.key,
        hostedAttemptIntent: (binding) => ({
          kind: "task.comment_add",
          taskId: hostedTargetTaskId(binding),
          body: parsed.data.body,
        }),
        operation,
        parseReceipt: parseComment,
        execute: async (command) => {
          const task = await taskByKey(ctx, command.authorization.workspace._id, args.key);
          if (
            task === null ||
            task.organizationId !== command.authorization.organization._id
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          const publicId = randomPublicId("cmt");
          await ctx.db.insert("taskComments", {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
            taskId: task._id,
            publicId,
            body: parsed.data.body,
            actor: command.actor,
            createdAt: command.now,
          });
          await appendTaskEvent(ctx, {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
            taskId: task._id,
            taskPublicId: task.publicId,
            taskRevision: task.revision,
            type: "task.comment_added",
            actor: command.actor,
            command: clientCommand(command),
            payload: { commentId: publicId },
            now: command.now,
          });
          return {
            ok: true,
            data: {
              comment: {
                id: publicId,
                body: parsed.data.body,
                actor: { kind: "human" as const, userId: command.authorization.user.publicId },
                createdAt: command.now,
              },
            },
          };
        },
      },
    );
  },
});

export const addTaskReference = mutation({
  args: {
    ...baseTaskArgs,
    reference: referenceInputValidator,
  },
  returns: referenceResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
    const parsed = addTaskReferenceRequestSchema.safeParse({
      revision: args.revision,
      reference: args.reference,
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
    const operation = "tasks.references.add";
    const requestDigest = humanTaskMutationDigest(operation, {
      workspaceId: args.workspaceId,
      key: args.key,
      ...parsed.data,
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "planner",
        hostedAttemptOperation: "task.reference_add",
        hostedAttemptTargetTaskKey: args.key,
        hostedAttemptIntent: (binding) => ({
          kind: "task.reference_add",
          taskId: hostedTargetTaskId(binding),
          expectedTaskRevision: parsed.data.revision,
          reference: parsed.data.reference,
        }),
        operation,
        parseReceipt: parseReference,
        execute: async (command) => {
          const loaded = await loadHumanMutableTask(ctx, {
            workspaceId: command.authorization.workspace._id,
            key: args.key,
            revision: parsed.data.revision,
            now: command.now,
            requestId: command.requestId,
          });
          if (!loaded.ok) return loaded;
          if (!referenceHasSafeUrls(parsed.data.reference)) {
            return domainFailure("VALIDATION_ERROR", command.requestId);
          }
          const value = await persistedReferenceValue(
            ctx,
            loaded.data.workspaceId,
            parsed.data.reference,
          );
          if (value === null) return domainFailure("NOT_FOUND", command.requestId);
          const publicId = randomPublicId("ref");
          const referenceId = await ctx.db.insert("taskReferences", {
            organizationId: loaded.data.organizationId,
            workspaceId: loaded.data.workspaceId,
            taskId: loaded.data._id,
            publicId,
            value,
            status: "active",
            createdBy: command.actor,
            createdAt: command.now,
            updatedAt: command.now,
          });
          await ctx.db.patch(loaded.data._id, {
            revision: loaded.data.revision + 1,
            reviewRevision: loaded.data.reviewRevision + 1,
            lastEditedBy: command.actor,
            updatedAt: command.now,
          });
          await appendTaskEvent(ctx, {
            organizationId: loaded.data.organizationId,
            workspaceId: loaded.data.workspaceId,
            taskId: loaded.data._id,
            taskPublicId: loaded.data.publicId,
            taskRevision: loaded.data.revision + 1,
            type: "task.reference_added",
            actor: command.actor,
            command: clientCommand(command),
            payload: { referenceId: publicId, kind: value.kind },
            now: command.now,
          });
          const [stored, updated] = await Promise.all([
            ctx.db.get(referenceId),
            ctx.db.get(loaded.data._id),
          ]);
          if (stored === null || updated === null) {
            throw new Error("Human task reference disappeared.");
          }
          const view = await referenceView(ctx, stored);
          if (view === null) throw new Error("Human task reference target disappeared.");
          return { ok: true, data: { reference: view, task: taskView(updated) } };
        },
      },
    );
  },
});

export const removeTaskReference = mutation({
  args: {
    ...baseTaskArgs,
    referenceId: v.string(),
  },
  returns: referenceRemoveResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !validPublicScope(args) ||
      !taskReferenceIdSchema.safeParse(args.referenceId).success
    ) {
      return domainFailure("VALIDATION_ERROR", requestId);
    }
    const parsed = removeTaskReferenceRequestSchema.safeParse({ revision: args.revision });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
    const operation = "tasks.references.remove";
    const requestDigest = humanTaskMutationDigest(operation, {
      workspaceId: args.workspaceId,
      key: args.key,
      referenceId: args.referenceId,
      ...parsed.data,
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "planner",
        hostedAttemptOperation: "task.reference_remove",
        hostedAttemptTargetTaskKey: args.key,
        hostedAttemptIntent: (binding) => ({
          kind: "task.reference_remove",
          taskId: hostedTargetTaskId(binding),
          expectedTaskRevision: parsed.data.revision,
          referenceId: args.referenceId,
        }),
        operation,
        parseReceipt: parseRemovedReference,
        execute: async (command) => {
          const loaded = await loadHumanMutableTask(ctx, {
            workspaceId: command.authorization.workspace._id,
            key: args.key,
            revision: parsed.data.revision,
            now: command.now,
            requestId: command.requestId,
          });
          if (!loaded.ok) return loaded;
          const reference = await ctx.db
            .query("taskReferences")
            .withIndex("by_public_id", (query) => query.eq("publicId", args.referenceId))
            .unique();
          if (
            reference === null ||
            reference.organizationId !== loaded.data.organizationId ||
            reference.workspaceId !== loaded.data.workspaceId ||
            reference.taskId !== loaded.data._id ||
            reference.status !== "active"
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          await ctx.db.patch(reference._id, {
            status: "removed",
            removedAt: command.now,
            updatedAt: command.now,
          });
          await ctx.db.patch(loaded.data._id, {
            revision: loaded.data.revision + 1,
            reviewRevision: loaded.data.reviewRevision + 1,
            lastEditedBy: command.actor,
            updatedAt: command.now,
          });
          await appendTaskEvent(ctx, {
            organizationId: loaded.data.organizationId,
            workspaceId: loaded.data.workspaceId,
            taskId: loaded.data._id,
            taskPublicId: loaded.data.publicId,
            taskRevision: loaded.data.revision + 1,
            type: "task.reference_removed",
            actor: command.actor,
            command: clientCommand(command),
            payload: { referenceId: reference.publicId, kind: reference.value.kind },
            now: command.now,
          });
          const updated = await ctx.db.get(loaded.data._id);
          if (updated === null) throw new Error("Human-unreferenced task disappeared.");
          return {
            ok: true,
            data: { referenceId: reference.publicId, task: taskView(updated) },
          };
        },
      },
    );
  },
});

type DependencyMutationArgs = Readonly<{
  workspaceId: string;
  key: string;
  blockerKey: string;
  revision: number;
  idempotencyKey: string;
}>;

async function mutateTaskDependency(
  ctx: MutationCtx,
  args: DependencyMutationArgs,
  remove: boolean,
) {
  const requestId = randomRequestId();
  if (
    !validPublicScope(args) ||
    !taskKeySchema.safeParse(args.blockerKey).success
  ) {
    return domainFailure("VALIDATION_ERROR", requestId);
  }
  const parsed = taskDependencyMutationRequestSchema.safeParse({
    revision: args.revision,
    blockerKey: args.blockerKey,
  });
  if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
  const operation = remove ? "tasks.dependencies.remove" : "tasks.dependencies.add";
  const requestDigest = humanTaskMutationDigest(operation, {
    workspaceId: args.workspaceId,
    key: args.key,
    ...parsed.data,
  });
  return await runHumanTaskMutation(
    ctx,
    { ...args, requestDigest, requestId },
    {
      capability: "planner",
      hostedAttemptOperation: remove
        ? "dependency.remove"
        : "dependency.add",
      hostedAttemptTargetTaskKey: args.key,
      hostedAttemptIntent: (binding) => ({
        kind: remove ? "dependency.remove" : "dependency.add",
        taskId: hostedTargetTaskId(binding),
        expectedTaskRevision: parsed.data.revision,
        blockerKey: parsed.data.blockerKey,
      }),
      operation,
      parseReceipt: parseDependency,
      execute: async (command) => {
        const loaded = await loadHumanMutableTask(ctx, {
          workspaceId: command.authorization.workspace._id,
          key: args.key,
          revision: parsed.data.revision,
          now: command.now,
          requestId: command.requestId,
        });
        if (!loaded.ok) return loaded;
        const blocker = await taskByKey(ctx, loaded.data.workspaceId, parsed.data.blockerKey);
        if (
          blocker === null ||
          blocker.organizationId !== loaded.data.organizationId ||
          blocker.workspaceId !== loaded.data.workspaceId
        ) {
          return domainFailure("NOT_FOUND", command.requestId);
        }
        if (blocker._id === loaded.data._id) {
          return domainFailure("DEPENDENCY_CYCLE", command.requestId, {
            taskKey: loaded.data.key,
            currentRevision: loaded.data.revision,
          });
        }
        const projection = await ensureCounterProjection(
          ctx,
          loaded.data,
          command.now,
          command.requestId,
        );
        if (!projection.ok) return projection;
        const existing = await ctx.db
          .query("taskDependencies")
          .withIndex("by_workspace_blocker_blocked", (query) =>
            query
              .eq("workspaceId", loaded.data.workspaceId)
              .eq("blockerTaskId", blocker._id)
              .eq("blockedTaskId", loaded.data._id),
          )
          .unique();
        if (
          existing !== null &&
          (existing.organizationId !== loaded.data.organizationId ||
            existing.workspaceId !== loaded.data.workspaceId ||
            existing.blockerTaskId !== blocker._id ||
            existing.blockedTaskId !== loaded.data._id ||
            existing.kind !== "blocks")
        ) {
          await queueTaskProjectionRepair(ctx, loaded.data, command.now);
          return domainFailure("PROJECTION_MISMATCH", command.requestId, {
            taskKey: loaded.data.key,
            currentRevision: loaded.data.revision,
          });
        }
        if (!remove && existing !== null) {
          return domainFailure("DEPENDENCY_DUPLICATE", command.requestId, {
            taskKey: loaded.data.key,
            currentRevision: loaded.data.revision,
          });
        }
        if (remove && existing === null) return domainFailure("NOT_FOUND", command.requestId);
        if (!remove) {
          const blockers = await blockerRows(ctx, loaded.data);
          if (blockers.length >= MAX_DIRECT_BLOCKERS) {
            return domainFailure("BLOCKER_LIMIT", command.requestId, {
              taskKey: loaded.data.key,
              currentRevision: loaded.data.revision,
              blockingCount: blockers.length,
            });
          }
          const dependents = await ctx.db
            .query("taskDependencies")
            .withIndex("by_workspace_blocker_created", (query) =>
              query
                .eq("workspaceId", blocker.workspaceId)
                .eq("blockerTaskId", blocker._id),
            )
            .take(MAX_BLOCKING_DEPENDENTS + 1);
          if (dependents.length >= MAX_BLOCKING_DEPENDENTS) {
            return domainFailure("DEPENDENT_LIMIT", command.requestId, {
              taskKey: blocker.key,
              currentRevision: blocker.revision,
              blockingCount: dependents.length,
            });
          }
          const cycle = await validateDependencyCycleDb(
            ctx,
            loaded.data.workspaceId,
            blocker._id,
            loaded.data._id,
          );
          if (cycle.kind === "cycle") {
            return domainFailure("DEPENDENCY_CYCLE", command.requestId, {
              taskKey: loaded.data.key,
              currentRevision: loaded.data.revision,
            });
          }
          if (cycle.kind === "limit") {
            return domainFailure("GRAPH_VALIDATION_LIMIT", command.requestId, {
              taskKey: loaded.data.key,
              currentRevision: loaded.data.revision,
              exhaustedLimit: cycle.exhaustedLimit,
            });
          }
        }
        let dependency: Doc<"taskDependencies">;
        if (remove) {
          if (existing === null) return domainFailure("NOT_FOUND", command.requestId);
          dependency = existing;
          await ctx.db.delete(existing._id);
        } else {
          const dependencyId = await ctx.db.insert("taskDependencies", {
            organizationId: loaded.data.organizationId,
            workspaceId: loaded.data.workspaceId,
            blockerTaskId: blocker._id,
            blockedTaskId: loaded.data._id,
            kind: "blocks",
            createdBy: command.actor,
            createdAt: command.now,
          });
          const created = await ctx.db.get(dependencyId);
          if (created === null) throw new Error("Human-created dependency disappeared.");
          dependency = created;
        }
        const contribution = blockerContribution(blocker.status);
        const unresolved =
          loaded.data.unresolvedBlockerCount +
          (remove ? -contribution.unresolved : contribution.unresolved);
        const cancelled =
          loaded.data.cancelledBlockerCount +
          (remove ? -contribution.cancelled : contribution.cancelled);
        if (unresolved < 0 || cancelled < 0) {
          await queueTaskProjectionRepair(ctx, loaded.data, command.now);
          return domainFailure("PROJECTION_MISMATCH", command.requestId, {
            taskKey: loaded.data.key,
            currentRevision: loaded.data.revision,
            blockingCount:
              loaded.data.unresolvedBlockerCount + loaded.data.cancelledBlockerCount,
          });
        }
        const ready = derivedReady({
          status: loaded.data.status,
          availableAt: loaded.data.availableAt,
          now: command.now,
          unresolved,
          cancelled,
        });
        await ctx.db.patch(loaded.data._id, {
          unresolvedBlockerCount: unresolved,
          cancelledBlockerCount: cancelled,
          isBlocked: unresolved + cancelled > 0,
          isReady: ready,
          ...(ready
            ? { readySince: loaded.data.readySince ?? command.now }
            : { readySince: undefined }),
          needsAttention: derivedNeedsAttention({
            status: loaded.data.status,
            unresolved,
            cancelled,
          }),
          revision: loaded.data.revision + 1,
          reviewRevision: loaded.data.reviewRevision + 1,
          lastEditedBy: command.actor,
          updatedAt: command.now,
        });
        await appendTaskEvent(ctx, {
          organizationId: loaded.data.organizationId,
          workspaceId: loaded.data.workspaceId,
          taskId: loaded.data._id,
          taskPublicId: loaded.data.publicId,
          taskRevision: loaded.data.revision + 1,
          type: remove ? "dependency.removed" : "dependency.added",
          actor: command.actor,
          command: clientCommand(command),
          payload: {
            blockerTaskId: blocker.publicId,
            blockedTaskId: loaded.data.publicId,
          },
          now: command.now,
        });
        const updated = await ctx.db.get(loaded.data._id);
        if (updated === null) throw new Error("Human dependency task disappeared.");
        const view = await dependencyView(ctx, dependency);
        if (view === null) throw new Error("Human dependency view disappeared.");
        return { ok: true, data: { dependency: view, task: taskView(updated) } };
      },
    },
  );
}

const dependencyArgs = { ...baseTaskArgs, blockerKey: v.string() } as const;

export const addTaskDependency = mutation({
  args: dependencyArgs,
  returns: dependencyResultValidator,
  handler: async (ctx, args) => await mutateTaskDependency(ctx, args, false),
});

export const removeTaskDependency = mutation({
  args: dependencyArgs,
  returns: dependencyResultValidator,
  handler: async (ctx, args) => await mutateTaskDependency(ctx, args, true),
});

type ParentMutationArgs = Readonly<{
  workspaceId: string;
  key: string;
  revision: number;
  parentKey?: string;
  idempotencyKey: string;
}>;

async function mutateTaskParent(
  ctx: MutationCtx,
  args: ParentMutationArgs,
  clear: boolean,
) {
  const requestId = randomRequestId();
  if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
  const parsed = clear
    ? clearTaskParentRequestSchema.safeParse({ revision: args.revision })
    : setTaskParentRequestSchema.safeParse({
        revision: args.revision,
        parentKey: args.parentKey,
      });
  if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
  const operation = clear ? "tasks.parent.clear" : "tasks.parent.set";
  const requestDigest = humanTaskMutationDigest(operation, {
    workspaceId: args.workspaceId,
    key: args.key,
    ...parsed.data,
  });
  return await runHumanTaskMutation(
    ctx,
    { ...args, requestDigest, requestId },
    {
      capability: "planner",
      hostedAttemptOperation: clear ? "task.parent_clear" : "task.parent_set",
      hostedAttemptTargetTaskKey: args.key,
      hostedAttemptIntent: (binding) =>
        clear
          ? {
              kind: "task.parent_clear",
              taskId: hostedTargetTaskId(binding),
              expectedTaskRevision: parsed.data.revision,
            }
          : {
              kind: "task.parent_set",
              taskId: hostedTargetTaskId(binding),
              expectedTaskRevision: parsed.data.revision,
              parentKey: requiredHostedMutationString(
                args.parentKey,
                "parentKey",
              ),
            },
      operation,
      parseReceipt: parseTaskMutation,
      execute: async (command) => {
        const loaded = await loadHumanMutableTask(ctx, {
          workspaceId: command.authorization.workspace._id,
          key: args.key,
          revision: parsed.data.revision,
          now: command.now,
          requestId: command.requestId,
        });
        if (!loaded.ok) return loaded;
        let parent: TaskDoc | null = null;
        if (!clear) {
          const parentKey = args.parentKey;
          if (parentKey === undefined) {
            return domainFailure("VALIDATION_ERROR", command.requestId);
          }
          parent = await taskByKey(ctx, loaded.data.workspaceId, parentKey);
          if (
            parent === null ||
            parent.organizationId !== loaded.data.organizationId ||
            parent.workspaceId !== loaded.data.workspaceId
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          const validation = await validateParentChain(ctx, loaded.data._id, parent);
          if (validation === "cycle") {
            return domainFailure("HIERARCHY_CYCLE", command.requestId, {
              taskKey: loaded.data.key,
              currentRevision: loaded.data.revision,
            });
          }
          if (validation === "limit") {
            return domainFailure("GRAPH_VALIDATION_LIMIT", command.requestId, {
              taskKey: loaded.data.key,
              currentRevision: loaded.data.revision,
              exhaustedLimit: "parent_depth",
            });
          }
          if (loaded.data.parentTaskId === parent._id) {
            return domainFailure("TASK_STATE_CONFLICT", command.requestId, {
              taskKey: loaded.data.key,
              currentRevision: loaded.data.revision,
            });
          }
        } else if (loaded.data.parentTaskId === undefined) {
          return domainFailure("TASK_STATE_CONFLICT", command.requestId, {
            taskKey: loaded.data.key,
            currentRevision: loaded.data.revision,
          });
        }
        await ctx.db.patch(loaded.data._id, {
          parentTaskId: parent?._id,
          revision: loaded.data.revision + 1,
          reviewRevision: loaded.data.reviewRevision + 1,
          lastEditedBy: command.actor,
          updatedAt: command.now,
        });
        await appendTaskEvent(ctx, {
          organizationId: loaded.data.organizationId,
          workspaceId: loaded.data.workspaceId,
          taskId: loaded.data._id,
          taskPublicId: loaded.data.publicId,
          taskRevision: loaded.data.revision + 1,
          type: clear ? "task.parent_cleared" : "task.parent_set",
          actor: command.actor,
          command: clientCommand(command),
          payload: parent === null ? {} : { parentTaskId: parent.publicId },
          now: command.now,
        });
        const updated = await ctx.db.get(loaded.data._id);
        if (updated === null) throw new Error("Human parent mutation task disappeared.");
        return await requireHumanTaskDetail(ctx, updated, command.requestId);
      },
    },
  );
}

export const setTaskParent = mutation({
  args: { ...baseTaskArgs, parentKey: v.string() },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => await mutateTaskParent(ctx, args, false),
});

export const clearTaskParent = mutation({
  args: baseTaskArgs,
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => await mutateTaskParent(ctx, args, true),
});

export const cancelTask = mutation({
  args: {
    ...baseTaskArgs,
    reason: v.string(),
  },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
    const parsed = cancelTaskRequestSchema.safeParse({
      workspaceId: args.workspaceId,
      revision: args.revision,
      reason: args.reason,
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
    const operation = "tasks.cancel";
    const requestDigest = humanTaskMutationDigest(operation, {
      key: args.key,
      ...parsed.data,
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "planner",
        hostedAttemptOperation: "task.cancel",
        hostedAttemptTargetTaskKey: args.key,
        hostedAttemptIntent: (binding) => ({
          kind: "task.cancel",
          taskId: hostedTargetTaskId(binding),
          expectedTaskRevision: parsed.data.revision,
          reason: parsed.data.reason,
        }),
        operation,
        parseReceipt: parseTaskMutation,
        execute: async (command) => {
          const task = await taskByKey(ctx, command.authorization.workspace._id, args.key);
          if (
            task === null ||
            task.organizationId !== command.authorization.organization._id
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          if (
            task.revision !== parsed.data.revision ||
            task.status === "done" ||
            task.status === "cancelled"
          ) {
            return domainFailure("TASK_STATE_CONFLICT", command.requestId, {
              taskKey: task.key,
              currentRevision: task.revision,
            });
          }
          const dispatchGuard = await loadTaskDispatchGuard(ctx, task);
          if (dispatchGuard.kind === "projection_mismatch") {
            return domainFailure("PROJECTION_MISMATCH", command.requestId, {
              taskKey: task.key,
              currentRevision: task.revision,
            });
          }
          if (dispatchGuard.kind === "blocked") {
            return domainFailure("TASK_STATE_CONFLICT", command.requestId, {
              taskKey: task.key,
              currentRevision: task.revision,
            });
          }
          if (task.status === "in_progress" && task.currentClaim === undefined) {
            await queueTaskClaimRepair(ctx, task, command.now);
            return domainFailure("PROJECTION_MISMATCH", command.requestId, {
              taskKey: task.key,
              currentRevision: task.revision,
            });
          }
          const detail = await requireHumanTaskDetail(ctx, task, command.requestId);
          if (!detail.ok) return detail;
          const pendingSubmissions =
            task.status === "in_review" ? await pendingSubmissionsForTask(ctx, task) : [];
          if (
            task.status === "in_review" &&
            (pendingSubmissions.length !== 1 ||
              pendingSubmissions[0] === undefined ||
              !submissionHasTaskOwnership(task, pendingSubmissions[0]))
          ) {
            await queueTaskReviewRepair(ctx, task, command.now);
            return domainFailure("PROJECTION_MISMATCH", command.requestId, {
              taskKey: task.key,
              currentRevision: task.revision,
            });
          }
          let activeClaim: Doc<"taskClaims"> | null = null;
          if (task.status === "in_progress" || task.currentClaim !== undefined) {
            activeClaim =
              task.currentClaim === undefined ? null : await ctx.db.get(task.currentClaim.claimId);
            if (!activeClaimMatchesTask(task, activeClaim)) {
              await queueTaskClaimRepair(ctx, task, command.now);
              return domainFailure("PROJECTION_MISMATCH", command.requestId, {
                taskKey: task.key,
                currentRevision: task.revision,
              });
            }
          }
          const usage = await activeWorkspaceUsage(ctx, {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
          });
          if (usage === null) return domainFailure("SERVICE_UNAVAILABLE", command.requestId);
          if (
            usage.organizationId !== task.organizationId ||
            usage.workspaceId !== task.workspaceId ||
            usage.activeTasks <= 0
          ) {
            return domainFailure("INTERNAL_ERROR", command.requestId);
          }
          const projection = await ensureCounterProjection(
            ctx,
            task,
            command.now,
            command.requestId,
          );
          if (!projection.ok) return projection;
          const propagated = await propagateBlockerTransition(ctx, {
            blocker: task,
            previousStatus: task.status,
            nextStatus: "cancelled",
            directBlockerCount: projection.actual.total,
            actor: command.actor,
            idempotencyKey: command.idempotencyKey,
            requestId: command.requestId,
            now: command.now,
          });
          if (!propagated.ok) return { ok: false as const, error: propagated.error };
          if (activeClaim !== null) {
            await ctx.db.patch(activeClaim._id, {
              state: "released",
              endedAt: command.now,
              updatedAt: command.now,
            });
          }
          const pendingSubmission = pendingSubmissions[0];
          if (pendingSubmission !== undefined) {
            await ctx.db.replace(pendingSubmission._id, {
              ...pendingSubmissionBase(pendingSubmission),
              status: "cancelled",
              cancelledBy: command.actor,
              cancelledAt: command.now,
              cancellationReason: parsed.data.reason,
            });
          }
          await ctx.db.insert("taskCancellations", {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
            taskId: task._id,
            reason: parsed.data.reason,
            actor: command.actor,
            cancelledAt: command.now,
          });
          await ctx.db.patch(task._id, {
            status: "cancelled",
            currentClaim: undefined,
            isReady: false,
            isBlocked: task.unresolvedBlockerCount + task.cancelledBlockerCount > 0,
            readySince: undefined,
            cancelledAt: command.now,
            revision: task.revision + 1,
            lastEditedBy: command.actor,
            updatedAt: command.now,
          });
          await ctx.db.patch(usage._id, {
            activeTasks: usage.activeTasks - 1,
            updatedAt: command.now,
          });
          await appendTaskEvent(ctx, {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
            taskId: task._id,
            taskPublicId: task.publicId,
            taskRevision: task.revision + 1,
            type: "task.cancelled",
            actor: command.actor,
            command: clientCommand(command),
            payload: { reason: parsed.data.reason.slice(0, 1_000) },
            now: command.now,
          });
          const updated = await ctx.db.get(task._id);
          if (updated === null) throw new Error("Human-cancelled task disappeared.");
          return await requireHumanTaskDetail(ctx, updated, command.requestId);
        },
      },
    );
  },
});

export const reopenTask = mutation({
  args: baseTaskArgs,
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
    const parsed = reopenTaskRequestSchema.safeParse({
      workspaceId: args.workspaceId,
      revision: args.revision,
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
    const operation = "tasks.reopen";
    const requestDigest = humanTaskMutationDigest(operation, {
      key: args.key,
      ...parsed.data,
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "planner",
        hostedAttemptOperation: "task.reopen",
        hostedAttemptTargetTaskKey: args.key,
        hostedAttemptIntent: (binding) => ({
          kind: "task.reopen",
          taskId: hostedTargetTaskId(binding),
          expectedTaskRevision: parsed.data.revision,
        }),
        operation,
        parseReceipt: parseTaskMutation,
        execute: async (command) => {
          const task = await taskByKey(ctx, command.authorization.workspace._id, args.key);
          if (
            task === null ||
            task.organizationId !== command.authorization.organization._id
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          if (
            task.revision !== parsed.data.revision ||
            (task.status !== "done" && task.status !== "cancelled")
          ) {
            return domainFailure("TASK_STATE_CONFLICT", command.requestId, {
              taskKey: task.key,
              currentRevision: task.revision,
            });
          }
          const detail = await requireHumanTaskDetail(ctx, task, command.requestId);
          if (!detail.ok) return detail;
          const usage = await activeWorkspaceUsage(ctx, {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
          });
          if (usage === null) return domainFailure("SERVICE_UNAVAILABLE", command.requestId);
          if (
            usage.organizationId !== task.organizationId ||
            usage.workspaceId !== task.workspaceId
          ) {
            return domainFailure("INTERNAL_ERROR", command.requestId);
          }
          if (usage.activeTasks >= WORKSPACE_ACTIVE_TASK_LIMIT) {
            return domainFailure("WORKSPACE_TASK_LIMIT", command.requestId);
          }
          const projection = await ensureCounterProjection(
            ctx,
            task,
            command.now,
            command.requestId,
          );
          if (!projection.ok) return projection;
          const propagated = await propagateBlockerTransition(ctx, {
            blocker: task,
            previousStatus: task.status,
            nextStatus: "open",
            directBlockerCount: projection.actual.total,
            actor: command.actor,
            idempotencyKey: command.idempotencyKey,
            requestId: command.requestId,
            now: command.now,
          });
          if (!propagated.ok) return { ok: false as const, error: propagated.error };
          const ready = derivedReady({
            status: "open",
            availableAt: task.availableAt,
            now: command.now,
            unresolved: projection.actual.unresolved,
            cancelled: projection.actual.cancelled,
          });
          await ctx.db.patch(task._id, {
            status: "open",
            currentClaim: undefined,
            isReady: ready,
            isBlocked: projection.actual.unresolved + projection.actual.cancelled > 0,
            ...(ready ? { readySince: command.now } : { readySince: undefined }),
            needsAttention: projection.actual.cancelled > 0,
            cancelledAt: undefined,
            completedAt: undefined,
            revision: task.revision + 1,
            lastEditedBy: command.actor,
            updatedAt: command.now,
          });
          await ctx.db.patch(usage._id, {
            activeTasks: usage.activeTasks + 1,
            updatedAt: command.now,
          });
          await appendTaskEvent(ctx, {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
            taskId: task._id,
            taskPublicId: task.publicId,
            taskRevision: task.revision + 1,
            type: "task.reopened",
            actor: command.actor,
            command: clientCommand(command),
            payload: {},
            now: command.now,
          });
          const updated = await ctx.db.get(task._id);
          if (updated === null) throw new Error("Human-reopened task disappeared.");
          return await requireHumanTaskDetail(ctx, updated, command.requestId);
        },
      },
    );
  },
});

type ReviewMutationArgs = Readonly<{
  workspaceId: string;
  key: string;
  submissionId: string;
  reviewRevision: number;
  reason?: string;
  idempotencyKey: string;
}>;

async function reviewSubmission(
  ctx: MutationCtx,
  args: ReviewMutationArgs,
  action: "accept" | "reject",
) {
  const requestId = randomRequestId();
  if (!validPublicScope(args)) return domainFailure("VALIDATION_ERROR", requestId);
  const parsed = action === "accept"
    ? acceptTaskRequestSchema.safeParse({
        submissionId: args.submissionId,
        reviewRevision: args.reviewRevision,
      })
    : rejectTaskRequestSchema.safeParse({
        submissionId: args.submissionId,
        reviewRevision: args.reviewRevision,
        reason: args.reason,
      });
  if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
  const operation = action === "accept" ? "tasks.accept" : "tasks.reject";
  const requestDigest = humanTaskMutationDigest(operation, {
    workspaceId: args.workspaceId,
    key: args.key,
    ...parsed.data,
  });
  return await runHumanTaskMutation(
    ctx,
    { ...args, requestDigest, requestId },
    {
      capability: "reviewer",
      hostedAttemptOperation: action === "accept"
        ? "review.accept"
        : "review.reject",
      hostedAttemptTargetTaskKey: args.key,
      hostedAttemptIntent: (binding) =>
        action === "accept"
          ? {
              kind: "review.accept",
              taskId: hostedTargetTaskId(binding),
              submissionId: parsed.data.submissionId,
              expectedReviewRevision: parsed.data.reviewRevision,
            }
          : {
              kind: "review.reject",
              taskId: hostedTargetTaskId(binding),
              submissionId: parsed.data.submissionId,
              expectedReviewRevision: parsed.data.reviewRevision,
              reason: requiredHostedMutationString(args.reason, "reason"),
            },
      operation,
      parseReceipt: parseReview,
      execute: async (command) => {
        const reason =
          "reason" in parsed.data && typeof parsed.data.reason === "string"
            ? parsed.data.reason
            : undefined;
        const reviewed = await reviewSubmissionTransition(ctx, {
          workspaceId: command.authorization.workspace._id,
          key: args.key,
          submissionPublicId: parsed.data.submissionId,
          reviewRevision: parsed.data.reviewRevision,
          action,
          ...(reason === undefined ? {} : { reason }),
          actor: command.actor,
          idempotencyKey: command.idempotencyKey,
          requestId: command.requestId,
          now: command.now,
        });
        return reviewed;
      },
    },
  );
}

const reviewArgs = {
  workspaceId: v.string(),
  key: v.string(),
  submissionId: v.string(),
  reviewRevision: v.number(),
  idempotencyKey: v.string(),
  ...hraMutationControlArgs,
} as const;

export const acceptSubmission = mutation({
  args: reviewArgs,
  returns: reviewResultValidator,
  handler: async (ctx, args) => await reviewSubmission(ctx, args, "accept"),
});

export const rejectSubmission = mutation({
  args: { ...reviewArgs, reason: v.string() },
  returns: reviewResultValidator,
  handler: async (ctx, args) => await reviewSubmission(ctx, args, "reject"),
});
