import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { authorizeAgent, type AuthorizedAgent } from "./authorization";
import { domainFailure } from "./domain";
import {
  authorizeWorkspaceHuman,
  findHumanUser,
  readHumanIdentity,
} from "./humanAuthorization";
import {
  MAX_RATE_LIMIT_CLEANUP_ROWS,
  apiOperationRateLimitClass,
  agentOperationAuthorizationPolicy,
  planRateLimitConsumption,
  rateLimitPolicies,
  rateLimitShard,
  rateLimitWindow,
  type AgentReadOperation,
  type AuthenticatedAgentRouteClass,
  type RateLimitBucketSnapshot,
  type RateLimitRouteClass,
  type RateLimitSubject,
} from "./rateLimitPolicy";

const agentReadOperationValidator = v.union(
  v.literal("context"),
  v.literal("readyTasks"),
  v.literal("listTasks"),
  v.literal("getTask"),
  v.literal("blockedTasks"),
  v.literal("listTaskLabels"),
  v.literal("listTaskComments"),
  v.literal("listTaskEvents"),
  v.literal("taskGraph"),
  v.literal("listTaskDependencies"),
  v.literal("listTaskReferences"),
  v.literal("reviewQueue"),
);
const humanRouteClassValidator = v.union(
  v.literal("human_read"),
  v.literal("human_mutation"),
  v.literal("human_poll"),
);
const opaqueRouteClassValidator = v.union(
  v.literal("refresh_auth"),
  v.literal("agent_auth_failure"),
  v.literal("enrollment_auth_failure"),
);
const consumeResultValidator = v.union(
  v.object({ kind: v.literal("allowed") }),
  v.object({ kind: v.literal("limited"), retryAfterMs: v.number() }),
  v.object({ kind: v.literal("skipped") }),
  v.object({ kind: v.literal("unavailable") }),
);

export type RateLimitConsumeResult =
  | { readonly kind: "allowed" }
  | { readonly kind: "limited"; readonly retryAfterMs: number }
  | { readonly kind: "skipped" }
  | { readonly kind: "unavailable" };

export function agentRateLimitFailure(
  result: RateLimitConsumeResult,
  requestId: string,
) {
  if (result.kind === "allowed") return null;
  return result.kind === "limited"
    ? domainFailure("RATE_LIMITED", requestId, { retryAfterMs: result.retryAfterMs })
    : domainFailure("SERVICE_UNAVAILABLE", requestId);
}

interface LoadedBucket {
  readonly document: Doc<"apiRateLimitBuckets">;
  readonly snapshot: RateLimitBucketSnapshot;
}

async function loadSelectedBuckets(
  ctx: MutationCtx,
  args: {
    readonly routeClass: RateLimitRouteClass;
    readonly subjects: readonly RateLimitSubject[];
    readonly requestId: string;
    readonly now: number;
  },
): Promise<readonly LoadedBucket[] | null> {
  const policy = rateLimitPolicies[args.routeClass];
  const shard = rateLimitShard(args.requestId, policy.shardCount);
  const window = rateLimitWindow(args.now, policy.windowMs);
  if (shard === null || window === null) return null;
  const documents = await Promise.all(
    args.subjects.map(async (subject) =>
      await ctx.db
        .query("apiRateLimitBuckets")
        .withIndex("by_subject_route_window_shard", (query) =>
          query
            .eq("subjectKind", subject.kind)
            .eq("subjectKey", subject.key)
            .eq("routeClass", args.routeClass)
            .eq("windowStartedAt", window.startedAt)
            .eq("shard", shard),
        )
        .unique(),
    ),
  );
  return documents.flatMap((document) =>
    document === null
      ? []
      : [
          {
            document,
            snapshot: {
              id: document._id,
              kind: document.subjectKind,
              key: document.subjectKey,
              routeClass: document.routeClass,
              windowStartedAt: document.windowStartedAt,
              shard: document.shard,
              count: document.count,
              expiresAt: document.expiresAt,
            },
          },
        ],
  );
}

async function consume(
  ctx: MutationCtx,
  args: {
    readonly routeClass: RateLimitRouteClass;
    readonly subjects: readonly RateLimitSubject[];
    readonly requestId: string;
    readonly now?: number;
  },
): Promise<RateLimitConsumeResult> {
  const now = args.now ?? Date.now();
  const loaded = await loadSelectedBuckets(ctx, { ...args, now });
  if (loaded === null) return { kind: "unavailable" };
  const plan = planRateLimitConsumption({
    ...args,
    currentWindowBuckets: loaded.map(({ snapshot }) => snapshot),
    now,
  });
  if (plan.kind === "invalid") return { kind: "unavailable" };
  if (plan.kind === "limited") {
    return { kind: "limited", retryAfterMs: plan.retryAfterMs };
  }
  const ids = new Map<string, Id<"apiRateLimitBuckets">>(
    loaded.map(({ document }) => [document._id, document._id]),
  );
  if (plan.writes.some((write) => write.kind === "increment" && !ids.has(write.id))) {
    return { kind: "unavailable" };
  }
  for (const write of plan.writes) {
    if (write.kind === "insert") {
      await ctx.db.insert("apiRateLimitBuckets", {
        subjectKind: write.bucket.kind,
        subjectKey: write.bucket.key,
        routeClass: write.bucket.routeClass,
        windowStartedAt: write.bucket.windowStartedAt,
        shard: write.bucket.shard,
        count: write.bucket.count,
        expiresAt: write.bucket.expiresAt,
      });
      continue;
    }
    const id = ids.get(write.id);
    if (id === undefined) throw new Error("Selected rate-limit bucket disappeared.");
    await ctx.db.patch(id, { count: write.count, expiresAt: write.expiresAt });
  }
  return { kind: "allowed" };
}

/**
 * Transaction-local entry point for public Convex functions that have already
 * completed human workspace authorization in the same mutation.
 */
export async function consumeAuthorizedHumanRateLimit(
  ctx: MutationCtx,
  args: {
    readonly userId: Id<"users">;
    readonly workspaceId?: Id<"workspaces">;
    readonly routeClass: "human_read" | "human_mutation" | "human_poll";
    readonly requestId: string;
  },
): Promise<RateLimitConsumeResult> {
  return await consume(ctx, {
    routeClass: args.routeClass,
    subjects: [
      { kind: "user", key: args.userId },
      ...(args.workspaceId === undefined
        ? []
        : ([{ kind: "workspace", key: args.workspaceId }] as const)),
    ],
    requestId: args.requestId,
  });
}

/**
 * Transaction-local entry point for an agent whose complete mutable
 * authorization tuple was reloaded in this mutation immediately beforehand.
 */
export async function consumeAuthorizedAgentRateLimit(
  ctx: MutationCtx,
  args: {
    readonly authorization: Pick<AuthorizedAgent, "credentialId" | "workspaceId">;
    readonly routeClass: AuthenticatedAgentRouteClass;
    readonly requestId: string;
    readonly now?: number;
  },
): Promise<RateLimitConsumeResult> {
  return await consume(ctx, {
    routeClass: args.routeClass,
    subjects: [
      { kind: "credential", key: args.authorization.credentialId },
      { kind: "workspace", key: args.authorization.workspaceId },
    ],
    requestId: args.requestId,
    ...(args.now === undefined ? {} : { now: args.now }),
  });
}

/**
 * The HTTP action cannot safely debit a read from bearer lookup alone. This
 * mutation reloads and validates the complete credential/session/tenant tuple
 * and required scope before touching either authenticated bucket.
 */
export async function consumeValidatedAgentReadRateLimit(
  ctx: MutationCtx,
  args: {
    readonly credentialId: Id<"agentCredentials">;
    readonly operation: AgentReadOperation;
    readonly requestId: string;
    readonly sessionPublicId: string;
    readonly now?: number;
  },
): Promise<RateLimitConsumeResult> {
  const policy = agentOperationAuthorizationPolicy[args.operation];
  const now = args.now ?? Date.now();
  const authorization = await authorizeAgent(ctx, {
    credentialId: args.credentialId,
    sessionPublicId: args.sessionPublicId,
    requestId: args.requestId,
    requiredScope: policy.requiredScope,
    now,
  });
  if (!authorization.ok) return { kind: "skipped" };
  return await consumeAuthorizedAgentRateLimit(ctx, {
    authorization: authorization.authorization,
    routeClass: apiOperationRateLimitClass[args.operation].routeClass,
    requestId: args.requestId,
    now,
  });
}

export const consumeAgentRead = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    operation: agentReadOperationValidator,
    requestId: v.string(),
    sessionPublicId: v.string(),
  },
  returns: consumeResultValidator,
  handler: async (ctx, args) => await consumeValidatedAgentReadRateLimit(ctx, args),
});

export const consumeHuman = internalMutation({
  args: {
    routeClass: humanRouteClassValidator,
    workspacePublicId: v.optional(v.string()),
    requestId: v.string(),
  },
  returns: consumeResultValidator,
  handler: async (ctx, args) => {
    if (args.workspacePublicId === undefined) {
      const identified = await readHumanIdentity(ctx, args.requestId, false);
      if (!identified.ok) return { kind: "skipped" as const };
      const user = await findHumanUser(ctx, identified.identity.subject);
      if (user === null) return { kind: "skipped" as const };
      return await consumeAuthorizedHumanRateLimit(ctx, {
        userId: user._id,
        routeClass: args.routeClass,
        requestId: args.requestId,
      });
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: args.requestId,
      workspacePublicId: args.workspacePublicId,
    });
    if (!authorized.ok) return { kind: "skipped" as const };
    return await consumeAuthorizedHumanRateLimit(ctx, {
      userId: authorized.authorization.user._id,
      workspaceId: authorized.authorization.workspace._id,
      routeClass: args.routeClass,
      requestId: args.requestId,
    });
  },
});

export const consumeOpaque = internalMutation({
  args: {
    routeClass: opaqueRouteClassValidator,
    slotKey: v.string(),
    requestId: v.string(),
  },
  returns: consumeResultValidator,
  handler: async (ctx, args) =>
    await consume(ctx, {
      routeClass: args.routeClass,
      subjects: [{ kind: "unauthenticated", key: args.slotKey }],
      requestId: args.requestId,
    }),
});

export const sweepExpired = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("apiRateLimitBuckets")
      .withIndex("by_expiry", (query) => query.lte("expiresAt", Date.now()))
      .take(MAX_RATE_LIMIT_CLEANUP_ROWS + 1);
    for (const row of rows.slice(0, MAX_RATE_LIMIT_CLEANUP_ROWS)) {
      await ctx.db.delete(row._id);
    }
    if (rows.length > MAX_RATE_LIMIT_CLEANUP_ROWS) {
      await ctx.scheduler.runAfter(0, internal.rateLimits.sweepExpired, {});
    }
    return {
      deleted: Math.min(rows.length, MAX_RATE_LIMIT_CLEANUP_ROWS),
      hasMore: rows.length > MAX_RATE_LIMIT_CLEANUP_ROWS,
    };
  },
});
