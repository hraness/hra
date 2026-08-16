import {
  runInteractionRequestSchema,
  sealedRunInteractionResponseSchema,
} from "@hraness/agent-tasks-protocol";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import {
  action,
  env,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { decodeBase64Url32, digestArrayBuffer } from "./crypto";
import {
  randomCrockford,
  randomPublicId,
  randomRequestId,
  randomUuidV7,
  isTaskReady,
  taskView,
} from "./domain";
import { appendSecurityEvent, appendTaskEvent } from "./events";
import { submittedTaskClaimMatchesDispatch } from "./dispatchReconciliation";
import {
  agentScopeValidator,
  eventCommandValidator,
  MAX_RUNNER_REPOSITORIES,
  persistedEventActorValidator,
  runInteractionStateValidator,
  sealedRunInteractionResponseValidator,
  taskViewValidator,
} from "./model";
import {
  AUTHENTICATED_RATE_LIMIT_SHARDS,
  perShardRateLimit,
  RATE_LIMIT_WINDOW_MS,
  rateLimitWindow,
} from "./rateLimitPolicy";
import {
  WORKSPACE_ACTIVE_TASK_LIMIT,
  WORKSPACE_TOTAL_TASK_LIMIT,
} from "./workGraphLaws";

const LOCATOR_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const TASK_KEY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/u;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;
const RAW_TOKEN_PATTERN = /(?:agt|enr)_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}/gu;
const RAW_BEARER_MATERIAL_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu;
const PLAINTEXT_INTERACTION_RESPONSE_KEYS = new Set([
  "answer",
  "answers",
  "decision",
  "otherText",
  "plaintext",
  "privateKey",
  "questionId",
  "selectedOptionIds",
]);

type FixtureCtx = QueryCtx | MutationCtx | ActionCtx;

const apiRateLimitSubjectKindValidator = v.union(
  v.literal("credential"),
  v.literal("workspace"),
  v.literal("user"),
  v.literal("unauthenticated"),
);
const apiRateLimitRouteClassValidator = v.union(
  v.literal("refresh_auth"),
  v.literal("agent_read"),
  v.literal("agent_write"),
  v.literal("agent_claim"),
  v.literal("agent_review"),
  v.literal("agent_session"),
  v.literal("human_read"),
  v.literal("human_mutation"),
  v.literal("human_poll"),
  v.literal("agent_auth_failure"),
  v.literal("enrollment_auth_failure"),
);

async function requireLocalFixtureIdentity(ctx: FixtureCtx) {
  const configured =
    env.TASKCTL_LOCAL_FIXTURES_ENABLED === "true" &&
    env.TASKCTL_LOCAL_FIXTURE_ISSUER !== undefined &&
    env.TASKCTL_LOCAL_FIXTURE_SUBJECT !== undefined;
  if (!configured) throw new Error("Local fixtures are disabled.");
  const identity = await ctx.auth.getUserIdentity();
  if (
    identity === null ||
    identity.issuer !== env.TASKCTL_LOCAL_FIXTURE_ISSUER ||
    identity.subject !== env.TASKCTL_LOCAL_FIXTURE_SUBJECT
  ) {
    throw new Error("Local fixture identity denied.");
  }
  return identity;
}

export const resetApiRateLimits = mutation({
  args: {
    subjectKind: v.optional(apiRateLimitSubjectKindValidator),
    subjectKey: v.optional(v.string()),
    routeClass: v.optional(apiRateLimitRouteClassValidator),
  },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const rows = await ctx.db.query("apiRateLimitBuckets").take(5_001);
    if (rows.length > 5_000) throw new Error("Local rate-limit reset exceeded its bounded row limit.");
    const selected = rows.filter(
      (row) =>
        (args.subjectKind === undefined || row.subjectKind === args.subjectKind) &&
        (args.subjectKey === undefined || row.subjectKey === args.subjectKey) &&
        (args.routeClass === undefined || row.routeClass === args.routeClass),
    );
    for (const row of selected) await ctx.db.delete(row._id);
    return { deleted: selected.length };
  },
});

export const inspectApiRateLimits = query({
  args: {},
  returns: v.array(
    v.object({
      subjectKind: apiRateLimitSubjectKindValidator,
      subjectKey: v.string(),
      routeClass: apiRateLimitRouteClassValidator,
      windowStartedAt: v.number(),
      shard: v.number(),
      count: v.number(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    await requireLocalFixtureIdentity(ctx);
    const rows = await ctx.db.query("apiRateLimitBuckets").take(5_001);
    if (rows.length > 5_000) {
      throw new Error("Local rate-limit inspection exceeded its bounded row limit.");
    }
    return rows.map((row) => ({
      subjectKind: row.subjectKind,
      subjectKey: row.subjectKey,
      routeClass: row.routeClass,
      windowStartedAt: row.windowStartedAt,
      shard: row.shard,
      count: row.count,
      expiresAt: row.expiresAt,
    }));
  },
});

export const validateApiRateLimitSubjects = query({
  args: {},
  returns: v.object({
    total: v.number(),
    authenticated: v.number(),
    credentials: v.number(),
    workspaces: v.number(),
    users: v.number(),
    unauthenticated: v.number(),
    refreshRows: v.number(),
    refreshSlots: v.number(),
    invalid: v.number(),
  }),
  handler: async (ctx) => {
    await requireLocalFixtureIdentity(ctx);
    const rows = await ctx.db.query("apiRateLimitBuckets").take(5_001);
    if (rows.length > 5_000) {
      throw new Error("Local rate-limit subject validation exceeded its bounded row limit.");
    }
    let authenticated = 0;
    let credentials = 0;
    let workspaces = 0;
    let users = 0;
    let unauthenticated = 0;
    let refreshRows = 0;
    const refreshSlots = new Set<string>();
    let invalid = 0;
    for (const row of rows) {
      if (row.subjectKind === "unauthenticated") {
        unauthenticated += 1;
        if (row.routeClass === "refresh_auth") {
          refreshRows += 1;
          refreshSlots.add(row.subjectKey);
        }
        if (!/^slot_[0-9]{3}$/u.test(row.subjectKey)) invalid += 1;
        continue;
      }
      authenticated += 1;
      if (row.subjectKind === "credential") credentials += 1;
      else if (row.subjectKind === "workspace") workspaces += 1;
      else users += 1;
      const id =
        row.subjectKind === "credential"
          ? ctx.db.normalizeId("agentCredentials", row.subjectKey)
          : row.subjectKind === "workspace"
            ? ctx.db.normalizeId("workspaces", row.subjectKey)
            : ctx.db.normalizeId("users", row.subjectKey);
      if (id === null || (await ctx.db.get(id)) === null) invalid += 1;
    }
    return {
      total: rows.length,
      authenticated,
      credentials,
      workspaces,
      users,
      unauthenticated,
      refreshRows,
      refreshSlots: refreshSlots.size,
      invalid,
    };
  },
});

export const primeHumanMutationRateLimit = mutation({
  args: {
    workspaceId: v.string(),
    workosUserId: v.string(),
    mode: v.union(v.literal("saturated"), v.literal("invalid")),
  },
  returns: v.object({ seeded: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const [workspace, user] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("users")
        .withIndex("by_workos_user_id", (query) => query.eq("workosUserId", args.workosUserId))
        .unique(),
    ]);
    if (workspace === null || user === null) {
      throw new Error("Local human rate-limit fixture subject not found.");
    }
    const window = rateLimitWindow(Date.now(), RATE_LIMIT_WINDOW_MS);
    const allowance = perShardRateLimit("human_mutation", "user");
    if (window === null || allowance === null) {
      throw new Error("Local human rate-limit fixture policy is invalid.");
    }
    const count = args.mode === "saturated" ? allowance : -1;
    const subjects = [
      { kind: "user" as const, key: String(user._id) },
      { kind: "workspace" as const, key: String(workspace._id) },
    ];
    let seeded = 0;
    for (const subject of subjects) {
      for (let shard = 0; shard < AUTHENTICATED_RATE_LIMIT_SHARDS; shard += 1) {
        const existing = await ctx.db
          .query("apiRateLimitBuckets")
          .withIndex("by_subject_route_window_shard", (query) =>
            query
              .eq("subjectKind", subject.kind)
              .eq("subjectKey", subject.key)
              .eq("routeClass", "human_mutation")
              .eq("windowStartedAt", window.startedAt)
              .eq("shard", shard),
          )
          .unique();
        if (existing === null) {
          await ctx.db.insert("apiRateLimitBuckets", {
            subjectKind: subject.kind,
            subjectKey: subject.key,
            routeClass: "human_mutation",
            windowStartedAt: window.startedAt,
            shard,
            count,
            expiresAt: window.expiresAt,
          });
        } else {
          await ctx.db.patch(existing._id, { count, expiresAt: window.expiresAt });
        }
        seeded += 1;
      }
    }
    return { seeded };
  },
});

const reconciliationStatusValidator = v.union(
  v.literal("completed"),
  v.literal("partial"),
  v.literal("busy"),
  v.literal("unavailable"),
  v.literal("failed"),
);

type FixtureReconciliationResult = {
  readonly status: "completed" | "partial" | "busy" | "unavailable" | "failed";
  readonly processed: number;
};

export const seedOpenTask = mutation({
  args: { workspaceId: v.string(), title: v.string() },
  returns: v.object({ key: v.string(), taskId: v.string(), revision: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const title = args.title.trim();
    if (title.length === 0 || new TextEncoder().encode(title).length > 512) {
      throw new Error("Local fixture task title is invalid.");
    }
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null || workspace.status !== "active") {
      throw new Error("Local fixture workspace not found.");
    }
    const usage = await ctx.db
      .query("workspaceUsage")
      .withIndex("by_workspace", (query) => query.eq("workspaceId", workspace._id))
      .unique();
    if (
      usage === null ||
      usage.activeTasks >= WORKSPACE_ACTIVE_TASK_LIMIT ||
      usage.totalTasks >= WORKSPACE_TOTAL_TASK_LIMIT
    ) {
      throw new Error("Local fixture workspace usage is unavailable.");
    }
    let key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await ctx.db
        .query("tasks")
        .withIndex("by_workspace_and_key", (query) =>
          query.eq("workspaceId", workspace._id).eq("key", key),
        )
        .unique();
      if (existing === null) break;
      key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
    }
    const now = Date.now();
    const taskPublicId = randomPublicId("tsk");
    const actor = { kind: "system" as const, jobKind: "repair" as const, sourceId: "local-fixture" };
    const taskId = await ctx.db.insert("tasks", {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      publicId: taskPublicId,
      key,
      title,
      type: "task",
      priority: 2,
      status: "open",
      availableAt: now,
      isReady: true,
      isBlocked: false,
      unresolvedBlockerCount: 0,
      cancelledBlockerCount: 0,
      revision: 1,
      reviewRevision: 1,
      createdBy: actor,
      lastEditedBy: actor,
      readySince: now,
      needsAttention: false,
      wakeGeneration: 0,
      claimFence: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("taskBodies", {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      taskId,
      description: "",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(usage._id, {
      activeTasks: usage.activeTasks + 1,
      totalTasks: usage.totalTasks + 1,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      taskId,
      taskPublicId,
      taskRevision: 1,
      type: "task.created",
      actor,
      command: { kind: "system", jobKind: "repair" },
      payload: { availableAt: now },
      now,
    });
    return { key, taskId: taskPublicId, revision: 1 };
  },
});

export const seedInReviewTask = mutation({
  args: { workspaceId: v.string(), title: v.string() },
  returns: v.object({ key: v.string(), submissionId: v.string(), revision: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const title = args.title.trim();
    if (title.length === 0 || new TextEncoder().encode(title).length > 512) {
      throw new Error("Local fixture task title is invalid.");
    }
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null || workspace.status !== "active") {
      throw new Error("Local fixture workspace not found.");
    }
    const usage = await ctx.db
      .query("workspaceUsage")
      .withIndex("by_workspace", (query) => query.eq("workspaceId", workspace._id))
      .unique();
    if (
      usage === null ||
      usage.activeTasks >= WORKSPACE_ACTIVE_TASK_LIMIT ||
      usage.totalTasks >= WORKSPACE_TOTAL_TASK_LIMIT
    ) {
      throw new Error("Local fixture workspace task quota is unavailable.");
    }
    let key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await ctx.db
        .query("tasks")
        .withIndex("by_workspace_and_key", (query) =>
          query.eq("workspaceId", workspace._id).eq("key", key),
        )
        .unique();
      if (existing === null) break;
      key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
    }
    const now = Date.now();
    const taskPublicId = randomPublicId("tsk");
    const submissionPublicId = randomPublicId("sub");
    const systemActor = {
      kind: "system" as const,
      jobKind: "repair" as const,
      sourceId: "local-review-fixture",
    };
    const submittedBy = {
      kind: "agent" as const,
      agentId: `agt_${randomCrockford(26)}`,
      credentialId: `fixture_${randomCrockford(16)}`,
    };
    const taskId = await ctx.db.insert("tasks", {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      publicId: taskPublicId,
      key,
      title,
      type: "task",
      priority: 2,
      status: "in_review",
      availableAt: now,
      isReady: false,
      isBlocked: false,
      unresolvedBlockerCount: 0,
      cancelledBlockerCount: 0,
      revision: 2,
      reviewRevision: 1,
      createdBy: systemActor,
      lastEditedBy: submittedBy,
      submittedAt: now,
      needsAttention: false,
      wakeGeneration: 0,
      claimFence: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("taskBodies", {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      taskId,
      description: "",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("taskSubmissions", {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      taskId,
      publicId: submissionPublicId,
      submittedBy,
      reviewRevision: 1,
      summary: "Local fixture pending submission",
      evidence: [{ kind: "note", text: "Awaiting a human cancellation acceptance test." }],
      status: "pending",
      submittedAt: now,
    });
    await ctx.db.patch(usage._id, {
      activeTasks: usage.activeTasks + 1,
      totalTasks: usage.totalTasks + 1,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      taskId,
      taskPublicId,
      taskRevision: 1,
      type: "task.created",
      actor: systemActor,
      command: { kind: "system", jobKind: "repair" },
      payload: { availableAt: now },
      now,
    });
    await appendTaskEvent(ctx, {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      taskId,
      taskPublicId,
      taskRevision: 2,
      type: "task.submitted",
      actor: submittedBy,
      command: { kind: "system", jobKind: "repair" },
      payload: { submissionId: submissionPublicId },
      now,
    });
    return { key, submissionId: submissionPublicId, revision: 2 };
  },
});

export const reconcileWorkOSMembershipsNow = action({
  args: {},
  returns: v.object({
    existing: v.object({ status: reconciliationStatusValidator, processed: v.number() }),
    discovery: v.object({ status: reconciliationStatusValidator, processed: v.number() }),
  }),
  handler: async (ctx): Promise<{
    existing: FixtureReconciliationResult;
    discovery: FixtureReconciliationResult;
  }> => {
    await requireLocalFixtureIdentity(ctx);
    const existing: FixtureReconciliationResult = await ctx.runAction(
      internal.identitySync.reconcileWorkOSMemberships,
      {},
    );
    const discovery: FixtureReconciliationResult = await ctx.runAction(
      internal.identitySync.discoverWorkOSMemberships,
      {},
    );
    return { existing, discovery };
  },
});

export const inspectIdentitySync = query({
  args: {},
  returns: v.object({
    organizations: v.array(
      v.object({
        publicId: v.string(),
        workosOrganizationId: v.optional(v.string()),
        status: v.string(),
        hardDeleted: v.boolean(),
        quarantined: v.boolean(),
      }),
    ),
    memberships: v.array(
      v.object({
        workosMembershipId: v.optional(v.string()),
        workosOrganizationId: v.optional(v.string()),
        workosUserId: v.optional(v.string()),
        role: v.string(),
        status: v.string(),
        hardDeleted: v.boolean(),
        quarantined: v.boolean(),
      }),
    ),
    webhookReceipts: v.array(
      v.object({ providerEventId: v.string(), eventType: v.string(), result: v.string() }),
    ),
    quarantines: v.array(
      v.object({
        resourceKind: v.string(),
        resourceId: v.string(),
        reason: v.string(),
        resolved: v.boolean(),
      }),
    ),
    membershipRetirements: v.array(
      v.object({ workosMembershipId: v.string(), replacementWorkosMembershipId: v.string() }),
    ),
  }),
  handler: async (ctx) => {
    await requireLocalFixtureIdentity(ctx);
    const [organizations, memberships, receipts, quarantines, membershipRetirements] = await Promise.all([
      ctx.db.query("organizations").collect(),
      ctx.db.query("organizationMemberships").collect(),
      ctx.db.query("identityWebhookReceipts").collect(),
      ctx.db.query("identityReconciliationQuarantines").collect(),
      ctx.db.query("workosMembershipRetirements").collect(),
    ]);
    return {
      organizations: organizations.map((organization) => ({
        publicId: organization.publicId,
        ...(organization.workosOrganizationId === undefined
          ? {}
          : { workosOrganizationId: organization.workosOrganizationId }),
        status: organization.status,
        hardDeleted: organization.workosHardDeletedAt !== undefined,
        quarantined: organization.workosQuarantinedAt !== undefined,
      })),
      memberships: await Promise.all(
        memberships.map(async (membership) => {
          const [organization, user] = await Promise.all([
            ctx.db.get(membership.organizationId),
            ctx.db.get(membership.userId),
          ]);
          return {
            ...(membership.workosMembershipId === undefined
              ? {}
              : { workosMembershipId: membership.workosMembershipId }),
            ...(organization?.workosOrganizationId === undefined
              ? {}
              : { workosOrganizationId: organization.workosOrganizationId }),
            ...(user?.workosUserId === undefined
              ? {}
              : { workosUserId: user.workosUserId }),
            role: membership.role,
            status: membership.status,
            hardDeleted: membership.workosHardDeletedAt !== undefined,
            quarantined: membership.workosQuarantinedAt !== undefined,
          };
        }),
      ),
      webhookReceipts: receipts.map((receipt) => ({
        providerEventId: receipt.providerEventId,
        eventType: receipt.eventType,
        result: receipt.result,
      })),
      quarantines: quarantines.map((quarantine) => ({
        resourceKind: quarantine.resourceKind,
        resourceId: quarantine.resourceId,
        reason: quarantine.reason,
        resolved: quarantine.resolvedAt !== undefined,
      })),
      membershipRetirements: membershipRetirements.map((retirement) => ({
        workosMembershipId: retirement.workosMembershipId,
        replacementWorkosMembershipId: retirement.replacementWorkosMembershipId,
      })),
    };
  },
});

export const inspectWorkspaceAgentCounts = query({
  args: { workspaceId: v.string() },
  returns: v.object({ agents: v.number(), grants: v.number(), enrollments: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const [agents, grants, enrollments] = await Promise.all([
      ctx.db
        .query("agents")
        .withIndex("by_organization", (query) => query.eq("organizationId", workspace.organizationId))
        .collect(),
      ctx.db
        .query("agentWorkspaceGrants")
        .withIndex("by_workspace_and_agent", (query) => query.eq("workspaceId", workspace._id))
        .collect(),
      ctx.db
        .query("agentEnrollments")
        .withIndex("by_workspace_and_agent", (query) => query.eq("workspaceId", workspace._id))
        .collect(),
    ]);
    return { agents: agents.length, grants: grants.length, enrollments: enrollments.length };
  },
});

export const inspectWorkspaceHumanAssignments = query({
  args: { workspaceId: v.string() },
  returns: v.object({
    assignments: v.array(
      v.object({ userId: v.string(), roles: v.array(v.string()), status: v.string() }),
    ),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const assignments = await ctx.db
      .query("workspaceMemberships")
      .withIndex("by_workspace_and_user", (query) => query.eq("workspaceId", workspace._id))
      .collect();
    return {
      assignments: await Promise.all(
        assignments.map(async (assignment) => {
          const user = await ctx.db.get(assignment.userId);
          if (user === null) throw new Error("Local fixture workspace user disappeared.");
          return { userId: user.publicId, roles: assignment.roles, status: assignment.status };
        }),
      ),
    };
  },
});

function assertBoundedText(value: string, maximum: number, label: string): void {
  if (value.length === 0 || new TextEncoder().encode(value).length > maximum) {
    throw new Error(`Invalid local fixture ${label}.`);
  }
}

function countRawSecretValues(value: unknown): number {
  if (typeof value === "string") {
    return (
      [...value.matchAll(RAW_TOKEN_PATTERN)].length +
      [...value.matchAll(RAW_BEARER_MATERIAL_PATTERN)].length
    );
  }
  if (value instanceof ArrayBuffer) return 0;
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).reduce<number>(
      (count, item) => count + countRawSecretValues(item),
      0,
    );
  }
  if (typeof value !== "object" || value === null) return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (count, item) => count + countRawSecretValues(item),
    0,
  );
}

function countPlaintextInteractionResponseFields(value: unknown): number {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).reduce<number>(
      (count, item) => count + countPlaintextInteractionResponseFields(item),
      0,
    );
  }
  if (typeof value !== "object" || value === null || value instanceof ArrayBuffer) return 0;
  return Object.entries(value as Record<string, unknown>).reduce<number>(
    (count, [key, item]) =>
      count +
      (PLAINTEXT_INTERACTION_RESPONSE_KEYS.has(key) ? 1 : 0) +
      countPlaintextInteractionResponseFields(item),
    0,
  );
}

const seedResultValidator = v.object({
  organizationId: v.string(),
  workspaceId: v.string(),
  agentId: v.string(),
  enrollmentLocator: v.string(),
  enrollmentExpiresAt: v.number(),
});

export const seedAgentEnrollment = mutation({
  args: {
    organizationId: v.string(),
    organizationName: v.string(),
    workspaceId: v.string(),
    workspaceSlug: v.string(),
    workspaceName: v.string(),
    taskKeyPrefix: v.string(),
    agentId: v.string(),
    agentName: v.string(),
    scopes: v.array(agentScopeValidator),
    enrollmentLocator: v.string(),
    enrollmentDigest: v.string(),
    enrollmentExpiresAt: v.number(),
  },
  returns: seedResultValidator,
  handler: async (ctx, args) => {
    const identity = await requireLocalFixtureIdentity(ctx);
    const now = Date.now();
    assertBoundedText(args.organizationId, 128, "organization ID");
    assertBoundedText(args.organizationName, 160, "organization name");
    assertBoundedText(args.workspaceId, 128, "workspace ID");
    assertBoundedText(args.workspaceName, 160, "workspace name");
    assertBoundedText(args.agentId, 128, "agent ID");
    assertBoundedText(args.agentName, 120, "agent name");
    if (
      !SLUG_PATTERN.test(args.workspaceSlug) ||
      !TASK_KEY_PREFIX_PATTERN.test(args.taskKeyPrefix) ||
      !LOCATOR_PATTERN.test(args.enrollmentLocator) ||
      args.scopes.length === 0 ||
      new Set(args.scopes).size !== args.scopes.length ||
      !Number.isSafeInteger(args.enrollmentExpiresAt)
    ) {
      throw new Error("Invalid local fixture input.");
    }
    const enrollmentDigest = digestArrayBuffer(args.enrollmentDigest);
    if (
      enrollmentDigest === null ||
      env.TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION === undefined ||
      env.TASKCTL_ENROLLMENT_PEPPER_CURRENT === undefined ||
      decodeBase64Url32(env.TASKCTL_ENROLLMENT_PEPPER_CURRENT) === null
    ) {
      throw new Error("Local enrollment HMAC configuration is invalid.");
    }

    let user = await ctx.db
      .query("users")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", identity.subject))
      .unique();
    if (user === null) {
      const userId = await ctx.db.insert("users", {
        publicId: identity.subject,
        name: "Local fixture operator",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      user = await ctx.db.get(userId);
    }
    if (user === null || user.status !== "active") throw new Error("Local fixture user is unavailable.");

    let organization = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.organizationId))
      .unique();
    if (organization === null) {
      const organizationId = await ctx.db.insert("organizations", {
        publicId: args.organizationId,
        name: args.organizationName,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      organization = await ctx.db.get(organizationId);
    }
    if (organization === null || organization.name !== args.organizationName) {
      throw new Error("Local fixture organization conflicts with existing data.");
    }
    const membership = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_organization_and_user", (builder) =>
        builder.eq("organizationId", organization._id).eq("userId", user._id),
      )
      .unique();
    if (membership === null) {
      await ctx.db.insert("organizationMemberships", {
        organizationId: organization._id,
        userId: user._id,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(membership._id, { role: "owner", status: "active", updatedAt: now });
    }

    let workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) {
      const workspaceId = await ctx.db.insert("workspaces", {
        organizationId: organization._id,
        publicId: args.workspaceId,
        slug: args.workspaceSlug,
        name: args.workspaceName,
        taskKeyPrefix: args.taskKeyPrefix,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      workspace = await ctx.db.get(workspaceId);
    }
    if (
      workspace === null ||
      workspace.organizationId !== organization._id ||
      workspace.slug !== args.workspaceSlug ||
      workspace.taskKeyPrefix !== args.taskKeyPrefix
    ) {
      throw new Error("Local fixture workspace conflicts with existing data.");
    }

    const usage = await ctx.db
      .query("workspaceUsage")
      .withIndex("by_workspace", (builder) => builder.eq("workspaceId", workspace._id))
      .unique();
    if (usage === null) {
      await ctx.db.insert("workspaceUsage", {
        organizationId: organization._id,
        workspaceId: workspace._id,
        activeTasks: 0,
        totalTasks: 0,
        activeAgents: 0,
        updatedAt: now,
      });
    }

    let agent = await ctx.db
      .query("agents")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.agentId))
      .unique();
    if (agent === null) {
      const agentId = await ctx.db.insert("agents", {
        organizationId: organization._id,
        createdByUserId: user._id,
        publicId: args.agentId,
        name: args.agentName,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      agent = await ctx.db.get(agentId);
    }
    if (agent === null || agent.organizationId !== organization._id || agent.name !== args.agentName) {
      throw new Error("Local fixture agent conflicts with existing data.");
    }

    let grant = await ctx.db
      .query("agentWorkspaceGrants")
      .withIndex("by_workspace_and_agent", (builder) =>
        builder.eq("workspaceId", workspace._id).eq("agentId", agent._id),
      )
      .unique();
    const createdGrant = grant === null;
    if (grant === null) {
      const grantId = await ctx.db.insert("agentWorkspaceGrants", {
        organizationId: organization._id,
        workspaceId: workspace._id,
        agentId: agent._id,
        status: "active",
        scopes: args.scopes,
        createdAt: now,
        updatedAt: now,
      });
      grant = await ctx.db.get(grantId);
    } else {
      await ctx.db.patch(grant._id, { status: "active", scopes: args.scopes, updatedAt: now });
      grant = await ctx.db.get(grant._id);
    }
    if (grant === null) throw new Error("Local fixture grant could not be created.");
    const currentUsage = await ctx.db
      .query("workspaceUsage")
      .withIndex("by_workspace", (builder) => builder.eq("workspaceId", workspace._id))
      .unique();
    if (currentUsage === null) throw new Error("Local fixture workspace usage disappeared.");
    if (createdGrant) {
      await ctx.db.patch(currentUsage._id, {
        activeAgents: currentUsage.activeAgents + 1,
        updatedAt: now,
      });
    }

    const existingEnrollment = await ctx.db
      .query("agentEnrollments")
      .withIndex("by_locator", (builder) => builder.eq("locator", args.enrollmentLocator))
      .unique();
    if (existingEnrollment !== null) {
      if (
        existingEnrollment.agentId !== agent._id ||
        existingEnrollment.workspaceId !== workspace._id
      ) {
        throw new Error("Local fixture enrollment locator conflicts with existing data.");
      }
    } else {
      await ctx.db.insert("agentEnrollments", {
        locator: args.enrollmentLocator,
        organizationId: organization._id,
        workspaceId: workspace._id,
        agentId: agent._id,
        grantId: grant._id,
        createdByUserId: user._id,
        verifierDigest: enrollmentDigest,
        pepperVersion: env.TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION,
        scopes: args.scopes,
        status: "active",
        expiresAt: args.enrollmentExpiresAt,
        createdAt: now,
      });
      await appendSecurityEvent(ctx, {
        organizationId: organization._id,
        workspaceId: workspace._id,
        agentId: agent._id,
        type: "agent.enrollment_created",
        actor: { kind: "human", userId: user.publicId },
        command: {
          kind: "client",
          idempotencyKey: randomUuidV7(now),
          requestId: randomRequestId(),
        },
        payload: { enrollmentLocator: args.enrollmentLocator },
        now,
      });
    }
    return {
      organizationId: organization.publicId,
      workspaceId: workspace.publicId,
      agentId: agent.publicId,
      enrollmentLocator: args.enrollmentLocator,
      enrollmentExpiresAt: args.enrollmentExpiresAt,
    };
  },
});

export const revokeCredential = mutation({
  args: { credentialLocator: v.string() },
  returns: v.object({ revoked: v.boolean() }),
  handler: async (ctx, args) => {
    const identity = await requireLocalFixtureIdentity(ctx);
    const credential = await ctx.db
      .query("agentCredentials")
      .withIndex("by_locator", (builder) => builder.eq("locator", args.credentialLocator))
      .unique();
    if (credential === null) return { revoked: false };
    const now = Date.now();
    await ctx.db.patch(credential._id, { status: "revoked", revokedAt: now });
    const sessions = await ctx.db
      .query("agentSessions")
      .withIndex("by_credential_and_status", (builder) =>
        builder.eq("credentialId", credential._id).eq("status", "active"),
      )
      .collect();
    for (const session of sessions) {
      await ctx.db.patch(session._id, { status: "revoked", revokedAt: now });
    }
    const agent = await ctx.db.get(credential.agentId);
    if (agent === null) throw new Error("Local fixture credential has no agent.");
    await appendSecurityEvent(ctx, {
      organizationId: credential.organizationId,
      workspaceId: credential.workspaceId,
      agentId: agent._id,
      type: "agent.credential_revoked",
      actor: { kind: "human", userId: identity.subject },
      command: {
        kind: "client",
        idempotencyKey: randomUuidV7(now),
        requestId: randomRequestId(),
      },
      payload: { credentialId: credential.locator },
      now,
    });
    return { revoked: true };
  },
});

const inspectResultValidator = v.object({
  workspaceId: v.string(),
  rawSecretLikeValueCount: v.number(),
  counts: v.object({
    enrollments: v.number(),
    credentials: v.number(),
    sessions: v.number(),
    tasks: v.number(),
    claims: v.number(),
    wakes: v.number(),
    taskEvents: v.number(),
    securityEvents: v.number(),
    receipts: v.number(),
    submissions: v.number(),
    cancellations: v.number(),
  }),
  enrollments: v.array(
    v.object({ locator: v.string(), status: v.string(), digestEncoding: v.literal("bytes"), digestByteLength: v.number() }),
  ),
  credentials: v.array(
    v.object({ locator: v.string(), status: v.string(), digestEncoding: v.literal("bytes"), digestByteLength: v.number() }),
  ),
  sessions: v.array(v.object({ id: v.string(), status: v.string(), credentialLocator: v.string() })),
  tasks: v.array(taskViewValidator),
  claims: v.array(
    v.object({ id: v.string(), taskId: v.string(), state: v.string(), fence: v.number(), leaseGeneration: v.number(), leaseUntil: v.number() }),
  ),
  wakes: v.array(v.object({ taskId: v.string(), state: v.string(), generation: v.number(), expectedAvailableAt: v.number() })),
  taskEvents: v.array(v.object({ type: v.string(), taskId: v.string(), taskRevision: v.number(), actor: persistedEventActorValidator, command: eventCommandValidator })),
  securityEvents: v.array(v.object({ type: v.string(), actor: persistedEventActorValidator, command: eventCommandValidator })),
  receipts: v.array(v.object({ operation: v.string(), idempotencyKey: v.string(), requestId: v.string() })),
  submissions: v.array(
    v.object({
      id: v.string(),
      taskId: v.string(),
      status: v.string(),
      submittedByAgentId: v.string(),
      reviewRevision: v.number(),
      summary: v.string(),
      reviewReason: v.optional(v.string()),
      cancellationReason: v.optional(v.string()),
    }),
  ),
  cancellations: v.array(
    v.object({ taskId: v.string(), reason: v.string(), cancelledAt: v.number() }),
  ),
});

export const inspectWorkspace = query({
  args: {
    workspaceId: v.string(),
    omitTaskTitlePrefix: v.optional(v.string()),
  },
  returns: inspectResultValidator,
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const [
      enrollments,
      credentials,
      sessions,
      tasks,
      claims,
      wakes,
      taskEvents,
      securityEvents,
      receipts,
      submissions,
      cancellations,
    ] =
      await Promise.all([
        ctx.db.query("agentEnrollments").withIndex("by_workspace_and_agent", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("agentCredentials").withIndex("by_workspace_and_agent", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("agentSessions").withIndex("by_workspace_and_agent", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("tasks").withIndex("by_workspace_status", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("taskClaims").withIndex("by_workspace_and_task", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("taskWakes").withIndex("by_workspace_and_task", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("taskEvents").withIndex("by_workspace_and_created", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("securityEvents").withIndex("by_workspace_and_created", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("commandReceipts").withIndex("by_workspace_and_expiry", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("taskSubmissions").withIndex("by_workspace_task_submitted", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
        ctx.db.query("taskCancellations").withIndex("by_workspace_task_cancelled", (builder) => builder.eq("workspaceId", workspace._id)).collect(),
      ]);
    const allRows = [
      enrollments,
      credentials,
      sessions,
      tasks,
      claims,
      wakes,
      taskEvents,
      securityEvents,
      receipts,
      submissions,
      cancellations,
    ];
    const taskPublicIdById = new Map(tasks.map((task) => [String(task._id), task.publicId]));
    const taskKeyById = new Map(tasks.map((task) => [String(task._id), task.key]));
    const credentialLocatorById = new Map(credentials.map((credential) => [String(credential._id), credential.locator]));
    const omittedTaskTitlePrefix = args.omitTaskTitlePrefix;
    const visibleTasks =
      omittedTaskTitlePrefix === undefined
        ? tasks
        : tasks.filter((task) => !task.title.startsWith(omittedTaskTitlePrefix));
    return {
      workspaceId: workspace.publicId,
      rawSecretLikeValueCount: countRawSecretValues(allRows),
      counts: {
        enrollments: enrollments.length,
        credentials: credentials.length,
        sessions: sessions.length,
        tasks: tasks.length,
        claims: claims.length,
        wakes: wakes.length,
        taskEvents: taskEvents.length,
        securityEvents: securityEvents.length,
        receipts: receipts.length,
        submissions: submissions.length,
        cancellations: cancellations.length,
      },
      enrollments: enrollments.map((enrollment) => ({
        locator: enrollment.locator,
        status: enrollment.status,
        digestEncoding: "bytes" as const,
        digestByteLength: enrollment.verifierDigest.byteLength,
      })),
      credentials: credentials.map((credential) => ({
        locator: credential.locator,
        status: credential.status,
        digestEncoding: "bytes" as const,
        digestByteLength: credential.verifierDigest.byteLength,
      })),
      sessions: sessions.map((session) => ({
        id: session.publicId,
        status: session.status,
        credentialLocator: credentialLocatorById.get(String(session.credentialId)) ?? "missing",
      })),
      tasks: visibleTasks.map(taskView),
      claims: claims.map((claim) => ({
        id: claim.publicId,
        taskId: taskPublicIdById.get(String(claim.taskId)) ?? "missing",
        state: claim.state,
        fence: claim.fence,
        leaseGeneration: claim.leaseGeneration,
        leaseUntil: claim.leaseUntil,
      })),
      wakes: wakes.map((wake) => ({
        taskId: taskKeyById.get(String(wake.taskId)) ?? "missing",
        state: wake.state,
        generation: wake.generation,
        expectedAvailableAt: wake.expectedAvailableAt,
      })),
      taskEvents: taskEvents.map((event) => ({
        type: event.type,
        taskId: event.taskPublicId,
        taskRevision: event.taskRevision,
        actor: event.actor,
        command: event.command,
      })),
      securityEvents: securityEvents.map((event) => ({
        type: event.type,
        actor: event.actor,
        command: event.command,
      })),
      receipts: receipts.map((receipt) => ({
        operation: receipt.operation,
        idempotencyKey: receipt.idempotencyKey,
        requestId: receipt.requestId,
      })),
      submissions: submissions.map((submission) => ({
        id: submission.publicId,
        taskId: taskKeyById.get(String(submission.taskId)) ?? "missing",
        status: submission.status,
        submittedByAgentId: submission.submittedBy.agentId,
        reviewRevision: submission.reviewRevision,
        summary: submission.summary,
        ...(submission.status === "rejected" ? { reviewReason: submission.reviewReason } : {}),
        ...(submission.status === "cancelled"
          ? { cancellationReason: submission.cancellationReason }
          : {}),
      })),
      cancellations: cancellations.map((cancellation) => ({
        taskId: taskKeyById.get(String(cancellation.taskId)) ?? "missing",
        reason: cancellation.reason,
        cancelledAt: cancellation.cancelledAt,
      })),
    };
  },
});

export const shortenClaimDeadline = mutation({
  args: {
    workspaceId: v.string(),
    key: v.string(),
    delayMs: v.number(),
    scheduleExpiry: v.boolean(),
  },
  returns: v.object({
    taskKey: v.string(),
    fence: v.number(),
    leaseGeneration: v.number(),
    leaseUntil: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    if (!Number.isInteger(args.delayMs) || args.delayMs < 25 || args.delayMs > 60_000) {
      throw new Error("Local fixture claim delay must be between 25ms and 60s.");
    }
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_and_key", (builder) =>
        builder.eq("workspaceId", workspace._id).eq("key", args.key),
      )
      .unique();
    if (task === null || task.status !== "in_progress" || task.currentClaim === undefined) {
      throw new Error("Local fixture active claim not found.");
    }
    const claim = await ctx.db.get(task.currentClaim.claimId);
    if (claim === null || claim.state !== "active") throw new Error("Local fixture claim projection is invalid.");
    const now = Date.now();
    const leaseGeneration = task.currentClaim.leaseGeneration + 1;
    const leaseUntil = now + (args.scheduleExpiry ? args.delayMs : 25);
    const revision = task.revision + 1;
    await ctx.db.patch(claim._id, { leaseGeneration, leaseUntil, updatedAt: now });
    await ctx.db.patch(task._id, {
      currentClaim: { ...task.currentClaim, leaseGeneration, leaseUntil },
      revision,
      updatedAt: now,
    });
    if (args.scheduleExpiry) {
      await ctx.scheduler.runAt(leaseUntil, internal.schedules.expireClaim, {
        taskId: task._id,
        claimId: claim._id,
        fence: claim.fence,
        leaseGeneration,
        expectedDeadline: leaseUntil,
      });
    }
    await appendTaskEvent(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: revision,
      type: "task.updated",
      actor: { kind: "system", jobKind: "repair", sourceId: "local-fixture" },
      command: { kind: "system", jobKind: "repair" },
      payload: { fields: ["currentClaim.leaseUntil"] },
      now,
    });
    return { taskKey: task.key, fence: claim.fence, leaseGeneration, leaseUntil };
  },
});

export const corruptTaskReadiness = mutation({
  args: { workspaceId: v.string(), key: v.string() },
  returns: v.object({ corrupted: v.boolean() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_and_key", (builder) =>
        builder.eq("workspaceId", workspace._id).eq("key", args.key),
      )
      .unique();
    if (task === null || (task.status !== "open" && task.status !== "in_progress")) {
      throw new Error("Local fixture active task not found.");
    }
    await ctx.db.patch(task._id, {
      unresolvedBlockerCount: 0,
      cancelledBlockerCount: 0,
      isBlocked: false,
      isReady: true,
      readySince: Date.now(),
    });
    return { corrupted: true };
  },
});

export const corruptClaimTuple = mutation({
  args: { workspaceId: v.string(), key: v.string() },
  returns: v.object({ corrupted: v.boolean() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_and_key", (builder) =>
        builder.eq("workspaceId", workspace._id).eq("key", args.key),
      )
      .unique();
    if (task === null || task.status !== "in_progress" || task.currentClaim === undefined) {
      throw new Error("Local fixture active claim not found.");
    }
    const claim = await ctx.db.get(task.currentClaim.claimId);
    if (claim === null || claim.state !== "active") {
      throw new Error("Local fixture compact claim not found.");
    }
    await ctx.db.patch(claim._id, { publicId: randomPublicId("clm"), updatedAt: Date.now() });
    return { corrupted: true };
  },
});

export const corruptClaimPointerAcrossTenants = mutation({
  args: {
    sourceWorkspaceId: v.string(),
    sourceKey: v.string(),
    targetWorkspaceId: v.string(),
    targetKey: v.string(),
  },
  returns: v.object({ corrupted: v.boolean(), targetClaimId: v.string() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const [sourceWorkspace, targetWorkspace] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", args.sourceWorkspaceId))
        .unique(),
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", args.targetWorkspaceId))
        .unique(),
    ]);
    if (
      sourceWorkspace === null ||
      targetWorkspace === null ||
      sourceWorkspace.organizationId === targetWorkspace.organizationId
    ) {
      throw new Error("Local fixture requires two distinct tenant workspaces.");
    }
    const [sourceTask, targetTask] = await Promise.all([
      ctx.db
        .query("tasks")
        .withIndex("by_workspace_and_key", (builder) =>
          builder.eq("workspaceId", sourceWorkspace._id).eq("key", args.sourceKey),
        )
        .unique(),
      ctx.db
        .query("tasks")
        .withIndex("by_workspace_and_key", (builder) =>
          builder.eq("workspaceId", targetWorkspace._id).eq("key", args.targetKey),
        )
        .unique(),
    ]);
    if (
      sourceTask?.status !== "in_progress" ||
      sourceTask.currentClaim === undefined ||
      targetTask?.status !== "in_progress" ||
      targetTask.currentClaim === undefined
    ) {
      throw new Error("Local fixture requires two active claimed tasks.");
    }
    const targetClaim = await ctx.db.get(targetTask.currentClaim.claimId);
    if (targetClaim === null || targetClaim.state !== "active") {
      throw new Error("Local fixture target claim is unavailable.");
    }
    await ctx.db.patch(sourceTask._id, {
      currentClaim: { ...sourceTask.currentClaim, claimId: targetClaim._id },
      updatedAt: Date.now(),
    });
    return { corrupted: true, targetClaimId: targetClaim.publicId };
  },
});

export const corruptReviewProjection = mutation({
  args: {
    workspaceId: v.string(),
    key: v.string(),
    mode: v.union(
      v.literal("revision_mismatch"),
      v.literal("zero_pending"),
      v.literal("multiple_pending"),
    ),
  },
  returns: v.object({ revision: v.number(), reviewRevision: v.number(), pending: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_and_key", (builder) =>
        builder.eq("workspaceId", workspace._id).eq("key", args.key),
      )
      .unique();
    if (task === null || task.status !== "in_review") {
      throw new Error("Local fixture review task not found.");
    }
    const pending = await ctx.db
      .query("taskSubmissions")
      .withIndex("by_workspace_task_status_submitted", (builder) =>
        builder
          .eq("workspaceId", workspace._id)
          .eq("taskId", task._id)
          .eq("status", "pending"),
      )
      .collect();
    if (pending.length !== 1 || pending[0] === undefined) {
      throw new Error("Local fixture requires exactly one pending submission.");
    }
    const submission = pending[0];
    const now = Date.now();
    const actor = {
      kind: "system" as const,
      jobKind: "repair" as const,
      sourceId: "local-review-corruption-fixture",
    };
    if (args.mode === "revision_mismatch") {
      await ctx.db.patch(task._id, {
        title: `${task.title} changed after submission`,
        revision: task.revision + 1,
        reviewRevision: task.reviewRevision + 1,
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
        payload: { fields: ["title"] },
        now,
      });
    } else if (args.mode === "zero_pending") {
      await ctx.db.replace(submission._id, {
        organizationId: submission.organizationId,
        workspaceId: submission.workspaceId,
        taskId: submission.taskId,
        publicId: submission.publicId,
        submittedBy: submission.submittedBy,
        reviewRevision: submission.reviewRevision,
        summary: submission.summary,
        evidence: submission.evidence,
        submittedAt: submission.submittedAt,
        status: "cancelled",
        cancelledBy: actor,
        cancelledAt: now,
        cancellationReason: "Cancelled by local zero-pending corruption fixture.",
      });
    } else {
      await ctx.db.insert("taskSubmissions", {
        organizationId: submission.organizationId,
        workspaceId: submission.workspaceId,
        taskId: submission.taskId,
        publicId: randomPublicId("sub"),
        submittedBy: submission.submittedBy,
        reviewRevision: submission.reviewRevision,
        summary: "Conflicting local pending submission",
        evidence: [{ kind: "note", text: "Inserted only to prove repair convergence." }],
        status: "pending",
        submittedAt: now + 1,
      });
    }
    const updated = await ctx.db.get(task._id);
    if (updated === null) throw new Error("Local review corruption task disappeared.");
    const remaining = await ctx.db
      .query("taskSubmissions")
      .withIndex("by_workspace_task_status_submitted", (builder) =>
        builder
          .eq("workspaceId", workspace._id)
          .eq("taskId", task._id)
          .eq("status", "pending"),
      )
      .collect();
    return {
      revision: updated.revision,
      reviewRevision: updated.reviewRevision,
      pending: remaining.length,
    };
  },
});

export const seedSweepBacklog = mutation({
  args: { workspaceId: v.string(), count: v.number() },
  returns: v.object({ seeded: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    if (!Number.isSafeInteger(args.count) || args.count < 65 || args.count > 80) {
      throw new Error("Local sweep backlog must cross exactly one bounded page.");
    }
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const usage = await ctx.db
      .query("workspaceUsage")
      .withIndex("by_workspace", (builder) => builder.eq("workspaceId", workspace._id))
      .unique();
    if (
      usage === null ||
      usage.activeTasks + args.count > WORKSPACE_ACTIVE_TASK_LIMIT ||
      usage.totalTasks + args.count > WORKSPACE_TOTAL_TASK_LIMIT
    ) {
      throw new Error("Local fixture workspace usage is unavailable.");
    }
    const now = Date.now();
    const dueAt = now - 1_000;
    const actor = {
      kind: "system" as const,
      jobKind: "repair" as const,
      sourceId: "local-sweep-backlog-fixture",
    };
    const grant = await ctx.db
      .query("agentWorkspaceGrants")
      .withIndex("by_workspace_status_and_agent", (builder) =>
        builder.eq("workspaceId", workspace._id).eq("status", "active"),
      )
      .first();
    const agent = grant === null ? null : await ctx.db.get(grant.agentId);
    if (agent === null || agent.status !== "active") {
      throw new Error("Local fixture active agent not found.");
    }
    for (let ordinal = 0; ordinal < args.count; ordinal += 1) {
      const taskPublicId = randomPublicId("tsk");
      const taskId = await ctx.db.insert("tasks", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        publicId: taskPublicId,
        key: `${workspace.taskKeyPrefix}-${randomCrockford(7)}`,
        title: `Sweep backlog ${ordinal}`,
        type: "chore",
        priority: ordinal % 5,
        status: "in_progress",
        availableAt: dueAt,
        isReady: false,
        isBlocked: false,
        unresolvedBlockerCount: 0,
        cancelledBlockerCount: 0,
        revision: 1,
        reviewRevision: 1,
        createdBy: actor,
        lastEditedBy: actor,
        needsAttention: false,
        wakeGeneration: 1,
        claimFence: 1,
        createdAt: now,
        updatedAt: now,
      });
      const claimPublicId = randomPublicId("clm");
      const claimId = await ctx.db.insert("taskClaims", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        taskId,
        publicId: claimPublicId,
        agentId: agent._id,
        agentPublicId: agent.publicId,
        state: "active",
        fence: 1,
        leaseGeneration: 1,
        leaseUntil: dueAt,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(taskId, {
        currentClaim: {
          claimId,
          publicId: claimPublicId,
          agentId: agent._id,
          agentPublicId: agent.publicId,
          fence: 1,
          leaseGeneration: 1,
          leaseUntil: dueAt,
        },
      });
      await ctx.db.insert("taskBodies", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        taskId,
        description: "",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("taskWakes", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        taskId,
        generation: 1,
        expectedAvailableAt: dueAt,
        state: "pending",
        createdAt: now,
      });
      await appendTaskEvent(ctx, {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        taskId,
        taskPublicId,
        taskRevision: 1,
        type: "task.created",
        actor,
        command: { kind: "system", jobKind: "repair" },
        payload: { availableAt: dueAt },
        now,
      });
    }
    await ctx.db.patch(usage._id, {
      activeTasks: usage.activeTasks + args.count,
      totalTasks: usage.totalTasks + args.count,
      updatedAt: now,
    });
    return { seeded: args.count };
  },
});

interface LocalSweepResult {
  readonly scheduled: number;
  readonly hasMore: boolean;
}

export const runTaskSweepsNow = action({
  args: {},
  returns: v.object({
    claims: v.object({ scheduled: v.number(), hasMore: v.boolean() }),
    wakes: v.object({ scheduled: v.number(), hasMore: v.boolean() }),
  }),
  handler: async (ctx): Promise<{
    readonly claims: LocalSweepResult;
    readonly wakes: LocalSweepResult;
  }> => {
    await requireLocalFixtureIdentity(ctx);
    const claims: LocalSweepResult = await ctx.runMutation(
      internal.schedules.sweepOverdueClaims,
      {},
    );
    const wakes: LocalSweepResult = await ctx.runMutation(
      internal.schedules.sweepDueWakes,
      {},
    );
    return { claims, wakes };
  },
});

export const seedBlockingDependents = mutation({
  args: {
    workspaceId: v.string(),
    blockerKey: v.string(),
    ordinalStart: v.number(),
    count: v.number(),
  },
  returns: v.object({ created: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    if (
      !Number.isSafeInteger(args.ordinalStart) ||
      args.ordinalStart < 0 ||
      !Number.isSafeInteger(args.count) ||
      args.count < 1 ||
      args.count > 50
    ) {
      throw new Error("Local fixture dependent batch is invalid.");
    }
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const blocker = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_and_key", (builder) =>
        builder.eq("workspaceId", workspace._id).eq("key", args.blockerKey),
      )
      .unique();
    if (blocker === null || blocker.status === "done" || blocker.status === "cancelled") {
      throw new Error("Local fixture active blocker not found.");
    }
    const usage = await ctx.db
      .query("workspaceUsage")
      .withIndex("by_workspace", (builder) => builder.eq("workspaceId", workspace._id))
      .unique();
    if (
      usage === null ||
      usage.activeTasks + args.count > WORKSPACE_ACTIVE_TASK_LIMIT ||
      usage.totalTasks + args.count > WORKSPACE_TOTAL_TASK_LIMIT
    ) {
      throw new Error("Local fixture workspace usage is unavailable.");
    }
    const now = Date.now();
    const actor = {
      kind: "system" as const,
      jobKind: "repair" as const,
      sourceId: "local-fanout-fixture",
    };
    for (let offset = 0; offset < args.count; offset += 1) {
      const ordinal = args.ordinalStart + offset;
      let key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await ctx.db
          .query("tasks")
          .withIndex("by_workspace_and_key", (builder) =>
            builder.eq("workspaceId", workspace._id).eq("key", key),
          )
          .unique();
        if (existing === null) break;
        key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
      }
      const taskPublicId = randomPublicId("tsk");
      const taskId = await ctx.db.insert("tasks", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        publicId: taskPublicId,
        key,
        title: `Fanout dependent ${ordinal}`,
        type: "task",
        priority: ordinal % 5,
        status: "open",
        availableAt: now,
        isReady: false,
        isBlocked: true,
        unresolvedBlockerCount: 1,
        cancelledBlockerCount: 0,
        revision: 1,
        reviewRevision: 1,
        createdBy: actor,
        lastEditedBy: actor,
        needsAttention: false,
        wakeGeneration: 0,
        claimFence: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("taskBodies", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        taskId,
        description: "",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("taskDependencies", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        blockerTaskId: blocker._id,
        blockedTaskId: taskId,
        kind: "blocks",
        createdBy: actor,
        createdAt: now + ordinal,
      });
      await appendTaskEvent(ctx, {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        taskId,
        taskPublicId,
        taskRevision: 1,
        type: "task.created",
        actor,
        command: { kind: "system", jobKind: "repair" },
        payload: { availableAt: now },
        now,
      });
    }
    await ctx.db.patch(usage._id, {
      activeTasks: usage.activeTasks + args.count,
      totalTasks: usage.totalTasks + args.count,
      updatedAt: now,
    });
    return { created: args.count };
  },
});

export const inspectBlockingDependents = query({
  args: { workspaceId: v.string(), blockerKey: v.string() },
  returns: v.object({ total: v.number(), ready: v.number(), unresolved: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const blocker = await ctx.db
      .query("tasks")
      .withIndex("by_workspace_and_key", (builder) =>
        builder.eq("workspaceId", workspace._id).eq("key", args.blockerKey),
      )
      .unique();
    if (blocker === null) throw new Error("Local fixture blocker not found.");
    const edges = await ctx.db
      .query("taskDependencies")
      .withIndex("by_workspace_blocker_created", (builder) =>
        builder.eq("workspaceId", workspace._id).eq("blockerTaskId", blocker._id),
      )
      .take(501);
    let ready = 0;
    let unresolved = 0;
    for (const edge of edges) {
      const task = await ctx.db.get(edge.blockedTaskId);
      if (task === null || task.workspaceId !== workspace._id) continue;
      if (task.isReady) ready += 1;
      unresolved += task.unresolvedBlockerCount;
    }
    return { total: edges.length, ready, unresolved };
  },
});

export const seedReadyTaskBatch = mutation({
  args: { workspaceId: v.string(), ordinalStart: v.number(), count: v.number() },
  returns: v.object({ created: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    if (
      !Number.isSafeInteger(args.ordinalStart) ||
      args.ordinalStart < 0 ||
      !Number.isSafeInteger(args.count) ||
      args.count < 1 ||
      args.count > 100
    ) {
      throw new Error("Local fixture ready-task batch is invalid.");
    }
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local fixture workspace not found.");
    const usage = await ctx.db
      .query("workspaceUsage")
      .withIndex("by_workspace", (builder) => builder.eq("workspaceId", workspace._id))
      .unique();
    if (
      usage === null ||
      usage.activeTasks + args.count > WORKSPACE_ACTIVE_TASK_LIMIT ||
      usage.totalTasks + args.count > WORKSPACE_TOTAL_TASK_LIMIT
    ) {
      throw new Error("Local fixture workspace usage is unavailable.");
    }
    const now = Date.now();
    const actor = {
      kind: "system" as const,
      jobKind: "repair" as const,
      sourceId: "local-ready-load-fixture",
    };
    for (let offset = 0; offset < args.count; offset += 1) {
      const ordinal = args.ordinalStart + offset;
      let key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await ctx.db
          .query("tasks")
          .withIndex("by_workspace_and_key", (builder) =>
            builder.eq("workspaceId", workspace._id).eq("key", key),
          )
          .unique();
        if (existing === null) break;
        key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
      }
      const taskId = await ctx.db.insert("tasks", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        publicId: randomPublicId("tsk"),
        key,
        title: `Ready load task ${ordinal}`,
        type: "task",
        priority: ordinal % 5,
        status: "open",
        availableAt: now,
        isReady: true,
        isBlocked: false,
        unresolvedBlockerCount: 0,
        cancelledBlockerCount: 0,
        revision: 1,
        reviewRevision: 1,
        createdBy: actor,
        lastEditedBy: actor,
        readySince: now + ordinal,
        needsAttention: false,
        wakeGeneration: 0,
        claimFence: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("taskBodies", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        taskId,
        description: "",
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(usage._id, {
      activeTasks: usage.activeTasks + args.count,
      totalTasks: usage.totalTasks + args.count,
      updatedAt: now,
    });
    return { created: args.count };
  },
});

const LOCAL_REPOSITORY_ID_PATTERN = /^repo_[0-9A-HJKMNP-TV-Z]{26}$/u;
type LocalDispatchActivePhase =
  | "leased"
  | "provisioning"
  | "starting"
  | "running"
  | "waiting"
  | "cancel_requested";

function isLocalDispatchActivePhase(phase: string): phase is LocalDispatchActivePhase {
  return phase === "leased" ||
    phase === "provisioning" ||
    phase === "starting" ||
    phase === "running" ||
    phase === "waiting" ||
    phase === "cancel_requested";
}

export const seedQueuedDispatch = mutation({
  args: {
    workspaceId: v.string(),
    repositoryId: v.string(),
    title: v.string(),
    availableAt: v.optional(v.number()),
  },
  returns: v.object({
    workspaceId: v.string(),
    taskId: v.string(),
    taskKey: v.string(),
    repositoryId: v.string(),
    runId: v.string(),
  }),
  handler: async (ctx, args) => {
    const identity = await requireLocalFixtureIdentity(ctx);
    const title = args.title.trim();
    if (
      title.length === 0 ||
      new TextEncoder().encode(title).length > 512 ||
      !LOCAL_REPOSITORY_ID_PATTERN.test(args.repositoryId)
    ) {
      throw new Error("Local dispatch seed input is invalid.");
    }
    const [workspace, user] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("users")
        .withIndex("by_public_id", (query) => query.eq("publicId", identity.subject))
        .unique(),
    ]);
    if (workspace === null || workspace.status !== "active" || user === null || user.status !== "active") {
      throw new Error("Local dispatch seed workspace is unavailable.");
    }
    const usage = await ctx.db
      .query("workspaceUsage")
      .withIndex("by_workspace", (query) => query.eq("workspaceId", workspace._id))
      .unique();
    if (
      usage === null ||
      usage.activeTasks >= WORKSPACE_ACTIVE_TASK_LIMIT ||
      usage.totalTasks >= WORKSPACE_TOTAL_TASK_LIMIT
    ) {
      throw new Error("Local dispatch seed workspace usage is unavailable.");
    }
    const now = Date.now();
    const availableAt = args.availableAt ?? now;
    if (
      !Number.isSafeInteger(availableAt) ||
      (args.availableAt !== undefined &&
        (availableAt <= now || availableAt > now + 60_000))
    ) {
      throw new Error("Local dispatch defer deadline is invalid.");
    }
    const isReady = availableAt <= now;
    let repository = await ctx.db
      .query("workspaceRepositories")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.repositoryId))
      .unique();
    if (repository === null) {
      const repositoryDocId = await ctx.db.insert("workspaceRepositories", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        publicId: args.repositoryId,
        name: `Local dispatch ${args.repositoryId.slice(-8)}`,
        provider: "other",
        url: `https://example.invalid/${args.repositoryId.toLowerCase()}`,
        status: "active",
        createdByUserId: user._id,
        createdAt: now,
        updatedAt: now,
      });
      repository = await ctx.db.get(repositoryDocId);
    }
    if (
      repository === null ||
      repository.status !== "active" ||
      repository.organizationId !== workspace.organizationId ||
      repository.workspaceId !== workspace._id
    ) {
      throw new Error("Local dispatch seed repository conflicts with its tenant.");
    }
    let key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await ctx.db
        .query("tasks")
        .withIndex("by_workspace_and_key", (query) =>
          query.eq("workspaceId", workspace._id).eq("key", key),
        )
        .unique();
      if (existing === null) break;
      key = `${workspace.taskKeyPrefix}-${randomCrockford(7)}`;
    }
    const actor = {
      kind: "system" as const,
      jobKind: "repair" as const,
      sourceId: "local-dispatch-fixture",
    };
    const taskPublicId = randomPublicId("tsk");
    const taskId = await ctx.db.insert("tasks", {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      publicId: taskPublicId,
      key,
      title,
      type: "task",
      priority: 2,
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
      ...(isReady ? { readySince: now } : {}),
      needsAttention: false,
      wakeGeneration: isReady ? 0 : 1,
      claimFence: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("taskBodies", {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      taskId,
      description: `Deterministic local dispatch evidence for ${title}.`,
      createdAt: now,
      updatedAt: now,
    });
    const runId = `run_${randomUuidV7(now).toLowerCase()}`;
    await ctx.db.insert("taskDispatches", {
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      taskId,
      repositoryId: repository._id,
      publicId: runId,
      taskKey: key,
      repositoryPublicId: repository.publicId,
      acceptedThroughSequence: 0,
      queuedByUserId: user._id,
      queuedTaskRevision: 1,
      queuedClaimFence: 0,
      phase: "queued",
      desiredState: "run",
      queuedAt: now,
      candidateOrderAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (!isReady) {
      const wakeId = await ctx.db.insert("taskWakes", {
        organizationId: workspace.organizationId,
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
      organizationId: workspace.organizationId,
      workspaceId: workspace._id,
      taskId,
      taskPublicId,
      taskRevision: 1,
      type: "task.created",
      actor,
      command: { kind: "system", jobKind: "repair" },
      payload: { availableAt },
      now,
    });
    return {
      workspaceId: workspace.publicId,
      taskId: taskPublicId,
      taskKey: key,
      repositoryId: repository.publicId,
      runId,
    };
  },
});

export const inspectQueuedDispatchReadiness = query({
  args: { workspaceId: v.string(), runId: v.string() },
  returns: v.object({
    runId: v.string(),
    phase: v.literal("queued"),
    availableAt: v.number(),
    taskRevision: v.number(),
    queuedTaskRevision: v.number(),
    taskIsReady: v.boolean(),
    taskReadyNow: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const [workspace, dispatch] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("taskDispatches")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
        .unique(),
    ]);
    if (
      workspace === null ||
      dispatch === null ||
      dispatch.organizationId !== workspace.organizationId ||
      dispatch.workspaceId !== workspace._id ||
      dispatch.phase !== "queued"
    ) throw new Error("Local queued dispatch readiness target was not found.");
    const task = await ctx.db.get(dispatch.taskId);
    if (
      task === null ||
      task.organizationId !== dispatch.organizationId ||
      task.workspaceId !== dispatch.workspaceId ||
      task.key !== dispatch.taskKey
    ) throw new Error("Local queued dispatch readiness projection is invalid.");
    return {
      runId: dispatch.publicId,
      phase: dispatch.phase,
      availableAt: task.availableAt,
      taskRevision: task.revision,
      queuedTaskRevision: dispatch.queuedTaskRevision,
      taskIsReady: task.isReady,
      taskReadyNow: isTaskReady(task, Date.now()),
    };
  },
});

export const setDispatchTaskBodyPresence = mutation({
  args: { workspaceId: v.string(), runId: v.string(), present: v.boolean() },
  returns: v.object({ present: v.boolean(), bodyCount: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const [workspace, dispatch] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("taskDispatches")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
        .unique(),
    ]);
    if (
      workspace === null ||
      dispatch === null ||
      dispatch.organizationId !== workspace.organizationId ||
      dispatch.workspaceId !== workspace._id ||
      dispatch.phase !== "queued"
    ) throw new Error("Local dispatch body target was not found.");
    const bodies = await ctx.db
      .query("taskBodies")
      .withIndex("by_workspace_and_task", (query) =>
        query.eq("workspaceId", workspace._id).eq("taskId", dispatch.taskId),
      )
      .take(2);
    if (
      bodies.length > 1 ||
      bodies.some((body) =>
        body.organizationId !== dispatch.organizationId ||
        body.workspaceId !== dispatch.workspaceId ||
        body.taskId !== dispatch.taskId)
    ) throw new Error("Local dispatch body projection is invalid.");
    const body = bodies[0];
    if (args.present) {
      if (body === undefined) {
        const now = Date.now();
        await ctx.db.insert("taskBodies", {
          organizationId: dispatch.organizationId,
          workspaceId: dispatch.workspaceId,
          taskId: dispatch.taskId,
          description: "Restored local dispatch rollback evidence.",
          createdAt: now,
          updatedAt: now,
        });
      }
    } else if (body !== undefined) {
      await ctx.db.delete(body._id);
    }
    return { present: args.present, bodyCount: args.present ? 1 : 0 };
  },
});

export const shortenDispatchLease = mutation({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    delayMs: v.number(),
    scheduleExpiry: v.boolean(),
  },
  returns: v.object({
    workspaceId: v.string(),
    runId: v.string(),
    phase: v.union(
      v.literal("leased"),
      v.literal("provisioning"),
      v.literal("starting"),
      v.literal("running"),
      v.literal("waiting"),
      v.literal("cancel_requested"),
    ),
    leaseGeneration: v.number(),
    leaseUntil: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    if (!Number.isSafeInteger(args.delayMs) || args.delayMs < 25 || args.delayMs > 5_000) {
      throw new Error("Local dispatch lease delay must be between 25ms and 5s.");
    }
    const [workspace, dispatch] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("taskDispatches")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
        .unique(),
    ]);
    if (
      workspace === null ||
      dispatch === null ||
      dispatch.organizationId !== workspace.organizationId ||
      dispatch.workspaceId !== workspace._id ||
      !("runnerId" in dispatch) ||
      !isLocalDispatchActivePhase(dispatch.phase)
    ) {
      throw new Error("Local active dispatch lease was not found.");
    }
    const leaseUntil = Date.now() + args.delayMs;
    await ctx.db.patch(dispatch._id, { leaseUntil, updatedAt: Date.now() });
    if (args.scheduleExpiry) {
      await ctx.scheduler.runAt(leaseUntil, internal.schedules.expireDispatch, {
        dispatchId: dispatch._id,
        runnerId: dispatch.runnerId,
        bootId: dispatch.bootId,
        bootGeneration: dispatch.bootGeneration,
        taskClaimId: dispatch.taskClaimId,
        claimFence: dispatch.claimFence,
        leaseGeneration: dispatch.leaseGeneration,
        expectedDeadline: leaseUntil,
      });
    }
    return {
      workspaceId: workspace.publicId,
      runId: dispatch.publicId,
      phase: dispatch.phase,
      leaseGeneration: dispatch.leaseGeneration,
      leaseUntil,
    };
  },
});

export const ageSubmittedDispatchClaim = mutation({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    ageMs: v.number(),
  },
  returns: v.object({ workspaceId: v.string(), runId: v.string(), endedAt: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    if (!Number.isSafeInteger(args.ageMs) || args.ageMs < 90_001 || args.ageMs > 3_600_000) {
      throw new Error("Local submitted-claim age must be over 90 seconds and at most one hour.");
    }
    const [workspace, dispatch] = await Promise.all([
      ctx.db.query("workspaces").withIndex("by_public_id", (query) =>
        query.eq("publicId", args.workspaceId)).unique(),
      ctx.db.query("taskDispatches").withIndex("by_public_id", (query) =>
        query.eq("publicId", args.runId)).unique(),
    ]);
    if (
      workspace === null ||
      dispatch === null ||
      dispatch.organizationId !== workspace.organizationId ||
      dispatch.workspaceId !== workspace._id ||
      !("taskClaimId" in dispatch)
    ) {
      throw new Error("Local submitted dispatch was not found.");
    }
    const [task, claim] = await Promise.all([
      ctx.db.get(dispatch.taskId),
      ctx.db.get(dispatch.taskClaimId),
    ]);
    if (!submittedTaskClaimMatchesDispatch(dispatch, task, claim)) {
      throw new Error("Local submitted dispatch tuple is not reconcilable.");
    }
    const endedAt = Date.now() - args.ageMs;
    await ctx.db.patch(dispatch.taskClaimId, { endedAt });
    return { workspaceId: workspace.publicId, runId: dispatch.publicId, endedAt };
  },
});

export const shortenRunnerAuthorityLease = mutation({
  args: { workspaceId: v.string(), delayMs: v.number() },
  returns: v.object({
    workspaceId: v.string(),
    runnerId: v.string(),
    installationId: v.string(),
    generation: v.number(),
    leaseUntil: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    if (!Number.isSafeInteger(args.delayMs) || args.delayMs < 25 || args.delayMs > 5_000) {
      throw new Error("Local runner authority delay must be between 25ms and 5s.");
    }
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local runner authority workspace was not found.");
    const authorities = await ctx.db
      .query("dispatchRunnerAuthorities")
      .withIndex("by_workspace", (query) => query.eq("workspaceId", workspace._id))
      .take(2);
    const authority = authorities.length === 1 ? authorities[0] : undefined;
    if (
      authority === undefined ||
      authority.organizationId !== workspace.organizationId ||
      authority.workspaceId !== workspace._id
    ) {
      throw new Error("Local runner authority projection is unavailable.");
    }
    const runner = await ctx.db.get(authority.runnerId);
    if (
      runner === null ||
      runner.organizationId !== workspace.organizationId ||
      runner.workspaceId !== workspace._id ||
      runner.publicId !== authority.runnerPublicId ||
      runner.installationId !== authority.installationId
    ) {
      throw new Error("Local runner authority lost its runner tuple.");
    }
    const now = Date.now();
    const leaseUntil = now + args.delayMs;
    await Promise.all([
      ctx.db.patch(authority._id, { leaseUntil, updatedAt: now }),
      ctx.db.patch(runner._id, { leaseUntil, updatedAt: now }),
    ]);
    return {
      workspaceId: workspace.publicId,
      runnerId: runner.publicId,
      installationId: runner.installationId,
      generation: authority.generation,
      leaseUntil,
    };
  },
});

export const clearRunnerHeartbeatResponse = mutation({
  args: { workspaceId: v.string(), runnerId: v.string() },
  returns: v.object({
    workspaceId: v.string(),
    runnerId: v.string(),
    cleared: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const [workspace, runner] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("dispatchRunners")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runnerId))
        .unique(),
    ]);
    if (
      workspace === null ||
      runner === null ||
      runner.organizationId !== workspace.organizationId ||
      runner.workspaceId !== workspace._id
    ) throw new Error("Local runner heartbeat migration target was not found.");
    const cleared = runner.lastHeartbeatResponse !== undefined;
    await ctx.db.patch(runner._id, { lastHeartbeatResponse: undefined });
    return { workspaceId: workspace.publicId, runnerId: runner.publicId, cleared };
  },
});

export const duplicateRunnerCapability = mutation({
  args: { workspaceId: v.string(), runnerId: v.string() },
  returns: v.object({
    workspaceId: v.string(),
    runnerId: v.string(),
    repositoryId: v.string(),
    duplicateCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const [workspace, runner] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("dispatchRunners")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runnerId))
        .unique(),
    ]);
    if (
      workspace === null ||
      runner === null ||
      runner.organizationId !== workspace.organizationId ||
      runner.workspaceId !== workspace._id
    ) throw new Error("Local runner capability target was not found.");
    const capabilities = await ctx.db
      .query("dispatchRunnerRepositories")
      .withIndex("by_runner", (query) => query.eq("runnerId", runner._id))
      .take(MAX_RUNNER_REPOSITORIES + 1);
    const source = capabilities[0];
    if (source === undefined || capabilities.length > MAX_RUNNER_REPOSITORIES) {
      throw new Error("Local runner capability source is unavailable.");
    }
    const now = Date.now();
    await ctx.db.insert("dispatchRunnerRepositories", {
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      runnerId: source.runnerId,
      repositoryId: source.repositoryId,
      createdAt: now,
      updatedAt: now,
    });
    return {
      workspaceId: workspace.publicId,
      runnerId: runner.publicId,
      repositoryId: String(source.repositoryId),
      duplicateCount: 2,
    };
  },
});

export const repairRunnerCapabilities = mutation({
  args: { workspaceId: v.string(), runnerId: v.string() },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const [workspace, runner] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("dispatchRunners")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runnerId))
        .unique(),
    ]);
    if (
      workspace === null ||
      runner === null ||
      runner.organizationId !== workspace.organizationId ||
      runner.workspaceId !== workspace._id
    ) throw new Error("Local runner capability repair target was not found.");
    const rows = await ctx.db
      .query("dispatchRunnerRepositories")
      .withIndex("by_runner", (query) => query.eq("runnerId", runner._id))
      .take(MAX_RUNNER_REPOSITORIES + 1);
    if (rows.length > MAX_RUNNER_REPOSITORIES) {
      throw new Error("Local runner capability repair exceeded its bound.");
    }
    const retainedRepositoryIds = new Set<string>();
    let deleted = 0;
    for (const row of rows) {
      if (!retainedRepositoryIds.has(row.repositoryId)) {
        retainedRepositoryIds.add(row.repositoryId);
        continue;
      }
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    return { deleted };
  },
});

export const seedSealedDispatchInteractionResponse = mutation({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    interactionId: v.string(),
    sealedResponse: sealedRunInteractionResponseValidator,
  },
  returns: v.object({
    workspaceId: v.string(),
    runId: v.string(),
    interactionId: v.string(),
    responseRevision: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const sealedResponse = sealedRunInteractionResponseSchema.safeParse(args.sealedResponse);
    if (!sealedResponse.success || sealedResponse.data.workspaceId !== args.workspaceId) {
      throw new Error("Local sealed interaction response is invalid.");
    }
    const [workspace, dispatch, interaction] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("taskDispatches")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
        .unique(),
      ctx.db
        .query("taskRunInteractions")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.interactionId))
        .unique(),
    ]);
    const now = Date.now();
    if (
      workspace === null ||
      dispatch === null ||
      interaction === null ||
      !("runnerId" in dispatch) ||
      dispatch.organizationId !== workspace.organizationId ||
      dispatch.workspaceId !== workspace._id ||
      dispatch.phase !== "running" ||
      dispatch.desiredState !== "run" ||
      dispatch.leaseUntil <= now ||
      interaction.organizationId !== dispatch.organizationId ||
      interaction.workspaceId !== dispatch.workspaceId ||
      interaction.dispatchId !== dispatch._id ||
      interaction.runnerId !== dispatch.runnerId ||
      interaction.runnerPublicId !== dispatch.runnerPublicId ||
      interaction.bootId !== dispatch.bootId ||
      interaction.bootGeneration !== dispatch.bootGeneration ||
      interaction.claimPublicId !== dispatch.taskClaimPublicId ||
      interaction.claimFence !== dispatch.claimFence ||
      interaction.state !== "pending" ||
      interaction.expiresAt <= now
    ) {
      throw new Error("Local dispatch interaction is not answerable.");
    }
    const request = runInteractionRequestSchema.safeParse(interaction.request);
    if (
      !request.success ||
      request.data.reply.keyId !== sealedResponse.data.keyId ||
      request.data.reply.runnerId !== dispatch.runnerPublicId ||
      request.data.reply.bootId !== dispatch.bootId ||
      request.data.reply.bootGeneration !== dispatch.bootGeneration ||
      request.data.reply.claimId !== dispatch.taskClaimPublicId ||
      request.data.reply.claimFence !== dispatch.claimFence
    ) {
      throw new Error("Local sealed response lost its interaction authority binding.");
    }
    const existingResponses = await ctx.db
      .query("taskRunInteractionResponses")
      .withIndex("by_interaction", (query) => query.eq("interactionId", interaction._id))
      .take(2);
    if (existingResponses.length !== 0) {
      throw new Error("Local dispatch interaction already has a response.");
    }
    const responseRevision = 1;
    await ctx.db.insert("taskRunInteractionResponses", {
      organizationId: dispatch.organizationId,
      workspaceId: dispatch.workspaceId,
      dispatchId: dispatch._id,
      interactionId: interaction._id,
      responseRevision,
      sealedResponse: {
        version: sealedResponse.data.version,
        algorithm: sealedResponse.data.algorithm,
        keyId: sealedResponse.data.keyId,
        workspaceId: sealedResponse.data.workspaceId,
        ephemeralPublicKey: sealedResponse.data.ephemeralPublicKey,
        nonce: sealedResponse.data.nonce,
        ciphertext: sealedResponse.data.ciphertext,
      },
      createdAt: now,
    });
    await ctx.db.patch(interaction._id, {
      state: "answered",
      responseRevision,
      respondedByUserId: dispatch.queuedByUserId,
      respondedAt: now,
      updatedAt: now,
    });
    return {
      workspaceId: workspace.publicId,
      runId: dispatch.publicId,
      interactionId: interaction.publicId,
      responseRevision,
    };
  },
});

export const inspectDispatchInteraction = query({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    interactionId: v.string(),
  },
  returns: v.object({
    workspaceId: v.string(),
    runId: v.string(),
    interactionId: v.string(),
    state: runInteractionStateValidator,
    responseRevision: v.optional(v.number()),
    responseRowCount: v.number(),
    plaintextResponseFieldCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const [workspace, dispatch, interaction] = await Promise.all([
      ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
        .unique(),
      ctx.db
        .query("taskDispatches")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
        .unique(),
      ctx.db
        .query("taskRunInteractions")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.interactionId))
        .unique(),
    ]);
    if (
      workspace === null ||
      dispatch === null ||
      interaction === null ||
      dispatch.organizationId !== workspace.organizationId ||
      dispatch.workspaceId !== workspace._id ||
      interaction.organizationId !== dispatch.organizationId ||
      interaction.workspaceId !== dispatch.workspaceId ||
      interaction.dispatchId !== dispatch._id
    ) {
      throw new Error("Local dispatch interaction inspection target was not found.");
    }
    const responses = await ctx.db
      .query("taskRunInteractionResponses")
      .withIndex("by_interaction", (query) => query.eq("interactionId", interaction._id))
      .take(2);
    if (
      responses.length > 1 ||
      responses.some(
        (response) =>
          response.organizationId !== dispatch.organizationId ||
          response.workspaceId !== dispatch.workspaceId ||
          response.dispatchId !== dispatch._id ||
          response.interactionId !== interaction._id ||
          response.responseRevision !== interaction.responseRevision,
      )
    ) {
      throw new Error("Local sealed interaction response projection is invalid.");
    }
    return {
      workspaceId: workspace.publicId,
      runId: dispatch.publicId,
      interactionId: interaction.publicId,
      state: interaction.state,
      ...(interaction.responseRevision === undefined
        ? {}
        : { responseRevision: interaction.responseRevision }),
      responseRowCount: responses.length,
      plaintextResponseFieldCount: responses.reduce(
        (count, response) => count + countPlaintextInteractionResponseFields(response),
        0,
      ),
    };
  },
});

export const inspectDispatchWorkspace = query({
  args: { workspaceId: v.string() },
  returns: v.object({
    workspaceId: v.string(),
    authority: v.union(
      v.null(),
      v.object({
        runnerId: v.string(),
        installationId: v.string(),
        generation: v.number(),
        leaseUntil: v.number(),
      }),
    ),
    repositories: v.array(
      v.object({ id: v.string(), status: v.union(v.literal("active"), v.literal("removed")) }),
    ),
    runners: v.array(
      v.object({
        id: v.string(),
        bootId: v.string(),
        bootGeneration: v.number(),
        sequence: v.number(),
        reportedState: v.union(
          v.literal("starting"),
          v.literal("ready"),
          v.literal("busy"),
          v.literal("degraded"),
        ),
        leaseUntil: v.number(),
        repositoryIds: v.array(v.string()),
      }),
    ),
    dispatches: v.array(
      v.object({
        runId: v.string(),
        taskId: v.string(),
        taskKey: v.string(),
        repositoryId: v.string(),
        phase: v.union(
          v.literal("queued"),
          v.literal("leased"),
          v.literal("provisioning"),
          v.literal("starting"),
          v.literal("running"),
          v.literal("waiting"),
          v.literal("submitted"),
          v.literal("failed"),
          v.literal("cancel_requested"),
          v.literal("cancelled"),
          v.literal("ambiguous"),
        ),
        desiredState: v.union(v.literal("run"), v.literal("stop")),
        acceptedThroughSequence: v.number(),
        runnerId: v.optional(v.string()),
        claimId: v.optional(v.string()),
        claimFence: v.optional(v.number()),
        leaseGeneration: v.optional(v.number()),
        leaseUntil: v.optional(v.number()),
      }),
    ),
    events: v.array(
      v.object({
        runId: v.string(),
        id: v.string(),
        sequence: v.number(),
        kind: v.string(),
      }),
    ),
    claims: v.array(
      v.object({
        id: v.string(),
        taskId: v.string(),
        state: v.union(
          v.literal("active"),
          v.literal("released"),
          v.literal("expired"),
          v.literal("submitted"),
          v.literal("replaced"),
        ),
        fence: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    await requireLocalFixtureIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.workspaceId))
      .unique();
    if (workspace === null) throw new Error("Local dispatch inspection workspace not found.");
    const [repositories, runners, authorities, dispatches] = await Promise.all([
      ctx.db
        .query("workspaceRepositories")
        .withIndex("by_workspace_status_created", (query) => query.eq("workspaceId", workspace._id))
        .take(101),
      ctx.db
        .query("dispatchRunners")
        .withIndex("by_workspace_and_updated", (query) => query.eq("workspaceId", workspace._id))
        .take(101),
      ctx.db
        .query("dispatchRunnerAuthorities")
        .withIndex("by_workspace", (query) => query.eq("workspaceId", workspace._id))
        .take(2),
      ctx.db
        .query("taskDispatches")
        .withIndex("by_workspace_and_updated", (query) => query.eq("workspaceId", workspace._id))
        .take(101),
    ]);
    if (
      repositories.length > 100 ||
      runners.length > 100 ||
      authorities.length > 1 ||
      dispatches.length > 100
    ) {
      throw new Error("Local dispatch inspection exceeded its bounded row limit.");
    }
    const repositoryById = new Map(repositories.map((row) => [String(row._id), row]));
    const runnerById = new Map(runners.map((row) => [String(row._id), row]));
    const taskRows = await Promise.all(dispatches.map(async (row) => await ctx.db.get(row.taskId)));
    const taskById = new Map(
      taskRows.flatMap((row) => row === null ? [] : [[String(row._id), row] as const]),
    );
    const capabilities = await Promise.all(
      runners.map(async (runner) =>
        await ctx.db
          .query("dispatchRunnerRepositories")
          .withIndex("by_runner", (query) => query.eq("runnerId", runner._id))
          .take(129),
      ),
    );
    const events = (
      await Promise.all(
        dispatches.map(async (dispatch) =>
          await ctx.db
            .query("taskRunEvents")
            .withIndex("by_dispatch_and_sequence", (query) => query.eq("dispatchId", dispatch._id))
            .take(101),
        ),
      )
    ).flat();
    const claimRows = (
      await Promise.all(
        dispatches.map(async (dispatch) =>
          await ctx.db
            .query("taskClaims")
            .withIndex("by_workspace_and_task", (query) =>
              query.eq("workspaceId", workspace._id).eq("taskId", dispatch.taskId),
            )
            .take(101),
        ),
      )
    ).flat();
    const claims = [...new Map(
      claimRows.map((claim) => [String(claim._id), claim] as const),
    ).values()];
    if (
      capabilities.some((rows) => rows.length > 128) ||
      claimRows.length > dispatches.length * 100 ||
      events.length > dispatches.length * 100 ||
      repositories.some(
        (row) => row.organizationId !== workspace.organizationId || row.workspaceId !== workspace._id,
      ) ||
      runners.some(
        (row) => row.organizationId !== workspace.organizationId || row.workspaceId !== workspace._id,
      ) ||
      authorities.some(
        (row) =>
          row.organizationId !== workspace.organizationId ||
          row.workspaceId !== workspace._id ||
          runnerById.get(String(row.runnerId))?.publicId !== row.runnerPublicId ||
          runnerById.get(String(row.runnerId))?.installationId !== row.installationId,
      ) ||
      dispatches.some(
        (row) =>
          row.organizationId !== workspace.organizationId ||
          row.workspaceId !== workspace._id ||
          taskById.get(String(row.taskId))?.workspaceId !== workspace._id ||
          repositoryById.get(String(row.repositoryId))?.workspaceId !== workspace._id ||
          ("runnerId" in row && runnerById.get(String(row.runnerId))?.workspaceId !== workspace._id),
      ) ||
      capabilities.flat().some(
        (row) =>
          row.organizationId !== workspace.organizationId ||
          row.workspaceId !== workspace._id ||
          runnerById.get(String(row.runnerId))?.workspaceId !== workspace._id ||
          repositoryById.get(String(row.repositoryId))?.workspaceId !== workspace._id,
      ) ||
      events.some(
        (row) => row.organizationId !== workspace.organizationId || row.workspaceId !== workspace._id,
      ) ||
      claims.some(
        (row) => row.organizationId !== workspace.organizationId || row.workspaceId !== workspace._id,
      )
    ) {
      throw new Error("Local dispatch inspection found a cross-tenant projection.");
    }
    return {
      workspaceId: workspace.publicId,
      authority: authorities[0] === undefined
        ? null
        : {
            runnerId: authorities[0].runnerPublicId,
            installationId: authorities[0].installationId,
            generation: authorities[0].generation,
            leaseUntil: authorities[0].leaseUntil,
          },
      repositories: repositories.map((repository) => ({
        id: repository.publicId,
        status: repository.status,
      })),
      runners: runners.map((runner, index) => ({
        id: runner.publicId,
        bootId: runner.bootId,
        bootGeneration: runner.bootGeneration,
        sequence: runner.heartbeatSequence,
        reportedState: runner.reportedState,
        leaseUntil: runner.leaseUntil,
        repositoryIds: (capabilities[index] ?? []).map((capability) => {
          const repository = repositoryById.get(String(capability.repositoryId));
          if (repository === undefined) throw new Error("Local runner capability lost its repository.");
          return repository.publicId;
        }),
      })),
      dispatches: dispatches.map((dispatch) => {
        const task = taskById.get(String(dispatch.taskId));
        const repository = repositoryById.get(String(dispatch.repositoryId));
        if (task === undefined || repository === undefined) {
          throw new Error("Local dispatch projection lost a task or repository.");
        }
        return {
          runId: dispatch.publicId,
          taskId: task.publicId,
          taskKey: task.key,
          repositoryId: repository.publicId,
          phase: dispatch.phase,
          desiredState: dispatch.desiredState,
          acceptedThroughSequence: dispatch.acceptedThroughSequence,
          ...("runnerId" in dispatch
            ? {
                runnerId: dispatch.runnerPublicId,
                claimId: dispatch.taskClaimPublicId,
                claimFence: dispatch.claimFence,
                leaseGeneration: dispatch.leaseGeneration,
                leaseUntil: dispatch.leaseUntil,
              }
            : {}),
        };
      }),
      events: events.map((event) => {
        const dispatch = dispatches.find((candidate) => candidate._id === event.dispatchId);
        if (dispatch === undefined) throw new Error("Local run event lost its dispatch.");
        return {
          runId: dispatch.publicId,
          id: event.publicId,
          sequence: event.sequence,
          kind: event.kind,
        };
      }),
      claims: claims.map((claim) => {
        const task = taskById.get(String(claim.taskId));
        if (task === undefined) throw new Error("Local task claim lost its task.");
        return { id: claim.publicId, taskId: task.publicId, state: claim.state, fence: claim.fence };
      }),
    };
  },
});
