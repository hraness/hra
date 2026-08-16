import {
  addTaskCommentResponseSchema,
  createTaskRequestSchema,
  removeWorkspaceRepositoryResponseSchema,
  removeTaskReferenceResponseSchema,
  reviewReasonSchema,
  reviewTaskResponseSchema,
  submitTaskRequestSchema,
  submitTaskResponseSchema,
  taskDependencyMutationResponseSchema,
  taskMutationResponseSchema,
  taskReferenceResponseSchema,
  workspaceRepositoryResponseSchema,
  type DispatchSubmissionBinding,
  type TaskReferenceInput,
  type TaskReferenceView as ProtocolTaskReferenceView,
  type SubmissionEvidenceInput,
  type TaskView as ProtocolTaskView,
} from "@hraness/agent-tasks-protocol";
import { v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  dispatchSubmissionAuthorityMatches,
  dispatchSubmissionInputRevisionMatches,
} from "./dispatchLaws";
import {
  authorizeAgent,
  touchAuthorizedAgent,
  type AuthorizedAgent,
} from "./authorization";
import {
  assertRequestMetadata,
  domainFailure,
  lookupReceipt,
  randomCrockford,
  randomPublicId,
  storeReceipt,
  parseTaskData,
  taskView,
  type DomainError,
} from "./domain";
import { appendSecurityEvent, appendTaskEvent } from "./events";
import { authorizeWorkspaceHuman } from "./humanAuthorization";
import {
  lookupHumanReceipt,
  storeHumanReceipt,
} from "./humanTenancy";
import {
  domainErrorValidator,
  eventCommandValidator,
  MAX_DEFER_MS,
  MAX_SUBMISSION_EVIDENCE,
  MAX_SUBMISSION_SUMMARY_BYTES,
  MAX_TASK_COMMENT_BYTES,
  MAX_TASK_DESCRIPTION_BYTES,
  publicMetadataValidator,
  repositoryProviderValidator,
  submissionEvidenceValidator,
  taskEventTypeValidator,
  taskStatusValidator,
  taskTypeValidator,
  taskViewValidator,
} from "./model";
import {
  agentRateLimitFailure,
  consumeAuthorizedAgentRateLimit,
} from "./rateLimits";
import type { AuthenticatedAgentRouteClass } from "./rateLimitPolicy";
import {
  activeTaskClaimTupleMatches,
  agentGrantTupleMatches,
  blockerContribution,
  blockerPropagationReadBound,
  claimCommandDisposition,
  derivedNeedsAttention,
  derivedReady,
  dependencyTupleMatches,
  isCredentialFreeHttpsUrl,
  MAX_BLOCKING_DEPENDENTS,
  MAX_DIRECT_BLOCKERS,
  MAX_GRAPH_EXAMINED_EDGES,
  MAX_GRAPH_VISITED_TASKS,
  MAX_PARENT_DEPTH,
  parentTaskTupleMatches,
  reviewAcceptanceAllowed,
  reviewActorAllowed,
  taskMatchesAuthorizedScope,
  taskCancellationDisposition,
  taskScopedRecordMatches,
  transitionBlockerCounters,
  transitionSubmissionLifecycle,
  WORKSPACE_ACTIVE_TASK_LIMIT,
  WORKSPACE_TOTAL_TASK_LIMIT,
} from "./workGraphLaws";

export type ReadCtx = QueryCtx | MutationCtx;
export type TaskDoc = Doc<"tasks">;
export type PersistedActor = Doc<"taskEvents">["actor"];
type TaskReferenceValue = Doc<"taskReferences">["value"];
type SubmissionDoc = Doc<"taskSubmissions">;

function taskMatchesTenant(
  task: Readonly<{ organizationId: string; workspaceId: string }>,
  tenant: Readonly<{ organizationId: string; workspaceId: string }>,
): boolean {
  return taskMatchesAuthorizedScope({
    taskOrganizationId: task.organizationId,
    taskWorkspaceId: task.workspaceId,
    authorizedOrganizationId: tenant.organizationId,
    authorizedWorkspaceId: tenant.workspaceId,
  });
}

function taskRelationMatches(
  task: Readonly<{ _id: string; organizationId: string; workspaceId: string }>,
  relation: Readonly<{ organizationId: string; workspaceId: string; taskId: string }>,
): boolean {
  return taskScopedRecordMatches({
    taskOrganizationId: task.organizationId,
    taskWorkspaceId: task.workspaceId,
    taskId: task._id,
    recordOrganizationId: relation.organizationId,
    recordWorkspaceId: relation.workspaceId,
    recordTaskId: relation.taskId,
  });
}

function parentRelationMatches(
  task: Readonly<{
    organizationId: string;
    workspaceId: string;
    parentTaskId?: string;
  }>,
  parent: Readonly<{ _id: string; organizationId: string; workspaceId: string }>,
): boolean {
  return task.parentTaskId !== undefined && parentTaskTupleMatches({
    taskOrganizationId: task.organizationId,
    taskWorkspaceId: task.workspaceId,
    taskParentTaskId: task.parentTaskId,
    parentOrganizationId: parent.organizationId,
    parentWorkspaceId: parent.workspaceId,
    parentTaskId: parent._id,
  });
}

function dependencyMatchesTasks(
  dependency: Readonly<{
    organizationId: string;
    workspaceId: string;
    blockerTaskId: string;
    blockedTaskId: string;
    kind: string;
  }>,
  blocker: Readonly<{ _id: string; organizationId: string; workspaceId: string }>,
  blocked: Readonly<{ _id: string; organizationId: string; workspaceId: string }>,
): boolean {
  return dependency.kind === "blocks" && dependencyTupleMatches({
    dependencyOrganizationId: dependency.organizationId,
    dependencyWorkspaceId: dependency.workspaceId,
    dependencyBlockerTaskId: dependency.blockerTaskId,
    dependencyBlockedTaskId: dependency.blockedTaskId,
    blockerOrganizationId: blocker.organizationId,
    blockerWorkspaceId: blocker.workspaceId,
    blockerTaskId: blocker._id,
    blockedOrganizationId: blocked.organizationId,
    blockedWorkspaceId: blocked.workspaceId,
    blockedTaskId: blocked._id,
  });
}

function activeAssigneeGrantMatches(
  tenant: Readonly<{ organizationId: string; workspaceId: string }>,
  agent: Readonly<{ _id: string; organizationId: string; status: string }>,
  grant: Readonly<{
    agentId: string;
    organizationId: string;
    workspaceId: string;
    status: string;
  }>,
): boolean {
  return agent.status === "active" &&
    grant.status === "active" &&
    agentGrantTupleMatches({
      authorizedOrganizationId: tenant.organizationId,
      authorizedWorkspaceId: tenant.workspaceId,
      agentId: agent._id,
      agentOrganizationId: agent.organizationId,
      grantAgentId: grant.agentId,
      grantOrganizationId: grant.organizationId,
      grantWorkspaceId: grant.workspaceId,
    });
}

const PAGE_LIMIT = 100;
const MAX_TASK_LABELS = 50;
const REVIEW_REPAIR_BATCH_SIZE = 64;
const REVIEW_REPAIR_CANCELLATION_REASON =
  "Cancelled by projection repair because the pending submission no longer matched a reviewable task revision.";

const actorViewValidator = v.union(
  v.object({ kind: v.literal("human"), userId: v.string() }),
  v.object({ kind: v.literal("agent"), agentId: v.string() }),
  v.object({
    kind: v.literal("system"),
    jobKind: v.union(
      v.literal("claim_expiry"),
      v.literal("defer_wake"),
      v.literal("repair"),
      v.literal("reconciliation"),
    ),
  }),
);

const commentViewValidator = v.object({
  id: v.string(),
  body: v.string(),
  actor: actorViewValidator,
  createdAt: v.number(),
});

const repositoryViewValidator = v.object({
  id: v.string(),
  name: v.string(),
  provider: repositoryProviderValidator,
  url: v.string(),
  createdAt: v.number(),
});

const referenceViewValidator = v.union(
  v.object({ id: v.string(), createdAt: v.number(), kind: v.literal("repository"), repositoryId: v.string() }),
  v.object({
    id: v.string(),
    createdAt: v.number(),
    kind: v.literal("pull_request"),
    url: v.string(),
    repositoryId: v.optional(v.string()),
  }),
  v.object({
    id: v.string(),
    createdAt: v.number(),
    kind: v.literal("commit"),
    sha: v.string(),
    repositoryId: v.optional(v.string()),
    url: v.optional(v.string()),
  }),
  v.object({
    id: v.string(),
    createdAt: v.number(),
    kind: v.literal("artifact"),
    name: v.string(),
    url: v.string(),
  }),
  v.object({
    id: v.string(),
    createdAt: v.number(),
    kind: v.literal("url"),
    label: v.string(),
    url: v.string(),
  }),
);
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

const submittedByViewValidator = v.object({
  kind: v.literal("agent"),
  agentId: v.string(),
});

const submissionViewBase = {
  id: v.string(),
  taskKey: v.string(),
  submittedBy: submittedByViewValidator,
  reviewRevision: v.number(),
  summary: v.string(),
  evidence: v.array(submissionEvidenceValidator),
  submittedAt: v.number(),
} as const;

const submissionViewValidator = v.union(
  v.object({ ...submissionViewBase, status: v.literal("pending") }),
  v.object({ ...submissionViewBase, status: v.literal("accepted"), reviewedAt: v.number() }),
  v.object({
    ...submissionViewBase,
    status: v.literal("rejected"),
    reviewedAt: v.number(),
    reviewReason: v.string(),
  }),
  v.object({
    ...submissionViewBase,
    status: v.literal("cancelled"),
    cancelledAt: v.number(),
    cancellationReason: v.string(),
  }),
);

const dependencyViewValidator = v.object({
  kind: v.literal("blocks"),
  blockerKey: v.string(),
  blockedKey: v.string(),
  createdAt: v.number(),
});

const taskEventViewValidator = v.object({
  id: v.string(),
  organizationId: v.string(),
  workspaceId: v.string(),
  taskId: v.string(),
  taskRevision: v.number(),
  schemaVersion: v.literal(1),
  type: taskEventTypeValidator,
  actor: actorViewValidator,
  command: eventCommandValidator,
  payload: publicMetadataValidator,
  createdAt: v.number(),
});

function resultValidator<Data extends Parameters<typeof v.object>[0]>(data: Data) {
  return v.union(
    v.object({ ok: v.literal(true), data: v.object(data), requestId: v.string() }),
    v.object({ ok: v.literal(false), error: domainErrorValidator }),
  );
}

export const taskResultValidator = resultValidator({ task: taskViewValidator });
export const taskDetailResultValidator = resultValidator({
  task: taskViewValidator,
  description: v.string(),
  labels: v.array(v.string()),
  parentKey: v.optional(v.string()),
});
const taskListResultValidator = resultValidator({
  tasks: v.array(taskViewValidator),
  cursor: v.union(v.string(), v.null()),
});
const blockedListResultValidator = resultValidator({
  tasks: v.array(v.object({ task: taskViewValidator, needsAttention: v.boolean() })),
  cursor: v.union(v.string(), v.null()),
});
const labelListResultValidator = resultValidator({ labels: v.array(v.string()), revision: v.number() });
export const commentResultValidator = resultValidator({ comment: commentViewValidator });
const commentListResultValidator = resultValidator({
  comments: v.array(commentViewValidator),
  cursor: v.union(v.string(), v.null()),
});
const repositoryResultValidator = resultValidator({ repository: repositoryViewValidator });
const repositoryListResultValidator = resultValidator({
  repositories: v.array(repositoryViewValidator),
  cursor: v.union(v.string(), v.null()),
});
const repositoryRemoveResultValidator = resultValidator({
  repositoryId: v.string(),
  removed: v.literal(true),
});
export const referenceResultValidator = resultValidator({
  reference: referenceViewValidator,
  task: taskViewValidator,
});
const referenceListResultValidator = resultValidator({
  references: v.array(referenceViewValidator),
  cursor: v.union(v.string(), v.null()),
});
export const referenceRemoveResultValidator = resultValidator({
  referenceId: v.string(),
  task: taskViewValidator,
});
export const dependencyResultValidator = resultValidator({
  dependency: dependencyViewValidator,
  task: taskViewValidator,
});
const dependencyListResultValidator = resultValidator({
  dependencies: v.array(dependencyViewValidator),
  cursor: v.union(v.string(), v.null()),
});
const graphResultValidator = resultValidator({
  rootKey: v.string(),
  nodes: v.array(taskViewValidator),
  dependencies: v.array(dependencyViewValidator),
  truncated: v.boolean(),
});
const eventListResultValidator = resultValidator({
  events: v.array(taskEventViewValidator),
  cursor: v.union(v.string(), v.null()),
});
const submitResultValidator = resultValidator({
  task: taskViewValidator,
  submission: submissionViewValidator,
});
const reviewQueueResultValidator = resultValidator({
  reviews: v.array(v.object({ task: taskViewValidator, submission: submissionViewValidator })),
  cursor: v.union(v.string(), v.null()),
});
export const reviewResultValidator = resultValidator({
  task: taskViewValidator,
  submission: submissionViewValidator,
});

function receiptIdentity(authorization: AuthorizedAgent) {
  return {
    kind: "agent" as const,
    publicId: authorization.agentPublicId,
    organizationId: authorization.organizationId,
    workspaceId: authorization.workspaceId,
  };
}

async function consumeAgentWriteRateLimit(
  ctx: MutationCtx,
  authorization: AuthorizedAgent,
  routeClass: Exclude<AuthenticatedAgentRouteClass, "agent_read">,
  requestId: string,
  now: number,
) {
  return agentRateLimitFailure(
    await consumeAuthorizedAgentRateLimit(ctx, {
      authorization,
      routeClass,
      requestId,
      now,
    }),
    requestId,
  );
}

function agentActor(
  authorization: AuthorizedAgent,
): Extract<PersistedActor, { readonly kind: "agent" }> {
  return {
    kind: "agent",
    agentId: authorization.agentPublicId,
    credentialId: authorization.credentialPublicId,
    sessionId: authorization.sessionPublicId,
  };
}

function publicActor(actor: PersistedActor) {
  if (actor.kind === "human") return actor;
  if (actor.kind === "agent") return { kind: "agent" as const, agentId: actor.agentId };
  return { kind: "system" as const, jobKind: actor.jobKind };
}

export async function taskByKey(ctx: ReadCtx, workspaceId: Id<"workspaces">, key: string) {
  return await ctx.db
    .query("tasks")
    .withIndex("by_workspace_and_key", (query) =>
      query.eq("workspaceId", workspaceId).eq("key", key),
    )
    .unique();
}

export type TaskDetailData = {
  readonly task: Infer<typeof taskViewValidator>;
  readonly description: string;
  readonly labels: string[];
  readonly parentKey?: string;
};

export async function taskDetail(ctx: ReadCtx, task: TaskDoc): Promise<TaskDetailData | null> {
  const [body, labels, parent] = await Promise.all([
    ctx.db
      .query("taskBodies")
      .withIndex("by_workspace_and_task", (query) =>
        query.eq("workspaceId", task.workspaceId).eq("taskId", task._id),
      )
      .unique(),
    ctx.db
      .query("taskLabels")
      .withIndex("by_workspace_task_created", (query) =>
        query.eq("workspaceId", task.workspaceId).eq("taskId", task._id),
      )
      .take(MAX_TASK_LABELS + 1),
    task.parentTaskId === undefined ? null : ctx.db.get(task.parentTaskId),
  ]);
  if (
    (body !== null && !taskRelationMatches(task, body)) ||
    labels.length > MAX_TASK_LABELS ||
    labels.some((label) => !taskRelationMatches(task, label)) ||
    (task.parentTaskId !== undefined &&
      (parent === null || !parentRelationMatches(task, parent)))
  ) {
    return null;
  }
  const base = {
    task: taskView(task),
    description: body?.description ?? "",
    labels: labels.map((label) => label.label).sort(),
  };
  return parent === null
    ? base
    : { ...base, parentKey: parent.key };
}

function parseWithSchema<Data>(schema: {
  safeParse(value: unknown): { readonly success: boolean; readonly data?: Data };
}) {
  return (value: unknown): Data | null => {
    const parsed = schema.safeParse(value);
    return parsed.success && parsed.data !== undefined ? parsed.data : null;
  };
}

function normalizeTaskView(view: ProtocolTaskView): Infer<typeof taskViewValidator> {
  const base = {
    id: view.id,
    key: view.key,
    title: view.title,
    type: view.type,
    priority: view.priority,
    availableAt: view.availableAt,
    isReady: view.isReady,
    unresolvedBlockerCount: view.unresolvedBlockerCount,
    cancelledBlockerCount: view.cancelledBlockerCount,
    revision: view.revision,
    reviewRevision: view.reviewRevision,
    ...(view.assigneeAgentId === undefined ? {} : { assigneeAgentId: view.assigneeAgentId }),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
  if (view.status === "in_progress") {
    return { ...base, status: "in_progress", currentClaim: view.currentClaim };
  }
  if (view.status === "open") return { ...base, status: "open" };
  if (view.status === "in_review") return { ...base, status: "in_review" };
  if (view.status === "done") return { ...base, status: "done" };
  return { ...base, status: "cancelled" };
}

export function parseTaskMutationData(value: unknown): TaskDetailData | null {
  const parsed = taskMutationResponseSchema.safeParse(value);
  if (!parsed.success) return null;
  const base = {
    task: normalizeTaskView(parsed.data.task),
    description: parsed.data.description,
    labels: [...parsed.data.labels],
  };
  return parsed.data.parentKey === undefined
    ? base
    : { ...base, parentKey: parsed.data.parentKey };
}

type ReferenceData = {
  readonly reference: Infer<typeof referenceViewValidator>;
  readonly task: Infer<typeof taskViewValidator>;
};

function normalizeReferenceView(
  reference: ProtocolTaskReferenceView,
): Infer<typeof referenceViewValidator> {
  if (reference.kind === "repository") return reference;
  if (reference.kind === "pull_request") {
    return reference.repositoryId === undefined
      ? { id: reference.id, createdAt: reference.createdAt, kind: reference.kind, url: reference.url }
      : {
          id: reference.id,
          createdAt: reference.createdAt,
          kind: reference.kind,
          url: reference.url,
          repositoryId: reference.repositoryId,
        };
  }
  if (reference.kind === "commit") {
    return {
      id: reference.id,
      createdAt: reference.createdAt,
      kind: reference.kind,
      sha: reference.sha,
      ...(reference.repositoryId === undefined ? {} : { repositoryId: reference.repositoryId }),
      ...(reference.url === undefined ? {} : { url: reference.url }),
    };
  }
  return reference;
}

export function parseReferenceData(value: unknown): ReferenceData | null {
  const parsed = taskReferenceResponseSchema.safeParse(value);
  return parsed.success
    ? {
        reference: normalizeReferenceView(parsed.data.reference),
        task: normalizeTaskView(parsed.data.task),
      }
    : null;
}

type RemovedReferenceData = {
  readonly referenceId: string;
  readonly task: Infer<typeof taskViewValidator>;
};

export function parseRemovedReferenceData(value: unknown): RemovedReferenceData | null {
  const parsed = removeTaskReferenceResponseSchema.safeParse(value);
  return parsed.success
    ? { referenceId: parsed.data.referenceId, task: normalizeTaskView(parsed.data.task) }
    : null;
}

type SubmissionView = Infer<typeof submissionViewValidator>;
type SubmissionMutationData = {
  readonly task: Infer<typeof taskViewValidator>;
  readonly submission: SubmissionView;
};

function normalizeSubmissionEvidence(
  evidence: readonly SubmissionEvidenceInput[],
): Infer<typeof submissionEvidenceValidator>[] {
  return evidence.map((item) =>
    item.kind === "commit"
      ? {
          kind: "commit" as const,
          sha: item.sha,
          ...(item.url === undefined ? {} : { url: item.url }),
        }
      : item,
  );
}

function submissionView(submission: SubmissionDoc, taskKey: string): SubmissionView {
  const base = {
    id: submission.publicId,
    taskKey,
    submittedBy: { kind: "agent" as const, agentId: submission.submittedBy.agentId },
    reviewRevision: submission.reviewRevision,
    summary: submission.summary,
    evidence: normalizeSubmissionEvidence(submission.evidence),
    submittedAt: submission.submittedAt,
  };
  if (submission.status === "pending") return { ...base, status: "pending" };
  if (submission.status === "accepted") {
    return { ...base, status: "accepted", reviewedAt: submission.reviewedAt };
  }
  if (submission.status === "rejected") {
    return {
      ...base,
      status: "rejected",
      reviewedAt: submission.reviewedAt,
      reviewReason: submission.reviewReason,
    };
  }
  return {
    ...base,
    status: "cancelled",
    cancelledAt: submission.cancelledAt,
    cancellationReason: submission.cancellationReason,
  };
}

function normalizeSubmissionData(value: {
  readonly task: ProtocolTaskView;
  readonly submission: {
    readonly id: string;
    readonly taskKey: string;
    readonly submittedBy: { readonly kind: string; readonly agentId?: string };
    readonly reviewRevision: number;
    readonly summary: string;
    readonly evidence: readonly SubmissionEvidenceInput[];
    readonly status: "pending" | "accepted" | "rejected" | "cancelled";
    readonly submittedAt: number;
    readonly reviewedAt?: number;
    readonly reviewReason?: string;
    readonly cancelledAt?: number;
    readonly cancellationReason?: string;
  };
}): SubmissionMutationData | null {
  const submission = value.submission;
  if (submission.submittedBy.kind !== "agent" || submission.submittedBy.agentId === undefined) {
    return null;
  }
  const base = {
    id: submission.id,
    taskKey: submission.taskKey,
    submittedBy: { kind: "agent" as const, agentId: submission.submittedBy.agentId },
    reviewRevision: submission.reviewRevision,
    summary: submission.summary,
    evidence: normalizeSubmissionEvidence(submission.evidence),
    submittedAt: submission.submittedAt,
  };
  let normalized: SubmissionView;
  if (submission.status === "pending") normalized = { ...base, status: "pending" };
  else if (submission.status === "accepted" && submission.reviewedAt !== undefined) {
    normalized = { ...base, status: "accepted", reviewedAt: submission.reviewedAt };
  } else if (
    submission.status === "rejected" &&
    submission.reviewedAt !== undefined &&
    submission.reviewReason !== undefined
  ) {
    normalized = {
      ...base,
      status: "rejected",
      reviewedAt: submission.reviewedAt,
      reviewReason: submission.reviewReason,
    };
  } else if (
    submission.status === "cancelled" &&
    submission.cancelledAt !== undefined &&
    submission.cancellationReason !== undefined
  ) {
    normalized = {
      ...base,
      status: "cancelled",
      cancelledAt: submission.cancelledAt,
      cancellationReason: submission.cancellationReason,
    };
  } else {
    return null;
  }
  return { task: normalizeTaskView(value.task), submission: normalized };
}

function parseSubmitData(value: unknown): SubmissionMutationData | null {
  const parsed = submitTaskResponseSchema.safeParse(value);
  return parsed.success ? normalizeSubmissionData(parsed.data) : null;
}

export function parseReviewData(value: unknown): SubmissionMutationData | null {
  const parsed = reviewTaskResponseSchema.safeParse(value);
  return parsed.success ? normalizeSubmissionData(parsed.data) : null;
}

type DependencyData = {
  readonly dependency: Infer<typeof dependencyViewValidator>;
  readonly task: Infer<typeof taskViewValidator>;
};

export function parseDependencyData(value: unknown): DependencyData | null {
  const parsed = taskDependencyMutationResponseSchema.safeParse(value);
  return parsed.success
    ? { dependency: parsed.data.dependency, task: normalizeTaskView(parsed.data.task) }
    : null;
}

function validPage(limit: number, cursor: string | undefined): boolean {
  return (
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= PAGE_LIMIT &&
    (cursor === undefined || (cursor.length >= 1 && cursor.length <= 8_192))
  );
}

function nextCursor(page: { readonly isDone: boolean; readonly continueCursor: string }): string | null {
  return page.isDone ? null : page.continueCursor;
}

function specFailure(
  task: TaskDoc,
  authorization: AuthorizedAgent,
  fence: number | undefined,
  now: number,
  requestId: string,
): { readonly ok: true } | { readonly ok: false; readonly error: DomainError } {
  if (task.status === "in_review") {
    return domainFailure("TASK_IN_REVIEW", requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  if (task.status === "open" && task.currentClaim === undefined) return { ok: true };
  if (task.status !== "in_progress" || task.currentClaim === undefined) {
    return domainFailure("TASK_STATE_CONFLICT", requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  if (task.currentClaim.agentId !== authorization.agentId) {
    return domainFailure("CLAIM_NOT_OWNED", requestId, {
      taskKey: task.key,
      fence: fence ?? task.currentClaim.fence,
    });
  }
  if (fence === undefined || fence !== task.currentClaim.fence || task.currentClaim.leaseUntil <= now) {
    return domainFailure("CLAIM_STALE", requestId, {
      taskKey: task.key,
      fence: task.currentClaim.fence,
      currentRevision: task.revision,
    });
  }
  return { ok: true };
}

export function claimHasTaskOwnership(
  task: TaskDoc,
  claim: Doc<"taskClaims">,
): boolean {
  return taskScopedRecordMatches({
    taskOrganizationId: task.organizationId,
    taskWorkspaceId: task.workspaceId,
    taskId: task._id,
    recordOrganizationId: claim.organizationId,
    recordWorkspaceId: claim.workspaceId,
    recordTaskId: claim.taskId,
  });
}

export function submissionHasTaskOwnership(
  task: TaskDoc,
  submission: Doc<"taskSubmissions">,
): boolean {
  return taskScopedRecordMatches({
    taskOrganizationId: task.organizationId,
    taskWorkspaceId: task.workspaceId,
    taskId: task._id,
    recordOrganizationId: submission.organizationId,
    recordWorkspaceId: submission.workspaceId,
    recordTaskId: submission.taskId,
  });
}

export function activeClaimMatchesTask(
  task: TaskDoc,
  claim: Doc<"taskClaims"> | null,
): claim is Doc<"taskClaims"> {
  const compact = task.currentClaim;
  if (compact === undefined || claim === null) return false;
  return activeTaskClaimTupleMatches({
    taskStatus: task.status,
    taskOrganizationId: task.organizationId,
    taskWorkspaceId: task.workspaceId,
    taskId: task._id,
    compactClaimId: compact.claimId,
    compactClaimPublicId: compact.publicId,
    compactAgentId: compact.agentId,
    compactAgentPublicId: compact.agentPublicId,
    compactFence: compact.fence,
    compactLeaseGeneration: compact.leaseGeneration,
    compactLeaseUntil: compact.leaseUntil,
    claimId: claim._id,
    claimOrganizationId: claim.organizationId,
    claimWorkspaceId: claim.workspaceId,
    claimTaskId: claim.taskId,
    claimPublicId: claim.publicId,
    claimAgentId: claim.agentId,
    claimAgentPublicId: claim.agentPublicId,
    claimState: claim.state,
    claimFence: claim.fence,
    claimLeaseGeneration: claim.leaseGeneration,
    claimLeaseUntil: claim.leaseUntil,
  });
}

const DISPATCH_BOUND_SUBMISSION_PHASES = [
  "leased",
  "provisioning",
  "starting",
  "running",
  "waiting",
  "cancel_requested",
  "ambiguous",
] as const;

async function taskClaimDispatchState(
  ctx: MutationCtx,
  task: TaskDoc,
  claim: Doc<"taskClaims">,
): Promise<"none" | "bound" | "corrupt"> {
  const phasePages = await Promise.all(
    DISPATCH_BOUND_SUBMISSION_PHASES.map(async (phase) =>
      await ctx.db
        .query("taskDispatches")
        .withIndex("by_workspace_task_phase", (query) =>
          query
            .eq("workspaceId", task.workspaceId)
            .eq("taskId", task._id)
            .eq("phase", phase),
        )
        .take(2),
    ),
  );
  if (phasePages.some((page) => page.length > 1)) return "corrupt";
  const active = phasePages.flat();
  if (active.length === 0) return "none";
  const dispatch = active[0];
  if (
    active.length !== 1 ||
    dispatch === undefined ||
    !("taskClaimId" in dispatch) ||
    dispatch.organizationId !== task.organizationId ||
    dispatch.workspaceId !== task.workspaceId ||
    dispatch.taskId !== task._id ||
    dispatch.taskClaimId !== claim._id ||
    dispatch.taskClaimPublicId !== claim.publicId ||
    dispatch.claimFence !== claim.fence
  ) {
    return "corrupt";
  }
  return "bound";
}

async function dispatchSubmissionAuthorityState(
  ctx: MutationCtx,
  authorization: AuthorizedAgent,
  task: TaskDoc,
  claim: Doc<"taskClaims">,
  binding: DispatchSubmissionBinding,
  now: number,
): Promise<"current" | "stale" | "corrupt"> {
  const [dispatches, runners, authorities] = await Promise.all([
    ctx.db
      .query("taskDispatches")
      .withIndex("by_public_id", (query) => query.eq("publicId", binding.runId))
      .take(2),
    ctx.db
      .query("dispatchRunners")
      .withIndex("by_public_id", (query) => query.eq("publicId", binding.runnerId))
      .take(2),
    ctx.db
      .query("dispatchRunnerAuthorities")
      .withIndex("by_workspace", (query) => query.eq("workspaceId", task.workspaceId))
      .take(2),
  ]);
  if (dispatches.length > 1 || runners.length > 1 || authorities.length > 1) {
    return "corrupt";
  }
  const dispatch = dispatches[0];
  const runner = runners[0];
  const authority = authorities[0];
  if (dispatch === undefined || runner === undefined || authority === undefined) {
    return "stale";
  }
  if (!("runnerId" in dispatch)) return "stale";
  return dispatchSubmissionAuthorityMatches({
    now,
    authorization: {
      organizationId: authorization.organizationId,
      workspaceId: authorization.workspaceId,
      agentId: authorization.agentId,
    },
    request: binding,
    task: {
      id: task._id,
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
    },
    claim: {
      id: claim._id,
      organizationId: claim.organizationId,
      workspaceId: claim.workspaceId,
      taskId: claim.taskId,
      agentId: claim.agentId,
      publicId: claim.publicId,
      fence: claim.fence,
      state: claim.state,
      leaseUntil: claim.leaseUntil,
    },
    dispatch: {
      publicId: dispatch.publicId,
      organizationId: dispatch.organizationId,
      workspaceId: dispatch.workspaceId,
      taskId: dispatch.taskId,
      runnerId: dispatch.runnerId,
      runnerPublicId: dispatch.runnerPublicId,
      bootId: dispatch.bootId,
      bootGeneration: dispatch.bootGeneration,
      taskClaimId: dispatch.taskClaimId,
      taskClaimPublicId: dispatch.taskClaimPublicId,
      claimFence: dispatch.claimFence,
      leaseUntil: dispatch.leaseUntil,
      phase: dispatch.phase,
    },
    runner: {
      id: runner._id,
      organizationId: runner.organizationId,
      workspaceId: runner.workspaceId,
      agentId: runner.agentId,
      publicId: runner.publicId,
      installationId: runner.installationId,
      bootId: runner.bootId,
      bootGeneration: runner.bootGeneration,
      leaseUntil: runner.leaseUntil,
    },
    authority: {
      organizationId: authority.organizationId,
      workspaceId: authority.workspaceId,
      runnerId: authority.runnerId,
      runnerPublicId: authority.runnerPublicId,
      installationId: authority.installationId,
      generation: authority.generation,
      leaseUntil: authority.leaseUntil,
    },
  })
    ? "current"
    : "stale";
}

async function closeRecentOwnedActiveClaims(
  ctx: MutationCtx,
  task: TaskDoc,
  state: "expired" | "submitted",
  now: number,
): Promise<void> {
  const recentOwnedClaims = await ctx.db
    .query("taskClaims")
    .withIndex("by_workspace_task_state", (builder) =>
      builder
        .eq("workspaceId", task.workspaceId)
        .eq("taskId", task._id)
        .eq("state", "active"),
    )
    .order("desc")
    .take(101);
  for (const ownedClaim of recentOwnedClaims) {
    if (ownedClaim.state === "active" && claimHasTaskOwnership(task, ownedClaim)) {
      await ctx.db.patch(ownedClaim._id, { state, endedAt: now, updatedAt: now });
    }
  }
}

export async function activeWorkspaceUsage(
  ctx: MutationCtx,
  scope: { readonly organizationId: Id<"organizations">; readonly workspaceId: Id<"workspaces"> },
) {
  return await ctx.db
    .query("workspaceUsage")
    .withIndex("by_workspace", (query) => query.eq("workspaceId", scope.workspaceId))
    .unique();
}

export async function ensureWorkspaceLabel(
  ctx: MutationCtx,
  authorization: {
    readonly organizationId: Id<"organizations">;
    readonly workspaceId: Id<"workspaces">;
  },
  label: string,
  now: number,
) {
  const existing = await ctx.db
    .query("workspaceLabels")
    .withIndex("by_workspace_and_name", (query) =>
      query.eq("workspaceId", authorization.workspaceId).eq("name", label),
    )
    .unique();
  if (existing !== null) {
    return existing.organizationId === authorization.organizationId &&
      existing.workspaceId === authorization.workspaceId &&
      existing.name === label
      ? existing
      : null;
  }
  const labelId = await ctx.db.insert("workspaceLabels", {
    organizationId: authorization.organizationId,
    workspaceId: authorization.workspaceId,
    name: label,
    createdAt: now,
  });
  const created = await ctx.db.get(labelId);
  if (created === null) throw new Error("Workspace label disappeared during creation.");
  return created;
}

export async function validateParentChain(
  ctx: ReadCtx,
  taskId: Id<"tasks"> | null,
  parent: TaskDoc,
): Promise<"valid" | "cycle" | "limit" | "projection_mismatch"> {
  let current: TaskDoc = parent;
  for (let depth = 1; depth <= MAX_PARENT_DEPTH; depth += 1) {
    if (taskId !== null && current._id === taskId) return "cycle";
    if (current.parentTaskId === undefined) return "valid";
    if (depth === MAX_PARENT_DEPTH) return "limit";
    const next: TaskDoc | null = await ctx.db.get(current.parentTaskId);
    if (next === null || !parentRelationMatches(current, next)) return "projection_mismatch";
    current = next;
  }
  return "limit";
}

export const createTask = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    type: taskTypeValidator,
    priority: v.number(),
    availableAt: v.optional(v.number()),
    parentKey: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const parsed = createTaskRequestSchema.safeParse({
      title: args.title,
      ...(args.description === undefined ? {} : { description: args.description }),
      type: args.type,
      priority: args.priority,
      ...(args.availableAt === undefined ? {} : { availableAt: args.availableAt }),
      ...(args.parentKey === undefined ? {} : { parentKey: args.parentKey }),
      ...(args.labels === undefined ? {} : { labels: args.labels }),
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:create",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = await consumeAgentWriteRateLimit(
      ctx,
      authorization.authorization,
      "agent_write",
      args.requestId,
      now,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseTaskData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const availableAt = parsed.data.availableAt ?? now;
    if (availableAt > now + MAX_DEFER_MS) return domainFailure("DEFER_HORIZON", args.requestId);
    const usage = await activeWorkspaceUsage(ctx, authorization.authorization);
    if (usage === null) return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
    if (
      usage.activeTasks >= WORKSPACE_ACTIVE_TASK_LIMIT ||
      usage.totalTasks >= WORKSPACE_TOTAL_TASK_LIMIT
    ) {
      return domainFailure("WORKSPACE_TASK_LIMIT", args.requestId);
    }
    const workspace = await ctx.db.get(authorization.authorization.workspaceId);
    if (
      workspace === null ||
      workspace.organizationId !== authorization.authorization.organizationId
    ) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    let parent: TaskDoc | null = null;
    if (parsed.data.parentKey !== undefined) {
      parent = await taskByKey(ctx, workspace._id, parsed.data.parentKey);
      if (parent === null) return domainFailure("NOT_FOUND", args.requestId);
      if (!taskMatchesTenant(parent, authorization.authorization)) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      const parentValidation = await validateParentChain(ctx, null, parent);
      if (parentValidation === "limit") {
        return domainFailure("GRAPH_VALIDATION_LIMIT", args.requestId, {
          taskKey: parent.key,
          currentRevision: parent.revision,
          exhaustedLimit: "parent_depth",
        });
      }
      if (parentValidation === "projection_mismatch") {
        await queueTaskProjectionRepair(ctx, parent, now);
        return domainFailure("PROJECTION_MISMATCH", args.requestId, {
          taskKey: parent.key,
          currentRevision: parent.revision,
        });
      }
      if (parentValidation === "cycle") return domainFailure("HIERARCHY_CYCLE", args.requestId);
    }
    let key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
    for (let attempt = 0; attempt < 5 && (await taskByKey(ctx, workspace._id, key)) !== null; attempt += 1) {
      key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
    }
    if ((await taskByKey(ctx, workspace._id, key)) !== null) {
      return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
    }
    const actor = agentActor(authorization.authorization);
    const isReady = availableAt <= now;
    const taskPublicId = randomPublicId("tsk");
    const taskId = await ctx.db.insert("tasks", {
      organizationId: authorization.authorization.organizationId,
      workspaceId: workspace._id,
      publicId: taskPublicId,
      key,
      title: parsed.data.title,
      type: parsed.data.type,
      priority: parsed.data.priority,
      status: "open",
      availableAt,
      isReady,
      isBlocked: false,
      unresolvedBlockerCount: 0,
      cancelledBlockerCount: 0,
      revision: 1,
      reviewRevision: 1,
      createdBy: actor,
      lastEditedBy: actor,
      ...(parent === null ? {} : { parentTaskId: parent._id }),
      ...(isReady ? { readySince: now } : {}),
      needsAttention: false,
      wakeGeneration: availableAt > now ? 1 : 0,
      claimFence: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("taskBodies", {
      organizationId: authorization.authorization.organizationId,
      workspaceId: workspace._id,
      taskId,
      description: parsed.data.description ?? "",
      createdAt: now,
      updatedAt: now,
    });
    for (const label of parsed.data.labels ?? []) {
      const workspaceLabel = await ensureWorkspaceLabel(ctx, authorization.authorization, label, now);
      if (workspaceLabel === null) {
        throw new Error("Agent-created task label projection is invalid after a protected write.");
      }
      await ctx.db.insert("taskLabels", {
        organizationId: authorization.authorization.organizationId,
        workspaceId: workspace._id,
        taskId,
        labelId: workspaceLabel._id,
        label,
        createdBy: actor,
        createdAt: now,
      });
    }
    if (availableAt > now) {
      const wakeId = await ctx.db.insert("taskWakes", {
        organizationId: authorization.authorization.organizationId,
        workspaceId: workspace._id,
        taskId,
        generation: 1,
        expectedAvailableAt: availableAt,
        state: "pending",
        createdAt: now,
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
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: authorization.authorization.organizationId,
      workspaceId: workspace._id,
      taskId,
      taskPublicId,
      taskRevision: 1,
      type: "task.created",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { availableAt },
      now,
    });
    const task = await ctx.db.get(taskId);
    if (task === null) throw new Error("Created task disappeared.");
    const data = { task: taskView(task) };
    await storeReceipt(ctx, {
      identity,
      operation: "tasks.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    await touchAuthorizedAgent(ctx, authorization.authorization, now);
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export const getTask = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    requestId: v.string(),
  },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (!taskMatchesTenant(task, authorization.authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const detail = await taskDetail(ctx, task);
    return detail === null
      ? domainFailure("PROJECTION_MISMATCH", args.requestId)
      : { ok: true as const, data: detail, requestId: args.requestId };
  },
});

export const listTasks = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    status: v.optional(taskStatusValidator),
    type: v.optional(taskTypeValidator),
    priority: v.optional(v.number()),
    assigneeAgentId: v.optional(v.string()),
    label: v.optional(v.string()),
    parentKey: v.optional(v.string()),
    updatedAfter: v.optional(v.number()),
    requestId: v.string(),
  },
  returns: taskListResultValidator,
  handler: async (ctx, args) => {
    if (!validPage(args.limit, args.cursor)) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    let parentId: Id<"tasks"> | undefined;
    if (args.parentKey !== undefined) {
      const parent = await taskByKey(ctx, authorization.authorization.workspaceId, args.parentKey);
      if (parent === null) return domainFailure("NOT_FOUND", args.requestId);
      if (!taskMatchesTenant(parent, authorization.authorization)) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      parentId = parent._id;
    }
    const tasks: Infer<typeof taskViewValidator>[] = [];
    let cursor: string | null = args.cursor ?? null;
    let done = false;
    const maximumPages = 20;
    if (args.label !== undefined) {
      for (let attempt = 0; attempt < maximumPages && tasks.length < args.limit && !done; attempt += 1) {
        const label = args.label;
        const page = await ctx.db
          .query("taskLabels")
          .withIndex("by_workspace_label_task", (query) =>
            query.eq("workspaceId", authorization.authorization.workspaceId).eq("label", label),
          )
          .paginate({ cursor, numItems: args.limit - tasks.length });
        for (const row of page.page) {
          const task = await ctx.db.get(row.taskId);
          if (
            task === null ||
            !taskMatchesTenant(task, authorization.authorization) ||
            !taskRelationMatches(task, row)
          ) {
            return domainFailure("PROJECTION_MISMATCH", args.requestId);
          }
          if (matchesTaskFilters(task, args, parentId)) tasks.push(taskView(task));
        }
        done = page.isDone;
        cursor = page.continueCursor;
      }
      return {
        ok: true as const,
        data: { tasks, cursor: done ? null : cursor },
        requestId: args.requestId,
      };
    }
    const loadPage = async (continuation: string | null, numItems: number) => {
      if (args.status !== undefined) {
        const status = args.status;
        return await ctx.db
          .query("tasks")
          .withIndex("by_workspace_status_updated", (query) => {
            const scoped = query
              .eq("workspaceId", authorization.authorization.workspaceId)
              .eq("status", status);
            return args.updatedAfter === undefined ? scoped : scoped.gt("updatedAt", args.updatedAfter);
          })
          .order("desc")
          .paginate({ cursor: continuation, numItems });
      }
      if (args.assigneeAgentId !== undefined) {
        const assigneeAgentId = args.assigneeAgentId;
        return await ctx.db
          .query("tasks")
          .withIndex("by_workspace_assignee_updated", (query) => {
            const scoped = query
              .eq("workspaceId", authorization.authorization.workspaceId)
              .eq("assigneeAgentPublicId", assigneeAgentId);
            return args.updatedAfter === undefined ? scoped : scoped.gt("updatedAt", args.updatedAfter);
          })
          .order("desc")
          .paginate({ cursor: continuation, numItems });
      }
      if (parentId !== undefined) {
        const selectedParentId = parentId;
        return await ctx.db
          .query("tasks")
          .withIndex("by_workspace_parent_updated", (query) => {
            const scoped = query
              .eq("workspaceId", authorization.authorization.workspaceId)
              .eq("parentTaskId", selectedParentId);
            return args.updatedAfter === undefined ? scoped : scoped.gt("updatedAt", args.updatedAfter);
          })
          .order("desc")
          .paginate({ cursor: continuation, numItems });
      }
      if (args.type !== undefined) {
        const type = args.type;
        return await ctx.db
          .query("tasks")
          .withIndex("by_workspace_type_updated", (query) => {
            const scoped = query
              .eq("workspaceId", authorization.authorization.workspaceId)
              .eq("type", type);
            return args.updatedAfter === undefined ? scoped : scoped.gt("updatedAt", args.updatedAfter);
          })
          .order("desc")
          .paginate({ cursor: continuation, numItems });
      }
      if (args.priority !== undefined) {
        const priority = args.priority;
        return await ctx.db
          .query("tasks")
          .withIndex("by_workspace_priority_updated", (query) => {
            const scoped = query
              .eq("workspaceId", authorization.authorization.workspaceId)
              .eq("priority", priority);
            return args.updatedAfter === undefined ? scoped : scoped.gt("updatedAt", args.updatedAfter);
          })
          .order("desc")
          .paginate({ cursor: continuation, numItems });
      }
      return await ctx.db
        .query("tasks")
        .withIndex("by_workspace_updated", (query) => {
          const scoped = query.eq("workspaceId", authorization.authorization.workspaceId);
          return args.updatedAfter === undefined ? scoped : scoped.gt("updatedAt", args.updatedAfter);
        })
        .order("desc")
        .paginate({ cursor: continuation, numItems });
    };
    for (let attempt = 0; attempt < maximumPages && tasks.length < args.limit && !done; attempt += 1) {
      const page = await loadPage(cursor, args.limit - tasks.length);
      if (page.page.some((task) => !taskMatchesTenant(task, authorization.authorization))) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      tasks.push(
        ...page.page
          .filter((task) => matchesTaskFilters(task, args, parentId))
          .map(taskView),
      );
      done = page.isDone;
      cursor = page.continueCursor;
    }
    return {
      ok: true as const,
      data: { tasks, cursor: done ? null : cursor },
      requestId: args.requestId,
    };
  },
});

function matchesTaskFilters(
  task: TaskDoc,
  args: {
    readonly status?: TaskDoc["status"];
    readonly type?: TaskDoc["type"];
    readonly priority?: number;
    readonly assigneeAgentId?: string;
  },
  parentId: Id<"tasks"> | undefined,
) {
  return (
    (args.status === undefined || task.status === args.status) &&
    (args.type === undefined || task.type === args.type) &&
    (args.priority === undefined || task.priority === args.priority) &&
    (args.assigneeAgentId === undefined || task.assigneeAgentPublicId === args.assigneeAgentId) &&
    (parentId === undefined || task.parentTaskId === parentId)
  );
}

export const blockedTasks = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    attentionOnly: v.optional(v.boolean()),
    requestId: v.string(),
  },
  returns: blockedListResultValidator,
  handler: async (ctx, args) => {
    if (!validPage(args.limit, args.cursor)) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const page = await ctx.db
    .query("tasks")
      .withIndex("by_workspace_blocked_attention_updated", (query) => {
        const scoped = query
          .eq("workspaceId", authorization.authorization.workspaceId)
          .eq("isBlocked", true);
        return args.attentionOnly === true ? scoped.eq("needsAttention", true) : scoped;
      })
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    if (page.page.some((task) => !taskMatchesTenant(task, authorization.authorization))) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const tasks = page.page.flatMap((task) => {
      const blocked = task.unresolvedBlockerCount > 0 || task.cancelledBlockerCount > 0;
      const needsAttention = task.needsAttention === true || task.cancelledBlockerCount > 0;
      return blocked && (args.attentionOnly !== true || needsAttention)
        ? [{ task: taskView(task), needsAttention }]
        : [];
    });
    return {
      ok: true as const,
      data: { tasks, cursor: nextCursor(page) },
      requestId: args.requestId,
    };
  },
});

async function loadMutableAgentTask(
  ctx: MutationCtx,
  args: {
    readonly authorization: AuthorizedAgent;
    readonly key: string;
    readonly revision: number;
    readonly fence?: number;
    readonly now: number;
    readonly requestId: string;
  },
) {
  const task = await taskByKey(ctx, args.authorization.workspaceId, args.key);
  if (task === null) return { ok: false as const, result: domainFailure("NOT_FOUND", args.requestId) };
  if (!taskMatchesTenant(task, args.authorization)) {
    return {
      ok: false as const,
      result: domainFailure("PROJECTION_MISMATCH", args.requestId),
    };
  }
  if ((await taskDetail(ctx, task)) === null) {
    await queueTaskProjectionRepair(ctx, task, args.now);
    return {
      ok: false as const,
      result: domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      }),
    };
  }
  if (task.revision !== args.revision) {
    return {
      ok: false as const,
      result: domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      }),
    };
  }
  if (task.status === "in_progress" || task.currentClaim !== undefined) {
    const claim =
      task.currentClaim === undefined ? null : await ctx.db.get(task.currentClaim.claimId);
    if (!activeClaimMatchesTask(task, claim)) {
      await queueTaskClaimRepair(ctx, task, args.now);
      return {
        ok: false as const,
        result: domainFailure("PROJECTION_MISMATCH", args.requestId, {
          taskKey: task.key,
          currentRevision: task.revision,
        }),
      };
    }
  }
  const editable = specFailure(task, args.authorization, args.fence, args.now, args.requestId);
  if (!editable.ok) return { ok: false as const, result: { ok: false as const, error: editable.error } };
  return { ok: true as const, task };
}

async function finishTaskDetailMutation(
  ctx: MutationCtx,
  args: {
    readonly authorization: AuthorizedAgent;
    readonly task: TaskDoc;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly requestId: string;
    readonly now: number;
  },
) {
  const data = await taskDetail(ctx, args.task);
  if (data === null) {
    await queueTaskProjectionRepair(ctx, args.task, args.now);
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: args.task.key,
      currentRevision: args.task.revision,
    });
  }
  await storeReceipt(ctx, {
    identity: receiptIdentity(args.authorization),
    operation: args.operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    data,
    now: args.now,
  });
  await touchAuthorizedAgent(ctx, args.authorization, args.now);
  return { ok: true as const, data, requestId: args.requestId };
}

export const updateTask = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    revision: v.number(),
    fence: v.optional(v.number()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    type: v.optional(taskTypeValidator),
    priority: v.optional(v.number()),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const title = args.title?.trim();
    if (
      (title === undefined &&
        args.description === undefined &&
        args.type === undefined &&
        args.priority === undefined) ||
      (title !== undefined &&
        (title.length === 0 || new TextEncoder().encode(title).length > 512)) ||
      (args.description !== undefined &&
        new TextEncoder().encode(args.description).length > MAX_TASK_DESCRIPTION_BYTES) ||
      (args.priority !== undefined &&
        (!Number.isInteger(args.priority) || args.priority < 0 || args.priority > 4))
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:edit",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = await consumeAgentWriteRateLimit(
      ctx,
      authorization.authorization,
      "agent_write",
      args.requestId,
      now,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.update",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseTaskMutationData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const loaded = await loadMutableAgentTask(ctx, {
      authorization: authorization.authorization,
      key: args.key,
      revision: args.revision,
      ...(args.fence === undefined ? {} : { fence: args.fence }),
      now,
      requestId: args.requestId,
    });
    if (!loaded.ok) return loaded.result;
    const actor = agentActor(authorization.authorization);
    const fields: string[] = [];
    const patch: Partial<TaskDoc> = {
      revision: loaded.task.revision + 1,
      reviewRevision: loaded.task.reviewRevision + 1,
      lastEditedBy: actor,
      updatedAt: now,
    };
    if (title !== undefined) {
      patch.title = title;
      fields.push("title");
    }
    if (args.type !== undefined) {
      patch.type = args.type;
      fields.push("type");
    }
    if (args.priority !== undefined) {
      patch.priority = args.priority;
      fields.push("priority");
    }
    if (args.description !== undefined) {
      fields.push("description");
      const body = await ctx.db
        .query("taskBodies")
        .withIndex("by_workspace_and_task", (query) =>
          query.eq("workspaceId", loaded.task.workspaceId).eq("taskId", loaded.task._id),
        )
        .unique();
      if (body !== null && !taskRelationMatches(loaded.task, body)) {
        await queueTaskProjectionRepair(ctx, loaded.task, now);
        return domainFailure("PROJECTION_MISMATCH", args.requestId, {
          taskKey: loaded.task.key,
          currentRevision: loaded.task.revision,
        });
      }
      if (body === null) {
        await ctx.db.insert("taskBodies", {
          organizationId: loaded.task.organizationId,
          workspaceId: loaded.task.workspaceId,
          taskId: loaded.task._id,
          description: args.description,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        await ctx.db.patch(body._id, { description: args.description, updatedAt: now });
      }
    }
    await ctx.db.patch(loaded.task._id, patch);
    await appendTaskEvent(ctx, {
      organizationId: loaded.task.organizationId,
      workspaceId: loaded.task.workspaceId,
      taskId: loaded.task._id,
      taskPublicId: loaded.task.publicId,
      taskRevision: loaded.task.revision + 1,
      type: "task.updated",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { fields },
      now,
    });
    const updated = await ctx.db.get(loaded.task._id);
    if (updated === null) throw new Error("Updated task disappeared.");
    return await finishTaskDetailMutation(ctx, {
      authorization: authorization.authorization,
      task: updated,
      operation: "tasks.update",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      now,
    });
  },
});

export const assignTask = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    revision: v.number(),
    fence: v.optional(v.number()),
    assigneeAgentId: v.union(v.string(), v.null()),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:assign",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = await consumeAgentWriteRateLimit(
      ctx,
      authorization.authorization,
      "agent_write",
      args.requestId,
      now,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.assign",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseTaskMutationData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const loaded = await loadMutableAgentTask(ctx, {
      authorization: authorization.authorization,
      key: args.key,
      revision: args.revision,
      ...(args.fence === undefined ? {} : { fence: args.fence }),
      now,
      requestId: args.requestId,
    });
    if (!loaded.ok) return loaded.result;
    if (args.assigneeAgentId !== null) {
      const assignee = await ctx.db
        .query("agents")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.assigneeAgentId ?? ""))
        .unique();
      if (
        assignee === null ||
        assignee.organizationId !== authorization.authorization.organizationId ||
        assignee.status !== "active"
      ) {
        return domainFailure("NOT_FOUND", args.requestId);
      }
      const grant = await ctx.db
        .query("agentWorkspaceGrants")
        .withIndex("by_workspace_and_agent", (query) =>
          query.eq("workspaceId", authorization.authorization.workspaceId).eq("agentId", assignee._id),
        )
        .unique();
      if (grant === null || grant.status !== "active") {
        return domainFailure("NOT_FOUND", args.requestId);
      }
      if (!activeAssigneeGrantMatches(authorization.authorization, assignee, grant)) {
        await queueTaskProjectionRepair(ctx, loaded.task, now);
        return domainFailure("PROJECTION_MISMATCH", args.requestId, {
          taskKey: loaded.task.key,
          currentRevision: loaded.task.revision,
        });
      }
    }
    const actor = agentActor(authorization.authorization);
    await ctx.db.patch(loaded.task._id, {
      ...(args.assigneeAgentId === null
        ? { assigneeAgentPublicId: undefined }
        : { assigneeAgentPublicId: args.assigneeAgentId }),
      revision: loaded.task.revision + 1,
      reviewRevision: loaded.task.reviewRevision + 1,
      lastEditedBy: actor,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: loaded.task.organizationId,
      workspaceId: loaded.task.workspaceId,
      taskId: loaded.task._id,
      taskPublicId: loaded.task.publicId,
      taskRevision: loaded.task.revision + 1,
      type: "task.assigned",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { assigneeAgentId: args.assigneeAgentId },
      now,
    });
    const updated = await ctx.db.get(loaded.task._id);
    if (updated === null) throw new Error("Assigned task disappeared.");
    return await finishTaskDetailMutation(ctx, {
      authorization: authorization.authorization,
      task: updated,
      operation: "tasks.assign",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      now,
    });
  },
});

export const deferTask = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    revision: v.number(),
    availableAt: v.number(),
    fence: v.optional(v.number()),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    if (!Number.isSafeInteger(args.availableAt) || args.availableAt < 0) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    if (args.availableAt > now + MAX_DEFER_MS) return domainFailure("DEFER_HORIZON", args.requestId);
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:edit",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = await consumeAgentWriteRateLimit(
      ctx,
      authorization.authorization,
      "agent_write",
      args.requestId,
      now,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.defer",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseTaskMutationData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const loaded = await loadMutableAgentTask(ctx, {
      authorization: authorization.authorization,
      key: args.key,
      revision: args.revision,
      ...(args.fence === undefined ? {} : { fence: args.fence }),
      now,
      requestId: args.requestId,
    });
    if (!loaded.ok) return loaded.result;
    const actor = agentActor(authorization.authorization);
    const generation = (loaded.task.wakeGeneration ?? 0) + 1;
    const ready =
      loaded.task.status === "open" &&
      args.availableAt <= now &&
      loaded.task.unresolvedBlockerCount === 0 &&
      loaded.task.cancelledBlockerCount === 0;
    await ctx.db.patch(loaded.task._id, {
      availableAt: args.availableAt,
      isReady: ready,
      ...(ready ? { readySince: now } : { readySince: undefined }),
      wakeGeneration: generation,
      revision: loaded.task.revision + 1,
      reviewRevision: loaded.task.reviewRevision + 1,
      lastEditedBy: actor,
      updatedAt: now,
    });
    if (args.availableAt > now) {
      const wakeId = await ctx.db.insert("taskWakes", {
        organizationId: loaded.task.organizationId,
        workspaceId: loaded.task.workspaceId,
        taskId: loaded.task._id,
        generation,
        expectedAvailableAt: args.availableAt,
        state: "pending",
        createdAt: now,
      });
      await ctx.scheduler.runAt(args.availableAt, internal.schedules.wakeTask, {
        taskId: loaded.task._id,
        wakeId,
        generation,
        expectedAvailableAt: args.availableAt,
      });
    }
    await appendTaskEvent(ctx, {
      organizationId: loaded.task.organizationId,
      workspaceId: loaded.task.workspaceId,
      taskId: loaded.task._id,
      taskPublicId: loaded.task.publicId,
      taskRevision: loaded.task.revision + 1,
      type: "task.deferred",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { availableAt: args.availableAt },
      now,
    });
    const updated = await ctx.db.get(loaded.task._id);
    if (updated === null) throw new Error("Deferred task disappeared.");
    return await finishTaskDetailMutation(ctx, {
      authorization: authorization.authorization,
      task: updated,
      operation: "tasks.defer",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      now,
    });
  },
});

export const listTaskLabels = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    requestId: v.string(),
  },
  returns: labelListResultValidator,
  handler: async (ctx, args) => {
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (!taskMatchesTenant(task, authorization.authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const labels = await ctx.db
      .query("taskLabels")
      .withIndex("by_workspace_task_created", (query) =>
        query.eq("workspaceId", task.workspaceId).eq("taskId", task._id),
      )
      .take(MAX_TASK_LABELS + 1);
    if (
      labels.length > MAX_TASK_LABELS ||
      labels.some((label) => !taskRelationMatches(task, label))
    ) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    return {
      ok: true as const,
      data: { labels: labels.map((row) => row.label).sort(), revision: task.revision },
      requestId: args.requestId,
    };
  },
});

async function mutateTaskLabel(
  ctx: MutationCtx,
  args: {
    credentialId: Id<"agentCredentials">;
    sessionPublicId: string;
    key: string;
    revision: number;
    label: string;
    fence?: number;
    idempotencyKey: string;
    requestDigest: string;
    requestId: string;
    remove: boolean;
  },
) {
  const now = Date.now();
  const metadata = assertRequestMetadata({ ...args, now });
  if (!metadata.ok) return { ok: false as const, error: metadata.error };
  const normalized = args.label.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9._/-]{0,62}[a-z0-9])?$/u.test(normalized)
  ) {
    return domainFailure("VALIDATION_ERROR", args.requestId);
  }
  const authorization = await authorizeAgent(ctx, {
    ...args,
    requiredScope: "tasks:edit",
    now,
  });
  if (!authorization.ok) return { ok: false as const, error: authorization.error };
  const rateLimitFailure = await consumeAgentWriteRateLimit(
    ctx,
    authorization.authorization,
    "agent_write",
    args.requestId,
    now,
  );
  if (rateLimitFailure !== null) return rateLimitFailure;
  const operation = args.remove ? "tasks.labels.remove" : "tasks.labels.add";
  const receipt = await lookupReceipt(ctx, {
    identity: receiptIdentity(authorization.authorization),
    operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    parse: parseTaskMutationData,
  });
  if (receipt.kind === "failure") return receipt.result;
  if (receipt.kind === "replay") {
    return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
  }
  const loaded = await loadMutableAgentTask(ctx, {
    authorization: authorization.authorization,
    key: args.key,
    revision: args.revision,
    ...(args.fence === undefined ? {} : { fence: args.fence }),
    now,
    requestId: args.requestId,
  });
  if (!loaded.ok) return loaded.result;
  const existing = await ctx.db
    .query("taskLabels")
    .withIndex("by_workspace_task_label", (query) =>
      query
        .eq("workspaceId", loaded.task.workspaceId)
        .eq("taskId", loaded.task._id)
        .eq("label", normalized),
    )
    .unique();
  if (
    existing !== null &&
    (!taskRelationMatches(loaded.task, existing) || existing.label !== normalized)
  ) {
    await queueTaskProjectionRepair(ctx, loaded.task, now);
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: loaded.task.key,
      currentRevision: loaded.task.revision,
    });
  }
  if ((!args.remove && existing !== null) || (args.remove && existing === null)) {
    return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
      taskKey: loaded.task.key,
      currentRevision: loaded.task.revision,
    });
  }
  if (!args.remove) {
    const labels = await ctx.db
      .query("taskLabels")
      .withIndex("by_workspace_task_created", (query) =>
        query.eq("workspaceId", loaded.task.workspaceId).eq("taskId", loaded.task._id),
      )
      .take(MAX_TASK_LABELS);
    if (labels.length >= MAX_TASK_LABELS) return domainFailure("VALIDATION_ERROR", args.requestId);
    const workspaceLabel = await ensureWorkspaceLabel(ctx, authorization.authorization, normalized, now);
    if (workspaceLabel === null) {
      throw new Error("Agent task label projection is invalid after label creation.");
    }
    await ctx.db.insert("taskLabels", {
      organizationId: loaded.task.organizationId,
      workspaceId: loaded.task.workspaceId,
      taskId: loaded.task._id,
      labelId: workspaceLabel._id,
      label: normalized,
      createdBy: agentActor(authorization.authorization),
      createdAt: now,
    });
  } else if (existing !== null) {
    await ctx.db.delete(existing._id);
  }
  const actor = agentActor(authorization.authorization);
  await ctx.db.patch(loaded.task._id, {
    revision: loaded.task.revision + 1,
    reviewRevision: loaded.task.reviewRevision + 1,
    lastEditedBy: actor,
    updatedAt: now,
  });
  await appendTaskEvent(ctx, {
    organizationId: loaded.task.organizationId,
    workspaceId: loaded.task.workspaceId,
    taskId: loaded.task._id,
    taskPublicId: loaded.task.publicId,
    taskRevision: loaded.task.revision + 1,
    type: args.remove ? "task.label_removed" : "task.label_added",
    actor,
    command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
    payload: { label: normalized },
    now,
  });
  const updated = await ctx.db.get(loaded.task._id);
  if (updated === null) throw new Error("Labelled task disappeared.");
  return await finishTaskDetailMutation(ctx, {
    authorization: authorization.authorization,
    task: updated,
    operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    now,
  });
}

const taskLabelArgs = {
  credentialId: v.id("agentCredentials"),
  sessionPublicId: v.string(),
  key: v.string(),
  revision: v.number(),
  label: v.string(),
  fence: v.optional(v.number()),
  idempotencyKey: v.string(),
  requestDigest: v.string(),
  requestId: v.string(),
};

export const addTaskLabel = internalMutation({
  args: taskLabelArgs,
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => await mutateTaskLabel(ctx, { ...args, remove: false }),
});

export const removeTaskLabel = internalMutation({
  args: taskLabelArgs,
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => await mutateTaskLabel(ctx, { ...args, remove: true }),
});

export const addTaskComment = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    body: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: commentResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    if (
      args.body.trim().length === 0 ||
      new TextEncoder().encode(args.body).length > MAX_TASK_COMMENT_BYTES
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "comments:write",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = await consumeAgentWriteRateLimit(
      ctx,
      authorization.authorization,
      "agent_write",
      args.requestId,
      now,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.comments.add",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseWithSchema(addTaskCommentResponseSchema),
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    const actor = agentActor(authorization.authorization);
    const publicId = randomPublicId("cmt");
    await ctx.db.insert("taskComments", {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      publicId,
      body: args.body,
      actor,
      createdAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: task.revision,
      type: "task.comment_added",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { commentId: publicId },
      now,
    });
    const data = { comment: { id: publicId, body: args.body, actor: publicActor(actor), createdAt: now } };
    await storeReceipt(ctx, {
      identity,
      operation: "tasks.comments.add",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    await touchAuthorizedAgent(ctx, authorization.authorization, now);
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export const listTaskComments = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: commentListResultValidator,
  handler: async (ctx, args) => {
    if (!validPage(args.limit, args.cursor)) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (!taskMatchesTenant(task, authorization.authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const page = await ctx.db
      .query("taskComments")
      .withIndex("by_workspace_task_created", (query) =>
        query.eq("workspaceId", task.workspaceId).eq("taskId", task._id),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    if (page.page.some((comment) => !taskRelationMatches(task, comment))) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    return {
      ok: true as const,
      data: {
        comments: page.page.map((comment) => ({
          id: comment.publicId,
          body: comment.body,
          actor: publicActor(comment.actor),
          createdAt: comment.createdAt,
        })),
        cursor: nextCursor(page),
      },
      requestId: args.requestId,
    };
  },
});

async function resolveRepository(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  publicId: string,
  activeOnly: boolean,
) {
  const repository = await ctx.db
    .query("workspaceRepositories")
    .withIndex("by_public_id", (query) => query.eq("publicId", publicId))
    .unique();
  return repository !== null &&
    repository.workspaceId === workspaceId &&
    (!activeOnly || repository.status === "active")
    ? repository
    : null;
}

export async function persistedReferenceValue(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  input: TaskReferenceInput,
): Promise<TaskReferenceValue | null> {
  if (input.kind === "repository") {
    const repository = await resolveRepository(ctx, workspaceId, input.repositoryId, true);
    return repository === null ? null : { kind: "repository", repositoryId: repository._id };
  }
  if (input.kind === "pull_request") {
    if (input.repositoryId === undefined) return { kind: "pull_request", url: input.url };
    const repository = await resolveRepository(ctx, workspaceId, input.repositoryId, true);
    return repository === null
      ? null
      : { kind: "pull_request", url: input.url, repositoryId: repository._id };
  }
  if (input.kind === "commit") {
    if (input.repositoryId === undefined) {
      return {
        kind: "commit",
        sha: input.sha,
        ...(input.url === undefined ? {} : { url: input.url }),
      };
    }
    const repository = await resolveRepository(ctx, workspaceId, input.repositoryId, true);
    return repository === null
      ? null
      : {
          kind: "commit",
          sha: input.sha,
          repositoryId: repository._id,
          ...(input.url === undefined ? {} : { url: input.url }),
        };
  }
  return input;
}

export function referenceHasSafeUrls(input: TaskReferenceInput): boolean {
  if (input.kind === "repository") return true;
  if (input.kind === "commit") {
    return input.url === undefined || isCredentialFreeHttpsUrl(input.url);
  }
  return isCredentialFreeHttpsUrl(input.url);
}

export async function referenceView(
  ctx: ReadCtx,
  reference: Doc<"taskReferences">,
): Promise<Infer<typeof referenceViewValidator> | null> {
  const base = { id: reference.publicId, createdAt: reference.createdAt };
  if (reference.value.kind === "repository") {
    const repository = await ctx.db.get(reference.value.repositoryId);
    if (repository === null || repository.workspaceId !== reference.workspaceId) return null;
    return { ...base, kind: "repository" as const, repositoryId: repository.publicId };
  }
  if (reference.value.kind === "pull_request") {
    if (reference.value.repositoryId === undefined) {
      return { ...base, kind: "pull_request" as const, url: reference.value.url };
    }
    const repository = await ctx.db.get(reference.value.repositoryId);
    if (repository === null || repository.workspaceId !== reference.workspaceId) return null;
    return {
      ...base,
      kind: "pull_request" as const,
      url: reference.value.url,
      repositoryId: repository.publicId,
    };
  }
  if (reference.value.kind === "commit") {
    if (reference.value.repositoryId === undefined) {
      return {
        ...base,
        kind: "commit" as const,
        sha: reference.value.sha,
        ...(reference.value.url === undefined ? {} : { url: reference.value.url }),
      };
    }
    const repository = await ctx.db.get(reference.value.repositoryId);
    if (repository === null || repository.workspaceId !== reference.workspaceId) return null;
    return {
      ...base,
      kind: "commit" as const,
      sha: reference.value.sha,
      repositoryId: repository.publicId,
      ...(reference.value.url === undefined ? {} : { url: reference.value.url }),
    };
  }
  return { ...base, ...reference.value };
}

export const addTaskReference = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    revision: v.number(),
    fence: v.optional(v.number()),
    reference: referenceInputValidator,
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: referenceResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:edit",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = await consumeAgentWriteRateLimit(
      ctx,
      authorization.authorization,
      "agent_write",
      args.requestId,
      now,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.references.add",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseReferenceData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const loaded = await loadMutableAgentTask(ctx, {
      authorization: authorization.authorization,
      key: args.key,
      revision: args.revision,
      ...(args.fence === undefined ? {} : { fence: args.fence }),
      now,
      requestId: args.requestId,
    });
    if (!loaded.ok) return loaded.result;
    if (!referenceHasSafeUrls(args.reference)) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const value = await persistedReferenceValue(ctx, loaded.task.workspaceId, args.reference);
    if (value === null) return domainFailure("NOT_FOUND", args.requestId);
    const actor = agentActor(authorization.authorization);
    const publicId = randomPublicId("ref");
    const referenceId = await ctx.db.insert("taskReferences", {
      organizationId: loaded.task.organizationId,
      workspaceId: loaded.task.workspaceId,
      taskId: loaded.task._id,
      publicId,
      value,
      status: "active",
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(loaded.task._id, {
      revision: loaded.task.revision + 1,
      reviewRevision: loaded.task.reviewRevision + 1,
      lastEditedBy: actor,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: loaded.task.organizationId,
      workspaceId: loaded.task.workspaceId,
      taskId: loaded.task._id,
      taskPublicId: loaded.task.publicId,
      taskRevision: loaded.task.revision + 1,
      type: "task.reference_added",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { referenceId: publicId, kind: value.kind },
      now,
    });
    const stored = await ctx.db.get(referenceId);
    if (stored === null) throw new Error("Task reference disappeared.");
    const view = await referenceView(ctx, stored);
    if (view === null) throw new Error("Task reference repository disappeared.");
    const updated = await ctx.db.get(loaded.task._id);
    if (updated === null) throw new Error("Referenced task disappeared.");
    const data = { reference: view, task: taskView(updated) };
    await storeReceipt(ctx, {
      identity,
      operation: "tasks.references.add",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    await touchAuthorizedAgent(ctx, authorization.authorization, now);
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export const listTaskReferences = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: referenceListResultValidator,
  handler: async (ctx, args) => {
    if (!validPage(args.limit, args.cursor)) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (!taskMatchesTenant(task, authorization.authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const page = await ctx.db
      .query("taskReferences")
      .withIndex("by_workspace_task_status_created", (query) =>
        query
          .eq("workspaceId", task.workspaceId)
          .eq("taskId", task._id)
          .eq("status", "active"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    const references = [];
    for (const reference of page.page) {
      if (!taskRelationMatches(task, reference)) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      const view = await referenceView(ctx, reference);
      if (view === null) return domainFailure("PROJECTION_MISMATCH", args.requestId);
      references.push(view);
    }
    return {
      ok: true as const,
      data: { references, cursor: nextCursor(page) },
      requestId: args.requestId,
    };
  },
});

export const removeTaskReference = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    referencePublicId: v.string(),
    revision: v.number(),
    fence: v.optional(v.number()),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: referenceRemoveResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:edit",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = await consumeAgentWriteRateLimit(
      ctx,
      authorization.authorization,
      "agent_write",
      args.requestId,
      now,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.references.remove",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseRemovedReferenceData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const loaded = await loadMutableAgentTask(ctx, {
      authorization: authorization.authorization,
      key: args.key,
      revision: args.revision,
      ...(args.fence === undefined ? {} : { fence: args.fence }),
      now,
      requestId: args.requestId,
    });
    if (!loaded.ok) return loaded.result;
    const reference = await ctx.db
      .query("taskReferences")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.referencePublicId))
      .unique();
    if (
      reference === null ||
      reference.workspaceId !== loaded.task.workspaceId ||
      reference.taskId !== loaded.task._id ||
      reference.status !== "active"
    ) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    const actor = agentActor(authorization.authorization);
    await ctx.db.patch(reference._id, { status: "removed", removedAt: now, updatedAt: now });
    await ctx.db.patch(loaded.task._id, {
      revision: loaded.task.revision + 1,
      reviewRevision: loaded.task.reviewRevision + 1,
      lastEditedBy: actor,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: loaded.task.organizationId,
      workspaceId: loaded.task.workspaceId,
      taskId: loaded.task._id,
      taskPublicId: loaded.task.publicId,
      taskRevision: loaded.task.revision + 1,
      type: "task.reference_removed",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { referenceId: reference.publicId, kind: reference.value.kind },
      now,
    });
    const updated = await ctx.db.get(loaded.task._id);
    if (updated === null) throw new Error("Reference task disappeared.");
    const data = { referenceId: reference.publicId, task: taskView(updated) };
    await storeReceipt(ctx, {
      identity,
      operation: "tasks.references.remove",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    await touchAuthorizedAgent(ctx, authorization.authorization, now);
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export async function blockerRows(ctx: ReadCtx, task: TaskDoc) {
  return await ctx.db
    .query("taskDependencies")
    .withIndex("by_workspace_blocked_blocker", (query) =>
      query.eq("workspaceId", task.workspaceId).eq("blockedTaskId", task._id),
    )
    .take(MAX_DIRECT_BLOCKERS + 1);
}

async function actualBlockerCounters(ctx: ReadCtx, task: TaskDoc) {
  const rows = await blockerRows(ctx, task);
  if (rows.length > MAX_DIRECT_BLOCKERS) return null;
  let unresolved = 0;
  let cancelled = 0;
  for (const row of rows) {
    const blocker = await ctx.db.get(row.blockerTaskId);
    if (blocker === null || !dependencyMatchesTasks(row, blocker, task)) {
      return null;
    }
    const contribution = blockerContribution(blocker.status);
    unresolved += contribution.unresolved;
    cancelled += contribution.cancelled;
  }
  return { unresolved, cancelled, total: rows.length };
}

export async function queueTaskProjectionRepair(
  ctx: MutationCtx,
  task: TaskDoc,
  now: number,
): Promise<void> {
  await queueProjectionRepair(ctx, task, "task_readiness", now);
}

export async function queueTaskClaimRepair(
  ctx: MutationCtx,
  task: TaskDoc,
  now: number,
): Promise<void> {
  await queueProjectionRepair(ctx, task, "task_claim", now);
}

export async function queueTaskReviewRepair(
  ctx: MutationCtx,
  task: TaskDoc,
  now: number,
): Promise<void> {
  await queueProjectionRepair(ctx, task, "task_review", now);
}

async function queueProjectionRepair(
  ctx: MutationCtx,
  task: TaskDoc,
  kind: Doc<"projectionRepairs">["kind"],
  now: number,
): Promise<void> {
  const existing = await ctx.db
    .query("projectionRepairs")
    .withIndex("by_workspace_task_kind", (query) =>
      query
        .eq("workspaceId", task.workspaceId)
        .eq("taskId", task._id)
        .eq("kind", kind),
    )
    .unique();
  if (
    existing !== null &&
    (existing.organizationId !== task.organizationId ||
      existing.workspaceId !== task.workspaceId ||
      existing.taskId !== task._id ||
      existing.kind !== kind)
  ) {
    return;
  }
  const generation = (existing?.generation ?? 0) + 1;
  const repairId = existing?._id ??
    (await ctx.db.insert("projectionRepairs", {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      kind,
      generation,
      expectedRevision: task.revision,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }));
  if (existing !== null) {
    await ctx.db.patch(existing._id, {
      generation,
      expectedRevision: task.revision,
      status: "pending",
      updatedAt: now,
    });
  }
  await ctx.scheduler.runAfter(0, internal.workGraph.repairTaskProjection, {
    repairId,
    generation,
  });
}

export async function ensureCounterProjection(
  ctx: MutationCtx,
  task: TaskDoc,
  now: number,
  requestId: string,
) {
  const actual = await actualBlockerCounters(ctx, task);
  if (
    actual === null ||
    actual.unresolved !== task.unresolvedBlockerCount ||
    actual.cancelled !== task.cancelledBlockerCount
  ) {
    await queueTaskProjectionRepair(ctx, task, now);
    return domainFailure("PROJECTION_MISMATCH", requestId, {
      taskKey: task.key,
      blockingCount: task.unresolvedBlockerCount + task.cancelledBlockerCount,
      currentRevision: task.revision,
    });
  }
  return { ok: true as const, actual };
}

async function validateDependencyCycleIntegrityDb(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  blockerId: Id<"tasks">,
  blockedId: Id<"tasks">,
): Promise<
  | { readonly kind: "valid" }
  | { readonly kind: "cycle" }
  | { readonly kind: "projection_mismatch" }
  | { readonly kind: "limit"; readonly exhaustedLimit: "visited_tasks" | "examined_edges" }
> {
  if (blockerId === blockedId) return { kind: "cycle" };
  const [blockerRoot, blockedRoot] = await Promise.all([
    ctx.db.get(blockerId),
    ctx.db.get(blockedId),
  ]);
  if (
    blockerRoot === null ||
    blockedRoot === null ||
    blockerRoot.workspaceId !== workspaceId ||
    blockedRoot.workspaceId !== workspaceId ||
    blockerRoot.organizationId !== blockedRoot.organizationId
  ) {
    return { kind: "projection_mismatch" };
  }
  const visited = new Set<string>([String(blockedId)]);
  const queue: TaskDoc[] = [blockedRoot];
  let examinedEdges = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const remaining = MAX_GRAPH_EXAMINED_EDGES - examinedEdges;
    if (remaining <= 0) return { kind: "limit", exhaustedLimit: "examined_edges" };
    const edges = await ctx.db
      .query("taskDependencies")
      .withIndex("by_workspace_blocker_created", (query) =>
        query.eq("workspaceId", workspaceId).eq("blockerTaskId", current._id),
      )
      .take(remaining + 1);
    if (edges.length > remaining) return { kind: "limit", exhaustedLimit: "examined_edges" };
    examinedEdges += edges.length;
    for (const edge of edges) {
      const neighbor = await ctx.db.get(edge.blockedTaskId);
      if (neighbor === null || !dependencyMatchesTasks(edge, current, neighbor)) {
        return { kind: "projection_mismatch" };
      }
      if (
        edge.blockedTaskId === blockerId &&
        !visited.has(String(edge.blockedTaskId)) &&
        visited.size >= MAX_GRAPH_VISITED_TASKS
      ) {
        return { kind: "limit", exhaustedLimit: "visited_tasks" };
      }
      if (edge.blockedTaskId === blockerId) return { kind: "cycle" };
      const key = String(edge.blockedTaskId);
      if (visited.has(key)) continue;
      if (visited.size >= MAX_GRAPH_VISITED_TASKS) {
        return { kind: "limit", exhaustedLimit: "visited_tasks" };
      }
      visited.add(key);
      queue.push(neighbor);
    }
  }
  return { kind: "valid" };
}

export async function validateDependencyCycleDb(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  blockerId: Id<"tasks">,
  blockedId: Id<"tasks">,
): Promise<
  | { readonly kind: "valid" }
  | { readonly kind: "cycle" }
  | { readonly kind: "limit"; readonly exhaustedLimit: "visited_tasks" | "examined_edges" }
> {
  const result = await validateDependencyCycleIntegrityDb(
    ctx,
    workspaceId,
    blockerId,
    blockedId,
  );
  return result.kind === "projection_mismatch"
    ? { kind: "limit", exhaustedLimit: "examined_edges" }
    : result;
}

export async function dependencyView(ctx: ReadCtx, dependency: Doc<"taskDependencies">) {
  const [blocker, blocked] = await Promise.all([
    ctx.db.get(dependency.blockerTaskId),
    ctx.db.get(dependency.blockedTaskId),
  ]);
  return blocker === null || blocked === null || !dependencyMatchesTasks(dependency, blocker, blocked)
    ? null
    : {
        kind: "blocks" as const,
        blockerKey: blocker.key,
        blockedKey: blocked.key,
        createdAt: dependency.createdAt,
      };
}

async function mutateTaskDependency(
  ctx: MutationCtx,
  args: {
    credentialId: Id<"agentCredentials">;
    sessionPublicId: string;
    key: string;
    blockerKey: string;
    revision: number;
    fence?: number;
    idempotencyKey: string;
    requestDigest: string;
    requestId: string;
    remove: boolean;
  },
) {
  const now = Date.now();
  const metadata = assertRequestMetadata({ ...args, now });
  if (!metadata.ok) return { ok: false as const, error: metadata.error };
  const authorization = await authorizeAgent(ctx, {
    ...args,
    requiredScope: "dependencies:write",
    now,
  });
  if (!authorization.ok) return { ok: false as const, error: authorization.error };
  const rateLimitFailure = await consumeAgentWriteRateLimit(
    ctx,
    authorization.authorization,
    "agent_write",
    args.requestId,
    now,
  );
  if (rateLimitFailure !== null) return rateLimitFailure;
  const operation = args.remove ? "tasks.dependencies.remove" : "tasks.dependencies.add";
  const receipt = await lookupReceipt(ctx, {
    identity: receiptIdentity(authorization.authorization),
    operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    parse: parseDependencyData,
  });
  if (receipt.kind === "failure") return receipt.result;
  if (receipt.kind === "replay") {
    return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
  }
  const loaded = await loadMutableAgentTask(ctx, {
    authorization: authorization.authorization,
    key: args.key,
    revision: args.revision,
    ...(args.fence === undefined ? {} : { fence: args.fence }),
    now,
    requestId: args.requestId,
  });
  if (!loaded.ok) return loaded.result;
  const blocker = await taskByKey(ctx, loaded.task.workspaceId, args.blockerKey);
  if (blocker === null) return domainFailure("NOT_FOUND", args.requestId);
  if (!taskMatchesTenant(blocker, authorization.authorization)) {
    await queueTaskProjectionRepair(ctx, loaded.task, now);
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: loaded.task.key,
      currentRevision: loaded.task.revision,
    });
  }
  if (blocker._id === loaded.task._id) {
    return domainFailure("DEPENDENCY_CYCLE", args.requestId, {
      taskKey: loaded.task.key,
      currentRevision: loaded.task.revision,
    });
  }
  const projection = await ensureCounterProjection(ctx, loaded.task, now, args.requestId);
  if (!projection.ok) return projection;
  const existing = await ctx.db
    .query("taskDependencies")
    .withIndex("by_workspace_blocker_blocked", (query) =>
      query
        .eq("workspaceId", loaded.task.workspaceId)
        .eq("blockerTaskId", blocker._id)
        .eq("blockedTaskId", loaded.task._id),
    )
    .unique();
  if (existing !== null && !dependencyMatchesTasks(existing, blocker, loaded.task)) {
    await queueTaskProjectionRepair(ctx, loaded.task, now);
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: loaded.task.key,
      currentRevision: loaded.task.revision,
    });
  }
  if (!args.remove && existing !== null) {
    return domainFailure("DEPENDENCY_DUPLICATE", args.requestId, {
      taskKey: loaded.task.key,
      currentRevision: loaded.task.revision,
    });
  }
  if (args.remove && existing === null) return domainFailure("NOT_FOUND", args.requestId);
  if (!args.remove) {
    const blockers = await blockerRows(ctx, loaded.task);
    if (blockers.length >= MAX_DIRECT_BLOCKERS) {
      return domainFailure("BLOCKER_LIMIT", args.requestId, {
        taskKey: loaded.task.key,
        currentRevision: loaded.task.revision,
        blockingCount: blockers.length,
      });
    }
    const dependents = await ctx.db
      .query("taskDependencies")
      .withIndex("by_workspace_blocker_created", (query) =>
        query.eq("workspaceId", blocker.workspaceId).eq("blockerTaskId", blocker._id),
      )
      .take(MAX_BLOCKING_DEPENDENTS + 1);
    for (const dependent of dependents) {
      const blockedTask = await ctx.db.get(dependent.blockedTaskId);
      if (blockedTask === null || !dependencyMatchesTasks(dependent, blocker, blockedTask)) {
        await queueTaskProjectionRepair(ctx, loaded.task, now);
        return domainFailure("PROJECTION_MISMATCH", args.requestId, {
          taskKey: loaded.task.key,
          currentRevision: loaded.task.revision,
        });
      }
    }
    if (dependents.length >= MAX_BLOCKING_DEPENDENTS) {
      return domainFailure("DEPENDENT_LIMIT", args.requestId, {
        taskKey: blocker.key,
        currentRevision: blocker.revision,
        blockingCount: dependents.length,
      });
    }
    const cycle = await validateDependencyCycleIntegrityDb(
      ctx,
      loaded.task.workspaceId,
      blocker._id,
      loaded.task._id,
    );
    if (cycle.kind === "cycle") {
      return domainFailure("DEPENDENCY_CYCLE", args.requestId, {
        taskKey: loaded.task.key,
        currentRevision: loaded.task.revision,
      });
    }
    if (cycle.kind === "projection_mismatch") {
      await queueTaskProjectionRepair(ctx, loaded.task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: loaded.task.key,
        currentRevision: loaded.task.revision,
      });
    }
    if (cycle.kind === "limit") {
      return domainFailure("GRAPH_VALIDATION_LIMIT", args.requestId, {
        taskKey: loaded.task.key,
        currentRevision: loaded.task.revision,
        exhaustedLimit: cycle.exhaustedLimit,
      });
    }
  }
  const actor = agentActor(authorization.authorization);
  let dependency: Doc<"taskDependencies">;
  if (args.remove) {
    if (existing === null) return domainFailure("NOT_FOUND", args.requestId);
    dependency = existing;
    await ctx.db.delete(existing._id);
  } else {
    const dependencyId = await ctx.db.insert("taskDependencies", {
      organizationId: loaded.task.organizationId,
      workspaceId: loaded.task.workspaceId,
      blockerTaskId: blocker._id,
      blockedTaskId: loaded.task._id,
      kind: "blocks",
      createdBy: actor,
      createdAt: now,
    });
    const created = await ctx.db.get(dependencyId);
    if (created === null) throw new Error("Dependency disappeared.");
    dependency = created;
  }
  const contribution = blockerContribution(blocker.status);
  const unresolved =
    loaded.task.unresolvedBlockerCount + (args.remove ? -contribution.unresolved : contribution.unresolved);
  const cancelled =
    loaded.task.cancelledBlockerCount + (args.remove ? -contribution.cancelled : contribution.cancelled);
  if (unresolved < 0 || cancelled < 0) {
    await queueTaskProjectionRepair(ctx, loaded.task, now);
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: loaded.task.key,
      blockingCount: loaded.task.unresolvedBlockerCount + loaded.task.cancelledBlockerCount,
      currentRevision: loaded.task.revision,
    });
  }
  const ready = derivedReady({
    status: loaded.task.status,
    availableAt: loaded.task.availableAt,
    now,
    unresolved,
    cancelled,
  });
  await ctx.db.patch(loaded.task._id, {
    unresolvedBlockerCount: unresolved,
    cancelledBlockerCount: cancelled,
    isBlocked: unresolved + cancelled > 0,
    isReady: ready,
    ...(ready ? { readySince: loaded.task.readySince ?? now } : { readySince: undefined }),
    needsAttention: derivedNeedsAttention({
      status: loaded.task.status,
      unresolved,
      cancelled,
    }),
    revision: loaded.task.revision + 1,
    reviewRevision: loaded.task.reviewRevision + 1,
    lastEditedBy: actor,
    updatedAt: now,
  });
  await appendTaskEvent(ctx, {
    organizationId: loaded.task.organizationId,
    workspaceId: loaded.task.workspaceId,
    taskId: loaded.task._id,
    taskPublicId: loaded.task.publicId,
    taskRevision: loaded.task.revision + 1,
    type: args.remove ? "dependency.removed" : "dependency.added",
    actor,
    command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
    payload: { blockerTaskId: blocker.publicId, blockedTaskId: loaded.task.publicId },
    now,
  });
  const updated = await ctx.db.get(loaded.task._id);
  if (updated === null) throw new Error("Dependency task disappeared.");
  const view = await dependencyView(ctx, dependency);
  if (view === null) throw new Error("Dependency view disappeared.");
  const data = { dependency: view, task: taskView(updated) };
  await storeReceipt(ctx, {
    identity: receiptIdentity(authorization.authorization),
    operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    data,
    now,
  });
  await touchAuthorizedAgent(ctx, authorization.authorization, now);
  return { ok: true as const, data, requestId: args.requestId };
}

const taskDependencyArgs = {
  credentialId: v.id("agentCredentials"),
  sessionPublicId: v.string(),
  key: v.string(),
  blockerKey: v.string(),
  revision: v.number(),
  fence: v.optional(v.number()),
  idempotencyKey: v.string(),
  requestDigest: v.string(),
  requestId: v.string(),
};

export const addTaskDependency = internalMutation({
  args: taskDependencyArgs,
  returns: dependencyResultValidator,
  handler: async (ctx, args) => await mutateTaskDependency(ctx, { ...args, remove: false }),
});

export const removeTaskDependency = internalMutation({
  args: taskDependencyArgs,
  returns: dependencyResultValidator,
  handler: async (ctx, args) => await mutateTaskDependency(ctx, { ...args, remove: true }),
});

function encodeOffsetCursor(value: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeOffsetCursor(
  value: string | undefined,
  expected: { readonly workspaceId: string; readonly taskId: string; readonly direction: string },
) {
  if (value === undefined) return 0;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(`${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`), (character) =>
        character.charCodeAt(0),
      ),
    );
    const parsed = JSON.parse(decoded) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("workspaceId" in parsed) ||
      parsed.workspaceId !== expected.workspaceId ||
      !("taskId" in parsed) ||
      parsed.taskId !== expected.taskId ||
      !("direction" in parsed) ||
      parsed.direction !== expected.direction ||
      !("offset" in parsed) ||
      typeof parsed.offset !== "number" ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      return null;
    }
    return parsed.offset;
  } catch {
    return null;
  }
}

export const listTaskDependencies = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    direction: v.union(v.literal("blockers"), v.literal("dependents"), v.literal("both")),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: dependencyListResultValidator,
  handler: async (ctx, args) => {
    if (!validPage(args.limit, args.cursor)) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (!taskMatchesTenant(task, authorization.authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const offset = decodeOffsetCursor(args.cursor, {
      workspaceId: authorization.authorization.workspacePublicId,
      taskId: task.publicId,
      direction: args.direction,
    });
    if (offset === null) return domainFailure("VALIDATION_ERROR", args.requestId);
    const rows = [];
    if (args.direction !== "dependents") {
      rows.push(...(await ctx.db
        .query("taskDependencies")
        .withIndex("by_workspace_blocked_created", (query) =>
          query.eq("workspaceId", task.workspaceId).eq("blockedTaskId", task._id),
        )
        .take(MAX_DIRECT_BLOCKERS + 1)));
    }
    if (args.direction !== "blockers") {
      rows.push(...(await ctx.db
        .query("taskDependencies")
        .withIndex("by_workspace_blocker_created", (query) =>
          query.eq("workspaceId", task.workspaceId).eq("blockerTaskId", task._id),
        )
        .take(MAX_BLOCKING_DEPENDENTS + 1)));
    }
    if (rows.length > MAX_DIRECT_BLOCKERS + MAX_BLOCKING_DEPENDENTS) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    rows.sort((left, right) => left.createdAt - right.createdAt || String(left._id).localeCompare(String(right._id)));
    const views = new Map<string, NonNullable<Awaited<ReturnType<typeof dependencyView>>>>();
    for (const row of rows) {
      const view = await dependencyView(ctx, row);
      if (view === null) return domainFailure("PROJECTION_MISMATCH", args.requestId);
      views.set(String(row._id), view);
    }
    const selected = rows.slice(offset, offset + args.limit);
    const dependencies = selected.flatMap((row) => {
      const view = views.get(String(row._id));
      return view === undefined ? [] : [view];
    });
    const nextOffset = offset + selected.length;
    return {
      ok: true as const,
      data: {
        dependencies,
        cursor:
          nextOffset >= rows.length
            ? null
            : encodeOffsetCursor({
                workspaceId: authorization.authorization.workspacePublicId,
                taskId: task.publicId,
                direction: args.direction,
                offset: nextOffset,
              }),
      },
      requestId: args.requestId,
    };
  },
});

async function mutateTaskParent(
  ctx: MutationCtx,
  args: {
    credentialId: Id<"agentCredentials">;
    sessionPublicId: string;
    key: string;
    revision: number;
    parentKey?: string;
    fence?: number;
    idempotencyKey: string;
    requestDigest: string;
    requestId: string;
    clear: boolean;
  },
) {
  const now = Date.now();
  const metadata = assertRequestMetadata({ ...args, now });
  if (!metadata.ok) return { ok: false as const, error: metadata.error };
  const authorization = await authorizeAgent(ctx, {
    ...args,
    requiredScope: "dependencies:write",
    now,
  });
  if (!authorization.ok) return { ok: false as const, error: authorization.error };
  const rateLimitFailure = await consumeAgentWriteRateLimit(
    ctx,
    authorization.authorization,
    "agent_write",
    args.requestId,
    now,
  );
  if (rateLimitFailure !== null) return rateLimitFailure;
  const operation = args.clear ? "tasks.parent.clear" : "tasks.parent.set";
  const receipt = await lookupReceipt(ctx, {
    identity: receiptIdentity(authorization.authorization),
    operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    parse: parseTaskMutationData,
  });
  if (receipt.kind === "failure") return receipt.result;
  if (receipt.kind === "replay") {
    return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
  }
  const loaded = await loadMutableAgentTask(ctx, {
    authorization: authorization.authorization,
    key: args.key,
    revision: args.revision,
    ...(args.fence === undefined ? {} : { fence: args.fence }),
    now,
    requestId: args.requestId,
  });
  if (!loaded.ok) return loaded.result;
  let parent: TaskDoc | null = null;
  if (!args.clear) {
    if (args.parentKey === undefined) return domainFailure("VALIDATION_ERROR", args.requestId);
    parent = await taskByKey(ctx, loaded.task.workspaceId, args.parentKey);
    if (parent === null) return domainFailure("NOT_FOUND", args.requestId);
    if (!taskMatchesTenant(parent, authorization.authorization)) {
      await queueTaskProjectionRepair(ctx, loaded.task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: loaded.task.key,
        currentRevision: loaded.task.revision,
      });
    }
    const validation = await validateParentChain(ctx, loaded.task._id, parent);
    if (validation === "cycle") {
      return domainFailure("HIERARCHY_CYCLE", args.requestId, {
        taskKey: loaded.task.key,
        currentRevision: loaded.task.revision,
      });
    }
    if (validation === "limit") {
      return domainFailure("GRAPH_VALIDATION_LIMIT", args.requestId, {
        taskKey: loaded.task.key,
        currentRevision: loaded.task.revision,
        exhaustedLimit: "parent_depth",
      });
    }
    if (validation === "projection_mismatch") {
      await queueTaskProjectionRepair(ctx, loaded.task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: loaded.task.key,
        currentRevision: loaded.task.revision,
      });
    }
    if (loaded.task.parentTaskId === parent._id) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: loaded.task.key,
        currentRevision: loaded.task.revision,
      });
    }
  } else if (loaded.task.parentTaskId === undefined) {
    return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
      taskKey: loaded.task.key,
      currentRevision: loaded.task.revision,
    });
  }
  const actor = agentActor(authorization.authorization);
  await ctx.db.patch(loaded.task._id, {
    parentTaskId: parent?._id,
    revision: loaded.task.revision + 1,
    reviewRevision: loaded.task.reviewRevision + 1,
    lastEditedBy: actor,
    updatedAt: now,
  });
  await appendTaskEvent(ctx, {
    organizationId: loaded.task.organizationId,
    workspaceId: loaded.task.workspaceId,
    taskId: loaded.task._id,
    taskPublicId: loaded.task.publicId,
    taskRevision: loaded.task.revision + 1,
    type: args.clear ? "task.parent_cleared" : "task.parent_set",
    actor,
    command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
    payload: parent === null ? {} : { parentTaskId: parent.publicId },
    now,
  });
  const updated = await ctx.db.get(loaded.task._id);
  if (updated === null) throw new Error("Parent task disappeared.");
  return await finishTaskDetailMutation(ctx, {
    authorization: authorization.authorization,
    task: updated,
    operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    now,
  });
}

const taskParentArgs = {
  credentialId: v.id("agentCredentials"),
  sessionPublicId: v.string(),
  key: v.string(),
  revision: v.number(),
  fence: v.optional(v.number()),
  idempotencyKey: v.string(),
  requestDigest: v.string(),
  requestId: v.string(),
};

export const setTaskParent = internalMutation({
  args: { ...taskParentArgs, parentKey: v.string() },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => await mutateTaskParent(ctx, { ...args, clear: false }),
});

export const clearTaskParent = internalMutation({
  args: taskParentArgs,
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => await mutateTaskParent(ctx, { ...args, clear: true }),
});

export const getTaskGraph = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    depth: v.number(),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: graphResultValidator,
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.depth) ||
      args.depth < 1 ||
      args.depth > MAX_PARENT_DEPTH ||
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > MAX_GRAPH_VISITED_TASKS
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const root = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (root === null) return domainFailure("NOT_FOUND", args.requestId);
    if (!taskMatchesTenant(root, authorization.authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const tasks = new Map<string, TaskDoc>([[String(root._id), root]]);
    const dependencies = new Map<string, Doc<"taskDependencies">>();
    const queue: Array<{ readonly task: TaskDoc; readonly depth: number }> = [
      { task: root, depth: 0 },
    ];
    let examinedEdges = 0;
    let truncated = false;
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const remaining = MAX_GRAPH_EXAMINED_EDGES - examinedEdges;
      if (remaining <= 0) {
        return domainFailure("GRAPH_VALIDATION_LIMIT", args.requestId, {
          taskKey: root.key,
          currentRevision: root.revision,
          exhaustedLimit: "examined_edges",
        });
      }
      const outgoing = await ctx.db
        .query("taskDependencies")
        .withIndex("by_workspace_blocker_created", (query) =>
          query
            .eq("workspaceId", root.workspaceId)
            .eq("blockerTaskId", current.task._id),
        )
        .take(remaining + 1);
      if (outgoing.length > remaining) {
        return domainFailure("GRAPH_VALIDATION_LIMIT", args.requestId, {
          taskKey: root.key,
          currentRevision: root.revision,
          exhaustedLimit: "examined_edges",
        });
      }
      examinedEdges += outgoing.length;
      const incomingRemaining = MAX_GRAPH_EXAMINED_EDGES - examinedEdges;
      const incoming = await ctx.db
        .query("taskDependencies")
        .withIndex("by_workspace_blocked_created", (query) =>
          query
            .eq("workspaceId", root.workspaceId)
            .eq("blockedTaskId", current.task._id),
        )
        .take(incomingRemaining + 1);
      if (incoming.length > incomingRemaining) {
        return domainFailure("GRAPH_VALIDATION_LIMIT", args.requestId, {
          taskKey: root.key,
          currentRevision: root.revision,
          exhaustedLimit: "examined_edges",
        });
      }
      examinedEdges += incoming.length;
      const adjacent = [...outgoing, ...incoming];
      for (const edge of adjacent) {
        const [blocker, blocked] = await Promise.all([
          ctx.db.get(edge.blockerTaskId),
          ctx.db.get(edge.blockedTaskId),
        ]);
        if (
          blocker === null ||
          blocked === null ||
          !dependencyMatchesTasks(edge, blocker, blocked) ||
          !taskMatchesTenant(blocker, authorization.authorization) ||
          !taskMatchesTenant(blocked, authorization.authorization)
        ) {
          return domainFailure("PROJECTION_MISMATCH", args.requestId);
        }
        dependencies.set(String(edge._id), edge);
        const neighbor = edge.blockerTaskId === current.task._id ? blocked : blocker;
        const neighborId = neighbor._id;
        if (tasks.has(String(neighborId))) continue;
        if (current.depth >= args.depth) {
          truncated = true;
          continue;
        }
        if (tasks.size >= args.limit) {
          truncated = true;
          continue;
        }
        tasks.set(String(neighbor._id), neighbor);
        queue.push({ task: neighbor, depth: current.depth + 1 });
      }
    }
    const visibleDependencies = [];
    for (const dependency of dependencies.values()) {
      if (
        !tasks.has(String(dependency.blockerTaskId)) ||
        !tasks.has(String(dependency.blockedTaskId))
      ) {
        continue;
      }
      const view = await dependencyView(ctx, dependency);
      if (view === null) return domainFailure("PROJECTION_MISMATCH", args.requestId);
      visibleDependencies.push(view);
    }
    visibleDependencies.sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.blockerKey.localeCompare(right.blockerKey) ||
        left.blockedKey.localeCompare(right.blockedKey),
    );
    const nodes = [...tasks.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key))
      .map(taskView);
    return {
      ok: true as const,
      data: { rootKey: root.key, nodes, dependencies: visibleDependencies, truncated },
      requestId: args.requestId,
    };
  },
});

export const listTaskEvents = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: eventListResultValidator,
  handler: async (ctx, args) => {
    if (!validPage(args.limit, args.cursor)) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (!taskMatchesTenant(task, authorization.authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const page = await ctx.db
      .query("taskEvents")
      .withIndex("by_workspace_and_task", (query) =>
        query.eq("workspaceId", task.workspaceId).eq("taskId", task._id),
      )
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    if (page.page.some((event) => !taskRelationMatches(task, event))) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const events = page.page.flatMap((event) =>
      event.publicId === undefined
        ? []
        : [{
            id: event.publicId,
            organizationId: authorization.authorization.organizationPublicId,
            workspaceId: authorization.authorization.workspacePublicId,
            taskId: event.taskPublicId,
            taskRevision: event.taskRevision,
            schemaVersion: 1 as const,
            type: event.type,
            actor: publicActor(event.actor),
            command: event.command,
            payload: event.payload,
            createdAt: event.createdAt,
          }],
    );
    return {
      ok: true as const,
      data: { events, cursor: nextCursor(page) },
      requestId: args.requestId,
    };
  },
});

function evidenceHasSafeUrls(evidence: readonly SubmissionEvidenceInput[]): boolean {
  return evidence.every((item) => {
    if (item.kind === "test" || item.kind === "note") return true;
    if (item.kind === "commit") {
      return item.url === undefined || isCredentialFreeHttpsUrl(item.url);
    }
    return isCredentialFreeHttpsUrl(item.url);
  });
}

export async function pendingSubmissionsForTask(ctx: ReadCtx, task: TaskDoc) {
  return await ctx.db
    .query("taskSubmissions")
    .withIndex("by_workspace_task_status_submitted", (builder) =>
      builder
        .eq("workspaceId", task.workspaceId)
        .eq("taskId", task._id)
        .eq("status", "pending"),
    )
    .take(2);
}

async function authorizeReviewer(
  ctx: ReadCtx,
  args: { readonly workspacePublicId: string; readonly requestId: string },
) {
  const authorized = await authorizeWorkspaceHuman(ctx, args);
  if (!authorized.ok) return authorized;
  if (
    authorized.authorization.role !== "owner" &&
    authorized.authorization.role !== "admin" &&
    authorized.authorization.workspaceMembership?.roles.includes("reviewer") !== true
  ) {
    return domainFailure("WORKSPACE_ROLE_REQUIRED", args.requestId);
  }
  return authorized;
}

async function loadReviewQueuePage(
  ctx: ReadCtx,
  args: {
    readonly organizationId: Id<"organizations">;
    readonly workspaceId: Id<"workspaces">;
    readonly cursor?: string;
    readonly limit: number;
    readonly requestId: string;
  },
) {
  if (!validPage(args.limit, args.cursor)) return domainFailure("VALIDATION_ERROR", args.requestId);
  const page = await ctx.db
    .query("taskSubmissions")
    .withIndex("by_workspace_status_submitted", (builder) =>
      builder.eq("workspaceId", args.workspaceId).eq("status", "pending"),
    )
    .order("asc")
    .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
  const reviews = [];
  for (const submission of page.page) {
    const task = await ctx.db.get(submission.taskId);
    const pending = task === null ? [] : await pendingSubmissionsForTask(ctx, task);
    if (
      task === null ||
      task.organizationId !== args.organizationId ||
      task.workspaceId !== args.workspaceId ||
      !submissionHasTaskOwnership(task, submission) ||
      pending.length !== 1 ||
      pending[0]?._id !== submission._id ||
      task.status !== "in_review" ||
      task.currentClaim !== undefined ||
      task.reviewRevision !== submission.reviewRevision
    ) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    reviews.push({ task: taskView(task), submission: submissionView(submission, task.key) });
  }
  return {
    ok: true as const,
    data: { reviews, cursor: nextCursor(page) },
    requestId: args.requestId,
  };
}

export const listReviewQueue = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: reviewQueueResultValidator,
  handler: async (ctx, args) => {
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:review",
      now: Date.now(),
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    return await loadReviewQueuePage(ctx, {
      organizationId: authorization.authorization.organizationId,
      workspaceId: authorization.authorization.workspaceId,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      limit: args.limit,
      requestId: args.requestId,
    });
  },
});

const HUMAN_QUERY_REQUEST_ID = "req_00000000000000000000000000";

export const reviewQueueForHuman = query({
  args: { workspaceId: v.string(), cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: reviewQueueResultValidator,
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const authorized = await authorizeReviewer(ctx, {
      workspacePublicId: args.workspaceId,
      requestId: HUMAN_QUERY_REQUEST_ID,
    });
    if (!authorized.ok) return { ok: false as const, error: authorized.error };
    return await loadReviewQueuePage(ctx, {
      organizationId: authorized.authorization.organization._id,
      workspaceId: authorized.authorization.workspace._id,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      limit,
      requestId: HUMAN_QUERY_REQUEST_ID,
    });
  },
});

export const submitTask = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    fence: v.number(),
    expectedReviewRevision: v.optional(v.number()),
    dispatch: v.optional(v.object({
      runId: v.string(),
      runnerId: v.string(),
      bootId: v.string(),
      claimId: v.string(),
      claimFence: v.number(),
    })),
    summary: v.string(),
    evidence: v.array(submissionEvidenceValidator),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: submitResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const parsed = submitTaskRequestSchema.safeParse({
      fence: args.fence,
      ...(args.expectedReviewRevision === undefined
        ? {}
        : { expectedReviewRevision: args.expectedReviewRevision }),
      ...(args.dispatch === undefined ? {} : { dispatch: args.dispatch }),
      summary: args.summary,
      evidence: args.evidence,
    });
    if (
      !parsed.success ||
      parsed.data.evidence.length > MAX_SUBMISSION_EVIDENCE ||
      new TextEncoder().encode(parsed.data.summary).length > MAX_SUBMISSION_SUMMARY_BYTES ||
      !evidenceHasSafeUrls(parsed.data.evidence)
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:submit",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = await consumeAgentWriteRateLimit(
      ctx,
      authorization.authorization,
      "agent_review",
      args.requestId,
      now,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.submit",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseSubmitData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (!taskMatchesTenant(task, authorization.authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const dispatchAuthorized = authorization.authorization.scopes.includes("dispatch:execute");
    if (dispatchAuthorized && args.expectedReviewRevision === undefined) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    if (
      args.expectedReviewRevision !== undefined &&
      !dispatchSubmissionInputRevisionMatches(task.reviewRevision, args.expectedReviewRevision)
    ) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    if ((await taskDetail(ctx, task)) === null) {
      await queueTaskProjectionRepair(ctx, task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    const claimDisposition = claimCommandDisposition({
      command: "submit",
      taskStatus: task.status,
      hasCurrentClaim: task.currentClaim !== undefined,
      ...(task.currentClaim === undefined
        ? {}
        : {
            currentAgentId: task.currentClaim.agentId,
            currentFence: task.currentClaim.fence,
            currentLeaseUntil: task.currentClaim.leaseUntil,
          }),
      authorizedAgentId: authorization.authorization.agentId,
      requestedFence: args.fence,
      now,
    });
    if (claimDisposition.kind === "task_state_conflict") {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    if (claimDisposition.kind === "claim_not_owned") {
      return domainFailure("CLAIM_NOT_OWNED", args.requestId, {
        taskKey: task.key,
        fence: args.fence,
      });
    }
    if (claimDisposition.kind === "claim_stale") {
      return domainFailure("CLAIM_STALE", args.requestId, {
        taskKey: task.key,
        fence: task.currentClaim?.fence ?? args.fence,
        currentRevision: task.revision,
      });
    }
    if (claimDisposition.kind === "lease_not_renewable") {
      throw new Error("Submit claim classification returned a renewal-only disposition.");
    }
    if (task.currentClaim === undefined) {
      throw new Error("Allowed submission lost its compact claim.");
    }
    const claim = await ctx.db.get(task.currentClaim.claimId);
    if (
      claim === null ||
      claim.organizationId !== task.organizationId ||
      claim.workspaceId !== task.workspaceId ||
      claim.taskId !== task._id ||
      claim.state !== "active" ||
      claim.publicId !== task.currentClaim.publicId ||
      claim.agentId !== task.currentClaim.agentId ||
      claim.agentPublicId !== task.currentClaim.agentPublicId ||
      claim.fence !== task.currentClaim.fence ||
      claim.leaseGeneration !== task.currentClaim.leaseGeneration ||
      claim.leaseUntil !== task.currentClaim.leaseUntil
    ) {
      await queueTaskClaimRepair(ctx, task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    const claimDispatchState = await taskClaimDispatchState(ctx, task, claim);
    if (claimDispatchState === "corrupt") {
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    if (claimDispatchState === "bound" && parsed.data.dispatch === undefined) {
      return domainFailure("CLAIM_STALE", args.requestId, {
        taskKey: task.key,
        fence: args.fence,
        currentRevision: task.revision,
      });
    }
    if (parsed.data.dispatch !== undefined) {
      const authorityState = await dispatchSubmissionAuthorityState(
        ctx,
        authorization.authorization,
        task,
        claim,
        parsed.data.dispatch,
        now,
      );
      if (authorityState === "corrupt") {
        return domainFailure("PROJECTION_MISMATCH", args.requestId, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      if (authorityState === "stale") {
        return domainFailure("CLAIM_STALE", args.requestId, {
          taskKey: task.key,
          fence: args.fence,
          currentRevision: task.revision,
        });
      }
    }
    const projection = await ensureCounterProjection(ctx, task, now, args.requestId);
    if (!projection.ok) return projection;
    const blockingCount = projection.actual.unresolved + projection.actual.cancelled;
    if (blockingCount > 0) {
      return domainFailure("TASK_BLOCKED", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
        blockingCount,
      });
    }
    const existingPending = await pendingSubmissionsForTask(ctx, task);
    if (existingPending.length !== 0) {
      await queueTaskReviewRepair(ctx, task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    const actor = agentActor(authorization.authorization);
    const publicId = randomPublicId("sub");
    const submissionId = await ctx.db.insert("taskSubmissions", {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      publicId,
      ...(parsed.data.dispatch === undefined
        ? {}
        : { dispatchPublicId: parsed.data.dispatch.runId }),
      submittedBy: actor,
      reviewRevision: task.reviewRevision,
      summary: parsed.data.summary,
      evidence: normalizeSubmissionEvidence(parsed.data.evidence),
      status: "pending",
      submittedAt: now,
    });
    await ctx.db.patch(claim._id, { state: "submitted", endedAt: now, updatedAt: now });
    const nextRevision = task.revision + 1;
    await ctx.db.patch(task._id, {
      status: "in_review",
      currentClaim: undefined,
      isReady: false,
      readySince: undefined,
      submittedAt: now,
      revision: nextRevision,
      lastEditedBy: actor,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: nextRevision,
      type: "task.submitted",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { submissionId: publicId },
      now,
    });
    const [updatedTask, submission] = await Promise.all([
      ctx.db.get(task._id),
      ctx.db.get(submissionId),
    ]);
    if (updatedTask === null || submission === null) {
      throw new Error("Submitted task or immutable submission disappeared.");
    }
    const data = { task: taskView(updatedTask), submission: submissionView(submission, task.key) };
    await storeReceipt(ctx, {
      identity,
      operation: "tasks.submit",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    await touchAuthorizedAgent(ctx, authorization.authorization, now);
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export function pendingSubmissionBase(submission: SubmissionDoc) {
  return {
    organizationId: submission.organizationId,
    workspaceId: submission.workspaceId,
    taskId: submission.taskId,
    publicId: submission.publicId,
    submittedBy: submission.submittedBy,
    reviewRevision: submission.reviewRevision,
    summary: submission.summary,
    evidence: submission.evidence,
    submittedAt: submission.submittedAt,
  };
}

export async function reviewSubmissionTransition(
  ctx: MutationCtx,
  args: {
    readonly organizationId?: Id<"organizations">;
    readonly workspaceId: Id<"workspaces">;
    readonly key: string;
    readonly submissionPublicId: string;
    readonly reviewRevision: number;
    readonly action: "accept" | "reject";
    readonly reason?: string;
    readonly actor: PersistedActor;
    readonly reviewerAgentPublicId?: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly now: number;
  },
): Promise<
  | { readonly ok: false; readonly error: DomainError }
  | { readonly ok: true; readonly data: SubmissionMutationData }
> {
  const parsedReason =
    args.action === "reject" ? reviewReasonSchema.safeParse(args.reason) : null;
  if (args.action === "reject" && (parsedReason === null || !parsedReason.success)) {
    return domainFailure("VALIDATION_ERROR", args.requestId);
  }
  const rejectionReason = parsedReason?.success === true ? parsedReason.data : undefined;
  const task = await taskByKey(ctx, args.workspaceId, args.key);
  if (task === null) return domainFailure("NOT_FOUND", args.requestId);
  if (
    args.organizationId !== undefined &&
    (task.organizationId !== args.organizationId || task.workspaceId !== args.workspaceId)
  ) {
    return domainFailure("PROJECTION_MISMATCH", args.requestId);
  }
  if (task.status !== "in_review" || task.currentClaim !== undefined) {
    if (task.status === "in_review") await queueTaskReviewRepair(ctx, task, args.now);
    return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  const pending = await pendingSubmissionsForTask(ctx, task);
  if (pending.length !== 1 || pending[0] === undefined) {
    await queueTaskReviewRepair(ctx, task, args.now);
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  const submission = pending[0];
  if (!submissionHasTaskOwnership(task, submission)) {
    await queueTaskReviewRepair(ctx, task, args.now);
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  if (submission.publicId !== args.submissionPublicId) {
    return domainFailure("SUBMISSION_STALE", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  if (
    submission.reviewRevision !== args.reviewRevision ||
    task.reviewRevision !== args.reviewRevision
  ) {
    await queueTaskReviewRepair(ctx, task, args.now);
    return domainFailure("SUBMISSION_STALE", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  if (
    !reviewActorAllowed({
      submittedByAgentId: submission.submittedBy.agentId,
      ...(args.reviewerAgentPublicId === undefined
        ? {}
        : { reviewerAgentId: args.reviewerAgentPublicId }),
    })
  ) {
    return domainFailure("SELF_REVIEW_DENIED", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  const projection = await ensureCounterProjection(ctx, task, args.now, args.requestId);
  if (!projection.ok) return projection;
  const blockingCount = projection.actual.unresolved + projection.actual.cancelled;
  if (!reviewAcceptanceAllowed({ action: args.action, blockingCount })) {
    return domainFailure("TASK_BLOCKED", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
      blockingCount,
    });
  }
  const nextSubmissionStatus = transitionSubmissionLifecycle(submission.status, args.action);
  if (nextSubmissionStatus === null) {
    await queueTaskReviewRepair(ctx, task, args.now);
    return domainFailure("PROJECTION_MISMATCH", args.requestId, {
      taskKey: task.key,
      currentRevision: task.revision,
    });
  }
  let usage: Doc<"workspaceUsage"> | null = null;
  if (args.action === "accept") {
    usage = await activeWorkspaceUsage(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
    });
    if (usage === null) return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
    if (usage.activeTasks <= 0) return domainFailure("INTERNAL_ERROR", args.requestId);
    const propagated = await propagateBlockerTransition(ctx, {
      blocker: task,
      previousStatus: "in_review",
      nextStatus: "done",
      directBlockerCount: projection.actual.total,
      actor: args.actor,
      idempotencyKey: args.idempotencyKey,
      requestId: args.requestId,
      now: args.now,
    });
    if (!propagated.ok) return { ok: false, error: propagated.error };
  }
  const nextRevision = task.revision + 1;
  if (args.action === "accept") {
    if (nextSubmissionStatus !== "accepted") {
      throw new Error("Accepted review produced an invalid submission lifecycle.");
    }
    await ctx.db.replace(submission._id, {
      ...pendingSubmissionBase(submission),
      status: nextSubmissionStatus,
      reviewedBy: args.actor,
      reviewedAt: args.now,
    });
    await ctx.db.patch(task._id, {
      status: "done",
      isReady: false,
      isBlocked: false,
      readySince: undefined,
      needsAttention: false,
      completedAt: args.now,
      cancelledAt: undefined,
      revision: nextRevision,
      lastEditedBy: args.actor,
      updatedAt: args.now,
    });
    if (usage === null) throw new Error("Accepted task lost its usage row.");
    await ctx.db.patch(usage._id, { activeTasks: usage.activeTasks - 1, updatedAt: args.now });
  } else {
    const reason = rejectionReason;
    if (reason === undefined) return domainFailure("VALIDATION_ERROR", args.requestId);
    if (nextSubmissionStatus !== "rejected") {
      throw new Error("Rejected review produced an invalid submission lifecycle.");
    }
    await ctx.db.replace(submission._id, {
      ...pendingSubmissionBase(submission),
      status: nextSubmissionStatus,
      reviewedBy: args.actor,
      reviewedAt: args.now,
      reviewReason: reason,
    });
    const ready = derivedReady({
      status: "open",
      availableAt: task.availableAt,
      now: args.now,
      unresolved: projection.actual.unresolved,
      cancelled: projection.actual.cancelled,
    });
    await ctx.db.patch(task._id, {
      status: "open",
      isReady: ready,
      isBlocked: blockingCount > 0,
      ...(ready ? { readySince: args.now } : { readySince: undefined }),
      needsAttention: derivedNeedsAttention({
        status: "open",
        unresolved: projection.actual.unresolved,
        cancelled: projection.actual.cancelled,
      }),
      submittedAt: undefined,
      completedAt: undefined,
      cancelledAt: undefined,
      revision: nextRevision,
      lastEditedBy: args.actor,
      updatedAt: args.now,
    });
  }
  await appendTaskEvent(ctx, {
    organizationId: task.organizationId,
    workspaceId: task.workspaceId,
    taskId: task._id,
    taskPublicId: task.publicId,
    taskRevision: nextRevision,
    type: args.action === "accept" ? "task.accepted" : "task.rejected",
    actor: args.actor,
    command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
    payload:
      args.action === "accept"
        ? { submissionId: submission.publicId }
        : { submissionId: submission.publicId, reason: (args.reason ?? "").slice(0, 1_000) },
    now: args.now,
  });
  const [updatedTask, updatedSubmission] = await Promise.all([
    ctx.db.get(task._id),
    ctx.db.get(submission._id),
  ]);
  if (updatedTask === null || updatedSubmission === null) {
    throw new Error("Reviewed task or immutable submission disappeared.");
  }
  return {
    ok: true,
    data: {
      task: taskView(updatedTask),
      submission: submissionView(updatedSubmission, task.key),
    },
  };
}

async function reviewTaskForAgent(
  ctx: MutationCtx,
  args: {
    readonly credentialId: Id<"agentCredentials">;
    readonly sessionPublicId: string;
    readonly key: string;
    readonly submissionPublicId: string;
    readonly reviewRevision: number;
    readonly action: "accept" | "reject";
    readonly reason?: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly requestId: string;
  },
) {
  const now = Date.now();
  const metadata = assertRequestMetadata({ ...args, now });
  if (!metadata.ok) return { ok: false as const, error: metadata.error };
  const authorization = await authorizeAgent(ctx, {
    ...args,
    requiredScope: "tasks:review",
    now,
  });
  if (!authorization.ok) return { ok: false as const, error: authorization.error };
  const rateLimitFailure = await consumeAgentWriteRateLimit(
    ctx,
    authorization.authorization,
    "agent_review",
    args.requestId,
    now,
  );
  if (rateLimitFailure !== null) return rateLimitFailure;
  const identity = receiptIdentity(authorization.authorization);
  const operation = args.action === "accept" ? "tasks.accept" : "tasks.reject";
  const receipt = await lookupReceipt(ctx, {
    identity,
    operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    parse: parseReviewData,
  });
  if (receipt.kind === "failure") return receipt.result;
  if (receipt.kind === "replay") {
    return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
  }
  const reviewed = await reviewSubmissionTransition(ctx, {
    organizationId: authorization.authorization.organizationId,
    workspaceId: authorization.authorization.workspaceId,
    key: args.key,
    submissionPublicId: args.submissionPublicId,
    reviewRevision: args.reviewRevision,
    action: args.action,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
    actor: agentActor(authorization.authorization),
    reviewerAgentPublicId: authorization.authorization.agentPublicId,
    idempotencyKey: args.idempotencyKey,
    requestId: args.requestId,
    now,
  });
  if (!reviewed.ok) return reviewed;
  await storeReceipt(ctx, {
    identity,
    operation,
    idempotencyKey: args.idempotencyKey,
    requestDigest: args.requestDigest,
    requestId: args.requestId,
    data: reviewed.data,
    now,
  });
  await touchAuthorizedAgent(ctx, authorization.authorization, now);
  return { ok: true as const, data: reviewed.data, requestId: args.requestId };
}

const agentReviewArgs = {
  credentialId: v.id("agentCredentials"),
  sessionPublicId: v.string(),
  key: v.string(),
  submissionPublicId: v.string(),
  reviewRevision: v.number(),
  idempotencyKey: v.string(),
  requestDigest: v.string(),
  requestId: v.string(),
};

export const acceptTask = internalMutation({
  args: agentReviewArgs,
  returns: reviewResultValidator,
  handler: async (ctx, args) => await reviewTaskForAgent(ctx, { ...args, action: "accept" }),
});

export const rejectTask = internalMutation({
  args: { ...agentReviewArgs, reason: v.string() },
  returns: reviewResultValidator,
  handler: async (ctx, args) => await reviewTaskForAgent(ctx, { ...args, action: "reject" }),
});

export const repairTaskProjection = internalMutation({
  args: { repairId: v.id("projectionRepairs"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repair = await ctx.db.get(args.repairId);
    if (
      repair === null ||
      repair.status !== "pending" ||
      repair.generation !== args.generation
    ) {
      return null;
    }
    const now = Date.now();
    const task = await ctx.db.get(repair.taskId);
    if (
      task === null ||
      task.workspaceId !== repair.workspaceId ||
      task.organizationId !== repair.organizationId
    ) {
      await ctx.db.patch(repair._id, { status: "stale", updatedAt: now });
      return null;
    }
    if (repair.kind === "task_claim") {
      const claim = task.currentClaim === undefined ? null : await ctx.db.get(task.currentClaim.claimId);
      const claimMatches =
        task.status === "in_progress" &&
        task.currentClaim !== undefined &&
        claim !== null &&
        claim.organizationId === task.organizationId &&
        claim.workspaceId === task.workspaceId &&
        claim.taskId === task._id &&
        claim.state === "active" &&
        claim.publicId === task.currentClaim.publicId &&
        claim.agentId === task.currentClaim.agentId &&
        claim.agentPublicId === task.currentClaim.agentPublicId &&
        claim.fence === task.currentClaim.fence &&
        claim.leaseGeneration === task.currentClaim.leaseGeneration &&
        claim.leaseUntil === task.currentClaim.leaseUntil;
      if (!claimMatches && (task.status === "in_progress" || task.currentClaim !== undefined)) {
        const actual = await actualBlockerCounters(ctx, task);
        if (actual === null) {
          await ctx.db.patch(repair._id, { status: "stale", updatedAt: now });
          return null;
        }
        await closeRecentOwnedActiveClaims(ctx, task, "expired", now);
        const ready = derivedReady({
          status: "open",
          availableAt: task.availableAt,
          now,
          unresolved: actual.unresolved,
          cancelled: actual.cancelled,
        });
        const actor = {
          kind: "system" as const,
          jobKind: "repair" as const,
          sourceId: `repair:${task.publicId}:${args.generation}`,
        };
        await ctx.db.patch(task._id, {
          status: "open",
          currentClaim: undefined,
          unresolvedBlockerCount: actual.unresolved,
          cancelledBlockerCount: actual.cancelled,
          isBlocked: actual.unresolved + actual.cancelled > 0,
          isReady: ready,
          ...(ready ? { readySince: task.readySince ?? now } : { readySince: undefined }),
          needsAttention: derivedNeedsAttention({
            status: "open",
            unresolved: actual.unresolved,
            cancelled: actual.cancelled,
          }),
          revision: task.revision + 1,
          lastEditedBy: actor,
          updatedAt: now,
        });
        await appendTaskEvent(ctx, {
          organizationId: task.organizationId,
          workspaceId: task.workspaceId,
          taskId: task._id,
          taskPublicId: task.publicId,
          taskRevision: task.revision + 1,
          type: "task.updated",
          actor,
          command: { kind: "system", jobKind: "repair" },
          payload: { fields: ["claim", "status"] },
          now,
        });
      }
      await ctx.db.patch(repair._id, { status: "completed", updatedAt: now });
      return null;
    }
    if (repair.kind === "task_review") {
      const pending = await ctx.db
        .query("taskSubmissions")
        .withIndex("by_workspace_task_status_submitted", (builder) =>
          builder
            .eq("workspaceId", task.workspaceId)
            .eq("taskId", task._id)
            .eq("status", "pending"),
        )
        .take(REVIEW_REPAIR_BATCH_SIZE + 1);
      const actor = {
        kind: "system" as const,
        jobKind: "repair" as const,
        sourceId: `repair:${task.publicId}:${args.generation}`,
      };
      if (pending.some((submission) => !submissionHasTaskOwnership(task, submission))) {
        await ctx.db.patch(repair._id, { status: "stale", updatedAt: now });
        return null;
      }
      const solePending = pending.length === 1 ? pending[0] : undefined;
      const consistentPending =
        task.status === "in_review" &&
        solePending !== undefined &&
        solePending.reviewRevision === task.reviewRevision;
      const mustTerminalizePending = !consistentPending;
      const reopeningProjection =
        task.status === "in_review" && !consistentPending
          ? await actualBlockerCounters(ctx, task)
          : undefined;
      if (reopeningProjection === null) {
        await ctx.db.patch(repair._id, { status: "stale", updatedAt: now });
        return null;
      }
      if (mustTerminalizePending) {
        for (const submission of pending.slice(0, REVIEW_REPAIR_BATCH_SIZE)) {
          await ctx.db.replace(submission._id, {
            ...pendingSubmissionBase(submission),
            status: "cancelled",
            cancelledBy: actor,
            cancelledAt: now,
            cancellationReason: REVIEW_REPAIR_CANCELLATION_REASON,
          });
        }
      }

      let taskChanged = false;
      if (task.status === "in_review" && !consistentPending) {
        const actual = reopeningProjection;
        if (actual === undefined) throw new Error("Review repair lost its reopening projection.");
        if (task.currentClaim !== undefined) {
          await closeRecentOwnedActiveClaims(ctx, task, "expired", now);
        }
        const ready = derivedReady({
          status: "open",
          availableAt: task.availableAt,
          now,
          unresolved: actual.unresolved,
          cancelled: actual.cancelled,
        });
        await ctx.db.patch(task._id, {
          status: "open",
          currentClaim: undefined,
          unresolvedBlockerCount: actual.unresolved,
          cancelledBlockerCount: actual.cancelled,
          isBlocked: actual.unresolved + actual.cancelled > 0,
          isReady: ready,
          ...(ready ? { readySince: now } : { readySince: undefined }),
          needsAttention: derivedNeedsAttention({
            status: "open",
            unresolved: actual.unresolved,
            cancelled: actual.cancelled,
          }),
          submittedAt: undefined,
          revision: task.revision + 1,
          lastEditedBy: actor,
          updatedAt: now,
        });
        taskChanged = true;
      } else if (consistentPending && task.currentClaim !== undefined) {
        await closeRecentOwnedActiveClaims(ctx, task, "submitted", now);
        await ctx.db.patch(task._id, {
          currentClaim: undefined,
          isReady: false,
          readySince: undefined,
          revision: task.revision + 1,
          lastEditedBy: actor,
          updatedAt: now,
        });
        taskChanged = true;
      }
      if (taskChanged) {
        await appendTaskEvent(ctx, {
          organizationId: task.organizationId,
          workspaceId: task.workspaceId,
          taskId: task._id,
          taskPublicId: task.publicId,
          taskRevision: task.revision + 1,
          type: "task.updated",
          actor,
          command: { kind: "system", jobKind: "repair" },
          payload: { fields: ["review", "claim", "status"] },
          now,
        });
      }
      if (mustTerminalizePending && pending.length > REVIEW_REPAIR_BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.workGraph.repairTaskProjection, args);
        return null;
      }
      await ctx.db.patch(repair._id, { status: "completed", updatedAt: now });
      return null;
    }
    if ((await taskDetail(ctx, task)) === null) {
      await ctx.db.patch(repair._id, { status: "stale", updatedAt: now });
      return null;
    }
    const actual = await actualBlockerCounters(ctx, task);
    if (actual === null) {
      await ctx.db.patch(repair._id, { status: "stale", updatedAt: now });
      return null;
    }
    const ready = derivedReady({
      status: task.status,
      availableAt: task.availableAt,
      now,
      unresolved: actual.unresolved,
      cancelled: actual.cancelled,
    });
    const changed =
      task.unresolvedBlockerCount !== actual.unresolved ||
      task.cancelledBlockerCount !== actual.cancelled ||
      task.isReady !== ready ||
      (task.needsAttention === true) !==
        derivedNeedsAttention({
          status: task.status,
          unresolved: actual.unresolved,
          cancelled: actual.cancelled,
        });
    if (changed) {
      await ctx.db.patch(task._id, {
        unresolvedBlockerCount: actual.unresolved,
        cancelledBlockerCount: actual.cancelled,
        isBlocked: actual.unresolved + actual.cancelled > 0,
        isReady: ready,
        ...(ready ? { readySince: task.readySince ?? now } : { readySince: undefined }),
        needsAttention: derivedNeedsAttention({
          status: task.status,
          unresolved: actual.unresolved,
          cancelled: actual.cancelled,
        }),
        revision: task.revision + 1,
        lastEditedBy: {
          kind: "system",
          jobKind: "repair",
          sourceId: `repair:${task.publicId}:${args.generation}`,
        },
        updatedAt: now,
      });
      await appendTaskEvent(ctx, {
        organizationId: task.organizationId,
        workspaceId: task.workspaceId,
        taskId: task._id,
        taskPublicId: task.publicId,
        taskRevision: task.revision + 1,
        type: "task.updated",
        actor: {
          kind: "system",
          jobKind: "repair",
          sourceId: `repair:${task.publicId}:${args.generation}`,
        },
        command: { kind: "system", jobKind: "repair" },
        payload: { fields: ["blockers"] },
        now,
      });
    }
    await ctx.db.patch(repair._id, { status: "completed", updatedAt: now });
    return null;
  },
});

async function authorizePlanner(
  ctx: ReadCtx,
  args: { readonly workspacePublicId: string; readonly requestId: string },
) {
  const authorized = await authorizeWorkspaceHuman(ctx, args);
  if (!authorized.ok) return authorized;
  if (
    authorized.authorization.role !== "owner" &&
    authorized.authorization.role !== "admin" &&
    authorized.authorization.workspaceMembership?.roles.includes("planner") !== true
  ) {
    return domainFailure("WORKSPACE_ROLE_REQUIRED", args.requestId);
  }
  return authorized;
}

export function humanReceiptIdentity(authorization: {
  readonly subject: string;
  readonly organization: Doc<"organizations">;
}) {
  return {
    kind: "organization" as const,
    principalId: authorization.subject,
    organizationId: authorization.organization._id,
  };
}

export function humanActor(authorization: { readonly user: Doc<"users"> }): PersistedActor {
  return { kind: "human", userId: authorization.user.publicId };
}

async function loadBlockingDependents(ctx: ReadCtx, blocker: TaskDoc) {
  return await ctx.db
    .query("taskDependencies")
    .withIndex("by_workspace_blocker_created", (query) =>
      query.eq("workspaceId", blocker.workspaceId).eq("blockerTaskId", blocker._id),
    )
    .take(MAX_BLOCKING_DEPENDENTS + 1);
}

export async function propagateBlockerTransition(
  ctx: MutationCtx,
  args: {
    readonly blocker: TaskDoc;
    readonly previousStatus: TaskDoc["status"];
    readonly nextStatus: TaskDoc["status"];
    readonly directBlockerCount: number;
    readonly actor: PersistedActor;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly now: number;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: DomainError }> {
  const edges = await loadBlockingDependents(ctx, args.blocker);
  if (
    edges.length > MAX_BLOCKING_DEPENDENTS ||
    blockerPropagationReadBound(args.directBlockerCount, edges.length) === null
  ) {
    return domainFailure("DEPENDENT_LIMIT", args.requestId, {
      taskKey: args.blocker.key,
      currentRevision: args.blocker.revision,
      blockingCount: edges.length,
    });
  }
  const dependents: Array<{
    readonly task: TaskDoc;
    readonly unresolved: number;
    readonly cancelled: number;
    readonly ready: boolean;
  }> = [];
  const seenDependents = new Set<string>();
  for (const edge of edges) {
    const dependent = await ctx.db.get(edge.blockedTaskId);
    if (
      dependent === null ||
      !dependencyMatchesTasks(edge, args.blocker, dependent) ||
      seenDependents.has(dependent._id)
    ) {
      await queueTaskProjectionRepair(ctx, args.blocker, args.now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: args.blocker.key,
        currentRevision: args.blocker.revision,
      });
    }
    seenDependents.add(dependent._id);
    const compactCountersAreValid =
      Number.isSafeInteger(dependent.unresolvedBlockerCount) &&
      dependent.unresolvedBlockerCount >= 0 &&
      Number.isSafeInteger(dependent.cancelledBlockerCount) &&
      dependent.cancelledBlockerCount >= 0 &&
      dependent.unresolvedBlockerCount + dependent.cancelledBlockerCount <= MAX_DIRECT_BLOCKERS &&
      (dependent.isBlocked === true) ===
        (dependent.unresolvedBlockerCount + dependent.cancelledBlockerCount > 0) &&
      dependent.isReady ===
        derivedReady({
          status: dependent.status,
          availableAt: dependent.availableAt,
          now: args.now,
          unresolved: dependent.unresolvedBlockerCount,
          cancelled: dependent.cancelledBlockerCount,
        });
    if (!compactCountersAreValid) {
      await queueTaskProjectionRepair(ctx, dependent, args.now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: dependent.key,
        currentRevision: dependent.revision,
        blockingCount: dependent.unresolvedBlockerCount + dependent.cancelledBlockerCount,
      });
    }
    const counters = transitionBlockerCounters(
      {
        unresolved: dependent.unresolvedBlockerCount,
        cancelled: dependent.cancelledBlockerCount,
      },
      args.previousStatus,
      args.nextStatus,
    );
    if (counters.unresolved < 0 || counters.cancelled < 0) {
      await queueTaskProjectionRepair(ctx, dependent, args.now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: dependent.key,
        currentRevision: dependent.revision,
        blockingCount: dependent.unresolvedBlockerCount + dependent.cancelledBlockerCount,
      });
    }
    const ready = derivedReady({
      status: dependent.status,
      availableAt: dependent.availableAt,
      now: args.now,
      unresolved: counters.unresolved,
      cancelled: counters.cancelled,
    });
    dependents.push({
      task: dependent,
      unresolved: counters.unresolved,
      cancelled: counters.cancelled,
      ready,
    });
  }
  // The caller verifies the blocker's own at-most-B projection once. This loop
  // then reads D outgoing edges and D dependent tasks exactly once: <=2B+2D+O(1).
  for (const projection of dependents) {
    const dependent = projection.task;
    await ctx.db.patch(dependent._id, {
      unresolvedBlockerCount: projection.unresolved,
      cancelledBlockerCount: projection.cancelled,
      isBlocked: projection.unresolved + projection.cancelled > 0,
      isReady: projection.ready,
      ...(projection.ready
        ? { readySince: dependent.readySince ?? args.now }
        : { readySince: undefined }),
      needsAttention: derivedNeedsAttention({
        status: dependent.status,
        unresolved: projection.unresolved,
        cancelled: projection.cancelled,
      }),
      revision: dependent.revision + 1,
      reviewRevision: dependent.reviewRevision + 1,
      lastEditedBy: args.actor,
      updatedAt: args.now,
    });
    await appendTaskEvent(ctx, {
      organizationId: dependent.organizationId,
      workspaceId: dependent.workspaceId,
      taskId: dependent._id,
      taskPublicId: dependent.publicId,
      taskRevision: dependent.revision + 1,
      type: "task.updated",
      actor: args.actor,
      command: {
        kind: "client",
        idempotencyKey: args.idempotencyKey,
        requestId: args.requestId,
      },
      payload: { fields: ["blockers"] },
      now: args.now,
    });
  }
  return { ok: true };
}

export const cancelTaskForHuman = internalMutation({
  args: {
    workspacePublicId: v.string(),
    key: v.string(),
    revision: v.number(),
    reason: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    if (
      args.reason.trim().length === 0 ||
      new TextEncoder().encode(args.reason).length > 16 * 1_024
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorized = await authorizePlanner(ctx, args);
    if (!authorized.ok) return { ok: false as const, error: authorized.error };
    const identity = humanReceiptIdentity(authorized.authorization);
    const receipt = await lookupHumanReceipt(ctx, {
      identity,
      operation: "tasks.cancel",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseTaskMutationData,
    });
    if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const task = await taskByKey(ctx, authorized.authorization.workspace._id, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    const cancellationDisposition = taskCancellationDisposition({
      currentRevision: task.revision,
      expectedRevision: args.revision,
      status: task.status,
    });
    if (cancellationDisposition === "revision_conflict") {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    if (cancellationDisposition === "terminal") {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    const pendingSubmissions =
      task.status === "in_review" ? await pendingSubmissionsForTask(ctx, task) : [];
    if (
      task.status === "in_review" &&
      (pendingSubmissions.length !== 1 ||
        pendingSubmissions[0] === undefined ||
        !submissionHasTaskOwnership(task, pendingSubmissions[0]))
    ) {
      await queueTaskReviewRepair(ctx, task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    let activeClaim: Doc<"taskClaims"> | null = null;
    if (task.status === "in_progress" || task.currentClaim !== undefined) {
      activeClaim =
        task.currentClaim === undefined ? null : await ctx.db.get(task.currentClaim.claimId);
      if (!activeClaimMatchesTask(task, activeClaim)) {
        await queueTaskClaimRepair(ctx, task, now);
        return domainFailure("PROJECTION_MISMATCH", args.requestId, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
    }
    const usage = await activeWorkspaceUsage(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
    });
    if (usage === null) return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
    if (usage.activeTasks <= 0) return domainFailure("INTERNAL_ERROR", args.requestId);
    const projection = await ensureCounterProjection(ctx, task, now, args.requestId);
    if (!projection.ok) return projection;
    const actor = humanActor(authorized.authorization);
    const propagated = await propagateBlockerTransition(ctx, {
      blocker: task,
      previousStatus: task.status,
      nextStatus: "cancelled",
      directBlockerCount: projection.actual.total,
      actor,
      idempotencyKey: args.idempotencyKey,
      requestId: args.requestId,
      now,
    });
    if (!propagated.ok) return { ok: false as const, error: propagated.error };
    if (activeClaim !== null) {
      await ctx.db.patch(activeClaim._id, { state: "released", endedAt: now, updatedAt: now });
    }
    const pendingSubmission = pendingSubmissions[0];
    if (pendingSubmission !== undefined) {
      await ctx.db.replace(pendingSubmission._id, {
        ...pendingSubmissionBase(pendingSubmission),
        status: "cancelled",
        cancelledBy: actor,
        cancelledAt: now,
        cancellationReason: args.reason,
      });
    }
    await ctx.db.insert("taskCancellations", {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      reason: args.reason,
      actor,
      cancelledAt: now,
    });
    await ctx.db.patch(task._id, {
      status: "cancelled",
      currentClaim: undefined,
      isReady: false,
      isBlocked: task.unresolvedBlockerCount + task.cancelledBlockerCount > 0,
      readySince: undefined,
      cancelledAt: now,
      revision: task.revision + 1,
      lastEditedBy: actor,
      updatedAt: now,
    });
    await ctx.db.patch(usage._id, { activeTasks: usage.activeTasks - 1, updatedAt: now });
    await appendTaskEvent(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: task.revision + 1,
      type: "task.cancelled",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { reason: args.reason.slice(0, 1_000) },
      now,
    });
    const updated = await ctx.db.get(task._id);
    if (updated === null) throw new Error("Cancelled task disappeared.");
    const data = await taskDetail(ctx, updated);
    if (data === null) throw new Error("Cancelled task detail relation changed.");
    await storeHumanReceipt(ctx, {
      identity,
      operation: "tasks.cancel",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export const reopenTaskForHuman = internalMutation({
  args: {
    workspacePublicId: v.string(),
    key: v.string(),
    revision: v.number(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskDetailResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizePlanner(ctx, args);
    if (!authorized.ok) return { ok: false as const, error: authorized.error };
    const identity = humanReceiptIdentity(authorized.authorization);
    const receipt = await lookupHumanReceipt(ctx, {
      identity,
      operation: "tasks.reopen",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseTaskMutationData,
    });
    if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const task = await taskByKey(ctx, authorized.authorization.workspace._id, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (
      task.revision !== args.revision ||
      (task.status !== "done" && task.status !== "cancelled")
    ) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    const usage = await activeWorkspaceUsage(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
    });
    if (usage === null) return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
    if (usage.activeTasks >= WORKSPACE_ACTIVE_TASK_LIMIT) {
      return domainFailure("WORKSPACE_TASK_LIMIT", args.requestId);
    }
    const projection = await ensureCounterProjection(ctx, task, now, args.requestId);
    if (!projection.ok) return projection;
    const actor = humanActor(authorized.authorization);
    const propagated = await propagateBlockerTransition(ctx, {
      blocker: task,
      previousStatus: task.status,
      nextStatus: "open",
      directBlockerCount: projection.actual.total,
      actor,
      idempotencyKey: args.idempotencyKey,
      requestId: args.requestId,
      now,
    });
    if (!propagated.ok) return { ok: false as const, error: propagated.error };
    const ready = derivedReady({
      status: "open",
      availableAt: task.availableAt,
      now,
      unresolved: projection.actual.unresolved,
      cancelled: projection.actual.cancelled,
    });
    await ctx.db.patch(task._id, {
      status: "open",
      currentClaim: undefined,
      isReady: ready,
      isBlocked: projection.actual.unresolved + projection.actual.cancelled > 0,
      ...(ready ? { readySince: now } : { readySince: undefined }),
      needsAttention: projection.actual.cancelled > 0,
      cancelledAt: undefined,
      completedAt: undefined,
      revision: task.revision + 1,
      lastEditedBy: actor,
      updatedAt: now,
    });
    await ctx.db.patch(usage._id, { activeTasks: usage.activeTasks + 1, updatedAt: now });
    await appendTaskEvent(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: task.revision + 1,
      type: "task.reopened",
      actor,
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: {},
      now,
    });
    const updated = await ctx.db.get(task._id);
    if (updated === null) throw new Error("Reopened task disappeared.");
    const data = await taskDetail(ctx, updated);
    if (data === null) throw new Error("Reopened task detail relation changed.");
    await storeHumanReceipt(ctx, {
      identity,
      operation: "tasks.reopen",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});

function repositoryView(repository: Doc<"workspaceRepositories">) {
  return {
    id: repository.publicId,
    name: repository.name,
    provider: repository.provider,
    url: repository.url,
    createdAt: repository.createdAt,
  };
}

export const createWorkspaceRepositoryForHuman = internalMutation({
  args: {
    workspacePublicId: v.string(),
    name: v.string(),
    provider: repositoryProviderValidator,
    url: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: repositoryResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const name = args.name.trim();
    if (
      name.length === 0 ||
      new TextEncoder().encode(name).length > 160 ||
      !isCredentialFreeHttpsUrl(args.url)
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorized = await authorizePlanner(ctx, args);
    if (!authorized.ok) return { ok: false as const, error: authorized.error };
    const identity = humanReceiptIdentity(authorized.authorization);
    const receipt = await lookupHumanReceipt(ctx, {
      identity,
      operation: "workspace.repositories.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseWithSchema(workspaceRepositoryResponseSchema),
    });
    if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const existing = await ctx.db
      .query("workspaceRepositories")
      .withIndex("by_workspace_and_url", (query) =>
        query.eq("workspaceId", authorized.authorization.workspace._id).eq("url", args.url),
      )
      .take(1);
    if (existing.length > 0) return domainFailure("TASK_STATE_CONFLICT", args.requestId);
    const publicId = randomPublicId("repo");
    const repositoryId = await ctx.db.insert("workspaceRepositories", {
      organizationId: authorized.authorization.organization._id,
      workspaceId: authorized.authorization.workspace._id,
      publicId,
      name,
      provider: args.provider,
      url: args.url,
      status: "active",
      createdByUserId: authorized.authorization.user._id,
      createdAt: now,
      updatedAt: now,
    });
    await appendSecurityEvent(ctx, {
      organizationId: authorized.authorization.organization._id,
      workspaceId: authorized.authorization.workspace._id,
      type: "workspace.repository_created",
      actor: humanActor(authorized.authorization),
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { repositoryId: publicId, name, provider: args.provider, url: args.url },
      now,
    });
    const repository = await ctx.db.get(repositoryId);
    if (repository === null) throw new Error("Created repository disappeared.");
    const data = { repository: repositoryView(repository) };
    await storeHumanReceipt(ctx, {
      identity,
      operation: "workspace.repositories.create",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export const listWorkspaceRepositoriesForHuman = internalQuery({
  args: {
    workspacePublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: repositoryListResultValidator,
  handler: async (ctx, args) => {
    if (!validPage(args.limit, args.cursor)) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorized = await authorizeWorkspaceHuman(ctx, args);
    if (!authorized.ok) return { ok: false as const, error: authorized.error };
    const page = await ctx.db
      .query("workspaceRepositories")
      .withIndex("by_workspace_status_created", (query) =>
        query.eq("workspaceId", authorized.authorization.workspace._id).eq("status", "active"),
      )
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    return {
      ok: true as const,
      data: { repositories: page.page.map(repositoryView), cursor: nextCursor(page) },
      requestId: args.requestId,
    };
  },
});

export const removeWorkspaceRepositoryForHuman = internalMutation({
  args: {
    workspacePublicId: v.string(),
    repositoryPublicId: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: repositoryRemoveResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorized = await authorizePlanner(ctx, args);
    if (!authorized.ok) return { ok: false as const, error: authorized.error };
    const identity = humanReceiptIdentity(authorized.authorization);
    const receipt = await lookupHumanReceipt(ctx, {
      identity,
      operation: "workspace.repositories.remove",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseWithSchema(removeWorkspaceRepositoryResponseSchema),
    });
    if (receipt.kind === "failure") return { ok: false as const, error: receipt.error };
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const repository = await resolveRepository(
      ctx,
      authorized.authorization.workspace._id,
      args.repositoryPublicId,
      true,
    );
    if (repository === null) return domainFailure("NOT_FOUND", args.requestId);
    await ctx.db.patch(repository._id, { status: "removed", removedAt: now, updatedAt: now });
    await appendSecurityEvent(ctx, {
      organizationId: authorized.authorization.organization._id,
      workspaceId: authorized.authorization.workspace._id,
      type: "workspace.repository_removed",
      actor: humanActor(authorized.authorization),
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { repositoryId: repository.publicId },
      now,
    });
    const data = { repositoryId: repository.publicId, removed: true as const };
    await storeHumanReceipt(ctx, {
      identity,
      operation: "workspace.repositories.remove",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      data,
      now,
    });
    return { ok: true as const, data, requestId: args.requestId };
  },
});
