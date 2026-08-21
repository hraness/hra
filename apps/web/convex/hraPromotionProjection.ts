import {
  MAX_BLOCKING_DEPENDENTS,
  MAX_DIRECT_BLOCKERS,
  MAX_TASK_LABELS,
  promotionEntityFamilyValues,
  promotionEntityIdentity,
  promotionEntitySchema,
  type PromotionEntity,
} from "@hraness/agent-tasks-domain";
import {
  agentPresetScopes,
} from "@hraness/agent-tasks-protocol";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import {
  validateDependencyCycleDb,
  validateParentChain,
} from "./workGraph";

const PROJECTION_PAGE_SIZE = 32;

function importedActor(session: Doc<"promotionSessions">) {
  return {
    kind: "system" as const,
    jobKind: "reconciliation" as const,
    sourceId: session.publicId,
  };
}

function importedExecutorPublicId(session: Doc<"promotionSessions">): string {
  return `imported_local_codex_${session.publicId}`;
}

async function storedAuthorizationIsActive(
  ctx: MutationCtx,
  session: Doc<"promotionSessions">,
): Promise<boolean> {
  const [organization, user, membership] = await Promise.all([
    ctx.db.get(session.organizationId),
    ctx.db.get(session.startedByUserId),
    ctx.db.get(session.authorizationMembershipId),
  ]);
  return (
    organization !== null &&
    user !== null &&
    membership !== null &&
    organization.status === "active" &&
    user.status === "active" &&
    organization.publicId === session.organizationPublicId &&
    user.publicId === session.startedByUserPublicId &&
    membership.organizationId === session.organizationId &&
    membership.userId === session.startedByUserId &&
    membership.status === "active" &&
    (membership.role === "owner" || membership.role === "admin")
  );
}

async function taskByPublicId(
  ctx: MutationCtx,
  session: Doc<"promotionSessions">,
  publicId: string,
) {
  const task = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_and_public_id", (query) =>
      query
        .eq("workspaceId", session.stagingWorkspaceId)
        .eq("publicId", publicId))
    .unique();
  if (
    task === null ||
    task.organizationId !== session.organizationId ||
    task.workspaceId !== session.stagingWorkspaceId
  ) {
    throw new Error("Promotion task relation target is missing.");
  }
  return task;
}

async function repositoryByPublicId(
  ctx: MutationCtx,
  session: Doc<"promotionSessions">,
  publicId: string,
) {
  const repository = await ctx.db
    .query("workspaceRepositories")
    .withIndex("by_public_id", (query) => query.eq("publicId", publicId))
    .unique();
  if (
    repository === null ||
    repository.organizationId !== session.organizationId ||
    repository.workspaceId !== session.stagingWorkspaceId
  ) {
    throw new Error("Promotion repository relation target is missing.");
  }
  return repository;
}

async function ensureImportedExecutor(
  ctx: MutationCtx,
  session: Doc<"promotionSessions">,
  now: number,
) {
  const publicId = importedExecutorPublicId(session);
  const existing = await ctx.db
    .query("agents")
    .withIndex("by_public_id", (query) => query.eq("publicId", publicId))
    .unique();
  if (existing !== null) {
    if (existing.organizationId !== session.organizationId) {
      throw new Error("Promotion executor public ID collided across tenants.");
    }
    return existing;
  }
  const agentId = await ctx.db.insert("agents", {
    organizationId: session.organizationId,
    createdByUserId: session.startedByUserId,
    publicId,
    name: "Local Codex (imported)",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("agentWorkspaceGrants", {
    organizationId: session.organizationId,
    workspaceId: session.stagingWorkspaceId,
    agentId,
    status: "active",
    scopes: [...agentPresetScopes.dispatcher],
    createdAt: now,
    updatedAt: now,
  });
  const usage = await ctx.db
    .query("workspaceUsage")
    .withIndex("by_workspace", (query) =>
      query.eq("workspaceId", session.stagingWorkspaceId))
    .unique();
  if (usage === null || usage.organizationId !== session.organizationId) {
    throw new Error("Promotion workspace usage projection is missing.");
  }
  await ctx.db.patch(usage._id, {
    activeAgents: usage.activeAgents + 1,
    updatedAt: now,
  });
  const agent = await ctx.db.get(agentId);
  if (agent === null) throw new Error("Promotion executor vanished.");
  return agent;
}

async function persistedReference(
  ctx: MutationCtx,
  session: Doc<"promotionSessions">,
  reference: Extract<PromotionEntity, { family: "references" }>["reference"],
) {
  switch (reference.kind) {
    case "repository": {
      const repository = await repositoryByPublicId(
        ctx,
        session,
        reference.repositoryId,
      );
      return { kind: "repository" as const, repositoryId: repository._id };
    }
    case "pull_request": {
      if (reference.repositoryId === undefined) {
        return { kind: "pull_request" as const, url: reference.url };
      }
      const repository = await repositoryByPublicId(
        ctx,
        session,
        reference.repositoryId,
      );
      return {
        kind: "pull_request" as const,
        url: reference.url,
        repositoryId: repository._id,
      };
    }
    case "commit": {
      if (reference.repositoryId === undefined) {
        return {
          kind: "commit" as const,
          sha: reference.sha,
          ...(reference.url === undefined ? {} : { url: reference.url }),
        };
      }
      const repository = await repositoryByPublicId(
        ctx,
        session,
        reference.repositoryId,
      );
      return {
        kind: "commit" as const,
        sha: reference.sha,
        repositoryId: repository._id,
        ...(reference.url === undefined ? {} : { url: reference.url }),
      };
    }
    case "artifact":
      return {
        kind: "artifact" as const,
        name: reference.name,
        url: reference.url,
      };
    case "url":
      return {
        kind: "url" as const,
        label: reference.label,
        url: reference.url,
      };
  }
}

async function projectEntity(
  ctx: MutationCtx,
  session: Doc<"promotionSessions">,
  entity: PromotionEntity,
  now: number,
): Promise<void> {
  const actor = importedActor(session);
  switch (entity.family) {
    case "workspace_metadata": {
      if (entity.workspaceId !== session.sourceWorkspacePublicId) {
        throw new Error("Promotion workspace metadata source is invalid.");
      }
      const workspace = await ctx.db.get(session.stagingWorkspaceId);
      if (
        workspace === null ||
        workspace.organizationId !== session.organizationId ||
        workspace.status !== "staging"
      ) {
        throw new Error("Promotion staging workspace disappeared.");
      }
      const slugCollision = await ctx.db
        .query("workspaces")
        .withIndex("by_organization_and_slug", (query) =>
          query
            .eq("organizationId", session.organizationId)
            .eq("slug", entity.slug))
        .unique();
      if (slugCollision !== null && slugCollision._id !== workspace._id) {
        throw new Error("Promotion workspace slug already exists.");
      }
      await ctx.db.patch(workspace._id, {
        name: entity.name,
        slug: entity.slug,
        taskKeyPrefix: entity.keyPrefix,
        updatedAt: now,
      });
      return;
    }
    case "executors":
      if (entity.workspaceId !== session.sourceWorkspacePublicId) {
        throw new Error("Promotion executor source is invalid.");
      }
      await ensureImportedExecutor(ctx, session, now);
      return;
    case "repositories": {
      const collision = await ctx.db
        .query("workspaceRepositories")
        .withIndex("by_public_id", (query) =>
          query.eq("publicId", entity.id))
        .unique();
      if (collision !== null) {
        throw new Error("Promotion repository public ID already exists.");
      }
      await ctx.db.insert("workspaceRepositories", {
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        publicId: entity.id,
        name: entity.name,
        provider: entity.provider,
        url: entity.url,
        status: "active",
        createdByUserId: session.startedByUserId,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    case "tasks": {
      const [collision, keyCollision, workspace] = await Promise.all([
        ctx.db
          .query("tasks")
          .withIndex("by_public_id", (query) =>
            query.eq("publicId", entity.id))
          .unique(),
        ctx.db
          .query("tasks")
          .withIndex("by_workspace_and_key", (query) =>
            query
              .eq("workspaceId", session.stagingWorkspaceId)
              .eq("key", entity.key))
          .unique(),
        ctx.db.get(session.stagingWorkspaceId),
      ]);
      if (collision !== null || keyCollision !== null) {
        throw new Error("Promotion task public ID already exists.");
      }
      if (
        workspace === null ||
        workspace.organizationId !== session.organizationId ||
        workspace.status !== "staging" ||
        !entity.key.startsWith(`${workspace.taskKeyPrefix}-`)
      ) {
        throw new Error("Promotion task key is outside the workspace prefix.");
      }
      const isReady = entity.status === "open" && entity.availableAt <= now;
      await ctx.db.insert("tasks", {
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        publicId: entity.id,
        key: entity.key,
        title: entity.title,
        type: entity.type,
        priority: entity.priority,
        status: entity.status,
        availableAt: entity.availableAt,
        isReady,
        isBlocked: false,
        unresolvedBlockerCount: 0,
        cancelledBlockerCount: 0,
        revision: entity.revision,
        reviewRevision: entity.reviewRevision,
        createdBy: actor,
        lastEditedBy: actor,
        ...(entity.assignee === undefined
          ? {}
          : { assigneeAgentPublicId: importedExecutorPublicId(session) }),
        ...(isReady ? { readySince: now } : {}),
        needsAttention: false,
        wakeGeneration: 0,
        ...(entity.status === "cancelled" ? { cancelledAt: now } : {}),
        ...(entity.status === "done" ? { completedAt: now } : {}),
        claimFence: 0,
        createdAt: now,
        updatedAt: now,
      });
      const usage = await ctx.db
        .query("workspaceUsage")
        .withIndex("by_workspace", (query) =>
          query.eq("workspaceId", session.stagingWorkspaceId))
        .unique();
      if (usage === null || usage.organizationId !== session.organizationId) {
        throw new Error("Promotion task usage row is missing.");
      }
      await ctx.db.patch(usage._id, {
        totalTasks: usage.totalTasks + 1,
        activeTasks: usage.activeTasks +
          (entity.status === "open" || entity.status === "in_review" ? 1 : 0),
        updatedAt: now,
      });
      return;
    }
    case "task_bodies": {
      const task = await taskByPublicId(ctx, session, entity.taskId);
      await ctx.db.insert("taskBodies", {
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        taskId: task._id,
        description: entity.description,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    case "task_repository_links": {
      const [task, repository] = await Promise.all([
        taskByPublicId(ctx, session, entity.taskId),
        repositoryByPublicId(ctx, session, entity.repositoryId),
      ]);
      await ctx.db.insert("promotionTaskRepositoryLinks", {
        promotionSessionId: session._id,
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        taskId: task._id,
        repositoryId: repository._id,
        relationKey: entity.relationKey,
        createdAt: now,
      });
      await ctx.db.insert("taskRepositoryLinks", {
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        taskId: task._id,
        repositoryId: repository._id,
        createdAt: now,
      });
      return;
    }
    case "parent_edges": {
      const [task, parent] = await Promise.all([
        taskByPublicId(ctx, session, entity.taskId),
        taskByPublicId(ctx, session, entity.parentTaskId),
      ]);
      if (
        task.parentTaskId !== undefined ||
        await validateParentChain(ctx, task._id, parent) !== "valid"
      ) {
        throw new Error("Promotion parent graph is invalid.");
      }
      await ctx.db.patch(task._id, {
        parentTaskId: parent._id,
        updatedAt: now,
      });
      return;
    }
    case "dependencies": {
      const [blocker, blocked] = await Promise.all([
        taskByPublicId(ctx, session, entity.blockerTaskId),
        taskByPublicId(ctx, session, entity.blockedTaskId),
      ]);
      const [blockers, dependents, cycle] = await Promise.all([
        ctx.db
          .query("taskDependencies")
          .withIndex("by_workspace_blocked_created", (query) =>
            query
              .eq("workspaceId", session.stagingWorkspaceId)
              .eq("blockedTaskId", blocked._id))
          .take(MAX_DIRECT_BLOCKERS),
        ctx.db
          .query("taskDependencies")
          .withIndex("by_workspace_blocker_created", (query) =>
            query
              .eq("workspaceId", session.stagingWorkspaceId)
              .eq("blockerTaskId", blocker._id))
          .take(MAX_BLOCKING_DEPENDENTS),
        validateDependencyCycleDb(
          ctx,
          session.stagingWorkspaceId,
          blocker._id,
          blocked._id,
        ),
      ]);
      if (
        blockers.length >= MAX_DIRECT_BLOCKERS ||
        dependents.length >= MAX_BLOCKING_DEPENDENTS ||
        cycle.kind !== "valid"
      ) {
        throw new Error("Promotion dependency graph is invalid.");
      }
      await ctx.db.insert("taskDependencies", {
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        blockerTaskId: blocker._id,
        blockedTaskId: blocked._id,
        kind: "blocks",
        createdBy: actor,
        createdAt: now,
      });
      const cancelledDelta = blocker.status === "cancelled" ? 1 : 0;
      const unresolvedDelta =
        blocker.status === "done" || blocker.status === "cancelled" ? 0 : 1;
      const unresolvedBlockerCount =
        blocked.unresolvedBlockerCount + unresolvedDelta;
      const cancelledBlockerCount =
        blocked.cancelledBlockerCount + cancelledDelta;
      const isBlocked =
        unresolvedBlockerCount + cancelledBlockerCount > 0;
      await ctx.db.patch(blocked._id, {
        unresolvedBlockerCount,
        cancelledBlockerCount,
        isBlocked,
        isReady: blocked.status === "open" &&
          blocked.availableAt <= now &&
          !isBlocked,
        readySince: blocked.status === "open" &&
            blocked.availableAt <= now &&
            !isBlocked
          ? blocked.readySince ?? now
          : undefined,
        needsAttention: cancelledBlockerCount > 0,
        updatedAt: now,
      });
      return;
    }
    case "labels": {
      const task = await taskByPublicId(ctx, session, entity.taskId);
      const existingLabels = await ctx.db
        .query("taskLabels")
        .withIndex("by_workspace_task_created", (query) =>
          query
            .eq("workspaceId", session.stagingWorkspaceId)
            .eq("taskId", task._id))
        .take(MAX_TASK_LABELS);
      if (existingLabels.length >= MAX_TASK_LABELS) {
        throw new Error("Promotion task label limit exceeded.");
      }
      let label = await ctx.db
        .query("workspaceLabels")
        .withIndex("by_workspace_and_name", (query) =>
          query
            .eq("workspaceId", session.stagingWorkspaceId)
            .eq("name", entity.label))
        .unique();
      if (label === null) {
        const labelId = await ctx.db.insert("workspaceLabels", {
          organizationId: session.organizationId,
          workspaceId: session.stagingWorkspaceId,
          name: entity.label,
          createdAt: now,
        });
        label = await ctx.db.get(labelId);
      }
      if (label === null || label.organizationId !== session.organizationId) {
        throw new Error("Promotion label projection is invalid.");
      }
      await ctx.db.insert("taskLabels", {
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        taskId: task._id,
        labelId: label._id,
        label: entity.label,
        createdBy: actor,
        createdAt: now,
      });
      return;
    }
    case "comments": {
      const task = await taskByPublicId(ctx, session, entity.taskId);
      const collision = await ctx.db
        .query("taskComments")
        .withIndex("by_public_id", (query) =>
          query.eq("publicId", entity.id))
        .unique();
      if (collision !== null) {
        throw new Error("Promotion comment public ID already exists.");
      }
      await ctx.db.insert("taskComments", {
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        taskId: task._id,
        publicId: entity.id,
        body: entity.body,
        actor,
        createdAt: entity.createdAt,
      });
      return;
    }
    case "references": {
      const task = await taskByPublicId(ctx, session, entity.taskId);
      const collision = await ctx.db
        .query("taskReferences")
        .withIndex("by_public_id", (query) =>
          query.eq("publicId", entity.reference.id))
        .unique();
      if (collision !== null) {
        throw new Error("Promotion reference public ID already exists.");
      }
      await ctx.db.insert("taskReferences", {
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        taskId: task._id,
        publicId: entity.reference.id,
        value: await persistedReference(ctx, session, entity.reference),
        status: "active",
        createdBy: actor,
        createdAt: entity.reference.createdAt,
        updatedAt: entity.reference.createdAt,
      });
      return;
    }
    case "submissions": {
      const task = await taskByPublicId(ctx, session, entity.taskId);
      if (
        entity.reviewRevision > task.reviewRevision ||
        (
          entity.status === "pending" &&
          (
            task.status !== "in_review" ||
            entity.reviewRevision !== task.reviewRevision
          )
        ) ||
        (
          entity.status !== "pending" &&
          task.status === "in_review"
        )
      ) {
        throw new Error("Promotion submission lifecycle is invalid.");
      }
      const imported = {
        ...entity,
        status: "pending" as const,
      };
      const evidence = entity.evidence.map((item) =>
        item.kind === "commit"
          ? {
              kind: "commit" as const,
              sha: item.sha,
              ...(item.url === undefined ? {} : { url: item.url }),
            }
          : item);
      await ctx.db.insert("promotionImportedSubmissions", {
        promotionSessionId: session._id,
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        taskId: task._id,
        publicId: entity.submissionId,
        submissionJson: JSON.stringify(entity),
        createdAt: now,
      });
      await ctx.db.insert("taskSubmissions", {
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        taskId: task._id,
        publicId: entity.submissionId,
        submittedBy: {
          kind: "agent",
          agentId: importedExecutorPublicId(session),
          credentialId: `imported:${session.publicId}`,
        },
        reviewRevision: entity.reviewRevision,
        summary: entity.summary,
        evidence,
        status: imported.status,
        submittedAt: now,
      });
      return;
    }
    case "reviews": {
      const submission = await ctx.db
        .query("taskSubmissions")
        .withIndex("by_public_id", (query) =>
          query.eq("publicId", entity.submissionId))
        .unique();
      const task = await taskByPublicId(ctx, session, entity.taskId);
      const importedSubmission = await ctx.db
        .query("promotionImportedSubmissions")
        .withIndex("by_workspace_and_public_id", (query) =>
          query
            .eq("workspaceId", session.stagingWorkspaceId)
            .eq("publicId", entity.submissionId))
        .unique();
      if (
        submission === null ||
        importedSubmission === null ||
        submission.organizationId !== session.organizationId ||
        submission.workspaceId !== session.stagingWorkspaceId ||
        submission.taskId !== task._id ||
        importedSubmission.organizationId !== session.organizationId ||
        importedSubmission.taskId !== task._id
      ) {
        throw new Error("Promotion review submission is missing.");
      }
      const sourceSubmission = promotionEntitySchema.parse(
        JSON.parse(importedSubmission.submissionJson) as unknown,
      );
      if (
        sourceSubmission.family !== "submissions" ||
        sourceSubmission.taskId !== entity.taskId ||
        sourceSubmission.status !== entity.decision
      ) {
        throw new Error("Promotion review does not match its submission.");
      }
      if (entity.decision === "accepted") {
        await ctx.db.replace(submission._id, {
          ...submission,
          status: "accepted",
          reviewedBy: actor,
          reviewedAt: entity.reviewedAt,
        });
      } else if (entity.decision === "rejected") {
        await ctx.db.replace(submission._id, {
          ...submission,
          status: "rejected",
          reviewedBy: actor,
          reviewedAt: entity.reviewedAt,
          reviewReason: entity.reason,
        });
      } else {
        await ctx.db.replace(submission._id, {
          ...submission,
          status: "cancelled",
          cancelledBy: actor,
          cancelledAt: entity.reviewedAt,
          cancellationReason: entity.reason,
        });
      }
      return;
    }
    case "terminal_states": {
      const task = await taskByPublicId(ctx, session, entity.taskId);
      if (task.status !== entity.status) {
        throw new Error("Promotion terminal state does not match its task.");
      }
      if (entity.status === "done") {
        const submission = await ctx.db
          .query("taskSubmissions")
          .withIndex("by_public_id", (query) =>
            query.eq("publicId", entity.acceptedSubmissionId))
          .unique();
        if (
          submission === null ||
          submission.organizationId !== session.organizationId ||
          submission.workspaceId !== session.stagingWorkspaceId ||
          submission.taskId !== task._id ||
          submission.status !== "accepted" ||
          submission.reviewRevision !== task.reviewRevision ||
          submission.reviewedAt !== entity.terminalAt
        ) {
          throw new Error("Promotion terminal acceptance is invalid.");
        }
      }
      await ctx.db.patch(task._id, entity.status === "done"
        ? {
            status: "done",
            completedAt: entity.terminalAt,
            cancelledAt: undefined,
            isReady: false,
            readySince: undefined,
            updatedAt: now,
          }
        : {
            status: "cancelled",
            cancelledAt: entity.terminalAt,
            completedAt: undefined,
            isReady: false,
            readySince: undefined,
            updatedAt: now,
          });
      return;
    }
    case "imported_run_summaries": {
      await taskByPublicId(ctx, session, entity.summary.taskId);
      if (
        entity.summary.provenance.sourceWorkspaceId !==
          session.sourceWorkspacePublicId ||
        entity.summary.provenance.sourceTaskId !== entity.summary.taskId
      ) {
        throw new Error("Promotion imported run provenance is invalid.");
      }
      await ctx.db.insert("promotionImportedRunSummaries", {
        promotionSessionId: session._id,
        organizationId: session.organizationId,
        workspaceId: session.stagingWorkspaceId,
        publicId: entity.summary.id,
        taskPublicId: entity.summary.taskId,
        summaryJson: JSON.stringify(entity.summary),
        finishedAt: entity.summary.finishedAt,
        createdAt: now,
      });
      return;
    }
  }
}

async function projectedTaskIsComplete(
  ctx: MutationCtx,
  session: Doc<"promotionSessions">,
  task: Doc<"tasks">,
): Promise<boolean> {
  const [body, stagedBody, stagedTerminal, pendingSubmissions] =
    await Promise.all([
      ctx.db
        .query("taskBodies")
        .withIndex("by_workspace_and_task", (query) =>
          query
            .eq("workspaceId", session.stagingWorkspaceId)
            .eq("taskId", task._id))
        .unique(),
      ctx.db
        .query("promotionStagedEntities")
        .withIndex("by_session_family_identity", (query) =>
          query
            .eq("promotionSessionId", session._id)
            .eq("family", "task_bodies")
            .eq("identity", task.publicId))
        .unique(),
      ctx.db
        .query("promotionStagedEntities")
        .withIndex("by_session_family_identity", (query) =>
          query
            .eq("promotionSessionId", session._id)
            .eq("family", "terminal_states")
            .eq("identity", task.publicId))
        .unique(),
      ctx.db
        .query("taskSubmissions")
        .withIndex("by_workspace_task_status_submitted", (query) =>
          query
            .eq("workspaceId", session.stagingWorkspaceId)
            .eq("taskId", task._id)
            .eq("status", "pending"))
        .take(2),
    ]);
  if (
    body === null ||
    stagedBody === null ||
    body.organizationId !== session.organizationId ||
    body.workspaceId !== session.stagingWorkspaceId ||
    body.taskId !== task._id
  ) {
    return false;
  }
  if (task.status === "in_review") {
    if (
      pendingSubmissions.length !== 1 ||
      pendingSubmissions[0]?.reviewRevision !== task.reviewRevision
    ) {
      return false;
    }
  } else if (pendingSubmissions.length !== 0) {
    return false;
  }
  const terminal = stagedTerminal === null
    ? null
    : promotionEntitySchema.safeParse(
        JSON.parse(stagedTerminal.entityJson) as unknown,
      );
  if (task.status === "done" || task.status === "cancelled") {
    return terminal?.success === true &&
      terminal.data.family === "terminal_states" &&
      terminal.data.taskId === task.publicId &&
      terminal.data.status === task.status;
  }
  return stagedTerminal === null;
}

export const projectPage = internalMutation({
  args: { sessionId: v.id("promotionSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session === null || session.state !== "projecting") return null;
    const now = Date.now();
    if (!(await storedAuthorizationIsActive(ctx, session))) {
      await ctx.db.patch(session._id, {
        state: "rejected",
        rejectionCode: "authorization_lost",
        updatedAt: now,
      });
      return null;
    }
    const familyIndex = session.projectionFamilyIndex ?? 0;
    if (familyIndex >= promotionEntityFamilyValues.length) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_workspace_updated", (query) =>
          query.eq("workspaceId", session.stagingWorkspaceId))
        .paginate({
          cursor: session.projectionCursor ?? null,
          numItems: PROJECTION_PAGE_SIZE,
        });
      try {
        for (const task of tasks.page) {
          if (
            task.organizationId !== session.organizationId ||
            task.workspaceId !== session.stagingWorkspaceId ||
            !(await projectedTaskIsComplete(ctx, session, task))
          ) {
            throw new Error("Promotion task projection is incomplete.");
          }
        }
      } catch {
        await ctx.db.patch(session._id, {
          state: "rejected",
          rejectionCode: "projection_incomplete",
          updatedAt: now,
        });
        return null;
      }
      if (tasks.isDone) {
        await ctx.db.patch(session._id, {
          state: "ready",
          projectionCursor: undefined,
          updatedAt: now,
        });
      } else {
        await ctx.db.patch(session._id, {
          projectionCursor: tasks.continueCursor,
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.hraPromotionProjection.projectPage,
          { sessionId: session._id },
        );
      }
      return null;
    }
    const family = promotionEntityFamilyValues[familyIndex];
    if (family === undefined) {
      throw new Error("Promotion projection family index is invalid.");
    }
    const page = await ctx.db
      .query("promotionStagedEntities")
      .withIndex("by_session_family_identity", (query) =>
        query
          .eq("promotionSessionId", session._id)
          .eq("family", family))
      .paginate({
        cursor: session.projectionCursor ?? null,
        numItems: PROJECTION_PAGE_SIZE,
      });
    try {
      for (const row of page.page) {
        const entity = promotionEntitySchema.parse(
          JSON.parse(row.entityJson) as unknown,
        );
        if (
          entity.family !== family ||
          promotionEntityIdentity(entity) !== row.identity ||
          row.promotionSessionId !== session._id ||
          row.promotionPublicId !== session.publicId
        ) {
          throw new Error("Promotion projection row identity mismatch.");
        }
        if (row.projectedAt === undefined) {
          await projectEntity(ctx, session, entity, now);
          await ctx.db.patch(row._id, { projectedAt: now });
        }
      }
    } catch {
      await ctx.db.patch(session._id, {
        state: "rejected",
        rejectionCode: "projection_failed",
        updatedAt: now,
      });
      return null;
    }
    if (!page.isDone) {
      await ctx.db.patch(session._id, {
        projectionCursor: page.continueCursor,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(session._id, {
        projectionFamilyIndex: familyIndex + 1,
        projectionCursor: undefined,
        updatedAt: now,
      });
    }
    await ctx.scheduler.runAfter(
      0,
      internal.hraPromotionProjection.projectPage,
      { sessionId: session._id },
    );
    return null;
  },
});

export function promotionProjectionPageSize(): number {
  return PROJECTION_PAGE_SIZE;
}
