import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { scheduledDispatchExpiryDisposition } from "./dispatchLaws";
import {
  reconcileSubmittedDispatch,
  requeueLeasedDispatch,
} from "./dispatchReconciliation";
import { expireOpenInteractions } from "./dispatchInteractions";
import { advanceWorkspaceProjectionById } from "./hraProjection";
import {
  loadTaskDispatchGuard,
  type TaskDispatchGuard,
} from "./dispatchSafety";
import { isTaskReady } from "./domain";
import { appendTaskEvent } from "./events";
import {
  activeClaimMatchesTask,
  ensureCounterProjection,
  queueTaskClaimRepair,
} from "./workGraph";
import { scheduledClaimDisposition } from "./workGraphLaws";

const scheduledResultValidator = v.object({
  status: v.union(v.literal("applied"), v.literal("rescheduled"), v.literal("stale")),
});
const SCHEDULE_REQUEST_ID = "req_00000000000000000000000000";
const SWEEP_BATCH_SIZE = 64;

/**
 * Sweep jobs remove processed rows from their qualifying index. Restarting
 * each bounded page at the head avoids continuation-cursor skips when those
 * removals race the chained sweep; duplicate scheduled item jobs are already
 * generation-checked and idempotent.
 */
export function nextSweepArgs(isDone: boolean): Readonly<Record<string, never>> | null {
  return isDone ? null : {};
}

export function overdueClaimSweepDisposition(input: {
  readonly dispatchGuardKind: TaskDispatchGuard["kind"];
  readonly sweepSuppressed: boolean | undefined;
}): "expire" | "protected" | "suppress" {
  if (input.dispatchGuardKind === "clear") return "expire";
  return input.sweepSuppressed === true ? "protected" : "suppress";
}

export function scheduledWakeTupleMatches(input: {
  readonly scheduledTaskId: string;
  readonly loadedTaskId: string;
  readonly taskOrganizationId: string;
  readonly taskWorkspaceId: string;
  readonly wakeTaskId: string;
  readonly wakeOrganizationId: string;
  readonly wakeWorkspaceId: string;
  readonly scheduledGeneration: number;
  readonly wakeGeneration: number;
  readonly scheduledDeadline: number;
  readonly wakeDeadline: number;
}): boolean {
  return (
    input.loadedTaskId === input.scheduledTaskId &&
    input.wakeTaskId === input.loadedTaskId &&
    input.wakeOrganizationId === input.taskOrganizationId &&
    input.wakeWorkspaceId === input.taskWorkspaceId &&
    input.wakeGeneration === input.scheduledGeneration &&
    input.wakeDeadline === input.scheduledDeadline
  );
}

interface ScheduledWakeTaskTuple {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly key: string;
  readonly revision: number;
  readonly claimFence: number;
}

interface ScheduledWakeQueuedDispatchTuple {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly phase: string;
  readonly queuedTaskRevision: number;
  readonly queuedClaimFence: number;
}

export function scheduledWakeDispatchDisposition(input: {
  readonly queuedDispatchCount: number;
  readonly task: ScheduledWakeTaskTuple;
  readonly queuedDispatch?: ScheduledWakeQueuedDispatchTuple | undefined;
}): "none" | "advance" | "invalid" {
  if (input.queuedDispatchCount === 0) return "none";
  const dispatch = input.queuedDispatch;
  return input.queuedDispatchCount === 1 &&
    dispatch !== undefined &&
    dispatch.organizationId === input.task.organizationId &&
    dispatch.workspaceId === input.task.workspaceId &&
    dispatch.taskId === input.task.id &&
    dispatch.taskKey === input.task.key &&
    dispatch.phase === "queued" &&
    dispatch.queuedTaskRevision === input.task.revision &&
    dispatch.queuedClaimFence === input.task.claimFence
    ? "advance"
    : "invalid";
}

export const expireClaim = internalMutation({
  args: {
    taskId: v.id("tasks"),
    claimId: v.id("taskClaims"),
    fence: v.number(),
    leaseGeneration: v.number(),
    expectedDeadline: v.number(),
  },
  returns: scheduledResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const [task, claim] = await Promise.all([ctx.db.get(args.taskId), ctx.db.get(args.claimId)]);
    if (task === null || claim === null) return { status: "stale" as const };
    const disposition = scheduledClaimDisposition({
      activeTupleMatches: activeClaimMatchesTask(task, claim),
      scheduledClaimId: args.claimId,
      currentClaimId: task.currentClaim?.claimId,
      scheduledFence: args.fence,
      currentFence: task.currentClaim?.fence,
      scheduledLeaseGeneration: args.leaseGeneration,
      currentLeaseGeneration: task.currentClaim?.leaseGeneration,
      scheduledDeadline: args.expectedDeadline,
      currentLeaseUntil: task.currentClaim?.leaseUntil,
      now,
    });
    if (disposition === "stale") {
      await queueTaskClaimRepair(ctx, task, now);
      return { status: "stale" as const };
    }
    if (disposition === "reschedule") {
      await ctx.scheduler.runAt(args.expectedDeadline, internal.schedules.expireClaim, args);
      return { status: "rescheduled" as const };
    }
    const dispatchGuard = await loadTaskDispatchGuard(ctx, task);
    const sweepDisposition = overdueClaimSweepDisposition({
      dispatchGuardKind: dispatchGuard.kind,
      sweepSuppressed: claim.sweepSuppressed,
    });
    if (sweepDisposition !== "expire") {
      // A dispatch reservation intentionally keeps this expired task claim
      // fail-closed until a proved terminal or explicit ambiguity resolution.
      // Remove it from the generic sweep index so one protected claim cannot
      // permanently starve unrelated overdue claims at the index head.
      if (sweepDisposition === "suppress") {
        await ctx.db.patch(claim._id, { sweepSuppressed: true, updatedAt: now });
      }
      return { status: "stale" as const };
    }
    const projection = await ensureCounterProjection(ctx, task, now, SCHEDULE_REQUEST_ID);
    if (!projection.ok) return { status: "stale" as const };
    const nextRevision = task.revision + 1;
    const ready =
      task.availableAt <= now &&
      projection.actual.unresolved === 0 &&
      projection.actual.cancelled === 0;
    await ctx.db.patch(claim._id, { state: "expired", endedAt: now, updatedAt: now });
    await ctx.db.patch(task._id, {
      status: "open",
      currentClaim: undefined,
      isReady: ready,
      ...(ready ? { readySince: now } : { readySince: undefined }),
      revision: nextRevision,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: nextRevision,
      type: "task.claim_expired",
      actor: { kind: "system", jobKind: "claim_expiry", sourceId: claim.publicId },
      command: { kind: "system", jobKind: "claim_expiry" },
      payload: { fence: args.fence },
      now,
    });
    return { status: "applied" as const };
  },
});

export const expireDispatch = internalMutation({
  args: {
    dispatchId: v.id("taskDispatches"),
    runnerId: v.id("dispatchRunners"),
    bootId: v.string(),
    bootGeneration: v.number(),
    taskClaimId: v.id("taskClaims"),
    claimFence: v.number(),
    leaseGeneration: v.number(),
    expectedDeadline: v.number(),
  },
  returns: scheduledResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const dispatch = await ctx.db.get(args.dispatchId);
    const disposition = scheduledDispatchExpiryDisposition(
      dispatch !== null && "runnerId" in dispatch
        ? {
            dispatchId: dispatch._id,
            runnerId: dispatch.runnerId,
            bootId: dispatch.bootId,
            bootGeneration: dispatch.bootGeneration,
            taskClaimId: dispatch.taskClaimId,
            claimFence: dispatch.claimFence,
            leaseGeneration: dispatch.leaseGeneration,
            leaseUntil: dispatch.leaseUntil,
            phase: dispatch.phase,
          }
        : null,
      args,
      now,
    );
    if (disposition === "stale") return { status: "stale" as const };
    if (disposition === "reschedule") {
      await ctx.scheduler.runAt(args.expectedDeadline, internal.schedules.expireDispatch, args);
      return { status: "rescheduled" as const };
    }
    if (
      disposition === "requeue" &&
      dispatch !== null &&
      "runnerId" in dispatch &&
      await requeueLeasedDispatch(ctx, dispatch, now)
    ) {
      return { status: "applied" as const };
    }
    if (
      dispatch !== null &&
      "runnerId" in dispatch &&
      await reconcileSubmittedDispatch(ctx, dispatch, now)
    ) {
      return { status: "applied" as const };
    }
    if (dispatch === null || !("runnerId" in dispatch)) {
      return { status: "stale" as const };
    }
    await ctx.db.patch(args.dispatchId, {
      phase: "ambiguous",
      failureKind: "lease_lost",
      terminalAt: now,
      updatedAt: now,
    });
    // No runner may consume an answer after this exact lease expires. Remove
    // every sealed response immediately instead of retaining ciphertext until
    // the request's later one-hour deadline or a future runner takeover.
    await expireOpenInteractions(ctx, args.dispatchId, now);
    await advanceWorkspaceProjectionById(ctx, dispatch.workspaceId, now);
    return { status: "applied" as const };
  },
});

export const wakeTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    wakeId: v.id("taskWakes"),
    generation: v.number(),
    expectedAvailableAt: v.number(),
  },
  returns: scheduledResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const [task, wake] = await Promise.all([ctx.db.get(args.taskId), ctx.db.get(args.wakeId)]);
    if (task === null || wake === null) return { status: "stale" as const };
    const ownsScheduledTuple = scheduledWakeTupleMatches({
      scheduledTaskId: args.taskId,
      loadedTaskId: task._id,
      taskOrganizationId: task.organizationId,
      taskWorkspaceId: task.workspaceId,
      wakeTaskId: wake.taskId,
      wakeOrganizationId: wake.organizationId,
      wakeWorkspaceId: wake.workspaceId,
      scheduledGeneration: args.generation,
      wakeGeneration: wake.generation,
      scheduledDeadline: args.expectedAvailableAt,
      wakeDeadline: wake.expectedAvailableAt,
    });
    if (!ownsScheduledTuple || wake.state !== "pending") {
      return { status: "stale" as const };
    }
    if (
      task.wakeGeneration !== args.generation ||
      task.availableAt !== args.expectedAvailableAt ||
      task.status !== "open"
    ) {
      await ctx.db.patch(wake._id, { state: "stale", completedAt: now });
      return { status: "stale" as const };
    }
    if (now < args.expectedAvailableAt) {
      await ctx.scheduler.runAt(args.expectedAvailableAt, internal.schedules.wakeTask, args);
      return { status: "rescheduled" as const };
    }
    const ready = isTaskReady(task, now);
    const queuedDispatches = ready && !task.isReady
      ? await ctx.db
          .query("taskDispatches")
          .withIndex("by_workspace_task_phase", (query) =>
            query
              .eq("workspaceId", task.workspaceId)
              .eq("taskId", task._id)
              .eq("phase", "queued"),
          )
          .take(2)
      : [];
    const queuedDispatch = queuedDispatches[0];
    const dispatchDisposition = scheduledWakeDispatchDisposition({
      queuedDispatchCount: queuedDispatches.length,
      task: {
        id: task._id,
        organizationId: task.organizationId,
        workspaceId: task.workspaceId,
        key: task.key,
        revision: task.revision,
        claimFence: task.claimFence,
      },
      ...(queuedDispatch === undefined ? {} : { queuedDispatch }),
    });
    if (dispatchDisposition === "invalid") {
      throw new Error("Scheduled wake found an invalid queued dispatch projection.");
    }
    await ctx.db.patch(wake._id, { state: "completed", completedAt: now });
    if (!ready || task.isReady) return { status: "applied" as const };
    const nextRevision = task.revision + 1;
    if (dispatchDisposition === "advance" && queuedDispatch !== undefined) {
      await ctx.db.patch(queuedDispatch._id, {
        queuedTaskRevision: nextRevision,
        candidateOrderAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(task._id, {
      isReady: true,
      readySince: now,
      revision: nextRevision,
      updatedAt: now,
    });
    await appendTaskEvent(ctx, {
      organizationId: task.organizationId,
      workspaceId: task.workspaceId,
      taskId: task._id,
      taskPublicId: task.publicId,
      taskRevision: nextRevision,
      type: "task.became_ready",
      actor: {
        kind: "system",
        jobKind: "defer_wake",
        sourceId: `wake:${task.publicId}:${args.generation}`,
      },
      command: { kind: "system", jobKind: "defer_wake" },
      payload: {},
      now,
    });
    return { status: "applied" as const };
  },
});

export const sweepOverdueClaims = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({ scheduled: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const page = await ctx.db
      .query("taskClaims")
      .withIndex("by_sweep_suppressed_state_deadline", (builder) =>
        builder
          .eq("sweepSuppressed", undefined)
          .eq("state", "active")
          .lte("leaseUntil", now),
      )
      .paginate({ cursor: null, numItems: SWEEP_BATCH_SIZE });
    for (const claim of page.page) {
      await ctx.scheduler.runAfter(0, internal.schedules.expireClaim, {
        taskId: claim.taskId,
        claimId: claim._id,
        fence: claim.fence,
        leaseGeneration: claim.leaseGeneration,
        expectedDeadline: claim.leaseUntil,
      });
    }
    const nextArgs = nextSweepArgs(page.isDone);
    if (nextArgs !== null) {
      await ctx.scheduler.runAfter(0, internal.schedules.sweepOverdueClaims, nextArgs);
    }
    return {
      scheduled: page.page.length,
      hasMore: nextArgs !== null,
    };
  },
});

export const sweepDueWakes = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({ scheduled: v.number(), hasMore: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const page = await ctx.db
      .query("taskWakes")
      .withIndex("by_state_and_available", (builder) =>
        builder.eq("state", "pending").lte("expectedAvailableAt", now),
      )
      .paginate({ cursor: null, numItems: SWEEP_BATCH_SIZE });
    for (const wake of page.page) {
      await ctx.scheduler.runAfter(0, internal.schedules.wakeTask, {
        taskId: wake.taskId,
        wakeId: wake._id,
        generation: wake.generation,
        expectedAvailableAt: wake.expectedAvailableAt,
      });
    }
    const nextArgs = nextSweepArgs(page.isDone);
    if (nextArgs !== null) {
      await ctx.scheduler.runAfter(0, internal.schedules.sweepDueWakes, nextArgs);
    }
    return {
      scheduled: page.page.length,
      hasMore: nextArgs !== null,
    };
  },
});
