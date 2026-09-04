import { v, type GenericId as Id } from "convex/values";

import {
  cloudLimits,
  isDigest,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isSafePositiveInteger,
  parseEncryptedEnvelope,
} from "../src/cloud/contracts";
import {
  usageSnapshotDisposition,
  parseUsageEncryptedEnvelope,
  type UsageSnapshotOrder,
} from "../src/cloud/usage";
import {
  rejectAuthority,
  requireDaemonDevice,
  requireDeviceAuthority,
} from "./authority";
import {
  loadIdempotencyReceipt,
  storeIdempotencyReceipt,
} from "./idempotency";
import {
  adjustQuotaForPatch,
  initializeAccountUsageQuotaAuthority,
  releaseAccountUsageSnapshotQuotaForDelete,
  reserveAccountUsageSnapshotQuotaForInsert,
  reserveCodexAccountQuotaForInsert,
  reserveQuotaForInsert,
} from "./quota";
import { CLOUD_USAGE_SNAPSHOT_RETENTION_MS } from "./lifecyclePolicy";
import { mutation, query, type MutationCtx } from "./server";
import { encryptedEnvelope, usageEncryptedEnvelope } from "./validators";

type AccountSummary = Readonly<{
  publicId: string;
  sourceGeneration: number;
}>;

export const USAGE_ADMISSION_EXPIRY_RELEASE_LIMIT = 20;
export const USAGE_SERVER_ADMISSION_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

async function releaseExpiredAccountUsage(
  ctx: MutationCtx,
  input: Readonly<{
    accountId: Id<"codexAccounts">;
    now: number;
    userId: Id<"users">;
  }>,
): Promise<void> {
  const expired = await ctx.db.query("accountUsageSnapshots")
    .withIndex("by_account_and_received_at", (builder) => builder
      .eq("accountId", input.accountId)
      .lt("receivedAt", input.now - CLOUD_USAGE_SNAPSHOT_RETENTION_MS))
    .take(USAGE_ADMISSION_EXPIRY_RELEASE_LIMIT);
  for (const snapshot of expired) {
    if (snapshot.userId !== input.userId || snapshot.accountId !== input.accountId) {
      rejectAuthority();
    }
    await releaseAccountUsageSnapshotQuotaForDelete(
      ctx,
      input.userId,
      input.accountId,
      snapshot,
    );
    await ctx.db.delete(snapshot._id);
  }
}

function parseAccountSummary(value: unknown): AccountSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (!isOpaqueIdentifier(record.publicId) || !isSafePositiveInteger(record.sourceGeneration)) {
    return null;
  }
  return { publicId: record.publicId, sourceGeneration: record.sourceGeneration };
}

export const upsertAccount = mutation({
  args: {
    encryptedLocalReference: encryptedEnvelope,
    encryptedMetadata: encryptedEnvelope,
    idempotencyKey: v.string(),
    matchKey: v.string(),
    publicId: v.string(),
    requestDigest: v.string(),
    sourceGeneration: v.number(),
  },
  handler: async (ctx, args): Promise<AccountSummary> => {
    const authority = await requireDaemonDevice(ctx);
    if (
      !isOpaqueIdentifier(args.publicId)
      || !isDigest(args.matchKey)
      || !isSafePositiveInteger(args.sourceGeneration)
      || parseEncryptedEnvelope(
        args.encryptedMetadata,
        cloudLimits.metadataCiphertextCharacters,
      ) === null
      || parseEncryptedEnvelope(
        args.encryptedLocalReference,
        cloudLimits.metadataCiphertextCharacters,
      ) === null
    ) rejectAuthority();
    const scope = {
      deviceId: authority.deviceId,
      operation: "usage.account",
      scopeId: args.publicId,
      userId: authority.userId,
    } as const;
    const replay = await loadIdempotencyReceipt(
      ctx,
      scope,
      args.idempotencyKey,
      args.requestDigest,
    );
    if (replay !== null) {
      const parsed = parseAccountSummary(replay);
      if (parsed === null) rejectAuthority();
      return parsed;
    }
    const byMatch = await ctx.db
      .query("codexAccounts")
      .withIndex("by_user_and_match_key", (builder) => builder
        .eq("userId", authority.userId)
        .eq("matchKey", args.matchKey))
      .take(2);
    if (byMatch.length > 1) rejectAuthority();
    let account = byMatch[0] ?? null;
    const now = Date.now();
    if (account === null) {
      const duplicatePublicIds = await ctx.db
        .query("codexAccounts")
        .withIndex("by_user_and_public_id", (builder) => builder
          .eq("userId", authority.userId)
          .eq("publicId", args.publicId))
        .take(1);
      if (duplicatePublicIds.length !== 0) rejectAuthority();
      const accountDocument = {
        createdAt: now,
        encryptedMetadata: args.encryptedMetadata,
        matchKey: args.matchKey,
        publicId: args.publicId,
        updatedAt: now,
        userId: authority.userId,
      } as const;
      await reserveCodexAccountQuotaForInsert(ctx, authority.userId, accountDocument);
      const accountId = await ctx.db.insert("codexAccounts", accountDocument);
      await initializeAccountUsageQuotaAuthority(ctx, authority.userId, accountId);
      account = await ctx.db.get(accountId);
    } else {
      if (account.publicId !== args.publicId) rejectAuthority();
      const accountPatch = {
        encryptedMetadata: args.encryptedMetadata,
        updatedAt: now,
      } as const;
      await adjustQuotaForPatch(ctx, authority.userId, "account", account, accountPatch);
      await ctx.db.patch(account._id, accountPatch);
    }
    if (account === null) rejectAuthority();
    const bindings = await ctx.db
      .query("deviceAccountBindings")
      .withIndex("by_device_and_account", (builder) => builder
        .eq("deviceId", authority.deviceId)
        .eq("accountId", account._id))
      .take(2);
    if (bindings.length > 1) rejectAuthority();
    const binding = bindings[0];
    if (binding === undefined) {
      const bindingDocument = {
        accountId: account._id,
        deviceId: authority.deviceId,
        encryptedLocalReference: args.encryptedLocalReference,
        lastSeenAt: now,
        sourceGeneration: args.sourceGeneration,
        state: "present",
        updatedAt: now,
        userId: authority.userId,
      } as const;
      await reserveQuotaForInsert(ctx, authority.userId, "account", bindingDocument);
      await ctx.db.insert("deviceAccountBindings", bindingDocument);
    } else {
      if (args.sourceGeneration <= binding.sourceGeneration) {
        throw new Error("ACCOUNT_BINDING_GENERATION_CONFLICT");
      }
      const bindingPatch = {
        encryptedLocalReference: args.encryptedLocalReference,
        lastSeenAt: now,
        sourceGeneration: args.sourceGeneration,
        state: "present",
        updatedAt: now,
      } as const;
      await adjustQuotaForPatch(ctx, authority.userId, "account", binding, bindingPatch);
      await ctx.db.patch(binding._id, bindingPatch);
    }
    const response = { publicId: account.publicId, sourceGeneration: args.sourceGeneration };
    await storeIdempotencyReceipt(ctx, scope, {
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      response,
    });
    return response;
  },
});

// Durable outbox recovery must prove the exact account/binding identity. A
// bounded account listing cannot distinguish absence from pagination.
export const getAccountBinding = query({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isOpaqueIdentifier(args.publicId)) rejectAuthority();
    const accounts = await ctx.db
      .query("codexAccounts")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.publicId))
      .take(2);
    if (accounts.length > 1) rejectAuthority();
    const account = accounts[0];
    if (account === undefined) return null;
    const bindings = await ctx.db
      .query("deviceAccountBindings")
      .withIndex("by_device_and_account", (builder) => builder
        .eq("deviceId", authority.deviceId)
        .eq("accountId", account._id))
      .take(2);
    if (bindings.length > 1) rejectAuthority();
    const binding = bindings[0];
    const legacyUsageHead = binding === undefined || binding.usageAdmission !== undefined
      ? null
      : (await ctx.db.query("accountUsageSnapshots")
          .withIndex("by_source_revision", (builder) => builder
            .eq("accountId", account._id)
            .eq("sourceDeviceId", authority.deviceId))
          .order("desc")
          .take(1))[0] ?? null;
    if (
      legacyUsageHead !== null
      && (
        legacyUsageHead.userId !== authority.userId
        || legacyUsageHead.sourceDevicePublicId !== authority.device.publicId
      )
    ) rejectAuthority();
    return {
      ...(binding === undefined
        ? { binding: null }
        : {
            binding: {
              encryptedLocalReference: binding.encryptedLocalReference,
              sourceGeneration: binding.sourceGeneration,
              state: binding.state,
              usageSourceRevision: binding.usageAdmission?.cursor.sourceRevision
                ?? legacyUsageHead?.sourceRevision
                ?? 0,
            },
          }),
      encryptedMetadata: account.encryptedMetadata,
      matchKey: account.matchKey,
      publicId: account.publicId,
    };
  },
});

export const listAccounts = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isSafePositiveInteger(args.limit) || args.limit > cloudLimits.pageSize) {
      rejectAuthority();
    }
    const accounts = await ctx.db
      .query("codexAccounts")
      .withIndex("by_user_and_public_id", (builder) =>
        builder.eq("userId", authority.userId))
      .take(args.limit);
    return accounts.map((account) => ({
      encryptedMetadata: account.encryptedMetadata,
      publicId: account.publicId,
      updatedAt: account.updatedAt,
    }));
  },
});

function snapshotOrder(snapshot: Readonly<{
  digest: string;
  observedAt: number;
  sourceDeviceId: string;
  sourceRevision: number;
}>): UsageSnapshotOrder {
  return {
    digest: snapshot.digest,
    observedAt: snapshot.observedAt,
    sourceDeviceId: snapshot.sourceDeviceId,
    sourceRevision: snapshot.sourceRevision,
  };
}

export const upsertSnapshot = mutation({
  args: {
    accountPublicId: v.string(),
    digest: v.string(),
    envelope: usageEncryptedEnvelope,
    observedAt: v.number(),
    sourceGeneration: v.number(),
    sourceRevision: v.number(),
  },
  handler: async (ctx, args) => {
    const authority = await requireDaemonDevice(ctx);
    const now = Date.now();
    if (
      !isOpaqueIdentifier(args.accountPublicId)
      || !isDigest(args.digest)
      || !isFiniteTimestamp(args.observedAt)
      || !isSafePositiveInteger(args.sourceGeneration)
      || !isSafePositiveInteger(args.sourceRevision)
      || parseUsageEncryptedEnvelope(args.envelope) === null
    ) rejectAuthority();
    const accounts = await ctx.db
      .query("codexAccounts")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.accountPublicId))
      .take(2);
    const account = accounts[0];
    if (accounts.length !== 1 || account === undefined) rejectAuthority();
    const bindings = await ctx.db
      .query("deviceAccountBindings")
      .withIndex("by_device_and_account", (builder) => builder
        .eq("deviceId", authority.deviceId)
        .eq("accountId", account._id))
      .take(2);
    const binding = bindings[0];
    if (
      bindings.length !== 1
      || binding === undefined
      || binding.userId !== authority.userId
      || binding.state !== "present"
      || binding.sourceGeneration !== args.sourceGeneration
    ) rejectAuthority();
    const exact = await ctx.db
      .query("accountUsageSnapshots")
      .withIndex("by_source_revision", (builder) => builder
        .eq("accountId", account._id)
        .eq("sourceDeviceId", authority.deviceId)
        .eq("sourceRevision", args.sourceRevision))
      .take(2);
    if (exact.length > 1) rejectAuthority();
    const latestForSource = await ctx.db
      .query("accountUsageSnapshots")
      .withIndex("by_source_revision", (builder) => builder
        .eq("accountId", account._id)
        .eq("sourceDeviceId", authority.deviceId))
      .order("desc")
      .take(1);
    const candidate = snapshotOrder({
      digest: args.digest,
      observedAt: args.observedAt,
      sourceDeviceId: authority.device.publicId,
      sourceRevision: args.sourceRevision,
    });
    const existingExact = exact[0];
    if (
      existingExact !== undefined
        && (
          existingExact.userId !== authority.userId
          || existingExact.sourceDevicePublicId !== authority.device.publicId
        )
    ) rejectAuthority();
    if (existingExact !== undefined) {
      if (
        existingExact.digest === args.digest
        && existingExact.observedAt === args.observedAt
      ) return { disposition: "replay" as const, sourceRevision: args.sourceRevision };
      throw new Error("USAGE_SNAPSHOT_CONFLICT");
    }
    const latest = latestForSource[0];
    if (
      latest !== undefined
      && (
        latest.userId !== authority.userId
        || latest.sourceDevicePublicId !== authority.device.publicId
      )
    ) rejectAuthority();
    const storedFallback = latest === undefined
      ? null
      : {
          cursor: {
            digest: latest.digest,
            disposition: "stored" as const,
            observedAt: latest.observedAt,
            sourceRevision: latest.sourceRevision,
          },
          lastAcceptedAt: latest.receivedAt,
        };
    const usageAdmission = binding.usageAdmission ?? storedFallback;
    if (
      usageAdmission !== null
      && (
        !isFiniteTimestamp(usageAdmission.lastAcceptedAt)
        || !isDigest(usageAdmission.cursor.digest)
        || !isFiniteTimestamp(usageAdmission.cursor.observedAt)
        || !isSafePositiveInteger(usageAdmission.cursor.sourceRevision)
        || (
          latest !== undefined
          && latest.sourceRevision > usageAdmission.cursor.sourceRevision
        )
      )
    ) rejectAuthority();
    if (
      usageAdmission !== null
      && args.sourceRevision === usageAdmission.cursor.sourceRevision
    ) {
      if (
        args.digest !== usageAdmission.cursor.digest
        || args.observedAt !== usageAdmission.cursor.observedAt
      ) throw new Error("USAGE_SNAPSHOT_CONFLICT");
      return {
        disposition: usageAdmission.cursor.disposition === "coalesced"
          ? "coalesced" as const
          : "replay" as const,
        sourceRevision: args.sourceRevision,
      };
    }
    if (
      (usageAdmission !== null
        && args.sourceRevision < usageAdmission.cursor.sourceRevision)
      || (latest !== undefined && args.sourceRevision <= latest.sourceRevision)
    ) {
      throw new Error("USAGE_SNAPSHOT_STALE");
    }
    if (args.observedAt > now + 5 * 60 * 1_000) {
      throw new Error("USAGE_SNAPSHOT_FUTURE");
    }
    if (
      usageAdmission !== null
      && now - usageAdmission.lastAcceptedAt < USAGE_SERVER_ADMISSION_MIN_INTERVAL_MS
    ) {
      const bindingPatch = {
        updatedAt: now,
        usageAdmission: {
          cursor: {
            digest: args.digest,
            disposition: "coalesced" as const,
            observedAt: args.observedAt,
            sourceRevision: args.sourceRevision,
          },
          lastAcceptedAt: usageAdmission.lastAcceptedAt,
        },
      } as const;
      await adjustQuotaForPatch(ctx, authority.userId, "account", binding, bindingPatch);
      await ctx.db.patch(binding._id, bindingPatch);
      return { disposition: "coalesced" as const, sourceRevision: args.sourceRevision };
    }
    await releaseExpiredAccountUsage(ctx, {
      accountId: account._id,
      now,
      userId: authority.userId,
    });
    const current = await ctx.db
      .query("accountUsageSnapshots")
      .withIndex("by_account_and_winner", (builder) =>
        builder.eq("accountId", account._id))
      .order("desc")
      .take(1);
    const currentSnapshot = current[0];
    if (
      currentSnapshot !== undefined
      && (
        currentSnapshot.userId !== authority.userId
        || !isOpaqueIdentifier(currentSnapshot.sourceDevicePublicId)
      )
    ) rejectAuthority();
    const disposition = usageSnapshotDisposition(
      currentSnapshot === undefined
        ? null
        : snapshotOrder({
          digest: currentSnapshot.digest,
          observedAt: currentSnapshot.observedAt,
          sourceDeviceId: currentSnapshot.sourceDevicePublicId,
          sourceRevision: currentSnapshot.sourceRevision,
        }),
      null,
      candidate,
      now,
    );
    if (disposition === "conflict" || disposition === "future" || disposition === "stale") {
      throw new Error(`USAGE_SNAPSHOT_${disposition.toUpperCase()}`);
    }
    const snapshotDocument = {
      accountId: account._id,
      createdAt: now,
      digest: args.digest,
      envelope: args.envelope,
      observedAt: args.observedAt,
      receivedAt: now,
      sourceDeviceId: authority.deviceId,
      sourceDevicePublicId: authority.device.publicId,
      sourceRevision: args.sourceRevision,
      userId: authority.userId,
    } as const;
    await reserveAccountUsageSnapshotQuotaForInsert(
      ctx,
      authority.userId,
      account._id,
      snapshotDocument,
    );
    await ctx.db.insert("accountUsageSnapshots", snapshotDocument);
    const bindingPatch = {
      updatedAt: now,
      usageAdmission: {
        cursor: {
          digest: args.digest,
          disposition: "stored" as const,
          observedAt: args.observedAt,
          sourceRevision: args.sourceRevision,
        },
        lastAcceptedAt: now,
      },
    } as const;
    await adjustQuotaForPatch(ctx, authority.userId, "account", binding, bindingPatch);
    await ctx.db.patch(binding._id, bindingPatch);
    return { disposition, sourceRevision: args.sourceRevision };
  },
});

export const listSnapshots = query({
  args: { accountPublicId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.accountPublicId)
      || !isSafePositiveInteger(args.limit)
      || args.limit > cloudLimits.pageSize
    ) rejectAuthority();
    const accounts = await ctx.db
      .query("codexAccounts")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.accountPublicId))
      .take(2);
    const account = accounts[0];
    if (accounts.length !== 1 || account === undefined) rejectAuthority();
    const snapshots = await ctx.db
      .query("accountUsageSnapshots")
      .withIndex("by_account_and_winner", (builder) =>
        builder.eq("accountId", account._id))
      .order("desc")
      .take(args.limit);
    return snapshots.map((snapshot) => ({
      digest: snapshot.digest,
      envelope: snapshot.envelope,
      observedAt: snapshot.observedAt,
      receivedAt: snapshot.receivedAt,
      sourceRevision: snapshot.sourceRevision,
    }));
  },
});
