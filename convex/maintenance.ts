import { v } from "convex/values";

import { isSafePositiveInteger } from "../src/cloud/contracts";
import { commandTerminalRetentionMs } from "./commands";
import {
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  finalizeUserQuotaAuthorityForDelete,
  releaseAccountUsageSnapshotQuotaForDelete,
  releaseCommandQuotaForDelete,
  releaseParentAttributedQuotaForDelete,
  releaseQuotaForDelete,
  releaseQuotaForStoredIdentity,
  releaseServiceQuotaForDelete,
} from "./quota";
import { internalMutation, type MutationCtx } from "./server";

const maximumCleanupBatch = 200;
const categoryQuantum = 20;
const maintenanceCategories = [
  "auth_attempts",
  "otp_challenges",
  "auth_invites",
  "abandoned_identities",
  "bind_challenges",
  "device_presence",
  "idempotency_receipts",
  "pending_commands",
  "terminal_commands",
  "security_events",
  "usage_snapshots",
  "account_deletion_receipts",
  "device_revocation_jobs",
] as const;
type MaintenanceCategory = typeof maintenanceCategories[number];

export const cloudRetentionMs = Object.freeze({
  abandonedIdentity: 24 * 60 * 60 * 1_000,
  accountDeletionReceipt: 7 * 24 * 60 * 60 * 1_000,
  authAttemptMaximum: 24 * 60 * 60 * 1_000,
  bindChallengeMaximum: 5 * 60 * 1_000,
  deviceRevocationJob: 7 * 24 * 60 * 60 * 1_000,
  idempotencyReceipt: 7 * 24 * 60 * 60 * 1_000,
  otpChallengeMaximum: 10 * 60 * 1_000,
  securityEvent: 90 * 24 * 60 * 60 * 1_000,
  terminalCommand: commandTerminalRetentionMs,
  usageSnapshot: 90 * 24 * 60 * 60 * 1_000,
} as const);

type CleanupCounts = {
  abandonedIdentities: number;
  accountDeletionReceipts: number;
  authAttempts: number;
  authInvites: number;
  bindChallenges: number;
  devicePresence: number;
  deviceRevocationJobs: number;
  expiredPendingCommands: number;
  idempotencyReceipts: number;
  otpChallenges: number;
  securityEvents: number;
  terminalCommands: number;
  usageSnapshots: number;
};

const countField = {
  auth_attempts: "authAttempts",
  otp_challenges: "otpChallenges",
  auth_invites: "authInvites",
  abandoned_identities: "abandonedIdentities",
  bind_challenges: "bindChallenges",
  device_presence: "devicePresence",
  idempotency_receipts: "idempotencyReceipts",
  pending_commands: "expiredPendingCommands",
  terminal_commands: "terminalCommands",
  security_events: "securityEvents",
  usage_snapshots: "usageSnapshots",
  account_deletion_receipts: "accountDeletionReceipts",
  device_revocation_jobs: "deviceRevocationJobs",
} as const satisfies Readonly<Record<MaintenanceCategory, keyof CleanupCounts>>;

function requireCleanupLimit(value: number): number {
  if (!isSafePositiveInteger(value) || value > maximumCleanupBatch) {
    throw new Error("Invalid cleanup batch.");
  }
  return value;
}

async function deleteExpiredAuthAttempts(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("authEmailAttemptEvents")
    .withIndex("by_expires_at", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseServiceQuotaForDelete(ctx, record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredOtpChallenges(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("authOtpChallenges")
    .withIndex("by_expires_at", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "identity", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredInvites(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("authInvites")
    .withIndex("by_expiry", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseServiceQuotaForDelete(ctx, record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function cleanAbandonedIdentity(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const subject = await ctx.db.query("authSubjects")
    .withIndex("by_unverified_status_and_updated_at", (builder) => builder
      .eq("verifiedAt", undefined)
      .eq("status", "active")
      .lt("updatedAt", now - cloudRetentionMs.abandonedIdentity))
    .first();
  if (subject === null) return 0;
  if (subject.userId === undefined) {
    await releaseServiceQuotaForDelete(ctx, subject);
    await ctx.db.delete(subject._id);
    return 1;
  }
  const user = await ctx.db.get(subject.userId);
  if (user === null) {
    throw new Error("Maintenance authority is corrupt.");
  }
  if (user.emailVerificationTime !== undefined) {
    const subjectPatch = {
      updatedAt: now,
      verifiedAt: user.emailVerificationTime,
    };
    await adjustQuotaForPatch(ctx, user._id, "identity", subject, subjectPatch);
    await ctx.db.patch(subject._id, subjectPatch);
    return 1;
  }
  const [session, device] = await Promise.all([
    ctx.db.query("authSessions")
      .withIndex("userId", (builder) => builder.eq("userId", user._id))
      .first(),
    ctx.db.query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", user._id))
      .first(),
  ]);
  if (session !== null || device !== null) {
    const subjectPatch = { updatedAt: now };
    await adjustQuotaForPatch(ctx, user._id, "identity", subject, subjectPatch);
    await ctx.db.patch(subject._id, subjectPatch);
    return 1;
  }

  let remaining = limit;
  const challenges = await ctx.db.query("authOtpChallenges")
    .withIndex("by_user", (builder) => builder.eq("userId", user._id))
    .take(remaining);
  for (const challenge of challenges) {
    await releaseQuotaForDelete(ctx, user._id, "identity", challenge);
    await ctx.db.delete(challenge._id);
  }
  remaining -= challenges.length;
  if (remaining === 0) return limit;

  const account = await ctx.db.query("authAccounts")
    .withIndex("userIdAndProvider", (builder) => builder.eq("userId", user._id))
    .first();
  if (account !== null) {
    const codes = await ctx.db.query("authVerificationCodes")
      .withIndex("accountId", (builder) => builder.eq("accountId", account._id))
      .take(remaining);
    for (const code of codes) {
      await releaseParentAttributedQuotaForDelete(ctx, user._id, "identity", code);
      await ctx.db.delete(code._id);
    }
    remaining -= codes.length;
    if (remaining === 0) return limit;
    if (codes.length === 0) {
      await releaseQuotaForDelete(ctx, user._id, "identity", account);
      await ctx.db.delete(account._id);
      remaining -= 1;
    }
    return limit - remaining;
  }

  if (remaining < 2) return limit - remaining;
  await releaseQuotaForDelete(ctx, user._id, "identity", subject);
  await releaseQuotaForStoredIdentity(ctx, user._id, user);
  await finalizeUserQuotaAuthorityForDelete(ctx, user._id);
  await ctx.db.delete(subject._id);
  await ctx.db.delete(user._id);
  return limit - remaining + 2;
}

async function deleteExpiredBindChallenges(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("deviceBindChallenges")
    .withIndex("by_expiry", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "custody", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredPresence(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("devicePresence")
    .withIndex("by_presence_until", (builder) => builder.lt("presenceUntil", now))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "device", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredIdempotency(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("idempotencyReceipts")
    .withIndex("by_expiry", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "receipt", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function expirePendingCommands(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("sessionCommands")
    .withIndex("by_state_and_deadline", (builder) => builder
      .eq("state", "pending")
      .lt("deadline", now))
    .take(limit);
  for (const record of records) {
    const commandPatch = {
      nonterminal: false,
      state: "expired" as const,
      ...(record.requesterAcknowledgedAt === undefined
        ? {}
        : { terminalCleanupAfter: now + cloudRetentionMs.terminalCommand }),
      updatedAt: now,
    };
    await adjustCommandQuotaForPatch(ctx, record.userId, record, commandPatch);
    await ctx.db.patch(record._id, commandPatch);
  }
  return records.length;
}

async function deleteTerminalCommands(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  let remaining = limit;
  for (const state of ["applied", "failed", "ambiguous", "cancelled", "expired"] as const) {
    if (remaining === 0) break;
    const records = await ctx.db.query("sessionCommands")
      .withIndex("by_state_and_cleanup_after", (builder) => builder
        .eq("state", state)
        .gt("terminalCleanupAfter", 0)
        .lt("terminalCleanupAfter", now))
      .take(remaining);
    for (const record of records) {
      await releaseCommandQuotaForDelete(ctx, record.userId, record);
      await ctx.db.delete(record._id);
    }
    remaining -= records.length;
  }
  return limit - remaining;
}

async function deleteExpiredSecurityEvents(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("securityEvents")
    .withIndex("by_created_at", (builder) => builder
      .lt("createdAt", now - cloudRetentionMs.securityEvent))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "security", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredUsage(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("accountUsageSnapshots")
    .withIndex("by_received_at", (builder) => builder
      .lt("receivedAt", now - cloudRetentionMs.usageSnapshot))
    .take(limit);
  for (const record of records) {
    await releaseAccountUsageSnapshotQuotaForDelete(
      ctx,
      record.userId,
      record.accountId,
      record,
    );
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredAccountReceipts(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("accountDeletionReceipts")
    .withIndex("by_expiry", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseServiceQuotaForDelete(ctx, record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteCompletedRevocationJobs(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("deviceRevocationJobs")
    .withIndex("by_state_and_updated_at", (builder) => builder
      .eq("state", "complete")
      .lt("updatedAt", now - cloudRetentionMs.deviceRevocationJob))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "job", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

const handlers = {
  auth_attempts: deleteExpiredAuthAttempts,
  otp_challenges: deleteExpiredOtpChallenges,
  auth_invites: deleteExpiredInvites,
  abandoned_identities: cleanAbandonedIdentity,
  bind_challenges: deleteExpiredBindChallenges,
  device_presence: deleteExpiredPresence,
  idempotency_receipts: deleteExpiredIdempotency,
  pending_commands: expirePendingCommands,
  terminal_commands: deleteTerminalCommands,
  security_events: deleteExpiredSecurityEvents,
  usage_snapshots: deleteExpiredUsage,
  account_deletion_receipts: deleteExpiredAccountReceipts,
  device_revocation_jobs: deleteCompletedRevocationJobs,
} as const satisfies Readonly<Record<
  MaintenanceCategory,
  (ctx: MutationCtx, now: number, limit: number) => Promise<number>
>>;

const emptyCounts = (): CleanupCounts => ({
  abandonedIdentities: 0,
  accountDeletionReceipts: 0,
  authAttempts: 0,
  authInvites: 0,
  bindChallenges: 0,
  devicePresence: 0,
  deviceRevocationJobs: 0,
  expiredPendingCommands: 0,
  idempotencyReceipts: 0,
  otpChallenges: 0,
  securityEvents: 0,
  terminalCommands: 0,
  usageSnapshots: 0,
});

export const cleanupExpired = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    let remaining = requireCleanupLimit(args.limit);
    const now = Date.now();
    const counts = emptyCounts();
    const states = await ctx.db.query("maintenanceState")
      .withIndex("by_key", (builder) => builder.eq("key", "retention"))
      .take(2);
    if (states.length > 1) throw new Error("Maintenance authority is corrupt.");
    const state = states[0];
    const start = state === undefined
      ? 0
      : maintenanceCategories.indexOf(state.nextCategory);
    if (start < 0) throw new Error("Maintenance authority is corrupt.");
    let visited = 0;
    while (remaining > 0 && visited < maintenanceCategories.length) {
      const category = maintenanceCategories[(start + visited) % maintenanceCategories.length];
      if (category === undefined) throw new Error("Maintenance category is unavailable.");
      const budget = Math.min(categoryQuantum, remaining);
      const processed = await handlers[category](ctx, now, budget);
      if (!Number.isSafeInteger(processed) || processed < 0 || processed > budget) {
        throw new Error("Maintenance category exceeded its budget.");
      }
      counts[countField[category]] += processed;
      remaining -= processed;
      visited += 1;
    }
    const nextCategory = maintenanceCategories[(start + visited) % maintenanceCategories.length];
    if (nextCategory === undefined) throw new Error("Maintenance category is unavailable.");
    if (state === undefined) {
      await ctx.db.insert("maintenanceState", { key: "retention", nextCategory, updatedAt: now });
    } else {
      await ctx.db.patch(state._id, { nextCategory, updatedAt: now });
    }
    return {
      ...counts,
      nextCategory,
      processed: args.limit - remaining,
      visitedCategories: visited,
    };
  },
});
