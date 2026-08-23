import { v } from "convex/values";
import type { GenericId as Id } from "convex/values";

import {
  isDigest,
  isOpaqueIdentifier,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
} from "../src/cloud/contracts";
import { rejectAuthority, requireRegisteredDeviceAuthority } from "./authority";
import { adjustQuotaForPatch, reserveQuotaForInsert } from "./quota";
import type { MutationCtx, QueryCtx } from "./server";
import { mutation, query } from "./server";

export const devicePresenceHeartbeatMs = 15_000;
export const devicePresenceTtlMs = 45_000;

type PresenceReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export async function presenceForDevice(
  ctx: PresenceReadCtx,
  deviceId: Id<"devices">,
) {
  const rows = await ctx.db
    .query("devicePresence")
    .withIndex("by_device", (builder) => builder.eq("deviceId", deviceId))
    .take(2);
  if (rows.length > 1) rejectAuthority();
  return rows[0] ?? null;
}

const publicPresence = (presence: Awaited<ReturnType<typeof presenceForDevice>>, now: number) => ({
  connectionId: presence?.connectionId ?? null,
  lastSeenAt: presence?.observedAt ?? null,
  online: presence !== null && presence.presenceUntil > now,
  presenceUntil: presence?.presenceUntil ?? null,
  sequence: presence?.connectionSequence ?? null,
  serverNow: now,
});

const parseConnectionInput = (input: {
  connectionId: string;
  credentialGeneration: number;
  fingerprint: string;
  sequence: number;
}): void => {
  if (
    !isOpaqueIdentifier(input.connectionId)
    || !isSafePositiveInteger(input.credentialGeneration)
    || !isDigest(input.fingerprint)
    || !isSafeNonNegativeInteger(input.sequence)
  ) rejectAuthority();
};

export const connect = mutation({
  args: {
    connectionId: v.string(),
    credentialGeneration: v.number(),
    fingerprint: v.string(),
    sequence: v.number(),
  },
  handler: async (ctx, args) => {
    const authority = await requireRegisteredDeviceAuthority(ctx);
    parseConnectionInput(args);
    if (args.sequence !== 0) rejectAuthority();
    const deviceGeneration = authority.device.credentialGeneration ?? 1;
    if (args.credentialGeneration !== deviceGeneration) rejectAuthority();
    const existing = await presenceForDevice(ctx, authority.deviceId);
    const now = Date.now();
    if (existing !== null) {
      const exactReplay = existing.connectionId === args.connectionId
        && existing.credentialGeneration === args.credentialGeneration
        && existing.connectionSequence === args.sequence
        && existing.fingerprint === args.fingerprint;
      if (exactReplay) return publicPresence(existing, now);
      if (existing.presenceUntil > now) throw new Error("PRESENCE_CONNECTION_CONFLICT");
      const presencePatch = {
        authEpoch: authority.subject.authEpoch,
        connectionId: args.connectionId,
        connectionSequence: 0,
        credentialGeneration: args.credentialGeneration,
        fingerprint: args.fingerprint,
        observedAt: now,
        presenceUntil: now + devicePresenceTtlMs,
      } as const;
      await adjustQuotaForPatch(ctx, authority.userId, "device", existing, presencePatch);
      await ctx.db.patch(existing._id, presencePatch);
    } else {
      const presenceDocument = {
        authEpoch: authority.subject.authEpoch,
        connectionId: args.connectionId,
        connectionSequence: 0,
        credentialGeneration: args.credentialGeneration,
        deviceId: authority.deviceId,
        fingerprint: args.fingerprint,
        observedAt: now,
        presenceUntil: now + devicePresenceTtlMs,
        userId: authority.userId,
      } as const;
      await reserveQuotaForInsert(ctx, authority.userId, "device", presenceDocument);
      await ctx.db.insert("devicePresence", presenceDocument);
    }
    return publicPresence(await presenceForDevice(ctx, authority.deviceId), now);
  },
});

export const heartbeat = mutation({
  args: {
    connectionId: v.string(),
    credentialGeneration: v.number(),
    fingerprint: v.string(),
    sequence: v.number(),
  },
  handler: async (ctx, args) => {
    const authority = await requireRegisteredDeviceAuthority(ctx);
    parseConnectionInput(args);
    const deviceGeneration = authority.device.credentialGeneration ?? 1;
    if (args.credentialGeneration !== deviceGeneration) rejectAuthority();
    const existing = await presenceForDevice(ctx, authority.deviceId);
    if (
      existing === null
      || existing.userId !== authority.userId
      || existing.authEpoch !== authority.subject.authEpoch
      || existing.connectionId !== args.connectionId
      || existing.credentialGeneration !== args.credentialGeneration
    ) rejectAuthority();
    const now = Date.now();
    if (args.sequence === existing.connectionSequence) {
      if (args.fingerprint !== existing.fingerprint) rejectAuthority();
      return publicPresence(existing, now);
    }
    if (args.sequence !== existing.connectionSequence + 1) rejectAuthority();
    const presencePatch = {
      connectionSequence: args.sequence,
      fingerprint: args.fingerprint,
      observedAt: now,
      presenceUntil: now + devicePresenceTtlMs,
    } as const;
    await adjustQuotaForPatch(ctx, authority.userId, "device", existing, presencePatch);
    await ctx.db.patch(existing._id, presencePatch);
    return publicPresence(await presenceForDevice(ctx, authority.deviceId), now);
  },
});

export const disconnect = mutation({
  args: {
    connectionId: v.string(),
    credentialGeneration: v.number(),
    fingerprint: v.string(),
    sequence: v.number(),
  },
  handler: async (ctx, args) => {
    const authority = await requireRegisteredDeviceAuthority(ctx);
    parseConnectionInput(args);
    const existing = await presenceForDevice(ctx, authority.deviceId);
    if (
      existing === null
      || existing.connectionId !== args.connectionId
      || existing.credentialGeneration !== args.credentialGeneration
      || existing.connectionSequence !== args.sequence
      || existing.fingerprint !== args.fingerprint
    ) rejectAuthority();
    const now = Date.now();
    const presencePatch = { observedAt: now, presenceUntil: now } as const;
    await adjustQuotaForPatch(ctx, authority.userId, "device", existing, presencePatch);
    await ctx.db.patch(existing._id, presencePatch);
    return publicPresence(await presenceForDevice(ctx, authority.deviceId), now);
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const authority = await requireRegisteredDeviceAuthority(ctx);
    return publicPresence(await presenceForDevice(ctx, authority.deviceId), Date.now());
  },
});
