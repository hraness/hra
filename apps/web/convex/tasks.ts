import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { authorizeAgent, touchAuthorizedAgent, type AuthorizedAgent } from "./authorization";
import {
  assertRequestMetadata,
  domainFailure,
  isTaskReady,
  lookupReceipt,
  parseTaskData,
  randomCrockford,
  randomPublicId,
  storeReceipt,
  taskView,
} from "./domain";
import { appendTaskEvent } from "./events";
import {
  CLAIM_RENEWAL_THRESHOLD_MS,
  DEFAULT_CLAIM_LEASE_MS,
  MAX_DEFER_MS,
  TASK_KEY_SUFFIX_LENGTH,
  contextDataValidator,
  domainErrorValidator,
  readyTasksDataValidator,
  taskDataValidator,
  taskTypeValidator,
} from "./model";
import {
  agentRateLimitFailure,
  consumeAuthorizedAgentRateLimit,
} from "./rateLimits";
import {
  activeClaimMatchesTask,
  ensureCounterProjection,
  queueTaskClaimRepair,
  queueTaskProjectionRepair,
} from "./workGraph";
import { claimCommandDisposition, nextClaimFence } from "./workGraphLaws";

const taskResultValidator = v.union(
  v.object({ ok: v.literal(true), data: taskDataValidator, requestId: v.string() }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
const readyResultValidator = v.union(
  v.object({ ok: v.literal(true), data: readyTasksDataValidator, requestId: v.string() }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);
const contextResultValidator = v.union(
  v.object({ ok: v.literal(true), data: contextDataValidator, requestId: v.string() }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const READY_CURSOR_VERSION = 1;
const READY_CURSOR_MAX_LENGTH = 8_192;
const READY_CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const READY_CURSOR_FUTURE_SKEW_MS = 5 * 60 * 1_000;

interface ReadyCursorState {
  readonly version: 1;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly snapshotAt: number;
  readonly phase: "open" | "overdue";
  readonly continuation: string | null;
}

type ReadRelationResult<Value> =
  | { readonly ok: true; readonly data: Value }
  | { readonly ok: false };

export function readTaskTenantMatches(input: {
  readonly authorizationOrganizationId: string;
  readonly authorizationWorkspaceId: string;
  readonly taskOrganizationId: string;
  readonly taskWorkspaceId: string;
}): boolean {
  return (
    input.taskOrganizationId === input.authorizationOrganizationId &&
    input.taskWorkspaceId === input.authorizationWorkspaceId
  );
}

export function readRelationTupleMatches(input: {
  readonly authorizationOrganizationId: string;
  readonly authorizationWorkspaceId: string;
  readonly taskOrganizationId: string;
  readonly taskWorkspaceId: string;
  readonly taskId: string;
  readonly recordOrganizationId: string;
  readonly recordWorkspaceId: string;
  readonly recordTaskId: string;
}): boolean {
  return (
    readTaskTenantMatches(input) &&
    input.recordOrganizationId === input.taskOrganizationId &&
    input.recordWorkspaceId === input.taskWorkspaceId &&
    input.recordTaskId === input.taskId
  );
}

function taskMatchesAuthorization(
  task: Doc<"tasks">,
  authorization: Pick<AuthorizedAgent, "organizationId" | "workspaceId">,
): boolean {
  return readTaskTenantMatches({
    authorizationOrganizationId: authorization.organizationId,
    authorizationWorkspaceId: authorization.workspaceId,
    taskOrganizationId: task.organizationId,
    taskWorkspaceId: task.workspaceId,
  });
}

function relationMatchesAuthorization(
  task: Doc<"tasks">,
  record: Pick<Doc<"taskClaims"> | Doc<"taskSubmissions">, "organizationId" | "workspaceId" | "taskId">,
  authorization: Pick<AuthorizedAgent, "organizationId" | "workspaceId">,
): boolean {
  return readRelationTupleMatches({
    authorizationOrganizationId: authorization.organizationId,
    authorizationWorkspaceId: authorization.workspaceId,
    taskOrganizationId: task.organizationId,
    taskWorkspaceId: task.workspaceId,
    taskId: task._id,
    recordOrganizationId: record.organizationId,
    recordWorkspaceId: record.workspaceId,
    recordTaskId: record.taskId,
  });
}

function receiptIdentity(authorization: AuthorizedAgent) {
  return {
    kind: "agent" as const,
    publicId: authorization.agentPublicId,
    organizationId: authorization.organizationId,
    workspaceId: authorization.workspaceId,
  };
}

function agentActor(authorization: AuthorizedAgent) {
  return {
    kind: "agent" as const,
    agentId: authorization.agentPublicId,
    credentialId: authorization.credentialPublicId,
    sessionId: authorization.sessionPublicId,
  };
}

async function taskByKey(ctx: Parameters<typeof authorizeAgent>[0], workspaceId: AuthorizedAgent["workspaceId"], key: string) {
  return await ctx.db
    .query("tasks")
    .withIndex("by_workspace_and_key", (query) =>
      query.eq("workspaceId", workspaceId).eq("key", key),
    )
    .unique();
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > READY_CURSOR_MAX_LENGTH) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeReadyCursor(state: ReadyCursorState): string {
  return encodeBase64Url(JSON.stringify(state));
}

function initialReadyCursor(authorization: AuthorizedAgent, now: number): ReadyCursorState {
  return {
    version: READY_CURSOR_VERSION,
    organizationId: authorization.organizationPublicId,
    workspaceId: authorization.workspacePublicId,
    snapshotAt: now,
    phase: "open",
    continuation: null,
  };
}

function decodeReadyCursor(
  value: string,
  authorization: AuthorizedAgent,
  now: number,
): ReadyCursorState | null {
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
    Object.keys(parsed).length !== 6 ||
    parsed.version !== READY_CURSOR_VERSION ||
    parsed.organizationId !== authorization.organizationPublicId ||
    parsed.workspaceId !== authorization.workspacePublicId ||
    !Number.isSafeInteger(parsed.snapshotAt) ||
    typeof parsed.snapshotAt !== "number" ||
    parsed.snapshotAt < now - READY_CURSOR_MAX_AGE_MS ||
    parsed.snapshotAt > now + READY_CURSOR_FUTURE_SKEW_MS ||
    (parsed.phase !== "open" && parsed.phase !== "overdue") ||
    (parsed.continuation !== null &&
      (typeof parsed.continuation !== "string" || parsed.continuation.length === 0))
  ) {
    return null;
  }
  return {
    version: READY_CURSOR_VERSION,
    organizationId: parsed.organizationId,
    workspaceId: parsed.workspaceId,
    snapshotAt: parsed.snapshotAt,
    phase: parsed.phase,
    continuation: parsed.continuation,
  };
}

function isVisibleOverdueTask(
  task: Doc<"tasks">,
  claim: Doc<"taskClaims">,
  snapshotAt: number,
): boolean {
  return (
    claim.leaseUntil <= snapshotAt &&
    task.availableAt <= snapshotAt &&
    task.unresolvedBlockerCount === 0 &&
    task.cancelledBlockerCount === 0
  );
}

async function loadReadyPage(
  ctx: Parameters<typeof authorizeAgent>[0],
  authorization: AuthorizedAgent,
  state: ReadyCursorState,
  limit: number,
): Promise<ReadRelationResult<{ readonly tasks: Doc<"tasks">[]; readonly cursor: string | null }>> {
  if (state.phase === "open") {
    const openPage = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_ready_priority_since", (query) =>
        query
          .eq("workspaceId", authorization.workspaceId)
          .eq("isReady", true),
      )
      .order("asc")
      .filter((query) => query.lte(query.field("createdAt"), state.snapshotAt))
      .paginate({ cursor: state.continuation, numItems: limit });
    if (openPage.page.some((task) => !taskMatchesAuthorization(task, authorization))) {
      return { ok: false };
    }
    return {
      ok: true,
      data: {
        tasks: openPage.page.filter((task) => isTaskReady(task, state.snapshotAt)),
        cursor: encodeReadyCursor(
          openPage.isDone
            ? { ...state, phase: "overdue", continuation: null }
            : { ...state, continuation: openPage.continueCursor },
        ),
      },
    };
  }

  const overduePage = await ctx.db
    .query("taskClaims")
    .withIndex("by_workspace_state_deadline", (query) =>
      query
        .eq("workspaceId", authorization.workspaceId)
        .eq("state", "active")
        .lte("leaseUntil", state.snapshotAt),
    )
    .filter((query) => query.lte(query.field("createdAt"), state.snapshotAt))
    .paginate({ cursor: state.continuation, numItems: limit });
  const overdueTasks = await Promise.all(
    overduePage.page.map(async (claim) => ({ claim, task: await ctx.db.get(claim.taskId) })),
  );
  const tasks: Doc<"tasks">[] = [];
  for (const { claim, task } of overdueTasks) {
    if (
      task === null ||
      !relationMatchesAuthorization(task, claim, authorization) ||
      !activeClaimMatchesTask(task, claim)
    ) {
      return { ok: false };
    }
    if (isVisibleOverdueTask(task, claim, state.snapshotAt)) tasks.push(task);
  }
  return {
    ok: true,
    data: {
      tasks,
      cursor: overduePage.isDone
        ? null
        : encodeReadyCursor({ ...state, phase: "overdue", continuation: overduePage.continueCursor }),
    },
  };
}

async function loadReadyContext(
  ctx: Parameters<typeof authorizeAgent>[0],
  authorization: AuthorizedAgent,
  now: number,
  limit: number,
): Promise<ReadRelationResult<Doc<"tasks">[]>> {
  const openRows = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_ready_priority_since", (query) =>
      query
        .eq("workspaceId", authorization.workspaceId)
        .eq("isReady", true),
    )
    .order("asc")
    .take(limit);
  if (openRows.some((task) => !taskMatchesAuthorization(task, authorization))) {
    return { ok: false };
  }
  const openTasks = openRows.filter((task) => isTaskReady(task, now));
  const overdueClaims = await ctx.db
    .query("taskClaims")
    .withIndex("by_workspace_state_deadline", (query) =>
      query.eq("workspaceId", authorization.workspaceId).eq("state", "active").lte("leaseUntil", now),
    )
    .take(limit);
  const overdueRows = await Promise.all(
    overdueClaims.map(async (claim) => ({ claim, task: await ctx.db.get(claim.taskId) })),
  );
  const overdueTasks: Doc<"tasks">[] = [];
  for (const { claim, task } of overdueRows) {
    if (
      task === null ||
      !relationMatchesAuthorization(task, claim, authorization) ||
      !activeClaimMatchesTask(task, claim)
    ) {
      return { ok: false };
    }
    if (isVisibleOverdueTask(task, claim, now)) overdueTasks.push(task);
  }
  return {
    ok: true,
    data: [...openTasks, ...overdueTasks]
      .sort((left, right) => left.priority - right.priority || left.createdAt - right.createdAt)
      .slice(0, limit),
  };
}

export const createTask = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    title: v.string(),
    type: taskTypeValidator,
    priority: v.number(),
    availableAt: v.optional(v.number()),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const title = args.title.trim();
    if (
      title.length === 0 ||
      new TextEncoder().encode(title).length > 512 ||
      !Number.isInteger(args.priority) ||
      args.priority < 0 ||
      args.priority > 4
    ) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const availableAt = args.availableAt ?? now;
    if (!Number.isSafeInteger(availableAt) || availableAt < 0) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    if (availableAt > now + MAX_DEFER_MS) {
      return domainFailure("DEFER_HORIZON", args.requestId);
    }
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:create",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = agentRateLimitFailure(
      await consumeAuthorizedAgentRateLimit(ctx, {
        authorization: authorization.authorization,
        routeClass: "agent_write",
        requestId: args.requestId,
        now,
      }),
      args.requestId,
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

    const workspace = await ctx.db.get(authorization.authorization.workspaceId);
    if (workspace === null) return domainFailure("AUTHORIZATION_DENIED", args.requestId);
    let key = `${workspace.taskKeyPrefix}-${randomCrockford(TASK_KEY_SUFFIX_LENGTH)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((await taskByKey(ctx, workspace._id, key)) === null) break;
      key = `${workspace.taskKeyPrefix}-${randomCrockford(TASK_KEY_SUFFIX_LENGTH)}`;
    }
    if ((await taskByKey(ctx, workspace._id, key)) !== null) {
      return domainFailure("SERVICE_UNAVAILABLE", args.requestId);
    }
    const taskPublicId = randomPublicId("tsk");
    const taskId = await ctx.db.insert("tasks", {
      organizationId: authorization.authorization.organizationId,
      workspaceId: workspace._id,
      publicId: taskPublicId,
      key,
      title,
      type: args.type,
      priority: args.priority,
      status: "open",
      availableAt,
      isReady: availableAt <= now,
      isBlocked: false,
      ...(availableAt <= now ? { readySince: now } : {}),
      needsAttention: false,
      wakeGeneration: availableAt > now ? 1 : 0,
      unresolvedBlockerCount: 0,
      cancelledBlockerCount: 0,
      revision: 1,
      reviewRevision: 1,
      claimFence: 0,
      createdAt: now,
      updatedAt: now,
    });
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
    await appendTaskEvent(ctx, {
      organizationId: authorization.authorization.organizationId,
      workspaceId: workspace._id,
      taskId,
      taskPublicId,
      taskRevision: 1,
      type: "task.created",
      actor: agentActor(authorization.authorization),
      command: {
        kind: "client",
        idempotencyKey: args.idempotencyKey,
        requestId: args.requestId,
      },
      payload: { availableAt },
      now,
    });
    const task = await ctx.db.get(taskId);
    if (task === null) throw new Error("Created task disappeared in its transaction.");
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

export const readyTasks = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.number(),
    requestId: v.string(),
  },
  returns: readyResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const cursorState =
      args.cursor === undefined
        ? initialReadyCursor(authorization.authorization, now)
        : decodeReadyCursor(args.cursor, authorization.authorization, now);
    if (cursorState === null) return domainFailure("VALIDATION_ERROR", args.requestId);
    const page = await loadReadyPage(ctx, authorization.authorization, cursorState, args.limit);
    if (!page.ok) return domainFailure("PROJECTION_MISMATCH", args.requestId);
    return {
      ok: true as const,
      data: { tasks: page.data.tasks.map(taskView), cursor: page.data.cursor },
      requestId: args.requestId,
    };
  },
});

export const context = internalQuery({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    requestId: v.string(),
  },
  returns: contextResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:read",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const readyResult = await loadReadyContext(ctx, authorization.authorization, now, 20);
    if (!readyResult.ok) return domainFailure("PROJECTION_MISMATCH", args.requestId);
    const ready = readyResult.data;
    const ownedClaimRows = await ctx.db
      .query("taskClaims")
      .withIndex("by_workspace_agent_state", (query) =>
        query
          .eq("workspaceId", authorization.authorization.workspaceId)
          .eq("agentId", authorization.authorization.agentId)
          .eq("state", "active"),
      )
      .order("desc")
      .take(100);
    const durableClaims = await Promise.all(
      ownedClaimRows.map(async (claim) => ({ claim, task: await ctx.db.get(claim.taskId) })),
    );
    const activeClaims: ReturnType<typeof taskView>[] = [];
    for (const { task, claim } of durableClaims) {
      if (
        task === null ||
        claim.agentId !== authorization.authorization.agentId ||
        claim.agentPublicId !== authorization.authorization.agentPublicId ||
        !taskMatchesAuthorization(task, authorization.authorization) ||
        !relationMatchesAuthorization(task, claim, authorization.authorization) ||
        !activeClaimMatchesTask(task, claim)
      ) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      if (
        claim.leaseUntil > now &&
        activeClaims.length < 20
      ) {
        activeClaims.push(taskView(task));
      }
    }
    const reviewPage = authorization.authorization.scopes.includes("tasks:review")
      ? await ctx.db
          .query("taskSubmissions")
          .withIndex("by_workspace_status_submitted", (query) =>
            query
              .eq("workspaceId", authorization.authorization.workspaceId)
              .eq("status", "pending"),
          )
          .order("asc")
          .paginate({ cursor: null, numItems: 20 })
      : null;
    const reviewRequests = [];
    for (const submission of reviewPage?.page ?? []) {
      const task = await ctx.db.get(submission.taskId);
      if (
        task === null ||
        !relationMatchesAuthorization(task, submission, authorization.authorization) ||
        task.status !== "in_review" ||
        task.currentClaim !== undefined ||
        task.reviewRevision !== submission.reviewRevision
      ) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      const pendingForTask = await ctx.db
        .query("taskSubmissions")
        .withIndex("by_workspace_task_status_submitted", (query) =>
          query
            .eq("workspaceId", task.workspaceId)
            .eq("taskId", task._id)
            .eq("status", "pending"),
        )
        .take(2);
      if (pendingForTask.length !== 1 || pendingForTask[0]?._id !== submission._id) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      reviewRequests.push({
        task: taskView(task),
        submissionId: submission.publicId,
        submittedByAgentId: submission.submittedBy.agentId,
        submittedAt: submission.submittedAt,
      });
    }
    const data = {
      principal: {
        kind: "agent" as const,
        agentId: authorization.authorization.agentPublicId,
        name: authorization.authorization.agentName,
        scopes: authorization.authorization.scopes,
        sessionId: authorization.authorization.sessionPublicId,
      },
      organization: {
        id: authorization.authorization.organizationPublicId,
        name: authorization.authorization.organizationName,
      },
      workspace: {
        id: authorization.authorization.workspacePublicId,
        slug: authorization.authorization.workspaceSlug,
        name: authorization.authorization.workspaceName,
      },
      serverTime: now,
      defaults: {
        claimLeaseMs: DEFAULT_CLAIM_LEASE_MS,
        claimRenewalThresholdMs: CLAIM_RENEWAL_THRESHOLD_MS,
        sessionIdleMs: 20 * 60 * 1_000,
        sessionHeartbeatMs: 5 * 60 * 1_000,
      },
      counts: {
        readyTasks: ready.length,
        activeClaims: activeClaims.length,
        reviewRequests: reviewRequests.length,
      },
      readyTasks: ready.map(taskView),
      activeClaims,
      reviewRequests,
      cursors: {
        readyTasks: null,
        activeClaims: null,
        reviewRequests:
          reviewPage === null || reviewPage.isDone ? null : reviewPage.continueCursor,
      },
      workflowRules: [
        "Claim only ready work and retain the returned fence for claim-bound writes.",
        "Renew a lease only during its final five minutes; stale generations are rejected.",
        "A released or expired task returns to ready only when every blocker is satisfied.",
        "Submission closes the execution claim; use a distinct reviewer identity to accept or reject it.",
      ],
    };
    return { ok: true as const, data, requestId: args.requestId };
  },
});

export const claimTask = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:claim",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = agentRateLimitFailure(
      await consumeAuthorizedAgentRateLimit(ctx, {
        authorization: authorization.authorization,
        routeClass: "agent_claim",
        requestId: args.requestId,
        now,
      }),
      args.requestId,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.claim",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseTaskData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") {
      return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    }
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);

    let previousAgentId: string | undefined;
    let previousClaimToReplace: Doc<"taskClaims"> | null = null;
    let eventType: "task.claimed" | "task.reclaimed" = "task.claimed";
    if (task.status === "open") {
      const projection = await ensureCounterProjection(ctx, task, now, args.requestId);
      if (!projection.ok) return projection;
      const derivedReady = isTaskReady(task, now);
      if (projection.actual.unresolved > 0 || projection.actual.cancelled > 0) {
        return domainFailure("TASK_BLOCKED", args.requestId, {
          taskKey: task.key,
          blockingCount: projection.actual.unresolved + projection.actual.cancelled,
          currentRevision: task.revision,
        });
      }
      if (derivedReady !== task.isReady) {
        await queueTaskProjectionRepair(ctx, task, now);
        return domainFailure("PROJECTION_MISMATCH", args.requestId, {
          taskKey: task.key,
          blockingCount: 0,
          currentRevision: task.revision,
        });
      }
      if (!derivedReady) {
        return domainFailure("TASK_NOT_READY", args.requestId, {
          taskKey: task.key,
          blockingCount: 0,
          currentRevision: task.revision,
        });
      }
    } else if (task.status === "in_progress" && task.currentClaim !== undefined) {
      const previousClaim = await ctx.db.get(task.currentClaim.claimId);
      if (!activeClaimMatchesTask(task, previousClaim)) {
        await queueTaskClaimRepair(ctx, task, now);
        return domainFailure("PROJECTION_MISMATCH", args.requestId, {
          taskKey: task.key,
          blockingCount: task.unresolvedBlockerCount + task.cancelledBlockerCount,
          currentRevision: task.revision,
        });
      }
      if (previousClaim.leaseUntil > now) {
        return domainFailure("TASK_ALREADY_CLAIMED", args.requestId, {
          taskKey: task.key,
          ownerAgentId: previousClaim.agentPublicId,
          leaseUntil: previousClaim.leaseUntil,
          currentRevision: task.revision,
        });
      }
      const projection = await ensureCounterProjection(ctx, task, now, args.requestId);
      if (!projection.ok) return projection;
      if (projection.actual.unresolved > 0 || projection.actual.cancelled > 0) {
        return domainFailure("TASK_BLOCKED", args.requestId, {
          taskKey: task.key,
          blockingCount: projection.actual.unresolved + projection.actual.cancelled,
          currentRevision: task.revision,
        });
      }
      if (task.availableAt > now) {
        return domainFailure("TASK_NOT_READY", args.requestId, {
          taskKey: task.key,
          blockingCount: 0,
          currentRevision: task.revision,
        });
      }
      previousAgentId = previousClaim.agentPublicId;
      previousClaimToReplace = previousClaim;
      eventType = "task.reclaimed";
    } else if (task.status === "in_progress") {
      await queueTaskClaimRepair(ctx, task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        blockingCount: task.unresolvedBlockerCount + task.cancelledBlockerCount,
        currentRevision: task.revision,
      });
    } else {
      return domainFailure("TASK_NOT_READY", args.requestId, {
        taskKey: task.key,
        blockingCount: task.unresolvedBlockerCount + task.cancelledBlockerCount,
        currentRevision: task.revision,
      });
    }

    const fence = nextClaimFence(task.claimFence);
    if (fence === null) {
      await queueTaskClaimRepair(ctx, task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        blockingCount: task.unresolvedBlockerCount + task.cancelledBlockerCount,
        currentRevision: task.revision,
      });
    }
    if (previousClaimToReplace !== null) {
      await ctx.db.patch(previousClaimToReplace._id, {
        state: "replaced",
        endedAt: now,
        updatedAt: now,
      });
    }
    const leaseGeneration = 1;
    const leaseUntil = now + DEFAULT_CLAIM_LEASE_MS;
    const claimPublicId = randomPublicId("clm");
    const claimId = await ctx.db.insert("taskClaims", {
      organizationId: authorization.authorization.organizationId,
      workspaceId: authorization.authorization.workspaceId,
      taskId: task._id,
      publicId: claimPublicId,
      agentId: authorization.authorization.agentId,
      agentPublicId: authorization.authorization.agentPublicId,
      state: "active",
      fence,
      leaseGeneration,
      leaseUntil,
      createdAt: now,
      updatedAt: now,
    });
    const nextRevision = task.revision + 1;
    await ctx.db.patch(task._id, {
      status: "in_progress",
      isReady: false,
      readySince: undefined,
      claimFence: fence,
      currentClaim: {
        claimId,
        publicId: claimPublicId,
        agentId: authorization.authorization.agentId,
        agentPublicId: authorization.authorization.agentPublicId,
        fence,
        leaseGeneration,
        leaseUntil,
      },
      revision: nextRevision,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(leaseUntil, internal.schedules.expireClaim, {
      taskId: task._id,
      claimId,
      fence,
      leaseGeneration,
      expectedDeadline: leaseUntil,
    });
    await appendTaskEvent(ctx, {
      organizationId: authorization.authorization.organizationId,
      workspaceId: authorization.authorization.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: nextRevision,
      type: eventType,
      actor: agentActor(authorization.authorization),
      command: {
        kind: "client",
        idempotencyKey: args.idempotencyKey,
        requestId: args.requestId,
      },
      payload:
        previousAgentId === undefined
          ? { agentId: authorization.authorization.agentPublicId, fence, leaseUntil }
          : {
              agentId: authorization.authorization.agentPublicId,
              fence,
              leaseUntil,
              previousAgentId,
            },
      now,
    });
    const updated = await ctx.db.get(task._id);
    if (updated === null) throw new Error("Claimed task disappeared in its transaction.");
    const data = { task: taskView(updated) };
    await storeReceipt(ctx, {
      identity,
      operation: "tasks.claim",
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

export const renewClaim = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    fence: v.number(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:claim",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = agentRateLimitFailure(
      await consumeAuthorizedAgentRateLimit(ctx, {
        authorization: authorization.authorization,
        routeClass: "agent_claim",
        requestId: args.requestId,
        now,
      }),
      args.requestId,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.claim.renew",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseTaskData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (task.status !== "in_progress" || task.currentClaim === undefined) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    const claim = await ctx.db.get(task.currentClaim.claimId);
    if (!activeClaimMatchesTask(task, claim)) {
      await queueTaskClaimRepair(ctx, task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        blockingCount: task.unresolvedBlockerCount + task.cancelledBlockerCount,
        currentRevision: task.revision,
      });
    }
    const disposition = claimCommandDisposition({
      command: "renew",
      taskStatus: task.status,
      hasCurrentClaim: true,
      currentAgentId: task.currentClaim.agentId,
      authorizedAgentId: authorization.authorization.agentId,
      currentFence: task.currentClaim.fence,
      requestedFence: args.fence,
      currentLeaseUntil: task.currentClaim.leaseUntil,
      now,
      renewalThresholdMs: CLAIM_RENEWAL_THRESHOLD_MS,
    });
    if (disposition.kind === "task_state_conflict") {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    if (disposition.kind === "claim_not_owned") {
      return domainFailure("CLAIM_NOT_OWNED", args.requestId, {
        taskKey: task.key,
        fence: args.fence,
      });
    }
    if (disposition.kind === "claim_stale") {
      return domainFailure("CLAIM_STALE", args.requestId, {
        taskKey: task.key,
        fence: task.currentClaim.fence,
        currentRevision: task.revision,
      });
    }
    if (disposition.kind === "lease_not_renewable") {
      return domainFailure("LEASE_NOT_RENEWABLE", args.requestId, {
        taskKey: task.key,
        fence: args.fence,
        leaseUntil: task.currentClaim.leaseUntil,
      });
    }
    const leaseGeneration = claim.leaseGeneration + 1;
    const leaseUntil = now + DEFAULT_CLAIM_LEASE_MS;
    const nextRevision = task.revision + 1;
    await ctx.db.patch(claim._id, { leaseGeneration, leaseUntil, updatedAt: now });
    await ctx.db.patch(task._id, {
      currentClaim: { ...task.currentClaim, leaseGeneration, leaseUntil },
      revision: nextRevision,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(leaseUntil, internal.schedules.expireClaim, {
      taskId: task._id,
      claimId: claim._id,
      fence: args.fence,
      leaseGeneration,
      expectedDeadline: leaseUntil,
    });
    await appendTaskEvent(ctx, {
      organizationId: authorization.authorization.organizationId,
      workspaceId: authorization.authorization.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: nextRevision,
      type: "task.claim_renewed",
      actor: agentActor(authorization.authorization),
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { fence: args.fence, leaseGeneration, leaseUntil },
      now,
    });
    const updated = await ctx.db.get(task._id);
    if (updated === null) throw new Error("Renewed task disappeared in its transaction.");
    const data = { task: taskView(updated) };
    await storeReceipt(ctx, {
      identity,
      operation: "tasks.claim.renew",
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

export const releaseClaim = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    key: v.string(),
    fence: v.number(),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
  },
  returns: taskResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const metadata = assertRequestMetadata({ ...args, now });
    if (!metadata.ok) return { ok: false as const, error: metadata.error };
    const authorization = await authorizeAgent(ctx, {
      ...args,
      requiredScope: "tasks:claim",
      now,
    });
    if (!authorization.ok) return { ok: false as const, error: authorization.error };
    const rateLimitFailure = agentRateLimitFailure(
      await consumeAuthorizedAgentRateLimit(ctx, {
        authorization: authorization.authorization,
        routeClass: "agent_claim",
        requestId: args.requestId,
        now,
      }),
      args.requestId,
    );
    if (rateLimitFailure !== null) return rateLimitFailure;
    const identity = receiptIdentity(authorization.authorization);
    const receipt = await lookupReceipt(ctx, {
      identity,
      operation: "tasks.claim.release",
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      requestId: args.requestId,
      parse: parseTaskData,
    });
    if (receipt.kind === "failure") return receipt.result;
    if (receipt.kind === "replay") return { ok: true as const, data: receipt.data, requestId: receipt.requestId };
    const task = await taskByKey(ctx, authorization.authorization.workspaceId, args.key);
    if (task === null) return domainFailure("NOT_FOUND", args.requestId);
    if (task.status !== "in_progress" || task.currentClaim === undefined) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    const claim = await ctx.db.get(task.currentClaim.claimId);
    if (!activeClaimMatchesTask(task, claim)) {
      await queueTaskClaimRepair(ctx, task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId, {
        taskKey: task.key,
        blockingCount: task.unresolvedBlockerCount + task.cancelledBlockerCount,
        currentRevision: task.revision,
      });
    }
    if (task.currentClaim.agentId !== authorization.authorization.agentId) {
      return domainFailure("CLAIM_NOT_OWNED", args.requestId, { taskKey: task.key, fence: args.fence });
    }
    if (task.currentClaim.fence !== args.fence) {
      return domainFailure("CLAIM_STALE", args.requestId, {
        taskKey: task.key,
        fence: task.currentClaim.fence,
        currentRevision: task.revision,
      });
    }
    if (task.currentClaim.leaseUntil <= now) {
      return domainFailure("CLAIM_STALE", args.requestId, {
        taskKey: task.key,
        fence: task.currentClaim.fence,
        currentRevision: task.revision,
      });
    }
    const projection = await ensureCounterProjection(ctx, task, now, args.requestId);
    if (!projection.ok) return projection;
    const nextRevision = task.revision + 1;
    const ready =
      task.availableAt <= now &&
      projection.actual.unresolved === 0 &&
      projection.actual.cancelled === 0;
    await ctx.db.patch(claim._id, { state: "released", endedAt: now, updatedAt: now });
    await ctx.db.patch(task._id, {
      status: "open",
      isReady: ready,
      ...(ready ? { readySince: now } : { readySince: undefined }),
      currentClaim: undefined,
      revision: nextRevision,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: authorization.authorization.organizationId,
      workspaceId: authorization.authorization.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: nextRevision,
      type: "task.claim_released",
      actor: agentActor(authorization.authorization),
      command: { kind: "client", idempotencyKey: args.idempotencyKey, requestId: args.requestId },
      payload: { fence: args.fence },
      now,
    });
    const updated = await ctx.db.get(task._id);
    if (updated === null) throw new Error("Released task disappeared in its transaction.");
    const data = { task: taskView(updated) };
    await storeReceipt(ctx, {
      identity,
      operation: "tasks.claim.release",
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
