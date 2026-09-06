import { v, type GenericId as Id } from "convex/values";

import {
  canonicalMemoryCiphertextLimits,
  parseCanonicalMemoryHostedSpaceId,
} from "../src/domain/canonical-memory-sync";
import {
  isDigest,
  parseEncryptedEnvelope,
  type EncryptedEnvelope,
} from "../src/cloud/contracts";
import { requireDaemonDevice } from "./authority";
import {
  reserveMemorySpaceQuotaForInsert,
  reserveQuotaForInsert,
} from "./quota";
import { mutation, query, type MutationCtx, type QueryCtx } from "./server";
import { encryptedEnvelope } from "./validators";

export const memorySyncLimits = Object.freeze({
  adoptionProofCiphertextCharacters: canonicalMemoryCiphertextLimits.adoptionProof,
  descriptorCiphertextCharacters: canonicalMemoryCiphertextLimits.terminalHeadProof,
  listSpaces: 100,
  operationCiphertextCharacters: canonicalMemoryCiphertextLimits.operation,
  pullOperations: 1,
  pushOperations: 1,
  terminalHeadProofCiphertextCharacters: canonicalMemoryCiphertextLimits.terminalHeadProof,
  wrappedSpaceKeyCiphertextCharacters: canonicalMemoryCiphertextLimits.terminalHeadProof,
} as const);

const memoryOperationInput = v.object({
  adoptionProof: v.union(v.null(), encryptedEnvelope),
  genesisToken: v.string(),
  headToken: v.string(),
  operation: encryptedEnvelope,
  priorToken: v.string(),
  sequence: v.number(),
  terminalHeadProof: encryptedEnvelope,
});

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

type SpaceShape = Readonly<{
  _id: Id<"memorySpaces">;
  bindingPolicy: "one_project_one_space";
  createdAt: number;
  encryptedDescriptor: EncryptedEnvelope;
  genesisHeadProof: EncryptedEnvelope;
  genesisToken: string;
  identityContract: 2;
  keyVersion: number;
  publicId: string;
  revision: number;
  updatedAt: number;
  userId: Id<"users">;
  wrappedSpaceKey: EncryptedEnvelope;
}>;

type OperationShape = Readonly<{
  _id: Id<"memoryOperations">;
  adoptionProof: EncryptedEnvelope | null;
  baseRevision: number;
  createdAt: number;
  genesisToken: string;
  headToken: string;
  keyVersion: number;
  memorySpaceId: Id<"memorySpaces">;
  operation: EncryptedEnvelope;
  priorToken: string;
  sequence: number;
  sourceDeviceId: Id<"devices">;
  terminalHeadProof: EncryptedEnvelope;
  userId: Id<"users">;
}>;

type HeadState = Readonly<{
  headToken: string;
  sequence: number;
  terminalHeadProof: EncryptedEnvelope;
}>;

function rejectInvalid(): never {
  throw new Error("MEMORY_SYNC_INVALID");
}

function rejectConflict(): never {
  throw new Error("MEMORY_SYNC_CONFLICT");
}

function rejectMissing(): never {
  throw new Error("MEMORY_SPACE_MISSING");
}

function rejectCorrupt(): never {
  throw new Error("MEMORY_SYNC_STORAGE_CORRUPT");
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function safePositiveInteger(value: unknown): value is number {
  return safeNonNegativeInteger(value) && value > 0;
}

function validEnvelope(
  value: unknown,
  maximumCiphertextCharacters: number,
  keyVersion?: number,
): value is EncryptedEnvelope {
  const parsed = parseEncryptedEnvelope(value, maximumCiphertextCharacters);
  return parsed !== null && (keyVersion === undefined || parsed.keyVersion === keyVersion);
}

function sameEnvelope(left: EncryptedEnvelope, right: EncryptedEnvelope): boolean {
  return left.ciphertext === right.ciphertext
    && left.keyVersion === right.keyVersion
    && left.nonce === right.nonce;
}

function sameNullableEnvelope(
  left: EncryptedEnvelope | null,
  right: EncryptedEnvelope | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameEnvelope(left, right);
}

function requireSpaceIntegrity(space: SpaceShape, userId: Id<"users">): void {
  if (
    space.userId !== userId
    || parseCanonicalMemoryHostedSpaceId(space.publicId) === null
    || !isDigest(space.genesisToken)
    || !safePositiveInteger(space.keyVersion)
    || !safePositiveInteger(space.revision)
    || !safeNonNegativeInteger(space.createdAt)
    || !safeNonNegativeInteger(space.updatedAt)
    || space.updatedAt < space.createdAt
    || !validEnvelope(
      space.encryptedDescriptor,
      memorySyncLimits.descriptorCiphertextCharacters,
      space.keyVersion,
    )
    || !validEnvelope(
      space.genesisHeadProof,
      memorySyncLimits.terminalHeadProofCiphertextCharacters,
      space.keyVersion,
    )
    || !validEnvelope(
      space.wrappedSpaceKey,
      memorySyncLimits.wrappedSpaceKeyCiphertextCharacters,
    )
  ) rejectCorrupt();
}

function requireOperationIntegrity(
  operation: OperationShape,
  space: SpaceShape,
): void {
  if (
    operation.userId !== space.userId
    || operation.memorySpaceId !== space._id
    || !safePositiveInteger(operation.baseRevision)
    || !safeNonNegativeInteger(operation.createdAt)
    || !safePositiveInteger(operation.sequence)
    || !safePositiveInteger(operation.keyVersion)
    || operation.genesisToken !== space.genesisToken
    || !isDigest(operation.priorToken)
    || !isDigest(operation.headToken)
    || operation.priorToken === operation.headToken
    || (operation.adoptionProof !== null && !validEnvelope(
      operation.adoptionProof,
      memorySyncLimits.adoptionProofCiphertextCharacters,
      operation.keyVersion,
    ))
    || !validEnvelope(
      operation.operation,
      memorySyncLimits.operationCiphertextCharacters,
      operation.keyVersion,
    )
    || !validEnvelope(
      operation.terminalHeadProof,
      memorySyncLimits.terminalHeadProofCiphertextCharacters,
      operation.keyVersion,
    )
  ) rejectCorrupt();
}

async function loadOwnedSpace(
  ctx: ReadCtx,
  userId: Id<"users">,
  publicId: string,
): Promise<SpaceShape> {
  const spaces = await ctx.db.query("memorySpaces")
    .withIndex("by_user_and_public_id", (builder) => builder
      .eq("userId", userId)
      .eq("publicId", publicId))
    .take(2);
  if (spaces.length === 0) rejectMissing();
  if (spaces.length !== 1) rejectCorrupt();
  const space = spaces[0] as SpaceShape;
  requireSpaceIntegrity(space, userId);
  return space;
}

async function operationAt(
  ctx: ReadCtx,
  space: SpaceShape,
  sequence: number,
): Promise<OperationShape | null> {
  const operations = await ctx.db.query("memoryOperations")
    .withIndex("by_space_and_sequence", (builder) => builder
      .eq("memorySpaceId", space._id)
      .eq("sequence", sequence))
    .take(2);
  if (operations.length > 1) rejectCorrupt();
  const operation = operations[0] as OperationShape | undefined;
  if (operation === undefined) return null;
  requireOperationIntegrity(operation, space);
  return operation;
}

async function requireBoundary(
  ctx: ReadCtx,
  space: SpaceShape,
  sequence: number,
  token: string,
): Promise<OperationShape | null> {
  if (sequence === 0) {
    if (token !== space.genesisToken) rejectConflict();
    return null;
  }
  const operation = await operationAt(ctx, space, sequence);
  if (operation === null) rejectCorrupt();
  if (operation.headToken !== token) rejectConflict();
  return operation;
}

async function currentHead(ctx: ReadCtx, space: SpaceShape): Promise<HeadState> {
  const latest = await ctx.db.query("memoryOperations")
    .withIndex("by_space_and_sequence", (builder) => builder.eq("memorySpaceId", space._id))
    .order("desc")
    .take(2);
  const terminal = latest[0] as OperationShape | undefined;
  if (terminal === undefined) {
    return {
      headToken: space.genesisToken,
      sequence: 0,
      terminalHeadProof: space.genesisHeadProof,
    };
  }
  requireOperationIntegrity(terminal, space);
  if (
    terminal.baseRevision !== space.revision
    || terminal.keyVersion !== space.keyVersion
    || (terminal.sequence === 1 && terminal.priorToken !== space.genesisToken)
  ) rejectCorrupt();
  const predecessor = latest[1] as OperationShape | undefined;
  if (terminal.sequence > 1) {
    if (predecessor === undefined) rejectCorrupt();
    requireOperationIntegrity(predecessor, space);
    if (
      predecessor.sequence !== terminal.sequence - 1
      || predecessor.headToken !== terminal.priorToken
    ) rejectCorrupt();
  }
  return {
    headToken: terminal.headToken,
    sequence: terminal.sequence,
    terminalHeadProof: terminal.terminalHeadProof,
  };
}

function summary(space: SpaceShape) {
  return {
    bindingPolicy: space.bindingPolicy,
    identityContract: space.identityContract,
    keyVersion: space.keyVersion,
    revision: space.revision,
    spaceId: space.publicId,
  };
}

function configuration(space: SpaceShape) {
  return {
    ...summary(space),
    encryptedDescriptor: space.encryptedDescriptor,
    genesisHeadProof: space.genesisHeadProof,
    genesisToken: space.genesisToken,
    wrappedSpaceKey: space.wrappedSpaceKey,
  };
}

function publicHead(space: SpaceShape, state: HeadState) {
  return {
    genesisToken: space.genesisToken,
    headToken: state.headToken,
    keyVersion: space.keyVersion,
    revision: space.revision,
    sequence: state.sequence,
    spaceId: space.publicId,
    terminalHeadProof: state.terminalHeadProof,
  };
}

function publicOperation(operation: OperationShape) {
  return {
    adoptionProof: operation.adoptionProof,
    genesisToken: operation.genesisToken,
    headToken: operation.headToken,
    operation: operation.operation,
    priorToken: operation.priorToken,
    sequence: operation.sequence,
    terminalHeadProof: operation.terminalHeadProof,
  };
}

function writeResult(space: SpaceShape, operation: Readonly<{
  headToken: string;
  sequence: number;
  terminalHeadProof: EncryptedEnvelope;
}>, replay: boolean) {
  return {
    acceptedHeadToken: operation.headToken,
    acceptedSequence: operation.sequence,
    acceptedTerminalHeadProof: operation.terminalHeadProof,
    keyVersion: space.keyVersion,
    replay,
    revision: space.revision,
    spaceId: space.publicId,
  };
}

function requireSpaceId(value: string): void {
  if (parseCanonicalMemoryHostedSpaceId(value) === null) rejectInvalid();
}

export const create = mutation({
  args: {
    bindingPolicy: v.literal("one_project_one_space"),
    encryptedDescriptor: encryptedEnvelope,
    genesisHeadProof: encryptedEnvelope,
    genesisToken: v.string(),
    identityContract: v.literal(2),
    keyVersion: v.number(),
    spaceId: v.string(),
    wrappedSpaceKey: encryptedEnvelope,
  },
  handler: async (ctx, args) => {
    const authority = await requireDaemonDevice(ctx);
    requireSpaceId(args.spaceId);
    if (
      !isDigest(args.genesisToken)
      || !safePositiveInteger(args.keyVersion)
      || !validEnvelope(
        args.encryptedDescriptor,
        memorySyncLimits.descriptorCiphertextCharacters,
        args.keyVersion,
      )
      || !validEnvelope(
        args.genesisHeadProof,
        memorySyncLimits.terminalHeadProofCiphertextCharacters,
        args.keyVersion,
      )
      || !validEnvelope(
        args.wrappedSpaceKey,
        memorySyncLimits.wrappedSpaceKeyCiphertextCharacters,
      )
    ) rejectInvalid();
    const matches = await ctx.db.query("memorySpaces")
      .withIndex("by_user_and_public_id", (builder) => builder
        .eq("userId", authority.userId)
        .eq("publicId", args.spaceId))
      .take(2);
    if (matches.length > 1) rejectCorrupt();
    const existing = matches[0] as SpaceShape | undefined;
    if (existing !== undefined) {
      requireSpaceIntegrity(existing, authority.userId);
      if (
        existing.genesisToken !== args.genesisToken
        || existing.keyVersion !== args.keyVersion
        || !sameEnvelope(existing.encryptedDescriptor, args.encryptedDescriptor)
        || !sameEnvelope(existing.genesisHeadProof, args.genesisHeadProof)
        || !sameEnvelope(existing.wrappedSpaceKey, args.wrappedSpaceKey)
      ) rejectConflict();
      return { ...configuration(existing), replay: true };
    }
    const now = Date.now();
    const document = {
      bindingPolicy: args.bindingPolicy,
      createdAt: now,
      encryptedDescriptor: args.encryptedDescriptor,
      genesisHeadProof: args.genesisHeadProof,
      genesisToken: args.genesisToken,
      identityContract: args.identityContract,
      keyVersion: args.keyVersion,
      publicId: args.spaceId,
      revision: 1,
      updatedAt: now,
      userId: authority.userId,
      wrappedSpaceKey: args.wrappedSpaceKey,
    } as const;
    await reserveMemorySpaceQuotaForInsert(ctx, authority.userId, document);
    const rowId = await ctx.db.insert("memorySpaces", document);
    const space = await ctx.db.get(rowId);
    if (space === null) rejectCorrupt();
    return { ...configuration(space), replay: false };
  },
});

export const list = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const authority = await requireDaemonDevice(ctx);
    if (!safePositiveInteger(args.limit) || args.limit > memorySyncLimits.listSpaces) {
      rejectInvalid();
    }
    const spaces = await ctx.db.query("memorySpaces")
      .withIndex("by_user_and_updated_at", (builder) => builder.eq("userId", authority.userId))
      .order("desc")
      .take(args.limit);
    return spaces.map((space) => {
      requireSpaceIntegrity(space, authority.userId);
      return summary(space);
    });
  },
});

export const get = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDaemonDevice(ctx);
    requireSpaceId(args.spaceId);
    return configuration(await loadOwnedSpace(ctx, authority.userId, args.spaceId));
  },
});

export const head = query({
  args: { spaceId: v.string() },
  handler: async (ctx, args) => {
    const authority = await requireDaemonDevice(ctx);
    requireSpaceId(args.spaceId);
    const space = await loadOwnedSpace(ctx, authority.userId, args.spaceId);
    return publicHead(space, await currentHead(ctx, space));
  },
});

export const push = mutation({
  args: {
    expectedKeyVersion: v.number(),
    expectedRevision: v.number(),
    operations: v.array(memoryOperationInput),
    spaceId: v.string(),
  },
  handler: async (ctx, args) => {
    const authority = await requireDaemonDevice(ctx);
    requireSpaceId(args.spaceId);
    if (
      !safePositiveInteger(args.expectedKeyVersion)
      || !safePositiveInteger(args.expectedRevision)
      || args.operations.length !== memorySyncLimits.pushOperations
    ) rejectInvalid();
    const operation = args.operations[0];
    if (
      operation === undefined
      || !isDigest(operation.genesisToken)
      || !isDigest(operation.priorToken)
      || !isDigest(operation.headToken)
      || operation.priorToken === operation.headToken
      || !safePositiveInteger(operation.sequence)
      || (operation.adoptionProof !== null && !validEnvelope(
        operation.adoptionProof,
        memorySyncLimits.adoptionProofCiphertextCharacters,
        args.expectedKeyVersion,
      ))
      || !validEnvelope(
        operation.operation,
        memorySyncLimits.operationCiphertextCharacters,
        args.expectedKeyVersion,
      )
      || !validEnvelope(
        operation.terminalHeadProof,
        memorySyncLimits.terminalHeadProofCiphertextCharacters,
        args.expectedKeyVersion,
      )
    ) rejectInvalid();
    const space = await loadOwnedSpace(ctx, authority.userId, args.spaceId);
    const existing = await operationAt(ctx, space, operation.sequence);
    if (existing !== null) {
      if (
        existing.baseRevision !== args.expectedRevision
        || existing.keyVersion !== args.expectedKeyVersion
        || !sameNullableEnvelope(existing.adoptionProof, operation.adoptionProof)
        || existing.genesisToken !== operation.genesisToken
        || existing.priorToken !== operation.priorToken
        || existing.headToken !== operation.headToken
        || !sameEnvelope(existing.operation, operation.operation)
        || !sameEnvelope(existing.terminalHeadProof, operation.terminalHeadProof)
      ) rejectConflict();
      await currentHead(ctx, space);
      return writeResult(space, existing, true);
    }
    const current = await currentHead(ctx, space);
    if (
      args.expectedRevision !== space.revision
      || args.expectedKeyVersion !== space.keyVersion
      || operation.genesisToken !== space.genesisToken
      || operation.sequence !== current.sequence + 1
      || operation.priorToken !== current.headToken
      || operation.headToken === space.genesisToken
    ) rejectConflict();
    const reusedTokens = await ctx.db.query("memoryOperations")
      .withIndex("by_space_and_head_token", (builder) => builder
        .eq("memorySpaceId", space._id)
        .eq("headToken", operation.headToken))
      .take(1);
    if (reusedTokens.length !== 0) rejectConflict();

    const operationDocument = {
      adoptionProof: operation.adoptionProof,
      baseRevision: args.expectedRevision,
      createdAt: Date.now(),
      genesisToken: operation.genesisToken,
      headToken: operation.headToken,
      keyVersion: args.expectedKeyVersion,
      memorySpaceId: space._id,
      operation: operation.operation,
      priorToken: operation.priorToken,
      sequence: operation.sequence,
      sourceDeviceId: authority.deviceId,
      terminalHeadProof: operation.terminalHeadProof,
      userId: authority.userId,
    } as const;
    await reserveQuotaForInsert(ctx, authority.userId, "memory", operationDocument);
    await ctx.db.insert("memoryOperations", operationDocument);
    return writeResult(space, operation, false);
  },
});

export const pull = query({
  args: {
    afterHeadToken: v.string(),
    afterSequence: v.number(),
    limit: v.number(),
    spaceId: v.string(),
    terminalHeadToken: v.string(),
    terminalSequence: v.number(),
  },
  handler: async (ctx, args) => {
    const authority = await requireDaemonDevice(ctx);
    requireSpaceId(args.spaceId);
    if (
      !isDigest(args.afterHeadToken)
      || !safeNonNegativeInteger(args.afterSequence)
      || args.limit !== memorySyncLimits.pullOperations
      || !isDigest(args.terminalHeadToken)
      || !safeNonNegativeInteger(args.terminalSequence)
      || args.afterSequence > args.terminalSequence
    ) rejectInvalid();
    const space = await loadOwnedSpace(ctx, authority.userId, args.spaceId);
    const current = await currentHead(ctx, space);
    if (args.terminalSequence > current.sequence) rejectConflict();
    await requireBoundary(ctx, space, args.terminalSequence, args.terminalHeadToken);
    await requireBoundary(ctx, space, args.afterSequence, args.afterHeadToken);
    if (args.afterSequence === args.terminalSequence) {
      if (args.afterHeadToken !== args.terminalHeadToken) rejectConflict();
      return {
        done: true,
        operations: [],
        spaceId: space.publicId,
        terminalHeadToken: args.terminalHeadToken,
        terminalSequence: args.terminalSequence,
      };
    }
    const operations = await ctx.db.query("memoryOperations")
      .withIndex("by_space_and_sequence", (builder) => builder
        .eq("memorySpaceId", space._id)
        .gt("sequence", args.afterSequence)
        .lte("sequence", args.terminalSequence))
      .take(memorySyncLimits.pullOperations);
    const operation = operations[0] as OperationShape | undefined;
    if (operation === undefined) rejectCorrupt();
    requireOperationIntegrity(operation, space);
    if (
      operation.sequence !== args.afterSequence + 1
      || operation.priorToken !== args.afterHeadToken
    ) rejectCorrupt();
    return {
      done: operation.sequence === args.terminalSequence,
      operations: [publicOperation(operation)],
      spaceId: space.publicId,
      terminalHeadToken: args.terminalHeadToken,
      terminalSequence: args.terminalSequence,
    };
  },
});
