import { taskPublicIdSchema } from "@hraness/agent-tasks-domain";
import { dispatchIdSchema } from "@hraness/agent-tasks-protocol";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export const INITIAL_WORKSPACE_PROJECTION_REVISION = 1;

export const workspaceTaskViewValues = [
  "all",
  "ready",
  "blocked",
  "deferred",
  "attention",
  "assigned",
  "review",
] as const;

export type WorkspaceTaskView = (typeof workspaceTaskViewValues)[number];

export type WorkspaceTaskViewRevisions = Readonly<
  Record<WorkspaceTaskView, number>
>;

type ProjectionReadCtx = QueryCtx | MutationCtx;

export type WorkspaceProjectionHeads = Readonly<{
  projectionRevision: number;
  taskViewRevisions: WorkspaceTaskViewRevisions;
}>;

/**
 * A semantic write has one closed invalidation scope. Workspace changes are
 * conservative full refreshes. Task and run changes carry enough bounded
 * identity for a client to patch an already loaded item. Only structure
 * changes invalidate continuation tokens for the listed views.
 */
export type WorkspaceProjectionImpact =
  | Readonly<{ scope: "workspace" }>
  | Readonly<{
      scope: "task";
      taskPublicId: string;
      views: readonly WorkspaceTaskView[];
      structure: boolean;
    }>
  | Readonly<{
      scope: "run";
      taskPublicId: string;
      runPublicId: string;
      views: readonly WorkspaceTaskView[];
      structure: boolean;
    }>;

const WORKSPACE_IMPACT: WorkspaceProjectionImpact = { scope: "workspace" };

type PersistedWorkspaceProjectionHeads = Readonly<{
  revision: number;
  taskListRevision?: number;
  taskViewRevisions?: Readonly<Record<WorkspaceTaskView, number>>;
}>;

function requireProjectionRevision(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < INITIAL_WORKSPACE_PROJECTION_REVISION) {
    throw new Error(`Workspace ${name} is invalid.`);
  }
  return value;
}

function allTaskViewRevisions(revision: number): WorkspaceTaskViewRevisions {
  return {
    all: revision,
    ready: revision,
    blocked: revision,
    deferred: revision,
    attention: revision,
    assigned: revision,
    review: revision,
  };
}

function normalizeTaskViews(
  views: readonly WorkspaceTaskView[],
): readonly WorkspaceTaskView[] {
  if (views.length < 1 || views.length > workspaceTaskViewValues.length) {
    throw new Error("Workspace invalidation has an invalid task-view bound.");
  }
  const unique = new Set<WorkspaceTaskView>();
  for (const view of views) {
    if (!workspaceTaskViewValues.includes(view) || unique.has(view)) {
      throw new Error("Workspace invalidation has invalid or duplicate task views.");
    }
    unique.add(view);
  }
  return workspaceTaskViewValues.filter((view) => unique.has(view));
}

function validateProjectionImpact(
  impact: WorkspaceProjectionImpact,
): WorkspaceProjectionImpact {
  if (impact.scope === "workspace") return impact;
  if (!taskPublicIdSchema.safeParse(impact.taskPublicId).success) {
    throw new Error("Workspace invalidation has an invalid task ID.");
  }
  const views = normalizeTaskViews(impact.views);
  if (impact.scope === "task") return { ...impact, views };
  if (!dispatchIdSchema.safeParse(impact.runPublicId).success) {
    throw new Error("Workspace invalidation has an invalid run ID.");
  }
  return { ...impact, views };
}

/**
 * Reads new and pre-migration head rows without allowing a scoped watermark to
 * regress. A legacy row applies its one list watermark to every task view.
 */
export function normalizeWorkspaceProjectionHeads(
  current: PersistedWorkspaceProjectionHeads | null,
): WorkspaceProjectionHeads {
  if (current === null) {
    return {
      projectionRevision: INITIAL_WORKSPACE_PROJECTION_REVISION,
      taskViewRevisions: allTaskViewRevisions(
        INITIAL_WORKSPACE_PROJECTION_REVISION,
      ),
    };
  }
  const projectionRevision = requireProjectionRevision(
    current.revision,
    "projection revision",
  );
  const legacyRevision = requireProjectionRevision(
    current.taskListRevision ?? projectionRevision,
    "legacy task-list projection revision",
  );
  const taskViewRevisions = current.taskViewRevisions === undefined
    ? allTaskViewRevisions(legacyRevision)
    : Object.fromEntries(workspaceTaskViewValues.map((view) => [
        view,
        requireProjectionRevision(
          current.taskViewRevisions?.[view] ?? 0,
          `${view} task-view projection revision`,
        ),
      ])) as WorkspaceTaskViewRevisions;
  if (
    legacyRevision > projectionRevision ||
    workspaceTaskViewValues.some(
      (view) => taskViewRevisions[view] > projectionRevision,
    )
  ) {
    throw new Error("Workspace task-view projection revision is ahead of its global revision.");
  }
  return { projectionRevision, taskViewRevisions };
}

/** Pure revision law used by the transactional writer and deterministic tests. */
export function nextWorkspaceProjectionHeads(
  current: PersistedWorkspaceProjectionHeads | null,
  rawImpact: WorkspaceProjectionImpact = WORKSPACE_IMPACT,
): WorkspaceProjectionHeads {
  const normalized = normalizeWorkspaceProjectionHeads(current);
  const impact = validateProjectionImpact(rawImpact);
  const projectionRevision = requireProjectionRevision(
    normalized.projectionRevision + 1,
    "next projection revision",
  );
  const affectedViews = impact.scope === "workspace"
    ? workspaceTaskViewValues
    : impact.structure
    ? impact.views
    : [];
  const taskViewRevisions = { ...normalized.taskViewRevisions };
  for (const view of affectedViews) taskViewRevisions[view] = projectionRevision;
  return { projectionRevision, taskViewRevisions };
}

export function workspaceTaskViewProjectionHead(
  heads: WorkspaceProjectionHeads,
  view: WorkspaceTaskView,
): number {
  return heads.taskViewRevisions[view];
}

export async function workspaceProjectionHeads(
  ctx: ProjectionReadCtx,
  workspaceId: Id<"workspaces">,
): Promise<WorkspaceProjectionHeads> {
  const row = await ctx.db
    .query("workspaceProjectionHeads")
    .withIndex("by_workspace", (query) => query.eq("workspaceId", workspaceId))
    .unique();
  return normalizeWorkspaceProjectionHeads(row);
}

export async function workspaceProjectionHead(
  ctx: ProjectionReadCtx,
  workspaceId: Id<"workspaces">,
): Promise<number> {
  return (await workspaceProjectionHeads(ctx, workspaceId)).projectionRevision;
}

/** Compatibility helper for callers that use the unfiltered All task view. */
export async function workspaceTaskListProjectionHead(
  ctx: ProjectionReadCtx,
  workspaceId: Id<"workspaces">,
): Promise<number> {
  return (await workspaceProjectionHeads(ctx, workspaceId)).taskViewRevisions.all;
}

/**
 * Advances the portable projection only after a visible semantic change.
 * Callers invoke this from the same mutation that persists the changed state.
 */
export async function advanceWorkspaceProjection(
  ctx: MutationCtx,
  workspace: Pick<
    Doc<"workspaces">,
    "_id" | "organizationId" | "publicId"
  >,
  now: number,
  rawImpact: WorkspaceProjectionImpact = WORKSPACE_IMPACT,
): Promise<number> {
  const impact = validateProjectionImpact(rawImpact);
  const current = await ctx.db
    .query("workspaceProjectionHeads")
    .withIndex("by_workspace", (query) =>
      query.eq("workspaceId", workspace._id))
    .unique();
  const next = nextWorkspaceProjectionHeads(current, impact);
  if (current === null) {
    await ctx.db.insert("workspaceProjectionHeads", {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      workspacePublicId: workspace.publicId,
      revision: next.projectionRevision,
      // Old readers conservatively refresh for every semantic write.
      taskListRevision: next.projectionRevision,
      taskViewRevisions: next.taskViewRevisions,
      lastSemanticAt: now,
    });
  } else {
    if (
      current.organizationId !== workspace.organizationId ||
      current.workspacePublicId !== workspace.publicId
    ) {
      throw new Error("Workspace projection head crossed its tenant.");
    }
    await ctx.db.patch(current._id, {
      revision: next.projectionRevision,
      taskListRevision: next.projectionRevision,
      taskViewRevisions: next.taskViewRevisions,
      lastSemanticAt: now,
    });
  }
  await ctx.db.insert("workspaceInvalidations", {
    organizationId: workspace.organizationId,
    workspaceId: workspace._id,
    workspacePublicId: workspace.publicId,
    projectionRevision: next.projectionRevision,
    scope: impact.scope,
    ...(impact.scope === "workspace"
      ? {}
      : {
          taskPublicId: impact.taskPublicId,
          views: [...impact.views],
          structure: impact.structure,
        }),
    ...(impact.scope === "run"
      ? { runPublicId: impact.runPublicId }
      : {}),
    createdAt: now,
  });
  return next.projectionRevision;
}

export async function advanceWorkspaceProjectionById(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  now: number,
  impact: WorkspaceProjectionImpact = WORKSPACE_IMPACT,
): Promise<number> {
  const workspace = await ctx.db.get(workspaceId);
  if (workspace === null) {
    throw new Error("Semantic write lost its workspace projection.");
  }
  return await advanceWorkspaceProjection(ctx, workspace, now, impact);
}
