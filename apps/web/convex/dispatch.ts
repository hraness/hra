import {
  appendRunEventsRequestSchema,
  claimDispatchRequestSchema,
  createTaskRequestSchema,
  dispatchIdSchema,
  MAX_DISPATCH_CLAIMS_PER_PULL,
  MAX_RUN_INTERACTION_VIEWS,
  publicRunStatusEventKindSchema,
  repositoryIdSchema,
  runnerHeartbeatRequestSchema,
  runnerHeartbeatResponseMatchesRequest,
  runnerHeartbeatResponseSchema,
  taskRunViewSchema,
  type PublicRunEvent,
  type RunPhase,
  type RunnerHeartbeatRequest,
  type RunnerPresenceView,
  type TaskRunView,
} from "@hraness/agent-tasks-protocol";
import { v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  authorizeAgent,
  touchAuthorizedAgent,
  type AuthorizedAgent,
} from "./authorization";
import {
  FAIL_CLOSED_TASK_DISPATCH_PHASES,
  CANDIDATE_ROTATION_COOLDOWN_MS,
  candidateRowsToRotate,
  contiguousEventBatch,
  deriveRunnerPresence,
  dispatchCandidateScanTake,
  dispatchCandidateIsEligible,
  dispatchBindingTupleMatches,
  dispatchClaimAllowed,
  dispatchClaimLeaseDisposition,
  dispatchRetryAllowed,
  dispatchTenantTupleMatches,
  heartbeatDisposition,
  heartbeatFingerprint,
  heartbeatMayRotateCandidates,
  heartbeatLeaseUntil,
  isTerminalRunPhase,
  nextRunPhase,
  planFairEligibleDispatchCandidates,
  retainedTerminalRunIds,
  resolvedAmbiguousDispatchPhase,
  rejectedSubmissionMatchesDispatch,
  runnerAuthorityClockMatches,
  runnerAuthorityDisposition,
  runnerAuthorityTupleMatches,
  runDisplayBudgetAfterBatch,
  runEventSequenceAllowed,
  storedRunEventPayloadMatches,
  taskDispatchBlocksTaskRelease,
  type AmbiguousDispatchResolutionReason,
} from "./dispatchLaws";
import {
  dispatchClaimRequiredScopes,
  firstMissingDispatchClaimScope,
} from "./dispatchAuthorization";
import {
  reconcileSubmittedDispatch,
  requeueLeasedDispatch,
  submittedTaskClaimMatchesDispatch,
} from "./dispatchReconciliation";
import { requireProjectionAfterProtectedWrite } from "./dispatchSafety";
import { expireOpenInteractions } from "./dispatchInteractions";
import {
  domainFailure,
  isTaskReady,
  parseTaskData,
  randomRequestId,
  type DomainError,
} from "./domain";
import { appendTaskEvent } from "./events";
import { authorizeWorkspaceHuman } from "./humanAuthorization";
import {
  createHumanTaskRecord,
  humanTaskMutationDigest,
  runHumanTaskMutation,
  validPublicScope,
} from "./humanTaskMutations";
import type { HostedMutationReceiptBinding } from "./hostedMutationAttempts";
import {
  advanceWorkspaceProjectionById,
  workspaceTaskViewValues,
  type WorkspaceProjectionImpact,
} from "./hraProjection";
import {
  DEFAULT_CLAIM_LEASE_MS,
  DISPATCH_LEASE_MS,
  MAX_RUN_EVENTS_VIEW,
  MAX_RUNNER_CAPACITY,
  MAX_RUNNER_REPOSITORIES,
  HRA_DISPATCH_PROTOCOL_VERSION,
  domainErrorValidator,
  publicRunStatusEventKindValidator,
  publicRunTextEventKindValidator,
  runInteractionRequestValidator,
  runInteractionStateValidator,
  runPhaseValidator,
  runnerBlockReasonValidator,
  runnerHeartbeatResponseValidator,
  taskViewValidator,
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
  type PersistedActor,
} from "./workGraph";
import { nextClaimFence } from "./workGraphLaws";

const QUERY_REQUEST_ID = "req_00000000000000000000000000";
const MAX_HUMAN_RUNS = 50;
const ACTIVE_BOUND_PHASES = [
  "leased",
  "provisioning",
  "starting",
  "running",
  "waiting",
  "cancel_requested",
] as const;

const runnerPresenceValidator = v.union(
  v.object({ state: v.literal("offline"), serverTime: v.number() }),
  v.object({
    state: v.literal("blocked"),
    serverTime: v.number(),
    leaseUntil: v.number(),
    reason: runnerBlockReasonValidator,
  }),
  v.object({
    state: v.literal("ready"),
    serverTime: v.number(),
    leaseUntil: v.number(),
    availableCapacity: v.number(),
  }),
  v.object({ state: v.literal("busy"), serverTime: v.number(), leaseUntil: v.number() }),
  v.object({ state: v.literal("draining"), serverTime: v.number(), leaseUntil: v.number() }),
);

const runEventViewValidator = v.union(
  v.object({
    id: v.string(),
    sequence: v.number(),
    kind: publicRunStatusEventKindValidator,
    observedAt: v.number(),
  }),
  v.object({
    id: v.string(),
    sequence: v.number(),
    kind: publicRunTextEventKindValidator,
    displayText: v.string(),
    observedAt: v.number(),
  }),
);

const runInteractionViewValidator = v.object({
  runId: v.string(),
  request: runInteractionRequestValidator,
  state: runInteractionStateValidator,
  responseRevision: v.optional(v.number()),
  respondedAt: v.optional(v.number()),
  resolvedAt: v.optional(v.number()),
});

const taskRunViewValidator = v.object({
  id: v.string(),
  taskKey: v.string(),
  phase: runPhaseValidator,
  repositoryId: v.string(),
  desiredState: v.union(v.literal("run"), v.literal("stop")),
  updatedAt: v.number(),
  events: v.array(runEventViewValidator),
  interactions: v.array(runInteractionViewValidator),
});
type ConvexRunInteractionView = Infer<typeof runInteractionViewValidator>;
type ConvexTaskRunView = Infer<typeof taskRunViewValidator>;

function convexRunInteractionView(
  interaction: TaskRunView["interactions"][number],
): ConvexRunInteractionView {
  const request = interaction.request.kind === "file_change_approval"
    ? interaction.request
    : {
        ...interaction.request,
        questions: interaction.request.questions.map((question) => ({
          ...question,
          options: question.options.map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        })),
      };
  return {
    runId: interaction.runId,
    request,
    state: interaction.state,
    ...(interaction.responseRevision === undefined
      ? {}
      : { responseRevision: interaction.responseRevision }),
    ...(interaction.respondedAt === undefined ? {} : { respondedAt: interaction.respondedAt }),
    ...(interaction.resolvedAt === undefined ? {} : { resolvedAt: interaction.resolvedAt }),
  };
}

function convexTaskRunView(run: TaskRunView): ConvexTaskRunView {
  return {
    id: run.id,
    taskKey: run.taskKey,
    phase: run.phase,
    repositoryId: run.repositoryId,
    desiredState: run.desiredState,
    updatedAt: run.updatedAt,
    events: run.events.map((event) => ({ ...event })),
    interactions: run.interactions.map(convexRunInteractionView),
  };
}

const heartbeatResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: runnerHeartbeatResponseValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const claimedDispatchValidator = v.object({
  runId: v.string(),
  taskId: v.string(),
  taskKey: v.string(),
  taskTitle: v.string(),
  taskDescription: v.string(),
  repositoryId: v.string(),
  baseRef: v.string(),
  claimId: v.string(),
  claimFence: v.number(),
  inputReviewRevision: v.number(),
  leaseGeneration: v.number(),
  leaseUntil: v.number(),
});

const claimResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ run: claimedDispatchValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const eventResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ acceptedThroughSequence: v.number(), serverTime: v.number() }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export const humanReadinessDataValidator = v.object({
  presence: runnerPresenceValidator,
  repositories: v.array(
    v.object({ id: v.string(), name: v.string(), ready: v.boolean() }),
  ),
});

export const humanReadinessResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: humanReadinessDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

export const humanRunsDataValidator = v.object({
  runs: v.array(taskRunViewValidator),
  hasMore: v.boolean(),
});

export const humanRunsResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: humanRunsDataValidator,
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const createAndDispatchResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ task: taskViewValidator, run: taskRunViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const stopRunResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({
      runId: v.string(),
      phase: runPhaseValidator,
      desiredState: v.literal("stop"),
      updatedAt: v.number(),
    }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

const humanRunMutationResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    data: v.object({ run: taskRunViewValidator }),
    requestId: v.string(),
  }),
  v.object({ ok: v.literal(false), error: domainErrorValidator }),
);

type ReadCtx = QueryCtx | MutationCtx;
type BoundDispatch = Extract<
  Doc<"taskDispatches">,
  { runnerId: Id<"dispatchRunners"> }
>;
type RunnerAuthority = Doc<"dispatchRunnerAuthorities">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundDispatch(dispatch: Doc<"taskDispatches">): dispatch is BoundDispatch {
  return "runnerId" in dispatch;
}

function randomDispatchId(prefix: "run" | "claim"): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const body = [...bytes].map((byte) => byte.toString(36).padStart(2, "0")).join("");
  return `${prefix}_${body}`;
}

async function authorizeDispatchAgent(
  ctx: MutationCtx,
  args: {
    readonly credentialId: Id<"agentCredentials">;
    readonly sessionPublicId: string;
    readonly requestId: string;
    readonly scope: "dispatch:execute" | "runtime:heartbeat" | "tasks:claim" | "runs:report";
    readonly rateClass: "agent_session" | "agent_claim" | "agent_write";
    readonly now: number;
  },
) {
  const authorized = await authorizeAgent(ctx, {
    credentialId: args.credentialId,
    sessionPublicId: args.sessionPublicId,
    requestId: args.requestId,
    requiredScope: args.scope,
    now: args.now,
  });
  if (!authorized.ok) return authorized;
  const rateFailure = agentRateLimitFailure(
    await consumeAuthorizedAgentRateLimit(ctx, {
      authorization: authorized.authorization,
      routeClass: args.rateClass,
      requestId: args.requestId,
      now: args.now,
    }),
    args.requestId,
  );
  return rateFailure === null ? authorized : rateFailure;
}

function runnerTenantMatches(runner: Doc<"dispatchRunners">, authorization: AuthorizedAgent) {
  return (
    runner.organizationId === authorization.organizationId &&
    runner.workspaceId === authorization.workspaceId &&
    runner.agentId === authorization.agentId
  );
}

async function loadRunnerAuthority(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
): Promise<RunnerAuthority | null | "corrupt"> {
  const rows = await ctx.db
    .query("dispatchRunnerAuthorities")
    .withIndex("by_workspace", (query) => query.eq("workspaceId", workspaceId))
    .take(2);
  if (rows.length > 1) return "corrupt";
  return rows[0] ?? null;
}

function authorityTenantMatches(
  authority: RunnerAuthority,
  authorization: Pick<AuthorizedAgent, "organizationId" | "workspaceId">,
): boolean {
  return (
    authority.organizationId === authorization.organizationId &&
    authority.workspaceId === authorization.workspaceId
  );
}

function authorityOwnsRunner(
  authority: RunnerAuthority,
  runner: Doc<"dispatchRunners">,
  now: number,
): boolean {
  return (
    authority.leaseUntil > now &&
    runnerAuthorityClockMatches({
      authorityGeneration: authority.generation,
      authorityLeaseUntil: authority.leaseUntil,
      runnerLeaseUntil: runner.leaseUntil,
    }) &&
    runnerAuthorityTupleMatches({
      authorityOrganizationId: authority.organizationId,
      authorityWorkspaceId: authority.workspaceId,
      authorityRunnerId: authority.runnerId,
      authorityRunnerPublicId: authority.runnerPublicId,
      authorityInstallationId: authority.installationId,
      runnerOrganizationId: runner.organizationId,
      runnerWorkspaceId: runner.workspaceId,
      runnerId: runner._id,
      runnerPublicId: runner.publicId,
      runnerInstallationId: runner.installationId,
    })
  );
}

async function authorityRecordIsConsistent(
  ctx: ReadCtx,
  authority: RunnerAuthority,
): Promise<boolean> {
  const runner = await ctx.db.get(authority.runnerId);
  return runner !== null &&
    runnerAuthorityClockMatches({
      authorityGeneration: authority.generation,
      authorityLeaseUntil: authority.leaseUntil,
      runnerLeaseUntil: runner.leaseUntil,
    }) &&
    runnerAuthorityTupleMatches({
      authorityOrganizationId: authority.organizationId,
      authorityWorkspaceId: authority.workspaceId,
      authorityRunnerId: authority.runnerId,
      authorityRunnerPublicId: authority.runnerPublicId,
      authorityInstallationId: authority.installationId,
      runnerOrganizationId: runner.organizationId,
      runnerWorkspaceId: runner.workspaceId,
      runnerId: runner._id,
      runnerPublicId: runner.publicId,
      runnerInstallationId: runner.installationId,
    });
}

async function loadRepositoryRecords(
  ctx: ReadCtx,
  authorization: Pick<AuthorizedAgent, "organizationId" | "workspaceId">,
  repositoryPublicIds: readonly string[],
): Promise<Doc<"workspaceRepositories">[] | null> {
  const repositories = await Promise.all(
    repositoryPublicIds.map(async (publicId) =>
      await ctx.db
        .query("workspaceRepositories")
        .withIndex("by_public_id", (query) => query.eq("publicId", publicId))
        .unique(),
    ),
  );
  if (
    repositories.some(
      (repository) =>
        repository === null ||
        repository.status !== "active" ||
        repository.organizationId !== authorization.organizationId ||
        repository.workspaceId !== authorization.workspaceId,
    )
  ) {
    return null;
  }
  return repositories as Doc<"workspaceRepositories">[];
}

async function syncRunnerRepositories(
  ctx: MutationCtx,
  runner: Doc<"dispatchRunners">,
  repositories: readonly Doc<"workspaceRepositories">[],
  now: number,
): Promise<boolean> {
  const existing = await ctx.db
    .query("dispatchRunnerRepositories")
    .withIndex("by_runner", (query) => query.eq("runnerId", runner._id))
    .take(MAX_RUNNER_REPOSITORIES + 1);
  if (
    existing.length > MAX_RUNNER_REPOSITORIES ||
    new Set(existing.map(({ repositoryId }) => repositoryId)).size !== existing.length ||
    existing.some(
      (row) =>
        row.organizationId !== runner.organizationId ||
        row.workspaceId !== runner.workspaceId ||
        row.runnerId !== runner._id,
    )
  ) {
    return false;
  }
  const wanted = new Map(repositories.map((repository) => [repository._id, repository]));
  for (const row of existing) {
    if (!wanted.has(row.repositoryId)) await ctx.db.delete(row._id);
  }
  const present = new Set(existing.map((row) => row.repositoryId));
  for (const repository of repositories) {
    if (present.has(repository._id)) continue;
    await ctx.db.insert("dispatchRunnerRepositories", {
      organizationId: runner.organizationId,
      workspaceId: runner.workspaceId,
      runnerId: runner._id,
      repositoryId: repository._id,
      createdAt: now,
      updatedAt: now,
    });
  }
  return true;
}

async function loadRunnerCapabilities(
  ctx: ReadCtx,
  runner: Doc<"dispatchRunners">,
): Promise<Doc<"dispatchRunnerRepositories">[] | null> {
  const rows = await ctx.db
    .query("dispatchRunnerRepositories")
    .withIndex("by_runner", (query) => query.eq("runnerId", runner._id))
    .take(MAX_RUNNER_REPOSITORIES + 1);
  return rows.length <= MAX_RUNNER_REPOSITORIES &&
    new Set(rows.map(({ repositoryId }) => repositoryId)).size === rows.length &&
    rows.every(
      (row) =>
        row.organizationId === runner.organizationId &&
        row.workspaceId === runner.workspaceId &&
        row.runnerId === runner._id,
    )
    ? rows
    : null;
}

async function loadCloudActiveRuns(
  ctx: ReadCtx,
  runner: Doc<"dispatchRunners">,
): Promise<BoundDispatch[] | null> {
  const rows = (
    await Promise.all(
      ACTIVE_BOUND_PHASES.map(async (phase) =>
        await ctx.db
          .query("taskDispatches")
          .withIndex("by_runner_phase_updated", (query) =>
            query.eq("runnerId", runner._id).eq("phase", phase),
          )
          .order("desc")
          .take(MAX_RUNNER_CAPACITY + 1),
      ),
    )
  ).flat();
  if (
    rows.length > MAX_RUNNER_CAPACITY ||
    rows.some(
      (row) =>
        !isBoundDispatch(row) ||
        row.organizationId !== runner.organizationId ||
        row.workspaceId !== runner.workspaceId ||
        row.runnerId !== runner._id,
    )
  ) {
    return null;
  }
  return rows.filter(
    (row): row is BoundDispatch =>
      isBoundDispatch(row) &&
      !isTerminalRunPhase(row.phase) &&
      row.bootId === runner.bootId &&
      row.bootGeneration === runner.bootGeneration,
  );
}

async function loadRetainedTerminalRunIds(
  ctx: ReadCtx,
  runner: Doc<"dispatchRunners">,
  retainedRunIds: readonly string[],
): Promise<string[] | null> {
  const rows = (await Promise.all(retainedRunIds.map(async (runId) =>
    await ctx.db
      .query("taskDispatches")
      .withIndex("by_public_id", (query) => query.eq("publicId", runId))
      .unique(),
  ))).filter((row): row is Doc<"taskDispatches"> => row !== null);
  const ownedRows = rows.filter((row) =>
    isBoundDispatch(row) &&
    row.organizationId === runner.organizationId &&
    row.workspaceId === runner.workspaceId &&
    row.runnerId === runner._id,
  );
  return [...retainedTerminalRunIds(retainedRunIds, ownedRows)];
}

async function orphanPriorBootRuns(
  ctx: MutationCtx,
  runner: Doc<"dispatchRunners">,
  now: number,
): Promise<boolean> {
  const rows = (
    await Promise.all(
      ACTIVE_BOUND_PHASES.map(async (phase) =>
        await ctx.db
          .query("taskDispatches")
          .withIndex("by_runner_phase_updated", (query) =>
            query.eq("runnerId", runner._id).eq("phase", phase),
          )
          .order("desc")
          .take(MAX_RUNNER_CAPACITY + 1),
      ),
    )
  ).flat();
  if (
    rows.length > MAX_RUNNER_CAPACITY ||
    rows.some((row) =>
      !isBoundDispatch(row) ||
      row.organizationId !== runner.organizationId ||
      row.workspaceId !== runner.workspaceId ||
      row.runnerId !== runner._id
    )
  ) return false;
  for (const row of rows) {
    if (!isBoundDispatch(row)) throw new Error("Prior-boot dispatch lost its binding.");
    if (isTerminalRunPhase(row.phase)) continue;
    if (row.phase === "leased") {
      if (!(await requeueLeasedDispatch(ctx, row, now))) {
        // Throwing preserves transaction atomicity if another prior-boot row
        // was already reconciled before this corrupt tuple was discovered.
        throw new Error("Prior-boot leased dispatch could not be requeued safely.");
      }
      continue;
    }
    if (await reconcileSubmittedDispatch(ctx, row, now)) continue;
    await ctx.db.patch(row._id, {
      phase: "ambiguous",
      failureKind: "lease_lost",
      terminalAt: now,
      updatedAt: now,
    });
    await expireOpenInteractions(ctx, row._id, now);
    await advanceWorkspaceProjectionById(ctx, row.workspaceId, now);
  }
  return true;
}

async function renewRunnerDispatchLeases(
  ctx: MutationCtx,
  runner: Doc<"dispatchRunners">,
  authorization: AuthorizedAgent,
  requestId: string,
  now: number,
  currentRunIds: ReadonlySet<string>,
): Promise<boolean> {
  const activeRuns = await loadCloudActiveRuns(ctx, runner);
  if (activeRuns === null) return false;
  for (const run of activeRuns) {
    if (!currentRunIds.has(run.publicId)) continue;
    const [task, claim] = await Promise.all([
      ctx.db.get(run.taskId),
      ctx.db.get(run.taskClaimId),
    ]);
    if (
      claim !== null &&
      submittedTaskClaimMatchesDispatch(run, task, claim) &&
      claim.agentId === authorization.agentId
    ) {
      // submitTask has retired this exact claim, while the runner still owns
      // the ordered run.submitted event. Keep only the dispatch publication
      // lease aligned with the runner's local lease registry; never revive the
      // submitted task claim or synthesize an event in this two-request window.
      if (claim.endedAt === undefined || !Number.isSafeInteger(claim.endedAt)) return false;
      const publicationDeadline = claim.endedAt + DISPATCH_LEASE_MS;
      if (!Number.isSafeInteger(publicationDeadline)) return false;
      if (publicationDeadline <= now) {
        if (!(await reconcileSubmittedDispatch(ctx, run, now))) return false;
        continue;
      }
      const publicationLeaseUntil = Math.min(now + DISPATCH_LEASE_MS, publicationDeadline);
      await ctx.db.patch(run._id, {
        leaseUntil: publicationLeaseUntil,
      });
      await ctx.scheduler.runAt(publicationLeaseUntil, internal.schedules.expireDispatch, {
        dispatchId: run._id,
        runnerId: run.runnerId,
        bootId: run.bootId,
        bootGeneration: run.bootGeneration,
        taskClaimId: run.taskClaimId,
        claimFence: run.claimFence,
        leaseGeneration: run.leaseGeneration,
        expectedDeadline: publicationLeaseUntil,
      });
      continue;
    }
    if (
      task === null ||
      claim === null ||
      task.organizationId !== authorization.organizationId ||
      task.workspaceId !== authorization.workspaceId ||
      claim.organizationId !== authorization.organizationId ||
      claim.workspaceId !== authorization.workspaceId ||
      claim.agentId !== authorization.agentId ||
      claim.publicId !== run.taskClaimPublicId ||
      claim.fence !== run.claimFence ||
      claim.leaseGeneration !== run.leaseGeneration ||
      task.currentClaim === undefined ||
      !activeClaimMatchesTask(task, claim)
    ) {
      if (task !== null) await queueTaskClaimRepair(ctx, task, now);
      return false;
    }
    const disposition = dispatchClaimLeaseDisposition(
      {
        claimLeaseGeneration: claim.leaseGeneration,
        claimLeaseUntil: claim.leaseUntil,
      },
      now,
    );
    if (disposition === null) return false;
    if (disposition.kind === "renew") {
      const nextRevision = task.revision + 1;
      await ctx.db.patch(claim._id, {
        leaseGeneration: disposition.claimLeaseGeneration,
        leaseUntil: disposition.claimLeaseUntil,
        updatedAt: now,
      });
      await ctx.db.patch(task._id, {
        currentClaim: {
          ...task.currentClaim,
          leaseGeneration: disposition.claimLeaseGeneration,
          leaseUntil: disposition.claimLeaseUntil,
        },
        revision: nextRevision,
        updatedAt: now,
      });
      await ctx.scheduler.runAt(disposition.claimLeaseUntil, internal.schedules.expireClaim, {
        taskId: task._id,
        claimId: claim._id,
        fence: claim.fence,
        leaseGeneration: disposition.claimLeaseGeneration,
        expectedDeadline: disposition.claimLeaseUntil,
      });
      await appendTaskEvent(ctx, {
        organizationId: authorization.organizationId,
        workspaceId: authorization.workspaceId,
        taskId: task._id,
        taskPublicId: task.publicId,
        taskRevision: nextRevision,
        type: "task.claim_renewed",
        actor: {
          kind: "agent",
          agentId: authorization.agentPublicId,
          credentialId: authorization.credentialPublicId,
          sessionId: authorization.sessionPublicId,
        },
        command: {
          kind: "client",
          idempotencyKey: `${run.publicId}:${String(disposition.claimLeaseGeneration)}`,
          requestId,
        },
        payload: {
          fence: claim.fence,
          leaseGeneration: disposition.claimLeaseGeneration,
          leaseUntil: disposition.claimLeaseUntil,
        },
        now,
      });
    }
    await ctx.db.patch(run._id, {
      leaseGeneration: disposition.claimLeaseGeneration,
      leaseUntil: disposition.dispatchLeaseUntil,
    });
    await ctx.scheduler.runAt(
      disposition.dispatchLeaseUntil,
      internal.schedules.expireDispatch,
      {
        dispatchId: run._id,
        runnerId: run.runnerId,
        bootId: run.bootId,
        bootGeneration: run.bootGeneration,
        taskClaimId: run.taskClaimId,
        claimFence: run.claimFence,
        leaseGeneration: disposition.claimLeaseGeneration,
        expectedDeadline: disposition.dispatchLeaseUntil,
      },
    );
  }
  return true;
}

async function loadHeartbeatCandidates(
  ctx: MutationCtx,
  authorization: Pick<AuthorizedAgent, "organizationId" | "workspaceId">,
  capableRepositoryIds: readonly Id<"workspaceRepositories">[],
  candidateLimit: number,
  now: number,
  repositoryCursor: Id<"workspaceRepositories"> | undefined,
  rotateIneligible: boolean,
) {
  const heads = (await Promise.all(capableRepositoryIds.map(async (repositoryId) => ({
    repositoryId,
    row: await ctx.db
      .query("taskDispatches")
      .withIndex("by_workspace_repository_phase_candidate", (query) =>
        query
          .eq("workspaceId", authorization.workspaceId)
          .eq("repositoryId", repositoryId)
          .eq("phase", "queued"),
      )
      .order("asc")
      .first(),
  }))));
  if (heads.some(({ repositoryId, row }) => row !== null && (
    row.organizationId !== authorization.organizationId ||
    row.workspaceId !== authorization.workspaceId ||
    row.repositoryId !== repositoryId ||
    row.phase !== "queued"
  ))) return null;
  const headRows = heads.flatMap(({ row }) => row === null ? [] : [row]);
  const scanTake = dispatchCandidateScanTake(
    headRows.length,
    candidateLimit,
  );
  const pages = scanTake === 0
    ? []
    : await Promise.all(headRows.map(async ({ repositoryId }) => ({
        repositoryId,
        rows: await ctx.db
          .query("taskDispatches")
          .withIndex("by_workspace_repository_phase_candidate", (query) =>
            query
              .eq("workspaceId", authorization.workspaceId)
              .eq("repositoryId", repositoryId)
              .eq("phase", "queued"),
          )
          .order("asc")
          .take(scanTake + 1),
      })));
  const allPageRows = pages.flatMap(({ rows }) => rows);
  if (
    allPageRows.some((row) =>
      row.organizationId !== authorization.organizationId ||
      row.workspaceId !== authorization.workspaceId ||
      row.phase !== "queued" ||
      !capableRepositoryIds.includes(row.repositoryId)
    ) ||
    pages.some(({ repositoryId, rows }) =>
      rows[0]?.publicId !== heads.find((head) => head.repositoryId === repositoryId)?.row?.publicId)
  ) return null;
  const scannedRows = pages.flatMap(({ rows }) => rows.slice(0, scanTake));
  const repositories = await Promise.all(headRows.map(({ repositoryId }) =>
    ctx.db.get(repositoryId)));
  if (repositories.some((repository) =>
    repository === null ||
    repository.organizationId !== authorization.organizationId ||
    repository.workspaceId !== authorization.workspaceId ||
    repository.status !== "active"
  )) return null;
  const repositoryById = new Map(repositories.flatMap((repository) =>
    repository === null ? [] : [[repository._id, repository] as const]));
  const loaded = await Promise.all(scannedRows.map(async (dispatch) => ({
    dispatch,
    repository: repositoryById.get(dispatch.repositoryId),
    task: await ctx.db.get(dispatch.taskId),
  })));
  if (
    new Set(scannedRows.map(({ publicId }) => publicId)).size !== scannedRows.length ||
    new Set(scannedRows.map(({ repositoryId, taskId }) =>
      `${repositoryId}\u0000${taskId}`)).size !== scannedRows.length
  ) return null;
  const evaluated = [];
  for (const { dispatch, repository, task } of loaded) {
    if (
      task === null ||
      repository === undefined ||
      task.organizationId !== authorization.organizationId ||
      task.workspaceId !== authorization.workspaceId ||
      task.key !== dispatch.taskKey ||
      repository.organizationId !== authorization.organizationId ||
      repository.workspaceId !== authorization.workspaceId ||
      repository._id !== dispatch.repositoryId ||
      repository.publicId !== dispatch.repositoryPublicId ||
      repository.status !== "active"
    ) {
      return null;
    }
    evaluated.push({
      ...dispatch,
      eligible: dispatchCandidateIsEligible({
        currentClaimFence: task.claimFence,
        currentTaskRevision: task.revision,
        persistedReady: task.isReady,
        queuedClaimFence: dispatch.queuedClaimFence,
        queuedTaskRevision: dispatch.queuedTaskRevision,
        readyNow: isTaskReady(task, now),
      }),
    });
  }
  const plan = planFairEligibleDispatchCandidates({
    limit: candidateLimit,
    ...(repositoryCursor === undefined ? {} : { repositoryCursor }),
    rows: evaluated,
  });
  if (plan === null) return null;
  const truncatedRepositoryIds = pages
    .filter(({ rows }) => rows.length > scanTake)
    .map(({ repositoryId }) => repositoryId);
  const rowsToRotate = candidateRowsToRotate({
    cooldownMs: CANDIDATE_ROTATION_COOLDOWN_MS,
    deferredPublicIds: plan.deferredPublicIds,
    maximumRows: headRows.length * scanTake,
    now,
    rows: evaluated,
    truncatedRepositoryIds,
  });
  if (rowsToRotate === null) return null;

  // Every tenant, capability, repository, task, row, and selection invariant
  // is validated before the first queue-order write. Replays remain read-only.
  if (rotateIneligible) {
    for (const row of rowsToRotate) {
      await ctx.db.patch(row._id, { candidateOrderAt: now, candidateRotationAt: now });
    }
  }
  return {
    candidates: plan.selected.map((dispatch) => ({
      taskKey: dispatch.taskKey,
      repositoryId: dispatch.repositoryPublicId,
      queuedAt: dispatch.queuedAt,
    })),
    nextRepositoryCursor: plan.nextRepositoryCursor,
  };
}

async function heartbeatResponse(
  ctx: MutationCtx,
  runner: Doc<"dispatchRunners">,
  authorization: AuthorizedAgent,
  now: number,
  currentRunIds: readonly string[],
  retainedRunIds: readonly string[],
  rotateIneligibleCandidates: boolean,
) {
  const [capabilities, activeRuns, releaseRunIds] = await Promise.all([
    loadRunnerCapabilities(ctx, runner),
    loadCloudActiveRuns(ctx, runner),
    loadRetainedTerminalRunIds(ctx, runner, retainedRunIds),
  ]);
  if (capabilities === null || activeRuns === null || releaseRunIds === null) return null;
  const capableRepositoryIds = capabilities.map((row) => row.repositoryId);
  const presence = deriveRunnerPresence(
    {
      ...(runner.reportedState === "degraded" ? { blockReason: runner.blockReason } : {}),
      capacity: runner.capacity,
      cloudActiveRuns: activeRuns.length,
      desiredState: runner.desiredState,
      leaseUntil: runner.leaseUntil,
      reportedActiveRuns: runner.activeRuns,
      reportedState: runner.reportedState,
      repositoryCount: capabilities.length,
    },
    now,
  );
  const candidateLimit = Math.min(
    MAX_DISPATCH_CLAIMS_PER_PULL,
    Math.max(0, runner.capacity - Math.max(runner.activeRuns, activeRuns.length)),
  );
  const candidateSelection = presence.state === "ready" && candidateLimit > 0
    ? await loadHeartbeatCandidates(
        ctx,
        authorization,
        capableRepositoryIds,
        candidateLimit,
        now,
        runner.candidateRepositoryCursor,
        rotateIneligibleCandidates,
      )
    : { candidates: [], nextRepositoryCursor: undefined };
  if (candidateSelection === null) return null;
  if (
    rotateIneligibleCandidates &&
    candidateSelection.nextRepositoryCursor !== undefined &&
    candidateSelection.nextRepositoryCursor !== runner.candidateRepositoryCursor
  ) {
    await ctx.db.patch(runner._id, {
      candidateRepositoryCursor: candidateSelection.nextRepositoryCursor,
    });
  }
  const currentRunIdSet = new Set(currentRunIds);
  const liveCurrentRuns = activeRuns.filter((run) =>
    currentRunIdSet.has(run.publicId) && run.leaseUntil > now);
  return {
    serverTime: now,
    leaseUntil: runner.leaseUntil,
    desiredState: runner.desiredState,
    candidates: candidateSelection.candidates,
    runLeases: liveCurrentRuns.map((run) => ({ runId: run.publicId, leaseUntil: run.leaseUntil })),
    stopRunIds: liveCurrentRuns
      .filter((run) => run.desiredState === "stop")
      .slice(0, MAX_RUNNER_CAPACITY)
      .map((run) => run.publicId),
    releaseRunIds,
  };
}

function replayedHeartbeatResponse(
  runner: Doc<"dispatchRunners">,
  request: RunnerHeartbeatRequest,
) {
  if (runner.lastHeartbeatResponse === undefined) return undefined;
  const parsed = runnerHeartbeatResponseSchema.safeParse(runner.lastHeartbeatResponse);
  return parsed.success &&
    parsed.data.serverTime === runner.lastHeartbeatAt &&
    parsed.data.leaseUntil === runner.leaseUntil &&
    runnerHeartbeatResponseMatchesRequest(request, parsed.data)
    ? parsed.data
    : null;
}

function newlyConstructedHeartbeatResponse(
  runner: Doc<"dispatchRunners">,
  request: RunnerHeartbeatRequest,
  value: unknown,
) {
  const parsed = runnerHeartbeatResponseSchema.safeParse(value);
  return parsed.success &&
    parsed.data.serverTime === runner.lastHeartbeatAt &&
    parsed.data.leaseUntil === runner.leaseUntil &&
    parsed.data.desiredState === runner.desiredState &&
    runnerHeartbeatResponseMatchesRequest(request, parsed.data)
    ? parsed.data
    : null;
}

function legacyHeartbeatReplayResponse(
  runner: Doc<"dispatchRunners">,
  request: RunnerHeartbeatRequest,
) {
  // Rows written before exact-response persistence cannot reproduce the
  // historical candidate/run projection from mutable current state. Migrate
  // them with a deliberately inert response at the original heartbeat clock;
  // the next sequence obtains a fresh projection, while every retry of this
  // sequence becomes byte-for-byte stable after we persist this response.
  return newlyConstructedHeartbeatResponse(runner, request, {
    serverTime: runner.lastHeartbeatAt,
    leaseUntil: runner.leaseUntil,
    desiredState: runner.desiredState,
    candidates: [],
    runLeases: [],
    stopRunIds: [],
    releaseRunIds: [],
  });
}

export const runnerHeartbeat = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    requestId: v.string(),
    runnerId: v.string(),
    installationId: v.string(),
    bootId: v.string(),
    bootGeneration: v.number(),
    sequence: v.number(),
    protocolVersion: v.number(),
    clientVersion: v.string(),
    reportedState: v.union(
      v.literal("starting"),
      v.literal("ready"),
      v.literal("busy"),
      v.literal("degraded"),
    ),
    blockReason: v.optional(runnerBlockReasonValidator),
    capacity: v.number(),
    activeRuns: v.number(),
    currentRunIds: v.array(v.string()),
    retainedRunIds: v.array(v.string()),
    repositoryIds: v.array(v.string()),
  },
  returns: heartbeatResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const parsed = runnerHeartbeatRequestSchema.safeParse({
      runnerId: args.runnerId,
      installationId: args.installationId,
      bootId: args.bootId,
      bootGeneration: args.bootGeneration,
      sequence: args.sequence,
      protocolVersion: args.protocolVersion,
      clientVersion: args.clientVersion,
      reportedState: args.reportedState,
      ...(args.blockReason === undefined ? {} : { blockReason: args.blockReason }),
      capacity: args.capacity,
      activeRuns: args.activeRuns,
      currentRunIds: args.currentRunIds,
      retainedRunIds: args.retainedRunIds,
      repositoryIds: args.repositoryIds,
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorized = await authorizeDispatchAgent(ctx, {
      credentialId: args.credentialId,
      sessionPublicId: args.sessionPublicId,
      requestId: args.requestId,
      scope: "runtime:heartbeat",
      rateClass: "agent_session",
      now,
    });
    if (!authorized.ok) return authorized;
    const authorization = authorized.authorization;
    const [existing, authority] = await Promise.all([
      ctx.db
        .query("dispatchRunners")
        .withIndex("by_public_id", (query) => query.eq("publicId", parsed.data.runnerId))
        .unique(),
      loadRunnerAuthority(ctx, authorization.workspaceId),
    ]);
    if (
      existing !== null &&
      (!runnerTenantMatches(existing, authorization) ||
        existing.installationId !== parsed.data.installationId)
    ) {
      return domainFailure("AUTHORIZATION_DENIED", args.requestId);
    }
    if (
      authority === "corrupt" ||
      (authority !== null &&
        (!authorityTenantMatches(authority, authorization) ||
          !(await authorityRecordIsConsistent(ctx, authority))))
    ) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const readinessFingerprintBefore =
      await workspaceRunnerReadinessSemanticFingerprint(
        ctx,
        authorization.workspaceId,
        now,
      );
    if (readinessFingerprintBefore === null) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const authorityDisposition = runnerAuthorityDisposition(
      authority,
      {
        runnerPublicId: parsed.data.runnerId,
        installationId: parsed.data.installationId,
      },
      now,
    );
    if (authorityDisposition.kind === "corrupt") {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    if (authorityDisposition.kind === "conflict") {
      await touchAuthorizedAgent(ctx, authorization, now);
      return domainFailure("RUNNER_ALREADY_CONNECTED", args.requestId, {
        retryAfterMs: authorityDisposition.retryAfterMs,
      });
    }
    const fingerprint = heartbeatFingerprint(parsed.data);
    const disposition = heartbeatDisposition(existing, {
      bootId: parsed.data.bootId,
      bootGeneration: parsed.data.bootGeneration,
      sequence: parsed.data.sequence,
      fingerprint,
    });
    if (disposition.kind === "stale" || disposition.kind === "gap") {
      return domainFailure("CLAIM_STALE", args.requestId);
    }
    if (disposition.kind === "conflict") {
      return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
    }
    if (disposition.kind === "replay") {
      if (existing === null || existing.leaseUntil <= now) {
        return domainFailure("CLAIM_STALE", args.requestId);
      }
      if (authority !== null && !authorityOwnsRunner(authority, existing, now)) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      const persistedResponse = replayedHeartbeatResponse(existing, parsed.data);
      if (persistedResponse === null) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      const response = persistedResponse ?? legacyHeartbeatReplayResponse(existing, parsed.data);
      if (response === null) {
        return domainFailure("PROJECTION_MISMATCH", args.requestId);
      }
      if (authority === null) {
        await ctx.db.insert("dispatchRunnerAuthorities", {
          organizationId: authorization.organizationId,
          workspaceId: authorization.workspaceId,
          runnerId: existing._id,
          runnerPublicId: existing.publicId,
          installationId: existing.installationId,
          generation: authorityDisposition.generation,
          leaseUntil: existing.leaseUntil,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (persistedResponse === undefined) {
        await ctx.db.patch(existing._id, { lastHeartbeatResponse: response });
      }
      return { ok: true as const, data: response, requestId: args.requestId };
    }
    const repositories = await loadRepositoryRecords(ctx, authorization, parsed.data.repositoryIds);
    if (repositories === null) return domainFailure("NOT_FOUND", args.requestId);
    const nextLeaseUntil = heartbeatLeaseUntil(now);
    let runner: Doc<"dispatchRunners">;
    if (existing === null) {
      const runnerId = await ctx.db.insert("dispatchRunners", {
        organizationId: authorization.organizationId,
        workspaceId: authorization.workspaceId,
        agentId: authorization.agentId,
        publicId: parsed.data.runnerId,
        installationId: parsed.data.installationId,
        bootId: parsed.data.bootId,
        bootGeneration: parsed.data.bootGeneration,
        heartbeatSequence: parsed.data.sequence,
        heartbeatFingerprint: fingerprint,
        desiredState: "active",
        protocolVersion: HRA_DISPATCH_PROTOCOL_VERSION,
        clientVersion: parsed.data.clientVersion,
        reportedState: parsed.data.reportedState,
        ...(parsed.data.blockReason === undefined ? {} : { blockReason: parsed.data.blockReason }),
        capacity: parsed.data.capacity,
        activeRuns: parsed.data.activeRuns,
        lastHeartbeatAt: now,
        leaseUntil: nextLeaseUntil,
        createdAt: now,
        updatedAt: now,
      });
      const created = await ctx.db.get(runnerId);
      if (created === null) throw new Error("Dispatch runner disappeared during registration.");
      runner = created;
    } else {
      if (disposition.kind === "restart" && !(await orphanPriorBootRuns(ctx, existing, now))) {
        throw new Error("Runner restart projection is invalid.");
      }
      await ctx.db.patch(existing._id, {
        bootId: parsed.data.bootId,
        bootGeneration: parsed.data.bootGeneration,
        heartbeatSequence: parsed.data.sequence,
        heartbeatFingerprint: fingerprint,
        protocolVersion: HRA_DISPATCH_PROTOCOL_VERSION,
        clientVersion: parsed.data.clientVersion,
        reportedState: parsed.data.reportedState,
        ...(parsed.data.reportedState === "degraded"
          ? { blockReason: parsed.data.blockReason }
          : { blockReason: undefined }),
        capacity: parsed.data.capacity,
        activeRuns: parsed.data.activeRuns,
        lastHeartbeatAt: now,
        leaseUntil: nextLeaseUntil,
        updatedAt: now,
      });
      const updated = await ctx.db.get(existing._id);
      if (updated === null) throw new Error("Dispatch runner disappeared during heartbeat.");
      runner = updated;
    }
    if (authorityDisposition.kind === "takeover" && authority !== null) {
      const previousRunner = await ctx.db.get(authority.runnerId);
      if (previousRunner === null) throw new Error("Runner takeover lost its previous runner.");
      const previousRuns = await loadCloudActiveRuns(ctx, previousRunner);
      if (previousRuns === null) throw new Error("Runner takeover run projection is invalid.");
      let interactionsChanged = false;
      for (const previousRun of previousRuns) {
        interactionsChanged =
          (await expireOpenInteractions(ctx, previousRun._id, now)) ||
          interactionsChanged;
      }
      if (interactionsChanged) {
        await advanceWorkspaceProjectionById(ctx, runner.workspaceId, now);
      }
    }
    if (authority === null) {
      await ctx.db.insert("dispatchRunnerAuthorities", {
        organizationId: authorization.organizationId,
        workspaceId: authorization.workspaceId,
        runnerId: runner._id,
        runnerPublicId: runner.publicId,
        installationId: runner.installationId,
        generation: authorityDisposition.generation,
        leaseUntil: nextLeaseUntil,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(authority._id, {
        runnerId: runner._id,
        runnerPublicId: runner.publicId,
        installationId: runner.installationId,
        generation: authorityDisposition.generation,
        leaseUntil: nextLeaseUntil,
        updatedAt: now,
      });
    }
    if (!(await syncRunnerRepositories(ctx, runner, repositories, now))) {
      throw new Error("Runner repository projection is invalid.");
    }
    if (!(await renewRunnerDispatchLeases(
      ctx,
      runner,
      authorization,
      args.requestId,
      now,
      new Set(parsed.data.currentRunIds),
    ))) {
      throw new Error("Runner dispatch lease projection is invalid.");
    }
    const readinessFingerprintAfter =
      await workspaceRunnerReadinessSemanticFingerprint(
        ctx,
        authorization.workspaceId,
        now,
      );
    if (readinessFingerprintAfter === null) {
      throw new Error("Runner readiness projection is invalid.");
    }
    if (readinessFingerprintAfter !== readinessFingerprintBefore) {
      await advanceWorkspaceProjectionById(ctx, runner.workspaceId, now);
    }
    const constructedResponse = await heartbeatResponse(
      ctx,
      runner,
      authorization,
      now,
      parsed.data.currentRunIds,
      parsed.data.retainedRunIds,
      heartbeatMayRotateCandidates(disposition),
    );
    const response = constructedResponse === null
      ? null
      : newlyConstructedHeartbeatResponse(runner, parsed.data, constructedResponse);
    if (response === null) throw new Error("Heartbeat response projection is invalid.");
    await ctx.db.patch(runner._id, { lastHeartbeatResponse: response });
    await touchAuthorizedAgent(ctx, authorization, now);
    return { ok: true as const, data: response, requestId: args.requestId };
  },
});

async function taskByKey(ctx: ReadCtx, workspaceId: Id<"workspaces">, key: string) {
  return await ctx.db
    .query("tasks")
    .withIndex("by_workspace_and_key", (query) => query.eq("workspaceId", workspaceId).eq("key", key))
    .unique();
}

async function claimedDispatchData(ctx: ReadCtx, dispatch: BoundDispatch) {
  const [task, body, claim, repository] = await Promise.all([
    ctx.db.get(dispatch.taskId),
    ctx.db
      .query("taskBodies")
      .withIndex("by_workspace_and_task", (query) =>
        query.eq("workspaceId", dispatch.workspaceId).eq("taskId", dispatch.taskId),
      )
      .unique(),
    ctx.db.get(dispatch.taskClaimId),
    ctx.db.get(dispatch.repositoryId),
  ]);
  if (
    task === null ||
    body === null ||
    claim === null ||
    repository === null ||
    task.organizationId !== dispatch.organizationId ||
    task.workspaceId !== dispatch.workspaceId ||
    body.organizationId !== dispatch.organizationId ||
    body.workspaceId !== dispatch.workspaceId ||
    body.taskId !== dispatch.taskId ||
    claim.organizationId !== dispatch.organizationId ||
    claim.workspaceId !== dispatch.workspaceId ||
    claim.taskId !== dispatch.taskId ||
    claim.publicId !== dispatch.taskClaimPublicId ||
    claim.fence !== dispatch.claimFence ||
    repository.organizationId !== dispatch.organizationId ||
    repository.workspaceId !== dispatch.workspaceId ||
    repository.publicId !== dispatch.repositoryPublicId
  ) {
    return null;
  }
  return {
    runId: dispatch.publicId,
    taskId: task.publicId,
    taskKey: task.key,
    taskTitle: task.title,
    taskDescription: body.description,
    repositoryId: repository.publicId,
    baseRef: "HEAD",
    claimId: claim.publicId,
    claimFence: claim.fence,
    inputReviewRevision: dispatch.inputReviewRevision,
    leaseGeneration: claim.leaseGeneration,
    leaseUntil: dispatch.leaseUntil,
  };
}

async function replayedDispatchClaim(
  ctx: ReadCtx,
  authorization: AuthorizedAgent,
  runner: Doc<"dispatchRunners">,
  task: Doc<"tasks">,
  repository: Doc<"workspaceRepositories">,
) {
  const rows = await ctx.db
    .query("taskDispatches")
    .withIndex("by_workspace_task_updated", (query) =>
      query.eq("workspaceId", authorization.workspaceId).eq("taskId", task._id),
    )
    .order("desc")
    .take(10);
  const matching = rows.filter(
    (row): row is BoundDispatch =>
      isBoundDispatch(row) &&
      row.organizationId === authorization.organizationId &&
      row.repositoryId === repository._id &&
      row.runnerId === runner._id &&
      row.bootId === runner.bootId &&
      row.bootGeneration === runner.bootGeneration &&
      !isTerminalRunPhase(row.phase),
  );
  return matching.length === 1 ? (matching[0] ?? null) : null;
}

export const claimDispatch = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    requestId: v.string(),
    runnerId: v.string(),
    bootId: v.string(),
    bootGeneration: v.number(),
    taskKey: v.string(),
    repositoryId: v.string(),
  },
  returns: claimResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const parsed = claimDispatchRequestSchema.safeParse({
      runnerId: args.runnerId,
      bootId: args.bootId,
      bootGeneration: args.bootGeneration,
      taskKey: args.taskKey,
      repositoryId: args.repositoryId,
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", args.requestId);
    const authorized = await authorizeDispatchAgent(ctx, {
      credentialId: args.credentialId,
      sessionPublicId: args.sessionPublicId,
      requestId: args.requestId,
      scope: dispatchClaimRequiredScopes[0],
      rateClass: "agent_claim",
      now,
    });
    if (!authorized.ok) return authorized;
    const authorization = authorized.authorization;
    const missingScope = firstMissingDispatchClaimScope(authorization.scopes);
    if (missingScope !== null) {
      return domainFailure("SCOPE_REQUIRED", args.requestId, { requiredScope: missingScope });
    }
    const [runner, task, repository, authority] = await Promise.all([
      ctx.db
        .query("dispatchRunners")
        .withIndex("by_public_id", (query) => query.eq("publicId", parsed.data.runnerId))
        .unique(),
      taskByKey(ctx, authorization.workspaceId, parsed.data.taskKey),
      ctx.db
        .query("workspaceRepositories")
        .withIndex("by_public_id", (query) => query.eq("publicId", parsed.data.repositoryId))
        .unique(),
      loadRunnerAuthority(ctx, authorization.workspaceId),
    ]);
    if (runner === null || task === null || repository === null) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    if (authority === "corrupt") {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    if (authority !== null && !authorityTenantMatches(authority, authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    if (authority === null || !authorityOwnsRunner(authority, runner, now)) {
      return domainFailure("CLAIM_STALE", args.requestId);
    }
    if (
      !runnerTenantMatches(runner, authorization) ||
      repository.status !== "active" ||
      !dispatchTenantTupleMatches({
        authorizedOrganizationId: authorization.organizationId,
        authorizedWorkspaceId: authorization.workspaceId,
        runnerOrganizationId: runner.organizationId,
        runnerWorkspaceId: runner.workspaceId,
        taskOrganizationId: task.organizationId,
        taskWorkspaceId: task.workspaceId,
        repositoryOrganizationId: repository.organizationId,
        repositoryWorkspaceId: repository.workspaceId,
      })
    ) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    const [capability, activeRuns] = await Promise.all([
      ctx.db
        .query("dispatchRunnerRepositories")
        .withIndex("by_runner_and_repository", (query) =>
          query.eq("runnerId", runner._id).eq("repositoryId", repository._id),
        )
        .unique(),
      loadCloudActiveRuns(ctx, runner),
    ]);
    if (activeRuns === null) return domainFailure("PROJECTION_MISMATCH", args.requestId);
    const replay = await replayedDispatchClaim(ctx, authorization, runner, task, repository);
    if (replay !== null) {
      if (replay.leaseUntil <= now) return domainFailure("CLAIM_STALE", args.requestId);
      const data = await claimedDispatchData(ctx, replay);
      return data === null
        ? domainFailure("PROJECTION_MISMATCH", args.requestId)
        : { ok: true as const, data: { run: data }, requestId: args.requestId };
    }
    const dispatch = await ctx.db
      .query("taskDispatches")
      .withIndex("by_workspace_task_repository_phase", (query) =>
        query
          .eq("workspaceId", authorization.workspaceId)
          .eq("taskId", task._id)
          .eq("repositoryId", repository._id)
          .eq("phase", "queued"),
      )
      .unique();
    if (dispatch === null) return domainFailure("TASK_ALREADY_CLAIMED", args.requestId);
    if (
      capability === null ||
      capability.organizationId !== authorization.organizationId ||
      capability.workspaceId !== authorization.workspaceId ||
      capability.runnerId !== runner._id ||
      dispatch.organizationId !== authorization.organizationId ||
      dispatch.workspaceId !== authorization.workspaceId ||
      dispatch.taskId !== task._id ||
      dispatch.repositoryId !== repository._id
    ) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    if (
      dispatch.queuedTaskRevision !== task.revision ||
      dispatch.queuedClaimFence !== task.claimFence
    ) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId, {
        taskKey: task.key,
        currentRevision: task.revision,
      });
    }
    const projection = await ensureCounterProjection(ctx, task, now, args.requestId);
    if (!projection.ok) return projection;
    const ready = isTaskReady(task, now);
    if (ready !== task.isReady) {
      await queueTaskProjectionRepair(ctx, task, now);
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    const availableCapacity = Math.max(
      0,
      runner.capacity - Math.max(runner.activeRuns, activeRuns.length),
    );
    if (
      !dispatchClaimAllowed(
        {
          dispatchPhase: dispatch.phase,
          repositoryCapability: true,
          runnerBootMatches:
            runner.bootId === parsed.data.bootId &&
            runner.bootGeneration === parsed.data.bootGeneration,
          runnerDesiredState: runner.desiredState,
          runnerLeaseUntil: runner.leaseUntil,
          runnerReady: runner.reportedState === "ready",
          availableCapacity,
          taskReady: ready,
        },
        now,
      )
    ) {
      return domainFailure("TASK_NOT_READY", args.requestId);
    }
    const fence = nextClaimFence(task.claimFence);
    if (fence === null || task.status !== "open" || task.currentClaim !== undefined) {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId);
    }
    const claimPublicId = randomDispatchId("claim");
    const leaseGeneration = 1;
    const taskClaimLeaseUntil = now + DEFAULT_CLAIM_LEASE_MS;
    const taskClaimId = await ctx.db.insert("taskClaims", {
      organizationId: authorization.organizationId,
      workspaceId: authorization.workspaceId,
      taskId: task._id,
      publicId: claimPublicId,
      agentId: authorization.agentId,
      agentPublicId: authorization.agentPublicId,
      state: "active",
      fence,
      leaseGeneration,
      leaseUntil: taskClaimLeaseUntil,
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
        claimId: taskClaimId,
        publicId: claimPublicId,
        agentId: authorization.agentId,
        agentPublicId: authorization.agentPublicId,
        fence,
        leaseGeneration,
        leaseUntil: taskClaimLeaseUntil,
      },
      revision: nextRevision,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(taskClaimLeaseUntil, internal.schedules.expireClaim, {
      taskId: task._id,
      claimId: taskClaimId,
      fence,
      leaseGeneration,
      expectedDeadline: taskClaimLeaseUntil,
    });
    await appendTaskEvent(ctx, {
      organizationId: authorization.organizationId,
      workspaceId: authorization.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: nextRevision,
      type: "task.claimed",
      actor: {
        kind: "agent",
        agentId: authorization.agentPublicId,
        credentialId: authorization.credentialPublicId,
        sessionId: authorization.sessionPublicId,
      },
      command: { kind: "client", idempotencyKey: dispatch.publicId, requestId: args.requestId },
      payload: { agentId: authorization.agentPublicId, fence, leaseUntil: taskClaimLeaseUntil },
      now,
    });
    const dispatchLeaseUntil = Math.min(taskClaimLeaseUntil, now + DISPATCH_LEASE_MS);
    await ctx.db.patch(dispatch._id, {
      phase: "leased",
      runnerId: runner._id,
      runnerPublicId: runner.publicId,
      bootId: runner.bootId,
      bootGeneration: runner.bootGeneration,
      taskClaimId,
      taskClaimPublicId: claimPublicId,
      claimFence: fence,
      inputReviewRevision: task.reviewRevision,
      leaseGeneration,
      leaseUntil: dispatchLeaseUntil,
      claimedAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(dispatchLeaseUntil, internal.schedules.expireDispatch, {
      dispatchId: dispatch._id,
      runnerId: runner._id,
      bootId: runner.bootId,
      bootGeneration: runner.bootGeneration,
      taskClaimId,
      claimFence: fence,
      leaseGeneration,
      expectedDeadline: dispatchLeaseUntil,
    });
    const bound = await ctx.db.get(dispatch._id);
    if (bound === null || !isBoundDispatch(bound)) {
      throw new Error("Claimed dispatch disappeared in its transaction.");
    }
    const data = requireProjectionAfterProtectedWrite(
      await claimedDispatchData(ctx, bound),
      "claimDispatch",
    );
    await advanceWorkspaceProjectionById(ctx, dispatch.workspaceId, now);
    await touchAuthorizedAgent(ctx, authorization, now);
    return { ok: true as const, data: { run: data }, requestId: args.requestId };
  },
});

async function releaseRunTaskClaim(
  ctx: MutationCtx,
  dispatch: BoundDispatch,
  actor: PersistedActor,
  now: number,
  requestId: string,
  idempotencyKey: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: DomainError }> {
  const [task, claim] = await Promise.all([
    ctx.db.get(dispatch.taskId),
    ctx.db.get(dispatch.taskClaimId),
  ]);
  if (
    task === null ||
    claim === null ||
    task.organizationId !== dispatch.organizationId ||
    task.workspaceId !== dispatch.workspaceId ||
    claim.organizationId !== dispatch.organizationId ||
    claim.workspaceId !== dispatch.workspaceId ||
    claim.taskId !== task._id ||
    claim.publicId !== dispatch.taskClaimPublicId ||
    claim.fence !== dispatch.claimFence ||
    !activeClaimMatchesTask(task, claim)
  ) {
    if (task !== null) await queueTaskClaimRepair(ctx, task, now);
    return domainFailure("PROJECTION_MISMATCH", requestId);
  }
  const projection = await ensureCounterProjection(ctx, task, now, requestId);
  if (!projection.ok) return projection;
  const ready =
    task.availableAt <= now &&
    projection.actual.unresolved === 0 &&
    projection.actual.cancelled === 0;
  await ctx.db.patch(claim._id, { state: "released", endedAt: now, updatedAt: now });
  const nextRevision = task.revision + 1;
  await ctx.db.patch(task._id, {
    status: "open",
    currentClaim: undefined,
    isReady: ready,
    ...(ready ? { readySince: now } : { readySince: undefined }),
    revision: nextRevision,
    updatedAt: now,
  });
  await appendTaskEvent(ctx, {
    organizationId: dispatch.organizationId,
    workspaceId: dispatch.workspaceId,
    taskId: task._id,
    taskPublicId: task.publicId,
    taskRevision: nextRevision,
    type: "task.claim_released",
    actor,
    command: { kind: "client", idempotencyKey, requestId },
    payload: { fence: claim.fence },
    now,
  });
  return { ok: true };
}

async function submittedRunTaskMatches(ctx: ReadCtx, dispatch: BoundDispatch): Promise<boolean> {
  const [task, claim] = await Promise.all([
    ctx.db.get(dispatch.taskId),
    ctx.db.get(dispatch.taskClaimId),
  ]);
  return (
    task !== null &&
    claim !== null &&
    task.organizationId === dispatch.organizationId &&
    task.workspaceId === dispatch.workspaceId &&
    task.status === "in_review" &&
    claim.organizationId === dispatch.organizationId &&
    claim.workspaceId === dispatch.workspaceId &&
    claim.taskId === task._id &&
    claim.publicId === dispatch.taskClaimPublicId &&
    claim.fence === dispatch.claimFence &&
    claim.state === "submitted"
  );
}

export const appendRunEvents = internalMutation({
  args: {
    credentialId: v.id("agentCredentials"),
    sessionPublicId: v.string(),
    requestId: v.string(),
    runId: v.string(),
    runnerId: v.string(),
    bootId: v.string(),
    claimId: v.string(),
    claimFence: v.number(),
    events: v.array(v.union(
      v.object({
        id: v.string(),
        sequence: v.number(),
        kind: publicRunStatusEventKindValidator,
      }),
      v.object({
        id: v.string(),
        sequence: v.number(),
        kind: publicRunTextEventKindValidator,
        displayText: v.string(),
      }),
    )),
  },
  returns: eventResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const parsed = appendRunEventsRequestSchema.safeParse({
      runnerId: args.runnerId,
      bootId: args.bootId,
      claimId: args.claimId,
      claimFence: args.claimFence,
      events: args.events,
    });
    if (!parsed.success || !dispatchIdSchema.safeParse(args.runId).success) {
      return domainFailure("VALIDATION_ERROR", args.requestId);
    }
    const authorized = await authorizeDispatchAgent(ctx, {
      credentialId: args.credentialId,
      sessionPublicId: args.sessionPublicId,
      requestId: args.requestId,
      scope: "runs:report",
      rateClass: "agent_write",
      now,
    });
    if (!authorized.ok) return authorized;
    const authorization = authorized.authorization;
    const [dispatch, runner, authority] = await Promise.all([
      ctx.db
        .query("taskDispatches")
        .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
        .unique(),
      ctx.db
        .query("dispatchRunners")
        .withIndex("by_public_id", (query) => query.eq("publicId", parsed.data.runnerId))
        .unique(),
      loadRunnerAuthority(ctx, authorization.workspaceId),
    ]);
    if (dispatch === null || runner === null || !isBoundDispatch(dispatch)) {
      return domainFailure("NOT_FOUND", args.requestId);
    }
    if (authority === "corrupt") {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    if (authority !== null && !authorityTenantMatches(authority, authorization)) {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    if (
      authority === null ||
      !authorityOwnsRunner(authority, runner, now) ||
      !runnerTenantMatches(runner, authorization) ||
      runner.leaseUntil <= now ||
      dispatch.leaseUntil <= now ||
      !dispatchTenantTupleMatches({
        authorizedOrganizationId: authorization.organizationId,
        authorizedWorkspaceId: authorization.workspaceId,
        runnerOrganizationId: runner.organizationId,
        runnerWorkspaceId: runner.workspaceId,
        taskOrganizationId: dispatch.organizationId,
        taskWorkspaceId: dispatch.workspaceId,
        repositoryOrganizationId: dispatch.organizationId,
        repositoryWorkspaceId: dispatch.workspaceId,
        dispatchOrganizationId: dispatch.organizationId,
        dispatchWorkspaceId: dispatch.workspaceId,
      }) ||
      !dispatchBindingTupleMatches({
        dispatchRunnerId: dispatch.runnerId,
        runnerId: runner._id,
        dispatchBootId: dispatch.bootId,
        bootId: parsed.data.bootId,
        dispatchBootGeneration: dispatch.bootGeneration,
        bootGeneration: runner.bootGeneration,
        dispatchClaimPublicId: dispatch.taskClaimPublicId,
        claimPublicId: parsed.data.claimId,
        dispatchClaimFence: dispatch.claimFence,
        claimFence: parsed.data.claimFence,
      })
    ) {
      return domainFailure("CLAIM_STALE", args.requestId);
    }
    if (
      !contiguousEventBatch({
        acceptedThroughSequence: dispatch.acceptedThroughSequence,
        events: parsed.data.events,
      })
    ) {
      return domainFailure("CLAIM_STALE", args.requestId);
    }
    const existingEvents = await ctx.db
      .query("taskRunEvents")
      .withIndex("by_dispatch_and_sequence", (query) => query.eq("dispatchId", dispatch._id))
      .order("asc")
      .take(MAX_RUN_EVENTS_VIEW + 1);
    let acceptedThroughSequence = dispatch.acceptedThroughSequence;
    let phase: RunPhase = dispatch.phase;
    const pending: PublicRunEvent[] = [];
    for (const event of parsed.data.events) {
      const [bySequence, byPublicId] = await Promise.all([
        ctx.db
          .query("taskRunEvents")
          .withIndex("by_dispatch_and_sequence", (query) =>
            query.eq("dispatchId", dispatch._id).eq("sequence", event.sequence),
          )
          .unique(),
        ctx.db
          .query("taskRunEvents")
          .withIndex("by_public_id", (query) => query.eq("publicId", event.id))
          .unique(),
      ]);
      if (event.sequence <= acceptedThroughSequence) {
        if (
          bySequence === null ||
          byPublicId === null ||
          bySequence._id !== byPublicId._id ||
          bySequence.dispatchId !== dispatch._id ||
          bySequence.organizationId !== dispatch.organizationId ||
          bySequence.workspaceId !== dispatch.workspaceId ||
          bySequence.publicId !== event.id ||
          bySequence.kind !== event.kind ||
          !storedRunEventPayloadMatches(bySequence, event)
        ) {
          return domainFailure("IDEMPOTENCY_CONFLICT", args.requestId);
        }
        continue;
      }
      if (
        event.sequence !== acceptedThroughSequence + 1 ||
        bySequence !== null ||
        byPublicId !== null ||
        !runEventSequenceAllowed(event.sequence, event.kind)
      ) {
        return domainFailure("CLAIM_STALE", args.requestId);
      }
      const next = nextRunPhase(phase, dispatch.desiredState, event.kind);
      if (next === null) return domainFailure("TASK_STATE_CONFLICT", args.requestId);
      pending.push(event);
      phase = next;
      acceptedThroughSequence = event.sequence;
    }
    const displayBudget = runDisplayBudgetAfterBatch({
      acceptedThroughSequence: dispatch.acceptedThroughSequence,
      existingEvents,
      events: parsed.data.events,
    });
    if (displayBudget.kind === "invalid_existing") {
      return domainFailure("PROJECTION_MISMATCH", args.requestId);
    }
    if (displayBudget.kind === "limit_exceeded" || displayBudget.kind === "invalid_event") {
      return domainFailure("TASK_STATE_CONFLICT", args.requestId);
    }
    if (pending.length > 0) {
      const finalEvent = pending[pending.length - 1];
      if (phase === "submitted" && !(await submittedRunTaskMatches(ctx, dispatch))) {
        return domainFailure("TASK_STATE_CONFLICT", args.requestId);
      }
      if (phase === "failed" || phase === "cancelled") {
        if (finalEvent === undefined) return domainFailure("INTERNAL_ERROR", args.requestId);
        const released = await releaseRunTaskClaim(
          ctx,
          dispatch,
          {
            kind: "agent",
            agentId: authorization.agentPublicId,
            credentialId: authorization.credentialPublicId,
            sessionId: authorization.sessionPublicId,
          },
          now,
          args.requestId,
          finalEvent.id,
        );
        if (!released.ok) return released;
      }
      for (const event of pending) {
        const identity = {
          organizationId: dispatch.organizationId,
          workspaceId: dispatch.workspaceId,
          dispatchId: dispatch._id,
          publicId: event.id,
          sequence: event.sequence,
          observedAt: now,
        };
        if (
          event.kind === "codex.reasoning_summary.delta" ||
          event.kind === "codex.assistant_message.delta"
        ) {
          await ctx.db.insert("taskRunEvents", {
            ...identity,
            kind: event.kind,
            displayText: event.displayText,
          });
        } else {
          await ctx.db.insert("taskRunEvents", { ...identity, kind: event.kind });
        }
      }
      if (phase === "failed") {
        await ctx.db.patch(dispatch._id, {
          acceptedThroughSequence,
          phase,
          failureKind: "codex_exit",
          terminalAt: now,
          updatedAt: now,
        });
      } else if (phase === "ambiguous") {
        await ctx.db.patch(dispatch._id, {
          acceptedThroughSequence,
          phase,
          failureKind: "lease_lost",
          terminalAt: now,
          updatedAt: now,
        });
      } else if (phase === "submitted") {
        await ctx.db.patch(dispatch._id, {
          acceptedThroughSequence,
          phase,
          terminalAt: now,
          updatedAt: now,
        });
      } else if (phase === "cancelled") {
        await ctx.db.patch(dispatch._id, {
          acceptedThroughSequence,
          phase,
          desiredState: "stop",
          terminalAt: now,
          updatedAt: now,
        });
      } else if (phase === "cancel_requested") {
        await ctx.db.patch(dispatch._id, {
          acceptedThroughSequence,
          phase,
          desiredState: "stop",
          updatedAt: now,
        });
      } else {
        await ctx.db.patch(dispatch._id, {
          acceptedThroughSequence,
          phase,
          desiredState: "run",
          updatedAt: now,
        });
      }
      if (
        phase === "submitted" ||
        phase === "failed" ||
        phase === "cancel_requested" ||
        phase === "cancelled" ||
        phase === "ambiguous"
      ) {
        await expireOpenInteractions(ctx, dispatch._id, now);
      }
    }
    if (pending.length > 0) {
      const projectionTask = await ctx.db.get(dispatch.taskId);
      if (
        projectionTask === null ||
        projectionTask.organizationId !== dispatch.organizationId ||
        projectionTask.workspaceId !== dispatch.workspaceId
      ) {
        throw new Error("Run event invalidation lost its task tenant.");
      }
      await advanceWorkspaceProjectionById(
        ctx,
        dispatch.workspaceId,
        now,
        runEventBatchProjectionImpact({
          before: dispatch.phase,
          after: phase,
          taskPublicId: projectionTask.publicId,
          runPublicId: dispatch.publicId,
        }),
      );
    }
    await touchAuthorizedAgent(ctx, authorization, now);
    return {
      ok: true as const,
      data: { acceptedThroughSequence, serverTime: now },
      requestId: args.requestId,
    };
  },
});

/**
 * Run events update visible activity but cannot change task-list membership,
 * filtering, or order. The matching phase transition is the structural seam.
 */
export function runEventBatchAffectsTaskListContinuation(
  before: RunPhase,
  after: RunPhase,
): boolean {
  return before !== after;
}

/**
 * Same-phase event batches patch visible task/run content without invalidating
 * any list continuation. A phase transition can change structure and therefore
 * advances every view conservatively until narrower phase laws are proven.
 */
export function runEventBatchProjectionImpact(input: Readonly<{
  before: RunPhase;
  after: RunPhase;
  taskPublicId: string;
  runPublicId: string;
}>): WorkspaceProjectionImpact {
  return {
    scope: "run",
    taskPublicId: input.taskPublicId,
    runPublicId: input.runPublicId,
    views: workspaceTaskViewValues,
    structure: runEventBatchAffectsTaskListContinuation(
      input.before,
      input.after,
    ),
  };
}

async function runView(
  ctx: ReadCtx,
  dispatch: Doc<"taskDispatches">,
): Promise<ConvexTaskRunView | null> {
  const [task, repository, events, pendingInteractions, answeredInteractions] = await Promise.all([
    ctx.db.get(dispatch.taskId),
    ctx.db.get(dispatch.repositoryId),
    ctx.db
      .query("taskRunEvents")
      .withIndex("by_dispatch_and_sequence", (query) => query.eq("dispatchId", dispatch._id))
      .order("desc")
      .take(MAX_RUN_EVENTS_VIEW + 1),
    ctx.db
      .query("taskRunInteractions")
      .withIndex("by_dispatch_state_created", (query) =>
        query.eq("dispatchId", dispatch._id).eq("state", "pending"))
      .order("desc")
      .take(MAX_RUN_INTERACTION_VIEWS + 1),
    ctx.db
      .query("taskRunInteractions")
      .withIndex("by_dispatch_state_created", (query) =>
        query.eq("dispatchId", dispatch._id).eq("state", "answered"))
      .order("desc")
      .take(MAX_RUN_INTERACTION_VIEWS + 1),
  ]);
  const interactions = [...pendingInteractions, ...answeredInteractions]
    .sort((left, right) => left.createdAt - right.createdAt);
  if (
    task === null ||
    repository === null ||
    events.length > MAX_RUN_EVENTS_VIEW ||
    pendingInteractions.length > MAX_RUN_INTERACTION_VIEWS ||
    answeredInteractions.length > MAX_RUN_INTERACTION_VIEWS ||
    interactions.length > MAX_RUN_INTERACTION_VIEWS ||
    task.organizationId !== dispatch.organizationId ||
    task.workspaceId !== dispatch.workspaceId ||
    repository.organizationId !== dispatch.organizationId ||
    repository.workspaceId !== dispatch.workspaceId ||
    events.some(
      (event) =>
        event.organizationId !== dispatch.organizationId ||
        event.workspaceId !== dispatch.workspaceId ||
        event.dispatchId !== dispatch._id,
    ) ||
    interactions.some(
      (interaction) =>
        interaction.organizationId !== dispatch.organizationId ||
        interaction.workspaceId !== dispatch.workspaceId ||
        interaction.dispatchId !== dispatch._id,
    )
  ) {
    return null;
  }
  const value: ConvexTaskRunView = {
    id: dispatch.publicId,
    taskKey: task.key,
    phase: dispatch.phase,
    repositoryId: repository.publicId,
    desiredState: dispatch.desiredState,
    updatedAt: dispatch.updatedAt,
    events: events
      .toReversed()
      .map((event) => event.kind === "codex.reasoning_summary.delta" ||
        event.kind === "codex.assistant_message.delta"
        ? {
            id: event.publicId,
            sequence: event.sequence,
            kind: event.kind,
            displayText: "displayText" in event ? event.displayText : "",
            observedAt: event.observedAt,
          }
        : {
            id: event.publicId,
            sequence: event.sequence,
            kind: publicRunStatusEventKindSchema.parse(event.kind),
            observedAt: event.observedAt,
          }),
    interactions: interactions.map((interaction) => convexRunInteractionView({
      runId: dispatch.publicId,
      request: interaction.request,
      state: interaction.state,
      ...(interaction.responseRevision === undefined
        ? {}
        : { responseRevision: interaction.responseRevision }),
      ...(interaction.respondedAt === undefined ? {} : { respondedAt: interaction.respondedAt }),
      ...(interaction.resolvedAt === undefined ? {} : { resolvedAt: interaction.resolvedAt }),
    })),
  };
  return taskRunViewSchema.safeParse(value).success ? value : null;
}

type LoadedRunnerPresence = Readonly<{
  runner: Doc<"dispatchRunners">;
  presence: RunnerPresenceView;
  repositoryIds: ReadonlySet<string>;
}>;

async function loadRunnerPresence(
  ctx: ReadCtx,
  runner: Doc<"dispatchRunners">,
  now: number,
): Promise<LoadedRunnerPresence | null> {
  const [capabilities, activeRuns] = await Promise.all([
    loadRunnerCapabilities(ctx, runner),
    loadCloudActiveRuns(ctx, runner),
  ]);
  if (capabilities === null || activeRuns === null) return null;
  return {
    runner,
    presence: deriveRunnerPresence(
      {
        ...(runner.reportedState === "degraded" ? { blockReason: runner.blockReason } : {}),
        capacity: runner.capacity,
        cloudActiveRuns: activeRuns.length,
        desiredState: runner.desiredState,
        leaseUntil: runner.leaseUntil,
        reportedActiveRuns: runner.activeRuns,
        reportedState: runner.reportedState,
        repositoryCount: capabilities.length,
      },
      now,
    ),
    repositoryIds: new Set(capabilities.map((capability) => capability.repositoryId)),
  };
}

function authorityPresence(
  runner: LoadedRunnerPresence | null,
  now: number,
  repositoryId?: Id<"workspaceRepositories">,
): RunnerPresenceView {
  if (runner === null || runner.presence.state === "offline") {
    return { state: "offline", serverTime: now };
  }
  if (repositoryId !== undefined && !runner.repositoryIds.has(repositoryId)) {
    return {
      state: "blocked",
      serverTime: now,
      leaseUntil: runner.presence.leaseUntil,
      reason: "no_repository",
    };
  }
  return runner.presence;
}

/** Excludes lease/clock churn while retaining every human-visible readiness state. */
export function runnerReadinessSemanticFingerprint(
  presence: RunnerPresenceView,
  repositoryIds: readonly string[],
): string {
  const semanticPresence = (() => {
    switch (presence.state) {
      case "offline":
      case "busy":
      case "draining":
        return { state: presence.state };
      case "blocked":
        return { reason: presence.reason, state: presence.state };
      case "ready":
        return {
          availableCapacity: presence.availableCapacity,
          state: presence.state,
        };
    }
  })();
  return JSON.stringify([
    semanticPresence,
    [...new Set(repositoryIds)].sort(),
  ]);
}

async function workspaceRunnerReadinessSemanticFingerprint(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  now: number,
): Promise<string | null> {
  const authority = await loadRunnerAuthority(ctx, workspaceId);
  if (
    authority === "corrupt" ||
    (
      authority !== null &&
      !(await authorityRecordIsConsistent(ctx, authority))
    )
  ) {
    return null;
  }
  if (authority === null) {
    return runnerReadinessSemanticFingerprint(
      { state: "offline", serverTime: now },
      [],
    );
  }
  const runner = await ctx.db.get(authority.runnerId);
  if (runner === null) return null;
  const loaded = await loadRunnerPresence(ctx, runner, now);
  if (loaded === null) return null;
  return runnerReadinessSemanticFingerprint(
    authorityPresence(loaded, now),
    [...loaded.repositoryIds],
  );
}

export const humanReadiness = query({
  args: { workspaceId: v.string(), repositoryId: v.optional(v.string()) },
  returns: humanReadinessResultValidator,
  handler: async (ctx, args) => {
    if (
      args.repositoryId !== undefined &&
      !repositoryIdSchema.safeParse(args.repositoryId).success
    ) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const { organization, workspace } = authorized.authorization;
    const now = Date.now();
    const [repositories, authority] = await Promise.all([
      ctx.db
        .query("workspaceRepositories")
        .withIndex("by_workspace_status_created", (query) =>
          query.eq("workspaceId", workspace._id).eq("status", "active"),
        )
        .take(MAX_RUNNER_REPOSITORIES + 1),
      loadRunnerAuthority(ctx, workspace._id),
    ]);
    if (
      repositories.length > MAX_RUNNER_REPOSITORIES ||
      repositories.some(
        (repository) =>
          repository.organizationId !== organization._id ||
          repository.workspaceId !== workspace._id ||
          repository.status !== "active",
      ) ||
      authority === "corrupt" ||
      (authority !== null &&
        (authority.organizationId !== organization._id ||
          authority.workspaceId !== workspace._id ||
          !(await authorityRecordIsConsistent(ctx, authority))))
    ) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    const selectedRepository =
      args.repositoryId === undefined
        ? undefined
        : repositories.find((repository) => repository.publicId === args.repositoryId);
    if (args.repositoryId !== undefined && selectedRepository === undefined) {
      return domainFailure("NOT_FOUND", QUERY_REQUEST_ID);
    }
    const authorityRunner = authority === null
      ? null
      : await ctx.db.get(authority.runnerId);
    const loaded = authorityRunner === null
      ? null
      : await loadRunnerPresence(ctx, authorityRunner, now);
    if (authority !== null && loaded === null) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    return {
      ok: true as const,
      data: {
        presence: authorityPresence(loaded, now, selectedRepository?._id),
        repositories: repositories.map((repository) => ({
          id: repository.publicId,
          name: repository.name,
          ready:
            loaded?.presence.state === "ready" &&
            loaded.repositoryIds.has(repository._id),
        })),
      },
      requestId: QUERY_REQUEST_ID,
    };
  },
});

export const humanTaskRuns = query({
  args: {
    workspaceId: v.string(),
    taskKey: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: humanRunsResultValidator,
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HUMAN_RUNS) {
      return domainFailure("VALIDATION_ERROR", QUERY_REQUEST_ID);
    }
    const authorized = await authorizeWorkspaceHuman(ctx, {
      requestId: QUERY_REQUEST_ID,
      workspacePublicId: args.workspaceId,
    });
    if (!authorized.ok) return authorized;
    const { organization, workspace } = authorized.authorization;
    const task =
      args.taskKey === undefined ? null : await taskByKey(ctx, workspace._id, args.taskKey);
    if (
      args.taskKey !== undefined &&
      (task === null ||
        task.organizationId !== organization._id ||
        task.workspaceId !== workspace._id)
    ) {
      return domainFailure("NOT_FOUND", QUERY_REQUEST_ID);
    }
    const boundedRows = task === null
      ? await ctx.db
          .query("taskDispatches")
          .withIndex("by_workspace_and_updated", (query) => query.eq("workspaceId", workspace._id))
          .order("desc")
          .take(limit + 1)
      : await ctx.db
          .query("taskDispatches")
          .withIndex("by_workspace_task_updated", (query) =>
            query.eq("workspaceId", workspace._id).eq("taskId", task._id),
          )
          .order("desc")
          .take(limit + 1);
    const hasMore = boundedRows.length > limit;
    const rows = boundedRows.slice(0, limit);
    if (
      rows.some(
        (row) => row.organizationId !== organization._id || row.workspaceId !== workspace._id,
      )
    ) {
      return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
    }
    const runs = await Promise.all(rows.map(async (row) => await runView(ctx, row)));
    const completeRuns: ConvexTaskRunView[] = [];
    for (const run of runs) {
      if (run === null) return domainFailure("PROJECTION_MISMATCH", QUERY_REQUEST_ID);
      completeRuns.push(run);
    }
    return {
      ok: true as const,
      data: { runs: completeRuns, hasMore },
      requestId: QUERY_REQUEST_ID,
    };
  },
});

function parseCreateAndDispatchReceipt(value: unknown) {
  if (!isRecord(value)) return null;
  const task = parseTaskData({ task: value.task });
  const run = taskRunViewSchema.safeParse(value.run);
  return task !== null && run.success
    ? { task: task.task, run: convexTaskRunView(run.data) }
    : null;
}

type StopRunData = Readonly<{
  runId: string;
  phase: RunPhase;
  desiredState: "stop";
  updatedAt: number;
}>;

function parseStopReceipt(value: unknown): StopRunData | null {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    value.desiredState !== "stop" ||
    typeof value.updatedAt !== "number" ||
    typeof value.phase !== "string"
  ) {
    return null;
  }
  const parsedPhase = taskRunViewSchema.shape.phase.safeParse(value.phase);
  if (!parsedPhase.success) {
    return null;
  }
  return {
    runId: value.runId,
    phase: parsedPhase.data,
    desiredState: "stop",
    updatedAt: value.updatedAt,
  };
}

function parseHumanRunMutationReceipt(value: unknown): { readonly run: ConvexTaskRunView } | null {
  if (!isRecord(value)) return null;
  const run = taskRunViewSchema.safeParse(value.run);
  return run.success ? { run: convexTaskRunView(run.data) } : null;
}

async function anotherBlockingDispatchExists(
  ctx: ReadCtx,
  task: Pick<Doc<"tasks">, "_id" | "organizationId" | "workspaceId">,
  excludedDispatchId: Id<"taskDispatches">,
): Promise<boolean | null> {
  const rows = (
    await Promise.all(
      FAIL_CLOSED_TASK_DISPATCH_PHASES.map(async (phase) =>
        await ctx.db
          .query("taskDispatches")
          .withIndex("by_workspace_task_phase", (query) =>
            query.eq("workspaceId", task.workspaceId).eq("taskId", task._id).eq("phase", phase),
          )
          .take(2),
      ),
    )
  ).flat();
  if (
    rows.some(
      (row) =>
        row.organizationId !== task.organizationId ||
        row.workspaceId !== task.workspaceId ||
        row.taskId !== task._id ||
        !taskDispatchBlocksTaskRelease(row.phase),
    )
  ) {
    return null;
  }
  return rows.some((row) => row._id !== excludedDispatchId);
}

function hostedDispatchTargetTaskId(
  binding: HostedMutationReceiptBinding,
): string {
  if (binding.targetTaskId === undefined) {
    throw new Error("Hosted dispatch attempt has no target task.");
  }
  return binding.targetTaskId;
}

export const createTaskAndDispatch = mutation({
  args: {
    workspaceId: v.string(),
    repositoryId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    type: v.optional(v.union(v.literal("task"), v.literal("bug"), v.literal("feature"), v.literal("epic"), v.literal("chore"))),
    priority: v.optional(v.number()),
    availableAt: v.optional(v.number()),
    parentKey: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    idempotencyKey: v.string(),
    suppliedTaskId: v.optional(v.string()),
    hraOperationId: v.optional(v.string()),
    expectedProjectionHead: v.optional(v.number()),
  },
  returns: createAndDispatchResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (!validPublicScope(args) || !repositoryIdSchema.safeParse(args.repositoryId).success) {
      return domainFailure("VALIDATION_ERROR", requestId);
    }
    const parsed = createTaskRequestSchema.safeParse({
      title: args.title,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.type === undefined ? {} : { type: args.type }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
      ...(args.availableAt === undefined ? {} : { availableAt: args.availableAt }),
      ...(args.parentKey === undefined ? {} : { parentKey: args.parentKey }),
      ...(args.labels === undefined ? {} : { labels: args.labels }),
    });
    if (!parsed.success) return domainFailure("VALIDATION_ERROR", requestId);
    const operation = "tasks.create_and_dispatch";
    const requestDigest = humanTaskMutationDigest(operation, {
      workspaceId: args.workspaceId,
      repositoryId: args.repositoryId,
      ...parsed.data,
      ...(args.suppliedTaskId === undefined
        ? {}
        : { suppliedTaskId: args.suppliedTaskId }),
    });
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "dispatch",
        hostedAttemptOperation: "task.create",
        ...(args.suppliedTaskId === undefined
          ? {}
          : { hostedAttemptSuppliedTaskId: args.suppliedTaskId }),
        hostedAttemptIntent: () => ({
          kind: "task.create",
          title: parsed.data.title,
          ...(parsed.data.description === undefined
            ? {}
            : { description: parsed.data.description }),
          type: parsed.data.type,
          priority: parsed.data.priority,
          ...(parsed.data.availableAt === undefined
            ? {}
            : { availableAt: parsed.data.availableAt }),
          labels: parsed.data.labels ?? [],
          ...(parsed.data.parentKey === undefined
            ? {}
            : { parentKey: parsed.data.parentKey }),
          repositoryId: args.repositoryId,
        }),
        operation,
        parseReceipt: parseCreateAndDispatchReceipt,
        execute: async (command) => {
          const repository = await ctx.db
            .query("workspaceRepositories")
            .withIndex("by_public_id", (query) => query.eq("publicId", args.repositoryId))
            .unique();
          if (
            repository === null ||
            repository.status !== "active" ||
            repository.organizationId !== command.authorization.organization._id ||
            repository.workspaceId !== command.authorization.workspace._id
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          const created = await createHumanTaskRecord(ctx, command, {
            ...parsed.data,
            ...(args.suppliedTaskId === undefined
              ? {}
              : { publicId: args.suppliedTaskId }),
          });
          if (!created.ok) return created;
          const task = requireProjectionAfterProtectedWrite(
            await taskByKey(
              ctx,
              command.authorization.workspace._id,
              created.data.task.key,
            ),
            "createTaskAndDispatch task",
          );
          if (
            task.organizationId !== command.authorization.organization._id ||
            task.workspaceId !== command.authorization.workspace._id
          ) throw new Error("createTaskAndDispatch task projection crossed its tenant.");
          const runId = randomDispatchId("run");
          const dispatchId = await ctx.db.insert("taskDispatches", {
            organizationId: command.authorization.organization._id,
            workspaceId: command.authorization.workspace._id,
            taskId: task._id,
            repositoryId: repository._id,
            publicId: runId,
            taskKey: task.key,
            repositoryPublicId: repository.publicId,
            acceptedThroughSequence: 0,
            queuedByUserId: command.authorization.user._id,
            queuedTaskRevision: task.revision,
            queuedClaimFence: task.claimFence,
            phase: "queued",
            desiredState: "run",
            queuedAt: command.now,
            candidateOrderAt: command.now,
            createdAt: command.now,
            updatedAt: command.now,
          });
          const dispatch = requireProjectionAfterProtectedWrite(
            await ctx.db.get(dispatchId),
            "createTaskAndDispatch dispatch",
          );
          const run = requireProjectionAfterProtectedWrite(
            await runView(ctx, dispatch),
            "createTaskAndDispatch run",
          );
          return { ok: true as const, data: { task: created.data.task, run } };
        },
      },
    );
  },
});

export const requestRunStop = mutation({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    idempotencyKey: v.string(),
    hraOperationId: v.optional(v.string()),
    expectedProjectionHead: v.optional(v.number()),
  },
  returns: stopRunResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (!validPublicScope(args) || !dispatchIdSchema.safeParse(args.runId).success) {
      return domainFailure("VALIDATION_ERROR", requestId);
    }
    const operation = "runs.stop";
    const requestDigest = humanTaskMutationDigest(operation, args);
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "planner",
        hostedAttemptOperation: "dispatch.stop",
        hostedAttemptIntent: () => ({
          kind: "dispatch.stop",
          runId: args.runId,
        }),
        operation,
        parseReceipt: parseStopReceipt,
        execute: async (command) => {
          const dispatch = await ctx.db
            .query("taskDispatches")
            .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
            .unique();
          if (
            dispatch === null ||
            dispatch.organizationId !== command.authorization.organization._id ||
            dispatch.workspaceId !== command.authorization.workspace._id
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          let phase: RunPhase = dispatch.phase;
          if (dispatch.phase === "queued") {
            phase = "cancelled";
            await ctx.db.patch(dispatch._id, {
              phase,
              desiredState: "stop",
              terminalAt: command.now,
              updatedAt: command.now,
            });
          } else if (!isTerminalRunPhase(dispatch.phase) && dispatch.phase !== "cancel_requested") {
            phase = "cancel_requested";
            await ctx.db.patch(dispatch._id, {
              phase,
              desiredState: "stop",
              updatedAt: command.now,
            });
          } else if (isTerminalRunPhase(dispatch.phase)) {
            if (dispatch.desiredState !== "stop") {
              await ctx.db.patch(dispatch._id, {
                desiredState: "stop",
                updatedAt: command.now,
              });
            }
          }
          const interactionsChanged = await expireOpenInteractions(
            ctx,
            dispatch._id,
            command.now,
          );
          if (
            interactionsChanged ||
            dispatch.phase === "queued" ||
            (!isTerminalRunPhase(dispatch.phase) &&
              dispatch.phase !== "cancel_requested") ||
            dispatch.desiredState !== "stop"
          ) {
            await advanceWorkspaceProjectionById(
              ctx,
              dispatch.workspaceId,
              command.now,
            );
          }
          return {
            ok: true as const,
            data: {
              runId: dispatch.publicId,
              phase,
              desiredState: "stop" as const,
              updatedAt: command.now,
            },
          };
        },
      },
    );
  },
});

export const retryRun = mutation({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    taskRevision: v.number(),
    idempotencyKey: v.string(),
    hraOperationId: v.optional(v.string()),
    expectedProjectionHead: v.optional(v.number()),
  },
  returns: humanRunMutationResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !validPublicScope(args) ||
      !dispatchIdSchema.safeParse(args.runId).success ||
      !Number.isSafeInteger(args.taskRevision) ||
      args.taskRevision < 1
    ) {
      return domainFailure("VALIDATION_ERROR", requestId);
    }
    const operation = "runs.retry";
    const requestDigest = humanTaskMutationDigest(operation, args);
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "dispatch",
        hostedAttemptOperation: "dispatch.retry",
        hostedAttemptTargetRunId: args.runId,
        hostedAttemptIntent: (binding) => ({
          kind: "dispatch.retry",
          taskId: hostedDispatchTargetTaskId(binding),
          expectedTaskRevision: args.taskRevision,
          sourceRunId: args.runId,
        }),
        operation,
        parseReceipt: parseHumanRunMutationReceipt,
        execute: async (command) => {
          const source = await ctx.db
            .query("taskDispatches")
            .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
            .unique();
          if (
            source === null ||
            source.organizationId !== command.authorization.organization._id ||
            source.workspaceId !== command.authorization.workspace._id
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          const [
            task,
            repository,
            priorRetries,
            anotherBlocking,
            latestSubmission,
          ] = await Promise.all([
            ctx.db.get(source.taskId),
            ctx.db.get(source.repositoryId),
            ctx.db
              .query("taskDispatches")
              .withIndex("by_workspace_retry_source", (query) =>
                query
                  .eq("workspaceId", command.authorization.workspace._id)
                  .eq("retryOfDispatchId", source._id),
              )
              .take(2),
            anotherBlockingDispatchExists(
              ctx,
              {
                _id: source.taskId,
                organizationId: source.organizationId,
                workspaceId: source.workspaceId,
              },
              source._id,
            ),
            ctx.db
              .query("taskSubmissions")
              .withIndex("by_workspace_task_submitted", (query) =>
                query
                  .eq("workspaceId", source.workspaceId)
                  .eq("taskId", source.taskId),
              )
              .order("desc")
              .first(),
          ]);
          if (
            task === null ||
            repository === null ||
            task.organizationId !== command.authorization.organization._id ||
            task.workspaceId !== command.authorization.workspace._id ||
            repository.organizationId !== command.authorization.organization._id ||
            repository.workspaceId !== command.authorization.workspace._id ||
            repository.status !== "active" ||
            (
              latestSubmission !== null &&
              latestSubmission.organizationId !== source.organizationId
            )
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          if (
            anotherBlocking === null ||
            priorRetries.length > 1 ||
            priorRetries.some(
              (retry) =>
                retry.organizationId !== source.organizationId ||
                retry.workspaceId !== source.workspaceId ||
                retry.taskId !== source.taskId ||
                retry.retryOfDispatchId !== source._id,
            )
          ) {
            return domainFailure("PROJECTION_MISMATCH", command.requestId);
          }
          let sourceFenceMatches = source.queuedClaimFence === task.claimFence;
          if (isBoundDispatch(source)) {
            const claim = await ctx.db.get(source.taskClaimId);
            if (
              claim === null ||
              claim.organizationId !== source.organizationId ||
              claim.workspaceId !== source.workspaceId ||
              claim.taskId !== source.taskId ||
              claim.publicId !== source.taskClaimPublicId ||
              claim.fence !== source.claimFence
            ) {
              return domainFailure("PROJECTION_MISMATCH", command.requestId);
            }
            sourceFenceMatches =
              (
                claim.state === "released" ||
                (
                  source.phase === "submitted" &&
                  claim.state === "submitted"
                )
              ) &&
              claim.fence === task.claimFence &&
              source.claimFence === task.claimFence;
          }
          if (
            !dispatchRetryAllowed({
              sourcePhase: source.phase,
              sourceSubmissionRejected: rejectedSubmissionMatchesDispatch({
                sourceDispatchPublicId: source.publicId,
                ...(latestSubmission === null
                  ? {}
                  : {
                      ...(latestSubmission.dispatchPublicId === undefined
                        ? {}
                        : {
                            submissionDispatchPublicId:
                              latestSubmission.dispatchPublicId,
                          }),
                      submissionStatus: latestSubmission.status,
                    }),
              }),
              taskRevision: task.revision,
              expectedTaskRevision: args.taskRevision,
              taskStatus: task.status,
              taskHasCurrentClaim: task.currentClaim !== undefined,
              sourceFenceMatches,
              anotherDispatchBlocksTask: anotherBlocking,
              sourceAlreadyRetried: priorRetries.length > 0,
            })
          ) {
            return domainFailure("TASK_STATE_CONFLICT", command.requestId, {
              taskKey: task.key,
              currentRevision: task.revision,
            });
          }
          const dispatchId = await ctx.db.insert("taskDispatches", {
            organizationId: source.organizationId,
            workspaceId: source.workspaceId,
            taskId: source.taskId,
            repositoryId: source.repositoryId,
            publicId: randomDispatchId("run"),
            taskKey: source.taskKey,
            repositoryPublicId: source.repositoryPublicId,
            acceptedThroughSequence: 0,
            queuedByUserId: command.authorization.user._id,
            queuedTaskRevision: task.revision,
            queuedClaimFence: task.claimFence,
            retryOfDispatchId: source._id,
            phase: "queued",
            desiredState: "run",
            queuedAt: command.now,
            candidateOrderAt: command.now,
            createdAt: command.now,
            updatedAt: command.now,
          });
          const queued = requireProjectionAfterProtectedWrite(
            await ctx.db.get(dispatchId),
            "retryRun dispatch",
          );
          const run = requireProjectionAfterProtectedWrite(
            await runView(ctx, queued),
            "retryRun run",
          );
          await advanceWorkspaceProjectionById(
            ctx,
            source.workspaceId,
            command.now,
          );
          return { ok: true as const, data: { run } };
        },
      },
    );
  },
});

export const abandonAmbiguousRun = mutation({
  args: {
    workspaceId: v.string(),
    runId: v.string(),
    taskRevision: v.number(),
    reason: v.union(v.literal("confirmed_cancelled"), v.literal("declared_failed")),
    idempotencyKey: v.string(),
    hraOperationId: v.optional(v.string()),
    expectedProjectionHead: v.optional(v.number()),
  },
  returns: humanRunMutationResultValidator,
  handler: async (ctx, args) => {
    const requestId = randomRequestId();
    if (
      !validPublicScope(args) ||
      !dispatchIdSchema.safeParse(args.runId).success ||
      !Number.isSafeInteger(args.taskRevision) ||
      args.taskRevision < 1
    ) {
      return domainFailure("VALIDATION_ERROR", requestId);
    }
    const operation = "runs.abandon_ambiguous";
    const requestDigest = humanTaskMutationDigest(operation, args);
    return await runHumanTaskMutation(
      ctx,
      { ...args, requestDigest, requestId },
      {
        capability: "dispatch",
        hostedAttemptOperation: "dispatch.resolve_ambiguity",
        hostedAttemptTargetRunId: args.runId,
        hostedAttemptIntent: (binding) => ({
          kind: "dispatch.resolve_ambiguity",
          taskId: hostedDispatchTargetTaskId(binding),
          expectedTaskRevision: args.taskRevision,
          sourceRunId: args.runId,
          reason: args.reason,
        }),
        operation,
        parseReceipt: parseHumanRunMutationReceipt,
        execute: async (command) => {
          const source = await ctx.db
            .query("taskDispatches")
            .withIndex("by_public_id", (query) => query.eq("publicId", args.runId))
            .unique();
          if (
            source === null ||
            source.organizationId !== command.authorization.organization._id ||
            source.workspaceId !== command.authorization.workspace._id
          ) {
            return domainFailure("NOT_FOUND", command.requestId);
          }
          if (!isBoundDispatch(source) || source.phase !== "ambiguous") {
            return domainFailure("TASK_STATE_CONFLICT", command.requestId);
          }
          const [task, claim, anotherBlocking] = await Promise.all([
            ctx.db.get(source.taskId),
            ctx.db.get(source.taskClaimId),
            anotherBlockingDispatchExists(
              ctx,
              {
                _id: source.taskId,
                organizationId: source.organizationId,
                workspaceId: source.workspaceId,
              },
              source._id,
            ),
          ]);
          if (
            task === null ||
            claim === null ||
            task.organizationId !== command.authorization.organization._id ||
            task.workspaceId !== command.authorization.workspace._id ||
            claim.organizationId !== source.organizationId ||
            claim.workspaceId !== source.workspaceId ||
            claim.taskId !== source.taskId ||
            claim.publicId !== source.taskClaimPublicId ||
            claim.fence !== source.claimFence
          ) {
            return domainFailure("PROJECTION_MISMATCH", command.requestId);
          }
          if (anotherBlocking === null) {
            return domainFailure("PROJECTION_MISMATCH", command.requestId);
          }
          const sourceFenceMatches =
            claim.state === "active" &&
            claim.fence === task.claimFence &&
            source.claimFence === task.claimFence &&
            activeClaimMatchesTask(task, claim);
          const outcome = resolvedAmbiguousDispatchPhase(
            {
              sourcePhase: source.phase,
              taskRevision: task.revision,
              expectedTaskRevision: args.taskRevision,
              taskStatus: task.status,
              taskHasCurrentClaim: task.currentClaim !== undefined,
              sourceFenceMatches,
              anotherDispatchBlocksTask: anotherBlocking,
            },
            args.reason satisfies AmbiguousDispatchResolutionReason,
          );
          if (outcome === null) {
            return domainFailure("TASK_STATE_CONFLICT", command.requestId, {
              taskKey: task.key,
              currentRevision: task.revision,
            });
          }
          const released = await releaseRunTaskClaim(
            ctx,
            source,
            command.actor,
            command.now,
            command.requestId,
            command.idempotencyKey,
          );
          if (!released.ok) return released;
          const humanResolution = {
            reason: args.reason,
            resolvedByUserId: command.authorization.user._id,
            resolvedAt: command.now,
          };
          if (outcome === "cancelled") {
            await ctx.db.patch(source._id, {
              phase: outcome,
              desiredState: "stop",
              failureKind: undefined,
              humanResolution,
              terminalAt: command.now,
              updatedAt: command.now,
            });
          } else {
            await ctx.db.patch(source._id, {
              phase: outcome,
              failureKind: source.failureKind,
              humanResolution,
              terminalAt: command.now,
              updatedAt: command.now,
            });
          }
          const resolved = requireProjectionAfterProtectedWrite(
            await ctx.db.get(source._id),
            "abandonAmbiguousRun dispatch",
          );
          const run = requireProjectionAfterProtectedWrite(
            await runView(ctx, resolved),
            "abandonAmbiguousRun run",
          );
          await advanceWorkspaceProjectionById(
            ctx,
            source.workspaceId,
            command.now,
          );
          return { ok: true as const, data: { run } };
        },
      },
    );
  },
});
