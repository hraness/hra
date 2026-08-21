import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalAction, internalQuery } from "./_generated/server";
import {
  RATE_LIMIT_WINDOW_MS,
  perShardRateLimit,
  rateLimitRouteClasses,
  type RateLimitRouteClass,
  type RateLimitSubjectKind,
} from "./rateLimitPolicy";
import {
  WORKSPACE_ACTIVE_TASK_LIMIT,
  WORKSPACE_TOTAL_TASK_LIMIT,
} from "./workGraphLaws";
import {
  WORKSPACE_INTEGRITY_INVERSE_INDEXES,
  WORKSPACE_INTEGRITY_LIMITS,
  buildWorkspaceIntegrityPage,
  buildWorkspaceIntegrityScan,
  workspaceIntegrityPageValidator,
  workspaceIntegrityScanValidator,
  type WorkspaceIntegrityPage,
} from "./workspaceIntegrity";

export const OPERATOR_DIAGNOSTIC_LIMITS = {
  indexedRows: 128,
  scannedRows: 256,
  workspaces: 8,
  pendingReviewsPerWorkspace: 8,
  samples: 8,
} as const;

export const OPERATOR_DIAGNOSTIC_THRESHOLDS = {
  schedulerStuckAfterMs: 5 * 60 * 1_000,
  reviewAgedAfterMs: 24 * 60 * 60 * 1_000,
  credentialRenewalWindowMs: 14 * 24 * 60 * 60 * 1_000,
  credentialUnusedAfterMs: 30 * 24 * 60 * 60 * 1_000,
  quotaWarningPercent: 80,
} as const;

const WORKSPACE_ACTIVE_AGENT_LIMIT = 100;

interface BoundedRows<Row> {
  readonly rows: readonly Row[];
  readonly limit: number;
  readonly truncated: boolean;
}

export interface OperatorDiagnosticsInput {
  readonly now: number;
  readonly rateLimitBuckets: BoundedRows<{
    readonly routeClass: RateLimitRouteClass;
    readonly subjectKind: RateLimitSubjectKind;
    readonly windowStartedAt: number;
    readonly count: number;
  }>;
  readonly overdueClaims: BoundedRows<{
    readonly leaseUntil: number;
  }>;
  readonly claimSamples: readonly {
    readonly workspacePublicId: string;
    readonly taskKey: string;
    readonly agentPublicId: string;
    readonly leaseUntil: number;
  }[];
  readonly sessions: BoundedRows<{
    readonly status: "active" | "expired" | "revoked";
    readonly idleExpiresAt: number;
    readonly credentialResolution: "linked" | "missing" | "mismatch";
    readonly credentialStatus?: "active" | "revoked";
    readonly credentialExpiresAt?: number;
  }>;
  readonly projectionRepairs: BoundedRows<{
    readonly kind: "task_readiness" | "task_claim" | "task_review";
    readonly status: "pending" | "completed" | "stale";
    readonly updatedAt: number;
  }>;
  readonly repairSamples: readonly {
    readonly workspacePublicId: string;
    readonly taskKey: string;
    readonly kind: "task_readiness" | "task_claim" | "task_review";
    readonly generation: number;
    readonly expectedRevision: number;
    readonly updatedAt: number;
  }[];
  readonly reviewWorkspaces: BoundedRows<{
    readonly workspacePublicId: string;
    readonly workspaceSlug: string;
    readonly submissions: BoundedRows<{ readonly submittedAt: number }>;
  }>;
  readonly reviewSamples: readonly {
    readonly workspacePublicId: string;
    readonly taskKey: string;
    readonly submittedAt: number;
  }[];
  readonly credentials: BoundedRows<{
    readonly status: "active" | "revoked";
    readonly expiresAt: number;
    readonly lastUsedAt: number;
  }>;
  readonly dueWakes: BoundedRows<{
    readonly state: "pending" | "completed" | "stale";
    readonly expectedAvailableAt: number;
  }>;
  readonly wakeSamples: readonly {
    readonly workspacePublicId: string;
    readonly taskKey: string;
    readonly generation: number;
    readonly expectedAvailableAt: number;
  }[];
  readonly workspaceUsage: BoundedRows<{
    readonly workspacePublicId?: string;
    readonly activeTasks: number;
    readonly totalTasks: number;
    readonly activeAgents: number;
  }>;
}

function coverage<Row>(source: BoundedRows<Row>) {
  return {
    scanned: source.rows.length,
    limit: source.limit,
    truncated: source.truncated,
  };
}

function ageMs(now: number, timestamp: number): number {
  return Math.max(0, now - timestamp);
}

function oldestAgeMs(now: number, timestamps: readonly number[]): number | null {
  if (timestamps.length === 0) return null;
  return ageMs(now, Math.min(...timestamps));
}

function percent(value: number, limit: number): number {
  return Math.round((value / limit) * 100);
}

/**
 * Pure aggregation boundary. Inputs intentionally omit locators, subject keys,
 * digests, receipt bodies, provider IDs, and all bearer material.
 */
export function buildOperatorDiagnostics(input: OperatorDiagnosticsInput) {
  const currentWindowStartedAt =
    Math.floor(input.now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const currentRateBuckets = input.rateLimitBuckets.rows.filter(
    (row) => row.windowStartedAt === currentWindowStartedAt,
  );
  const byRoute = rateLimitRouteClasses.map((routeClass) => {
    const rows = currentRateBuckets.filter((row) => row.routeClass === routeClass);
    const utilization = rows.map((row) => {
      const limit = perShardRateLimit(row.routeClass, row.subjectKind);
      return limit === null ? 0 : percent(row.count, limit);
    });
    return {
      routeClass,
      requestsObserved: rows.reduce((sum, row) => sum + row.count, 0),
      saturatedBuckets: rows.filter((row) => {
        const limit = perShardRateLimit(row.routeClass, row.subjectKind);
        return limit !== null && row.count >= limit;
      }).length,
      maxShardUtilizationPercent: utilization.length === 0 ? 0 : Math.max(...utilization),
    };
  });
  const authRouteClasses = new Set<RateLimitRouteClass>([
    "password_sign_in",
    "password_sign_up",
    "refresh_auth",
    "agent_auth_failure",
    "enrollment_auth_failure",
  ]);
  const authRoutes = byRoute.filter((row) => authRouteClasses.has(row.routeClass));

  const claims = input.overdueClaims.rows.filter((row) => row.leaseUntil <= input.now);
  const claimSamples = input.claimSamples
    .filter((sample) => sample.leaseUntil <= input.now)
    .sort((left, right) => left.leaseUntil - right.leaseUntil)
    .slice(0, OPERATOR_DIAGNOSTIC_LIMITS.samples)
    .map((sample) => ({
      workspacePublicId: sample.workspacePublicId,
      taskKey: sample.taskKey,
      agentPublicId: sample.agentPublicId,
      overdueMs: ageMs(input.now, sample.leaseUntil),
    }));

  const activeSessions = input.sessions.rows.filter((row) => row.status === "active");
  const expiredActiveSessions = activeSessions.filter((row) => row.idleExpiresAt <= input.now);

  const pendingRepairs = input.projectionRepairs.rows.filter(
    (row) => row.status === "pending",
  );
  const repairKinds = ["task_readiness", "task_claim", "task_review"] as const;
  const repairsByKind = repairKinds.map((kind) => ({
    kind,
    pending: pendingRepairs.filter((row) => row.kind === kind).length,
  }));
  const repairSamples = [...input.repairSamples]
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(0, OPERATOR_DIAGNOSTIC_LIMITS.samples)
    .map((sample) => ({
      workspacePublicId: sample.workspacePublicId,
      taskKey: sample.taskKey,
      kind: sample.kind,
      generation: sample.generation,
      expectedRevision: sample.expectedRevision,
      pendingAgeMs: ageMs(input.now, sample.updatedAt),
    }));

  const reviewBacklogs = input.reviewWorkspaces.rows
    .map((workspace) => {
      const pendingTimestamps = workspace.submissions.rows.map((row) => row.submittedAt);
      return {
        workspacePublicId: workspace.workspacePublicId,
        workspaceSlug: workspace.workspaceSlug,
        pending: pendingTimestamps.length,
        aged: pendingTimestamps.filter(
          (submittedAt) =>
            ageMs(input.now, submittedAt) >=
            OPERATOR_DIAGNOSTIC_THRESHOLDS.reviewAgedAfterMs,
        ).length,
        oldestPendingAgeMs: oldestAgeMs(input.now, pendingTimestamps),
        truncated: workspace.submissions.truncated,
      };
    })
    .filter((workspace) => workspace.pending > 0)
    .sort((left, right) => {
      const leftAge = left.oldestPendingAgeMs ?? -1;
      const rightAge = right.oldestPendingAgeMs ?? -1;
      return rightAge - leftAge;
    })
    .slice(0, OPERATOR_DIAGNOSTIC_LIMITS.samples);
  const allObservedReviews = input.reviewWorkspaces.rows.flatMap((workspace) =>
    workspace.submissions.rows.map((row) => row.submittedAt),
  );
  const reviewSamples = [...input.reviewSamples]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .slice(0, OPERATOR_DIAGNOSTIC_LIMITS.samples)
    .map((sample) => ({
      workspacePublicId: sample.workspacePublicId,
      taskKey: sample.taskKey,
      pendingAgeMs: ageMs(input.now, sample.submittedAt),
    }));

  const activeCredentials = input.credentials.rows.filter((row) => row.status === "active");
  const dueWakes = input.dueWakes.rows.filter(
    (row) => row.state === "pending" && row.expectedAvailableAt <= input.now,
  );
  const wakeSamples = input.wakeSamples
    .filter((sample) => sample.expectedAvailableAt <= input.now)
    .sort((left, right) => left.expectedAvailableAt - right.expectedAvailableAt)
    .slice(0, OPERATOR_DIAGNOSTIC_LIMITS.samples)
    .map((sample) => ({
      workspacePublicId: sample.workspacePublicId,
      taskKey: sample.taskKey,
      generation: sample.generation,
      overdueMs: ageMs(input.now, sample.expectedAvailableAt),
    }));

  const quotaRows = input.workspaceUsage.rows.map((row) => ({
    ...row,
    activeTaskPercent: percent(row.activeTasks, WORKSPACE_ACTIVE_TASK_LIMIT),
    totalTaskPercent: percent(row.totalTasks, WORKSPACE_TOTAL_TASK_LIMIT),
    activeAgentPercent: percent(row.activeAgents, WORKSPACE_ACTIVE_AGENT_LIMIT),
  }));
  const quotaSamples = quotaRows
    .filter((row) => row.workspacePublicId !== undefined)
    .sort(
      (left, right) =>
        Math.max(
          right.activeTaskPercent,
          right.totalTaskPercent,
          right.activeAgentPercent,
        ) -
        Math.max(left.activeTaskPercent, left.totalTaskPercent, left.activeAgentPercent),
    )
    .slice(0, OPERATOR_DIAGNOSTIC_LIMITS.samples)
    .map((row) => ({
      workspacePublicId: row.workspacePublicId ?? "",
      activeTaskPercent: row.activeTaskPercent,
      totalTaskPercent: row.totalTaskPercent,
      activeAgentPercent: row.activeAgentPercent,
    }));

  return {
    generatedAt: input.now,
    thresholds: OPERATOR_DIAGNOSTIC_THRESHOLDS,
    rateLimits: {
      currentWindowStartedAt,
      currentBuckets: currentRateBuckets.length,
      requestsObserved: currentRateBuckets.reduce((sum, row) => sum + row.count, 0),
      saturatedBuckets: byRoute.reduce((sum, row) => sum + row.saturatedBuckets, 0),
      authPressure: {
        requestsObserved: authRoutes.reduce((sum, row) => sum + row.requestsObserved, 0),
        saturatedBuckets: authRoutes.reduce((sum, row) => sum + row.saturatedBuckets, 0),
      },
      byRoute,
      coverage: coverage(input.rateLimitBuckets),
    },
    claims: {
      overdue: claims.length,
      stuck: claims.filter(
        (row) =>
          ageMs(input.now, row.leaseUntil) >=
          OPERATOR_DIAGNOSTIC_THRESHOLDS.schedulerStuckAfterMs,
      ).length,
      oldestOverdueMs: oldestAgeMs(
        input.now,
        claims.map((row) => row.leaseUntil),
      ),
      samples: claimSamples,
      coverage: coverage(input.overdueClaims),
    },
    sessions: {
      active: activeSessions.length,
      expiredStatus: input.sessions.rows.filter((row) => row.status === "expired").length,
      revokedStatus: input.sessions.rows.filter((row) => row.status === "revoked").length,
      activePastIdleDeadline: expiredActiveSessions.length,
      stuckPastIdleDeadline: expiredActiveSessions.filter(
        (row) =>
          ageMs(input.now, row.idleExpiresAt) >=
          OPERATOR_DIAGNOSTIC_THRESHOLDS.schedulerStuckAfterMs,
      ).length,
      oldestIdleDeadlineOverdueMs: oldestAgeMs(
        input.now,
        expiredActiveSessions.map((row) => row.idleExpiresAt),
      ),
      observedActiveOnRevokedCredential: activeSessions.filter(
        (row) => row.credentialStatus === "revoked",
      ).length,
      observedActiveOnExpiredCredential: activeSessions.filter(
        (row) =>
          row.credentialExpiresAt !== undefined && row.credentialExpiresAt <= input.now,
      ).length,
      observedActiveWithMissingCredential: activeSessions.filter(
        (row) => row.credentialResolution === "missing",
      ).length,
      observedActiveWithCredentialLinkMismatch: activeSessions.filter(
        (row) => row.credentialResolution === "mismatch",
      ).length,
      coverage: coverage(input.sessions),
    },
    projectionRepairs: {
      pending: pendingRepairs.length,
      stuck: pendingRepairs.filter(
        (row) =>
          ageMs(input.now, row.updatedAt) >=
          OPERATOR_DIAGNOSTIC_THRESHOLDS.schedulerStuckAfterMs,
      ).length,
      oldestPendingAgeMs: oldestAgeMs(
        input.now,
        pendingRepairs.map((row) => row.updatedAt),
      ),
      byKind: repairsByKind,
      samples: repairSamples,
      coverage: coverage(input.projectionRepairs),
    },
    review: {
      pending: allObservedReviews.length,
      aged: allObservedReviews.filter(
        (submittedAt) =>
          ageMs(input.now, submittedAt) >=
          OPERATOR_DIAGNOSTIC_THRESHOLDS.reviewAgedAfterMs,
      ).length,
      oldestPendingAgeMs: oldestAgeMs(input.now, allObservedReviews),
      backlogs: reviewBacklogs,
      samples: reviewSamples,
      workspaceCoverage: coverage(input.reviewWorkspaces),
      submissionCoverage: {
        scanned: allObservedReviews.length,
        perWorkspaceLimit: OPERATOR_DIAGNOSTIC_LIMITS.pendingReviewsPerWorkspace,
        truncated: input.reviewWorkspaces.rows.some(
          (workspace) => workspace.submissions.truncated,
        ),
      },
    },
    credentials: {
      active: activeCredentials.length,
      revoked: input.credentials.rows.filter((row) => row.status === "revoked").length,
      activeExpired: activeCredentials.filter((row) => row.expiresAt <= input.now).length,
      activeExpiringWithinRenewalWindow: activeCredentials.filter(
        (row) =>
          row.expiresAt > input.now &&
          row.expiresAt <=
            input.now + OPERATOR_DIAGNOSTIC_THRESHOLDS.credentialRenewalWindowMs,
      ).length,
      activeUnused: activeCredentials.filter(
        (row) =>
          ageMs(input.now, row.lastUsedAt) >=
          OPERATOR_DIAGNOSTIC_THRESHOLDS.credentialUnusedAfterMs,
      ).length,
      coverage: coverage(input.credentials),
    },
    wakes: {
      overdue: dueWakes.length,
      stuck: dueWakes.filter(
        (row) =>
          ageMs(input.now, row.expectedAvailableAt) >=
          OPERATOR_DIAGNOSTIC_THRESHOLDS.schedulerStuckAfterMs,
      ).length,
      oldestOverdueMs: oldestAgeMs(
        input.now,
        dueWakes.map((row) => row.expectedAvailableAt),
      ),
      samples: wakeSamples,
      coverage: coverage(input.dueWakes),
    },
    quotas: {
      limits: {
        activeTasks: WORKSPACE_ACTIVE_TASK_LIMIT,
        totalTasks: WORKSPACE_TOTAL_TASK_LIMIT,
        activeAgents: WORKSPACE_ACTIVE_AGENT_LIMIT,
      },
      warningPercent: OPERATOR_DIAGNOSTIC_THRESHOLDS.quotaWarningPercent,
      workspacesAtOrAboveWarning: quotaRows.filter(
        (row) =>
          Math.max(row.activeTaskPercent, row.totalTaskPercent, row.activeAgentPercent) >=
          OPERATOR_DIAGNOSTIC_THRESHOLDS.quotaWarningPercent,
      ).length,
      workspacesAtOrAboveLimit: quotaRows.filter(
        (row) =>
          row.activeTaskPercent >= 100 ||
          row.totalTaskPercent >= 100 ||
          row.activeAgentPercent >= 100,
      ).length,
      highestActiveTaskPercent:
        quotaRows.length === 0 ? 0 : Math.max(...quotaRows.map((row) => row.activeTaskPercent)),
      highestTotalTaskPercent:
        quotaRows.length === 0 ? 0 : Math.max(...quotaRows.map((row) => row.totalTaskPercent)),
      highestActiveAgentPercent:
        quotaRows.length === 0 ? 0 : Math.max(...quotaRows.map((row) => row.activeAgentPercent)),
      samples: quotaSamples,
      coverage: coverage(input.workspaceUsage),
    },
  };
}

const coverageValidator = v.object({
  scanned: v.number(),
  limit: v.number(),
  truncated: v.boolean(),
});

const nullableNumberValidator = v.union(v.number(), v.null());
const taskSampleBase = {
  workspacePublicId: v.string(),
  taskKey: v.string(),
};
const routeClassValidator = v.union(
  v.literal("agent_read"),
  v.literal("agent_write"),
  v.literal("agent_claim"),
  v.literal("agent_review"),
  v.literal("agent_session"),
  v.literal("human_read"),
  v.literal("human_mutation"),
  v.literal("human_poll"),
  v.literal("refresh_auth"),
  v.literal("desktop_pairing_start"),
  v.literal("desktop_pairing_redeem"),
  v.literal("password_sign_in"),
  v.literal("password_sign_up"),
  v.literal("agent_auth_failure"),
  v.literal("enrollment_auth_failure"),
);
const repairKindValidator = v.union(
  v.literal("task_readiness"),
  v.literal("task_claim"),
  v.literal("task_review"),
);
const diagnosticsValidator = v.object({
  generatedAt: v.number(),
  thresholds: v.object({
    schedulerStuckAfterMs: v.number(),
    reviewAgedAfterMs: v.number(),
    credentialRenewalWindowMs: v.number(),
    credentialUnusedAfterMs: v.number(),
    quotaWarningPercent: v.number(),
  }),
  rateLimits: v.object({
    currentWindowStartedAt: v.number(),
    currentBuckets: v.number(),
    requestsObserved: v.number(),
    saturatedBuckets: v.number(),
    authPressure: v.object({
      requestsObserved: v.number(),
      saturatedBuckets: v.number(),
    }),
    byRoute: v.array(
      v.object({
        routeClass: routeClassValidator,
        requestsObserved: v.number(),
        saturatedBuckets: v.number(),
        maxShardUtilizationPercent: v.number(),
      }),
    ),
    coverage: coverageValidator,
  }),
  claims: v.object({
    overdue: v.number(),
    stuck: v.number(),
    oldestOverdueMs: nullableNumberValidator,
    samples: v.array(
      v.object({
        ...taskSampleBase,
        agentPublicId: v.string(),
        overdueMs: v.number(),
      }),
    ),
    coverage: coverageValidator,
  }),
  sessions: v.object({
    active: v.number(),
    expiredStatus: v.number(),
    revokedStatus: v.number(),
    activePastIdleDeadline: v.number(),
    stuckPastIdleDeadline: v.number(),
    oldestIdleDeadlineOverdueMs: nullableNumberValidator,
    observedActiveOnRevokedCredential: v.number(),
    observedActiveOnExpiredCredential: v.number(),
    observedActiveWithMissingCredential: v.number(),
    observedActiveWithCredentialLinkMismatch: v.number(),
    coverage: coverageValidator,
  }),
  projectionRepairs: v.object({
    pending: v.number(),
    stuck: v.number(),
    oldestPendingAgeMs: nullableNumberValidator,
    byKind: v.array(v.object({ kind: repairKindValidator, pending: v.number() })),
    samples: v.array(
      v.object({
        ...taskSampleBase,
        kind: repairKindValidator,
        generation: v.number(),
        expectedRevision: v.number(),
        pendingAgeMs: v.number(),
      }),
    ),
    coverage: coverageValidator,
  }),
  review: v.object({
    pending: v.number(),
    aged: v.number(),
    oldestPendingAgeMs: nullableNumberValidator,
    backlogs: v.array(
      v.object({
        workspacePublicId: v.string(),
        workspaceSlug: v.string(),
        pending: v.number(),
        aged: v.number(),
        oldestPendingAgeMs: nullableNumberValidator,
        truncated: v.boolean(),
      }),
    ),
    samples: v.array(
      v.object({ ...taskSampleBase, pendingAgeMs: v.number() }),
    ),
    workspaceCoverage: coverageValidator,
    submissionCoverage: v.object({
      scanned: v.number(),
      perWorkspaceLimit: v.number(),
      truncated: v.boolean(),
    }),
  }),
  credentials: v.object({
    active: v.number(),
    revoked: v.number(),
    activeExpired: v.number(),
    activeExpiringWithinRenewalWindow: v.number(),
    activeUnused: v.number(),
    coverage: coverageValidator,
  }),
  wakes: v.object({
    overdue: v.number(),
    stuck: v.number(),
    oldestOverdueMs: nullableNumberValidator,
    samples: v.array(
      v.object({
        ...taskSampleBase,
        generation: v.number(),
        overdueMs: v.number(),
      }),
    ),
    coverage: coverageValidator,
  }),
  quotas: v.object({
    limits: v.object({
      activeTasks: v.number(),
      totalTasks: v.number(),
      activeAgents: v.number(),
    }),
    warningPercent: v.number(),
    workspacesAtOrAboveWarning: v.number(),
    workspacesAtOrAboveLimit: v.number(),
    highestActiveTaskPercent: v.number(),
    highestTotalTaskPercent: v.number(),
    highestActiveAgentPercent: v.number(),
    samples: v.array(
      v.object({
        workspacePublicId: v.string(),
        activeTaskPercent: v.number(),
        totalTaskPercent: v.number(),
        activeAgentPercent: v.number(),
      }),
    ),
    coverage: coverageValidator,
  }),
});

function bounded<Row>(rows: readonly Row[], limit: number): BoundedRows<Row> {
  return {
    rows: rows.slice(0, limit),
    limit,
    truncated: rows.length > limit,
  };
}

async function taskSamples<
  Row extends {
    taskId: Id<"tasks">;
    workspaceId: Id<"workspaces">;
    organizationId: Id<"organizations">;
  },
  Rendered,
>(
  ctx: QueryCtx,
  rows: readonly Row[],
  render: (row: Row, taskKey: string, workspacePublicId: string) => Rendered,
): Promise<Rendered[]> {
  const rendered = await Promise.all(
    rows.slice(0, OPERATOR_DIAGNOSTIC_LIMITS.samples).map(async (row) => {
      const task = await ctx.db.get(row.taskId);
      if (
        task === null ||
        task.workspaceId !== row.workspaceId ||
        task.organizationId !== row.organizationId
      ) {
        return null;
      }
      const workspace = await ctx.db.get(row.workspaceId);
      if (workspace === null || workspace.organizationId !== row.organizationId) return null;
      return render(row, task.key, workspace.publicId);
    }),
  );
  return rendered.filter((row): row is NonNullable<typeof row> => row !== null);
}

export const snapshot = internalQuery({
  args: {},
  returns: diagnosticsValidator,
  handler: async (ctx) => {
    const now = Date.now();
    const indexedLimit = OPERATOR_DIAGNOSTIC_LIMITS.indexedRows;
    const scannedLimit = OPERATOR_DIAGNOSTIC_LIMITS.scannedRows;
    const workspaceLimit = OPERATOR_DIAGNOSTIC_LIMITS.workspaces;

    const [
      rateLimitDocs,
      claimDocs,
      sessionDocs,
      repairDocs,
      credentialDocs,
      wakeDocs,
      usageDocs,
      workspaceDocs,
    ] = await Promise.all([
      ctx.db
        .query("apiRateLimitBuckets")
        .withIndex("by_expiry", (query) => query.gt("expiresAt", now))
        .order("desc")
        .take(scannedLimit + 1),
      ctx.db
        .query("taskClaims")
        .withIndex("by_state_deadline", (query) =>
          query.eq("state", "active").lte("leaseUntil", now),
        )
        .order("asc")
        .take(indexedLimit + 1),
      ctx.db.query("agentSessions").order("asc").take(scannedLimit + 1),
      ctx.db
        .query("projectionRepairs")
        .withIndex("by_status_and_updated", (query) => query.eq("status", "pending"))
        .order("asc")
        .take(indexedLimit + 1),
      ctx.db.query("agentCredentials").order("asc").take(scannedLimit + 1),
      ctx.db
        .query("taskWakes")
        .withIndex("by_state_and_available", (query) =>
          query.eq("state", "pending").lte("expectedAvailableAt", now),
        )
        .order("asc")
        .take(indexedLimit + 1),
      ctx.db.query("workspaceUsage").order("asc").take(scannedLimit + 1),
      ctx.db.query("workspaces").order("asc").take(workspaceLimit + 1),
    ]);

    const sessions = bounded(sessionDocs, scannedLimit);
    const sessionRows = await Promise.all(
      sessions.rows.map(async (session) => {
        const credential = await ctx.db.get(session.credentialId);
        const credentialResolution =
          credential === null
            ? ("missing" as const)
            : credential.organizationId !== session.organizationId ||
                credential.workspaceId !== session.workspaceId ||
                credential.agentId !== session.agentId
              ? ("mismatch" as const)
              : ("linked" as const);
        return {
          status: session.status,
          idleExpiresAt: session.idleExpiresAt,
          credentialResolution,
          ...(credential === null || credentialResolution !== "linked"
            ? {}
            : {
                credentialStatus: credential.status,
                credentialExpiresAt: credential.expiresAt,
              }),
        };
      }),
    );

    const workspaces = bounded(workspaceDocs, workspaceLimit);
    const reviewWorkspaces = await Promise.all(
      workspaces.rows.map(async (workspace) => {
        const submissions = await ctx.db
          .query("taskSubmissions")
          .withIndex("by_workspace_status_submitted", (query) =>
            query.eq("workspaceId", workspace._id).eq("status", "pending"),
          )
          .order("asc")
          .take(OPERATOR_DIAGNOSTIC_LIMITS.pendingReviewsPerWorkspace + 1);
        return {
          workspace,
          submissions: bounded(
            submissions,
            OPERATOR_DIAGNOSTIC_LIMITS.pendingReviewsPerWorkspace,
          ),
        };
      }),
    );

    const claims = bounded(claimDocs, indexedLimit);
    const repairs = bounded(repairDocs, indexedLimit);
    const wakes = bounded(wakeDocs, indexedLimit);
    const reviewCandidates = reviewWorkspaces
      .flatMap(({ workspace, submissions }) =>
        submissions.rows.map((submission) => ({ workspace, submission })),
      )
      .sort((left, right) => left.submission.submittedAt - right.submission.submittedAt)
      .slice(0, OPERATOR_DIAGNOSTIC_LIMITS.samples);

    const [claimSamples, repairSamples, wakeSamples, reviewSamples] = await Promise.all([
      taskSamples(ctx, claims.rows, (claim, taskKey, workspacePublicId) => ({
        workspacePublicId,
        taskKey,
        agentPublicId: claim.agentPublicId,
        leaseUntil: claim.leaseUntil,
      })),
      taskSamples(ctx, repairs.rows, (repair, taskKey, workspacePublicId) => ({
        workspacePublicId,
        taskKey,
        kind: repair.kind,
        generation: repair.generation,
        expectedRevision: repair.expectedRevision,
        updatedAt: repair.updatedAt,
      })),
      taskSamples(ctx, wakes.rows, (wake, taskKey, workspacePublicId) => ({
        workspacePublicId,
        taskKey,
        generation: wake.generation,
        expectedAvailableAt: wake.expectedAvailableAt,
      })),
      Promise.all(
        reviewCandidates.map(async ({ workspace, submission }) => {
          const task = await ctx.db.get(submission.taskId);
          if (
            task === null ||
            task.workspaceId !== workspace._id ||
            task.organizationId !== workspace.organizationId ||
            submission.organizationId !== workspace.organizationId
          ) {
            return null;
          }
          return {
            workspacePublicId: workspace.publicId,
            taskKey: task.key,
            submittedAt: submission.submittedAt,
          };
        }),
      ).then((rows) => rows.filter((row): row is NonNullable<typeof row> => row !== null)),
    ]);

    const usage = bounded(usageDocs, scannedLimit);
    const quotaCandidates = [...usage.rows]
      .sort(
        (left, right) =>
          Math.max(
            percent(right.activeTasks, WORKSPACE_ACTIVE_TASK_LIMIT),
            percent(right.totalTasks, WORKSPACE_TOTAL_TASK_LIMIT),
            percent(right.activeAgents, WORKSPACE_ACTIVE_AGENT_LIMIT),
          ) -
          Math.max(
            percent(left.activeTasks, WORKSPACE_ACTIVE_TASK_LIMIT),
            percent(left.totalTasks, WORKSPACE_TOTAL_TASK_LIMIT),
            percent(left.activeAgents, WORKSPACE_ACTIVE_AGENT_LIMIT),
          ),
      )
      .slice(0, OPERATOR_DIAGNOSTIC_LIMITS.samples);
    const quotaWorkspaceEntries = await Promise.all(
      quotaCandidates.map(async (usageRow) => {
        const workspace = await ctx.db.get(usageRow.workspaceId);
        return workspace === null || workspace.organizationId !== usageRow.organizationId
          ? null
          : ([usageRow.workspaceId, workspace.publicId] as const);
      }),
    );
    const quotaWorkspaceIds = new Map(
      quotaWorkspaceEntries.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      ),
    );

    return buildOperatorDiagnostics({
      now,
      rateLimitBuckets: {
        ...bounded(rateLimitDocs, scannedLimit),
        rows: bounded(rateLimitDocs, scannedLimit).rows.map((row) => ({
          routeClass: row.routeClass,
          subjectKind: row.subjectKind,
          windowStartedAt: row.windowStartedAt,
          count: row.count,
        })),
      },
      overdueClaims: {
        ...claims,
        rows: claims.rows.map((row) => ({ leaseUntil: row.leaseUntil })),
      },
      claimSamples,
      sessions: {
        rows: sessionRows,
        limit: sessions.limit,
        truncated: sessions.truncated,
      },
      projectionRepairs: {
        ...repairs,
        rows: repairs.rows.map((row) => ({
          kind: row.kind,
          status: row.status,
          updatedAt: row.updatedAt,
        })),
      },
      repairSamples,
      reviewWorkspaces: {
        rows: reviewWorkspaces.map(({ workspace, submissions }) => ({
          workspacePublicId: workspace.publicId,
          workspaceSlug: workspace.slug,
          submissions: {
            rows: submissions.rows.map((submission) => ({
              submittedAt: submission.submittedAt,
            })),
            limit: submissions.limit,
            truncated: submissions.truncated,
          },
        })),
        limit: workspaces.limit,
        truncated: workspaces.truncated,
      },
      reviewSamples,
      credentials: {
        ...bounded(credentialDocs, scannedLimit),
        rows: bounded(credentialDocs, scannedLimit).rows.map((credential) => ({
          status: credential.status,
          expiresAt: credential.expiresAt,
          lastUsedAt: credential.lastUsedAt,
        })),
      },
      dueWakes: {
        ...wakes,
        rows: wakes.rows.map((row) => ({
          state: row.state,
          expectedAvailableAt: row.expectedAvailableAt,
        })),
      },
      wakeSamples,
      workspaceUsage: {
        rows: usage.rows.map((row) => {
          const workspacePublicId = quotaWorkspaceIds.get(row.workspaceId);
          return {
            ...(workspacePublicId === undefined ? {} : { workspacePublicId }),
            activeTasks: row.activeTasks,
            totalTasks: row.totalTasks,
            activeAgents: row.activeAgents,
          };
        }),
        limit: usage.limit,
        truncated: usage.truncated,
      },
    });
  },
});

export const workspaceIntegrityPage = internalQuery({
  args: {
    workspacePublicId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: workspaceIntegrityPageValidator,
  handler: async (ctx, args) => {
    const limit = args.limit ?? WORKSPACE_INTEGRITY_LIMITS.defaultTasks;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > WORKSPACE_INTEGRITY_LIMITS.maximumTasks ||
      (args.cursor !== undefined && (args.cursor.length < 1 || args.cursor.length > 8_192))
    ) {
      throw new Error("Invalid workspace integrity page request.");
    }
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_public_id", (query) => query.eq("publicId", args.workspacePublicId))
      .unique();
    if (workspace === null) throw new Error("Workspace integrity target was not found.");

    const now = Date.now();
    const [taskPage, usage, activeGrantDocs, runnerAuthorityDocs] = await Promise.all([
      ctx.db
        .query("tasks")
        .withIndex("by_workspace_updated", (query) =>
          query.eq("workspaceId", workspace._id),
        )
        .paginate({ cursor: args.cursor ?? null, numItems: limit }),
      ctx.db
        .query("workspaceUsage")
        .withIndex("by_workspace", (query) => query.eq("workspaceId", workspace._id))
        .unique(),
      ctx.db
        .query("agentWorkspaceGrants")
        .withIndex("by_workspace_status_and_agent", (query) =>
          query.eq("workspaceId", workspace._id).eq("status", "active"),
        )
        .take(WORKSPACE_INTEGRITY_LIMITS.activeGrants + 1),
      ctx.db
        .query("dispatchRunnerAuthorities")
        .withIndex("by_workspace", (query) => query.eq("workspaceId", workspace._id))
        .take(WORKSPACE_INTEGRITY_LIMITS.runnerAuthorities + 1),
    ]);
    const activeGrants = await Promise.all(
      activeGrantDocs
        .slice(0, WORKSPACE_INTEGRITY_LIMITS.activeGrants)
        .map(async (grant) => ({ grant, agent: await ctx.db.get(grant.agentId) })),
    );
    const runnerAuthorities = await Promise.all(
      runnerAuthorityDocs
        .slice(0, WORKSPACE_INTEGRITY_LIMITS.runnerAuthorities)
        .map(async (authority) => ({
          authority,
          runner: await ctx.db.get(authority.runnerId),
        })),
    );

    const tasks = await Promise.all(
      taskPage.page.map(async (task) => {
        const [edgeDocs, pendingSubmissionDocs, latestEvent, activeClaimDocs] =
          await Promise.all([
            ctx.db
              .query("taskDependencies")
              .withIndex(WORKSPACE_INTEGRITY_INVERSE_INDEXES.blockerEdges, (query) =>
                query.eq("blockedTaskId", task._id),
              )
              .take(WORKSPACE_INTEGRITY_LIMITS.directBlockers + 1),
            ctx.db
              .query("taskSubmissions")
              .withIndex(
                WORKSPACE_INTEGRITY_INVERSE_INDEXES.pendingSubmissions,
                (query) =>
                query
                  .eq("taskId", task._id)
                  .eq("status", "pending"),
              )
              .take(WORKSPACE_INTEGRITY_LIMITS.pendingSubmissions + 1),
            ctx.db
              .query("taskEvents")
              .withIndex(WORKSPACE_INTEGRITY_INVERSE_INDEXES.taskEvents, (query) =>
                query.eq("taskId", task._id),
              )
              .order("desc")
              .first(),
            ctx.db
              .query("taskClaims")
              .withIndex(WORKSPACE_INTEGRITY_INVERSE_INDEXES.activeClaims, (query) =>
                query.eq("taskId", task._id).eq("state", "active"),
              )
              .take(WORKSPACE_INTEGRITY_LIMITS.activeClaims + 1),
          ]);
        const edges = edgeDocs.slice(0, WORKSPACE_INTEGRITY_LIMITS.directBlockers);
        const blockers = await Promise.all(
          edges.map(async (edge) => ({ edge, blocker: await ctx.db.get(edge.blockerTaskId) })),
        );
        return {
          workspace: {
            organizationId: workspace.organizationId,
            id: workspace._id,
          },
          now,
          task: {
            organizationId: task.organizationId,
            workspaceId: task.workspaceId,
            id: task._id,
            publicId: task.publicId,
            key: task.key,
            status: task.status,
            availableAt: task.availableAt,
            isReady: task.isReady,
            ...(task.isBlocked === undefined ? {} : { isBlocked: task.isBlocked }),
            ...(task.needsAttention === undefined
              ? {}
              : { needsAttention: task.needsAttention }),
            unresolvedBlockerCount: task.unresolvedBlockerCount,
            cancelledBlockerCount: task.cancelledBlockerCount,
            revision: task.revision,
            reviewRevision: task.reviewRevision,
            claimFence: task.claimFence,
            ...(task.currentClaim === undefined
              ? {}
              : {
                  currentClaim: {
                    claimId: task.currentClaim.claimId,
                    publicId: task.currentClaim.publicId,
                    agentId: task.currentClaim.agentId,
                    agentPublicId: task.currentClaim.agentPublicId,
                    fence: task.currentClaim.fence,
                    leaseGeneration: task.currentClaim.leaseGeneration,
                    leaseUntil: task.currentClaim.leaseUntil,
                  },
                }),
          },
          activeClaims: {
            rows: activeClaimDocs
              .slice(0, WORKSPACE_INTEGRITY_LIMITS.activeClaims)
              .map((claim) => ({
                id: claim._id,
                organizationId: claim.organizationId,
                workspaceId: claim.workspaceId,
                taskId: claim.taskId,
                publicId: claim.publicId,
                agentId: claim.agentId,
                agentPublicId: claim.agentPublicId,
                state: claim.state,
                fence: claim.fence,
                leaseGeneration: claim.leaseGeneration,
                leaseUntil: claim.leaseUntil,
              })),
            limit: WORKSPACE_INTEGRITY_LIMITS.activeClaims,
            truncated: activeClaimDocs.length > WORKSPACE_INTEGRITY_LIMITS.activeClaims,
          },
          blockers: {
            rows: blockers.map(({ edge, blocker }) => ({
              edge: {
                organizationId: edge.organizationId,
                workspaceId: edge.workspaceId,
                blockerTaskId: edge.blockerTaskId,
                blockedTaskId: edge.blockedTaskId,
              },
              blocker:
                blocker === null
                  ? null
                  : {
                      organizationId: blocker.organizationId,
                      workspaceId: blocker.workspaceId,
                      id: blocker._id,
                      status: blocker.status,
                    },
            })),
            limit: WORKSPACE_INTEGRITY_LIMITS.directBlockers,
            truncated: edgeDocs.length > WORKSPACE_INTEGRITY_LIMITS.directBlockers,
          },
          pendingSubmissions: {
            rows: pendingSubmissionDocs.map((submission) => ({
              organizationId: submission.organizationId,
              workspaceId: submission.workspaceId,
              taskId: submission.taskId,
              status: submission.status,
              reviewRevision: submission.reviewRevision,
            })),
            limit: WORKSPACE_INTEGRITY_LIMITS.pendingSubmissions,
            truncated:
              pendingSubmissionDocs.length > WORKSPACE_INTEGRITY_LIMITS.pendingSubmissions,
          },
          latestEvent:
            latestEvent === null
              ? null
              : {
                  organizationId: latestEvent.organizationId,
                  workspaceId: latestEvent.workspaceId,
                  taskId: latestEvent.taskId,
                  taskPublicId: latestEvent.taskPublicId,
                  taskRevision: latestEvent.taskRevision,
                },
        };
      }),
    );

    return buildWorkspaceIntegrityPage({
      workspace: {
        organizationId: workspace.organizationId,
        id: workspace._id,
        publicId: workspace.publicId,
      },
      now,
      startedAtBeginning: args.cursor === undefined,
      nextCursor: taskPage.isDone ? null : taskPage.continueCursor,
      taskLimit: limit,
      tasks,
      usage:
        usage === null
          ? null
          : {
              organizationId: usage.organizationId,
              workspaceId: usage.workspaceId,
              activeTasks: usage.activeTasks,
              totalTasks: usage.totalTasks,
              activeAgents: usage.activeAgents,
              updatedAt: usage.updatedAt,
            },
      activeGrants: {
        rows: activeGrants.map(({ grant, agent }) => ({
            organizationId: grant.organizationId,
            workspaceId: grant.workspaceId,
            agentId: grant.agentId,
            agent:
              agent === null
                ? null
                : {
                    id: agent._id,
                    organizationId: agent.organizationId,
                    status: agent.status,
                  },
          })),
        limit: WORKSPACE_INTEGRITY_LIMITS.activeGrants,
        truncated: activeGrantDocs.length > WORKSPACE_INTEGRITY_LIMITS.activeGrants,
      },
      runnerAuthorities: {
        rows: runnerAuthorities.map(({ authority, runner }) => ({
          organizationId: authority.organizationId,
          workspaceId: authority.workspaceId,
          runnerId: authority.runnerId,
          runnerPublicId: authority.runnerPublicId,
          installationId: authority.installationId,
          generation: authority.generation,
          leaseUntil: authority.leaseUntil,
          runner:
            runner === null
              ? null
              : {
                  id: runner._id,
                  organizationId: runner.organizationId,
                  workspaceId: runner.workspaceId,
                  publicId: runner.publicId,
                  installationId: runner.installationId,
                  leaseUntil: runner.leaseUntil,
                },
        })),
        limit: WORKSPACE_INTEGRITY_LIMITS.runnerAuthorities,
        truncated:
          runnerAuthorityDocs.length > WORKSPACE_INTEGRITY_LIMITS.runnerAuthorities,
      },
    });
  },
});

export const workspaceIntegrityScan = internalAction({
  args: {
    workspacePublicId: v.string(),
    maxPages: v.optional(v.number()),
  },
  returns: workspaceIntegrityScanValidator,
  handler: async (ctx, args) => {
    const maxPages = args.maxPages ?? WORKSPACE_INTEGRITY_LIMITS.maximumScanPages;
    if (
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > WORKSPACE_INTEGRITY_LIMITS.maximumScanPages
    ) {
      throw new Error("Invalid workspace integrity scan request.");
    }

    const loadPass = async (): Promise<WorkspaceIntegrityPage[]> => {
      const pages: WorkspaceIntegrityPage[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const page = await ctx.runQuery(
          internal.operatorDiagnostics.workspaceIntegrityPage,
          {
            workspacePublicId: args.workspacePublicId,
            ...(cursor === undefined ? {} : { cursor }),
            limit: WORKSPACE_INTEGRITY_LIMITS.maximumTasks,
          },
        );
        pages.push(page);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return pages;
    };

    const firstPass = await loadPass();
    const passes: WorkspaceIntegrityPage[][] = [firstPass];
    if (firstPass.at(-1)?.nextCursor === null) passes.push(await loadPass());
    return buildWorkspaceIntegrityScan({
      workspacePublicId: args.workspacePublicId,
      generatedAt: Date.now(),
      maxPages,
      passes,
    });
  },
});
