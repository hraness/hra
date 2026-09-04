import { v } from "convex/values";
import type { GenericId as Id } from "convex/values";

import {
  isSafePositiveInteger,
  isUuidV7,
} from "../src/cloud/contracts";
import {
  requireDeviceAuthority,
} from "./authority";
import { commandTerminalRetentionMs } from "./commands";
import {
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  releaseQuotaForDelete,
} from "./quota";
import {
  internalMutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./server";

const maximumRevocationBatch = 200;

const revocationCategoryOrder = [
  "sessions",
  "leases",
  "commands",
  "bindings",
  "custody",
  "presence",
  "complete",
] as const;

type RevocationCategory = typeof revocationCategoryOrder[number];
type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

type CleanupResult = Readonly<{
  processed: number;
}>;

export const DEVICE_REVOCATION_SCHEMA_GAPS = Object.freeze([] as const);

function rejectRevocation(): never {
  throw new Error("Device revocation status is unavailable.");
}

function requireRevocationLimit(value: number): number {
  if (!isSafePositiveInteger(value) || value > maximumRevocationBatch) {
    throw new Error("Invalid device revocation batch.");
  }
  return value;
}

async function matchingJob(ctx: ReadCtx, jobId: string) {
  const matches = await ctx.db
    .query("deviceRevocationJobs")
    .withIndex("by_public_id", (builder) => builder.eq("publicId", jobId))
    .take(2);
  if (matches.length > 1) rejectRevocation();
  return matches[0] ?? null;
}

function nextCategory(category: RevocationCategory): RevocationCategory {
  const index = revocationCategoryOrder.indexOf(category);
  if (index < 0 || index === revocationCategoryOrder.length - 1) return "complete";
  return revocationCategoryOrder[index + 1] ?? "complete";
}

function nextUpdateTime(previous: number): number {
  return Math.max(Date.now(), previous + 1);
}

async function orphanSessions(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  userId: Id<"users">,
  limit: number,
): Promise<CleanupResult> {
  const active = await ctx.db.query("sessionHeads")
    .withIndex("by_execution_device_and_state", (builder) => builder
      .eq("executionDeviceId", deviceId)
      .eq("state", "active"))
    .take(limit);
  const remaining = limit - active.length;
  const idle = remaining === 0
    ? []
    : await ctx.db.query("sessionHeads")
      .withIndex("by_execution_device_and_state", (builder) => builder
        .eq("executionDeviceId", deviceId)
        .eq("state", "idle"))
      .take(remaining);
  const sessions = [...active, ...idle];
  const now = Date.now();
  for (const session of sessions) {
    const sessionPatch = { state: "orphaned" as const, updatedAt: now };
    await adjustQuotaForPatch(ctx, userId, "session", session, sessionPatch);
    await ctx.db.patch(session._id, sessionPatch);
  }
  return { processed: sessions.length };
}

async function deleteLeases(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  userId: Id<"users">,
  limit: number,
): Promise<CleanupResult> {
  const leases = await ctx.db.query("executionLeases")
    .withIndex("by_device", (builder) => builder.eq("deviceId", deviceId))
    .take(limit);
  for (const lease of leases) {
    await releaseQuotaForDelete(ctx, userId, "session", lease);
    await ctx.db.delete(lease._id);
  }
  return { processed: leases.length };
}

function revokedCommandTerminalFields(
  command: Readonly<{ requesterAcknowledgedAt?: number }>,
  now: number,
) {
  return {
    nonterminal: false,
    terminalCleanupAfter: command.requesterAcknowledgedAt === undefined
      ? undefined
      : now + commandTerminalRetentionMs,
  } as const;
}

async function terminalizeCommands(
  ctx: MutationCtx,
  input: Readonly<{
    deviceId: Id<"devices">;
    limit: number;
    userId: Id<"users">;
  }>,
): Promise<CleanupResult> {
  const targeted = await ctx.db.query("sessionCommands")
    .withIndex("by_target_nonterminal_and_created_at", (builder) => builder
      .eq("targetDeviceId", input.deviceId)
      .eq("nonterminal", true))
    .take(input.limit);
  let remaining = input.limit - targeted.length;

  // A revoked requester can no longer acknowledge or cancel commands that it
  // sent to another device. Include those effects in the revocation drain.
  const requestedCandidates = remaining === 0
    ? []
    : await ctx.db.query("sessionCommands")
      .withIndex("by_requesting_device_and_nonterminal", (builder) => builder
        .eq("requestingDeviceId", input.deviceId)
        .eq("nonterminal", true))
      .take(remaining);
  const targetedIds = new Set(targeted.map((command) => String(command._id)));
  const requested = requestedCandidates.filter((command) =>
    !targetedIds.has(String(command._id)));
  remaining -= requested.length;
  const records = [...targeted, ...requested];
  const now = Date.now();
  for (const command of records) {
    if (command.state === "pending" || command.state === "prepared") {
      const commandPatch = {
        ...revokedCommandTerminalFields(command, now),
        state: "cancelled" as const,
        updatedAt: now,
      };
      await adjustCommandQuotaForPatch(ctx, input.userId, command, commandPatch);
      await ctx.db.patch(command._id, commandPatch);
    } else if (command.state === "effect_started") {
      const commandPatch = {
        ...revokedCommandTerminalFields(command, now),
        state: "ambiguous" as const,
        updatedAt: now,
      };
      await adjustCommandQuotaForPatch(ctx, input.userId, command, commandPatch);
      await ctx.db.patch(command._id, commandPatch);
    } else {
      rejectRevocation();
    }
  }
  return { processed: records.length };
}

async function deleteAccountBindings(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  userId: Id<"users">,
  limit: number,
): Promise<CleanupResult> {
  const bindings = await ctx.db.query("deviceAccountBindings")
    .withIndex("by_device_and_account", (builder) => builder.eq("deviceId", deviceId))
    .take(limit);
  for (const binding of bindings) {
    await releaseQuotaForDelete(ctx, userId, "account", binding);
    await ctx.db.delete(binding._id);
  }
  return { processed: bindings.length };
}

async function deleteCustody(
  ctx: MutationCtx,
  input: Readonly<{
    deviceId: Id<"devices">;
    limit: number;
    userId: Id<"users">;
  }>,
): Promise<CleanupResult> {
  let remaining = input.limit;
  const sessions = await ctx.db.query("deviceSessions")
    .withIndex("by_device", (builder) => builder.eq("deviceId", input.deviceId))
    .take(remaining);
  for (const session of sessions) {
    await releaseQuotaForDelete(ctx, input.userId, "custody", session);
    await ctx.db.delete(session._id);
  }
  remaining -= sessions.length;
  if (remaining === 0) return { processed: input.limit };

  const challenges = await ctx.db.query("deviceBindChallenges")
    .withIndex("by_device", (builder) => builder.eq("deviceId", input.deviceId))
    .take(remaining);
  for (const challenge of challenges) {
    await releaseQuotaForDelete(ctx, input.userId, "custody", challenge);
    await ctx.db.delete(challenge._id);
  }
  remaining -= challenges.length;
  if (remaining === 0) return { processed: input.limit };

  const envelopes = await ctx.db.query("deviceKeyEnvelopes")
    .withIndex("by_device_and_version", (builder) => builder.eq("deviceId", input.deviceId))
    .take(remaining);
  for (const envelope of envelopes) {
    await releaseQuotaForDelete(ctx, input.userId, "custody", envelope);
    await ctx.db.delete(envelope._id);
  }
  remaining -= envelopes.length;
  if (remaining === 0) return { processed: input.limit };

  const registries = await ctx.db.query("deviceRegistries")
    .withIndex("by_device", (builder) => builder.eq("deviceId", input.deviceId))
    .take(remaining);
  for (const registry of registries) {
    await releaseQuotaForDelete(ctx, input.userId, "custody", registry);
    await ctx.db.delete(registry._id);
  }
  remaining -= registries.length;
  return { processed: input.limit - remaining };
}

async function deletePresence(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  userId: Id<"users">,
  limit: number,
): Promise<CleanupResult> {
  const records = await ctx.db.query("devicePresence")
    .withIndex("by_device", (builder) => builder.eq("deviceId", deviceId))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, userId, "device", record);
    await ctx.db.delete(record._id);
  }
  return { processed: records.length };
}

async function cleanCategory(
  ctx: MutationCtx,
  input: Readonly<{
    category: RevocationCategory;
    deviceId: Id<"devices">;
    limit: number;
    userId: Id<"users">;
  }>,
): Promise<CleanupResult> {
  switch (input.category) {
    case "sessions":
      return await orphanSessions(ctx, input.deviceId, input.userId, input.limit);
    case "leases":
      return await deleteLeases(ctx, input.deviceId, input.userId, input.limit);
    case "commands":
      return await terminalizeCommands(ctx, input);
    case "bindings":
      return await deleteAccountBindings(ctx, input.deviceId, input.userId, input.limit);
    case "custody":
      return await deleteCustody(ctx, input);
    case "presence":
      return await deletePresence(ctx, input.deviceId, input.userId, input.limit);
    case "complete":
      return { processed: 0 };
  }
}

export const status = query({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isUuidV7(args.jobId)) rejectRevocation();
    const job = await matchingJob(ctx, args.jobId);
    if (job?.userId !== authority.userId) rejectRevocation();
    const target = await ctx.db.get(job.deviceId);
    if (
      target?.userId !== authority.userId
      || target.status !== "revoked"
      || target.revokedAt === undefined
    ) rejectRevocation();
    return {
      category: job.category,
      createdAt: job.createdAt,
      jobId: job.publicId,
      state: job.state,
      targetPublicId: target.publicId,
      updatedAt: job.updatedAt,
    };
  },
});

/**
 * Reserved cron root: deviceRevocation:drain with { limit: 200 }.
 * Each transaction selects the least-recently serviced unfinished job, then
 * mutates at most `limit` dependent rows. Category and row changes commit
 * together, so a crash replays only work that did not commit.
 */
export const drain = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const limit = requireRevocationLimit(args.limit);
    const pending = await ctx.db.query("deviceRevocationJobs")
      .withIndex("by_state_and_updated_at", (builder) => builder.eq("state", "pending"))
      .first();
    const draining = await ctx.db.query("deviceRevocationJobs")
      .withIndex("by_state_and_updated_at", (builder) => builder.eq("state", "draining"))
      .first();
    const job = pending === null
      ? draining
      : draining === null || pending.updatedAt <= draining.updatedAt
        ? pending
        : draining;
    if (job === null) return { kind: "idle" as const, processed: 0 };

    const target = await ctx.db.get(job.deviceId);
    if (
      target?.userId !== job.userId
      || target.status !== "revoked"
      || target.revokedAt === undefined
    ) rejectRevocation();

    if (job.category === "complete") {
      const updatedAt = nextUpdateTime(job.updatedAt);
      const jobPatch = { state: "complete" as const, updatedAt };
      await adjustQuotaForPatch(ctx, job.userId, "job", job, jobPatch);
      await ctx.db.patch(job._id, jobPatch);
      return {
        category: "complete" as const,
        jobId: job.publicId,
        kind: "complete" as const,
        processed: 0,
        state: "complete" as const,
      };
    }

    const result = await cleanCategory(ctx, {
      category: job.category,
      deviceId: job.deviceId,
      limit,
      userId: job.userId,
    });
    const updatedAt = nextUpdateTime(job.updatedAt);
    if (result.processed > 0) {
      const jobPatch = { state: "draining" as const, updatedAt };
      await adjustQuotaForPatch(ctx, job.userId, "job", job, jobPatch);
      await ctx.db.patch(job._id, jobPatch);
      return {
        category: job.category,
        jobId: job.publicId,
        kind: "drained" as const,
        processed: result.processed,
        state: "draining" as const,
      };
    }

    const category = nextCategory(job.category);
    const state = category === "complete" ? "complete" as const : "draining" as const;
    const jobPatch = { category, state, updatedAt };
    await adjustQuotaForPatch(ctx, job.userId, "job", job, jobPatch);
    await ctx.db.patch(job._id, jobPatch);
    return {
      category,
      jobId: job.publicId,
      kind: category === "complete" ? "complete" as const : "advanced" as const,
      processed: 0,
      state,
    };
  },
});
