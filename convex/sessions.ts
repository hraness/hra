import { v, type GenericId as Id } from "convex/values";
import { paginationOptsValidator } from "convex/server";

import {
  cloudLimits,
  isDigest,
  isOpaqueIdentifier,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  parseEncryptedEnvelope,
} from "../src/cloud/contracts";
import {
  rejectAuthority,
  requireDeviceAuthority,
} from "./authority";
import {
  loadIdempotencyReceipt,
  storeIdempotencyReceipt,
} from "./idempotency";
import { requireLiveExecutionLease } from "./leases";
import {
  LIVE_TAIL_CHUNK_TTL_MS,
  LIVE_TAIL_ROW_CAP,
  LIVE_TAIL_ROW_CAP_TRIGGER,
} from "./lifecyclePolicy";
import {
  adjustQuotaForPatch,
  releaseLiveChunkResourceForDelete,
  releaseSessionChunkQuotaForDelete,
  reserveLiveChunkResourceForInsert,
  reserveQuotaForInsert,
  reserveSessionChunkQuotaForInsert,
  reserveSessionHeadQuotaForInsert,
} from "./quota";
import { mutation, query, type MutationCtx } from "./server";
import {
  authorityTuple,
  encryptedEnvelope,
  syncStream,
} from "./validators";

type SessionSummary = Readonly<{
  metadataRevision: number;
  projectionRevision: number;
  publicId: string;
  state: "active" | "idle" | "terminal" | "orphaned";
}>;

type CompactEpochSummary = Readonly<{
  boundaryHeadSequence: number;
  boundaryTailDigest: string;
  compactHasRecoveryGap: true;
  compactStreamEpoch: number;
  epochPublicId: string;
  projectionRevision: number;
  sessionPublicId: string;
}>;

function parseSessionSummary(value: unknown): SessionSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !isOpaqueIdentifier(record.publicId)
    || !isSafeNonNegativeInteger(record.metadataRevision)
    || !isSafeNonNegativeInteger(record.projectionRevision)
    || (record.state !== "active"
      && record.state !== "idle"
      && record.state !== "terminal"
      && record.state !== "orphaned")
  ) return null;
  return {
    metadataRevision: record.metadataRevision,
    projectionRevision: record.projectionRevision,
    publicId: record.publicId,
    state: record.state,
  };
}

function parseCompactEpochSummary(value: unknown): CompactEpochSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !isSafePositiveInteger(record.boundaryHeadSequence)
    || !isDigest(record.boundaryTailDigest)
    || record.compactHasRecoveryGap !== true
    || !isSafePositiveInteger(record.compactStreamEpoch)
    || !isUuidV7(record.epochPublicId)
    || !isSafePositiveInteger(record.projectionRevision)
    || !isOpaqueIdentifier(record.sessionPublicId)
  ) return null;
  return {
    boundaryHeadSequence: record.boundaryHeadSequence,
    boundaryTailDigest: record.boundaryTailDigest,
    compactHasRecoveryGap: true,
    compactStreamEpoch: record.compactStreamEpoch,
    epochPublicId: record.epochPublicId,
    projectionRevision: record.projectionRevision,
    sessionPublicId: record.sessionPublicId,
  };
}

function currentCompactStreamEpoch(session: Readonly<{ compactStreamEpoch?: number }>): number {
  const epoch = session.compactStreamEpoch ?? 0;
  if (!isSafeNonNegativeInteger(epoch)) rejectAuthority();
  return epoch;
}

function currentCompactRecoveryGap(session: Readonly<{ compactHasRecoveryGap?: boolean }>): boolean {
  const gap = session.compactHasRecoveryGap ?? false;
  if (typeof gap !== "boolean") rejectAuthority();
  return gap;
}

function currentDetailStreamEpoch(session: Readonly<{ detailStreamEpoch?: number }>): number {
  const epoch = session.detailStreamEpoch ?? 0;
  if (!isSafeNonNegativeInteger(epoch)) rejectAuthority();
  return epoch;
}

/**
 * Records a live_tail retention cut for the detail stream, mirroring the
 * compact sessionStreamEpochs mechanism but system-driven: no device
 * authority, idempotency key, or client replay protocol, since it is never
 * initiated by a client request. Called once per prune batch (never once
 * per deleted row) so an active session does not accumulate one epoch row
 * per pruned chunk. The caller is responsible for deleting the pruned rows
 * and releasing their quota; this only records the boundary and bumps the
 * session's detailStreamEpoch.
 */
export async function beginDetailRetentionEpoch(
  ctx: MutationCtx,
  session: Readonly<{
    _id: Id<"sessionHeads">;
    detailStreamEpoch?: number;
    executionDeviceId: Id<"devices">;
    projectionRevision: number;
    userId: Id<"users">;
  }>,
  boundaryHeadSequence: number,
  boundaryTailDigest: string,
): Promise<number> {
  const predecessorEpoch = currentDetailStreamEpoch(session);
  const nextEpoch = predecessorEpoch + 1;
  if (!isSafePositiveInteger(nextEpoch)) rejectAuthority();
  const now = Date.now();
  const epochDocument = {
    authority: { bootGeneration: 0, bootId: "system-live-tail-sweep", fence: 0 },
    boundaryHeadSequence,
    boundaryTailDigest,
    createdAt: now,
    epoch: nextEpoch,
    idempotencyKey: `live-tail-retention:${session._id}:${String(nextEpoch)}`,
    lineageCommitment: boundaryTailDigest,
    predecessorEpoch,
    projectionRevision: session.projectionRevision,
    publicId: crypto.randomUUID(),
    reason: "live_tail_retention",
    requestDigest: boundaryTailDigest,
    sessionId: session._id,
    sourceDeviceId: session.executionDeviceId,
    stream: "detail",
    userId: session.userId,
  } as const;
  await reserveQuotaForInsert(ctx, session.userId, "chunk", epochDocument);
  await ctx.db.insert("sessionStreamEpochs", epochDocument);
  await adjustQuotaForPatch(ctx, session.userId, "session", session, {
    detailStreamEpoch: nextEpoch,
  });
  await ctx.db.patch(session._id, { detailStreamEpoch: nextEpoch });
  return nextEpoch;
}

/**
 * Amortized live_tail row-cap enforcement: only prunes once a session holds
 * more than LIVE_TAIL_ROW_CAP + LIVE_TAIL_ROW_CAP_TRIGGER detail chunk rows,
 * and then deletes back down to LIVE_TAIL_ROW_CAP in one batch with exactly
 * one retention epoch for the whole batch. This keeps the common append
 * path (a session under the cap) to its existing single indexed read.
 */
export async function enforceLiveTailRowCap(
  ctx: MutationCtx,
  session: Readonly<{
    _id: Id<"sessionHeads">;
    detailStreamEpoch?: number;
    executionDeviceId: Id<"devices">;
    projectionRevision: number;
    userId: Id<"users">;
  }>,
): Promise<number> {
  const window = LIVE_TAIL_ROW_CAP + LIVE_TAIL_ROW_CAP_TRIGGER + 1;
  const oldest = await ctx.db
    .query("sessionChunks")
    .withIndex("by_session_stream_and_first", (builder) => builder
      .eq("sessionId", session._id)
      .eq("stream", "detail"))
    .order("asc")
    .take(window);
  if (oldest.length < window) return 0;
  const toDelete = oldest.slice(0, LIVE_TAIL_ROW_CAP_TRIGGER + 1);
  const survivor = oldest[LIVE_TAIL_ROW_CAP_TRIGGER];
  const cutDigest = toDelete.at(-1)?.digest;
  if (survivor === undefined || cutDigest === undefined) rejectAuthority();
  await beginDetailRetentionEpoch(ctx, session, survivor.firstSequence - 1, cutDigest);
  for (const chunk of toDelete) {
    if (chunk.userId !== session.userId) rejectAuthority();
    await releaseSessionChunkQuotaForDelete(ctx, session.userId, chunk);
    await releaseLiveChunkResourceForDelete(ctx, session.userId);
    await ctx.db.delete(chunk._id);
  }
  return toDelete.length;
}

export const create = mutation({
  args: {
    idempotencyKey: v.string(),
    metadata: v.optional(encryptedEnvelope),
    publicId: v.string(),
    requestDigest: v.string(),
  },
  handler: async (ctx, args): Promise<SessionSummary> => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.publicId)
      || (args.metadata !== undefined
        && parseEncryptedEnvelope(
          args.metadata,
          cloudLimits.metadataCiphertextCharacters,
        ) === null)
    ) rejectAuthority();
    const scope = {
      deviceId: authority.deviceId,
      operation: "session.create",
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
      const parsed = parseSessionSummary(replay);
      if (parsed === null) rejectAuthority();
      return parsed;
    }
    const duplicates = await ctx.db
      .query("sessionHeads")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.publicId))
      .take(1);
    if (duplicates.length !== 0) rejectAuthority();
    const now = Date.now();
    const sessionDocument = {
      compactHasRecoveryGap: false,
      compactHeadSequence: 0,
      compactStreamEpoch: 0,
      createdAt: now,
      detailHeadSequence: 0,
      executionDeviceId: authority.deviceId,
      ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
      metadataRevision: args.metadata === undefined ? 0 : 1,
      projectionRevision: 0,
      publicId: args.publicId,
      state: "active",
      updatedAt: now,
      userId: authority.userId,
    } as const;
    await reserveSessionHeadQuotaForInsert(ctx, authority.userId, sessionDocument);
    await ctx.db.insert("sessionHeads", sessionDocument);
    const response = {
      metadataRevision: args.metadata === undefined ? 0 : 1,
      projectionRevision: 0,
      publicId: args.publicId,
      state: "active" as const,
    };
    await storeIdempotencyReceipt(ctx, scope, {
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      response,
    });
    return response;
  },
});

export const listHeads = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isSafePositiveInteger(args.limit) || args.limit > cloudLimits.pageSize) {
      rejectAuthority();
    }
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_updated_at", (builder) =>
        builder.eq("userId", authority.userId))
      .order("desc")
      .take(args.limit);
    return await Promise.all(sessions.map(async (session) => {
      const executionDevice = await ctx.db.get(session.executionDeviceId);
      if (executionDevice?.userId !== authority.userId) {
        rejectAuthority();
      }
      return {
        compactHasRecoveryGap: currentCompactRecoveryGap(session),
        compactHeadSequence: session.compactHeadSequence,
        compactStreamEpoch: currentCompactStreamEpoch(session),
        ...(session.compactTailDigest === undefined
          ? {}
          : { compactTailDigest: session.compactTailDigest }),
        createdAt: session.createdAt,
        detailHeadSequence: session.detailHeadSequence,
        ...(session.detailTailDigest === undefined
          ? {}
          : { detailTailDigest: session.detailTailDigest }),
        executionDevicePublicId: executionDevice.publicId,
        ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
        metadataRevision: session.metadataRevision,
        projectionRevision: session.projectionRevision,
        publicId: session.publicId,
        state: session.state,
        updatedAt: session.updatedAt,
      };
    }));
  },
});

export const listHeadsPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > cloudLimits.pageSize
    ) rejectAuthority();
    const result = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_updated_at", (builder) =>
        builder.eq("userId", authority.userId))
      .order("desc")
      .paginate(args.paginationOpts);
    const page = await Promise.all(result.page.map(async (session) => {
      const executionDevice = await ctx.db.get(session.executionDeviceId);
      if (executionDevice?.userId !== authority.userId) rejectAuthority();
      return {
        compactHasRecoveryGap: currentCompactRecoveryGap(session),
        compactHeadSequence: session.compactHeadSequence,
        compactStreamEpoch: currentCompactStreamEpoch(session),
        ...(session.compactTailDigest === undefined
          ? {}
          : { compactTailDigest: session.compactTailDigest }),
        createdAt: session.createdAt,
        detailHeadSequence: session.detailHeadSequence,
        ...(session.detailTailDigest === undefined
          ? {}
          : { detailTailDigest: session.detailTailDigest }),
        executionDevicePublicId: executionDevice.publicId,
        ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
        metadataRevision: session.metadataRevision,
        projectionRevision: session.projectionRevision,
        publicId: session.publicId,
        state: session.state,
        updatedAt: session.updatedAt,
      };
    }));
    return {
      continueCursor: result.continueCursor,
      isDone: result.isDone,
      page,
      ...(result.pageStatus === undefined ? {} : { pageStatus: result.pageStatus }),
      ...(result.splitCursor === undefined ? {} : { splitCursor: result.splitCursor }),
    };
  },
});

export const getHead = query({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (!isOpaqueIdentifier(args.publicId)) rejectAuthority();
    const matches = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.publicId))
      .take(2);
    const session = matches[0];
    if (matches.length !== 1 || session === undefined) return null;
    const executionDevice = await ctx.db.get(session.executionDeviceId);
    if (executionDevice?.userId !== authority.userId) {
      rejectAuthority();
    }
    return {
      compactHasRecoveryGap: currentCompactRecoveryGap(session),
      compactHeadSequence: session.compactHeadSequence,
      compactStreamEpoch: currentCompactStreamEpoch(session),
      ...(session.compactTailDigest === undefined
        ? {}
        : { compactTailDigest: session.compactTailDigest }),
      createdAt: session.createdAt,
      detailHeadSequence: session.detailHeadSequence,
      detailStreamEpoch: currentDetailStreamEpoch(session),
      ...(session.detailTailDigest === undefined
        ? {}
        : { detailTailDigest: session.detailTailDigest }),
      executionDevicePublicId: executionDevice.publicId,
      ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
      metadataRevision: session.metadataRevision,
      projectionRevision: session.projectionRevision,
      publicId: session.publicId,
      state: session.state,
      updatedAt: session.updatedAt,
    };
  },
});

export const getChunks = query({
  args: {
    afterSequence: v.number(),
    limit: v.number(),
    sessionPublicId: v.string(),
    stream: syncStream,
  },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.sessionPublicId)
      || !isSafeNonNegativeInteger(args.afterSequence)
      || !isSafePositiveInteger(args.limit)
      || args.limit > cloudLimits.pageSize
    ) rejectAuthority();
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (sessions.length !== 1 || session === undefined) rejectAuthority();
    const chunks = await ctx.db
      .query("sessionChunks")
      .withIndex("by_session_stream_and_first", (builder) => builder
        .eq("sessionId", session._id)
        .eq("stream", args.stream)
        .gt("firstSequence", args.afterSequence))
      .take(args.limit);
    return await Promise.all(chunks.map(async (chunk) => {
      const sourceDevice = await ctx.db.get(chunk.sourceDeviceId);
      if (sourceDevice?.userId !== authority.userId) rejectAuthority();
      return {
        authority: chunk.authority,
        createdAt: chunk.createdAt,
        digest: chunk.digest,
        envelope: chunk.envelope,
        firstSequence: chunk.firstSequence,
        lastSequence: chunk.lastSequence,
        ...(chunk.previousDigest === undefined ? {} : { previousDigest: chunk.previousDigest }),
        sourceDevicePublicId: sourceDevice.publicId,
        stream: chunk.stream,
        streamEpoch: chunk.streamEpoch ?? 0,
      };
    }));
  },
});

export const getLatestChunks = query({
  args: {
    limit: v.number(),
    sessionPublicId: v.string(),
    stream: syncStream,
  },
  handler: async (ctx, args) => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.sessionPublicId)
      || !isSafePositiveInteger(args.limit)
      || args.limit > cloudLimits.pageSize
    ) rejectAuthority();
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (sessions.length !== 1 || session === undefined) rejectAuthority();
    const chunks = (await ctx.db
      .query("sessionChunks")
      .withIndex("by_session_stream_and_last", (builder) => builder
        .eq("sessionId", session._id)
        .eq("stream", args.stream))
      .order("desc")
      .take(args.limit))
      .reverse();
    return await Promise.all(chunks.map(async (chunk) => {
      const sourceDevice = await ctx.db.get(chunk.sourceDeviceId);
      if (sourceDevice?.userId !== authority.userId) rejectAuthority();
      return {
        authority: chunk.authority,
        createdAt: chunk.createdAt,
        digest: chunk.digest,
        envelope: chunk.envelope,
        firstSequence: chunk.firstSequence,
        lastSequence: chunk.lastSequence,
        ...(chunk.previousDigest === undefined ? {} : { previousDigest: chunk.previousDigest }),
        sourceDevicePublicId: sourceDevice.publicId,
        stream: chunk.stream,
        streamEpoch: chunk.streamEpoch ?? 0,
      };
    }));
  },
});

export const beginCompactEpoch = mutation({
  args: {
    authority: authorityTuple,
    epochPublicId: v.string(),
    expectedCompactStreamEpoch: v.number(),
    expectedHeadSequence: v.number(),
    expectedTailDigest: v.optional(v.string()),
    idempotencyKey: v.string(),
    lineageCommitment: v.string(),
    requestDigest: v.string(),
    sessionPublicId: v.string(),
  },
  handler: async (ctx, args) => {
    const current = await requireDeviceAuthority(ctx);
    if (
      !isUuidV7(args.epochPublicId)
      || !isSafeNonNegativeInteger(args.expectedCompactStreamEpoch)
      || !isSafePositiveInteger(args.expectedHeadSequence)
      || args.expectedTailDigest === undefined
      || !isDigest(args.expectedTailDigest)
      || !isOpaqueIdentifier(args.lineageCommitment)
      || !isDigest(args.requestDigest)
      || !isOpaqueIdentifier(args.sessionPublicId)
    ) rejectAuthority();
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", current.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (
      sessions.length !== 1
      || session?.executionDeviceId !== current.deviceId
    ) rejectAuthority();
    const lineageByPublicId = await ctx.db
      .query("sessionStreamEpochs")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.epochPublicId))
      .take(2);
    if (lineageByPublicId.length !== 0) {
      const lineage = lineageByPublicId[0];
      const committedProjectionRevision = lineage?.projectionRevision;
      if (
        lineageByPublicId.length !== 1
        || lineage?.sessionId !== session._id
        || lineage.userId !== current.userId
        || lineage.sourceDeviceId !== current.deviceId
        || lineage.epoch !== args.expectedCompactStreamEpoch + 1
        || lineage.predecessorEpoch !== args.expectedCompactStreamEpoch
        || lineage.boundaryHeadSequence !== args.expectedHeadSequence
        || lineage.boundaryTailDigest !== args.expectedTailDigest
        || lineage.authority.bootGeneration !== args.authority.bootGeneration
        || lineage.authority.bootId !== args.authority.bootId
        || lineage.authority.fence !== args.authority.fence
        || lineage.lineageCommitment !== args.lineageCommitment
        || lineage.requestDigest !== args.requestDigest
        || lineage.idempotencyKey !== args.idempotencyKey
        || !isSafePositiveInteger(committedProjectionRevision)
        || !currentCompactRecoveryGap(session)
        || currentCompactStreamEpoch(session) < lineage.epoch
        || !isSafeNonNegativeInteger(session.compactHeadSequence)
        || session.compactHeadSequence < lineage.boundaryHeadSequence
        || !isDigest(session.compactTailDigest)
        || (session.compactHeadSequence === lineage.boundaryHeadSequence
          && session.compactTailDigest !== lineage.boundaryTailDigest)
        || !isSafeNonNegativeInteger(session.projectionRevision)
        || session.projectionRevision < committedProjectionRevision
      ) rejectAuthority();
      return {
        boundaryHeadSequence: lineage.boundaryHeadSequence,
        boundaryTailDigest: lineage.boundaryTailDigest,
        compactHasRecoveryGap: true as const,
        compactStreamEpoch: lineage.epoch,
        epochPublicId: lineage.publicId,
        projectionRevision: committedProjectionRevision,
        sessionPublicId: session.publicId,
      };
    }
    const scope = {
      deviceId: current.deviceId,
      operation: "session.compact_epoch",
      scopeId: session.publicId,
      userId: current.userId,
    } as const;
    const replay = await loadIdempotencyReceipt(
      ctx,
      scope,
      args.idempotencyKey,
      args.requestDigest,
    );
    if (replay !== null) {
      const parsed = parseCompactEpochSummary(replay);
      if (
        parsed === null
        || parsed.boundaryHeadSequence !== args.expectedHeadSequence
        || parsed.boundaryTailDigest !== args.expectedTailDigest
        || parsed.compactStreamEpoch !== args.expectedCompactStreamEpoch + 1
        || parsed.epochPublicId !== args.epochPublicId
        || parsed.sessionPublicId !== session.publicId
        || !currentCompactRecoveryGap(session)
        || currentCompactStreamEpoch(session) < parsed.compactStreamEpoch
        || session.projectionRevision < parsed.projectionRevision
      ) rejectAuthority();
      const lineageMatches = await ctx.db
        .query("sessionStreamEpochs")
        .withIndex("by_session_stream_and_epoch", (builder) => builder
          .eq("sessionId", session._id)
          .eq("stream", "compact")
          .eq("epoch", parsed.compactStreamEpoch))
        .take(2);
      const lineage = lineageMatches[0];
      if (
        lineageMatches.length !== 1
        || lineage?.publicId !== args.epochPublicId
        || lineage.predecessorEpoch !== args.expectedCompactStreamEpoch
        || lineage.boundaryHeadSequence !== args.expectedHeadSequence
        || lineage.boundaryTailDigest !== args.expectedTailDigest
        || lineage.sourceDeviceId !== current.deviceId
        || lineage.userId !== current.userId
        || lineage.authority.bootGeneration !== args.authority.bootGeneration
        || lineage.authority.bootId !== args.authority.bootId
        || lineage.authority.fence !== args.authority.fence
        || lineage.lineageCommitment !== args.lineageCommitment
        || lineage.requestDigest !== args.requestDigest
        || lineage.idempotencyKey !== args.idempotencyKey
        || lineage.projectionRevision !== parsed.projectionRevision
      ) rejectAuthority();
      return parsed;
    }
    if (session.state === "orphaned" || session.state === "terminal") rejectAuthority();
    await requireLiveExecutionLease(ctx, {
      authority: args.authority,
      deviceId: current.deviceId,
      sessionId: session._id,
      userId: current.userId,
    });
    const compactStreamEpoch = currentCompactStreamEpoch(session);
    const nextEpoch = compactStreamEpoch + 1;
    const nextProjectionRevision = session.projectionRevision + 1;
    if (
      compactStreamEpoch !== args.expectedCompactStreamEpoch
      || session.compactHeadSequence !== args.expectedHeadSequence
      || session.compactTailDigest !== args.expectedTailDigest
      || !isSafePositiveInteger(nextEpoch)
      || !isSafePositiveInteger(nextProjectionRevision)
    ) throw new Error("SESSION_COMPACT_EPOCH_CONFLICT");
    const [epochMatches, publicIdMatches] = await Promise.all([
      ctx.db
        .query("sessionStreamEpochs")
        .withIndex("by_session_stream_and_epoch", (builder) => builder
          .eq("sessionId", session._id)
          .eq("stream", "compact")
          .eq("epoch", nextEpoch))
        .take(2),
      ctx.db
        .query("sessionStreamEpochs")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", args.epochPublicId))
        .take(1),
    ]);
    if (epochMatches.length !== 0 || publicIdMatches.length !== 0) {
      throw new Error("SESSION_COMPACT_EPOCH_CONFLICT");
    }
    const now = Date.now();
    const epochDocument = {
      authority: args.authority,
      boundaryHeadSequence: args.expectedHeadSequence,
      boundaryTailDigest: args.expectedTailDigest,
      createdAt: now,
      epoch: nextEpoch,
      idempotencyKey: args.idempotencyKey,
      lineageCommitment: args.lineageCommitment,
      predecessorEpoch: compactStreamEpoch,
      projectionRevision: nextProjectionRevision,
      publicId: args.epochPublicId,
      reason: "projection_cache_recovery",
      requestDigest: args.requestDigest,
      sessionId: session._id,
      sourceDeviceId: current.deviceId,
      stream: "compact",
      userId: current.userId,
    } as const;
    await reserveQuotaForInsert(ctx, current.userId, "chunk", epochDocument);
    await ctx.db.insert("sessionStreamEpochs", epochDocument);
    const sessionPatch = {
      compactHasRecoveryGap: true,
      compactStreamEpoch: nextEpoch,
      projectionRevision: nextProjectionRevision,
    } as const;
    await adjustQuotaForPatch(ctx, current.userId, "session", session, sessionPatch);
    await ctx.db.patch(session._id, sessionPatch);
    const response: CompactEpochSummary = {
      boundaryHeadSequence: args.expectedHeadSequence,
      boundaryTailDigest: args.expectedTailDigest,
      compactHasRecoveryGap: true,
      compactStreamEpoch: nextEpoch,
      epochPublicId: args.epochPublicId,
      projectionRevision: nextProjectionRevision,
      sessionPublicId: session.publicId,
    };
    await storeIdempotencyReceipt(ctx, scope, {
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      response,
    });
    return response;
  },
});

export const appendChunk = mutation({
  args: {
    authority: authorityTuple,
    digest: v.string(),
    envelope: encryptedEnvelope,
    expectedHeadSequence: v.number(),
    expectedStreamEpoch: v.number(),
    expectedTailDigest: v.optional(v.string()),
    firstSequence: v.number(),
    lastSequence: v.number(),
    previousDigest: v.optional(v.string()),
    sessionPublicId: v.string(),
    stream: syncStream,
  },
  handler: async (ctx, args) => {
    const current = await requireDeviceAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.sessionPublicId)
      || !isSafeNonNegativeInteger(args.expectedHeadSequence)
      || !isSafeNonNegativeInteger(args.expectedStreamEpoch)
      || !isSafePositiveInteger(args.firstSequence)
      || !isSafePositiveInteger(args.lastSequence)
      || args.firstSequence !== args.expectedHeadSequence + 1
      || args.lastSequence < args.firstSequence
      || !isDigest(args.digest)
      || (args.previousDigest !== undefined && !isDigest(args.previousDigest))
      || (args.expectedTailDigest !== undefined && !isDigest(args.expectedTailDigest))
      || parseEncryptedEnvelope(args.envelope) === null
    ) rejectAuthority();
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", current.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (
      sessions.length !== 1
      || session?.executionDeviceId !== current.deviceId
      || session.state === "orphaned"
      || (session.state === "terminal" && args.stream !== "compact")
    ) rejectAuthority();
    await requireLiveExecutionLease(ctx, {
      authority: args.authority,
      deviceId: current.deviceId,
      sessionId: session._id,
      userId: current.userId,
    });
    const existing = await ctx.db
      .query("sessionChunks")
      .withIndex("by_session_stream_and_first", (builder) => builder
        .eq("sessionId", session._id)
        .eq("stream", args.stream)
        .eq("firstSequence", args.firstSequence))
      .take(2);
    if (existing.length > 1) rejectAuthority();
    const replay = existing[0];
    if (replay !== undefined) {
      if (
        replay.lastSequence !== args.lastSequence
        || replay.digest !== args.digest
        || replay.previousDigest !== args.previousDigest
        || (replay.streamEpoch ?? 0) !== args.expectedStreamEpoch
        || JSON.stringify(replay.envelope) !== JSON.stringify(args.envelope)
      ) throw new Error("SESSION_CHUNK_CONFLICT");
      return {
        digest: replay.digest,
        headSequence: replay.lastSequence,
        replay: true,
        streamEpoch: replay.streamEpoch ?? 0,
      };
    }
    const headSequence = args.stream === "compact"
      ? session.compactHeadSequence
      : session.detailHeadSequence;
    const tailDigest = args.stream === "compact"
      ? session.compactTailDigest
      : session.detailTailDigest;
    const streamEpoch = args.stream === "compact"
      ? currentCompactStreamEpoch(session)
      : currentDetailStreamEpoch(session);
    if (
      headSequence !== args.expectedHeadSequence
      || streamEpoch !== args.expectedStreamEpoch
      || tailDigest !== args.expectedTailDigest
      || args.previousDigest !== tailDigest
      || !isSafePositiveInteger(session.projectionRevision + 1)
    ) throw new Error("SESSION_HEAD_CONFLICT");
    const now = Date.now();
    const chunkDocument = {
      authority: args.authority,
      createdAt: now,
      digest: args.digest,
      envelope: args.envelope,
      ...(args.stream === "detail" ? { expiresAt: now + LIVE_TAIL_CHUNK_TTL_MS } : {}),
      firstSequence: args.firstSequence,
      lastSequence: args.lastSequence,
      ...(args.previousDigest === undefined ? {} : { previousDigest: args.previousDigest }),
      sessionId: session._id,
      sourceDeviceId: current.deviceId,
      stream: args.stream,
      streamEpoch,
      userId: current.userId,
    } as const;
    await reserveSessionChunkQuotaForInsert(ctx, current.userId, chunkDocument);
    if (args.stream === "detail") {
      await reserveLiveChunkResourceForInsert(ctx, current.userId);
    }
    await ctx.db.insert("sessionChunks", chunkDocument);
    const sessionPatch = {
      ...(args.stream === "compact"
        ? { compactHeadSequence: args.lastSequence, compactTailDigest: args.digest }
        : { detailHeadSequence: args.lastSequence, detailTailDigest: args.digest }),
      projectionRevision: session.projectionRevision + 1,
      updatedAt: now,
    };
    await adjustQuotaForPatch(ctx, current.userId, "session", session, sessionPatch);
    await ctx.db.patch(session._id, sessionPatch);
    if (args.stream === "detail") {
      await enforceLiveTailRowCap(ctx, { ...session, ...sessionPatch });
    }
    return {
      digest: args.digest,
      headSequence: args.lastSequence,
      replay: false,
      streamEpoch,
    };
  },
});

export const updateMetadata = mutation({
  args: {
    expectedRevision: v.number(),
    idempotencyKey: v.string(),
    metadata: encryptedEnvelope,
    requestDigest: v.string(),
    sessionPublicId: v.string(),
  },
  handler: async (ctx, args): Promise<SessionSummary> => {
    const authority = await requireDeviceAuthority(ctx);
    if (
      !isOpaqueIdentifier(args.sessionPublicId)
      || !isSafeNonNegativeInteger(args.expectedRevision)
      || parseEncryptedEnvelope(
        args.metadata,
        cloudLimits.metadataCiphertextCharacters,
      ) === null
    ) rejectAuthority();
    const scope = {
      deviceId: authority.deviceId,
      operation: "session.metadata",
      scopeId: args.sessionPublicId,
      userId: authority.userId,
    } as const;
    const replay = await loadIdempotencyReceipt(
      ctx,
      scope,
      args.idempotencyKey,
      args.requestDigest,
    );
    if (replay !== null) {
      const parsed = parseSessionSummary(replay);
      if (parsed === null) rejectAuthority();
      return parsed;
    }
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (
      sessions.length !== 1
      || session?.metadataRevision !== args.expectedRevision
    ) throw new Error("SESSION_METADATA_CONFLICT");
    const now = Date.now();
    const sessionPatch = {
      metadata: args.metadata,
      metadataRevision: session.metadataRevision + 1,
      updatedAt: now,
    } as const;
    await adjustQuotaForPatch(ctx, authority.userId, "session", session, sessionPatch);
    await ctx.db.patch(session._id, sessionPatch);
    const response = {
      metadataRevision: session.metadataRevision + 1,
      projectionRevision: session.projectionRevision,
      publicId: session.publicId,
      state: session.state,
    };
    await storeIdempotencyReceipt(ctx, scope, {
      idempotencyKey: args.idempotencyKey,
      requestDigest: args.requestDigest,
      response,
    });
    return response;
  },
});

export const updateState = mutation({
  args: {
    authority: authorityTuple,
    expectedState: v.union(v.literal("active"), v.literal("idle")),
    sessionPublicId: v.string(),
    state: v.union(v.literal("active"), v.literal("idle"), v.literal("terminal")),
  },
  handler: async (ctx, args) => {
    const current = await requireDeviceAuthority(ctx);
    if (!isOpaqueIdentifier(args.sessionPublicId)) rejectAuthority();
    const sessions = await ctx.db
      .query("sessionHeads")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", current.userId)
        .eq("publicId", args.sessionPublicId))
      .take(2);
    const session = sessions[0];
    if (
      sessions.length !== 1
      || session?.executionDeviceId !== current.deviceId
      || session.state === "orphaned"
    ) rejectAuthority();
    if (session.state === args.state) {
      return { publicId: session.publicId, replay: true, state: session.state };
    }
    if (session.state !== args.expectedState) {
      throw new Error("SESSION_STATE_CONFLICT");
    }
    if (args.state === "terminal") {
      const unsettled = await Promise.all(
        (["pending", "prepared", "effect_started"] as const).map(async (state) =>
          await ctx.db
            .query("sessionCommands")
            .withIndex("by_session_and_state", (builder) => builder
              .eq("sessionId", session._id)
              .eq("state", state))
            .take(1)),
      );
      if (unsettled.some((commands) => commands.length !== 0)) {
        throw new Error("SESSION_COMMANDS_UNSETTLED");
      }
    }
    await requireLiveExecutionLease(ctx, {
      authority: args.authority,
      deviceId: current.deviceId,
      sessionId: session._id,
      userId: current.userId,
    });
    const sessionPatch = {
      state: args.state,
      updatedAt: Date.now(),
    } as const;
    await adjustQuotaForPatch(ctx, current.userId, "session", session, sessionPatch);
    await ctx.db.patch(session._id, sessionPatch);
    return { publicId: session.publicId, replay: false, state: args.state };
  },
});
