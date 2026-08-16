import { z } from "@hra-internal/schema";

import {
  dispatchClaimIdSchema,
  dispatchIdSchema,
  runnerBootIdSchema,
  runnerIdSchema,
} from "./dispatch-identifiers";
import { successEnvelopeSchema } from "./errors";
import {
  AGENT_SESSION_HEARTBEAT_MS,
  AGENT_SESSION_IDLE_MS,
  CLAIM_RENEWAL_THRESHOLD_MS,
  DEFAULT_CLAIM_LEASE_MS,
  IDEMPOTENCY_FUTURE_SKEW_MS,
  IDEMPOTENCY_WINDOW_MS,
  agentActorSchema,
  agentIdSchema,
  agentScopeSchema,
  eventActorSchema,
  epochMsSchema,
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_NODES,
  MAX_SUBMISSION_EVIDENCE,
  MAX_TASK_LABELS,
  doneTaskViewSchema,
  organizationIdSchema,
  repositoryIdSchema,
  repositoryNameSchema,
  repositoryProviderSchema,
  reviewReasonSchema,
  submissionEvidenceInputSchema,
  submissionSummarySchema,
  taskCommentBodySchema,
  taskCommentIdSchema,
  taskDescriptionSchema,
  taskEventSchema,
  taskLabelSchema,
  inProgressTaskViewSchema,
  inReviewTaskViewSchema,
  openTaskViewSchema,
  positiveGenerationSchema,
  readyTaskViewSchema,
  taskReferenceIdSchema,
  taskReferenceInputSchema,
  taskReferenceViewSchema,
  taskStatusSchema,
  taskSubmissionIdSchema,
  taskViewSchema,
  taskKeySchema,
  taskPrioritySchema,
  taskTitleSchema,
  taskTypeSchema,
  workspaceRepositoryViewSchema,
  workspaceIdSchema,
} from "./model";
import { credentialTokenSchema, sessionIdSchema, uuidV7Timestamp } from "./tokens";

export const MAX_SERIALIZED_SUBMISSION_CONTENT_BYTES = 400 * 1_024;
export const MAX_SERIALIZED_SUBMISSION_ENVELOPE_BYTES = 512 * 1_024;

export function serializedSubmissionContentByteLength(value: {
  readonly summary: string;
  readonly evidence: readonly unknown[];
}): number {
  return new TextEncoder().encode(
    JSON.stringify({ summary: value.summary, evidence: value.evidence }),
  ).byteLength;
}

function submissionContentIsBounded(value: {
  readonly summary: string;
  readonly evidence: readonly unknown[];
}): boolean {
  return serializedSubmissionContentByteLength(value) <= MAX_SERIALIZED_SUBMISSION_CONTENT_BYTES;
}

export type IdempotencyKeyStatus =
  | { readonly status: "valid"; readonly timestamp: number }
  | { readonly status: "invalid" | "expired" | "future" };

export function classifyIdempotencyKey(value: string, serverNow: number): IdempotencyKeyStatus {
  const timestamp = uuidV7Timestamp(value);
  if (timestamp === null) {
    return { status: "invalid" };
  }
  if (timestamp < serverNow - IDEMPOTENCY_WINDOW_MS) {
    return { status: "expired" };
  }
  if (timestamp > serverNow + IDEMPOTENCY_FUTURE_SKEW_MS) {
    return { status: "future" };
  }
  return { status: "valid", timestamp };
}

export const redeemEnrollmentRequestSchema = z
  .object({
    credential: credentialTokenSchema,
  })
  .strict();
export type RedeemEnrollmentRequest = z.infer<typeof redeemEnrollmentRequestSchema>;

export const redeemEnrollmentResponseSchema = z
  .object({
    agentId: agentIdSchema,
    credentialId: z.string().min(1),
    credentialExpiresAt: epochMsSchema,
    scopes: z.array(agentScopeSchema).min(1),
  })
  .strict();
export type RedeemEnrollmentResponse = z.infer<typeof redeemEnrollmentResponseSchema>;
export const redeemEnrollmentEnvelopeSchema = successEnvelopeSchema(redeemEnrollmentResponseSchema);

export const startSessionRequestSchema = z.object({}).strict();
export const startSessionResponseSchema = z
  .object({
    sessionId: sessionIdSchema,
    expiresAt: epochMsSchema,
  })
  .strict();
export type StartSessionResponse = z.infer<typeof startSessionResponseSchema>;
export const startSessionEnvelopeSchema = successEnvelopeSchema(startSessionResponseSchema);

export const reviewRequestSchema = z
  .object({
    task: inReviewTaskViewSchema,
    submissionId: z.string().min(1).max(128),
    submittedByAgentId: agentIdSchema,
    submittedAt: epochMsSchema,
  })
  .strict();

export const contextResponseSchema = z
  .object({
    principal: z
      .object({
        kind: z.literal("agent"),
        agentId: agentIdSchema,
        name: z.string().min(1).max(120),
        scopes: z.array(agentScopeSchema),
        sessionId: sessionIdSchema,
      })
      .strict(),
    organization: z.object({ id: organizationIdSchema, name: z.string().min(1).max(160) }).strict(),
    workspace: z.object({ id: workspaceIdSchema, slug: z.string().min(1).max(80), name: z.string().min(1).max(160) }).strict(),
    serverTime: epochMsSchema,
    defaults: z
      .object({
        claimLeaseMs: z.literal(DEFAULT_CLAIM_LEASE_MS),
        claimRenewalThresholdMs: z.literal(CLAIM_RENEWAL_THRESHOLD_MS),
        sessionIdleMs: z.literal(AGENT_SESSION_IDLE_MS),
        sessionHeartbeatMs: z.literal(AGENT_SESSION_HEARTBEAT_MS),
      })
      .strict(),
    counts: z
      .object({
        readyTasks: z.number().int().nonnegative().safe(),
        activeClaims: z.number().int().nonnegative().safe(),
        reviewRequests: z.number().int().nonnegative().safe(),
      })
      .strict(),
    readyTasks: z.array(readyTaskViewSchema).max(20),
    activeClaims: z.array(inProgressTaskViewSchema).max(20),
    reviewRequests: z.array(reviewRequestSchema).max(20),
    cursors: z
      .object({
        readyTasks: z.string().nullable(),
        activeClaims: z.string().nullable(),
        reviewRequests: z.string().nullable(),
      })
      .strict(),
    workflowRules: z.array(z.string().min(1).max(500)).min(1).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    value.readyTasks.forEach((task, index) => {
      if (task.availableAt > value.serverTime) {
        context.addIssue({
          code: "custom",
          message: "ready task is not yet available",
          path: ["readyTasks", index, "availableAt"],
        });
      }
      if (task.status === "in_progress" && task.currentClaim.leaseUntil > value.serverTime) {
        context.addIssue({
          code: "custom",
          message: "ready in-progress task must have an expired lease",
          path: ["readyTasks", index, "currentClaim", "leaseUntil"],
        });
      }
    });
  });
export type ContextResponse = z.infer<typeof contextResponseSchema>;
export const contextEnvelopeSchema = successEnvelopeSchema(contextResponseSchema);

export const createTaskRequestSchema = z
  .object({
    title: taskTitleSchema.transform((value) => value.trim()).pipe(taskTitleSchema),
    description: taskDescriptionSchema.optional(),
    type: taskTypeSchema.default("task"),
    priority: taskPrioritySchema.default(2),
    availableAt: epochMsSchema.optional(),
    parentKey: taskKeySchema.optional(),
    labels: z.array(taskLabelSchema).max(MAX_TASK_LABELS).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.labels !== undefined && new Set(value.labels).size !== value.labels.length) {
      context.addIssue({ code: "custom", message: "task labels must be unique", path: ["labels"] });
    }
  });
export type CreateTaskRequest = z.input<typeof createTaskRequestSchema>;

export const createTaskResponseSchema = z.object({ task: openTaskViewSchema }).strict();
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;
export const createTaskEnvelopeSchema = successEnvelopeSchema(createTaskResponseSchema);

const cursorSchema = z.string().min(1).max(8_192);
const queryLimitSchema = z
  .string()
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u, "limit must be a decimal integer from 1 to 100")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));

export const readyTasksQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u, "limit must be a decimal integer from 1 to 100")
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional()
      .transform((value) => value ?? 20),
  })
  .strict();

export function encodeReadyTasksQuery(input: { readonly cursor?: string; readonly limit?: number }): URLSearchParams {
  const query = new URLSearchParams();
  if (input.cursor !== undefined) {
    query.set("cursor", input.cursor);
  }
  if (input.limit !== undefined) {
    query.set("limit", String(input.limit));
  }
  readyTasksQuerySchema.parse(Object.fromEntries(query));
  return query;
}

export const readyTasksResponseSchema = z
  .object({
    tasks: z.array(readyTaskViewSchema).max(100),
    cursor: z.string().nullable(),
  })
  .strict();
export type ReadyTasksResponse = z.infer<typeof readyTasksResponseSchema>;
export const readyTasksEnvelopeSchema = successEnvelopeSchema(readyTasksResponseSchema);

export const claimTaskRequestSchema = z.object({}).strict();
export const claimTaskResponseSchema = z.object({ task: inProgressTaskViewSchema }).strict();
export type ClaimTaskResponse = z.infer<typeof claimTaskResponseSchema>;
export const claimTaskEnvelopeSchema = successEnvelopeSchema(claimTaskResponseSchema);

export const renewClaimRequestSchema = z
  .object({ fence: positiveGenerationSchema })
  .strict();
export const renewClaimResponseSchema = claimTaskResponseSchema;
export type RenewClaimRequest = z.infer<typeof renewClaimRequestSchema>;
export const renewClaimEnvelopeSchema = successEnvelopeSchema(renewClaimResponseSchema);

export const releaseClaimRequestSchema = z
  .object({ fence: positiveGenerationSchema })
  .strict();
export const releaseClaimResponseSchema = z.object({ task: openTaskViewSchema }).strict();
export type ReleaseClaimRequest = z.infer<typeof releaseClaimRequestSchema>;
export const releaseClaimEnvelopeSchema = successEnvelopeSchema(releaseClaimResponseSchema);

export const taskRouteParamsSchema = z.object({ key: taskKeySchema }).strict();

export const taskDetailSchema = z
  .object({
    task: taskViewSchema,
    description: taskDescriptionSchema,
    labels: z.array(taskLabelSchema).max(MAX_TASK_LABELS),
    parentKey: taskKeySchema.optional(),
  })
  .strict();
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const getTaskResponseSchema = taskDetailSchema;
export type GetTaskResponse = z.infer<typeof getTaskResponseSchema>;
export const getTaskEnvelopeSchema = successEnvelopeSchema(getTaskResponseSchema);

export const listTasksQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: queryLimitSchema.optional().transform((value) => value ?? 20),
    status: taskStatusSchema.optional(),
    type: taskTypeSchema.optional(),
    priority: z
      .string()
      .regex(/^[0-4]$/u)
      .transform(Number)
      .pipe(taskPrioritySchema)
      .optional(),
    assigneeAgentId: agentIdSchema.optional(),
    label: taskLabelSchema.optional(),
    parentKey: taskKeySchema.optional(),
    updatedAfter: z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/u)
      .transform(Number)
      .pipe(epochMsSchema)
      .optional(),
  })
  .strict();
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const listTasksResponseSchema = z
  .object({ tasks: z.array(taskViewSchema).max(100), cursor: cursorSchema.nullable() })
  .strict();
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;
export const listTasksEnvelopeSchema = successEnvelopeSchema(listTasksResponseSchema);

export const blockedTasksQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: queryLimitSchema.optional().transform((value) => value ?? 20),
    attentionOnly: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  })
  .strict();
export const blockedTaskViewSchema = z
  .object({ task: taskViewSchema, needsAttention: z.boolean() })
  .strict()
  .superRefine((value, context) => {
    if (value.task.unresolvedBlockerCount + value.task.cancelledBlockerCount === 0) {
      context.addIssue({ code: "custom", message: "blocked task has no blockers", path: ["task"] });
    }
    if (value.task.cancelledBlockerCount > 0 && !value.needsAttention) {
      context.addIssue({
        code: "custom",
        message: "cancelled blockers require attention",
        path: ["needsAttention"],
      });
    }
  });
export const blockedTasksResponseSchema = z
  .object({ tasks: z.array(blockedTaskViewSchema).max(100), cursor: cursorSchema.nullable() })
  .strict();
export type BlockedTasksResponse = z.infer<typeof blockedTasksResponseSchema>;
export const blockedTasksEnvelopeSchema = successEnvelopeSchema(blockedTasksResponseSchema);

export function encodeBlockedTasksQuery(input: {
  readonly cursor?: string;
  readonly limit?: number;
  readonly attentionOnly?: boolean;
}): URLSearchParams {
  const query = new URLSearchParams();
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.attentionOnly !== undefined) query.set("attentionOnly", String(input.attentionOnly));
  blockedTasksQuerySchema.parse(Object.fromEntries(query));
  return query;
}

export const updateTaskRequestSchema = z
  .object({
    revision: positiveGenerationSchema,
    fence: positiveGenerationSchema.optional(),
    title: taskTitleSchema.transform((value) => value.trim()).pipe(taskTitleSchema).optional(),
    description: taskDescriptionSchema.optional(),
    type: taskTypeSchema.optional(),
    priority: taskPrioritySchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.type !== undefined ||
      value.priority !== undefined,
    "at least one task field must be updated",
  );
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
export const taskMutationResponseSchema = taskDetailSchema;
export type TaskMutationResponse = z.infer<typeof taskMutationResponseSchema>;
export const taskMutationEnvelopeSchema = successEnvelopeSchema(taskMutationResponseSchema);

export const cancelTaskRequestSchema = z
  .object({ workspaceId: workspaceIdSchema, revision: positiveGenerationSchema, reason: reviewReasonSchema })
  .strict();
export type CancelTaskRequest = z.infer<typeof cancelTaskRequestSchema>;
export const reopenTaskRequestSchema = z
  .object({ workspaceId: workspaceIdSchema, revision: positiveGenerationSchema })
  .strict();
export type ReopenTaskRequest = z.infer<typeof reopenTaskRequestSchema>;
export const assignTaskRequestSchema = z
  .object({
    revision: positiveGenerationSchema,
    assigneeAgentId: agentIdSchema.nullable(),
    fence: positiveGenerationSchema.optional(),
  })
  .strict();
export type AssignTaskRequest = z.infer<typeof assignTaskRequestSchema>;
export const deferTaskRequestSchema = z
  .object({ revision: positiveGenerationSchema, availableAt: epochMsSchema, fence: positiveGenerationSchema.optional() })
  .strict();
export type DeferTaskRequest = z.infer<typeof deferTaskRequestSchema>;

export const taskLabelMutationRequestSchema = z
  .object({ revision: positiveGenerationSchema, label: taskLabelSchema, fence: positiveGenerationSchema.optional() })
  .strict();
export type TaskLabelMutationRequest = z.infer<typeof taskLabelMutationRequestSchema>;
export const listTaskLabelsResponseSchema = z
  .object({ labels: z.array(taskLabelSchema).max(MAX_TASK_LABELS), revision: positiveGenerationSchema })
  .strict();
export type ListTaskLabelsResponse = z.infer<typeof listTaskLabelsResponseSchema>;
export const listTaskLabelsEnvelopeSchema = successEnvelopeSchema(listTaskLabelsResponseSchema);

export const taskCommentViewSchema = z
  .object({
    id: taskCommentIdSchema,
    body: taskCommentBodySchema,
    actor: eventActorSchema,
    createdAt: epochMsSchema,
  })
  .strict();
export const addTaskCommentRequestSchema = z.object({ body: taskCommentBodySchema }).strict();
export type AddTaskCommentRequest = z.infer<typeof addTaskCommentRequestSchema>;
export const addTaskCommentResponseSchema = z.object({ comment: taskCommentViewSchema }).strict();
export type AddTaskCommentResponse = z.infer<typeof addTaskCommentResponseSchema>;
export const addTaskCommentEnvelopeSchema = successEnvelopeSchema(addTaskCommentResponseSchema);
export const listTaskCommentsQuerySchema = z
  .object({ cursor: cursorSchema.optional(), limit: queryLimitSchema.optional().transform((value) => value ?? 20) })
  .strict();
export const listTaskCommentsResponseSchema = z
  .object({ comments: z.array(taskCommentViewSchema).max(100), cursor: cursorSchema.nullable() })
  .strict();
export type ListTaskCommentsResponse = z.infer<typeof listTaskCommentsResponseSchema>;
export const listTaskCommentsEnvelopeSchema = successEnvelopeSchema(listTaskCommentsResponseSchema);

export const createWorkspaceRepositoryRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    name: repositoryNameSchema,
    provider: repositoryProviderSchema,
    url: workspaceRepositoryViewSchema.shape.url,
  })
  .strict();
export type CreateWorkspaceRepositoryRequest = z.infer<typeof createWorkspaceRepositoryRequestSchema>;
export const workspaceRepositoryResponseSchema = z
  .object({ repository: workspaceRepositoryViewSchema })
  .strict();
export type WorkspaceRepositoryResponse = z.infer<typeof workspaceRepositoryResponseSchema>;
export const workspaceRepositoryEnvelopeSchema = successEnvelopeSchema(workspaceRepositoryResponseSchema);
export const listWorkspaceRepositoriesQuerySchema = z
  .object({
    workspaceId: workspaceIdSchema,
    cursor: cursorSchema.optional(),
    limit: queryLimitSchema.optional().transform((value) => value ?? 20),
  })
  .strict();
export const listWorkspaceRepositoriesResponseSchema = z
  .object({ repositories: z.array(workspaceRepositoryViewSchema).max(100), cursor: cursorSchema.nullable() })
  .strict();
export type ListWorkspaceRepositoriesResponse = z.infer<typeof listWorkspaceRepositoriesResponseSchema>;
export const listWorkspaceRepositoriesEnvelopeSchema = successEnvelopeSchema(
  listWorkspaceRepositoriesResponseSchema,
);
export const removeWorkspaceRepositoryRequestSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export const removeWorkspaceRepositoryResponseSchema = z
  .object({ repositoryId: repositoryIdSchema, removed: z.literal(true) })
  .strict();
export const removeWorkspaceRepositoryEnvelopeSchema = successEnvelopeSchema(
  removeWorkspaceRepositoryResponseSchema,
);

export const addTaskReferenceRequestSchema = z
  .object({ revision: positiveGenerationSchema, reference: taskReferenceInputSchema, fence: positiveGenerationSchema.optional() })
  .strict();
export type AddTaskReferenceRequest = z.infer<typeof addTaskReferenceRequestSchema>;
export const taskReferenceResponseSchema = z
  .object({ reference: taskReferenceViewSchema, task: taskViewSchema })
  .strict();
export type TaskReferenceResponse = z.infer<typeof taskReferenceResponseSchema>;
export const taskReferenceEnvelopeSchema = successEnvelopeSchema(taskReferenceResponseSchema);
export const listTaskReferencesQuerySchema = z
  .object({ cursor: cursorSchema.optional(), limit: queryLimitSchema.optional().transform((value) => value ?? 20) })
  .strict();
export const listTaskReferencesResponseSchema = z
  .object({ references: z.array(taskReferenceViewSchema).max(100), cursor: cursorSchema.nullable() })
  .strict();
export type ListTaskReferencesResponse = z.infer<typeof listTaskReferencesResponseSchema>;
export const listTaskReferencesEnvelopeSchema = successEnvelopeSchema(listTaskReferencesResponseSchema);
export const removeTaskReferenceRequestSchema = z
  .object({ revision: positiveGenerationSchema, fence: positiveGenerationSchema.optional() })
  .strict();
export const removeTaskReferenceResponseSchema = z
  .object({ referenceId: taskReferenceIdSchema, task: taskViewSchema })
  .strict();
export const removeTaskReferenceEnvelopeSchema = successEnvelopeSchema(removeTaskReferenceResponseSchema);

export const taskDependencyViewSchema = z
  .object({
    kind: z.literal("blocks"),
    blockerKey: taskKeySchema,
    blockedKey: taskKeySchema,
    createdAt: epochMsSchema,
  })
  .strict();
export type TaskDependencyView = z.infer<typeof taskDependencyViewSchema>;
export const taskDependencyMutationRequestSchema = z
  .object({ revision: positiveGenerationSchema, blockerKey: taskKeySchema, fence: positiveGenerationSchema.optional() })
  .strict();
export type TaskDependencyMutationRequest = z.infer<typeof taskDependencyMutationRequestSchema>;
export const taskDependencyMutationResponseSchema = z
  .object({ dependency: taskDependencyViewSchema, task: taskViewSchema })
  .strict();
export type TaskDependencyMutationResponse = z.infer<typeof taskDependencyMutationResponseSchema>;
export const taskDependencyMutationEnvelopeSchema = successEnvelopeSchema(
  taskDependencyMutationResponseSchema,
);
export const listTaskDependenciesQuerySchema = z
  .object({
    direction: z.enum(["blockers", "dependents", "both"]).optional().transform((value) => value ?? "both"),
    cursor: cursorSchema.optional(),
    limit: queryLimitSchema.optional().transform((value) => value ?? 20),
  })
  .strict();
export const listTaskDependenciesResponseSchema = z
  .object({ dependencies: z.array(taskDependencyViewSchema).max(100), cursor: cursorSchema.nullable() })
  .strict();
export type ListTaskDependenciesResponse = z.infer<typeof listTaskDependenciesResponseSchema>;
export const listTaskDependenciesEnvelopeSchema = successEnvelopeSchema(
  listTaskDependenciesResponseSchema,
);

export const setTaskParentRequestSchema = z
  .object({ revision: positiveGenerationSchema, parentKey: taskKeySchema, fence: positiveGenerationSchema.optional() })
  .strict();
export type SetTaskParentRequest = z.infer<typeof setTaskParentRequestSchema>;
export const clearTaskParentRequestSchema = z
  .object({ revision: positiveGenerationSchema, fence: positiveGenerationSchema.optional() })
  .strict();
export type ClearTaskParentRequest = z.infer<typeof clearTaskParentRequestSchema>;

export const taskGraphQuerySchema = z
  .object({
    depth: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_GRAPH_DEPTH)),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]{0,2}|[1-4][0-9]{3}|5000)$/u)
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_GRAPH_NODES)),
  })
  .strict();
export const taskGraphResponseSchema = z
  .object({
    rootKey: taskKeySchema,
    nodes: z.array(taskViewSchema).max(MAX_GRAPH_NODES),
    dependencies: z.array(taskDependencyViewSchema).max(10_000),
    truncated: z.boolean(),
  })
  .strict();
export type TaskGraphResponse = z.infer<typeof taskGraphResponseSchema>;
export const taskGraphEnvelopeSchema = successEnvelopeSchema(taskGraphResponseSchema);

export const listTaskEventsQuerySchema = z
  .object({ cursor: cursorSchema.optional(), limit: queryLimitSchema.optional().transform((value) => value ?? 20) })
  .strict();
export const listTaskEventsResponseSchema = z
  .object({ events: z.array(taskEventSchema).max(100), cursor: cursorSchema.nullable() })
  .strict();
export type ListTaskEventsResponse = z.infer<typeof listTaskEventsResponseSchema>;
export const listTaskEventsEnvelopeSchema = successEnvelopeSchema(listTaskEventsResponseSchema);

export const dispatchSubmissionBindingSchema = z
  .object({
    runId: dispatchIdSchema,
    runnerId: runnerIdSchema,
    bootId: runnerBootIdSchema,
    claimId: dispatchClaimIdSchema,
    claimFence: positiveGenerationSchema,
  })
  .strict();
export type DispatchSubmissionBinding = z.infer<typeof dispatchSubmissionBindingSchema>;

export const submitTaskRequestSchema = z
  .object({
    fence: positiveGenerationSchema,
    expectedReviewRevision: positiveGenerationSchema.optional(),
    dispatch: dispatchSubmissionBindingSchema.optional(),
    summary: submissionSummarySchema,
    evidence: z.array(submissionEvidenceInputSchema).min(1).max(MAX_SUBMISSION_EVIDENCE),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dispatch !== undefined && value.dispatch.claimFence !== value.fence) {
      context.addIssue({
        code: "custom",
        message: "dispatch claim fence must equal the task claim fence",
        path: ["dispatch", "claimFence"],
      });
    }
  })
  .refine(submissionContentIsBounded, {
    message: `serialized submission content exceeds ${MAX_SERIALIZED_SUBMISSION_CONTENT_BYTES} bytes`,
    path: ["evidence"],
  });
export type SubmitTaskRequest = z.infer<typeof submitTaskRequestSchema>;
export const submissionStatusSchema = z.enum(["pending", "accepted", "rejected", "cancelled"]);
const taskSubmissionViewBase = {
  id: taskSubmissionIdSchema,
  taskKey: taskKeySchema,
  submittedBy: agentActorSchema,
  reviewRevision: positiveGenerationSchema,
  summary: submissionSummarySchema,
  evidence: z.array(submissionEvidenceInputSchema).min(1).max(MAX_SUBMISSION_EVIDENCE),
  submittedAt: epochMsSchema,
} as const;

export const pendingTaskSubmissionViewSchema = z
  .object({ ...taskSubmissionViewBase, status: z.literal("pending") })
  .strict()
  .refine(submissionContentIsBounded, "serialized submission content exceeds the receipt bound");
export const acceptedTaskSubmissionViewSchema = z
  .object({ ...taskSubmissionViewBase, status: z.literal("accepted"), reviewedAt: epochMsSchema })
  .strict()
  .refine(submissionContentIsBounded, "serialized submission content exceeds the receipt bound")
  .refine((value) => value.reviewedAt >= value.submittedAt, "review precedes submission");
export const rejectedTaskSubmissionViewSchema = z
  .object({
    ...taskSubmissionViewBase,
    status: z.literal("rejected"),
    reviewedAt: epochMsSchema,
    reviewReason: reviewReasonSchema,
  })
  .strict()
  .refine(submissionContentIsBounded, "serialized submission content exceeds the receipt bound")
  .refine((value) => value.reviewedAt >= value.submittedAt, "review precedes submission");
export const cancelledTaskSubmissionViewSchema = z
  .object({
    ...taskSubmissionViewBase,
    status: z.literal("cancelled"),
    cancelledAt: epochMsSchema,
    cancellationReason: reviewReasonSchema,
  })
  .strict()
  .refine(submissionContentIsBounded, "serialized submission content exceeds the receipt bound")
  .refine((value) => value.cancelledAt >= value.submittedAt, "cancellation precedes submission");
export const taskSubmissionViewSchema = z.discriminatedUnion("status", [
  pendingTaskSubmissionViewSchema,
  acceptedTaskSubmissionViewSchema,
  rejectedTaskSubmissionViewSchema,
  cancelledTaskSubmissionViewSchema,
]);
export type TaskSubmissionView = z.infer<typeof taskSubmissionViewSchema>;
export const submitTaskResponseSchema = z
  .object({ task: inReviewTaskViewSchema, submission: pendingTaskSubmissionViewSchema })
  .strict();
export type SubmitTaskResponse = z.infer<typeof submitTaskResponseSchema>;
export const submitTaskEnvelopeSchema = successEnvelopeSchema(submitTaskResponseSchema);

export const reviewQueueQuerySchema = z
  .object({ cursor: cursorSchema.optional(), limit: queryLimitSchema.optional().transform((value) => value ?? 20) })
  .strict();
export const reviewQueueItemSchema = z
  .object({ task: inReviewTaskViewSchema, submission: pendingTaskSubmissionViewSchema })
  .strict();
export const reviewQueueResponseSchema = z
  .object({ reviews: z.array(reviewQueueItemSchema).max(100), cursor: cursorSchema.nullable() })
  .strict();
export type ReviewQueueResponse = z.infer<typeof reviewQueueResponseSchema>;
export const reviewQueueEnvelopeSchema = successEnvelopeSchema(reviewQueueResponseSchema);
export const acceptTaskRequestSchema = z
  .object({ submissionId: taskSubmissionIdSchema, reviewRevision: positiveGenerationSchema })
  .strict();
export type AcceptTaskRequest = z.infer<typeof acceptTaskRequestSchema>;
export const rejectTaskRequestSchema = acceptTaskRequestSchema.extend({ reason: reviewReasonSchema });
export type RejectTaskRequest = z.infer<typeof rejectTaskRequestSchema>;
export const acceptTaskResponseSchema = z
  .object({ task: doneTaskViewSchema, submission: acceptedTaskSubmissionViewSchema })
  .strict();
export const rejectTaskResponseSchema = z
  .object({ task: openTaskViewSchema, submission: rejectedTaskSubmissionViewSchema })
  .strict();
export const reviewTaskResponseSchema = z.union([
  acceptTaskResponseSchema,
  rejectTaskResponseSchema,
]);
export type ReviewTaskResponse = z.infer<typeof reviewTaskResponseSchema>;
export const acceptTaskEnvelopeSchema = successEnvelopeSchema(acceptTaskResponseSchema);
export const rejectTaskEnvelopeSchema = successEnvelopeSchema(rejectTaskResponseSchema);
export const reviewTaskEnvelopeSchema = successEnvelopeSchema(reviewTaskResponseSchema);
