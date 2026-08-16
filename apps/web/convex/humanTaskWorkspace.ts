import {
  agentIdSchema,
  taskPublicIdSchema,
  workspacePublicIdSchema,
} from "@hraness/agent-tasks-domain";
import { dispatchIdSchema } from "@hraness/agent-tasks-protocol";
import { makeFunctionReference } from "convex/server";
import { type Infer, v } from "convex/values";

import { query } from "./_generated/server";
import {
  humanReadinessDataValidator,
  humanRunsDataValidator,
} from "./dispatch";
import type {
  humanReadinessResultValidator,
  humanRunsResultValidator,
} from "./dispatch";
import { domainFailure } from "./domain";
import { humanAdminRequestFingerprint } from "./humanAdminFingerprint";
import { authorizeWorkspaceHuman } from "./humanAuthorization";
import { humanTaskDetailDataValidator } from "./humanTaskDetail";
import type { detailResultValidator } from "./humanTaskDetail";
import {
  humanTaskViewValidator,
  joinHumanTaskListData,
  taskListDataValidator,
  taskPageDataValidator,
  workspaceContextDataValidator,
  type HumanTaskView,
} from "./humanTaskQueries";
import type {
  taskCountsResultValidator,
  taskPageResultValidator,
  workspaceContextResultValidator,
} from "./humanTaskQueries";
import { domainErrorValidator } from "./model";
import {
  workspaceProjectionHeads,
  workspaceTaskViewValues,
  type WorkspaceProjectionHeads,
  type WorkspaceTaskView,
  type WorkspaceTaskViewRevisions,
} from "./hraProjection";

const QUERY_REQUEST_ID = "req_00000000000000000000000000";
const SOURCE_TOKEN_VERSION = 3;
const SOURCE_TOKEN_TTL_MS = 5 * 60 * 1_000;
const SOURCE_TOKEN_FUTURE_SKEW_MS = 30_000;
const MAX_TOKEN_CHARACTERS = 8_192;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 50;
const DEFAULT_CHANGE_LIMIT = 50;
const MAX_CHANGE_LIMIT = 100;

export type HostedTaskSourceState = Readonly<{
  version: 3;
  kind: "task_workspace_source";
  organizationId: string;
  userId: string;
  workspaceId: string;
  continuationRevision: number;
  view: HumanTaskView;
  assignedAgentId: string | null;
  selectedTaskId: string | null;
  classifiedAt: number;
  expiresAt: number;
}>;

type HostedTaskPageState = Readonly<{
  version: 3;
  kind: "task_workspace_page";
  sourceDigest: string;
  continuation: string;
}>;

type HostedTaskSourceBinding = Readonly<{
  organizationId: string;
  userId: string;
  workspaceId: string;
  view: HumanTaskView;
  assignedAgentId: string | null;
  selectedTaskId: string | null;
}>;

const sourceValidator = v.object({
  kind: v.literal("hosted"),
  token: v.string(),
  workspaceId: v.string(),
  projectionRevision: v.number(),
  continuationRevision: v.number(),
  view: humanTaskViewValidator,
  assignedAgentId: v.optional(v.string()),
  selectedTaskId: v.optional(v.string()),
  classifiedAt: v.number(),
  expiresAt: v.number(),
});

const rootPageValidator = v.object({
  workspaceId: v.string(),
  projectionRevision: v.number(),
  continuationRevision: v.number(),
  view: humanTaskViewValidator,
  assignedAgentId: v.optional(v.string()),
  data: taskListDataValidator,
});

const continuationPageValidator = v.object({
  workspaceId: v.string(),
  projectionRevision: v.number(),
  continuationRevision: v.number(),
  view: humanTaskViewValidator,
  assignedAgentId: v.optional(v.string()),
  data: taskPageDataValidator,
});

const taskViewRevisionsValidator = v.object({
  all: v.number(),
  ready: v.number(),
  blocked: v.number(),
  deferred: v.number(),
  attention: v.number(),
  assigned: v.number(),
  review: v.number(),
});

export const hostedTaskWorkspaceHeadsDataValidator = v.object({
  workspaceId: v.string(),
  view: humanTaskViewValidator,
  projectionRevision: v.number(),
  continuationRevision: v.number(),
  taskViewRevisions: taskViewRevisionsValidator,
});

export const hostedTaskWorkspaceHeadsResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: hostedTaskWorkspaceHeadsDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const hostedTaskWorkspaceChangeValidator = v.union(
  v.object({
    projectionRevision: v.number(),
    scope: v.literal("workspace"),
    createdAt: v.number(),
  }),
  v.object({
    projectionRevision: v.number(),
    scope: v.literal("task"),
    taskId: v.string(),
    views: v.array(humanTaskViewValidator),
    structure: v.boolean(),
    createdAt: v.number(),
  }),
  v.object({
    projectionRevision: v.number(),
    scope: v.literal("run"),
    taskId: v.string(),
    runId: v.string(),
    views: v.array(humanTaskViewValidator),
    structure: v.boolean(),
    createdAt: v.number(),
  }),
);

export const hostedTaskWorkspaceChangesDataValidator = v.object({
  workspaceId: v.string(),
  fromRevision: v.number(),
  throughRevision: v.number(),
  projectionRevision: v.number(),
  taskViewRevisions: taskViewRevisionsValidator,
  changes: v.array(hostedTaskWorkspaceChangeValidator),
  hasMore: v.boolean(),
  resetRequired: v.boolean(),
});

type HostedTaskWorkspaceChangesData = Infer<
  typeof hostedTaskWorkspaceChangesDataValidator
>;

export const hostedTaskWorkspaceChangesResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: hostedTaskWorkspaceChangesDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export const hostedTaskWorkspacePresentationDataValidator = v.object({
  observedAt: v.number(),
  workspace: workspaceContextDataValidator,
  readiness: humanReadinessDataValidator,
});

export const hostedTaskWorkspacePresentationResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: hostedTaskWorkspacePresentationDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export const hostedTaskWorkspaceDataValidator = v.object({
  source: sourceValidator,
  context: hostedTaskWorkspacePresentationDataValidator,
  page: rootPageValidator,
  selected: v.union(
    v.null(),
    v.object({
      taskId: v.string(),
      workspaceId: v.string(),
      projectionRevision: v.number(),
      detail: humanTaskDetailDataValidator,
      runs: humanRunsDataValidator,
    }),
  ),
});

const projectionResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: hostedTaskWorkspaceDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export const hostedTaskContinuationDataValidator = v.object({
  source: sourceValidator,
  page: continuationPageValidator,
});

const continuationResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: hostedTaskContinuationDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

type WorkspaceContextResult = Infer<typeof workspaceContextResultValidator>;
type TaskPageResult = Infer<typeof taskPageResultValidator>;
type TaskCountsResult = Infer<typeof taskCountsResultValidator>;
type ReadinessResult = Infer<typeof humanReadinessResultValidator>;
type DetailResult = Infer<typeof detailResultValidator>;
type RunsResult = Infer<typeof humanRunsResultValidator>;

export type HostedTaskInvalidationRow = Readonly<{
  organizationId: string;
  workspaceId: string;
  workspacePublicId: string;
  projectionRevision: number;
  scope: "workspace" | "task" | "run";
  taskPublicId?: string;
  runPublicId?: string;
  views?: readonly WorkspaceTaskView[];
  structure?: boolean;
  createdAt: number;
}>;

export type HostedTaskWorkspaceChange =
  | Readonly<{
      projectionRevision: number;
      scope: "workspace";
      createdAt: number;
    }>
  | Readonly<{
      projectionRevision: number;
      scope: "task";
      taskId: string;
      views: readonly WorkspaceTaskView[];
      structure: boolean;
      createdAt: number;
    }>
  | Readonly<{
      projectionRevision: number;
      scope: "run";
      taskId: string;
      runId: string;
      views: readonly WorkspaceTaskView[];
      structure: boolean;
      createdAt: number;
    }>;

export type HostedTaskWorkspaceChangeFeed = Readonly<{
  workspaceId: string;
  fromRevision: number;
  throughRevision: number;
  projectionRevision: number;
  taskViewRevisions: WorkspaceTaskViewRevisions;
  changes: readonly HostedTaskWorkspaceChange[];
  hasMore: boolean;
  resetRequired: boolean;
}>;

function normalizeChangeViews(
  views: readonly WorkspaceTaskView[] | undefined,
): readonly WorkspaceTaskView[] | null {
  if (
    views === undefined ||
    views.length < 1 ||
    views.length > workspaceTaskViewValues.length
  ) {
    return null;
  }
  const unique = new Set<WorkspaceTaskView>();
  for (const view of views) {
    if (!workspaceTaskViewValues.includes(view) || unique.has(view)) return null;
    unique.add(view);
  }
  return workspaceTaskViewValues.filter((view) => unique.has(view));
}

function publicHostedTaskChange(
  row: HostedTaskInvalidationRow,
): HostedTaskWorkspaceChange | null {
  if (
    !Number.isSafeInteger(row.projectionRevision) ||
    row.projectionRevision < 1 ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt < 0
  ) {
    return null;
  }
  if (row.scope === "workspace") {
    if (
      row.taskPublicId !== undefined ||
      row.runPublicId !== undefined ||
      row.views !== undefined ||
      row.structure !== undefined
    ) {
      return null;
    }
    return {
      projectionRevision: row.projectionRevision,
      scope: "workspace",
      createdAt: row.createdAt,
    };
  }
  const views = normalizeChangeViews(row.views);
  if (
    !taskPublicIdSchema.safeParse(row.taskPublicId).success ||
    views === null ||
    typeof row.structure !== "boolean"
  ) {
    return null;
  }
  if (row.scope === "task") {
    if (row.runPublicId !== undefined) return null;
    return {
      projectionRevision: row.projectionRevision,
      scope: "task",
      taskId: row.taskPublicId ?? "",
      views,
      structure: row.structure,
      createdAt: row.createdAt,
    };
  }
  if (!dispatchIdSchema.safeParse(row.runPublicId).success) return null;
  return {
    projectionRevision: row.projectionRevision,
    scope: "run",
    taskId: row.taskPublicId ?? "",
    runId: row.runPublicId ?? "",
    views,
    structure: row.structure,
    createdAt: row.createdAt,
  };
}

/**
 * Validates and compacts one bounded ordered invalidation page. A missing head
 * or a legacy workspace row requests a root refresh instead of guessing.
 */
export function buildHostedTaskWorkspaceChangeFeed(input: Readonly<{
  tenant: Readonly<{
    organizationId: string;
    workspaceId: string;
    workspacePublicId: string;
  }>;
  afterRevision: number;
  limit: number;
  heads: WorkspaceProjectionHeads;
  rows: readonly HostedTaskInvalidationRow[];
}>): HostedTaskWorkspaceChangeFeed | null {
  if (
    !Number.isSafeInteger(input.afterRevision) ||
    input.afterRevision < 0 ||
    input.afterRevision > input.heads.projectionRevision ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_CHANGE_LIMIT ||
    input.rows.length > input.limit + 1
  ) {
    return null;
  }
  if (input.rows.some((row) =>
    row.organizationId !== input.tenant.organizationId ||
    row.workspaceId !== input.tenant.workspaceId ||
    row.workspacePublicId !== input.tenant.workspacePublicId ||
    row.projectionRevision > input.heads.projectionRevision
  )) {
    return null;
  }
  const selected = input.rows.slice(0, input.limit);
  const changes: HostedTaskWorkspaceChange[] = [];
  let expectedRevision = input.afterRevision + 1;
  let gap = false;
  for (const row of selected) {
    if (row.projectionRevision !== expectedRevision) {
      gap = true;
      break;
    }
    const change = publicHostedTaskChange(row);
    if (change === null) return null;
    changes.push(change);
    expectedRevision += 1;
  }
  const throughRevision = changes.at(-1)?.projectionRevision ?? input.afterRevision;
  const resetRequired = gap ||
    changes.some((change) => change.scope === "workspace") ||
    (throughRevision < input.heads.projectionRevision && selected.length === 0);
  return {
    workspaceId: input.tenant.workspacePublicId,
    fromRevision: input.afterRevision,
    throughRevision: resetRequired
      ? input.heads.projectionRevision
      : throughRevision,
    projectionRevision: input.heads.projectionRevision,
    taskViewRevisions: input.heads.taskViewRevisions,
    changes,
    hasMore: !resetRequired && throughRevision < input.heads.projectionRevision,
    resetRequired,
  };
}

// Explicit references avoid making this module's generated API type depend on
// itself. Every referenced function still validates and authorizes its public
// boundary, and Convex can cache each nested query independently.
const workspaceContextReference = makeFunctionReference<
  "query",
  { workspaceId: string },
  WorkspaceContextResult
>("humanTaskQueries:workspaceContext");
const taskPageReference = makeFunctionReference<
  "query",
  {
    workspaceId: string;
    view: HumanTaskView;
    assignedAgentId?: string;
    classifiedAt: number;
    cursor?: string;
    limit?: number;
  },
  TaskPageResult
>("humanTaskQueries:taskPage");
const taskCountsReference = makeFunctionReference<
  "query",
  { workspaceId: string; classifiedAt: number },
  TaskCountsResult
>("humanTaskQueries:taskCounts");
const readinessReference = makeFunctionReference<
  "query",
  { workspaceId: string; repositoryId?: string },
  ReadinessResult
>("dispatch:humanReadiness");
const detailReference = makeFunctionReference<
  "query",
  { workspaceId: string; key: string; classifiedAt?: number },
  DetailResult
>("humanTaskDetail:detail");
const runsReference = makeFunctionReference<
  "query",
  { workspaceId: string; taskKey?: string; limit?: number },
  RunsResult
>("dispatch:humanTaskRuns");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | null {
  if (
    value.length < 1 ||
    value.length > MAX_TOKEN_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return null;
  }
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = `${normalized}${"=".repeat((4 - normalized.length % 4) % 4)}`;
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

export function encodeHostedTaskSourceToken(
  state: HostedTaskSourceState,
): string {
  const token = encodeBase64Url(JSON.stringify(state));
  if (token.length > MAX_TOKEN_CHARACTERS) {
    throw new Error("Hosted task source token exceeded its portable bound.");
  }
  return token;
}

export function decodeHostedTaskSourceToken(
  token: string,
): HostedTaskSourceState | null {
  const decoded = decodeBase64Url(token);
  if (decoded === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "assignedAgentId",
      "classifiedAt",
      "continuationRevision",
      "expiresAt",
      "kind",
      "organizationId",
      "selectedTaskId",
      "userId",
      "version",
      "view",
      "workspaceId",
    ]) ||
    value.version !== SOURCE_TOKEN_VERSION ||
    value.kind !== "task_workspace_source" ||
    typeof value.organizationId !== "string" ||
    value.organizationId.length < 1 ||
    value.organizationId.length > 128 ||
    typeof value.userId !== "string" ||
    value.userId.length < 1 ||
    value.userId.length > 128 ||
    typeof value.workspaceId !== "string" ||
    !workspacePublicIdSchema.safeParse(value.workspaceId).success ||
    typeof value.continuationRevision !== "number" ||
    !Number.isSafeInteger(value.continuationRevision) ||
    value.continuationRevision < 1 ||
    typeof value.view !== "string" ||
    ![
      "all",
      "ready",
      "blocked",
      "deferred",
      "attention",
      "assigned",
      "review",
    ].includes(value.view) ||
    (value.assignedAgentId !== null &&
      !agentIdSchema.safeParse(value.assignedAgentId).success) ||
    (value.selectedTaskId !== null &&
      !taskPublicIdSchema.safeParse(value.selectedTaskId).success) ||
    typeof value.classifiedAt !== "number" ||
    !Number.isSafeInteger(value.classifiedAt) ||
    value.classifiedAt < 0 ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt !== value.classifiedAt + SOURCE_TOKEN_TTL_MS ||
    value.expiresAt <= value.classifiedAt ||
    (value.view !== "assigned" && value.assignedAgentId !== null)
  ) {
    return null;
  }
  return {
    version: 3,
    kind: "task_workspace_source",
    organizationId: value.organizationId,
    userId: value.userId,
    workspaceId: value.workspaceId,
    continuationRevision: value.continuationRevision,
    view: value.view as HumanTaskView,
    assignedAgentId: value.assignedAgentId as string | null,
    selectedTaskId: value.selectedTaskId as string | null,
    classifiedAt: value.classifiedAt,
    expiresAt: value.expiresAt,
  };
}

function sourceMatchesBinding(
  source: HostedTaskSourceState,
  binding: HostedTaskSourceBinding,
): boolean {
  return source.organizationId === binding.organizationId &&
    source.userId === binding.userId &&
    source.workspaceId === binding.workspaceId &&
    source.view === binding.view &&
    source.assignedAgentId === binding.assignedAgentId &&
    source.selectedTaskId === binding.selectedTaskId;
}

function encodeHostedTaskPageToken(
  sourceToken: string,
  continuation: string,
): string | null {
  const value: HostedTaskPageState = {
    version: SOURCE_TOKEN_VERSION,
    kind: "task_workspace_page",
    sourceDigest: humanAdminRequestFingerprint(sourceToken),
    continuation,
  };
  const token = encodeBase64Url(JSON.stringify(value));
  return token.length <= MAX_TOKEN_CHARACTERS ? token : null;
}

function decodeHostedTaskPageToken(
  token: string,
  sourceToken: string,
): HostedTaskPageState | null {
  const decoded = decodeBase64Url(token);
  if (decoded === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["continuation", "kind", "sourceDigest", "version"]) ||
    value.version !== SOURCE_TOKEN_VERSION ||
    value.kind !== "task_workspace_page" ||
    value.sourceDigest !== humanAdminRequestFingerprint(sourceToken) ||
    typeof value.continuation !== "string" ||
    value.continuation.length < 1 ||
    value.continuation.length > MAX_TOKEN_CHARACTERS
  ) {
    return null;
  }
  return {
    version: 3,
    kind: "task_workspace_page",
    sourceDigest: value.sourceDigest,
    continuation: value.continuation,
  };
}

function publicSource(
  source: HostedTaskSourceState,
  token: string,
  projectionRevision: number,
) {
  return {
    kind: "hosted" as const,
    token,
    workspaceId: source.workspaceId,
    projectionRevision,
    continuationRevision: source.continuationRevision,
    view: source.view,
    ...(source.assignedAgentId === null
      ? {}
      : { assignedAgentId: source.assignedAgentId }),
    ...(source.selectedTaskId === null
      ? {}
      : { selectedTaskId: source.selectedTaskId }),
    classifiedAt: source.classifiedAt,
    expiresAt: source.expiresAt,
  };
}

function publicPage<Data extends { cursor: string | null }>(
  source: HostedTaskSourceState,
  sourceToken: string,
  projectionRevision: number,
  data: Data,
) {
  const cursor = data.cursor === null
    ? null
    : encodeHostedTaskPageToken(sourceToken, data.cursor);
  if (data.cursor !== null && cursor === null) return null;
  return {
    workspaceId: source.workspaceId,
    projectionRevision,
    continuationRevision: source.continuationRevision,
    view: source.view,
    ...(source.assignedAgentId === null
      ? {}
      : { assignedAgentId: source.assignedAgentId }),
    data: { ...data, cursor },
  };
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_LIMIT;
}

function newSource(
  binding: HostedTaskSourceBinding,
  continuationRevision: number,
  observedAt: number,
): HostedTaskSourceState {
  return {
    version: SOURCE_TOKEN_VERSION,
    kind: "task_workspace_source",
    ...binding,
    continuationRevision,
    classifiedAt: observedAt,
    expiresAt: observedAt + SOURCE_TOKEN_TTL_MS,
  };
}

function encodeSourceOrNull(source: HostedTaskSourceState): string | null {
  try {
    return encodeHostedTaskSourceToken(source);
  } catch {
    return null;
  }
}

/**
 * Watches the complete presentation authority in one Convex snapshot. Counts
 * remain part of the projection root, while identity, capabilities, agents,
 * repositories, and runner readiness update atomically here.
 */
export const presentation = query({
  args: { workspaceId: v.string() },
  returns: hostedTaskWorkspacePresentationResultValidator,
  handler: async (ctx, args) => {
    if (!workspacePublicIdSchema.safeParse(args.workspaceId).success) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const observedAt = Date.now();
    const [workspace, readiness] = await Promise.all([
      ctx.runQuery(workspaceContextReference, { workspaceId: args.workspaceId }),
      ctx.runQuery(readinessReference, { workspaceId: args.workspaceId }),
    ]);
    if (!workspace.ok) return workspace;
    if (!readiness.ok) return readiness;
    if (workspace.data.workspace.id !== args.workspaceId) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    return {
      ok: true as const,
      data: { observedAt, workspace: workspace.data, readiness: readiness.data },
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export const heads = query({
  args: {
    workspaceId: v.string(),
    view: v.optional(humanTaskViewValidator),
  },
  returns: hostedTaskWorkspaceHeadsResultValidator,
  handler: async (ctx, args) => {
    if (!workspacePublicIdSchema.safeParse(args.workspaceId).success) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const { workspace } = authorized.authorization;
    const current = await workspaceProjectionHeads(ctx, workspace._id);
    const view = args.view ?? "all";
    return {
      ok: true as const,
      data: {
        workspaceId: workspace.publicId,
        view,
        projectionRevision: current.projectionRevision,
        continuationRevision: current.taskViewRevisions[view],
        taskViewRevisions: current.taskViewRevisions,
      },
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export const changes = query({
  args: {
    workspaceId: v.string(),
    afterRevision: v.number(),
    limit: v.optional(v.number()),
  },
  returns: hostedTaskWorkspaceChangesResultValidator,
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_CHANGE_LIMIT;
    if (
      !workspacePublicIdSchema.safeParse(args.workspaceId).success ||
      !Number.isSafeInteger(args.afterRevision) ||
      args.afterRevision < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CHANGE_LIMIT
    ) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const { organization, workspace } = authorized.authorization;
    const current = await workspaceProjectionHeads(ctx, workspace._id);
    if (args.afterRevision > current.projectionRevision) {
      return domainFailure("TASK_STATE_CONFLICT", QUERY_REQUEST_ID, {
        currentRevision: current.projectionRevision,
      });
    }
    const rows = await ctx.db
      .query("workspaceInvalidations")
      .withIndex("by_workspace_and_revision", (index) =>
        index
          .eq("workspaceId", workspace._id)
          .gt("projectionRevision", args.afterRevision),
      )
      .order("asc")
      .take(limit + 1);
    const feed = buildHostedTaskWorkspaceChangeFeed({
      tenant: {
        organizationId: organization._id,
        workspaceId: workspace._id,
        workspacePublicId: workspace.publicId,
      },
      afterRevision: args.afterRevision,
      limit,
      heads: current,
      rows,
    });
    if (feed === null) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    const data: HostedTaskWorkspaceChangesData = {
      workspaceId: feed.workspaceId,
      fromRevision: feed.fromRevision,
      throughRevision: feed.throughRevision,
      projectionRevision: feed.projectionRevision,
      taskViewRevisions: { ...feed.taskViewRevisions },
      changes: feed.changes.map((change) => {
        switch (change.scope) {
          case "workspace":
            return {
              projectionRevision: change.projectionRevision,
              scope: change.scope,
              createdAt: change.createdAt,
            };
          case "task":
            return {
              projectionRevision: change.projectionRevision,
              scope: change.scope,
              taskId: change.taskId,
              views: [...change.views],
              structure: change.structure,
              createdAt: change.createdAt,
            };
          case "run":
            return {
              projectionRevision: change.projectionRevision,
              scope: change.scope,
              taskId: change.taskId,
              runId: change.runId,
              views: [...change.views],
              structure: change.structure,
              createdAt: change.createdAt,
            };
          default: {
            const exhaustiveChange: never = change;
            return exhaustiveChange;
          }
        }
      }),
      hasMore: feed.hasMore,
      resetRequired: feed.resetRequired,
    };
    return {
      ok: true as const,
      data,
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export const projection = query({
  args: {
    workspaceId: v.string(),
    view: humanTaskViewValidator,
    assignedAgentId: v.optional(v.string()),
    selectedTaskId: v.optional(v.string()),
    sourceToken: v.optional(v.string()),
  },
  returns: projectionResultValidator,
  handler: async (ctx, args) => {
    if (
      !workspacePublicIdSchema.safeParse(args.workspaceId).success ||
      (args.view !== "assigned" && args.assignedAgentId !== undefined) ||
      (args.selectedTaskId !== undefined &&
        !taskPublicIdSchema.safeParse(args.selectedTaskId).success) ||
      (args.assignedAgentId !== undefined &&
        !agentIdSchema.safeParse(args.assignedAgentId).success)
    ) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const { organization, user, workspace } = authorized.authorization;
    const binding: HostedTaskSourceBinding = {
      organizationId: organization.publicId,
      userId: user.publicId,
      workspaceId: workspace.publicId,
      view: args.view,
      assignedAgentId: args.assignedAgentId ?? null,
      selectedTaskId: args.selectedTaskId ?? null,
    };
    const observedAt = Date.now();
    const current = await workspaceProjectionHeads(ctx, workspace._id);
    let source: HostedTaskSourceState | null = null;
    if (args.sourceToken !== undefined) {
      const decoded = decodeHostedTaskSourceToken(args.sourceToken);
      if (decoded === null || !sourceMatchesBinding(decoded, binding)) {
        return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
      }
      if (
        decoded.continuationRevision === current.taskViewRevisions[decoded.view] &&
        decoded.expiresAt > observedAt &&
        decoded.classifiedAt <= observedAt + SOURCE_TOKEN_FUTURE_SKEW_MS
      ) {
        source = decoded;
      }
    }
    source ??= newSource(
      binding,
      current.taskViewRevisions[binding.view],
      observedAt,
    );
    const sourceToken = encodeSourceOrNull(source);
    if (sourceToken === null) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }

    const selectedTask = source.selectedTaskId === null
      ? null
      : await ctx.db
          .query("tasks")
          .withIndex("by_workspace_and_public_id", (index) =>
            index
              .eq("workspaceId", workspace._id)
              .eq("publicId", source.selectedTaskId ?? ""),
          )
          .unique();
    if (
      source.selectedTaskId !== null &&
      (selectedTask === null ||
        selectedTask.organizationId !== organization._id ||
        selectedTask.workspaceId !== workspace._id)
    ) {
      return domainFailure("NOT_FOUND", QUERY_REQUEST_ID);
    }

    const [context, readiness, page, counts, detail, runs] = await Promise.all([
      ctx.runQuery(workspaceContextReference, {
        workspaceId: source.workspaceId,
      }),
      ctx.runQuery(readinessReference, {
        workspaceId: source.workspaceId,
      }),
      ctx.runQuery(taskPageReference, {
        workspaceId: source.workspaceId,
        view: source.view,
        ...(source.assignedAgentId === null
          ? {}
          : { assignedAgentId: source.assignedAgentId }),
        classifiedAt: source.classifiedAt,
        limit: DEFAULT_PAGE_LIMIT,
      }),
      ctx.runQuery(taskCountsReference, {
        workspaceId: source.workspaceId,
        classifiedAt: source.classifiedAt,
      }),
      selectedTask === null
        ? Promise.resolve(null)
        : ctx.runQuery(detailReference, {
            workspaceId: source.workspaceId,
            key: selectedTask.key,
            classifiedAt: source.classifiedAt,
          }),
      selectedTask === null
        ? Promise.resolve(null)
        : ctx.runQuery(runsReference, {
            workspaceId: source.workspaceId,
            taskKey: selectedTask.key,
            limit: 20,
          }),
    ]);
    if (!context.ok) return context;
    if (!readiness.ok) return readiness;
    if (!page.ok) return page;
    if (!counts.ok) return counts;
    if (detail !== null && !detail.ok) return detail;
    if (runs !== null && !runs.ok) return runs;
    const list = joinHumanTaskListData(page.data, counts.data);
    if (
      list === null ||
      context.data.workspace.id !== source.workspaceId ||
      list.view !== source.view ||
      list.now !== source.classifiedAt ||
      (detail === null) !== (source.selectedTaskId === null) ||
      (runs === null) !== (source.selectedTaskId === null) ||
      (detail !== null &&
        (detail.data.task.id !== source.selectedTaskId ||
          detail.data.task.key !== selectedTask?.key ||
          runs === null)) ||
      (runs !== null && runs.data.runs.some((run) =>
        run.taskKey !== selectedTask?.key))
    ) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    const selected = detail === null || runs === null
      ? null
      : {
          taskId: detail.data.task.id,
          workspaceId: source.workspaceId,
          projectionRevision: current.projectionRevision,
          detail: detail.data,
          runs: runs.data,
        };
    const firstPage = publicPage(
      source,
      sourceToken,
      current.projectionRevision,
      list,
    );
    if (firstPage === null) {
      return domainFailure("SERVICE_UNAVAILABLE", QUERY_REQUEST_ID);
    }
    return {
      ok: true as const,
      data: {
        source: publicSource(source, sourceToken, current.projectionRevision),
        context: {
          observedAt,
          workspace: context.data,
          readiness: readiness.data,
        },
        page: firstPage,
        selected,
      },
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export const continuePage = query({
  args: {
    workspaceId: v.string(),
    sourceToken: v.string(),
    cursor: v.string(),
    limit: v.optional(v.number()),
  },
  returns: continuationResultValidator,
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_PAGE_LIMIT;
    if (
      !workspacePublicIdSchema.safeParse(args.workspaceId).success ||
      !validLimit(limit)
    ) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const source = decodeHostedTaskSourceToken(args.sourceToken);
    const pageToken = decodeHostedTaskPageToken(args.cursor, args.sourceToken);
    if (
      source === null ||
      pageToken === null ||
      source.workspaceId !== args.workspaceId
    ) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const { organization, user, workspace } = authorized.authorization;
    const binding: HostedTaskSourceBinding = {
      organizationId: organization.publicId,
      userId: user.publicId,
      workspaceId: workspace.publicId,
      view: source.view,
      assignedAgentId: source.assignedAgentId,
      selectedTaskId: source.selectedTaskId,
    };
    if (!sourceMatchesBinding(source, binding)) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const observedAt = Date.now();
    const current = await workspaceProjectionHeads(ctx, workspace._id);
    if (
      source.expiresAt <= observedAt ||
      source.classifiedAt > observedAt + SOURCE_TOKEN_FUTURE_SKEW_MS ||
      source.continuationRevision !== current.taskViewRevisions[source.view]
    ) {
      return domainFailure("TASK_STATE_CONFLICT", QUERY_REQUEST_ID, {
        currentRevision: current.projectionRevision,
      });
    }
    const page = await ctx.runQuery(taskPageReference, {
      workspaceId: source.workspaceId,
      view: source.view,
      ...(source.assignedAgentId === null
        ? {}
        : { assignedAgentId: source.assignedAgentId }),
      classifiedAt: source.classifiedAt,
      cursor: pageToken.continuation,
      limit,
    });
    if (!page.ok) return page;
    if (
      page.data.view !== source.view ||
      page.data.now !== source.classifiedAt
    ) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    const continuation = publicPage(
      source,
      args.sourceToken,
      current.projectionRevision,
      page.data,
    );
    if (continuation === null) {
      return domainFailure("SERVICE_UNAVAILABLE", QUERY_REQUEST_ID);
    }
    return {
      ok: true as const,
      data: {
        source: publicSource(
          source,
          args.sourceToken,
          current.projectionRevision,
        ),
        page: continuation,
      },
      requestId: QUERY_REQUEST_ID,
    };
  },
});
