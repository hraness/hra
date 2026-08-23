import { v } from "convex/values";
import type { GenericId as Id } from "convex/values";

import {
  isDigest,
  isOpaqueIdentifier,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  type AuthorityTuple,
} from "../src/cloud/contracts";
import {
  acquireLeaseDisposition,
  heartbeatDisposition,
  type LeaseSnapshot,
} from "../src/cloud/leases";
import {
  rejectAuthority,
  requireDeviceAuthority,
  requireOwnedSession,
} from "./authority";
import { adjustQuotaForPatch, reserveQuotaForInsert } from "./quota";
import type { MutationCtx, QueryCtx } from "./server";
import { mutation, query } from "./server";
import { authorityTuple } from "./validators";

type LeaseReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

async function leaseForSession(ctx: LeaseReadCtx, sessionId: Id<"sessionHeads">) {
  const matches = await ctx.db
    .query("executionLeases")
    .withIndex("by_session", (builder) => builder.eq("sessionId", sessionId))
    .take(2);
  if (matches.length > 1) rejectAuthority();
  return matches[0] ?? null;
}

async function toSnapshot(ctx: LeaseReadCtx, lease: NonNullable<Awaited<ReturnType<typeof leaseForSession>>>): Promise<LeaseSnapshot> {
  const device = await ctx.db.get(lease.deviceId);
  if (device?.userId !== lease.userId) rejectAuthority();
  return {
    bootGeneration: lease.bootGeneration,
    bootId: lease.bootId,
    devicePublicId: device.publicId,
    fence: lease.fence,
    heartbeatFingerprint: lease.heartbeatFingerprint,
    heartbeatSequence: lease.heartbeatSequence,
    leaseUntil: lease.leaseUntil,
  };
}

export async function requireLiveExecutionLease(
  ctx: MutationCtx,
  input: Readonly<{
    authority: AuthorityTuple;
    deviceId: Id<"devices">;
    sessionId: Id<"sessionHeads">;
    userId: Id<"users">;
  }>,
) {
  const lease = await leaseForSession(ctx, input.sessionId);
  if (
    lease?.userId !== input.userId
    || lease.deviceId !== input.deviceId
    || lease.bootId !== input.authority.bootId
    || lease.bootGeneration !== input.authority.bootGeneration
    || lease.fence !== input.authority.fence
    || lease.leaseUntil <= Date.now()
  ) rejectAuthority();
  return lease;
}

export const acquire = mutation({
  args: {
    bootGeneration: v.number(),
    bootId: v.string(),
    leaseDurationMs: v.number(),
    sessionPublicId: v.string(),
  },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.bootId)
      || !isOpaqueIdentifier(args.sessionPublicId)
      || !isSafePositiveInteger(args.bootGeneration)
    ) rejectAuthority();
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (
      sessions.length !== 1
      || session?.executionDeviceId !== authority.deviceId
      || session.state === "orphaned"
      || session.state === "terminal"
    ) rejectAuthority();
    const existing = await leaseForSession(ctx, session._id);
    const now = Date.now();
    const disposition = acquireLeaseDisposition(
      existing === null ? null : await toSnapshot(ctx, existing),
      {
        bootGeneration: args.bootGeneration,
        bootId: args.bootId,
        devicePublicId: authority.device.publicId,
        leaseDurationMs: args.leaseDurationMs,
        now,
      },
    );
    if (disposition.kind === "rejected") throw new Error(`LEASE_${disposition.reason.toUpperCase()}`);
    if (existing === null) {
      const leaseDocument = {
        bootGeneration: disposition.lease.bootGeneration,
        bootId: disposition.lease.bootId,
        deviceId: authority.deviceId,
        fence: disposition.lease.fence,
        heartbeatFingerprint: disposition.lease.heartbeatFingerprint,
        heartbeatSequence: disposition.lease.heartbeatSequence,
        leaseUntil: disposition.lease.leaseUntil,
        sessionId: session._id,
        updatedAt: now,
        userId: authority.userId,
      } as const;
      await reserveQuotaForInsert(ctx, authority.userId, "session", leaseDocument);
      await ctx.db.insert("executionLeases", leaseDocument);
    } else {
      const leasePatch = {
        bootGeneration: disposition.lease.bootGeneration,
        bootId: disposition.lease.bootId,
        fence: disposition.lease.fence,
        heartbeatFingerprint: disposition.lease.heartbeatFingerprint,
        heartbeatSequence: disposition.lease.heartbeatSequence,
        leaseUntil: disposition.lease.leaseUntil,
        updatedAt: now,
      } as const;
      await adjustQuotaForPatch(ctx, authority.userId, "session", existing, leasePatch);
      await ctx.db.patch(existing._id, leasePatch);
    }
    if (disposition.kind === "acquired") {
      const securityDocument = {
        actorDeviceId: authority.deviceId,
        createdAt: now,
        entityId: session.publicId,
        event: "lease_acquired",
        userId: authority.userId,
      } as const;
      await reserveQuotaForInsert(ctx, authority.userId, "security", securityDocument);
      await ctx.db.insert("securityEvents", securityDocument);
    }
    return disposition.lease;
  },
});

export const heartbeat = mutation({
  args: {
    authority: authorityTuple,
    fingerprint: v.string(),
    leaseDurationMs: v.number(),
    sequence: v.number(),
    sessionPublicId: v.string(),
  },
  handler: async (ctx, args) => {
    const current = await requireDeviceAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.sessionPublicId)
      || !isDigest(args.fingerprint)
      || !isSafeNonNegativeInteger(args.sequence)
    ) rejectAuthority();
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", current.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (sessions.length !== 1 || session === undefined) rejectAuthority();
    await requireOwnedSession(ctx, current.userId, session._id);
    if (session.executionDeviceId !== current.deviceId) rejectAuthority();
    const existing = await leaseForSession(ctx, session._id);
    if (existing?.deviceId !== current.deviceId) rejectAuthority();
    const now = Date.now();
    const disposition = heartbeatDisposition(await toSnapshot(ctx, existing), {
      authority: args.authority,
      fingerprint: args.fingerprint,
      leaseDurationMs: args.leaseDurationMs,
      now,
      sequence: args.sequence,
    });
    if (disposition.kind === "rejected") {
      throw new Error(`HEARTBEAT_${disposition.reason.toUpperCase()}`);
    }
    if (disposition.kind === "advanced") {
      const leasePatch = {
        heartbeatFingerprint: disposition.lease.heartbeatFingerprint,
        heartbeatSequence: disposition.lease.heartbeatSequence,
        leaseUntil: disposition.lease.leaseUntil,
        updatedAt: now,
      } as const;
      await adjustQuotaForPatch(ctx, current.userId, "session", existing, leasePatch);
      await ctx.db.patch(existing._id, leasePatch);
    }
    return disposition.lease;
  },
});

export const current = query({
  args: { sessionPublicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isOpaqueIdentifier(args.sessionPublicId)) rejectAuthority();
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (sessions.length !== 1 || session === undefined) rejectAuthority();
    const lease = await leaseForSession(ctx, session._id);
    return lease === null ? null : await toSnapshot(ctx, lease);
  },
});
