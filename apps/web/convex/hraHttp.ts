import {
  HRA_PROMOTION_MAX_REQUEST_BYTES,
  hraHumanApiOperations,
  hraHumanHeaders,
  hraPromotionApiOperations,
  makeErrorEnvelope,
  errorHttpStatus,
  parseHRAHumanRoute,
  parseHRAPromotionRoute,
  uuidV7Schema,
  type ErrorCode,
  type ErrorDetails,
  type HRAHumanMutationIntent,
  type HRAHumanRouteMatch,
  type HRAPromotionRouteMatch,
  type TaskWorkspaceMutationResult,
} from "@hraness/agent-tasks-protocol";

import { api, internal } from "./_generated/api";
import {
  httpAction,
  type ActionCtx,
} from "./_generated/server";
import { randomRequestId } from "./domain";
import {
  decodeHRACursor,
  encodeHRACursor,
  hraMutationResult,
} from "./hraHuman";
import { parseBoundedJsonBody } from "./boundedJsonBody";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;
const MAX_JSON_BODY_BYTES = 512 * 1_024;
const IDEMPOTENT_MUTATION_ATTEMPTS = 5;
const INITIAL_INVALIDATION_POLL_DELAY_MS = 250;
const MAXIMUM_INVALIDATION_POLL_DELAY_MS = 1_000;

type DomainFailure = Readonly<{
  ok: false;
  error: Readonly<{
    code: ErrorCode;
    requestId: string;
    details: ErrorDetails;
  }>;
}>;

type DomainResult<Data> =
  | Readonly<{ ok: true; data: Data; requestId: string }>
  | DomainFailure;

type WorkspaceInfo = Readonly<{
  workspace: {
    id: string;
    revision: number;
  };
  projectionHead: number;
  identity: {
    organizationId: string;
    userId: string;
  };
  viewer: {
    id: string;
    kind: "human";
    name: string;
  };
}>;

export function nextHRAInvalidationPollDelay(
  currentDelayMs: number,
): number {
  if (
    !Number.isSafeInteger(currentDelayMs) ||
    currentDelayMs < INITIAL_INVALIDATION_POLL_DELAY_MS
  ) {
    throw new RangeError("Invalid HRA invalidation poll delay.");
  }
  return Math.min(MAXIMUM_INVALIDATION_POLL_DELAY_MS, currentDelayMs * 2);
}

async function waitForHRAInvalidationPollDelay(
  signal: AbortSignal,
  delayMs: number,
): Promise<boolean> {
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (elapsed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(elapsed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function runHRAInvalidationPoll<Result>(
  options: Readonly<{
    deadline: number;
    now?: () => number;
    query: () => Promise<Result>;
    shouldStop: (result: Result) => boolean;
    signal: AbortSignal;
  }>,
): Promise<Result | null> {
  const now = options.now ?? (() => performance.now());
  if (!Number.isFinite(options.deadline) || options.deadline < 0) {
    throw new RangeError("Invalid HRA invalidation poll deadline.");
  }
  let pollDelayMs = INITIAL_INVALIDATION_POLL_DELAY_MS;
  let result: Result | null = null;
  let hasQueried = false;
  while (!options.signal.aborted) {
    if (hasQueried) {
      const beforeQuery = now();
      if (!Number.isFinite(beforeQuery) || beforeQuery < 0) {
        throw new RangeError("Invalid HRA invalidation poll clock.");
      }
      if (beforeQuery >= options.deadline) break;
    }
    result = await options.query();
    hasQueried = true;
    const observedAt = now();
    if (!Number.isFinite(observedAt) || observedAt < 0) {
      throw new RangeError("Invalid HRA invalidation poll clock.");
    }
    if (
      options.signal.aborted ||
      options.shouldStop(result) ||
      observedAt >= options.deadline
    ) {
      break;
    }
    const elapsed = await waitForHRAInvalidationPollDelay(
      options.signal,
      Math.min(pollDelayMs, options.deadline - observedAt),
    );
    if (!elapsed) break;
    pollDelayMs = nextHRAInvalidationPollDelay(pollDelayMs);
  }
  return result;
}

function failure(
  code: ErrorCode,
  requestId: string,
  details: ErrorDetails = {},
): DomainFailure {
  return { ok: false, error: { code, requestId, details } };
}

function errorResponse(
  code: ErrorCode,
  requestId: string,
  details: ErrorDetails = {},
): Response {
  return new Response(
    JSON.stringify(makeErrorEnvelope(code, requestId, details)),
    {
      status: errorHttpStatus[code],
      headers: JSON_HEADERS,
    },
  );
}

function resultResponse<Schema extends {
  parse: (value: unknown) => unknown;
}>(
  result: DomainResult<unknown>,
  responseSchema: Schema,
): Response {
  if (!result.ok) {
    return errorResponse(
      result.error.code,
      result.error.requestId,
      result.error.details,
    );
  }
  const envelope = {
    ok: true as const,
    data: result.data,
    requestId: result.requestId,
  };
  return new Response(JSON.stringify(responseSchema.parse(envelope)), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

async function hraPollRateLimitResponse(
  ctx: ActionCtx,
  workspacePublicId: string,
  requestId: string,
): Promise<Response | null> {
  let result;
  try {
    result = await ctx.runMutation(internal.rateLimits.consumeHuman, {
      requestId,
      routeClass: "human_poll",
      workspacePublicId,
    });
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  if (result.kind === "allowed" || result.kind === "skipped") return null;
  if (result.kind === "limited") {
    return errorResponse("RATE_LIMITED", requestId, {
      retryAfterMs: result.retryAfterMs,
    });
  }
  return errorResponse("SERVICE_UNAVAILABLE", requestId);
}

export function hraHumanAdmissionRateClass(
  operation: HRAHumanRouteMatch["operation"],
): "human_poll" | null {
  return operation === "poll_invalidations" ? "human_poll" : null;
}

function hasJsonContentType(request: Request): boolean {
  const value = request.headers.get(hraHumanHeaders.contentType);
  if (value === null) return false;
  const [mediaType] = value.split(";", 1);
  return mediaType?.trim().toLowerCase() === "application/json";
}

function hasHRABearer(request: Request): boolean {
  const value = request.headers.get(hraHumanHeaders.authorization);
  return value !== null &&
    value.startsWith("Bearer ") &&
    value.length > "Bearer ".length &&
    !value.slice("Bearer ".length).includes(" ");
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get(hraHumanHeaders.idempotencyKey);
  return value !== null && uuidV7Schema.safeParse(value).success
    ? value
    : null;
}

function parseJsonBody(
  request: Request,
  maximumBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown | null> {
  return parseBoundedJsonBody(request, maximumBytes);
}

function strictQuery(url: URL): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key)) return null;
    result[key] = value;
  }
  return result;
}

async function runIdempotentMutationWithRetry<Value>(
  requestId: string,
  operation: () => Promise<Value>,
): Promise<
  | Readonly<{ kind: "success"; value: Value }>
  | Readonly<{ kind: "exhausted" }>
> {
  for (
    let attempt = 0;
    attempt < IDEMPOTENT_MUTATION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return { kind: "success", value: await operation() };
    } catch {
      if (attempt + 1 === IDEMPOTENT_MUTATION_ATTEMPTS) {
        return { kind: "exhausted" };
      }
      const baseDelayMs = 5 * 2 ** attempt;
      const seed = [...requestId].reduce(
        (value, character) =>
          (
            Math.imul(value, 33) +
            character.charCodeAt(0)
          ) >>> 0,
        attempt + 1,
      );
      await new Promise<void>((resolve) =>
        setTimeout(resolve, baseDelayMs + seed % (baseDelayMs + 1)));
    }
  }
  return { kind: "exhausted" };
}

async function workspaceInfo(
  ctx: ActionCtx,
  workspaceId: string,
  requestId: string,
) {
  return await ctx.runQuery(internal.hraHuman.workspace, {
    workspaceId,
    requestId,
  });
}

function requestedHeadResult(
  info: WorkspaceInfo,
  expected: number | undefined,
  requestId: string,
): DomainFailure | null {
  return expected !== undefined && expected !== info.projectionHead
    ? failure("TASK_STATE_CONFLICT", requestId, {
        currentRevision: info.projectionHead,
      })
    : null;
}

async function listAllContextRepositories(
  ctx: ActionCtx,
  workspaceId: string,
  requestId: string,
) {
  const repositories = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.runQuery(
      internal.workGraph.listWorkspaceRepositoriesForHuman,
      {
        workspacePublicId: workspaceId,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
        requestId,
      },
    );
    if (!page.ok) return page;
    repositories.push(...page.data.repositories);
    if (repositories.length > 128) {
      return failure("PROJECTION_MISMATCH", requestId);
    }
    cursor = page.data.cursor ?? undefined;
  } while (cursor !== undefined);
  return {
    ok: true as const,
    data: { repositories },
    requestId,
  };
}

async function listHRAWorkspaces(
  ctx: ActionCtx,
  request: Request,
  requestId: string,
): Promise<Response> {
  const query = strictQuery(new URL(request.url));
  const parsed = query === null
    ? null
    : hraHumanApiOperations.listWorkspaces.querySchema.safeParse(query);
  if (parsed === null || !parsed.success) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const result = await ctx.runQuery(internal.hraHuman.listWorkspaces, {
    ...(parsed.data.cursor === undefined
      ? {}
      : { cursor: parsed.data.cursor }),
    limit: parsed.data.limit,
    requestId,
  });
  return resultResponse(
    result,
    hraHumanApiOperations.listWorkspaces.responseSchema,
  );
}

async function getHRAWorkspace(
  ctx: ActionCtx,
  route: HRAHumanRouteMatch & { workspaceId: string },
  requestId: string,
): Promise<Response> {
  const result = await workspaceInfo(ctx, route.workspaceId, requestId);
  return resultResponse(
    result.ok
      ? {
          ok: true as const,
          data: { workspace: result.data.workspace },
          requestId,
        }
      : result,
    hraHumanApiOperations.getWorkspace.responseSchema,
  );
}

async function getHRAContext(
  ctx: ActionCtx,
  route: HRAHumanRouteMatch & { workspaceId: string },
  requestId: string,
): Promise<Response> {
  const [info, context, readiness, repositoryPage] = await Promise.all([
    workspaceInfo(ctx, route.workspaceId, requestId),
    ctx.runQuery(api.humanTaskQueries.workspaceContext, {
      workspaceId: route.workspaceId,
    }),
    ctx.runQuery(api.dispatch.humanReadiness, {
      workspaceId: route.workspaceId,
    }),
    listAllContextRepositories(ctx, route.workspaceId, requestId),
  ]);
  if (!info.ok) {
    return resultResponse(
      info,
      hraHumanApiOperations.context.responseSchema,
    );
  }
  if (!context.ok) {
    return resultResponse(
      context,
      hraHumanApiOperations.context.responseSchema,
    );
  }
  if (!readiness.ok) {
    return resultResponse(
      readiness,
      hraHumanApiOperations.context.responseSchema,
    );
  }
  if (!repositoryPage.ok) {
    return resultResponse(
      repositoryPage,
      hraHumanApiOperations.context.responseSchema,
    );
  }
  if (context.data.agents.capped) {
    return errorResponse("PROJECTION_MISMATCH", requestId);
  }
  const readyById = new Map(
    readiness.data.repositories.map((repository) => [
      repository.id,
      repository.ready,
    ]),
  );
  if (
    repositoryPage.data.repositories.some(
      (repository) => !readyById.has(repository.id),
    )
  ) {
    return errorResponse("PROJECTION_MISMATCH", requestId);
  }
  return resultResponse(
    {
      ok: true as const,
      data: {
        workspace: info.data.workspace,
        projectionHead: info.data.projectionHead,
        viewer: info.data.viewer,
        capabilities: context.data.capabilities,
        agents: context.data.agents.items,
        runner: readiness.data.presence,
        repositories: repositoryPage.data.repositories.map((repository) => ({
          repository,
          ready: readyById.get(repository.id) ?? false,
        })),
        serverTime: readiness.data.presence.serverTime,
      },
      requestId,
    },
    hraHumanApiOperations.context.responseSchema,
  );
}

async function listHRARepositories(
  ctx: ActionCtx,
  request: Request,
  route: HRAHumanRouteMatch & { workspaceId: string },
  requestId: string,
): Promise<Response> {
  const query = strictQuery(new URL(request.url));
  const parsed = query === null
    ? null
    : hraHumanApiOperations.repositories.querySchema.safeParse(query);
  if (parsed === null || !parsed.success) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const info = await workspaceInfo(ctx, route.workspaceId, requestId);
  if (!info.ok) {
    return resultResponse(
      info,
      hraHumanApiOperations.repositories.responseSchema,
    );
  }
  const headFailure = requestedHeadResult(
    info.data,
    parsed.data.projectionHead,
    requestId,
  );
  if (headFailure !== null) {
    return resultResponse(
      headFailure,
      hraHumanApiOperations.repositories.responseSchema,
    );
  }
  const cursor = parsed.data.cursor === undefined
    ? null
    : decodeHRACursor(parsed.data.cursor);
  if (
    parsed.data.cursor !== undefined &&
    (
      cursor?.kind !== "repositories" ||
      cursor.organizationId !== info.data.identity.organizationId ||
      cursor.userId !== info.data.identity.userId ||
      cursor.workspaceId !== route.workspaceId ||
      cursor.projectionHead !== info.data.projectionHead
    )
  ) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const [page, readiness] = await Promise.all([
    ctx.runQuery(internal.workGraph.listWorkspaceRepositoriesForHuman, {
      workspacePublicId: route.workspaceId,
      ...(cursor?.kind === "repositories"
        ? { cursor: cursor.continuation }
        : {}),
      limit: parsed.data.limit,
      requestId,
    }),
    ctx.runQuery(api.dispatch.humanReadiness, {
      workspaceId: route.workspaceId,
    }),
  ]);
  if (!page.ok) {
    return resultResponse(
      page,
      hraHumanApiOperations.repositories.responseSchema,
    );
  }
  if (!readiness.ok) {
    return resultResponse(
      readiness,
      hraHumanApiOperations.repositories.responseSchema,
    );
  }
  const readyById = new Map(
    readiness.data.repositories.map((repository) => [
      repository.id,
      repository.ready,
    ]),
  );
  if (page.data.repositories.some(({ id }) => !readyById.has(id))) {
    return errorResponse("PROJECTION_MISMATCH", requestId);
  }
  const next = page.data.cursor === null
    ? null
    : {
        version: 1 as const,
        token: encodeHRACursor({
          kind: "repositories",
          organizationId: info.data.identity.organizationId,
          userId: info.data.identity.userId,
          workspaceId: route.workspaceId,
          projectionHead: info.data.projectionHead,
          continuation: page.data.cursor,
        }),
        workspaceId: route.workspaceId,
        projectionHead: info.data.projectionHead,
        scope: { kind: "repositories" as const },
      };
  return resultResponse(
    {
      ok: true as const,
      data: {
        workspaceId: route.workspaceId,
        projectionHead: info.data.projectionHead,
        repositories: page.data.repositories.map((repository) => ({
          repository,
          ready: readyById.get(repository.id) ?? false,
        })),
        cursor: next,
      },
      requestId,
    },
    hraHumanApiOperations.repositories.responseSchema,
  );
}

async function listHRATasks(
  ctx: ActionCtx,
  request: Request,
  route: HRAHumanRouteMatch & { workspaceId: string },
  requestId: string,
): Promise<Response> {
  const query = strictQuery(new URL(request.url));
  const parsed = query === null
    ? null
    : hraHumanApiOperations.listTasks.querySchema.safeParse(query);
  if (parsed === null || !parsed.success) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const info = await workspaceInfo(ctx, route.workspaceId, requestId);
  if (!info.ok) {
    return resultResponse(
      info,
      hraHumanApiOperations.listTasks.responseSchema,
    );
  }
  const headFailure = requestedHeadResult(
    info.data,
    parsed.data.projectionHead,
    requestId,
  );
  if (headFailure !== null) {
    return resultResponse(
      headFailure,
      hraHumanApiOperations.listTasks.responseSchema,
    );
  }
  const cursor = parsed.data.cursor === undefined
    ? null
    : decodeHRACursor(parsed.data.cursor);
  if (
    parsed.data.cursor !== undefined &&
    (
      cursor?.kind !== "task_list" ||
      cursor.organizationId !== info.data.identity.organizationId ||
      cursor.userId !== info.data.identity.userId ||
      cursor.workspaceId !== route.workspaceId ||
      cursor.projectionHead !== info.data.projectionHead ||
      cursor.view !== parsed.data.view ||
      cursor.assignedAgentId !== parsed.data.assignedAgentId
    )
  ) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const page = await ctx.runQuery(api.humanTaskQueries.taskList, {
    workspaceId: route.workspaceId,
    view: parsed.data.view,
    ...(cursor?.kind === "task_list"
      ? { cursor: cursor.continuation }
      : {}),
    limit: parsed.data.limit,
  });
  if (!page.ok) {
    return resultResponse(
      page,
      hraHumanApiOperations.listTasks.responseSchema,
    );
  }
  const items = parsed.data.view === "assigned"
    ? page.data.tasks.filter(
        ({ task }) =>
          task.assigneeAgentId === parsed.data.assignedAgentId,
      )
    : page.data.tasks;
  const nextToken = page.data.cursor === null
    ? null
    : encodeHRACursor({
        kind: "task_list",
        organizationId: info.data.identity.organizationId,
        userId: info.data.identity.userId,
        workspaceId: route.workspaceId,
        projectionHead: info.data.projectionHead,
        view: parsed.data.view,
        ...(parsed.data.assignedAgentId === undefined
          ? {}
          : { assignedAgentId: parsed.data.assignedAgentId }),
        continuation: page.data.cursor,
      });
  const next = nextToken === null
    ? null
    : {
        version: 1 as const,
        token: nextToken,
        workspaceId: route.workspaceId,
        projectionHead: info.data.projectionHead,
        scope: {
          kind: "task_list" as const,
          view: parsed.data.view,
          ...(parsed.data.assignedAgentId === undefined
            ? {}
            : { assignedAgentId: parsed.data.assignedAgentId }),
        },
      };
  return resultResponse(
    {
      ok: true as const,
      data: {
        page: {
          workspaceId: route.workspaceId,
          view: parsed.data.view,
          ...(parsed.data.assignedAgentId === undefined
            ? {}
            : { assignedAgentId: parsed.data.assignedAgentId }),
          projectionRevision: info.data.projectionHead,
          items,
          cursor: nextToken,
          hasMore: nextToken !== null,
        },
        cursor: next,
      },
      requestId,
    },
    hraHumanApiOperations.listTasks.responseSchema,
  );
}

function taskLink(task: {
  id: string;
  key: string;
  priority: number;
  revision: number;
  status: "open" | "in_progress" | "in_review" | "done" | "cancelled";
  title: string;
}) {
  return {
    id: task.id,
    key: task.key,
    priority: task.priority,
    revision: task.revision,
    status: task.status,
    title: task.title,
  };
}

async function lookupHRATask(
  ctx: ActionCtx,
  request: Request,
  route: HRAHumanRouteMatch & { workspaceId: string },
  requestId: string,
): Promise<Response> {
  const query = strictQuery(new URL(request.url));
  const parsed = query === null
    ? null
    : hraHumanApiOperations.lookupTask.querySchema.safeParse(query);
  if (parsed === null || !parsed.success) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const info = await workspaceInfo(ctx, route.workspaceId, requestId);
  if (!info.ok) {
    return resultResponse(
      info,
      hraHumanApiOperations.lookupTask.responseSchema,
    );
  }
  const headFailure = requestedHeadResult(
    info.data,
    parsed.data.projectionHead,
    requestId,
  );
  if (headFailure !== null) {
    return resultResponse(
      headFailure,
      hraHumanApiOperations.lookupTask.responseSchema,
    );
  }
  const identity = await ctx.runQuery(internal.hraHuman.taskIdentity, {
    workspaceId: route.workspaceId,
    key: parsed.data.key,
    requestId,
  });
  if (!identity.ok && identity.error.code !== "NOT_FOUND") {
    return resultResponse(
      identity,
      hraHumanApiOperations.lookupTask.responseSchema,
    );
  }
  return resultResponse(
    {
      ok: true as const,
      data: {
        workspaceId: route.workspaceId,
        projectionHead: info.data.projectionHead,
        key: parsed.data.key,
        task: identity.ok ? taskLink(identity.data.task) : null,
      },
      requestId,
    },
    hraHumanApiOperations.lookupTask.responseSchema,
  );
}

async function getHRATask(
  ctx: ActionCtx,
  request: Request,
  route: HRAHumanRouteMatch & {
    workspaceId: string;
    taskId: string;
  },
  requestId: string,
): Promise<Response> {
  const query = strictQuery(new URL(request.url));
  const parsed = query === null
    ? null
    : hraHumanApiOperations.getTask.querySchema.safeParse(query);
  if (parsed === null || !parsed.success) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const info = await workspaceInfo(ctx, route.workspaceId, requestId);
  if (!info.ok) {
    return resultResponse(
      info,
      hraHumanApiOperations.getTask.responseSchema,
    );
  }
  const headFailure = requestedHeadResult(
    info.data,
    parsed.data.projectionHead,
    requestId,
  );
  if (headFailure !== null) {
    return resultResponse(
      headFailure,
      hraHumanApiOperations.getTask.responseSchema,
    );
  }
  const identity = await ctx.runQuery(internal.hraHuman.taskIdentity, {
    workspaceId: route.workspaceId,
    taskId: route.taskId,
    requestId,
  });
  if (!identity.ok) {
    return resultResponse(
      identity,
      hraHumanApiOperations.getTask.responseSchema,
    );
  }
  const [detail, runs] = await Promise.all([
    ctx.runQuery(api.humanTaskDetail.detail, {
      workspaceId: route.workspaceId,
      key: identity.data.task.key,
    }),
    ctx.runQuery(api.dispatch.humanTaskRuns, {
      workspaceId: route.workspaceId,
      taskKey: identity.data.task.key,
      limit: 50,
    }),
  ]);
  if (!detail.ok) {
    return resultResponse(
      detail,
      hraHumanApiOperations.getTask.responseSchema,
    );
  }
  if (!runs.ok) {
    return resultResponse(
      runs,
      hraHumanApiOperations.getTask.responseSchema,
    );
  }
  const truncatedCollections = [
    ...detail.data.truncatedCollections,
    ...(runs.data.hasMore &&
    !detail.data.truncatedCollections.includes("runs" as never)
      ? ["runs" as const]
      : []),
  ];
  return resultResponse(
    {
      ok: true as const,
      data: {
        workspaceId: route.workspaceId,
        taskId: route.taskId,
        projectionHead: info.data.projectionHead,
        detail: {
          workspaceId: route.workspaceId,
          projectionRevision: info.data.projectionHead,
          ...detail.data,
          runs: runs.data.runs,
          truncatedCollections,
        },
      },
      requestId,
    },
    hraHumanApiOperations.getTask.responseSchema,
  );
}

async function pollHRAInvalidations(
  ctx: ActionCtx,
  request: Request,
  route: HRAHumanRouteMatch & { workspaceId: string },
  requestId: string,
): Promise<Response> {
  const query = strictQuery(new URL(request.url));
  const parsed = query === null
    ? null
    : hraHumanApiOperations.pollInvalidations.querySchema.safeParse(query);
  if (parsed === null || !parsed.success) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const deadline = performance.now() + parsed.data.waitMs;
  const result = await runHRAInvalidationPoll({
    deadline,
    query: async () =>
      await ctx.runQuery(internal.hraHuman.invalidations, {
        workspaceId: route.workspaceId,
        afterProjectionHead: parsed.data.afterProjectionHead,
        ...(parsed.data.cursor === undefined
          ? {}
          : { cursor: parsed.data.cursor }),
        ...(parsed.data.cursorProjectionHead === undefined
          ? {}
          : { cursorProjectionHead: parsed.data.cursorProjectionHead }),
        limit: parsed.data.limit,
        requestId,
      }),
    shouldStop: (current) =>
      !current.ok ||
      current.data.invalidations.length > 0 ||
      current.data.projectionHead > parsed.data.afterProjectionHead ||
      parsed.data.cursor !== undefined,
    signal: request.signal,
  });
  if (result === null) {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  return resultResponse(
    result,
    hraHumanApiOperations.pollInvalidations.responseSchema,
  );
}

async function resolveExpectedTask(
  ctx: ActionCtx,
  input: {
    workspaceId: string;
    taskId: string;
    expectedTaskRevision: number;
    expectedProjectionHead: number;
    requestId: string;
  },
) {
  const identity = await ctx.runQuery(internal.hraHuman.taskIdentity, {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    requestId: input.requestId,
  });
  if (!identity.ok) return identity;
  if (
    identity.data.projectionHead === input.expectedProjectionHead &&
    identity.data.task.revision !== input.expectedTaskRevision
  ) {
    return failure("TASK_STATE_CONFLICT", input.requestId, {
      currentRevision: identity.data.task.revision,
      taskKey: identity.data.task.key,
    });
  }
  return identity;
}

async function finishMutation<Data>(
  ctx: ActionCtx,
  input: {
    raw: DomainResult<Data>;
    intent: HRAHumanMutationIntent;
    workspaceId: string;
    requestId: string;
    result: (
      data: Data,
      projectionHead: number,
    ) => TaskWorkspaceMutationResult["result"];
  },
): Promise<DomainResult<{ mutation: TaskWorkspaceMutationResult }>> {
  if (!input.raw.ok) return input.raw;
  const info = await workspaceInfo(ctx, input.workspaceId, input.requestId);
  if (!info.ok) return info;
  return {
    ok: true,
    data: {
      mutation: hraMutationResult({
        operationId: input.intent.operationId,
        workspaceId: input.workspaceId,
        commandKind: input.intent.kind,
        workspaceRevision: info.data.projectionHead,
        projectionRevision: info.data.projectionHead,
        result: input.result(
          input.raw.data,
          info.data.projectionHead,
        ),
      }),
    },
    requestId: input.raw.requestId,
  };
}

async function executeHRAMutation(
  ctx: ActionCtx,
  input: {
    route: HRAHumanRouteMatch & { workspaceId: string };
    intent: HRAHumanMutationIntent;
    expectedProjectionHead: number;
    idempotencyKey: string;
    requestId: string;
  },
): Promise<DomainResult<{ mutation: TaskWorkspaceMutationResult }>> {
  const { route, intent, expectedProjectionHead, idempotencyKey, requestId } =
    input;
  if (intent.expectedWorkspaceRevision !== expectedProjectionHead) {
    return failure("VALIDATION_ERROR", requestId);
  }
  const controls = {
    workspaceId: route.workspaceId,
    idempotencyKey,
    hraOperationId: intent.operationId,
    expectedProjectionHead,
  } as const;

  if (intent.kind === "workspace.rename") {
    const raw = await ctx.runMutation(internal.hraHuman.renameWorkspace, {
      ...controls,
      name: intent.name,
      requestId,
    });
    return await finishMutation(ctx, {
      raw,
      intent,
      workspaceId: route.workspaceId,
      requestId,
      result: (_data, projectionHead) => ({
        kind: "workspace",
        workspaceRevision: projectionHead,
      }),
    });
  }

  if (
    intent.kind === "task.create" ||
    intent.kind === "task.create_and_run"
  ) {
    let parentKey: string | undefined;
    if (
      intent.parentTaskId !== undefined &&
      intent.expectedParentRevision !== undefined
    ) {
      const parent = await resolveExpectedTask(ctx, {
        workspaceId: route.workspaceId,
        taskId: intent.parentTaskId,
        expectedTaskRevision: intent.expectedParentRevision,
        expectedProjectionHead,
        requestId,
      });
      if (!parent.ok) return parent;
      parentKey = parent.data.task.key;
    }
    const create = {
      ...controls,
      suppliedTaskId: intent.taskId,
      title: intent.title,
      ...(intent.description === undefined
        ? {}
        : { description: intent.description }),
      type: intent.type,
      priority: intent.priority,
      availableAt: intent.availableAt,
      labels: intent.labels,
      ...(intent.repositoryId === undefined
        ? {}
        : { repositoryId: intent.repositoryId }),
      ...(parentKey === undefined ? {} : { parentKey }),
    };
    if (intent.kind === "task.create") {
      const raw = await ctx.runMutation(
        api.humanTaskMutations.createTask,
        create,
      );
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: ({ task }) => ({
          kind: "task_created",
          taskId: task.id,
          taskRevision: task.revision,
        }),
      });
    }
    const raw = await ctx.runMutation(api.dispatch.createTaskAndDispatch, {
      ...create,
      repositoryId: intent.repositoryId,
    });
    return await finishMutation(ctx, {
      raw,
      intent,
      workspaceId: route.workspaceId,
      requestId,
      result: ({ task, run }) => ({
        kind: "task_created",
        taskId: task.id,
        taskRevision: task.revision,
        runId: run.id,
      }),
    });
  }

  if (intent.kind === "dispatch.stop") {
    const raw = await ctx.runMutation(api.dispatch.requestRunStop, {
      ...controls,
      runId: intent.runId,
    });
    return await finishMutation(ctx, {
      raw,
      intent,
      workspaceId: route.workspaceId,
      requestId,
      result: ({ runId, phase }) => ({
        kind: "run_updated",
        runId,
        phase,
      }),
    });
  }

  if (
    intent.kind === "task.comment_add" ||
    intent.kind === "review.accept" ||
    intent.kind === "review.reject"
  ) {
    const identity = await ctx.runQuery(internal.hraHuman.taskIdentity, {
      workspaceId: route.workspaceId,
      taskId: intent.taskId,
      requestId,
    });
    if (!identity.ok) return identity;
    if (intent.kind === "task.comment_add") {
      const raw = await ctx.runMutation(
        api.humanTaskMutations.addTaskComment,
        {
          ...controls,
          key: identity.data.task.key,
          body: intent.body,
        },
      );
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: ({ comment }) => ({
          kind: "comment_added",
          taskId: identity.data.task.id,
          commentId: comment.id,
        }),
      });
    }
    const reviewArgs = {
      ...controls,
      key: identity.data.task.key,
      submissionId: intent.submissionId,
      reviewRevision: intent.expectedReviewRevision,
    };
    const raw = intent.kind === "review.accept"
      ? await ctx.runMutation(
          api.humanTaskMutations.acceptSubmission,
          reviewArgs,
        )
      : await ctx.runMutation(
          api.humanTaskMutations.rejectSubmission,
          { ...reviewArgs, reason: intent.reason },
        );
    return await finishMutation(ctx, {
      raw,
      intent,
      workspaceId: route.workspaceId,
      requestId,
      result: ({ task: updated, submission }) => ({
        kind: "submission_updated",
        taskId: updated.id,
        submissionId: submission.id,
        taskRevision: updated.revision,
      }),
    });
  }

  const task = await resolveExpectedTask(ctx, {
    workspaceId: route.workspaceId,
    taskId: intent.taskId,
    expectedTaskRevision: intent.expectedTaskRevision,
    expectedProjectionHead,
    requestId,
  });
  if (!task.ok) return task;
  const taskArgs = {
    ...controls,
    key: task.data.task.key,
    revision: intent.expectedTaskRevision,
  } as const;
  const taskResult = (updated: {
    task: { id: string; revision: number };
  }) => ({
    kind: "task_updated" as const,
    taskId: updated.task.id,
    taskRevision: updated.task.revision,
  });

  switch (intent.kind) {
    case "task.update": {
      const patch = {
        ...(intent.patch.title === undefined
          ? {}
          : { title: intent.patch.title }),
        ...(intent.patch.description === undefined
          ? {}
          : { description: intent.patch.description }),
        ...(intent.patch.type === undefined
          ? {}
          : { type: intent.patch.type }),
        ...(intent.patch.priority === undefined
          ? {}
          : { priority: intent.patch.priority }),
        ...(intent.patch.availableAt === undefined
          ? {}
          : { availableAt: intent.patch.availableAt }),
      };
      const raw = await ctx.runMutation(api.humanTaskMutations.updateTask, {
        ...taskArgs,
        ...patch,
      });
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: taskResult,
      });
    }
    case "task.cancel": {
      const raw = await ctx.runMutation(api.humanTaskMutations.cancelTask, {
        ...taskArgs,
        reason: intent.reason,
      });
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: taskResult,
      });
    }
    case "task.reopen": {
      const raw = await ctx.runMutation(api.humanTaskMutations.reopenTask, {
        ...taskArgs,
      });
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: taskResult,
      });
    }
    case "task.assign": {
      const raw = await ctx.runMutation(api.humanTaskMutations.assignTask, {
        ...taskArgs,
        agentId: intent.assigneeAgentId,
      });
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: taskResult,
      });
    }
    case "task.defer": {
      const raw = await ctx.runMutation(api.humanTaskMutations.deferTask, {
        ...taskArgs,
        availableAt: intent.availableAt,
      });
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: taskResult,
      });
    }
    case "task.parent_set": {
      const parent = await resolveExpectedTask(ctx, {
        workspaceId: route.workspaceId,
        taskId: intent.parentTaskId,
        expectedTaskRevision: intent.expectedParentRevision,
        expectedProjectionHead,
        requestId,
      });
      if (!parent.ok) return parent;
      const raw = await ctx.runMutation(
        api.humanTaskMutations.setTaskParent,
        {
          ...taskArgs,
          parentKey: parent.data.task.key,
        },
      );
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: taskResult,
      });
    }
    case "task.parent_clear": {
      const raw = await ctx.runMutation(
        api.humanTaskMutations.clearTaskParent,
        taskArgs,
      );
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: taskResult,
      });
    }
    case "task.label_add":
    case "task.label_remove": {
      const raw = await ctx.runMutation(
        intent.kind === "task.label_add"
          ? api.humanTaskMutations.addTaskLabel
          : api.humanTaskMutations.removeTaskLabel,
        { ...taskArgs, label: intent.label },
      );
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: taskResult,
      });
    }
    case "task.reference_add": {
      const reference = intent.reference.kind === "pull_request"
        ? {
            kind: intent.reference.kind,
            url: intent.reference.url,
            ...(intent.reference.repositoryId === undefined
              ? {}
              : { repositoryId: intent.reference.repositoryId }),
          }
        : intent.reference.kind === "commit"
          ? {
              kind: intent.reference.kind,
              sha: intent.reference.sha,
              ...(intent.reference.repositoryId === undefined
                ? {}
                : { repositoryId: intent.reference.repositoryId }),
              ...(intent.reference.url === undefined
                ? {}
                : { url: intent.reference.url }),
            }
          : intent.reference;
      const raw = await ctx.runMutation(
        api.humanTaskMutations.addTaskReference,
        { ...taskArgs, reference },
      );
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: ({ reference, task: updated }) => ({
          kind: "reference_added",
          taskId: updated.id,
          referenceId: reference.id,
        }),
      });
    }
    case "task.reference_remove": {
      const raw = await ctx.runMutation(
        api.humanTaskMutations.removeTaskReference,
        { ...taskArgs, referenceId: intent.referenceId },
      );
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: ({ referenceId, task: updated }) => ({
          kind: "reference_removed",
          taskId: updated.id,
          referenceId,
        }),
      });
    }
    case "dependency.add":
    case "dependency.remove": {
      const blocker = await resolveExpectedTask(ctx, {
        workspaceId: route.workspaceId,
        taskId: intent.blockerTaskId,
        expectedTaskRevision: intent.expectedBlockerRevision,
        expectedProjectionHead,
        requestId,
      });
      if (!blocker.ok) return blocker;
      const raw = await ctx.runMutation(
        intent.kind === "dependency.add"
          ? api.humanTaskMutations.addTaskDependency
          : api.humanTaskMutations.removeTaskDependency,
        { ...taskArgs, blockerKey: blocker.data.task.key },
      );
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: ({ task: updated }) => ({
          kind: "task_updated",
          taskId: updated.id,
          taskRevision: updated.revision,
        }),
      });
    }
    case "dispatch.retry": {
      const raw = await ctx.runMutation(api.dispatch.retryRun, {
        ...controls,
        runId: intent.sourceRunId,
        taskRevision: intent.expectedTaskRevision,
      });
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: ({ run }) => ({
          kind: "run_updated",
          runId: run.id,
          phase: run.phase,
        }),
      });
    }
    case "dispatch.resolve_ambiguity": {
      const raw = await ctx.runMutation(api.dispatch.abandonAmbiguousRun, {
        ...controls,
        runId: intent.sourceRunId,
        taskRevision: intent.expectedTaskRevision,
        reason: intent.reason,
      });
      return await finishMutation(ctx, {
        raw,
        intent,
        workspaceId: route.workspaceId,
        requestId,
        result: ({ run }) => ({
          kind: "run_updated",
          runId: run.id,
          phase: run.phase,
        }),
      });
    }
    default:
      return failure("VALIDATION_ERROR", requestId);
  }
}

async function mutateHRAWorkspace(
  ctx: ActionCtx,
  request: Request,
  route: HRAHumanRouteMatch & { workspaceId: string },
  requestId: string,
): Promise<Response> {
  if (!hasJsonContentType(request)) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const key = idempotencyKey(request);
  if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
  const body = hraHumanApiOperations.mutate.requestSchema.safeParse(
    await parseJsonBody(request),
  );
  if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
  const retried = await runIdempotentMutationWithRetry(
    requestId,
    async () =>
      await executeHRAMutation(ctx, {
        route,
        intent: body.data.intent,
        expectedProjectionHead: body.data.expectedProjectionHead,
        idempotencyKey: key,
        requestId,
      }),
  );
  if (retried.kind === "exhausted") {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  return resultResponse(
    retried.value,
    hraHumanApiOperations.mutate.responseSchema,
  );
}

async function respondHRAInteraction(
  ctx: ActionCtx,
  request: Request,
  route: HRAHumanRouteMatch & {
    workspaceId: string;
    runId: string;
    interactionId: string;
  },
  requestId: string,
): Promise<Response> {
  if (!hasJsonContentType(request)) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const key = idempotencyKey(request);
  if (key === null) return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
  const body = hraHumanApiOperations.respondInteraction.requestSchema
    .safeParse(await parseJsonBody(request));
  if (
    !body.success ||
    body.data.workspaceId !== route.workspaceId ||
    body.data.expectedWorkspaceRevision !==
      body.data.expectedProjectionHead
  ) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const identity = await ctx.runQuery(
    internal.hraHuman.interactionIdentity,
    {
      workspaceId: route.workspaceId,
      runId: route.runId,
      interactionId: route.interactionId,
      requestId,
    },
  );
  if (!identity.ok) {
    return resultResponse(
      identity,
      hraHumanApiOperations.respondInteraction.responseSchema,
    );
  }
  if (
    identity.data.requestDigest !== body.data.requestDigest
  ) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const retried = await runIdempotentMutationWithRetry(
    requestId,
    async () =>
      await ctx.runMutation(
        api.dispatchInteractions.respondToRunInteraction,
        {
          workspaceId: route.workspaceId,
          runId: route.runId,
          interactionId: route.interactionId,
          sealedResponse: body.data.sealedResponse,
          idempotencyKey: key,
          hraOperationId: body.data.operationId,
          expectedProjectionHead: body.data.expectedProjectionHead,
        },
      ),
  );
  if (retried.kind === "exhausted") {
    return errorResponse("SERVICE_UNAVAILABLE", requestId);
  }
  const raw = retried.value;
  if (!raw.ok) {
    return resultResponse(
      raw,
      hraHumanApiOperations.respondInteraction.responseSchema,
    );
  }
  const info = await workspaceInfo(ctx, route.workspaceId, requestId);
  if (!info.ok) {
    return resultResponse(
      info,
      hraHumanApiOperations.respondInteraction.responseSchema,
    );
  }
  return resultResponse(
    {
      ok: true as const,
      data: {
        mutation: hraMutationResult({
          operationId: body.data.operationId,
          workspaceId: route.workspaceId,
          commandKind: "interaction.respond",
          workspaceRevision: info.data.projectionHead,
          projectionRevision: info.data.projectionHead,
          result: {
            kind: "interaction_updated",
            runId: route.runId,
            interactionId: raw.data.interactionId,
            state: raw.data.state,
          },
        }),
      },
      requestId: raw.requestId,
    },
    hraHumanApiOperations.respondInteraction.responseSchema,
  );
}

async function getHRAInteractionReplyAuthority(
  ctx: ActionCtx,
  request: Request,
  route: HRAHumanRouteMatch & {
    workspaceId: string;
    runId: string;
    interactionId: string;
  },
  requestId: string,
): Promise<Response> {
  const query = strictQuery(new URL(request.url));
  const parsed = query === null
    ? null
    : hraHumanApiOperations.interactionReplyAuthority.querySchema
      .safeParse(query);
  if (parsed === null || !parsed.success) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const result = await ctx.runQuery(
    internal.hraHuman.interactionReplyAuthority,
    {
      workspaceId: route.workspaceId,
      runId: route.runId,
      interactionId: route.interactionId,
      requestDigest: parsed.data.requestDigest,
      projectionHead: parsed.data.projectionHead,
      requestId,
    },
  );
  return resultResponse(
    result,
    hraHumanApiOperations.interactionReplyAuthority.responseSchema,
  );
}

async function dispatchHRAHuman(
  ctx: ActionCtx,
  request: Request,
  route: HRAHumanRouteMatch,
  requestId: string,
): Promise<Response> {
  if (route.operation === "list_workspaces") {
    return await listHRAWorkspaces(ctx, request, requestId);
  }
  if (route.workspaceId === undefined) {
    return errorResponse("VALIDATION_ERROR", requestId);
  }
  const workspaceRoute = { ...route, workspaceId: route.workspaceId };
  switch (route.operation) {
    case "get_workspace":
      return await getHRAWorkspace(ctx, workspaceRoute, requestId);
    case "get_context":
      return await getHRAContext(ctx, workspaceRoute, requestId);
    case "list_repositories":
      return await listHRARepositories(
        ctx,
        request,
        workspaceRoute,
        requestId,
      );
    case "list_tasks":
      return await listHRATasks(
        ctx,
        request,
        workspaceRoute,
        requestId,
      );
    case "lookup_task":
      return await lookupHRATask(
        ctx,
        request,
        workspaceRoute,
        requestId,
      );
    case "get_task":
      return route.taskId === undefined
        ? errorResponse("VALIDATION_ERROR", requestId)
        : await getHRATask(
            ctx,
            request,
            {
              ...workspaceRoute,
              taskId: route.taskId,
            },
            requestId,
          );
    case "mutate":
      return await mutateHRAWorkspace(
        ctx,
        request,
        workspaceRoute,
        requestId,
      );
    case "poll_invalidations":
      return await pollHRAInvalidations(
        ctx,
        request,
        workspaceRoute,
        requestId,
      );
    case "get_interaction_reply_authority":
      return route.runId === undefined || route.interactionId === undefined
        ? errorResponse("VALIDATION_ERROR", requestId)
        : await getHRAInteractionReplyAuthority(
            ctx,
            request,
            {
              ...workspaceRoute,
              runId: route.runId,
              interactionId: route.interactionId,
            },
            requestId,
          );
    case "respond_interaction":
      return route.runId === undefined || route.interactionId === undefined
        ? errorResponse("VALIDATION_ERROR", requestId)
        : await respondHRAInteraction(
            ctx,
            request,
            {
              ...workspaceRoute,
              runId: route.runId,
              interactionId: route.interactionId,
            },
            requestId,
          );
    default:
      return errorResponse("VALIDATION_ERROR", requestId);
  }
}

export const hraHumanHttp = httpAction(async (ctx, request) => {
  const requestId = randomRequestId();
  try {
    if (!hasHRABearer(request)) {
      return errorResponse("AUTHENTICATION_FAILED", requestId);
    }
    const route = parseHRAHumanRoute({
      method: request.method,
      pathname: new URL(request.url).pathname,
    });
    if (route === null) return errorResponse("VALIDATION_ERROR", requestId);
    const admissionRateClass = hraHumanAdmissionRateClass(route.operation);
    if (admissionRateClass !== null) {
      if (route.workspaceId === undefined) {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const limited = await hraPollRateLimitResponse(
        ctx,
        route.workspaceId,
        requestId,
      );
      if (limited !== null) return limited;
    }
    return await dispatchHRAHuman(ctx, request, route, requestId);
  } catch {
    return errorResponse("INTERNAL_ERROR", requestId);
  }
});

async function dispatchHRAPromotion(
  ctx: ActionCtx,
  request: Request,
  route: HRAPromotionRouteMatch,
  requestId: string,
): Promise<Response> {
  const key = route.operation === "lookup" ||
      route.operation === "list_receipts" ||
      route.operation === "cleanup_status"
    ? null
    : idempotencyKey(request);
  if (key === null && route.operation !== "lookup" &&
    route.operation !== "list_receipts" &&
    route.operation !== "cleanup_status") {
    return errorResponse("IDEMPOTENCY_REQUIRED", requestId);
  }

  if (route.operation === "start") {
    if (!hasJsonContentType(request) || key === null) {
      return errorResponse("VALIDATION_ERROR", requestId);
    }
    const body = hraPromotionApiOperations.start.requestSchema.safeParse(
      await parseJsonBody(request, HRA_PROMOTION_MAX_REQUEST_BYTES),
    );
    if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
    const result = await ctx.runMutation(internal.hraPromotion.start, {
      body: body.data,
      idempotencyKey: key,
      requestId,
    });
    return resultResponse(
      result,
      hraPromotionApiOperations.start.responseSchema,
    );
  }

  const promotionId = route.promotionId;
  switch (route.operation) {
    case "lookup": {
      const result = await ctx.runQuery(internal.hraPromotion.lookup, {
        promotionId,
        requestId,
      });
      return resultResponse(
        result,
        hraPromotionApiOperations.lookup.responseSchema,
      );
    }
    case "list_receipts": {
      const query = strictQuery(new URL(request.url));
      const parsed = query === null
        ? null
        : hraPromotionApiOperations.listReceipts.querySchema.safeParse(
            query,
          );
      if (parsed === null || !parsed.success) {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const result = await ctx.runQuery(
        internal.hraPromotion.listReceipts,
        {
          promotionId,
          ...(parsed.data.cursor === undefined
            ? {}
            : { cursor: parsed.data.cursor }),
          limit: parsed.data.limit,
          requestId,
        },
      );
      return resultResponse(
        result,
        hraPromotionApiOperations.listReceipts.responseSchema,
      );
    }
    case "cleanup_status": {
      const result = await ctx.runQuery(
        internal.hraPromotion.cleanupStatus,
        { promotionId, requestId },
      );
      return resultResponse(
        result,
        hraPromotionApiOperations.cleanupStatus.responseSchema,
      );
    }
    case "accept_batch": {
      if (!hasJsonContentType(request) || key === null) {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const body = hraPromotionApiOperations.acceptBatch.requestSchema
        .safeParse(
          await parseJsonBody(request, HRA_PROMOTION_MAX_REQUEST_BYTES),
        );
      if (
        !body.success ||
        body.data.batch.promotionId !== promotionId
      ) {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const result = await ctx.runMutation(
        internal.hraPromotion.acceptBatch,
        {
          promotionId,
          body: body.data,
          idempotencyKey: key,
          requestId,
        },
      );
      return resultResponse(
        result,
        hraPromotionApiOperations.acceptBatch.responseSchema,
      );
    }
    case "activate": {
      if (!hasJsonContentType(request) || key === null) {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const body = hraPromotionApiOperations.activate.requestSchema
        .safeParse(
          await parseJsonBody(request, HRA_PROMOTION_MAX_REQUEST_BYTES),
        );
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const result = await ctx.runMutation(
        internal.hraPromotion.activate,
        {
          promotionId,
          body: body.data,
          idempotencyKey: key,
          requestId,
        },
      );
      return resultResponse(
        result,
        hraPromotionApiOperations.activate.responseSchema,
      );
    }
    case "abort": {
      if (!hasJsonContentType(request) || key === null) {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const body = hraPromotionApiOperations.abort.requestSchema.safeParse(
        await parseJsonBody(request, HRA_PROMOTION_MAX_REQUEST_BYTES),
      );
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const result = await ctx.runMutation(internal.hraPromotion.abort, {
        promotionId,
        body: body.data,
        idempotencyKey: key,
        requestId,
      });
      return resultResponse(
        result,
        hraPromotionApiOperations.abort.responseSchema,
      );
    }
    case "advance_cleanup": {
      if (!hasJsonContentType(request) || key === null) {
        return errorResponse("VALIDATION_ERROR", requestId);
      }
      const body =
        hraPromotionApiOperations.advanceCleanup.requestSchema.safeParse(
          await parseJsonBody(request),
        );
      if (!body.success) return errorResponse("VALIDATION_ERROR", requestId);
      const result = await ctx.runMutation(
        internal.hraPromotion.advanceCleanup,
        {
          promotionId,
          limit: body.data.limit,
          idempotencyKey: key,
          requestId,
        },
      );
      return resultResponse(
        result,
        hraPromotionApiOperations.advanceCleanup.responseSchema,
      );
    }
    default:
      return errorResponse("VALIDATION_ERROR", requestId);
  }
}

export const hraPromotionHttp = httpAction(async (ctx, request) => {
  const requestId = randomRequestId();
  try {
    if (!hasHRABearer(request)) {
      return errorResponse("AUTHENTICATION_FAILED", requestId);
    }
    const route = parseHRAPromotionRoute({
      method: request.method,
      pathname: new URL(request.url).pathname,
    });
    if (route === null) return errorResponse("VALIDATION_ERROR", requestId);
    if (request.method === "POST") {
      const retried = await runIdempotentMutationWithRetry(
        requestId,
        async () =>
          await dispatchHRAPromotion(
            ctx,
            request.clone(),
            route,
            requestId,
          ),
      );
      return retried.kind === "success"
        ? retried.value
        : errorResponse("SERVICE_UNAVAILABLE", requestId);
    }
    return await dispatchHRAPromotion(ctx, request, route, requestId);
  } catch {
    return errorResponse("INTERNAL_ERROR", requestId);
  }
});
