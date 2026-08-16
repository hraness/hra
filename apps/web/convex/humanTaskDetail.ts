import {
  taskEventTypeValues,
  taskKeySchema,
  taskWorkspaceDetailCollectionValues,
  type SubmissionEvidenceInput,
} from "@hraness/agent-tasks-protocol";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { domainFailure, taskView } from "./domain";
import { authorizeWorkspaceHuman } from "./humanAuthorization";
import { validHumanTaskClassifiedAt } from "./humanTaskQueries";
import {
  domainErrorValidator,
  persistedEventActorValidator,
  submissionEvidenceValidator,
  taskEventTypeValidator,
  taskViewValidator,
} from "./model";
import {
  activeTaskClaimTupleMatches,
  isCredentialFreeHttpsUrl,
} from "./workGraphLaws";

const QUERY_REQUEST_ID = "req_00000000000000000000000000";
const MAX_LABELS = 50;
const MAX_BLOCKERS = 100;
const MAX_CHILDREN = 100;
const MAX_COMMENTS = 100;
const MAX_DEPENDENTS = 100;
const MAX_EVENTS = 100;
const MAX_REFERENCES = 100;

export const detailCollectionValues = taskWorkspaceDetailCollectionValues;
type DetailCollection = (typeof detailCollectionValues)[number];

const detailCollectionValidator = v.union(
  v.literal("blockers"),
  v.literal("children"),
  v.literal("comments"),
  v.literal("dependents"),
  v.literal("events"),
  v.literal("references"),
  v.literal("runs"),
);

const actorValidator = v.union(
  v.object({ id: v.string(), kind: v.literal("human"), name: v.string() }),
  v.object({
    id: v.string(),
    kind: v.literal("agent"),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
  }),
  v.object({
    id: v.string(),
    kind: v.literal("system"),
    jobKind: v.union(
      v.literal("claim_expiry"),
      v.literal("defer_wake"),
      v.literal("repair"),
      v.literal("reconciliation"),
    ),
  }),
);

const taskLinkValidator = v.object({
  id: v.string(),
  key: v.string(),
  priority: v.number(),
  revision: v.number(),
  status: v.union(
    v.literal("open"),
    v.literal("in_progress"),
    v.literal("in_review"),
    v.literal("done"),
    v.literal("cancelled"),
  ),
  title: v.string(),
});

const graphEdgeValidator = v.object({
  createdAt: v.number(),
  task: taskLinkValidator,
});

const referenceValidator = v.union(
  v.object({
    id: v.string(),
    createdAt: v.number(),
    kind: v.literal("repository"),
    repositoryId: v.string(),
  }),
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

const submissionBase = {
  id: v.string(),
  taskKey: v.string(),
  submittedBy: actorValidator,
  reviewRevision: v.number(),
  summary: v.string(),
  evidence: v.array(submissionEvidenceValidator),
  submittedAt: v.number(),
} as const;

const submissionValidator = v.union(
  v.object({ ...submissionBase, status: v.literal("pending") }),
  v.object({
    ...submissionBase,
    status: v.literal("accepted"),
    reviewedAt: v.number(),
  }),
  v.object({
    ...submissionBase,
    status: v.literal("rejected"),
    reviewedAt: v.number(),
    reviewReason: v.string(),
  }),
  v.object({
    ...submissionBase,
    status: v.literal("cancelled"),
  }),
);

export const humanTaskDetailDataValidator = v.object({
  task: taskViewValidator,
  description: v.string(),
  labels: v.array(v.string()),
  parent: v.union(taskLinkValidator, v.null()),
  children: v.array(taskLinkValidator),
  blockers: v.array(graphEdgeValidator),
  dependents: v.array(graphEdgeValidator),
  comments: v.array(
    v.object({
      id: v.string(),
      body: v.string(),
      actor: actorValidator,
      createdAt: v.number(),
    }),
  ),
  events: v.array(
    v.object({
      id: v.string(),
      actor: actorValidator,
      createdAt: v.number(),
      summary: v.string(),
      taskRevision: v.number(),
      type: taskEventTypeValidator,
    }),
  ),
  references: v.array(referenceValidator),
  submission: v.union(submissionValidator, v.null()),
  recoveries: v.array(
    v.object({
      kind: v.union(
        v.literal("access_revoked"),
        v.literal("task_cancelled"),
        v.literal("submission_rejected"),
        v.literal("claim_expired"),
        v.literal("cancelled_blocker"),
      ),
    }),
  ),
  truncatedCollections: v.array(detailCollectionValidator),
});

export const detailResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: humanTaskDetailDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

type PersistedActor = Doc<"taskEvents">["actor"];
type ResolvedActor =
  | { readonly id: string; readonly kind: "human"; readonly name: string }
  | {
      readonly id: string;
      readonly kind: "agent";
      readonly name: string;
      readonly status: "active" | "disabled";
    }
  | {
      readonly id: string;
      readonly kind: "system";
      readonly jobKind: "claim_expiry" | "defer_wake" | "repair" | "reconciliation";
    };

function taskLink(task: Doc<"tasks">) {
  return {
    id: task.publicId,
    key: task.key,
    priority: task.priority,
    revision: task.revision,
    status: task.status,
    title: task.title,
  };
}

export function humanTaskEventSummary(type: Doc<"taskEvents">["type"]): string {
  const summaries: Readonly<Record<Doc<"taskEvents">["type"], string>> = {
    "task.created": "Task created.",
    "task.deferred": "Task deferred until a later time.",
    "task.became_ready": "Task became ready for work.",
    "task.claimed": "Execution claim acquired.",
    "task.claim_renewed": "Execution lease renewed.",
    "task.claim_released": "Execution claim released.",
    "task.claim_expired": "Execution claim expired.",
    "task.reclaimed": "Expired work reclaimed by another agent.",
    "task.submitted": "Immutable evidence submitted for review.",
    "task.accepted": "Submission accepted.",
    "task.rejected": "Submission rejected and work reopened.",
    "task.updated": "Task fields updated.",
    "task.cancelled": "Task cancelled with history retained.",
    "task.reopened": "Task reopened.",
    "task.assigned": "Task assignment changed.",
    "task.parent_set": "Parent task set.",
    "task.parent_cleared": "Parent task cleared.",
    "task.label_added": "Label added.",
    "task.label_removed": "Label removed.",
    "task.comment_added": "Comment added.",
    "task.reference_added": "External reference added.",
    "task.reference_removed": "External reference removed.",
    "dependency.added": "Blocking dependency added.",
    "dependency.removed": "Blocking dependency removed.",
  };
  return summaries[type];
}

export function detailEvidenceHasSafeUrls(
  evidence: readonly SubmissionEvidenceInput[],
): boolean {
  return evidence.every((item) => {
    if (item.kind === "test" || item.kind === "note") return true;
    if (item.kind === "commit") {
      return item.url === undefined || isCredentialFreeHttpsUrl(item.url);
    }
    return isCredentialFreeHttpsUrl(item.url);
  });
}

export function eventSummariesAreExhaustive(): boolean {
  return taskEventTypeValues.every((type) => humanTaskEventSummary(type).length > 0);
}

async function claimTupleIsValid(ctx: QueryCtx, task: Doc<"tasks">): Promise<boolean> {
  if (task.status !== "in_progress") return task.currentClaim === undefined;
  const compact = task.currentClaim;
  if (compact === undefined) return false;
  const claim = await ctx.db.get(compact.claimId);
  if (claim === null) return false;
  if (!activeTaskClaimTupleMatches({
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
  })) {
    return false;
  }
  const agent = await ctx.db.get(claim.agentId);
  return (
    agent !== null &&
    agent.organizationId === task.organizationId &&
    agent._id === compact.agentId &&
    agent.publicId === compact.agentPublicId &&
    agent.publicId === claim.agentPublicId
  );
}

function actorResolver(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
): (actor: PersistedActor) => Promise<ResolvedActor> {
  const cache = new Map<string, Promise<ResolvedActor>>();
  return async (actor) => {
    if (actor.kind === "system") {
      return {
        id: `system:${actor.jobKind}`,
        kind: "system",
        jobKind: actor.jobKind,
      };
    }
    const key = `${actor.kind}:${actor.kind === "human" ? actor.userId : actor.agentId}`;
    const existing = cache.get(key);
    if (existing !== undefined) return await existing;
    const pending = (async (): Promise<ResolvedActor> => {
      if (actor.kind === "agent") {
        const agent = await ctx.db
          .query("agents")
          .withIndex("by_public_id", (index) => index.eq("publicId", actor.agentId))
          .unique();
        if (agent === null || agent.organizationId !== organizationId) {
          return {
            id: "agent:unavailable",
            kind: "agent",
            name: "Unavailable agent",
            status: "disabled",
          };
        }
        return {
          id: agent.publicId,
          kind: "agent",
          name: agent.name,
          status: agent.status,
        };
      }
      const user = await ctx.db
        .query("users")
        .withIndex("by_public_id", (index) => index.eq("publicId", actor.userId))
        .unique();
      if (user === null) {
        return { id: "human:unavailable", kind: "human", name: "Former human" };
      }
      const membership = await ctx.db
        .query("organizationMemberships")
        .withIndex("by_organization_and_user", (index) =>
          index.eq("organizationId", organizationId).eq("userId", user._id),
        )
        .unique();
      return membership === null
        ? { id: "human:unavailable", kind: "human", name: "Former human" }
        : { id: user.publicId, kind: "human", name: user.name };
    })();
    cache.set(key, pending);
    return await pending;
  };
}

export function humanTaskDetailRowBelongsToTask(
  row: { readonly organizationId: string; readonly workspaceId: string; readonly taskId: string },
  task: Readonly<{ organizationId: string; workspaceId: string; _id: string }>,
): boolean {
  return (
    row.organizationId === task.organizationId &&
    row.workspaceId === task.workspaceId &&
    row.taskId === task._id
  );
}

async function repositoryPublicId(
  ctx: QueryCtx,
  task: Doc<"tasks">,
  repositoryId: Id<"workspaceRepositories"> | undefined,
): Promise<string | undefined> {
  if (repositoryId === undefined) return undefined;
  const repository = await ctx.db.get(repositoryId);
  return repository !== null &&
    repository.organizationId === task.organizationId &&
    repository.workspaceId === task.workspaceId
    ? repository.publicId
    : undefined;
}

async function referenceView(
  ctx: QueryCtx,
  task: Doc<"tasks">,
  reference: Doc<"taskReferences">,
) {
  const common = { id: reference.publicId, createdAt: reference.createdAt };
  switch (reference.value.kind) {
    case "repository": {
      const publicId = await repositoryPublicId(ctx, task, reference.value.repositoryId);
      return publicId === undefined
        ? null
        : { ...common, kind: "repository" as const, repositoryId: publicId };
    }
    case "pull_request": {
      if (!isCredentialFreeHttpsUrl(reference.value.url)) return null;
      const publicId = await repositoryPublicId(ctx, task, reference.value.repositoryId);
      if (reference.value.repositoryId !== undefined && publicId === undefined) return null;
      return {
        ...common,
        kind: "pull_request" as const,
        url: reference.value.url,
        ...(publicId === undefined ? {} : { repositoryId: publicId }),
      };
    }
    case "commit": {
      if (
        reference.value.url !== undefined &&
        !isCredentialFreeHttpsUrl(reference.value.url)
      ) {
        return null;
      }
      const publicId = await repositoryPublicId(ctx, task, reference.value.repositoryId);
      if (reference.value.repositoryId !== undefined && publicId === undefined) return null;
      return {
        ...common,
        kind: "commit" as const,
        sha: reference.value.sha,
        ...(publicId === undefined ? {} : { repositoryId: publicId }),
        ...(reference.value.url === undefined ? {} : { url: reference.value.url }),
      };
    }
    case "artifact":
      if (!isCredentialFreeHttpsUrl(reference.value.url)) return null;
      return {
        ...common,
        kind: "artifact" as const,
        name: reference.value.name,
        url: reference.value.url,
      };
    case "url":
      if (!isCredentialFreeHttpsUrl(reference.value.url)) return null;
      return {
        ...common,
        kind: "url" as const,
        label: reference.value.label,
        url: reference.value.url,
      };
  }
}

export const detail = query({
  args: {
    workspaceId: v.string(),
    key: v.string(),
    classifiedAt: v.optional(v.number()),
  },
  returns: detailResultValidator,
  handler: async (ctx, args) => {
    const observedAt = Date.now();
    if (
      !taskKeySchema.safeParse(args.key).success ||
      !validHumanTaskClassifiedAt(args.classifiedAt, observedAt)
    ) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      workspacePublicId: args.workspaceId,
      requestId: QUERY_REQUEST_ID,
    });
    if (!authorized.ok) return authorized;
    const workspace = authorized.authorization.workspace;
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_and_key", (index) =>
        index.eq("workspaceId", workspace._id).eq("key", args.key),
      )
      .unique();
    if (
      task === null ||
      task.organizationId !== workspace.organizationId ||
      !(await claimTupleIsValid(ctx, task))
    ) {
      return task === null
        ? domainFailure("NOT_FOUND", QUERY_REQUEST_ID)
        : domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
            taskKey: task.key,
            currentRevision: task.revision,
          });
    }

    const [
      body,
      labels,
      childrenRows,
      blockerRows,
      dependentRows,
      commentRows,
      eventRows,
      referenceRows,
      submissionRows,
      parent,
    ] = await Promise.all([
      ctx.db
        .query("taskBodies")
        .withIndex("by_workspace_and_task", (index) =>
          index.eq("workspaceId", workspace._id).eq("taskId", task._id),
        )
        .unique(),
      ctx.db
        .query("taskLabels")
        .withIndex("by_workspace_task_created", (index) =>
          index.eq("workspaceId", workspace._id).eq("taskId", task._id),
        )
        .take(MAX_LABELS + 1),
      ctx.db
        .query("tasks")
        .withIndex("by_workspace_parent_updated", (index) =>
          index.eq("workspaceId", workspace._id).eq("parentTaskId", task._id),
        )
        .order("desc")
        .take(MAX_CHILDREN + 1),
      ctx.db
        .query("taskDependencies")
        .withIndex("by_workspace_blocked_created", (index) =>
          index.eq("workspaceId", workspace._id).eq("blockedTaskId", task._id),
        )
        .order("asc")
        .take(MAX_BLOCKERS + 1),
      ctx.db
        .query("taskDependencies")
        .withIndex("by_workspace_blocker_created", (index) =>
          index.eq("workspaceId", workspace._id).eq("blockerTaskId", task._id),
        )
        .order("asc")
        .take(MAX_DEPENDENTS + 1),
      ctx.db
        .query("taskComments")
        .withIndex("by_workspace_task_created", (index) =>
          index.eq("workspaceId", workspace._id).eq("taskId", task._id),
        )
        .order("desc")
        .take(MAX_COMMENTS + 1),
      ctx.db
        .query("taskEvents")
        .withIndex("by_workspace_and_task", (index) =>
          index.eq("workspaceId", workspace._id).eq("taskId", task._id),
        )
        .order("desc")
        .take(MAX_EVENTS + 1),
      ctx.db
        .query("taskReferences")
        .withIndex("by_workspace_task_status_created", (index) =>
          index
            .eq("workspaceId", workspace._id)
            .eq("taskId", task._id)
            .eq("status", "active"),
        )
        .order("desc")
        .take(MAX_REFERENCES + 1),
      ctx.db
        .query("taskSubmissions")
        .withIndex("by_workspace_task_submitted", (index) =>
          index.eq("workspaceId", workspace._id).eq("taskId", task._id),
        )
        .order("desc")
        .take(1),
      task.parentTaskId === undefined ? null : ctx.db.get(task.parentTaskId),
    ]);

    if (
      (body !== null && !humanTaskDetailRowBelongsToTask(body, task)) ||
      labels.length > MAX_LABELS ||
      labels.some((label) => !humanTaskDetailRowBelongsToTask(label, task))
    ) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    const resolveActor = actorResolver(ctx, task.organizationId);
    const blockers = [];
    for (const edge of blockerRows.slice(0, MAX_BLOCKERS)) {
      if (!humanTaskDetailRowBelongsToTask({ ...edge, taskId: edge.blockedTaskId }, task)) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      const related = await ctx.db.get(edge.blockerTaskId);
      if (
        related === null ||
        related.organizationId !== task.organizationId ||
        related.workspaceId !== task.workspaceId ||
        !(await claimTupleIsValid(ctx, related))
      ) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      blockers.push({ createdAt: edge.createdAt, task: taskLink(related) });
    }
    const dependents = [];
    for (const edge of dependentRows.slice(0, MAX_DEPENDENTS)) {
      if (
        edge.organizationId !== task.organizationId ||
        edge.workspaceId !== task.workspaceId ||
        edge.blockerTaskId !== task._id
      ) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      const related = await ctx.db.get(edge.blockedTaskId);
      if (
        related === null ||
        related.organizationId !== task.organizationId ||
        related.workspaceId !== task.workspaceId ||
        !(await claimTupleIsValid(ctx, related))
      ) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      dependents.push({ createdAt: edge.createdAt, task: taskLink(related) });
    }

    const children = childrenRows.slice(0, MAX_CHILDREN);
    if (
      children.some(
        (child) =>
          child.organizationId !== task.organizationId ||
          child.workspaceId !== task.workspaceId ||
          child.parentTaskId !== task._id,
      ) ||
      !(await Promise.all(children.map(async (child) => await claimTupleIsValid(ctx, child)))).every(Boolean)
    ) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    if (
      parent !== null &&
      (parent.organizationId !== task.organizationId ||
        parent.workspaceId !== task.workspaceId ||
        !(await claimTupleIsValid(ctx, parent)))
    ) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }

    const comments = [];
    for (const comment of commentRows.slice(0, MAX_COMMENTS).reverse()) {
      if (!humanTaskDetailRowBelongsToTask(comment, task)) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      comments.push({
        id: comment.publicId,
        body: comment.body,
        actor: await resolveActor(comment.actor),
        createdAt: comment.createdAt,
      });
    }
    const events = [];
    for (const event of eventRows.slice(0, MAX_EVENTS).reverse()) {
      if (
        !humanTaskDetailRowBelongsToTask(event, task) ||
        event.taskPublicId !== task.publicId
      ) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      events.push({
        id: event.publicId ?? `event:${task.publicId}:${event.taskRevision}:${event.type}`,
        actor: await resolveActor(event.actor),
        createdAt: event.createdAt,
        summary: humanTaskEventSummary(event.type),
        taskRevision: event.taskRevision,
        type: event.type,
      });
    }
    const references = [];
    for (const reference of referenceRows.slice(0, MAX_REFERENCES).reverse()) {
      if (!humanTaskDetailRowBelongsToTask(reference, task)) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      const view = await referenceView(ctx, task, reference);
      if (view === null) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      references.push(view);
    }

    const submission = submissionRows[0];
    let submissionView = null;
    if (submission !== undefined) {
      if (
        !humanTaskDetailRowBelongsToTask(submission, task) ||
        !detailEvidenceHasSafeUrls(submission.evidence)
      ) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
          taskKey: task.key,
          currentRevision: task.revision,
        });
      }
      const submittedBy = await resolveActor(submission.submittedBy);
      const base = {
        id: submission.publicId,
        taskKey: task.key,
        submittedBy,
        reviewRevision: submission.reviewRevision,
        summary: submission.summary,
        evidence: submission.evidence,
        submittedAt: submission.submittedAt,
      };
      switch (submission.status) {
        case "pending":
          submissionView = { ...base, status: "pending" as const };
          break;
        case "accepted":
          submissionView = {
            ...base,
            status: "accepted" as const,
            reviewedAt: submission.reviewedAt,
          };
          break;
        case "rejected":
          submissionView = {
            ...base,
            status: "rejected" as const,
            reviewedAt: submission.reviewedAt,
            reviewReason: submission.reviewReason,
          };
          break;
        case "cancelled":
          submissionView = {
            ...base,
            status: "cancelled" as const,
          };
          break;
      }
    }
    if (
      (task.status === "in_review" &&
        (submission === undefined ||
          submission.status !== "pending" ||
          submission.reviewRevision !== task.reviewRevision)) ||
      (task.status !== "in_review" && submission?.status === "pending")
    ) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }

    const recoveries = [];
    const relevantAgentPublicId =
      task.currentClaim?.agentPublicId ?? task.assigneeAgentPublicId;
    if (relevantAgentPublicId !== undefined) {
      const agent = await ctx.db
        .query("agents")
        .withIndex("by_public_id", (index) => index.eq("publicId", relevantAgentPublicId))
        .unique();
      if (
        agent === null ||
        agent.organizationId !== task.organizationId ||
        agent.status === "disabled"
      ) {
        recoveries.push({ kind: "access_revoked" as const });
      } else {
        const grant = await ctx.db
          .query("agentWorkspaceGrants")
          .withIndex("by_workspace_and_agent", (index) =>
            index.eq("workspaceId", task.workspaceId).eq("agentId", agent._id),
          )
          .unique();
        if (
          grant === null ||
          grant.organizationId !== task.organizationId ||
          grant.status !== "active"
        ) {
          recoveries.push({ kind: "access_revoked" as const });
        }
      }
    }
    if (task.status === "cancelled") recoveries.push({ kind: "task_cancelled" as const });
    if (submission?.status === "rejected") {
      recoveries.push({ kind: "submission_rejected" as const });
    }
    if (
      task.status === "in_progress" &&
      task.currentClaim !== undefined &&
      task.currentClaim.leaseUntil <= (args.classifiedAt ?? observedAt)
    ) {
      recoveries.push({ kind: "claim_expired" as const });
    }
    if (task.cancelledBlockerCount > 0) {
      recoveries.push({ kind: "cancelled_blocker" as const });
    }

    const truncatedCollections: DetailCollection[] = [];
    if (blockerRows.length > MAX_BLOCKERS) truncatedCollections.push("blockers" as const);
    if (childrenRows.length > MAX_CHILDREN) truncatedCollections.push("children" as const);
    if (commentRows.length > MAX_COMMENTS) truncatedCollections.push("comments" as const);
    if (dependentRows.length > MAX_DEPENDENTS) truncatedCollections.push("dependents" as const);
    if (eventRows.length > MAX_EVENTS) truncatedCollections.push("events" as const);
    if (referenceRows.length > MAX_REFERENCES) truncatedCollections.push("references" as const);

    return {
      ok: true as const,
      data: {
        task: taskView(task),
        description: body?.description ?? "",
        labels: labels.map((label) => label.label).sort(),
        parent: parent === null ? null : taskLink(parent),
        children: children.map(taskLink),
        blockers,
        dependents,
        comments,
        events,
        references,
        submission: submissionView,
        recoveries,
        truncatedCollections,
      },
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export { persistedEventActorValidator };
