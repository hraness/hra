import { v } from "convex/values";
import type { GenericId as Id, Value } from "convex/values";

import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import { isCanonicalAuthEmail } from "../src/cloud/authCredentials";
import {
  isDigest,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isSafePositiveInteger,
  isUuidV7,
} from "../src/cloud/contracts";
import { sha256Hex } from "../src/cloud/crypto";
import {
  remoteInteractionActionOrder,
  type RemoteInteractionAction,
} from "../src/domain/remote-interaction-contract";
import { createCloudUuidV7 } from "../src/domain/uuid-v7";
import {
  buildHraAttentionEmailBody,
  isHraAttentionEmailDocumentedRefusal,
  parseHraAttentionEmailBody,
  type HraAttentionEmailBody,
} from "./attentionEmail";
import {
  completeAttentionNotificationSafetyFaultQuarantine,
  deleteAttentionNotificationSafetyFaultsForAccount,
  faultCapacityDeliveryIdForAnchor,
  latchAttentionNotificationSafetyFault,
  maximumAttentionNotificationDeliveryAttempts,
  maximumAttentionNotificationNonterminalRows,
  readAttentionNotificationControl,
  readAttentionNotificationSafetyFaultById,
  readOldestLatchedAttentionNotificationSafetyFault,
  releaseUnusedAttentionNotificationFaultCapacity,
  requireAttentionNotificationFaultCapacity,
  reserveAttentionNotificationFaultCapacity,
  type AttentionNotificationSafetyFault,
} from "./attentionNotificationControl";
import { digestAuthEmail } from "./authEmail";
import { deviceClassOf, requireDaemonDevice } from "./authority";
import { ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS } from "./lifecyclePolicy";
import {
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  CATEGORY_QUOTAS,
  logicalDocumentBytes,
  releaseCommandQuotaForDelete,
  reserveNonterminalCommandQuotaForInsert,
} from "./quota";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "./server";
import {
  attentionNotificationInteractionKind,
  attentionNotificationRemoteAction,
  authorityTuple,
} from "./validators";

export const attentionNotificationCandidateLimit = 64;
export const attentionNotificationGroupLimit = 8;
export const attentionNotificationConsentLeaseMs = 2 * 60 * 1_000;
export const attentionNotificationCoalescingMs = 60 * 1_000;
export const attentionNotificationRetryRecoveryMs = 2 * 60 * 1_000;
export const attentionNotificationRetryTwoDelayMs = 60 * 1_000;
export const attentionNotificationRetryThreeDelayMs = 5 * 60 * 1_000;
export const attentionNotificationDeliveryHorizonMs = 23 * 60 * 60 * 1_000;
export const attentionNotificationQuarantineRowLimit = 64;
export const attentionNotificationQuotaReservations = Object.freeze({
  pending: "0".repeat(16 * 1_024),
  started: "0".repeat(4 * 1_024),
  suppressed: "0".repeat(3 * 1_024),
});

const maximumNonterminalRows = maximumAttentionNotificationNonterminalRows;
const maximumDeliveryAttempts = maximumAttentionNotificationDeliveryAttempts;
const sourceDeviceHourlyGroupLimit = 3;
const userHourlyGroupLimit = 6;
const userDailyGroupLimit = 24;
const hourMs = 60 * 60 * 1_000;
const dayMs = 24 * hourMs;

type SuppressionReason =
  | "source_reconciled"
  | "local_policy_changed"
  | "global_disabled"
  | "interaction_resolved"
  | "deadline_expired"
  | "account_deletion"
  | "device_revoked"
  | "consent_expired"
  | "execution_authority_changed"
  | "recipient_unavailable"
  | "service_fault";

type AttentionCandidate = Readonly<{
  executionAuthority: Readonly<{
    bootGeneration: number;
    bootId: string;
    fence: number;
  }>;
  interactionDeadline: number;
  interactionId: string;
  interactionKind:
    | "command_approval"
    | "file_change_approval"
    | "permission_approval"
    | "user_input"
    | "mcp_elicitation";
  interactionRevision: number;
  remoteActions: readonly RemoteInteractionAction[];
  sessionPublicId: string;
}>;

const candidateValidator = v.object({
  executionAuthority: authorityTuple,
  interactionDeadline: v.number(),
  interactionId: v.string(),
  interactionKind: attentionNotificationInteractionKind,
  interactionRevision: v.number(),
  remoteActions: v.array(attentionNotificationRemoteAction),
  sessionPublicId: v.string(),
});

function invalidRequest(): never {
  throw new Error("ATTENTION_NOTIFICATION_RECONCILIATION_REJECTED");
}

function corrupt(): never {
  throw new Error("ATTENTION_NOTIFICATION_AUTHORITY_CORRUPT");
}

function validTimestamp(value: unknown): value is number {
  return isFiniteTimestamp(value) && Number.isSafeInteger(value);
}

function sameAuthority(
  left: Readonly<{ bootGeneration: number; bootId: string; fence: number }>,
  right: Readonly<{ bootGeneration: number; bootId: string; fence: number }>,
): boolean {
  return left.bootGeneration === right.bootGeneration
    && left.bootId === right.bootId
    && left.fence === right.fence;
}

function validAuthority(value: AttentionCandidate["executionAuthority"]): boolean {
  return isSafePositiveInteger(value.bootGeneration)
    && isOpaqueIdentifier(value.bootId)
    && isSafePositiveInteger(value.fence);
}

function actionsAreCanonical(actions: readonly RemoteInteractionAction[]): boolean {
  const canonical = remoteInteractionActionOrder.filter((action) => actions.includes(action));
  return canonical.length === actions.length
    && canonical.every((action, index) => action === actions[index]);
}

function requireNonGrowingPatch(
  row: OutboxRow,
  patch: Readonly<Record<string, Value | undefined>>,
): void {
  if (logicalDocumentBytes({ ...row, ...patch }) > logicalDocumentBytes(row)) corrupt();
}

async function registryForDevice(ctx: MutationCtx, deviceId: Id<"devices">) {
  const rows = await ctx.db.query("deviceRegistries")
    .withIndex("by_device", (builder) => builder.eq("deviceId", deviceId))
    .take(2);
  if (rows.length > 1) corrupt();
  return rows[0] ?? null;
}

async function leaseForSession(ctx: MutationCtx, sessionId: Id<"sessionHeads">) {
  const rows = await ctx.db.query("executionLeases")
    .withIndex("by_session", (builder) => builder.eq("sessionId", sessionId))
    .take(2);
  if (rows.length > 1) corrupt();
  return rows[0] ?? null;
}

async function rowForInteraction(
  ctx: MutationCtx,
  userId: Id<"users">,
  interactionId: string,
) {
  const rows = await ctx.db.query("attentionNotificationOutbox")
    .withIndex("by_user_and_interaction", (builder) => builder
      .eq("userId", userId)
      .eq("interactionId", interactionId))
    .take(2);
  if (rows.length > 1) corrupt();
  return rows[0] ?? null;
}

type OutboxRow = NonNullable<Awaited<ReturnType<typeof rowForInteraction>>>;

function interactionMatches(row: OutboxRow, candidate: AttentionCandidate): boolean {
  return row.interactionRevision === candidate.interactionRevision
    && row.interactionKind === candidate.interactionKind
    && row.interactionDeadline === candidate.interactionDeadline
    && row.sessionPublicId === candidate.sessionPublicId
    && sameAuthority(row.executionAuthority, candidate.executionAuthority)
    && actionsAreCanonical(row.remoteActions)
    && row.remoteActions.length === candidate.remoteActions.length
    && row.remoteActions.every((action, index) => action === candidate.remoteActions[index]);
}

async function cancelPending(
  ctx: MutationCtx,
  row: OutboxRow,
  reason: SuppressionReason,
  now: number,
): Promise<void> {
  if (row.state !== "pending" || !row.nonterminal || row.delivery !== undefined) corrupt();
  const patch = {
    claimCapacityReservation: undefined,
    nonterminal: false,
    retrySuppressedAt: now,
    retrySuppressionReason: reason,
    state: "cancelled" as const,
    terminalCleanupAfter: now + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
    updatedAt: now,
  };
  requireNonGrowingPatch(row, patch);
  await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
  await ctx.db.patch(row._id, patch);
}

async function expirePending(
  ctx: MutationCtx,
  row: OutboxRow,
  now: number,
): Promise<void> {
  if (row.state !== "pending" || !row.nonterminal || row.delivery !== undefined) corrupt();
  const patch = {
    claimCapacityReservation: undefined,
    nonterminal: false,
    retrySuppressedAt: now,
    retrySuppressionReason: "deadline_expired" as const,
    state: "expired" as const,
    terminalCleanupAfter: now + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
    updatedAt: now,
  };
  requireNonGrowingPatch(row, patch);
  await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
  await ctx.db.patch(row._id, patch);
}

async function suppressStarted(
  ctx: MutationCtx,
  row: OutboxRow,
  reason: SuppressionReason,
  now: number,
): Promise<void> {
  if (row.state !== "effect_started" || !row.nonterminal || row.delivery === undefined) corrupt();
  if (row.retrySuppressedAt !== undefined) return;
  const patch = {
    claimCapacityReservation: attentionNotificationQuotaReservations.suppressed,
    retrySuppressedAt: now,
    retrySuppressionReason: reason,
    updatedAt: now,
  };
  requireNonGrowingPatch(row, patch);
  await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
  await ctx.db.patch(row._id, patch);
}

type ResolvedCandidate = Readonly<{
  candidate: AttentionCandidate;
  existing: OutboxRow | null;
  sessionId: Id<"sessionHeads">;
}>;

async function resolveCompleteCandidate(
  ctx: MutationCtx,
  input: Readonly<{
    candidate: AttentionCandidate;
    deviceId: Id<"devices">;
    now: number;
    userId: Id<"users">;
  }>,
): Promise<ResolvedCandidate> {
  const { candidate } = input;
  if (
    !isOpaqueIdentifier(candidate.interactionId)
    || !isOpaqueIdentifier(candidate.sessionPublicId)
    || !isSafePositiveInteger(candidate.interactionRevision)
    || !validTimestamp(candidate.interactionDeadline)
    || candidate.interactionDeadline <= input.now
    || !validAuthority(candidate.executionAuthority)
    || !actionsAreCanonical(candidate.remoteActions)
  ) invalidRequest();
  const sessions = await ctx.db.query("sessionHeads")
    .withIndex("by_user_and_public_id", (builder) => builder
      .eq("userId", input.userId)
      .eq("publicId", candidate.sessionPublicId))
    .take(2);
  const session = sessions[0];
  if (
    sessions.length !== 1
    || session === undefined
    || session.executionDeviceId !== input.deviceId
    || session.state === "orphaned"
    || session.state === "terminal"
  ) invalidRequest();
  const lease = await leaseForSession(ctx, session._id);
  if (
    lease?.userId !== input.userId
    || lease.deviceId !== input.deviceId
    || lease.leaseUntil <= input.now
    || !sameAuthority(lease, candidate.executionAuthority)
  ) invalidRequest();
  const existing = await rowForInteraction(ctx, input.userId, candidate.interactionId);
  if (
    existing !== null
    && (
      existing.sourceDeviceId !== input.deviceId
      || existing.sessionId !== session._id
      || existing.sessionPublicId !== candidate.sessionPublicId
    )
  ) invalidRequest();
  return { candidate, existing, sessionId: session._id };
}

async function sourceNonterminalRows(ctx: MutationCtx, deviceId: Id<"devices">) {
  const rows = await ctx.db.query("attentionNotificationOutbox")
    .withIndex("by_source_device_nonterminal_and_revocation", (builder) => builder
      .eq("sourceDeviceId", deviceId)
      .eq("nonterminal", true))
    .take(maximumNonterminalRows + 1);
  if (rows.length > maximumNonterminalRows) corrupt();
  return rows;
}

export const reconcile = mutation({
  args: {
    allowedWindowEnd: v.optional(v.number()),
    candidates: v.optional(v.array(candidateValidator)),
    expectedGlobalNotificationGeneration: v.optional(v.number()),
    localNotificationPolicyRevision: v.number(),
    mode: v.union(v.literal("complete"), v.literal("invalidate")),
    reconciliationSequence: v.number(),
  },
  handler: async (ctx, args) => {
    const authority = await requireDaemonDevice(ctx);
    const now = Date.now();
    if (
      !isSafePositiveInteger(args.localNotificationPolicyRevision)
      || !isSafePositiveInteger(args.reconciliationSequence)
    ) invalidRequest();
    const previous = authority.device.attentionNotificationAuthority;
    if (
      previous !== undefined
      && args.reconciliationSequence <= previous.reconciliationSequence
    ) invalidRequest();
    const control = await readAttentionNotificationControl(ctx);
    const latchedFault = await readOldestLatchedAttentionNotificationSafetyFault(ctx);
    const globalGeneration = control.attentionNotificationGeneration ?? 0;

    if (args.mode === "invalidate") {
      if (
        args.allowedWindowEnd !== undefined
        || args.candidates !== undefined
        || args.expectedGlobalNotificationGeneration !== undefined
        || (previous !== undefined
          && args.localNotificationPolicyRevision < previous.localNotificationPolicyRevision)
      ) invalidRequest();
      const rows = await sourceNonterminalRows(ctx, authority.deviceId);
      for (const row of rows) {
        if (row.userId !== authority.userId) corrupt();
        if (row.state === "pending") {
          await cancelPending(ctx, row, "local_policy_changed", now);
        } else if (row.state === "effect_started") {
          await suppressStarted(ctx, row, "local_policy_changed", now);
        } else {
          corrupt();
        }
      }
      const attentionNotificationAuthority = {
        consentLeaseUntil: now,
        globalNotificationGeneration: globalGeneration,
        localNotificationPolicyRevision: args.localNotificationPolicyRevision,
        reconciliationSequence: args.reconciliationSequence,
      } as const;
      const devicePatch = { attentionNotificationAuthority, updatedAt: now };
      await adjustQuotaForPatch(ctx, authority.userId, "device", authority.device, devicePatch);
      await ctx.db.patch(authority.deviceId, devicePatch);
      return {
        acknowledgedAt: now,
        consentLeaseUntil: now,
        globalNotificationGeneration: globalGeneration,
        localNotificationPolicyRevision: args.localNotificationPolicyRevision,
        reconciliationSequence: args.reconciliationSequence,
        state: "invalidated" as const,
      };
    }

    if (
      args.allowedWindowEnd === undefined
      || args.candidates === undefined
      || args.expectedGlobalNotificationGeneration === undefined
      || args.candidates.length > attentionNotificationCandidateLimit
      || !validTimestamp(args.allowedWindowEnd)
      || args.allowedWindowEnd <= now
      || !isSafePositiveInteger(args.expectedGlobalNotificationGeneration)
      || control.attentionNotifications !== "enabled"
      || latchedFault !== null
      || globalGeneration !== args.expectedGlobalNotificationGeneration
    ) invalidRequest();
    const registry = await registryForDevice(ctx, authority.deviceId);
    if (
      registry?.userId !== authority.userId
      || registry.notificationPolicyRevision !== args.localNotificationPolicyRevision
    ) invalidRequest();
    const ids = new Set<string>();
    const resolved: ResolvedCandidate[] = [];
    for (const candidate of args.candidates) {
      if (ids.has(candidate.interactionId)) invalidRequest();
      ids.add(candidate.interactionId);
      resolved.push(await resolveCompleteCandidate(ctx, {
        candidate,
        deviceId: authority.deviceId,
        now,
        userId: authority.userId,
      }));
    }
    const currentRows = await sourceNonterminalRows(ctx, authority.deviceId);
    const consentLeaseUntil = Math.min(
      now + attentionNotificationConsentLeaseMs,
      args.allowedWindowEnd,
    );
    const included = new Set<string>();
    for (const entry of resolved) {
      const { candidate, existing } = entry;
      const claimDeadline = Math.min(
        candidate.interactionDeadline,
        args.allowedWindowEnd,
        consentLeaseUntil,
      );
      if (existing === null) {
        const document = {
          allowedWindowEnd: args.allowedWindowEnd,
          claimCapacityReservation: attentionNotificationQuotaReservations.pending,
          claimDeadline,
          coalesceAfter: now + attentionNotificationCoalescingMs,
          consentLeaseUntil,
          createdAt: now,
          executionAuthority: candidate.executionAuthority,
          globalNotificationGeneration: globalGeneration,
          interactionDeadline: candidate.interactionDeadline,
          interactionId: candidate.interactionId,
          interactionKind: candidate.interactionKind,
          interactionRevision: candidate.interactionRevision,
          localNotificationPolicyRevision: args.localNotificationPolicyRevision,
          nonterminal: true,
          reconciliationSequence: args.reconciliationSequence,
          remoteActions: [...candidate.remoteActions],
          sessionId: entry.sessionId,
          sessionPublicId: candidate.sessionPublicId,
          sourceDeviceId: authority.deviceId,
          state: "pending" as const,
          updatedAt: now,
          userId: authority.userId,
        };
        await reserveNonterminalCommandQuotaForInsert(ctx, authority.userId, document);
        const id = await ctx.db.insert("attentionNotificationOutbox", document);
        included.add(String(id));
        continue;
      }
      included.add(String(existing._id));
      if (!existing.nonterminal) continue;
      if (existing.state === "pending") {
        if (
          existing.delivery !== undefined
          || existing.claimCapacityReservation
            !== attentionNotificationQuotaReservations.pending
        ) corrupt();
        if (existing.globalNotificationGeneration !== globalGeneration) {
          await cancelPending(ctx, existing, "global_disabled", now);
          continue;
        }
        if (
          existing.localNotificationPolicyRevision
          !== args.localNotificationPolicyRevision
        ) {
          await cancelPending(ctx, existing, "local_policy_changed", now);
          continue;
        }
        const revisionChanged = existing.interactionRevision !== candidate.interactionRevision;
        const patch = {
          allowedWindowEnd: args.allowedWindowEnd,
          claimDeadline,
          ...(revisionChanged
            ? { coalesceAfter: now + attentionNotificationCoalescingMs }
            : {}),
          consentLeaseUntil,
          executionAuthority: candidate.executionAuthority,
          interactionDeadline: candidate.interactionDeadline,
          interactionKind: candidate.interactionKind,
          interactionRevision: candidate.interactionRevision,
          reconciliationSequence: args.reconciliationSequence,
          remoteActions: [...candidate.remoteActions],
          retrySuppressedAt: undefined,
          retrySuppressionReason: undefined,
          updatedAt: now,
        };
        await adjustCommandQuotaForPatch(ctx, existing.userId, existing, patch);
        await ctx.db.patch(existing._id, patch);
      } else if (existing.state === "effect_started") {
        if (existing.globalNotificationGeneration !== globalGeneration) {
          await suppressStarted(ctx, existing, "global_disabled", now);
        } else if (
          existing.localNotificationPolicyRevision
          !== args.localNotificationPolicyRevision
        ) {
          await suppressStarted(ctx, existing, "local_policy_changed", now);
        } else if (!interactionMatches(existing, candidate)) {
          await suppressStarted(ctx, existing, "interaction_resolved", now);
        } else if (existing.retrySuppressedAt === undefined) {
          const patch = {
            allowedWindowEnd: args.allowedWindowEnd,
            consentLeaseUntil,
            reconciliationSequence: args.reconciliationSequence,
            updatedAt: now,
          };
          await adjustCommandQuotaForPatch(ctx, existing.userId, existing, patch);
          await ctx.db.patch(existing._id, patch);
        }
      } else {
        corrupt();
      }
    }
    for (const row of currentRows) {
      if (included.has(String(row._id))) continue;
      if (row.userId !== authority.userId) corrupt();
      if (row.state === "pending") {
        await cancelPending(ctx, row, "source_reconciled", now);
      } else if (row.state === "effect_started") {
        await suppressStarted(ctx, row, "source_reconciled", now);
      } else {
        corrupt();
      }
    }
    const attentionNotificationAuthority = {
      consentLeaseUntil,
      globalNotificationGeneration: globalGeneration,
      localNotificationPolicyRevision: args.localNotificationPolicyRevision,
      reconciliationSequence: args.reconciliationSequence,
    } as const;
    const devicePatch = { attentionNotificationAuthority, updatedAt: now };
    await adjustQuotaForPatch(ctx, authority.userId, "device", authority.device, devicePatch);
    await ctx.db.patch(authority.deviceId, devicePatch);
    return {
      acknowledgedAt: now,
      candidateCount: resolved.length,
      consentLeaseUntil,
      globalNotificationGeneration: globalGeneration,
      localNotificationPolicyRevision: args.localNotificationPolicyRevision,
      reconciliationSequence: args.reconciliationSequence,
      state: "complete" as const,
    };
  },
});

/**
 * Bounded daemon-only status observation used before reconciliation. This is
 * intentionally a mutation so its server-clock freshness cannot be satisfied
 * from a query cache. The client must observe the exact global generation
 * rather than treating enablement as a boolean, and an expired retained device
 * authority is still useful when it must report the conservative end of an
 * offline revocation interval.
 */
export const authorityStatus = mutation({
  args: {},
  handler: async (ctx) => {
    const authority = await requireDaemonDevice(ctx);
    const control = await readAttentionNotificationControl(ctx);
    const latchedFault = await readOldestLatchedAttentionNotificationSafetyFault(ctx);
    const deviceAuthority = authority.device.attentionNotificationAuthority;
    return {
      deviceAuthority: deviceAuthority === undefined ? null : deviceAuthority,
      enabled: control.attentionNotifications === "enabled" && latchedFault === null,
      globalNotificationGeneration: control.attentionNotificationGeneration ?? 0,
      observedAt: Date.now(),
      safetyFaultState: latchedFault === null ? "none" as const : "latched" as const,
    };
  },
});

type Recipient = Readonly<{
  digest: string;
  email: CanonicalAuthEmail;
}>;

async function currentRecipient(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<Recipient | null> {
  const maximumSubjects = CATEGORY_QUOTAS.identity.records;
  const [user, subjects] = await Promise.all([
    ctx.db.get(userId),
    ctx.db.query("authSubjects")
      .withIndex("by_user", (builder) => builder.eq("userId", userId))
      .take(maximumSubjects + 1),
  ]);
  if (subjects.length > maximumSubjects) return null;
  const activeSubjects = subjects.filter((candidate) => candidate.status === "active");
  const subject = activeSubjects[0];
  if (
    user === null
    || !isCanonicalAuthEmail(user.email)
    || !validTimestamp(user.emailVerificationTime)
    || activeSubjects.length !== 1
    || subject?.userId !== userId
    || subject.verifiedAt !== user.emailVerificationTime
    || !isDigest(subject.emailDigest)
  ) return null;
  const digest = await digestAuthEmail(user.email);
  return digest === subject.emailDigest ? { digest, email: user.email } : null;
}

async function rowAuthorityFailure(
  ctx: MutationCtx,
  row: OutboxRow,
  globalGeneration: number,
  now: number,
): Promise<SuppressionReason | null> {
  if (row.globalNotificationGeneration !== globalGeneration) return "global_disabled";
  if (now >= row.interactionDeadline || now >= row.allowedWindowEnd) {
    return "deadline_expired";
  }
  if (now >= row.consentLeaseUntil) return "consent_expired";
  const device = await ctx.db.get(row.sourceDeviceId);
  if (
    device?.userId !== row.userId
    || device.status !== "active"
    || device.revokedAt !== undefined
    || deviceClassOf(device) !== "daemon"
  ) return "device_revoked";
  const deviceAuthority = device.attentionNotificationAuthority;
  if (
    deviceAuthority === undefined
    || deviceAuthority.consentLeaseUntil <= now
    || deviceAuthority.globalNotificationGeneration !== row.globalNotificationGeneration
    || deviceAuthority.localNotificationPolicyRevision !== row.localNotificationPolicyRevision
    || deviceAuthority.reconciliationSequence !== row.reconciliationSequence
  ) return deviceAuthority !== undefined
      && deviceAuthority.localNotificationPolicyRevision !== row.localNotificationPolicyRevision
    ? "local_policy_changed"
    : "consent_expired";
  const registry = await registryForDevice(ctx, row.sourceDeviceId);
  if (
    registry?.userId !== row.userId
    || registry.notificationPolicyRevision !== row.localNotificationPolicyRevision
  ) return "local_policy_changed";
  const session = await ctx.db.get(row.sessionId);
  if (
    session?.userId !== row.userId
    || session.publicId !== row.sessionPublicId
    || session.executionDeviceId !== row.sourceDeviceId
    || session.state === "orphaned"
    || session.state === "terminal"
  ) return "execution_authority_changed";
  const lease = await leaseForSession(ctx, row.sessionId);
  if (
    lease?.userId !== row.userId
    || lease.deviceId !== row.sourceDeviceId
    || lease.leaseUntil <= now
    || !sameAuthority(lease, row.executionAuthority)
  ) return "execution_authority_changed";
  return null;
}

type ClaimedEffect = Readonly<{
  body: HraAttentionEmailBody;
  deliveryId: string;
  generation: number;
  globalNotificationGeneration: number;
  idempotencyKey: string;
  kind: "effect";
  recipient: CanonicalAuthEmail;
}>;

type ClosedClaim = Readonly<{
  kind: "closed";
  quarantineFaultId?: string;
}>;

type ClaimResult = ClaimedEffect | ClosedClaim | null;

function sortedRows(rows: readonly OutboxRow[]): OutboxRow[] {
  return [...rows].sort((left, right) => String(left._id).localeCompare(String(right._id)));
}

async function bodyDigest(body: HraAttentionEmailBody): Promise<string> {
  return await sha256Hex(`hra-attention-body:v1\u0000${body.text}`);
}

async function deliveryKey(
  deliveryId: string,
  recipientDigest: string,
  digest: string,
): Promise<string> {
  return await sha256Hex(
    `hra-attention-resend:v1\u0000${deliveryId}\u0000${recipientDigest}\u0000${digest}`,
  );
}

async function deliveryRows(ctx: MutationCtx, deliveryId: string): Promise<OutboxRow[]> {
  const rows = await ctx.db.query("attentionNotificationOutbox")
    .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", deliveryId))
    .take(attentionNotificationGroupLimit + 1);
  return sortedRows(rows);
}

async function accountDeletionInProgress(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const jobs = await ctx.db.query("accountDeletionJobs")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(2);
  if (jobs.length > 1) corrupt();
  return jobs[0]?.state === "pending" || jobs[0]?.state === "draining";
}

type GroupHistory = Readonly<{
  earliestReleaseAt: number | null;
  groups: number;
  overflow: boolean;
}>;

function summarizeClaimHistory(
  rows: readonly OutboxRow[],
  maximumRows: number,
  cutoff: number,
  windowMs: number,
): GroupHistory {
  if (rows.length > maximumRows) {
    const earliestClaimedAt = rows.reduce((earliest, row) => {
      const claimedAt = row.delivery?.claimedAt;
      if (claimedAt === undefined || claimedAt < cutoff) corrupt();
      return Math.min(earliest, claimedAt);
    }, Number.POSITIVE_INFINITY);
    return {
      earliestReleaseAt: Math.max(
        cutoff + windowMs + 1,
        earliestClaimedAt + windowMs + 1,
      ),
      groups: Number.MAX_SAFE_INTEGER,
      overflow: true,
    };
  }
  const claims = new Map<string, number>();
  for (const row of rows) {
    const delivery = row.delivery;
    if (delivery === undefined || delivery.claimedAt < cutoff) corrupt();
    const previous = claims.get(delivery.id);
    claims.set(delivery.id, previous === undefined
      ? delivery.claimedAt
      : Math.min(previous, delivery.claimedAt));
  }
  const earliest = [...claims.values()].sort((left, right) => left - right)[0];
  return {
    earliestReleaseAt: earliest === undefined ? null : earliest + windowMs + 1,
    groups: claims.size,
    overflow: false,
  };
}

async function userClaimHistory(
  ctx: MutationCtx,
  userId: Id<"users">,
  cutoff: number,
  maximumRows: number,
  windowMs: number,
): Promise<GroupHistory> {
  const rows = await ctx.db.query("attentionNotificationOutbox")
    .withIndex("by_user_and_claimed_at", (builder) => builder
      .eq("userId", userId)
      .gte("delivery.claimedAt", cutoff))
    .take(maximumRows + 1);
  return summarizeClaimHistory(rows, maximumRows, cutoff, windowMs);
}

async function deviceClaimHistory(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  cutoff: number,
): Promise<GroupHistory> {
  const maximumRows = sourceDeviceHourlyGroupLimit * attentionNotificationGroupLimit;
  const rows = await ctx.db.query("attentionNotificationOutbox")
    .withIndex("by_source_device_and_claimed_at", (builder) => builder
      .eq("sourceDeviceId", deviceId)
      .gte("delivery.claimedAt", cutoff))
    .take(maximumRows + 1);
  return summarizeClaimHistory(rows, maximumRows, cutoff, hourMs);
}

async function capDeferral(
  ctx: MutationCtx,
  rows: readonly OutboxRow[],
  now: number,
): Promise<number | null> {
  const userId = rows[0]?.userId ?? corrupt();
  const hourly = await userClaimHistory(
    ctx,
    userId,
    now - hourMs,
    userHourlyGroupLimit * attentionNotificationGroupLimit,
    hourMs,
  );
  const daily = await userClaimHistory(
    ctx,
    userId,
    now - dayMs,
    userDailyGroupLimit * attentionNotificationGroupLimit,
    dayMs,
  );
  const releases: number[] = [];
  if (hourly.groups >= userHourlyGroupLimit && hourly.earliestReleaseAt !== null) {
    releases.push(hourly.earliestReleaseAt);
  }
  if (daily.groups >= userDailyGroupLimit && daily.earliestReleaseAt !== null) {
    releases.push(daily.earliestReleaseAt);
  }
  const devices = new Set(rows.map((row) => row.sourceDeviceId));
  for (const deviceId of devices) {
    const history = await deviceClaimHistory(ctx, deviceId, now - hourMs);
    if (
      history.groups >= sourceDeviceHourlyGroupLimit
      && history.earliestReleaseAt !== null
    ) releases.push(history.earliestReleaseAt);
  }
  if (releases.length === 0) return null;
  const releaseAt = Math.max(...releases);
  if (!validTimestamp(releaseAt) || releaseAt <= now) corrupt();
  return releaseAt;
}

async function deferPendingGroup(
  ctx: MutationCtx,
  rows: readonly OutboxRow[],
  until: number,
  now: number,
): Promise<void> {
  for (const row of rows) {
    if (until >= row.claimDeadline) {
      await expirePending(ctx, row, now);
      continue;
    }
    const patch = { coalesceAfter: Math.max(row.coalesceAfter, until), updatedAt: now };
    await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
    await ctx.db.patch(row._id, patch);
  }
}

async function startPendingGroup(
  ctx: MutationCtx,
  rows: readonly OutboxRow[],
  recipient: Recipient,
  globalGeneration: number,
  now: number,
): Promise<ClaimResult> {
  const ordered = sortedRows(rows);
  if (ordered.some((row) =>
    row.claimCapacityReservation !== attentionNotificationQuotaReservations.pending)) {
    corrupt();
  }
  const body = buildHraAttentionEmailBody(ordered.map((row) => ({
    interactionKind: row.interactionKind,
    sessionPublicId: row.sessionPublicId,
  })));
  const digest = await bodyDigest(body);
  let deliveryId = createCloudUuidV7(now);
  if ((await deliveryRows(ctx, deliveryId)).length !== 0) {
    deliveryId = createCloudUuidV7(now);
    if ((await deliveryRows(ctx, deliveryId)).length !== 0) corrupt();
  }
  const idempotencyKey = await deliveryKey(deliveryId, recipient.digest, digest);
  const leader = ordered[0] ?? corrupt();
  const deadline = Math.min(
    now + attentionNotificationDeliveryHorizonMs,
    ...ordered.map((row) => row.interactionDeadline),
    ...ordered.map((row) => row.allowedWindowEnd),
  );
  if (deadline <= now) {
    for (const row of ordered) await expirePending(ctx, row, now);
    return { kind: "closed" };
  }
  const capacityReserved = await reserveAttentionNotificationFaultCapacity(ctx, {
    anchorRowId: leader._id,
    deliveryId,
    now,
    userId: leader.userId,
  });
  if (!capacityReserved) {
    for (const row of ordered) await cancelPending(ctx, row, "service_fault", now);
    return { kind: "closed" };
  }
  for (const row of ordered) {
    const delivery = {
      attemptCount: 1,
      ...(row._id === leader._id ? { body } : {}),
      bodyDigest: digest,
      claimedAt: now,
      deadline,
      effectStartedAt: now,
      firstAttemptAt: now,
      generation: 1,
      id: deliveryId,
      idempotencyKey,
      lastAttemptAt: now,
      leaderRowId: leader._id,
      nextAttemptAt: now + attentionNotificationRetryRecoveryMs,
      recipientDigest: recipient.digest,
    };
    const patch = {
      claimCapacityReservation: attentionNotificationQuotaReservations.started,
      delivery,
      faultCapacityAnchor: leader._id,
      state: "effect_started" as const,
      updatedAt: now,
    };
    requireNonGrowingPatch(row, patch);
    await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
    await ctx.db.patch(row._id, patch);
  }
  return {
    body,
    deliveryId,
    generation: 1,
    globalNotificationGeneration: globalGeneration,
    idempotencyKey,
    kind: "effect",
    recipient: recipient.email,
  };
}

async function closeStartedAmbiguous(
  ctx: MutationCtx,
  rows: readonly OutboxRow[],
  code:
    | "retry_exhausted"
    | "delivery_deadline_elapsed"
    | "idempotency_mismatch"
    | "stored_delivery_corrupt",
  digest: string,
  now: number,
): Promise<void> {
  const first = rows[0] ?? corrupt();
  const groupDelivery = first.delivery ?? corrupt();
  await requireAttentionNotificationFaultCapacity(ctx, {
    anchorRowId: groupDelivery.leaderRowId,
    deliveryId: groupDelivery.id,
    userId: first.userId,
  });
  for (const row of rows) {
    if (row.state !== "effect_started" || row.delivery === undefined) corrupt();
    const delivery = { ...row.delivery };
    Reflect.deleteProperty(delivery, "nextAttemptAt");
    const patch = {
      claimCapacityReservation: undefined,
      delivery: {
        ...delivery,
        outcomeCode: code,
        outcomeDigest: digest,
        settledAt: now,
      },
      nonterminal: false,
      state: "ambiguous" as const,
      terminalCleanupAfter: now + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
      updatedAt: now,
    };
    requireNonGrowingPatch(row, patch);
    await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
    await ctx.db.patch(row._id, patch);
  }
  if (code !== "idempotency_mismatch" && code !== "stored_delivery_corrupt") {
    await releaseUnusedAttentionNotificationFaultCapacity(ctx, {
      anchorRowId: groupDelivery.leaderRowId,
      deliveryId: groupDelivery.id,
      userId: first.userId,
    });
  }
}

async function corruptDeliveryFault(deliveryId: string) {
  const digest = await sha256Hex(`stored_delivery_corrupt\u0000${deliveryId}`);
  const faultDeliveryId = isUuidV7(deliveryId)
    ? deliveryId
    : `00000000-0000-7000-8000-${digest.slice(0, 12)}`;
  return { digest, faultDeliveryId };
}

async function faultMatchesRealDeliveryId(
  fault: AttentionNotificationSafetyFault,
  deliveryId: string,
): Promise<boolean> {
  if (fault.reason !== "stored_delivery_corrupt") return false;
  const mapped = await corruptDeliveryFault(deliveryId);
  return fault.deliveryId === mapped.faultDeliveryId
    && fault.resultDigest === mapped.digest;
}

async function storedFaultDeliveryRows(
  ctx: MutationCtx,
  fault: AttentionNotificationSafetyFault,
  limit: number,
): Promise<OutboxRow[]> {
  const rows = await ctx.db.query("attentionNotificationOutbox")
    .withIndex("by_fault_capacity_anchor", (builder) => builder
      .eq("faultCapacityAnchor", fault.anchorRowId))
    .take(limit);
  return sortedRows(rows);
}

async function realDeliveryIdForStoredFault(
  ctx: MutationCtx,
  fault: AttentionNotificationSafetyFault,
): Promise<string | null> {
  if (fault.reason !== "stored_delivery_corrupt") return null;
  if (await faultMatchesRealDeliveryId(fault, fault.deliveryId)) return fault.deliveryId;
  const locator = fault.cleanupRowId === undefined
    ? null
    : await ctx.db.get(fault.cleanupRowId);
  if (
    locator?.delivery !== undefined
    && locator.userId === fault.userId
    && await faultMatchesRealDeliveryId(fault, locator.delivery.id)
  ) return locator.delivery.id;
  const candidates = await storedFaultDeliveryRows(
    ctx,
    fault,
    attentionNotificationGroupLimit + 1,
  );
  const deliveryIds = new Set(candidates.flatMap((row) =>
    row.delivery === undefined ? [] : [row.delivery.id]));
  for (const deliveryId of deliveryIds) {
    if (await faultMatchesRealDeliveryId(fault, deliveryId)) return deliveryId;
  }
  return null;
}

export async function latchCorruptAttentionNotificationDelivery(
  ctx: MutationCtx,
  deliveryId: string,
): Promise<ClosedClaim & Readonly<{ quarantineFaultId: string }>> {
  const rows = await deliveryRows(ctx, deliveryId);
  const cleanup = rows[0];
  if (cleanup?.delivery === undefined || cleanup.faultCapacityAnchor === undefined) corrupt();
  const { digest, faultDeliveryId } = await corruptDeliveryFault(deliveryId);
  const capacityDeliveryId = await faultCapacityDeliveryIdForAnchor(
    ctx,
    cleanup.userId,
    cleanup.faultCapacityAnchor,
  );
  if (capacityDeliveryId === null) corrupt();
  const latched = await latchAttentionNotificationSafetyFault(ctx, {
    anchorRowId: cleanup.faultCapacityAnchor,
    capacityDeliveryId,
    cleanupRowId: cleanup._id,
    deliveryId: faultDeliveryId,
    deliveryGeneration: 0,
    expectedGeneration: 0,
    reason: "stored_delivery_corrupt",
    resultDigest: digest,
    userId: cleanup.userId,
  });
  const faultId = latched.safetyFault?.faultId;
  if (faultId === undefined) corrupt();
  return { kind: "closed", quarantineFaultId: faultId };
}

async function latchCorruptSettlement(
  ctx: MutationCtx,
  input: Readonly<{
    deliveryGeneration: number;
    deliveryId: string;
    expectedGeneration: number;
    resultDigest?: string;
  }>,
): Promise<ClosedClaim & Readonly<{ quarantineFaultId: string }>> {
  const quarantine = await latchCorruptAttentionNotificationDelivery(ctx, input.deliveryId);
  if (input.resultDigest === undefined) return quarantine;
  const storedFault = await readAttentionNotificationSafetyFaultById(
    ctx,
    quarantine.quarantineFaultId,
  );
  if (
    storedFault?.reason !== "stored_delivery_corrupt"
    || !isUuidV7(input.deliveryId)
  ) corrupt();
  const capacityDeliveryId = await faultCapacityDeliveryIdForAnchor(
    ctx,
    storedFault.userId,
    storedFault.anchorRowId,
  );
  if (capacityDeliveryId === null) corrupt();
  await latchAttentionNotificationSafetyFault(ctx, {
    anchorRowId: storedFault.anchorRowId,
    capacityDeliveryId,
    deliveryId: input.deliveryId,
    deliveryGeneration: input.deliveryGeneration,
    expectedGeneration: input.expectedGeneration,
    reason: "invalid_idempotent_request",
    resultDigest: input.resultDigest,
    userId: storedFault.userId,
  });
  return quarantine;
}

export async function quarantineFaultedAttentionNotificationDelivery(
  ctx: MutationCtx,
  faultId: string,
  limit: number,
) {
  if (
    !isSafePositiveInteger(limit)
    || limit > attentionNotificationQuarantineRowLimit
  ) corrupt();
  const fault = await readAttentionNotificationSafetyFaultById(ctx, faultId);
  if (fault?.reason !== "stored_delivery_corrupt") corrupt();
  if (fault.quarantineState === "complete") {
    return { deleted: 0, remaining: false };
  }
  if (fault.state !== "latched" || fault.quarantineState !== "pending") corrupt();
  const cleanupDeliveryId = await realDeliveryIdForStoredFault(ctx, fault);
  if (cleanupDeliveryId === null) return { deleted: 0, remaining: true };
  const rows = await storedFaultDeliveryRows(ctx, fault, limit + 1);
  const selected = rows.length > limit && fault.cleanupRowId !== undefined
    ? rows.filter((row) => row._id !== fault.cleanupRowId).slice(0, limit)
    : rows.slice(0, limit);
  for (const row of selected) {
    await releaseCommandQuotaForDelete(ctx, row.userId, row);
    await ctx.db.delete(row._id);
  }
  const remaining = (await storedFaultDeliveryRows(ctx, fault, 1)).length !== 0;
  if (!remaining) {
    if ((await deliveryRows(ctx, cleanupDeliveryId)).length !== 0) corrupt();
    await completeAttentionNotificationSafetyFaultQuarantine(ctx, faultId, Date.now());
  }
  return { deleted: selected.length, remaining };
}

export const quarantineFaultedDelivery = internalMutation({
  args: { faultId: v.string() },
  handler: async (ctx, args) => await quarantineFaultedAttentionNotificationDelivery(
    ctx,
    args.faultId,
    attentionNotificationQuarantineRowLimit,
  ),
});

export async function deleteAttentionNotificationsForAccountDeletion(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
) {
  if (!isSafePositiveInteger(limit)) corrupt();
  const faults = await deleteAttentionNotificationSafetyFaultsForAccount(
    ctx,
    userId,
    limit,
  );
  if (faults.deleted === limit) return { deleted: limit, empty: false };
  const remainingLimit = limit - faults.deleted;
  const candidates = await ctx.db.query("attentionNotificationOutbox")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(remainingLimit);
  for (const row of candidates) {
    await releaseCommandQuotaForDelete(ctx, userId, row);
    await ctx.db.delete(row._id);
  }
  return {
    deleted: faults.deleted + candidates.length,
    empty: faults.empty && candidates.length === 0,
  };
}

export async function validatedStartedAttentionNotificationGroup(
  ctx: MutationCtx,
  deliveryId: string,
): Promise<Readonly<{ body: HraAttentionEmailBody; rows: OutboxRow[] }> | null> {
  const rows = await deliveryRows(ctx, deliveryId);
  if (rows.length < 1 || rows.length > attentionNotificationGroupLimit) return null;
  const first = rows[0] ?? corrupt();
  const delivery = first.delivery;
  if (delivery === undefined) return null;
  const leader = rows.find((row) => row._id === delivery.leaderRowId);
  const body = leader?.delivery?.body;
  if (
    leader === undefined
    || body === undefined
    || parseHraAttentionEmailBody(body) === null
    || rows.some((row) => {
      const candidate = row.delivery;
      return row.userId !== first.userId
        || row.state !== "effect_started"
        || !row.nonterminal
        || row.claimCapacityReservation !== (row.retrySuppressedAt === undefined
          ? attentionNotificationQuotaReservations.started
          : attentionNotificationQuotaReservations.suppressed)
        || row.faultCapacityAnchor !== delivery.leaderRowId
        || candidate === undefined
        || candidate.id !== delivery.id
        || candidate.leaderRowId !== delivery.leaderRowId
        || candidate.generation !== delivery.generation
        || candidate.attemptCount !== delivery.attemptCount
        || candidate.bodyDigest !== delivery.bodyDigest
        || candidate.claimedAt !== delivery.claimedAt
        || candidate.deadline !== delivery.deadline
        || candidate.effectStartedAt !== delivery.effectStartedAt
        || candidate.firstAttemptAt !== delivery.firstAttemptAt
        || candidate.idempotencyKey !== delivery.idempotencyKey
        || candidate.lastAttemptAt !== delivery.lastAttemptAt
        || candidate.nextAttemptAt !== delivery.nextAttemptAt
        || candidate.recipientDigest !== delivery.recipientDigest
        || (row._id === delivery.leaderRowId) !== (candidate.body !== undefined)
        || candidate.settledAt !== undefined
        || candidate.outcomeCode !== undefined
        || candidate.outcomeDigest !== undefined;
    })
  ) return null;
  const rebuilt = buildHraAttentionEmailBody(rows.map((row) => ({
    interactionKind: row.interactionKind,
    sessionPublicId: row.sessionPublicId,
  })));
  const rebuiltDigest = await bodyDigest(rebuilt);
  if (
    rebuilt.text !== body.text
    || rebuiltDigest !== delivery.bodyDigest
    || await deliveryKey(deliveryId, delivery.recipientDigest, delivery.bodyDigest)
      !== delivery.idempotencyKey
  ) return null;
  const capacity = await requireAttentionNotificationFaultCapacity(ctx, {
    anchorRowId: delivery.leaderRowId,
    deliveryId: delivery.id,
    userId: first.userId,
  });
  if (capacity.some((slot) => slot.state !== "reserved")) return null;
  return { body, rows };
}

async function validRetainedIdempotencyAmbiguity(
  rows: readonly OutboxRow[],
  input: Readonly<{
    deliveryId: string;
    resultDigest: string;
  }>,
): Promise<boolean> {
  if (rows.length < 1 || rows.length > attentionNotificationGroupLimit) return false;
  const first = rows[0];
  const delivery = first?.delivery;
  if (first === undefined || delivery?.settledAt === undefined) return false;
  const settledAt = delivery.settledAt;
  const leader = rows.find((row) => row._id === delivery.leaderRowId);
  const body = leader?.delivery?.body;
  if (
    leader === undefined
    || body === undefined
    || parseHraAttentionEmailBody(body) === null
    || rows.some((row) => {
      const candidate = row.delivery;
      return row.userId !== first.userId
        || row.state !== "ambiguous"
        || row.nonterminal
        || row.claimCapacityReservation !== undefined
        || row.faultCapacityAnchor !== delivery.leaderRowId
        || row.terminalCleanupAfter
          !== settledAt + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS
        || candidate === undefined
        || candidate.id !== input.deliveryId
        || candidate.id !== delivery.id
        || candidate.leaderRowId !== delivery.leaderRowId
        || candidate.generation !== delivery.generation
        || candidate.attemptCount !== delivery.attemptCount
        || candidate.bodyDigest !== delivery.bodyDigest
        || candidate.claimedAt !== delivery.claimedAt
        || candidate.deadline !== delivery.deadline
        || candidate.effectStartedAt !== delivery.effectStartedAt
        || candidate.firstAttemptAt !== delivery.firstAttemptAt
        || candidate.idempotencyKey !== delivery.idempotencyKey
        || candidate.lastAttemptAt !== delivery.lastAttemptAt
        || candidate.nextAttemptAt !== undefined
        || candidate.recipientDigest !== delivery.recipientDigest
        || (row._id === delivery.leaderRowId) !== (candidate.body !== undefined)
        || candidate.outcomeCode !== "idempotency_mismatch"
        || candidate.outcomeDigest !== input.resultDigest
        || candidate.settledAt !== settledAt;
    })
  ) return false;
  const rebuilt = buildHraAttentionEmailBody(rows.map((row) => ({
    interactionKind: row.interactionKind,
    sessionPublicId: row.sessionPublicId,
  })));
  return rebuilt.text === body.text
    && await bodyDigest(rebuilt) === delivery.bodyDigest
    && await deliveryKey(delivery.id, delivery.recipientDigest, delivery.bodyDigest)
      === delivery.idempotencyKey;
}

async function latchRetainedIdempotencyFault(
  ctx: MutationCtx,
  rows: readonly OutboxRow[],
  input: Readonly<{
    deliveryGeneration: number;
    deliveryId: string;
    expectedGeneration: number;
    resultDigest: string;
  }>,
) {
  const first = rows[0] ?? corrupt();
  const anchorRowId = first.faultCapacityAnchor ?? corrupt();
  const capacityDeliveryId = await faultCapacityDeliveryIdForAnchor(
    ctx,
    first.userId,
    anchorRowId,
  );
  if (capacityDeliveryId === null) corrupt();
  return await latchAttentionNotificationSafetyFault(ctx, {
    anchorRowId,
    capacityDeliveryId,
    deliveryId: input.deliveryId,
    deliveryGeneration: input.deliveryGeneration,
    expectedGeneration: input.expectedGeneration,
    reason: "invalid_idempotent_request",
    resultDigest: input.resultDigest,
    userId: first.userId,
  });
}

async function quiesceSuppressedGroup(
  ctx: MutationCtx,
  rows: readonly OutboxRow[],
  fallbackReason: SuppressionReason,
  now: number,
): Promise<void> {
  for (const row of rows) {
    const delivery = row.delivery ?? corrupt();
    const deliveryWithoutRetry = { ...delivery };
    Reflect.deleteProperty(deliveryWithoutRetry, "nextAttemptAt");
    const patch = {
      claimCapacityReservation: attentionNotificationQuotaReservations.suppressed,
      delivery: deliveryWithoutRetry,
      ...(row.retrySuppressedAt === undefined
        ? { retrySuppressedAt: now, retrySuppressionReason: fallbackReason }
        : {}),
      updatedAt: now,
    };
    requireNonGrowingPatch(row, patch);
    await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
    await ctx.db.patch(row._id, patch);
  }
}

async function retryStartedGroup(
  ctx: MutationCtx,
  seed: OutboxRow,
  control: Awaited<ReturnType<typeof readAttentionNotificationControl>>,
  now: number,
): Promise<ClaimResult> {
  const delivery = seed.delivery ?? corrupt();
  if (await accountDeletionInProgress(ctx, seed.userId)) {
    const rows = await deliveryRows(ctx, delivery.id);
    if (rows.length > attentionNotificationGroupLimit) {
      return await latchCorruptAttentionNotificationDelivery(ctx, delivery.id);
    }
    if (
      rows.length === 0
      || rows.some((row) =>
        row.userId !== seed.userId
        || row.state !== "effect_started"
        || !row.nonterminal
        || row.delivery?.id !== delivery.id)
    ) corrupt();
    await quiesceSuppressedGroup(ctx, rows, "account_deletion", now);
    return { kind: "closed" };
  }
  const validated = await validatedStartedAttentionNotificationGroup(ctx, delivery.id);
  if (validated === null) {
    return await latchCorruptAttentionNotificationDelivery(ctx, delivery.id);
  }
  const { body, rows } = validated;
  if (rows.some((row) => row.retrySuppressedAt !== undefined)) {
    await quiesceSuppressedGroup(ctx, rows, "source_reconciled", now);
    return { kind: "closed" };
  }
  if (
    control.attentionNotifications !== "enabled"
    || control.attentionNotificationGeneration !== seed.globalNotificationGeneration
  ) {
    await quiesceSuppressedGroup(ctx, rows, "global_disabled", now);
    return { kind: "closed" };
  }
  if (now >= delivery.deadline || delivery.attemptCount >= maximumDeliveryAttempts) {
    const code = delivery.attemptCount >= maximumDeliveryAttempts
      ? "retry_exhausted" as const
      : "delivery_deadline_elapsed" as const;
    const digest = await sha256Hex(`${code}\u0000${delivery.id}\u0000${String(delivery.generation)}`);
    await closeStartedAmbiguous(ctx, rows, code, digest, now);
    return { kind: "closed" };
  }
  const recipient = await currentRecipient(ctx, seed.userId);
  if (recipient === null || recipient.digest !== delivery.recipientDigest) {
    await quiesceSuppressedGroup(ctx, rows, "recipient_unavailable", now);
    return { kind: "closed" };
  }
  for (const row of rows) {
    const failure = await rowAuthorityFailure(
      ctx,
      row,
      seed.globalNotificationGeneration,
      now,
    );
    if (failure !== null) {
      await quiesceSuppressedGroup(ctx, rows, failure, now);
      return { kind: "closed" };
    }
  }
  const generation = delivery.generation + 1;
  const attemptCount = delivery.attemptCount + 1;
  for (const row of rows) {
    const current = row.delivery ?? corrupt();
    const patch = {
      delivery: {
        ...current,
        attemptCount,
        effectStartedAt: now,
        generation,
        lastAttemptAt: now,
        nextAttemptAt: now + attentionNotificationRetryRecoveryMs,
      },
      updatedAt: now,
    };
    requireNonGrowingPatch(row, patch);
    await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
    await ctx.db.patch(row._id, patch);
  }
  return {
    body,
    deliveryId: delivery.id,
    generation,
    globalNotificationGeneration: seed.globalNotificationGeneration,
    idempotencyKey: delivery.idempotencyKey,
    kind: "effect",
    recipient: recipient.email,
  };
}

export const claimNext = internalMutation({
  args: {},
  handler: async (ctx): Promise<ClaimResult> => {
    const now = Date.now();
    const control = await readAttentionNotificationControl(ctx);
    if (
      control.attentionNotifications !== "enabled"
      || await readOldestLatchedAttentionNotificationSafetyFault(ctx) !== null
    ) return null;
    const retry = await ctx.db.query("attentionNotificationOutbox")
      .withIndex("by_state_and_next_attempt_at", (builder) => builder
        .eq("state", "effect_started")
        .lte("delivery.nextAttemptAt", now))
      .first();
    if (retry !== null) return await retryStartedGroup(ctx, retry, control, now);
    const globalGeneration = control.attentionNotificationGeneration;
    if (!isSafePositiveInteger(globalGeneration)) corrupt();
    const seed = await ctx.db.query("attentionNotificationOutbox")
      .withIndex("by_state_and_coalesce_after", (builder) => builder
        .eq("state", "pending")
        .lte("coalesceAfter", now))
      .first();
    if (seed === null) return null;
    const rows = await ctx.db.query("attentionNotificationOutbox")
      .withIndex("by_user_state_and_coalesce_after", (builder) => builder
        .eq("userId", seed.userId)
        .eq("state", "pending")
        .lte("coalesceAfter", now))
      .take(attentionNotificationGroupLimit);
    const ordered = sortedRows(rows);
    if (!ordered.some((row) => row._id === seed._id)) corrupt();
    if (await accountDeletionInProgress(ctx, seed.userId)) {
      for (const row of ordered) await cancelPending(ctx, row, "account_deletion", now);
      return { kind: "closed" };
    }
    const recipient = await currentRecipient(ctx, seed.userId);
    if (recipient === null) {
      for (const row of ordered) await cancelPending(ctx, row, "recipient_unavailable", now);
      return { kind: "closed" };
    }
    for (const row of ordered) {
      if (
        row.delivery !== undefined
        || !row.nonterminal
        || row.state !== "pending"
        || !actionsAreCanonical(row.remoteActions)
      ) corrupt();
      if (now >= row.claimDeadline) {
        await expirePending(ctx, row, now);
        return { kind: "closed" };
      }
      const failure = await rowAuthorityFailure(ctx, row, globalGeneration, now);
      if (failure !== null) {
        await cancelPending(ctx, row, failure, now);
        return { kind: "closed" };
      }
    }
    const deferUntil = await capDeferral(ctx, ordered, now);
    if (deferUntil !== null) {
      await deferPendingGroup(ctx, ordered, deferUntil, now);
      return { kind: "closed" };
    }
    return await startPendingGroup(ctx, ordered, recipient, globalGeneration, now);
  },
});

const acceptedResult = v.object({
  kind: v.literal("accepted"),
  providerMessageId: v.string(),
});
const refusedResult = v.object({
  kind: v.literal("refused"),
  providerErrorType: v.string(),
  status: v.number(),
});
const ambiguousResult = v.object({
  kind: v.literal("ambiguous"),
  providerErrorType: v.literal("invalid_idempotent_request"),
  safetyFault: v.literal(true),
  status: v.literal(409),
});
const retryableResult = v.object({
  kind: v.literal("retryable"),
  reason: v.string(),
});

type SettlementResult =
  | Readonly<{ kind: "accepted"; providerMessageId: string }>
  | Readonly<{ kind: "refused"; providerErrorType: string; status: number }>
  | Readonly<{
      kind: "ambiguous";
      providerErrorType: "invalid_idempotent_request";
      safetyFault: true;
      status: 409;
    }>
  | Readonly<{ kind: "retryable"; reason: string }>;

const providerMessageIdPattern = /^[A-Za-z0-9_-]{1,256}$/u;
const refusalTypes = new Set([
  "invalid_access",
  "invalid_api_key",
  "invalid_attachment",
  "invalid_from_address",
  "invalid_idempotency_key",
  "invalid_parameter",
  "invalid_region",
  "method_not_allowed",
  "missing_api_key",
  "missing_required_field",
  "not_found",
  "restricted_api_key",
  "validation_error",
]);
const retryableReasons = new Set([
  "concurrent_idempotency",
  "malformed_success",
  "network",
  "timeout",
  "transient_http",
  "unknown_or_incoherent_response",
]);

function validSettlementResult(result: SettlementResult): boolean {
  if (result.kind === "accepted") return providerMessageIdPattern.test(result.providerMessageId);
  if (result.kind === "refused") {
    return Number.isInteger(result.status)
      && result.status >= 400
      && result.status < 500
      && refusalTypes.has(result.providerErrorType)
      && isHraAttentionEmailDocumentedRefusal(
        result.status,
        result.providerErrorType,
      );
  }
  if (result.kind === "ambiguous") return true;
  return retryableReasons.has(result.reason);
}

function canonicalResult(result: SettlementResult): string {
  switch (result.kind) {
    case "accepted":
      return `accepted\u0000${result.providerMessageId}`;
    case "refused":
      return `refused\u0000${String(result.status)}\u0000${result.providerErrorType}`;
    case "ambiguous":
      return "ambiguous\u0000409\u0000invalid_idempotent_request";
    case "retryable":
      return `retryable\u0000${result.reason}`;
  }
}

async function terminalizeDelivery(
  ctx: MutationCtx,
  rows: readonly OutboxRow[],
  result: Extract<SettlementResult, { kind: "accepted" | "refused" }>,
  digest: string,
  now: number,
): Promise<void> {
  const first = rows[0] ?? corrupt();
  const groupDelivery = first.delivery ?? corrupt();
  await requireAttentionNotificationFaultCapacity(ctx, {
    anchorRowId: groupDelivery.leaderRowId,
    deliveryId: groupDelivery.id,
    userId: first.userId,
  });
  const state = result.kind === "accepted"
    ? "accepted" as const
    : "refused" as const;
  const outcomeCode = result.kind === "accepted"
    ? "provider_accepted" as const
    : "provider_refused" as const;
  for (const row of rows) {
    const delivery = row.delivery ?? corrupt();
    const deliveryWithoutRetry = { ...delivery };
    Reflect.deleteProperty(deliveryWithoutRetry, "nextAttemptAt");
    const patch = {
      claimCapacityReservation: undefined,
      delivery: {
        ...deliveryWithoutRetry,
        outcomeCode,
        outcomeDigest: digest,
        settledAt: now,
      },
      nonterminal: false,
      state,
      terminalCleanupAfter: now + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
      updatedAt: now,
    };
    requireNonGrowingPatch(row, patch);
    await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
    await ctx.db.patch(row._id, patch);
  }
  await releaseUnusedAttentionNotificationFaultCapacity(ctx, {
    anchorRowId: groupDelivery.leaderRowId,
    deliveryId: groupDelivery.id,
    userId: first.userId,
  });
}

export const settleAttempt = internalMutation({
  args: {
    deliveryId: v.string(),
    generation: v.number(),
    globalNotificationGeneration: v.number(),
    result: v.union(acceptedResult, refusedResult, ambiguousResult, retryableResult),
  },
  handler: async (ctx, args) => {
    if (
      !isOpaqueIdentifier(args.deliveryId)
      || !isSafePositiveInteger(args.generation)
      || !isSafePositiveInteger(args.globalNotificationGeneration)
      || !validSettlementResult(args.result)
    ) corrupt();
    const result = args.result as SettlementResult;
    const digest = await sha256Hex(canonicalResult(result));
    const now = Date.now();
    const rows = await deliveryRows(ctx, args.deliveryId);
    if (rows.length === 0) return { kind: "erased" as const };
    const settlementUserId = rows[0]?.userId ?? corrupt();
    if (rows.some((row) => row.userId !== settlementUserId)) corrupt();
    if (await accountDeletionInProgress(ctx, settlementUserId)) {
      return { kind: "erasure_pending" as const };
    }
    if (rows.length > attentionNotificationGroupLimit) {
      const quarantine = await latchCorruptSettlement(ctx, {
        deliveryGeneration: args.generation,
        deliveryId: args.deliveryId,
        expectedGeneration: args.globalNotificationGeneration,
        ...(result.kind === "ambiguous" ? { resultDigest: digest } : {}),
      });
      return {
        kind: "safety_fault" as const,
        quarantineFaultId: quarantine.quarantineFaultId,
      };
    }
    if (rows.some((row) =>
      row.globalNotificationGeneration !== args.globalNotificationGeneration)) {
      corrupt();
    }
    const terminal = rows.every((row) => !row.nonterminal);
    if (terminal) {
      const expectedState = result.kind === "accepted"
        ? "accepted"
        : result.kind === "refused"
          ? "refused"
          : result.kind === "ambiguous"
            ? "ambiguous"
            : null;
      const basicReplay = !(
        expectedState === null
        || rows.some((row) =>
          row.delivery?.generation !== args.generation
          || row.delivery.id !== args.deliveryId
          || row.delivery.outcomeDigest !== digest
          || row.delivery.outcomeCode !== (result.kind === "accepted"
            ? "provider_accepted"
            : result.kind === "refused"
              ? "provider_refused"
              : "idempotency_mismatch")
          || row.state !== expectedState)
      );
      if (result.kind !== "ambiguous" && basicReplay) {
        return { kind: "replay" as const };
      }
      if (result.kind !== "ambiguous") corrupt();
      if (await validRetainedIdempotencyAmbiguity(rows, {
        deliveryId: args.deliveryId,
        resultDigest: digest,
      })) {
        const retainedGeneration = rows[0]?.delivery?.generation ?? corrupt();
        if (args.generation > retainedGeneration) corrupt();
        if (args.generation === retainedGeneration && !basicReplay) corrupt();
        const fault = await latchRetainedIdempotencyFault(ctx, rows, {
          deliveryGeneration: args.generation,
          deliveryId: args.deliveryId,
          expectedGeneration: args.globalNotificationGeneration,
          resultDigest: digest,
        });
        return fault.changed
          ? { kind: "ambiguous" as const, reason: "idempotency_mismatch" as const }
          : { kind: "replay" as const };
      }
      // Accepted, refused, and ordinary terminal ambiguity release all service
      // fault capacity. The delivery action has exactly one settlement call for
      // each resolved or aborted fetch, so an injected later contradictory 409
      // is not an admitted provider callback: fail without reversing terminal
      // state or creating retry work.
      if (rows.some((row) =>
        row.state !== "ambiguous"
        || row.delivery?.outcomeCode !== "idempotency_mismatch")) corrupt();
      const quarantine = await latchCorruptSettlement(ctx, {
        deliveryGeneration: args.generation,
        deliveryId: args.deliveryId,
        expectedGeneration: args.globalNotificationGeneration,
        resultDigest: digest,
      });
      return {
        kind: "safety_fault" as const,
        quarantineFaultId: quarantine.quarantineFaultId,
      };
    }
    const validated = await validatedStartedAttentionNotificationGroup(ctx, args.deliveryId);
    if (validated === null) {
      const quarantine = await latchCorruptSettlement(ctx, {
        deliveryGeneration: args.generation,
        deliveryId: args.deliveryId,
        expectedGeneration: args.globalNotificationGeneration,
        ...(result.kind === "ambiguous" ? { resultDigest: digest } : {}),
      });
      return {
        kind: "safety_fault" as const,
        quarantineFaultId: quarantine.quarantineFaultId,
      };
    }
    const exactRows = validated.rows;
    const currentGeneration = exactRows[0]?.delivery?.generation ?? corrupt();
    if (currentGeneration !== args.generation) {
      if (result.kind !== "ambiguous" || args.generation >= currentGeneration) corrupt();
      // Recovery may advance the durable row before an older admitted action
      // commits its provider result. A 409 remains a mandatory exact-generation
      // safety observation: close the current same-key group, consume the older
      // generation's reserved slot, and prevent any later result from reversing
      // the ambiguity.
      await closeStartedAmbiguous(
        ctx,
        exactRows,
        "idempotency_mismatch",
        digest,
        now,
      );
      await latchAttentionNotificationSafetyFault(ctx, {
        anchorRowId: exactRows[0]?.faultCapacityAnchor ?? corrupt(),
        capacityDeliveryId: args.deliveryId,
        deliveryId: args.deliveryId,
        deliveryGeneration: args.generation,
        expectedGeneration: args.globalNotificationGeneration,
        reason: "invalid_idempotent_request",
        resultDigest: digest,
        userId: exactRows[0]?.userId ?? corrupt(),
      });
      return { kind: "ambiguous" as const, reason: "idempotency_mismatch" as const };
    }
    if (result.kind === "retryable") {
      const delivery = exactRows[0]?.delivery ?? corrupt();
      const delay = delivery.attemptCount === 1
        ? attentionNotificationRetryTwoDelayMs
        : attentionNotificationRetryThreeDelayMs;
      const nextAttemptAt = delivery.lastAttemptAt + delay;
      if (
        delivery.attemptCount >= maximumDeliveryAttempts
        || nextAttemptAt >= delivery.deadline
      ) {
        const code = delivery.attemptCount >= maximumDeliveryAttempts
          ? "retry_exhausted" as const
          : "delivery_deadline_elapsed" as const;
        const terminalDigest = await sha256Hex(
          `${code}\u0000${delivery.id}\u0000${String(delivery.generation)}`,
        );
        await closeStartedAmbiguous(ctx, exactRows, code, terminalDigest, now);
        return { kind: "ambiguous" as const, reason: code };
      }
      for (const row of exactRows) {
        const current = row.delivery ?? corrupt();
        const patch = {
          delivery: { ...current, nextAttemptAt },
          updatedAt: now,
        };
        requireNonGrowingPatch(row, patch);
        await adjustCommandQuotaForPatch(ctx, row.userId, row, patch);
        await ctx.db.patch(row._id, patch);
      }
      return { kind: "retry_scheduled" as const, nextAttemptAt };
    }
    if (result.kind === "ambiguous") {
      await closeStartedAmbiguous(
        ctx,
        exactRows,
        "idempotency_mismatch",
        digest,
        now,
      );
      await latchAttentionNotificationSafetyFault(ctx, {
        anchorRowId: exactRows[0]?.faultCapacityAnchor ?? corrupt(),
        capacityDeliveryId: args.deliveryId,
        deliveryId: args.deliveryId,
        deliveryGeneration: args.generation,
        expectedGeneration: args.globalNotificationGeneration,
        reason: "invalid_idempotent_request",
        resultDigest: digest,
        userId: exactRows[0]?.userId ?? corrupt(),
      });
      return { kind: "ambiguous" as const, reason: "idempotency_mismatch" as const };
    }
    await terminalizeDelivery(ctx, exactRows, result, digest, now);
    return { kind: result.kind };
  },
});
