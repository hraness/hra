import { scheduledChatRunIdSchema } from "@hraness/agent-tasks-protocol";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { randomCrockford } from "./domain";

const SWEEP_BATCH_SIZE = 64;
const TERMINAL_RUN_PURGE_BATCH_SIZE = 64;
const scheduledResultValidator = v.object({
  status: v.union(v.literal("applied"), v.literal("rescheduled"), v.literal("stale")),
});

type WakeArgs = Readonly<{
  scheduleId: Id<"syncScheduledChats">;
  wakeId: Id<"syncScheduledChatWakes">;
  generation: string;
  occurrenceSequence: string;
  expectedRunAt: number;
}>;

const wakeScheduledChatReference = makeFunctionReference<
  "mutation",
  WakeArgs,
  Readonly<{ status: "applied" | "rescheduled" | "stale" }>
>("sessionSyncScheduledChats:wakeScheduledChat");
const sweepDueScheduledChatsReference = makeFunctionReference<
  "mutation",
  Record<string, never>,
  null
>("sessionSyncScheduledChats:sweepDueScheduledChats");

/** Exact ownership check shared with deterministic regression tests. */
export function scheduledChatWakeTupleMatches(input: Readonly<{
  scheduledScheduleId: string;
  scheduledWakeId: string;
  scheduledGeneration: string;
  scheduledOccurrenceSequence: string;
  scheduledExpectedRunAt: number;
  schedule: Pick<
    Doc<"syncScheduledChats">,
    "_id" | "vaultId" | "sessionEntryId" | "originDeviceId" | "generation"
      | "occurrenceSequence" | "nextRunAt"
  >;
  wake: Pick<
    Doc<"syncScheduledChatWakes">,
    "_id" | "scheduleId" | "vaultId" | "sessionEntryId" | "originDeviceId"
      | "generation" | "occurrenceSequence" | "expectedRunAt"
  >;
}>): boolean {
  const { schedule, wake } = input;
  return input.scheduledScheduleId === schedule._id
    && input.scheduledWakeId === wake._id
    && wake.scheduleId === schedule._id
    && wake.vaultId === schedule.vaultId
    && wake.sessionEntryId === schedule.sessionEntryId
    && wake.originDeviceId === schedule.originDeviceId
    && input.scheduledGeneration === schedule.generation
    && input.scheduledGeneration === wake.generation
    && input.scheduledOccurrenceSequence === schedule.occurrenceSequence
    && input.scheduledOccurrenceSequence === wake.occurrenceSequence
    && input.scheduledExpectedRunAt === schedule.nextRunAt
    && input.scheduledExpectedRunAt === wake.expectedRunAt;
}

/** Head-restart paging avoids cursor skips as due rows leave the pending index. */
export function nextScheduledChatSweepArgs(
  isDone: boolean,
): Readonly<Record<string, never>> | null {
  return isDone ? null : {};
}

async function uniqueRunId(
  ctx: MutationCtx,
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = scheduledChatRunIdSchema.parse(`syncrun_${randomCrockford(26)}`);
    const existing = await ctx.db
      .query("syncScheduledChatRuns")
      .withIndex("by_public_id", (query) => query.eq("runId", candidate))
      .unique();
    if (existing === null) return candidate;
  }
  throw new Error("scheduled chat run ID collision budget exhausted");
}

export const wakeScheduledChat = internalMutation({
  args: {
    scheduleId: v.id("syncScheduledChats"),
    wakeId: v.id("syncScheduledChatWakes"),
    generation: v.string(),
    occurrenceSequence: v.string(),
    expectedRunAt: v.number(),
  },
  returns: scheduledResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const [schedule, wake] = await Promise.all([
      ctx.db.get(args.scheduleId),
      ctx.db.get(args.wakeId),
    ]);
    if (schedule === null || wake === null) return { status: "stale" as const };
    const exact = scheduledChatWakeTupleMatches({
      scheduledScheduleId: args.scheduleId,
      scheduledWakeId: args.wakeId,
      scheduledGeneration: args.generation,
      scheduledOccurrenceSequence: args.occurrenceSequence,
      scheduledExpectedRunAt: args.expectedRunAt,
      schedule,
      wake,
    });
    if (!exact || wake.state !== "pending") return { status: "stale" as const };
    if (schedule.state !== "active") {
      await ctx.db.delete(wake._id);
      return { status: "stale" as const };
    }
    const [vault, entry, device] = await Promise.all([
      ctx.db.get(schedule.vaultId),
      ctx.db.get(schedule.sessionEntryId),
      ctx.db.get(schedule.originDeviceId),
    ]);
    if (
      vault === null
      || vault.status !== "active"
      || entry === null
      || entry.state !== "active"
      || entry.vaultId !== schedule.vaultId
      || entry.originDeviceId !== schedule.originDeviceId
      || entry.sessionId !== schedule.sessionId
      || device === null
      || device.status !== "active"
      || device.vaultId !== schedule.vaultId
      || device.deviceId !== schedule.originDevicePublicId
    ) {
      await ctx.db.delete(wake._id);
      await ctx.db.patch(schedule._id, {
        state: "cleared",
        nextRunAt: undefined,
        clearedBy: "authority_lost",
        clearedAt: now,
        updatedAt: now,
      });
      return { status: "stale" as const };
    }
    if (now < args.expectedRunAt) {
      await ctx.scheduler.runAt(args.expectedRunAt, wakeScheduledChatReference, args);
      return { status: "rescheduled" as const };
    }
    const exactRuns = await ctx.db
      .query("syncScheduledChatRuns")
      .withIndex("by_schedule_generation_and_sequence", (query) =>
        query
          .eq("scheduleId", schedule._id)
          .eq("generation", args.generation)
          .eq("occurrenceSequence", args.occurrenceSequence),
      )
      .take(2);
    if (exactRuns.length > 1) throw new Error("scheduled chat occurrence is not unique");
    const exactRun = exactRuns[0];
    if (exactRun !== undefined) {
      if (
        exactRun.scheduledFor !== args.expectedRunAt
        || exactRun.definitionCiphertextDigest !== schedule.definitionCiphertextDigest
        || exactRun.definitionEnvelopeJson !== schedule.definitionEnvelopeJson
      ) throw new Error("scheduled chat occurrence tuple is incoherent");
      await ctx.db.delete(wake._id);
      return { status: exactRun.state === "pending" ? "applied" as const : "stale" as const };
    }
    const outstanding = await ctx.db
      .query("syncScheduledChatRuns")
      .withIndex("by_schedule_and_state", (query) =>
        query.eq("scheduleId", schedule._id).eq("state", "pending"),
      )
      .take(2);
    if (outstanding.length > 0) {
      await ctx.db.delete(wake._id);
      return { status: "stale" as const };
    }
    await ctx.db.insert("syncScheduledChatRuns", {
      scheduleId: schedule._id,
      vaultId: schedule.vaultId,
      sessionEntryId: schedule.sessionEntryId,
      sessionId: schedule.sessionId,
      originDeviceId: schedule.originDeviceId,
      runId: await uniqueRunId(ctx),
      generation: schedule.generation,
      occurrenceSequence: schedule.occurrenceSequence,
      scheduledFor: args.expectedRunAt,
      definitionCiphertextDigest: schedule.definitionCiphertextDigest,
      definitionEnvelopeJson: schedule.definitionEnvelopeJson,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.delete(wake._id);
    return { status: "applied" as const };
  },
});

export const sweepDueScheduledChats = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const [acknowledgedRuns, cancelledRuns] = await Promise.all([
      ctx.db
        .query("syncScheduledChatRuns")
        .withIndex("by_state_and_purge_after", (query) =>
          query.eq("state", "acknowledged").lte("purgeAfter", now),
        )
        .take(TERMINAL_RUN_PURGE_BATCH_SIZE),
      ctx.db
        .query("syncScheduledChatRuns")
        .withIndex("by_state_and_purge_after", (query) =>
          query.eq("state", "cancelled").lte("purgeAfter", now),
        )
        .take(TERMINAL_RUN_PURGE_BATCH_SIZE),
    ]);
    const terminalRuns = [...acknowledgedRuns, ...cancelledRuns];
    for (const run of terminalRuns) {
      await ctx.db.delete(run._id);
    }
    const due = await ctx.db
      .query("syncScheduledChatWakes")
      .withIndex("by_state_and_due", (query) =>
        query.eq("state", "pending").lte("expectedRunAt", now),
      )
      .take(SWEEP_BATCH_SIZE);
    for (const wake of due) {
      await ctx.scheduler.runAfter(0, wakeScheduledChatReference, {
        scheduleId: wake.scheduleId,
        wakeId: wake._id,
        generation: wake.generation,
        occurrenceSequence: wake.occurrenceSequence,
        expectedRunAt: wake.expectedRunAt,
      });
    }
    const next = nextScheduledChatSweepArgs(
      due.length < SWEEP_BATCH_SIZE
      && acknowledgedRuns.length < TERMINAL_RUN_PURGE_BATCH_SIZE
      && cancelledRuns.length < TERMINAL_RUN_PURGE_BATCH_SIZE,
    );
    if (next !== null) {
      await ctx.scheduler.runAfter(0, sweepDueScheduledChatsReference, next);
    }
    return null;
  },
});
