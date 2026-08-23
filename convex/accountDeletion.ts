import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { GenericId as Id } from "convex/values";

import {
  isBase64Url,
  isOpaqueIdentifier,
  isSafePositiveInteger,
} from "../src/cloud/contracts";
import { sha256Hex } from "../src/cloud/crypto";
import type { HOSTED_TABLE_LIFECYCLE } from "./lifecyclePolicy";
import {
  adjustQuotaForPatch,
  finalizeUserQuotaAuthorityForDelete,
  releaseAccountUsageSnapshotQuotaForDelete,
  releaseCodexAccountQuotaForDelete,
  releaseCommandQuotaForDelete,
  releaseDeviceQuotaForDelete,
  releaseParentAttributedQuotaForDelete,
  releaseQuotaForDelete,
  releaseQuotaForStoredIdentity,
  releaseServiceQuotaForDelete,
  releaseSessionChunkQuotaForDelete,
  releaseSessionHeadQuotaForDelete,
  reserveQuotaForInsert,
  reserveServiceQuotaForInsert,
} from "./quota";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./server";

const deletionRejectedMessage = "Account deletion status is unavailable.";
const maximumDeletionBatch = 200;
const minimumJobIdCharacters = 24;
const minimumStatusCapabilityCharacters = 43;
const maximumStatusCapabilityCharacters = 96;
const statusCapabilityPurpose = "hra-control-plane-account-deletion-status-v1";

export const accountDeletionReceiptRetentionMs = 30 * 24 * 60 * 60 * 1_000;

const deletionCategoryOrder = [
  "commands_and_leases",
  "chunks_and_epochs",
  "session_heads",
  "usage_and_bindings",
  "codex_accounts",
  "device_custody",
  "devices",
  "receipts_and_events",
  "auth_tokens_and_verifiers",
  "auth_sessions",
  "auth_challenges",
  "auth_accounts",
  "user_and_subject",
  "complete",
] as const;

type DeletionCategory = typeof deletionCategoryOrder[number];

type JobStatus = Readonly<{
  category: DeletionCategory;
  createdAt: number;
  jobId: string;
  state: "pending" | "draining" | "complete";
  updatedAt: number;
}>;

type BeginResponse = JobStatus & Readonly<{
  replay: boolean;
  statusCapability?: string;
}>;

type DeleteResult = Readonly<{
  deleted: number;
  empty: boolean;
}>;

/**
 * This map is deliberately exhaustive against the generated hosted lifecycle.
 * Adding a table requires an explicit account-erasure strategy here as well as
 * in lifecyclePolicy.ts.
 */
export const ACCOUNT_DELETION_TABLE_STRATEGY = {
  users: "completion",
  authSessions: "auth_session_parent",
  authAccounts: "auth_account_parent",
  authRefreshTokens: "auth_session_child",
  authVerificationCodes: "auth_account_child",
  authVerifiers: "auth_session_child",
  authRateLimits: "derived_auth_identifier",
  authSubjects: "completion",
  authEmailAttemptEvents: "email_digest",
  authOtpChallenges: "user_index",
  authInvites: "issuer_or_bound_email_index",
  devices: "user_index",
  deviceSessions: "user_index",
  deviceBindChallenges: "user_index",
  deviceKeyEnvelopes: "user_index",
  recoveryEnvelopes: "user_index",
  devicePresence: "user_index",
  sessionHeads: "user_index",
  sessionChunks: "user_index_immutable_erasure",
  sessionStreamEpochs: "user_index_immutable_erasure",
  executionLeases: "user_index",
  sessionCommands: "user_index",
  codexAccounts: "user_index",
  deviceAccountBindings: "user_index",
  accountUsageSnapshots: "user_index",
  idempotencyReceipts: "user_index",
  securityEvents: "user_index",
  accountDeletionJobs: "completion",
  accountDeletionReceipts: "capability_receipt",
  deviceRevocationJobs: "user_index",
  storageUsageByUser: "user_index",
  storageResourceUsageByUser: "user_index",
  storageResourceUsageByAccount: "user_index",
  storageUsageService: "service_retained",
  maintenanceState: "service_retained",
} as const satisfies Readonly<Record<
  keyof typeof HOSTED_TABLE_LIFECYCLE,
  | "auth_account_child"
  | "auth_account_parent"
  | "auth_session_child"
  | "auth_session_parent"
  | "capability_receipt"
  | "completion"
  | "derived_auth_identifier"
  | "email_digest"
  | "issuer_or_bound_email_index"
  | "service_retained"
  | "user_index"
  | "user_index_immutable_erasure"
>>;

export const ACCOUNT_DELETION_SCHEMA_GAPS = Object.freeze([] as const);

function rejectDeletion(): never {
  throw new Error(deletionRejectedMessage);
}

function requireJobId(value: string): void {
  if (!isOpaqueIdentifier(value) || value.length < minimumJobIdCharacters) {
    rejectDeletion();
  }
}

function requireStatusCapability(value: string): void {
  if (!isBase64Url(
    value,
    minimumStatusCapabilityCharacters,
    maximumStatusCapabilityCharacters,
  )) rejectDeletion();
}

function requireDeletionLimit(value: number): number {
  if (!isSafePositiveInteger(value) || value > maximumDeletionBatch) {
    throw new Error("Invalid account deletion batch.");
  }
  return value;
}

async function digestStatusCapability(value: string): Promise<string> {
  return await sha256Hex(`${statusCapabilityPurpose}\u0000${value}`);
}

function equalDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function jobStatus(job: Readonly<{
  category: DeletionCategory;
  createdAt: number;
  publicId: string;
  state: "pending" | "draining" | "complete";
  updatedAt: number;
}>): JobStatus {
  return {
    category: job.category,
    createdAt: job.createdAt,
    jobId: job.publicId,
    state: job.state,
    updatedAt: job.updatedAt,
  };
}

function receiptStatus(receipt: Readonly<{
  completedAt: number;
  publicId: string;
}>): JobStatus {
  return {
    category: "complete",
    createdAt: receipt.completedAt,
    jobId: receipt.publicId,
    state: "complete",
    updatedAt: receipt.completedAt,
  };
}

async function matchingJob(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  jobId: string,
) {
  const matches = await ctx.db
    .query("accountDeletionJobs")
    .withIndex("by_public_id", (builder) => builder.eq("publicId", jobId))
    .take(2);
  if (matches.length > 1) rejectDeletion();
  return matches[0] ?? null;
}

async function matchingReceipt(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  jobId: string,
) {
  const matches = await ctx.db
    .query("accountDeletionReceipts")
    .withIndex("by_public_id", (builder) => builder.eq("publicId", jobId))
    .take(2);
  if (matches.length > 1) rejectDeletion();
  return matches[0] ?? null;
}

async function deleteCommandsAndLeases(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  const commands = await ctx.db.query("sessionCommands")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(limit);
  for (const command of commands) {
    await releaseCommandQuotaForDelete(ctx, userId, command);
    await ctx.db.delete(command._id);
  }
  let remaining = limit - commands.length;
  if (remaining === 0) return { deleted: limit, empty: false };
  const leases = await ctx.db.query("executionLeases")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const lease of leases) {
    await releaseQuotaForDelete(ctx, userId, "session", lease);
    await ctx.db.delete(lease._id);
  }
  remaining -= leases.length;
  return { deleted: limit - remaining, empty: commands.length === 0 && leases.length === 0 };
}

async function deleteChunksAndEpochs(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  // Account deletion is the sole lifecycle operation permitted to erase these
  // immutable encrypted history records.
  const chunks = await ctx.db.query("sessionChunks")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(limit);
  for (const chunk of chunks) {
    await releaseSessionChunkQuotaForDelete(ctx, userId, chunk);
    await ctx.db.delete(chunk._id);
  }
  let remaining = limit - chunks.length;
  if (remaining === 0) return { deleted: limit, empty: false };
  const epochs = await ctx.db.query("sessionStreamEpochs")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const epoch of epochs) {
    await releaseQuotaForDelete(ctx, userId, "chunk", epoch);
    await ctx.db.delete(epoch._id);
  }
  remaining -= epochs.length;
  return { deleted: limit - remaining, empty: chunks.length === 0 && epochs.length === 0 };
}

async function deleteSessionHeads(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  const records = await ctx.db.query("sessionHeads")
    .withIndex("by_user_and_updated_at", (builder) => builder.eq("userId", userId))
    .take(limit);
  for (const record of records) {
    await releaseSessionHeadQuotaForDelete(ctx, userId, record);
    await ctx.db.delete(record._id);
  }
  return { deleted: records.length, empty: records.length === 0 };
}

async function deleteUsageAndBindings(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  const snapshots = await ctx.db.query("accountUsageSnapshots")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(limit);
  for (const snapshot of snapshots) {
    await releaseAccountUsageSnapshotQuotaForDelete(
      ctx,
      userId,
      snapshot.accountId,
      snapshot,
    );
    await ctx.db.delete(snapshot._id);
  }
  let remaining = limit - snapshots.length;
  if (remaining === 0) return { deleted: limit, empty: false };
  const bindings = await ctx.db.query("deviceAccountBindings")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const binding of bindings) {
    await releaseQuotaForDelete(ctx, userId, "account", binding);
    await ctx.db.delete(binding._id);
  }
  remaining -= bindings.length;
  return {
    deleted: limit - remaining,
    empty: snapshots.length === 0 && bindings.length === 0,
  };
}

async function deleteCodexAccounts(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  const records = await ctx.db.query("codexAccounts")
    .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", userId))
    .take(limit);
  for (const record of records) {
    await releaseCodexAccountQuotaForDelete(ctx, userId, record);
    await ctx.db.delete(record._id);
  }
  return { deleted: records.length, empty: records.length === 0 };
}

async function deleteDeviceCustody(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  let remaining = limit;
  const sessions = await ctx.db.query("deviceSessions")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const session of sessions) {
    await releaseQuotaForDelete(ctx, userId, "custody", session);
    await ctx.db.delete(session._id);
  }
  remaining -= sessions.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const challenges = await ctx.db.query("deviceBindChallenges")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const challenge of challenges) {
    await releaseQuotaForDelete(ctx, userId, "custody", challenge);
    await ctx.db.delete(challenge._id);
  }
  remaining -= challenges.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const keys = await ctx.db.query("deviceKeyEnvelopes")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const key of keys) {
    await releaseQuotaForDelete(ctx, userId, "custody", key);
    await ctx.db.delete(key._id);
  }
  remaining -= keys.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const recovery = await ctx.db.query("recoveryEnvelopes")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const envelope of recovery) {
    await releaseQuotaForDelete(ctx, userId, "custody", envelope);
    await ctx.db.delete(envelope._id);
  }
  remaining -= recovery.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const presence = await ctx.db.query("devicePresence")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const record of presence) {
    await releaseQuotaForDelete(ctx, userId, "device", record);
    await ctx.db.delete(record._id);
  }
  remaining -= presence.length;
  return {
    deleted: limit - remaining,
    empty: sessions.length === 0
      && challenges.length === 0
      && keys.length === 0
      && recovery.length === 0
      && presence.length === 0,
  };
}

async function deleteDevices(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  const records = await ctx.db.query("devices")
    .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", userId))
    .take(limit);
  for (const record of records) {
    await releaseDeviceQuotaForDelete(ctx, userId, record);
    await ctx.db.delete(record._id);
  }
  return { deleted: records.length, empty: records.length === 0 };
}

async function deleteReceiptsAndEvents(
  ctx: MutationCtx,
  userId: Id<"users">,
  emailDigest: string,
  limit: number,
): Promise<DeleteResult> {
  let remaining = limit;
  const idempotency = await ctx.db.query("idempotencyReceipts")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const receipt of idempotency) {
    await releaseQuotaForDelete(ctx, userId, "receipt", receipt);
    await ctx.db.delete(receipt._id);
  }
  remaining -= idempotency.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const security = await ctx.db.query("securityEvents")
    .withIndex("by_user_and_created_at", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const event of security) {
    await releaseQuotaForDelete(ctx, userId, "security", event);
    await ctx.db.delete(event._id);
  }
  remaining -= security.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const revocations = await ctx.db.query("deviceRevocationJobs")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remaining);
  for (const job of revocations) {
    await releaseQuotaForDelete(ctx, userId, "job", job);
    await ctx.db.delete(job._id);
  }
  remaining -= revocations.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const attempts = await ctx.db.query("authEmailAttemptEvents")
    .withIndex("by_email_kind_and_created_at", (builder) =>
      builder.eq("emailDigest", emailDigest))
    .take(remaining);
  for (const attempt of attempts) {
    await releaseServiceQuotaForDelete(ctx, attempt);
    await ctx.db.delete(attempt._id);
  }
  remaining -= attempts.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const boundInvites = await ctx.db.query("authInvites")
    .withIndex("by_bound_email_digest", (builder) =>
      builder.eq("boundEmailDigest", emailDigest))
    .take(remaining);
  for (const invite of boundInvites) {
    await releaseServiceQuotaForDelete(ctx, invite);
    await ctx.db.delete(invite._id);
  }
  remaining -= boundInvites.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const invites = await ctx.db.query("authInvites")
    .withIndex("by_issuer", (builder) => builder.eq("issuedByUserId", userId))
    .take(remaining);
  for (const invite of invites) {
    await releaseServiceQuotaForDelete(ctx, invite);
    await ctx.db.delete(invite._id);
  }
  remaining -= invites.length;
  return {
    deleted: limit - remaining,
    empty: idempotency.length === 0
      && security.length === 0
      && revocations.length === 0
      && attempts.length === 0
      && boundInvites.length === 0
      && invites.length === 0,
  };
}

async function deleteAuthSessionTree(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  const session = await ctx.db.query("authSessions")
    .withIndex("userId", (builder) => builder.eq("userId", userId))
    .first();
  if (session === null) return { deleted: 0, empty: true };
  if (session.userId !== userId) rejectDeletion();

  const refreshTokens = await ctx.db.query("authRefreshTokens")
    .withIndex("sessionId", (builder) => builder.eq("sessionId", session._id))
    .take(limit);
  for (const token of refreshTokens) {
    await releaseParentAttributedQuotaForDelete(ctx, userId, "identity", token);
    await ctx.db.delete(token._id);
  }
  let remaining = limit - refreshTokens.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const verifiers = await ctx.db.query("authVerifiers")
    .withIndex("sessionId", (builder) => builder.eq("sessionId", session._id))
    .take(remaining);
  for (const verifier of verifiers) {
    await releaseParentAttributedQuotaForDelete(ctx, userId, "identity", verifier);
    await ctx.db.delete(verifier._id);
  }
  remaining -= verifiers.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  const refreshTokenStillExists = await ctx.db.query("authRefreshTokens")
    .withIndex("sessionId", (builder) => builder.eq("sessionId", session._id))
    .first();
  const verifierStillExists = await ctx.db.query("authVerifiers")
    .withIndex("sessionId", (builder) => builder.eq("sessionId", session._id))
    .first();
  if (refreshTokenStillExists !== null || verifierStillExists !== null) {
    return { deleted: limit - remaining, empty: false };
  }
  await releaseQuotaForDelete(ctx, userId, "identity", session);
  await ctx.db.delete(session._id);
  return { deleted: limit - remaining + 1, empty: false };
}

async function deleteAuthChallenges(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  const challenges = await ctx.db.query("authOtpChallenges")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(limit);
  for (const challenge of challenges) {
    await releaseQuotaForDelete(ctx, userId, "identity", challenge);
    await ctx.db.delete(challenge._id);
  }
  return { deleted: challenges.length, empty: challenges.length === 0 };
}

async function deleteRateLimitIdentifier(
  ctx: MutationCtx,
  identifier: string | undefined,
): Promise<number> {
  if (identifier === undefined) return 0;
  const record = await ctx.db.query("authRateLimits")
    .withIndex("identifier", (builder) => builder.eq("identifier", identifier))
    .unique();
  if (record === null) return 0;
  await releaseServiceQuotaForDelete(ctx, record);
  await ctx.db.delete(record._id);
  return 1;
}

async function deleteAuthAccountTree(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<DeleteResult> {
  let remaining = limit;
  const user = await ctx.db.get(userId);
  if (user === null) rejectDeletion();

  for (const identifier of [user.email, user.phone]) {
    if (remaining === 0) return { deleted: limit, empty: false };
    remaining -= await deleteRateLimitIdentifier(ctx, identifier);
  }

  const account = await ctx.db.query("authAccounts")
    .withIndex("userIdAndProvider", (builder) => builder.eq("userId", userId))
    .first();
  if (account === null) {
    return { deleted: limit - remaining, empty: remaining === limit };
  }
  if (account.userId !== userId) rejectDeletion();

  const verificationCodes = await ctx.db.query("authVerificationCodes")
    .withIndex("accountId", (builder) => builder.eq("accountId", account._id))
    .take(remaining);
  for (const code of verificationCodes) {
    await releaseParentAttributedQuotaForDelete(ctx, userId, "identity", code);
    await ctx.db.delete(code._id);
  }
  remaining -= verificationCodes.length;
  if (remaining === 0) return { deleted: limit, empty: false };

  remaining -= await deleteRateLimitIdentifier(ctx, account._id);
  if (remaining === 0) return { deleted: limit, empty: false };
  remaining -= await deleteRateLimitIdentifier(ctx, account.providerAccountId);
  if (remaining === 0) return { deleted: limit, empty: false };

  const verificationCodeStillExists = await ctx.db.query("authVerificationCodes")
    .withIndex("accountId", (builder) => builder.eq("accountId", account._id))
    .first();
  if (verificationCodeStillExists !== null) {
    return { deleted: limit - remaining, empty: false };
  }
  await releaseQuotaForDelete(ctx, userId, "identity", account);
  await ctx.db.delete(account._id);
  return { deleted: limit - remaining + 1, empty: false };
}

async function deleteCategory(
  ctx: MutationCtx,
  input: Readonly<{
    category: DeletionCategory;
    emailDigest: string;
    limit: number;
    userId: Id<"users">;
  }>,
): Promise<DeleteResult> {
  switch (input.category) {
    case "commands_and_leases":
      return await deleteCommandsAndLeases(ctx, input.userId, input.limit);
    case "chunks_and_epochs":
      return await deleteChunksAndEpochs(ctx, input.userId, input.limit);
    case "session_heads":
      return await deleteSessionHeads(ctx, input.userId, input.limit);
    case "usage_and_bindings":
      return await deleteUsageAndBindings(ctx, input.userId, input.limit);
    case "codex_accounts":
      return await deleteCodexAccounts(ctx, input.userId, input.limit);
    case "device_custody":
      return await deleteDeviceCustody(ctx, input.userId, input.limit);
    case "devices":
      return await deleteDevices(ctx, input.userId, input.limit);
    case "receipts_and_events":
      return await deleteReceiptsAndEvents(
        ctx,
        input.userId,
        input.emailDigest,
        input.limit,
      );
    case "auth_tokens_and_verifiers":
      return await deleteAuthSessionTree(ctx, input.userId, input.limit);
    case "auth_sessions":
      // Parent rows are deliberately consumed with their indexed children in
      // the previous category. This category remains explicit so schema and
      // status progression preserve the published lifecycle order.
      return { deleted: 0, empty: true };
    case "auth_challenges":
      return await deleteAuthChallenges(ctx, input.userId, input.limit);
    case "auth_accounts":
      return await deleteAuthAccountTree(ctx, input.userId, input.limit);
    case "user_and_subject":
    case "complete":
      return { deleted: 0, empty: true };
  }
}

function nextCategory(category: DeletionCategory): DeletionCategory {
  const index = deletionCategoryOrder.indexOf(category);
  if (index < 0 || index === deletionCategoryOrder.length - 1) return "complete";
  return deletionCategoryOrder[index + 1] ?? "complete";
}

async function finalizeDeletion(
  ctx: MutationCtx,
  job: Readonly<{
    _id: Id<"accountDeletionJobs">;
    publicId: string;
    statusCapabilityDigest: string;
    subjectId: Id<"authSubjects">;
    userId: Id<"users">;
  }>,
): Promise<number> {
  const [subject, user] = await Promise.all([
    ctx.db.get(job.subjectId),
    ctx.db.get(job.userId),
  ]);
  if (
    subject?.userId !== job.userId
    || subject.status !== "disabled"
    || user?._id !== job.userId
  ) rejectDeletion();

  const otherJobs = await ctx.db.query("accountDeletionJobs")
    .withIndex("by_user", (builder) => builder.eq("userId", job.userId))
    .take(2);
  if (otherJobs.length !== 1 || otherJobs[0]?._id !== job._id) rejectDeletion();

  const now = Date.now();
  const existingReceipt = await matchingReceipt(ctx, job.publicId);
  if (existingReceipt === null) {
    const receiptDocument = {
      completedAt: now,
      expiresAt: now + accountDeletionReceiptRetentionMs,
      publicId: job.publicId,
      statusCapabilityDigest: job.statusCapabilityDigest,
    };
    await reserveServiceQuotaForInsert(ctx, receiptDocument);
    await ctx.db.insert("accountDeletionReceipts", receiptDocument);
  } else if (!equalDigest(
    existingReceipt.statusCapabilityDigest,
    job.statusCapabilityDigest,
  )) {
    rejectDeletion();
  }

  // The completion receipt is durable before the authority and identity rows
  // are erased. Convex commits this sequence atomically.
  await releaseQuotaForDelete(ctx, job.userId, "job", job);
  await releaseQuotaForDelete(ctx, job.userId, "identity", subject);
  await releaseQuotaForStoredIdentity(ctx, job.userId, user);
  await finalizeUserQuotaAuthorityForDelete(ctx, job.userId);
  await ctx.db.delete(job._id);
  await ctx.db.delete(subject._id);
  await ctx.db.delete(user._id);
  return 3;
}

export const request = mutation({
  args: {
    jobId: v.string(),
    statusCapability: v.string(),
  },
  handler: async (ctx, args): Promise<BeginResponse> => {
    requireJobId(args.jobId);
    requireStatusCapability(args.statusCapability);
    const capabilityDigest = await digestStatusCapability(args.statusCapability);

    const [authSessionId, userId] = await Promise.all([
      getAuthSessionId(ctx),
      getAuthUserId(ctx),
    ]);
    if (authSessionId === null || userId === null) rejectDeletion();
    const [authSession, user] = await Promise.all([
      ctx.db.get(authSessionId),
      ctx.db.get(userId),
    ]);
    if (
      authSession?.userId !== userId
      || authSession.expirationTime <= Date.now()
      || user?._id !== userId
    ) rejectDeletion();

    const replay = await matchingJob(ctx, args.jobId);
    if (replay !== null) {
      if (
        replay.userId !== userId
        || !equalDigest(replay.statusCapabilityDigest, capabilityDigest)
      ) rejectDeletion();
      return { ...jobStatus(replay), replay: true };
    }

    const existingJobs = await ctx.db.query("accountDeletionJobs")
      .withIndex("by_user", (builder) => builder.eq("userId", userId))
      .take(2);
    if (existingJobs.length !== 0) rejectDeletion();
    const subjects = await ctx.db.query("authSubjects")
      .withIndex("by_user", (builder) => builder.eq("userId", userId))
      .take(2);
    const subject = subjects[0];
    if (
      subjects.length !== 1
      || subject?.status !== "active"
      || subject.userId !== userId
      || !isSafePositiveInteger(subject.authEpoch)
      || subject.authEpoch >= Number.MAX_SAFE_INTEGER
    ) rejectDeletion();

    const duplicateReceipt = await matchingReceipt(ctx, args.jobId);
    if (duplicateReceipt !== null) rejectDeletion();
    const duplicateJobId = await matchingJob(ctx, args.jobId);
    if (duplicateJobId !== null) rejectDeletion();

    const now = Date.now();
    const subjectPatch = {
      authEpoch: subject.authEpoch + 1,
      status: "disabled" as const,
      updatedAt: now,
    };
    const jobDocument = {
      category: "commands_and_leases",
      createdAt: now,
      publicId: args.jobId,
      state: "pending" as const,
      statusCapabilityDigest: capabilityDigest,
      subjectId: subject._id,
      updatedAt: now,
      userId,
    } as const;
    await adjustQuotaForPatch(ctx, userId, "identity", subject, subjectPatch);
    await reserveQuotaForInsert(ctx, userId, "job", jobDocument);
    await ctx.db.patch(subject._id, subjectPatch);
    await ctx.db.insert("accountDeletionJobs", jobDocument);
    return {
      category: "commands_and_leases",
      createdAt: now,
      jobId: args.jobId,
      replay: false,
      state: "pending",
      statusCapability: args.statusCapability,
      updatedAt: now,
    };
  },
});

export const status = query({
  args: {
    jobId: v.string(),
    statusCapability: v.string(),
  },
  handler: async (ctx, args): Promise<JobStatus> => {
    requireJobId(args.jobId);
    requireStatusCapability(args.statusCapability);
    const capabilityDigest = await digestStatusCapability(args.statusCapability);
    const job = await matchingJob(ctx, args.jobId);
    if (job !== null) {
      if (!equalDigest(job.statusCapabilityDigest, capabilityDigest)) rejectDeletion();
      return jobStatus(job);
    }
    const receipt = await matchingReceipt(ctx, args.jobId);
    if (
      receipt === null
      || receipt.expiresAt <= Date.now()
      || !equalDigest(receipt.statusCapabilityDigest, capabilityDigest)
    ) rejectDeletion();
    return receiptStatus(receipt);
  },
});

/**
 * Reserved cron root: accountDeletion:drain with { limit: 200 } once per minute.
 * One invocation advances or drains one durable category for one oldest job.
 */
export const drain = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const limit = requireDeletionLimit(args.limit);
    const pending = await ctx.db.query("accountDeletionJobs")
      .withIndex("by_state_and_updated_at", (builder) => builder.eq("state", "pending"))
      .first();
    const draining = await ctx.db.query("accountDeletionJobs")
      .withIndex("by_state_and_updated_at", (builder) => builder.eq("state", "draining"))
      .first();
    const job = pending === null
      ? draining
      : draining === null || pending.updatedAt <= draining.updatedAt
        ? pending
        : draining;
    if (job === null) return { kind: "idle" as const, processed: 0 };

    const subject = await ctx.db.get(job.subjectId);
    if (
      subject?.userId !== job.userId
      || subject.status !== "disabled"
    ) rejectDeletion();
    if (job.category === "user_and_subject" || job.category === "complete") {
      const processed = await finalizeDeletion(ctx, job);
      return {
        category: "complete" as const,
        jobId: job.publicId,
        kind: "complete" as const,
        processed,
        state: "complete" as const,
      };
    }

    const result = await deleteCategory(ctx, {
      category: job.category,
      emailDigest: subject.emailDigest,
      limit,
      userId: job.userId,
    });
    const now = Date.now();
    if (result.empty) {
      const category = nextCategory(job.category);
      const jobPatch = {
        category,
        state: "draining" as const,
        updatedAt: now,
      };
      await adjustQuotaForPatch(ctx, job.userId, "job", job, jobPatch);
      await ctx.db.patch(job._id, jobPatch);
      return {
        category,
        jobId: job.publicId,
        kind: "advanced" as const,
        processed: 0,
        state: "draining" as const,
      };
    }
    const jobPatch = { state: "draining" as const, updatedAt: now };
    await adjustQuotaForPatch(ctx, job.userId, "job", job, jobPatch);
    await ctx.db.patch(job._id, jobPatch);
    return {
      category: job.category,
      jobId: job.publicId,
      kind: "drained" as const,
      processed: result.deleted,
      state: "draining" as const,
    };
  },
});
