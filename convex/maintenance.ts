import { v } from "convex/values";

import { isSafePositiveInteger } from "../src/cloud/contracts";
import { maximumLiveOtpChallenges } from "./authPolicy";
import { commandTerminalRetentionMs } from "./commands";
import { CLOUD_USAGE_SNAPSHOT_RETENTION_MS } from "./lifecyclePolicy";
import {
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  finalizeUserQuotaAuthorityForDelete,
  releaseAccountUsageSnapshotQuotaForDelete,
  releaseCommandQuotaForDelete,
  releaseLiveChunkResourceForDelete,
  releaseParentAttributedQuotaForDelete,
  releaseQuotaForDelete,
  releaseQuotaForStoredIdentity,
  releaseServiceQuotaForDelete,
  releaseSessionChunkQuotaForDelete,
  requireHardQuotaAuthority,
} from "./quota";
import { internalMutation, type MutationCtx } from "./server";
import { beginDetailRetentionEpoch } from "./sessions";

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
  "pending_device_commands",
  "terminal_device_commands",
  "security_events",
  "usage_snapshots",
  "account_deletion_receipts",
  "device_revocation_jobs",
  "live_tail_chunks",
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
  usageSnapshot: CLOUD_USAGE_SNAPSHOT_RETENTION_MS,
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
  expiredPendingDeviceCommands: number;
  idempotencyReceipts: number;
  liveTailChunks: number;
  otpChallenges: number;
  securityEvents: number;
  terminalCommands: number;
  terminalDeviceCommands: number;
  usageSnapshots: number;
};

const countField = {
  live_tail_chunks: "liveTailChunks",
  auth_attempts: "authAttempts",
  otp_challenges: "otpChallenges",
  auth_invites: "authInvites",
  abandoned_identities: "abandonedIdentities",
  bind_challenges: "bindChallenges",
  device_presence: "devicePresence",
  idempotency_receipts: "idempotencyReceipts",
  pending_commands: "expiredPendingCommands",
  terminal_commands: "terminalCommands",
  pending_device_commands: "expiredPendingDeviceCommands",
  terminal_device_commands: "terminalDeviceCommands",
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
  const liveChallenges = await ctx.db.query("authOtpChallenges")
    .withIndex("by_user_and_expires_at", (builder) => builder
      .eq("userId", user._id)
      .gt("expiresAt", now))
    .take(maximumLiveOtpChallenges + 1);
  if (liveChallenges.length > maximumLiveOtpChallenges) {
    throw new Error("Maintenance authority is corrupt.");
  }
  if (liveChallenges.length > 0) {
    if (liveChallenges.some((challenge) =>
      challenge.authEpoch !== subject.authEpoch
      || challenge.emailDigest !== subject.emailDigest)) {
      throw new Error("Maintenance authority is corrupt.");
    }
    const subjectPatch = { updatedAt: now };
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

/*
 * Device commands share the session-command lifecycle, so they share its two
 * sweeps: a pending row past its deadline expires, and a terminal row the
 * requester has acknowledged is deleted after the same retention. They get
 * their own maintenance categories rather than being folded into the session
 * sweeps so one table's backlog can never starve the other's.
 */
async function expirePendingDeviceCommands(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("deviceCommands")
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

async function deleteTerminalDeviceCommands(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  let remaining = limit;
  for (const state of ["applied", "failed", "ambiguous", "cancelled", "expired"] as const) {
    if (remaining === 0) break;
    const records = await ctx.db.query("deviceCommands")
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
    let snapshotQuotaReleased = false;
    const bindings = await ctx.db.query("deviceAccountBindings")
      .withIndex("by_device_and_account", (builder) => builder
        .eq("deviceId", record.sourceDeviceId)
        .eq("accountId", record.accountId))
      .take(2);
    if (bindings.length > 1) throw new Error("USAGE_RETENTION_AUTHORITY_CORRUPT");
    const binding = bindings[0];
    if (binding !== undefined && binding.usageAdmission === undefined) {
      if (binding.userId !== record.userId) {
        throw new Error("USAGE_RETENTION_AUTHORITY_CORRUPT");
      }
      const latest = (await ctx.db.query("accountUsageSnapshots")
        .withIndex("by_source_revision", (builder) => builder
          .eq("accountId", record.accountId)
          .eq("sourceDeviceId", record.sourceDeviceId))
        .order("desc")
        .take(1))[0];
      if (
        latest !== undefined
        && latest._id === record._id
      ) {
        if (
          latest.userId !== record.userId
          || latest.sourceDevicePublicId !== record.sourceDevicePublicId
        ) throw new Error("USAGE_RETENTION_AUTHORITY_CORRUPT");
        const patch = {
          updatedAt: Math.max(binding.updatedAt, now),
          usageAdmission: {
            cursor: {
              digest: latest.digest,
              disposition: "stored" as const,
              observedAt: latest.observedAt,
              sourceRevision: latest.sourceRevision,
            },
            lastAcceptedAt: latest.receivedAt,
          },
        } as const;
        await releaseAccountUsageSnapshotQuotaForDelete(
          ctx,
          record.userId,
          record.accountId,
          record,
        );
        snapshotQuotaReleased = true;
        await adjustQuotaForPatch(ctx, record.userId, "account", binding, patch);
        await ctx.db.patch(binding._id, patch);
      }
    }
    if (!snapshotQuotaReleased) {
      await releaseAccountUsageSnapshotQuotaForDelete(
        ctx,
        record.userId,
        record.accountId,
        record,
      );
    }
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

/*
 * live_tail retention: detail-stream chunks carry an expiresAt deadline set at
 * append time. Expired rows are removed per session behind one detail
 * retention epoch per session per sweep, so digest-chain verification of the
 * surviving tail stays valid, and both the session_chunk charge and the
 * live_chunk resource counter are released.
 */
async function deleteExpiredLiveTailChunks(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const expired = await ctx.db.query("sessionChunks")
    .withIndex("by_stream_and_expires_at", (builder) => builder
      .eq("stream", "detail")
      .lt("expiresAt", now))
    .take(limit);
  if (expired.length === 0) return 0;
  const bySession = new Map<string, typeof expired>();
  for (const chunk of expired) {
    const list = bySession.get(chunk.sessionId) ?? [];
    list.push(chunk);
    bySession.set(chunk.sessionId, list);
  }
  let deleted = 0;
  for (const chunks of bySession.values()) {
    const first = chunks[0];
    if (first === undefined) continue;
    const session = await ctx.db.get(first.sessionId);
    if (session === null) {
      for (const chunk of chunks) {
        await releaseSessionChunkQuotaForDelete(ctx, chunk.userId, chunk);
        await releaseLiveChunkResourceForDelete(ctx, chunk.userId);
        await ctx.db.delete(chunk._id);
        deleted += 1;
      }
      continue;
    }
    chunks.sort((left, right) => left.firstSequence - right.firstSequence);
    const last = chunks.at(-1);
    if (last === undefined) continue;
    await beginDetailRetentionEpoch(ctx, session, last.lastSequence, last.digest);
    for (const chunk of chunks) {
      if (chunk.userId !== session.userId) throw new Error("Maintenance authority is corrupt.");
      await releaseSessionChunkQuotaForDelete(ctx, session.userId, chunk);
      await releaseLiveChunkResourceForDelete(ctx, session.userId);
      await ctx.db.delete(chunk._id);
      deleted += 1;
    }
  }
  return deleted;
}

const handlers = {
  live_tail_chunks: deleteExpiredLiveTailChunks,
  auth_attempts: deleteExpiredAuthAttempts,
  otp_challenges: deleteExpiredOtpChallenges,
  auth_invites: deleteExpiredInvites,
  abandoned_identities: cleanAbandonedIdentity,
  bind_challenges: deleteExpiredBindChallenges,
  device_presence: deleteExpiredPresence,
  idempotency_receipts: deleteExpiredIdempotency,
  pending_commands: expirePendingCommands,
  terminal_commands: deleteTerminalCommands,
  pending_device_commands: expirePendingDeviceCommands,
  terminal_device_commands: deleteTerminalDeviceCommands,
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
  expiredPendingDeviceCommands: 0,
  idempotencyReceipts: 0,
  liveTailChunks: 0,
  otpChallenges: 0,
  securityEvents: 0,
  terminalCommands: 0,
  terminalDeviceCommands: 0,
  usageSnapshots: 0,
});

export const cleanupExpired = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    await requireHardQuotaAuthority(ctx);
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
