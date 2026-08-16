import {
  MAX_RUN_INTERACTION_VIEWS,
  runInteractionRequestSchema,
  type OrganizationRole,
  type WorkspaceRole,
} from "@hraness/agent-tasks-protocol";
import {
  agentIdSchema,
  taskPublicIdSchema,
  workspacePublicIdSchema,
} from "@hraness/agent-tasks-domain";
import { type Infer, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { domainFailure, taskView } from "./domain";
import {
  authorizeWorkspaceHuman,
  type AuthorizedWorkspaceHuman,
} from "./humanAuthorization";
import {
  agentScopeValidator,
  domainErrorValidator,
  humanTaskListItemValidator,
  taskViewValidator,
} from "./model";
import {
  deriveActionableHumanInputSummary,
  deriveHumanInputProjection,
  humanInputProjectionIsDisplayableAt,
  humanInputProjectionFromTask,
  humanInputProjectionsMatch,
  type HumanInputProjection,
} from "./humanTaskProjection";
import {
  workspaceProjectionHeads,
  type WorkspaceProjectionHeads,
} from "./hraProjection";
import { activeTaskClaimTupleMatches } from "./workGraphLaws";

const QUERY_REQUEST_ID = "req_00000000000000000000000000";
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 50;
const COUNT_SCAN_LIMIT = 1_000;
const AGENT_SCAN_LIMIT = 100;
const MAX_CURSOR_LENGTH = 8_192;
const HUMAN_TASK_CURSOR_VERSION = 1;
const HUMAN_TASK_CURSOR_MAX_AGE_MS = 5 * 60 * 1_000;
const HUMAN_TASK_CURSOR_FUTURE_SKEW_MS = 30_000;

export const humanTaskViewValues = [
  "all",
  "ready",
  "blocked",
  "deferred",
  "attention",
  "assigned",
  "review",
] as const;

export type HumanTaskView = (typeof humanTaskViewValues)[number];

/** All and Attention use the expiry-aware two-phase HITL-first paginator. */
export function humanTaskViewUsesHumanInputPriority(view: HumanTaskView): boolean {
  return view === "all" || view === "attention";
}

interface HumanTaskCursorState {
  readonly version: 1;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly view: "all" | "attention";
  readonly snapshotAt: number;
  readonly phase: "live" | "ordinary";
  readonly continuation: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > MAX_CURSOR_LENGTH) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function encodeHumanTaskCursor(state: HumanTaskCursorState): string {
  return encodeBase64Url(JSON.stringify(state));
}

function initialHumanTaskCursor(
  organizationId: string,
  workspaceId: string,
  view: "all" | "attention",
  now: number,
): HumanTaskCursorState {
  return {
    version: HUMAN_TASK_CURSOR_VERSION,
    organizationId,
    workspaceId,
    view,
    snapshotAt: now,
    phase: "live",
    continuation: null,
  };
}

function decodeHumanTaskCursor(
  value: string,
  organizationId: string,
  workspaceId: string,
  view: "all" | "attention",
  now: number,
): HumanTaskCursorState | null {
  const decoded = decodeBase64Url(value);
  if (decoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 7 ||
    parsed.version !== HUMAN_TASK_CURSOR_VERSION ||
    parsed.organizationId !== organizationId ||
    parsed.workspaceId !== workspaceId ||
    parsed.view !== view ||
    !Number.isSafeInteger(parsed.snapshotAt) ||
    typeof parsed.snapshotAt !== "number" ||
    parsed.snapshotAt < now - HUMAN_TASK_CURSOR_MAX_AGE_MS ||
    parsed.snapshotAt > now + HUMAN_TASK_CURSOR_FUTURE_SKEW_MS ||
    (parsed.phase !== "live" && parsed.phase !== "ordinary") ||
    (parsed.continuation !== null &&
      (typeof parsed.continuation !== "string" || parsed.continuation.length === 0))
  ) {
    return null;
  }
  return {
    version: HUMAN_TASK_CURSOR_VERSION,
    organizationId,
    workspaceId,
    view,
    snapshotAt: parsed.snapshotAt,
    phase: parsed.phase,
    continuation: parsed.continuation,
  };
}

function isTextRunEventKind(
  kind: Doc<"taskRunEvents">["kind"],
): kind is "codex.reasoning_summary.delta" | "codex.assistant_message.delta" {
  return kind === "codex.reasoning_summary.delta" ||
    kind === "codex.assistant_message.delta";
}

export type HumanTaskCapabilities = Readonly<{
  canAssign: boolean;
  canCancel: boolean;
  canComment: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canManageGraph: boolean;
  canManageLabels: boolean;
  canManageReferences: boolean;
  canReopen: boolean;
  canReview: boolean;
}>;

type TaskClassificationInput = Readonly<{
  assigneeAgentPublicId?: string;
  availableAt: number;
  cancelledBlockerCount: number;
  currentClaim?: Readonly<{ leaseUntil: number }>;
  isBlocked?: boolean;
  isReady: boolean;
  latestPendingHumanInputExpiresAt?: number;
  needsAttention?: boolean;
  status: Doc<"tasks">["status"];
  unresolvedBlockerCount: number;
}>;

export type HumanTaskCounts = Readonly<
  Record<HumanTaskView, Readonly<{ value: number; capped: boolean }>>
>;

export const humanTaskViewValidator = v.union(
  v.literal("all"),
  v.literal("ready"),
  v.literal("blocked"),
  v.literal("deferred"),
  v.literal("attention"),
  v.literal("assigned"),
  v.literal("review"),
);

const organizationRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
);

const workspaceRoleValidator = v.union(
  v.literal("planner"),
  v.literal("reviewer"),
  v.literal("viewer"),
);

const capabilitiesValidator = v.object({
  canAssign: v.boolean(),
  canCancel: v.boolean(),
  canComment: v.boolean(),
  canCreate: v.boolean(),
  canEdit: v.boolean(),
  canManageGraph: v.boolean(),
  canManageLabels: v.boolean(),
  canManageReferences: v.boolean(),
  canReopen: v.boolean(),
  canReview: v.boolean(),
});

const countValidator = v.object({ value: v.number(), capped: v.boolean() });
export const humanTaskCountsValidator = v.object({
  all: countValidator,
  ready: countValidator,
  blocked: countValidator,
  deferred: countValidator,
  attention: countValidator,
  assigned: countValidator,
  review: countValidator,
});

export const workspaceContextDataValidator = v.object({
  now: v.number(),
  workspace: v.object({
    id: v.string(),
    name: v.string(),
    slug: v.string(),
    taskKeyPrefix: v.string(),
  }),
  viewer: v.object({
    id: v.string(),
    name: v.string(),
    organizationRole: organizationRoleValidator,
    workspaceRoles: v.array(workspaceRoleValidator),
  }),
  capabilities: capabilitiesValidator,
  agents: v.object({
    items: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        status: v.union(v.literal("active"), v.literal("disabled")),
      }),
    ),
    capped: v.boolean(),
  }),
});

export const workspaceContextResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: workspaceContextDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export const taskPageDataValidator = v.object({
  now: v.number(),
  view: humanTaskViewValidator,
  tasks: v.array(humanTaskListItemValidator),
  cursor: v.union(v.string(), v.null()),
});

export const taskPageResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: taskPageDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export const taskCountsDataValidator = v.object({
  now: v.number(),
  counts: humanTaskCountsValidator,
});

export const taskCountsResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: taskCountsDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export const taskListDataValidator = v.object({
  now: v.number(),
  view: humanTaskViewValidator,
  tasks: v.array(humanTaskListItemValidator),
  cursor: v.union(v.string(), v.null()),
  counts: humanTaskCountsValidator,
});

export const taskListResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: taskListDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export const taskPatchDataValidator = v.object({
  now: v.number(),
  view: humanTaskViewValidator,
  taskId: v.string(),
  projectionRevision: v.number(),
  continuationRevision: v.number(),
  membership: v.union(
    v.object({ kind: v.literal("absent") }),
    v.object({
      kind: v.literal("present"),
      item: humanTaskListItemValidator,
    }),
  ),
});

export const taskPatchResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: taskPatchDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export type HumanTaskPageData = Infer<typeof taskPageDataValidator>;
export type HumanTaskCountsData = Infer<typeof taskCountsDataValidator>;
export type HumanTaskPageResult = Infer<typeof taskPageResultValidator>;
export type HumanTaskCountsResult = Infer<typeof taskCountsResultValidator>;
export type HumanTaskPatchResult = Infer<typeof taskPatchResultValidator>;
export type HumanTaskPatchHeads = Readonly<{
  continuationRevision: number;
  projectionRevision: number;
}>;
export type HumanTaskPageQueryArgs = Readonly<{
  workspaceId: string;
  view: HumanTaskView;
  assignedAgentId?: string;
  classifiedAt: number;
  cursor?: string;
  limit?: number;
}>;
export type HumanTaskCountsQueryArgs = Readonly<{
  workspaceId: string;
  classifiedAt: number;
}>;

/** Selects the exact global and view heads that fence one atomic task patch. */
export function selectHumanTaskPatchHeads(
  heads: WorkspaceProjectionHeads,
  expectedProjectionRevision: number,
  view: HumanTaskView,
): HumanTaskPatchHeads | null {
  if (
    !Number.isSafeInteger(expectedProjectionRevision) ||
    expectedProjectionRevision < 1 ||
    heads.projectionRevision !== expectedProjectionRevision
  ) {
    return null;
  }
  return {
    continuationRevision: heads.taskViewRevisions[view],
    projectionRevision: heads.projectionRevision,
  };
}

const agentClaimsResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      now: v.number(),
      agent: v.object({
        id: v.string(),
        name: v.string(),
        status: v.union(v.literal("active"), v.literal("disabled")),
        grantStatus: v.union(v.literal("active"), v.literal("revoked")),
        scopes: v.array(agentScopeValidator),
      }),
      claims: v.array(
        v.object({
          id: v.string(),
          fence: v.number(),
          leaseGeneration: v.number(),
          leaseUntil: v.number(),
          expired: v.boolean(),
          task: taskViewValidator,
        }),
      ),
      cursor: v.union(v.string(), v.null()),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const ALL_CAPABILITIES: HumanTaskCapabilities = {
  canAssign: true,
  canCancel: true,
  canComment: true,
  canCreate: true,
  canEdit: true,
  canManageGraph: true,
  canManageLabels: true,
  canManageReferences: true,
  canReopen: true,
  canReview: true,
};

/** Maps server-loaded organization and workspace roles onto UI command affordances. */
export function deriveHumanTaskCapabilities(
  organizationRole: OrganizationRole,
  workspaceRoles: readonly WorkspaceRole[],
): HumanTaskCapabilities {
  if (organizationRole === "owner" || organizationRole === "admin") {
    return ALL_CAPABILITIES;
  }
  const planner = workspaceRoles.includes("planner");
  const reviewer = workspaceRoles.includes("reviewer");
  return {
    canAssign: planner,
    canCancel: planner,
    canComment: planner || reviewer,
    canCreate: planner,
    canEdit: planner,
    canManageGraph: planner,
    canManageLabels: planner,
    canManageReferences: planner,
    canReopen: planner,
    canReview: reviewer,
  };
}

/** Pure tenant check shared by query mappers and deterministic isolation tests. */
export function belongsToHumanTaskTenant(
  row: Readonly<{ organizationId: string; workspaceId: string }>,
  tenant: Readonly<{ organizationId: string; workspaceId: string }>,
): boolean {
  return (
    row.organizationId === tenant.organizationId &&
    row.workspaceId === tenant.workspaceId
  );
}

/** Fails closed when a workspace index contains a row owned by another tenant. */
export function allRowsBelongToHumanTaskTenant(
  rows: readonly Readonly<{ organizationId: string; workspaceId: string }>[],
  tenant: Readonly<{ organizationId: string; workspaceId: string }>,
): boolean {
  return rows.every((row) => belongsToHumanTaskTenant(row, tenant));
}

/** Classifies one compact task projection for the seven human list views. */
export function humanTaskMatchesView(
  task: TaskClassificationInput,
  view: HumanTaskView,
  now: number,
): boolean {
  switch (view) {
    case "all":
      return true;
    case "ready":
      return (
        (task.isReady && task.status === "open" && task.availableAt <= now) ||
        (task.status === "in_progress" &&
          task.currentClaim !== undefined &&
          task.currentClaim.leaseUntil <= now)
      );
    case "blocked":
      return (
        task.isBlocked === true ||
        task.unresolvedBlockerCount > 0 ||
        task.cancelledBlockerCount > 0
      );
    case "deferred":
      return (
        (task.status === "open" || task.status === "in_progress") &&
        task.availableAt > now
      );
    case "attention":
      return (
        (task.latestPendingHumanInputExpiresAt ?? -1) > now ||
        task.needsAttention === true ||
        task.cancelledBlockerCount > 0 ||
        (task.status === "in_progress" &&
          task.currentClaim !== undefined &&
          task.currentClaim.leaseUntil <= now)
      );
    case "assigned":
      return task.assigneeAgentPublicId !== undefined;
    case "review":
      return task.status === "in_review";
  }
}

/** Applies the optional Assigned agent partition after the closed view law. */
export function humanTaskMatchesScopedView(
  task: TaskClassificationInput,
  view: HumanTaskView,
  assignedAgentId: string | undefined,
  now: number,
): boolean {
  return humanTaskMatchesView(task, view, now) &&
    (assignedAgentId === undefined ||
      task.assigneeAgentPublicId === assignedAgentId);
}

async function loadHumanTaskRunSummary(
  ctx: QueryCtx,
  task: Doc<"tasks">,
) {
  const dispatch = await ctx.db
    .query("taskDispatches")
    .withIndex("by_workspace_task_updated", (index) =>
      index.eq("workspaceId", task.workspaceId).eq("taskId", task._id))
    .order("desc")
    .first();
  if (dispatch === null) return null;
  if (
    dispatch.organizationId !== task.organizationId ||
    dispatch.workspaceId !== task.workspaceId ||
    dispatch.taskId !== task._id
  ) {
    return undefined;
  }
  const event = await ctx.db
    .query("taskRunEvents")
    .withIndex("by_workspace_dispatch_sequence", (index) =>
      index.eq("workspaceId", task.workspaceId).eq("dispatchId", dispatch._id))
    .order("desc")
    .first();
  if (
    event !== null &&
    (event.organizationId !== task.organizationId ||
      event.workspaceId !== task.workspaceId ||
      event.dispatchId !== dispatch._id)
  ) {
    return undefined;
  }
  const displayText = event !== null &&
      "displayText" in event &&
      typeof event.displayText === "string"
    ? event.displayText
    : undefined;
  let latestDisplay;
  if (event === null) {
    latestDisplay = null;
  } else {
    const kind = event.kind;
    if (isTextRunEventKind(kind)) {
      if (displayText === undefined) return undefined;
      latestDisplay = { kind, displayText, observedAt: event.observedAt };
    } else {
      if (displayText !== undefined) return undefined;
      latestDisplay = { kind, observedAt: event.observedAt };
    }
  }
  return {
    phase: dispatch.phase,
    updatedAt: dispatch.updatedAt,
    latestDisplay,
  };
}

/** Revalidates the bounded durable rows before exposing an actionable question. */
async function loadHumanTaskInputSummary(
  ctx: QueryCtx,
  task: Doc<"tasks">,
  projection: HumanInputProjection | null,
  now: number,
) {
  if (projection === null || projection.latestExpiresAt <= now) return null;
  const pending = await ctx.db
    .query("taskRunInteractions")
    .withIndex("by_task_state_created", (index) =>
      index.eq("taskId", task._id).eq("state", "pending"))
    .take(MAX_RUN_INTERACTION_VIEWS + 1);
  if (
    pending.length > MAX_RUN_INTERACTION_VIEWS ||
    pending.some((interaction) =>
      interaction.organizationId !== task.organizationId ||
      interaction.workspaceId !== task.workspaceId ||
      interaction.taskId !== task._id ||
      interaction.state !== "pending")
  ) {
    return undefined;
  }
  const parsed = [];
  for (const interaction of pending) {
    const request = runInteractionRequestSchema.safeParse(interaction.request);
    if (
      !request.success ||
      request.data.id !== interaction.publicId ||
      request.data.expiresAt !== interaction.expiresAt
    ) {
      return undefined;
    }
    parsed.push({ publicId: interaction.publicId, request: request.data });
  }
  const exactProjection = deriveHumanInputProjection(parsed);
  if (!humanInputProjectionsMatch(exactProjection, projection)) return undefined;
  return deriveActionableHumanInputSummary(parsed, now);
}

type PrioritizedHumanTaskPage = Readonly<{
  page: readonly Doc<"tasks">[];
  cursor: string | null;
  snapshotAt: number;
}>;

async function ordinaryHumanTaskPage(
  ctx: QueryCtx,
  workspaceId: Doc<"workspaces">["_id"],
  state: HumanTaskCursorState,
  continuation: string | null,
  limit: number,
) {
  const query = ctx.db
    .query("tasks")
    .withIndex("by_workspace_updated", (index) => index.eq("workspaceId", workspaceId))
    .order("desc");
  const filtered = state.view === "all"
    ? query.filter((filter) =>
        filter.lte(
          filter.field("latestPendingHumanInputExpiresAt"),
          state.snapshotAt,
        ))
    : query.filter((filter) => filter.and(
        filter.lte(
          filter.field("latestPendingHumanInputExpiresAt"),
          state.snapshotAt,
        ),
        filter.or(
          filter.eq(filter.field("needsAttention"), true),
          filter.gt(filter.field("cancelledBlockerCount"), 0),
          filter.and(
            filter.eq(filter.field("status"), "in_progress"),
            filter.lte(filter.field("currentClaim.leaseUntil"), state.snapshotAt),
          ),
        ),
      ));
  return await filtered.paginate({ cursor: continuation, numItems: limit });
}

/**
 * Pages one stable snapshot as live-HITL then ordinary work. Database filters
 * skip an arbitrary stale raw-marker prefix before pagination counts a row.
 */
async function loadPrioritizedHumanTaskPage(
  ctx: QueryCtx,
  workspaceId: Doc<"workspaces">["_id"],
  state: HumanTaskCursorState,
  limit: number,
): Promise<PrioritizedHumanTaskPage> {
  if (state.phase === "ordinary") {
    const ordinary = await ordinaryHumanTaskPage(
      ctx,
      workspaceId,
      state,
      state.continuation,
      limit,
    );
    return {
      page: ordinary.page,
      cursor: ordinary.isDone
        ? null
        : encodeHumanTaskCursor({ ...state, continuation: ordinary.continueCursor }),
      snapshotAt: state.snapshotAt,
    };
  }

  const live = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_updated", (index) => index.eq("workspaceId", workspaceId))
    .order("desc")
    .filter((filter) =>
      filter.gt(
        filter.field("latestPendingHumanInputExpiresAt"),
        state.snapshotAt,
      ))
    .paginate({ cursor: state.continuation, numItems: limit });
  if (!live.isDone) {
    return {
      page: live.page,
      cursor: encodeHumanTaskCursor({ ...state, continuation: live.continueCursor }),
      snapshotAt: state.snapshotAt,
    };
  }

  const ordinaryState: HumanTaskCursorState = {
    ...state,
    phase: "ordinary",
    continuation: null,
  };
  const remaining = limit - live.page.length;
  if (remaining === 0) {
    const probe = await ordinaryHumanTaskPage(ctx, workspaceId, ordinaryState, null, 1);
    return {
      page: live.page,
      cursor: probe.page.length === 0 && probe.isDone
        ? null
        : encodeHumanTaskCursor(ordinaryState),
      snapshotAt: state.snapshotAt,
    };
  }
  const ordinary = await ordinaryHumanTaskPage(
    ctx,
    workspaceId,
    ordinaryState,
    null,
    remaining,
  );
  return {
    page: [...live.page, ...ordinary.page],
    cursor: ordinary.isDone
      ? null
      : encodeHumanTaskCursor({
          ...ordinaryState,
          continuation: ordinary.continueCursor,
        }),
    snapshotAt: state.snapshotAt,
  };
}

/** Counts one bounded scan. A capped scan reports lower bounds for every view. */
export function countHumanTaskViews(
  tasks: readonly TaskClassificationInput[],
  now: number,
  capped: boolean,
): HumanTaskCounts {
  const count = (view: HumanTaskView) => ({
    value: tasks.reduce(
      (total, task) => total + (humanTaskMatchesView(task, view, now) ? 1 : 0),
      0,
    ),
    capped,
  });
  return {
    all: count("all"),
    ready: count("ready"),
    blocked: count("blocked"),
    deferred: count("deferred"),
    attention: count("attention"),
    assigned: count("assigned"),
    review: count("review"),
  };
}

function validPage(limit: number, cursor: string | undefined): boolean {
  return (
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= MAX_PAGE_LIMIT &&
    (cursor === undefined || cursor.length <= MAX_CURSOR_LENGTH)
  );
}

export function validHumanTaskClassifiedAt(
  classifiedAt: number | undefined,
  now: number,
): boolean {
  return classifiedAt === undefined || (
    Number.isSafeInteger(classifiedAt) &&
    classifiedAt >= now - HUMAN_TASK_CURSOR_MAX_AGE_MS &&
    classifiedAt <= now + HUMAN_TASK_CURSOR_FUTURE_SKEW_MS
  );
}

export function joinHumanTaskListData(
  page: HumanTaskPageData,
  countProjection: HumanTaskCountsData,
): Infer<typeof taskListDataValidator> | null {
  if (page.now !== countProjection.now) return null;
  return {
    ...page,
    counts: countProjection.counts,
  };
}

async function taskProjectionIsConsistent(
  ctx: QueryCtx,
  task: Doc<"tasks">,
): Promise<boolean> {
  if (task.status !== "in_progress") return task.currentClaim === undefined;
  const compact = task.currentClaim;
  if (compact === undefined) return false;
  const claim = await ctx.db.get(compact.claimId);
  if (
    claim === null ||
    !activeTaskClaimTupleMatches({
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
    })
  ) {
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

async function loadAssignmentAgents(
  ctx: QueryCtx,
  organizationId: Doc<"organizations">["_id"],
  workspaceId: Doc<"workspaces">["_id"],
) {
  const tenant = { organizationId, workspaceId };
  const grants = await ctx.db
    .query("agentWorkspaceGrants")
    .withIndex("by_workspace_status_and_agent", (index) =>
      index.eq("workspaceId", workspaceId).eq("status", "active"),
    )
    .take(AGENT_SCAN_LIMIT + 1);
  const visibleGrants = grants.slice(0, AGENT_SCAN_LIMIT);
  if (
    visibleGrants.some((grant) =>
      !belongsToHumanTaskTenant(grant, tenant) || grant.status !== "active"
    )
  ) {
    return null;
  }
  const agents = await Promise.all(
    visibleGrants.map((grant) => ctx.db.get(grant.agentId)),
  );
  const items = [];
  for (const [index, grant] of visibleGrants.entries()) {
    const agent = agents[index];
    if (
      agent === undefined ||
      agent === null ||
      agent.organizationId !== organizationId ||
      agent._id !== grant.agentId
    ) {
      return null;
    }
    items.push({ id: agent.publicId, name: agent.name, status: agent.status });
  }
  return { items, capped: grants.length > AGENT_SCAN_LIMIT };
}

type HumanTaskPageRead = Readonly<{
  view: HumanTaskView;
  assignedAgentId?: string;
  classifiedAt: number;
  observedAt: number;
  cursor?: string;
  limit: number;
}>;

function validHumanTaskPageRead(
  args: Readonly<{
    view: HumanTaskView;
    assignedAgentId?: string;
    classifiedAt?: number;
    cursor?: string;
    limit: number;
  }>,
  observedAt: number,
): boolean {
  return validPage(args.limit, args.cursor) &&
    validHumanTaskClassifiedAt(args.classifiedAt, observedAt) &&
    (args.view === "assigned" || args.assignedAgentId === undefined);
}

async function loadHumanTaskListItem(
  ctx: QueryCtx,
  task: Doc<"tasks">,
  classifiedAt: number,
): Promise<Infer<typeof humanTaskListItemValidator> | null> {
  if (!(await taskProjectionIsConsistent(ctx, task))) return null;
  const projection = humanInputProjectionFromTask(task);
  if (projection === undefined) return null;
  const humanInput = await loadHumanTaskInputSummary(
    ctx,
    task,
    projection,
    classifiedAt,
  );
  const run = await loadHumanTaskRunSummary(ctx, task);
  if (humanInput === undefined || run === undefined) return null;
  return { task: taskView(task), humanInput, run };
}

async function readAuthorizedHumanTaskPage(
  ctx: QueryCtx,
  authorization: AuthorizedWorkspaceHuman,
  args: HumanTaskPageRead,
) {
  const { organization, workspace } = authorization;
  const tenant = {
    organizationId: organization._id,
    workspaceId: workspace._id,
  };
  const prioritized = humanTaskViewUsesHumanInputPriority(args.view);
  let page: PrioritizedHumanTaskPage;
  if (prioritized) {
    const view = args.view === "all" || args.view === "attention"
      ? args.view
      : undefined;
    if (view === undefined) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const state = args.cursor === undefined
      ? initialHumanTaskCursor(
          organization.publicId,
          workspace.publicId,
          view,
          args.classifiedAt,
        )
      : decodeHumanTaskCursor(
          args.cursor,
          organization.publicId,
          workspace.publicId,
          view,
          args.observedAt,
        );
    if (state === null || state.snapshotAt !== args.classifiedAt) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    page = await loadPrioritizedHumanTaskPage(
      ctx,
      workspace._id,
      state,
      args.limit,
    );
  } else {
    const ordinary = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_updated", (index) =>
        index.eq("workspaceId", workspace._id))
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    page = {
      page: ordinary.page,
      cursor: ordinary.isDone ? null : ordinary.continueCursor,
      snapshotAt: args.classifiedAt,
    };
  }
  if (
    !allRowsBelongToHumanTaskTenant(page.page, tenant) ||
    page.page.some((task) => humanInputProjectionFromTask(task) === undefined)
  ) {
    return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
  }
  const visibleTasks = [];
  for (const task of page.page) {
    const projection = humanInputProjectionFromTask(task);
    if (projection === undefined) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    // One frozen classification time stabilizes membership and display for
    // every page issued from the same hosted source token.
    if (
      prioritized &&
      !humanInputProjectionIsDisplayableAt(
        projection,
        page.snapshotAt,
        args.classifiedAt,
      )
    ) {
      continue;
    }
    if (!humanTaskMatchesScopedView(
      task,
      args.view,
      args.assignedAgentId,
      args.classifiedAt,
    )) {
      continue;
    }
    visibleTasks.push(task);
  }
  const tasks = await Promise.all(
    visibleTasks.map((task) =>
      loadHumanTaskListItem(ctx, task, args.classifiedAt)),
  );
  if (tasks.some((item) => item === null)) {
    return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
  }
  return {
    ok: true as const,
    data: {
      now: args.classifiedAt,
      view: args.view,
      tasks: tasks.filter((item) => item !== null),
      cursor: page.cursor,
    },
    requestId: QUERY_REQUEST_ID,
  };
}

async function readAuthorizedHumanTaskCounts(
  ctx: QueryCtx,
  authorization: AuthorizedWorkspaceHuman,
  classifiedAt: number,
) {
  const { organization, workspace } = authorization;
  const tenant = {
    organizationId: organization._id,
    workspaceId: workspace._id,
  };
  const countScan = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_updated", (index) =>
      index.eq("workspaceId", workspace._id))
    .order("desc")
    .take(COUNT_SCAN_LIMIT + 1);
  const countRows = countScan.slice(0, COUNT_SCAN_LIMIT);
  if (
    !allRowsBelongToHumanTaskTenant(countRows, tenant) ||
    countRows.some((task) => humanInputProjectionFromTask(task) === undefined)
  ) {
    return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
  }
  return {
    ok: true as const,
    data: {
      now: classifiedAt,
      counts: countHumanTaskViews(
        countRows,
        classifiedAt,
        countScan.length > COUNT_SCAN_LIMIT,
      ),
    },
    requestId: QUERY_REQUEST_ID,
  };
}

export const workspaceContext = query({
  args: { workspaceId: v.string() },
  returns: workspaceContextResultValidator,
  handler: async (ctx, args) => {
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const { authorization } = authorized;
    const workspaceRoles =
      authorization.role === "owner" || authorization.role === "admin"
        ? (["planner", "reviewer", "viewer"] as const)
        : (authorization.workspaceMembership?.roles ?? []);
    const agents = await loadAssignmentAgents(
      ctx,
      authorization.organization._id,
      authorization.workspace._id,
    );
    if (agents === null) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    return {
      ok: true as const,
      data: {
        now: Date.now(),
        workspace: {
          id: authorization.workspace.publicId,
          name: authorization.workspace.name,
          slug: authorization.workspace.slug,
          taskKeyPrefix: authorization.workspace.taskKeyPrefix,
        },
        viewer: {
          id: authorization.user.publicId,
          name: authorization.user.name,
          organizationRole: authorization.role,
          workspaceRoles: [...workspaceRoles],
        },
        capabilities: deriveHumanTaskCapabilities(
          authorization.role,
          workspaceRoles,
        ),
        agents,
      },
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export const taskPage = query({
  args: {
    workspaceId: v.string(),
    view: humanTaskViewValidator,
    assignedAgentId: v.optional(v.string()),
    classifiedAt: v.number(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: taskPageResultValidator,
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_PAGE_LIMIT;
    const observedAt = Date.now();
    if (!validHumanTaskPageRead({ ...args, limit }, observedAt)) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    return await readAuthorizedHumanTaskPage(ctx, authorized.authorization, {
      view: args.view,
      ...(args.assignedAgentId === undefined
        ? {}
        : { assignedAgentId: args.assignedAgentId }),
      classifiedAt: args.classifiedAt,
      observedAt,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      limit,
    });
  },
});

export const taskCounts = query({
  args: {
    workspaceId: v.string(),
    classifiedAt: v.number(),
  },
  returns: taskCountsResultValidator,
  handler: async (ctx, args) => {
    const observedAt = Date.now();
    if (!validHumanTaskClassifiedAt(args.classifiedAt, observedAt)) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    return await readAuthorizedHumanTaskCounts(
      ctx,
      authorized.authorization,
      args.classifiedAt,
    );
  },
});

export const taskPatch = query({
  args: {
    workspaceId: v.string(),
    taskId: v.string(),
    view: humanTaskViewValidator,
    assignedAgentId: v.optional(v.string()),
    classifiedAt: v.number(),
    expectedProjectionRevision: v.number(),
  },
  returns: taskPatchResultValidator,
  handler: async (ctx, args) => {
    const observedAt = Date.now();
    if (
      !workspacePublicIdSchema.safeParse(args.workspaceId).success ||
      !taskPublicIdSchema.safeParse(args.taskId).success ||
      (args.assignedAgentId !== undefined &&
        !agentIdSchema.safeParse(args.assignedAgentId).success) ||
      (args.view !== "assigned" && args.assignedAgentId !== undefined) ||
      !Number.isSafeInteger(args.expectedProjectionRevision) ||
      args.expectedProjectionRevision < 1 ||
      !validHumanTaskClassifiedAt(args.classifiedAt, observedAt)
    ) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const { organization, workspace } = authorized.authorization;
    const heads = await workspaceProjectionHeads(ctx, workspace._id);
    const patchHeads = selectHumanTaskPatchHeads(
      heads,
      args.expectedProjectionRevision,
      args.view,
    );
    if (patchHeads === null) {
      return domainFailure("TASK_STATE_CONFLICT", QUERY_REQUEST_ID, {
        currentRevision: heads.projectionRevision,
      });
    }
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_and_public_id", (index) =>
        index
          .eq("workspaceId", workspace._id)
          .eq("publicId", args.taskId),
      )
      .unique();
    if (task === null) return domainFailure("NOT_FOUND", QUERY_REQUEST_ID);
    if (
      task.organizationId !== organization._id ||
      task.workspaceId !== workspace._id
    ) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    const projection = humanInputProjectionFromTask(task);
    if (projection === undefined) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    if (!humanTaskMatchesScopedView(
      task,
      args.view,
      args.assignedAgentId,
      args.classifiedAt,
    )) {
      return {
        ok: true as const,
        data: {
          now: args.classifiedAt,
          view: args.view,
          taskId: task.publicId,
          projectionRevision: patchHeads.projectionRevision,
          continuationRevision: patchHeads.continuationRevision,
          membership: { kind: "absent" as const },
        },
        requestId: QUERY_REQUEST_ID,
      };
    }
    const item = await loadHumanTaskListItem(ctx, task, args.classifiedAt);
    if (item === null) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    return {
      ok: true as const,
      data: {
        now: args.classifiedAt,
        view: args.view,
        taskId: task.publicId,
        projectionRevision: patchHeads.projectionRevision,
        continuationRevision: patchHeads.continuationRevision,
        membership: { kind: "present" as const, item },
      },
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export const taskList = query({
  args: {
    workspaceId: v.string(),
    view: humanTaskViewValidator,
    assignedAgentId: v.optional(v.string()),
    classifiedAt: v.optional(v.number()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: taskListResultValidator,
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_PAGE_LIMIT;
    const observedAt = Date.now();
    if (!validHumanTaskPageRead({ ...args, limit }, observedAt)) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const classifiedAt = args.classifiedAt ?? observedAt;
    const [page, countProjection] = await Promise.all([
      readAuthorizedHumanTaskPage(ctx, authorized.authorization, {
        view: args.view,
        ...(args.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: args.assignedAgentId }),
        classifiedAt,
        observedAt,
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        limit,
      }),
      readAuthorizedHumanTaskCounts(
        ctx,
        authorized.authorization,
        classifiedAt,
      ),
    ]);
    if (!page.ok) return page;
    if (!countProjection.ok) return countProjection;
    const data = joinHumanTaskListData(page.data, countProjection.data);
    if (data === null) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    return {
      ok: true as const,
      data,
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export const agentClaims = query({
  args: {
    workspaceId: v.string(),
    agentId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: agentClaimsResultValidator,
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_PAGE_LIMIT;
    if (!validPage(limit, args.cursor)) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const { organization, workspace } = authorized.authorization;
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_public_id", (index) => index.eq("publicId", args.agentId))
      .unique();
    if (agent === null || agent.organizationId !== organization._id) {
      return domainFailure("NOT_FOUND", QUERY_REQUEST_ID);
    }
    const grant = await ctx.db
      .query("agentWorkspaceGrants")
      .withIndex("by_workspace_and_agent", (index) =>
        index.eq("workspaceId", workspace._id).eq("agentId", agent._id),
      )
      .unique();
    if (
      grant === null ||
      !belongsToHumanTaskTenant(grant, {
        organizationId: organization._id,
        workspaceId: workspace._id,
      })
    ) {
      return domainFailure("NOT_FOUND", QUERY_REQUEST_ID);
    }
    const page = await ctx.db
      .query("taskClaims")
      .withIndex("by_workspace_agent_state", (index) =>
        index
          .eq("workspaceId", workspace._id)
          .eq("agentId", agent._id)
          .eq("state", "active"),
      )
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    const now = Date.now();
    const claims = [];
    for (const claim of page.page) {
      if (
        !belongsToHumanTaskTenant(claim, {
          organizationId: organization._id,
          workspaceId: workspace._id,
        }) ||
        claim.agentId !== agent._id ||
        claim.agentPublicId !== agent.publicId
      ) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
      }
      const task = await ctx.db.get(claim.taskId);
      if (
        task === null ||
        !belongsToHumanTaskTenant(task, {
          organizationId: organization._id,
          workspaceId: workspace._id,
        }) ||
        task.status !== "in_progress" ||
        task.currentClaim?.claimId !== claim._id ||
        !(await taskProjectionIsConsistent(ctx, task))
      ) {
        return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
      }
      claims.push({
        id: claim.publicId,
        fence: claim.fence,
        leaseGeneration: claim.leaseGeneration,
        leaseUntil: claim.leaseUntil,
        expired: claim.leaseUntil <= now,
        task: taskView(task),
      });
    }
    return {
      ok: true as const,
      data: {
        now,
        agent: {
          id: agent.publicId,
          name: agent.name,
          status: agent.status,
          grantStatus: grant.status,
          scopes: grant.scopes,
        },
        claims,
        cursor: page.isDone ? null : page.continueCursor,
      },
      requestId: QUERY_REQUEST_ID,
    };
  },
});
