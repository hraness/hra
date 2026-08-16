import {
  acceptedSessionHeadSchema,
  assertObservationOnlySyncValue,
  canonicalSessionSyncJson,
  decodeSyncUint64,
  digestSyncRecoveryVaultRootWrap,
  digestSyncVaultRootWrapManifest,
  encodeSyncUint64,
  MAX_SYNC_DEVICES,
  MAX_SYNC_DIRECTORY_SESSIONS,
  MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE,
  MAX_SYNC_LIFETIME_DIRECTORY_IDENTITIES,
  MAX_SYNC_LIFETIME_MEMBERSHIP_EPOCHS,
  MAX_SYNC_LIFETIME_ROOT_KEY_EPOCHS,
  MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
  MAX_SYNC_RETAINED_EVENTS,
  MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS,
  retiredSessionIdFenceSchema,
  recoverSyncVaultRequestSchema,
  sessionDirectoryChangePageSchema,
  sessionDirectorySnapshotPageSchema,
  sessionSyncTombstoneSchema,
  syncDeviceProofSchema,
  syncDevicePublicKeysSchema,
  syncMembershipHeadSchema,
  syncMembershipSignatureSchema,
  syncEnrollmentPairingTranscriptSchema,
  syncRecoveryReceiptSchema,
  wrappedSyncVaultRootKeySchema,
  wrappedSyncVaultRootKeyLinkSchema,
  wrappedSyncRecoveryVaultRootKeySchema,
  type SyncDeviceProof,
  type RecoverSyncVaultRequest,
} from "@hraness/agent-tasks-protocol";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authorizeOrganizationHuman } from "./humanAuthorization";
import { hraSessionSyncEnabled } from "./hraEnvironment";
import {
  compareSyncIdentifier,
  compareSyncUint64,
  decideSessionPublication,
  deviceConnectionState,
  enrollmentQuotaFailure,
  nextRequiredSyncUint64,
  nextStreamState,
  quotaFailure,
  syncUint64OrderKey,
} from "./sessionSyncLaws";
import {
  bootstrapSyncVaultRequestSchema,
  claimSyncEnrollmentRequestSchema,
  MAX_SESSION_SYNC_PENDING_ENROLLMENTS,
  MAX_SESSION_SYNC_RESPONSE_JSON_BYTES,
  routeForSessionSyncRequest,
  readSyncRecoveryContextRequestSchema,
  SESSION_SYNC_ENROLLMENT_RETENTION_MS,
  SESSION_SYNC_ENROLLMENT_TTL_MS,
  SESSION_SYNC_MEMBERSHIP_PROPOSAL_TTL_MS,
  SESSION_SYNC_CREATION_GRANT_TTL_MS,
  SESSION_SYNC_SNAPSHOT_TTL_MS,
  SESSION_SYNC_TOMBSTONE_RETENTION_MS,
  sessionSyncBackendErrorCodes,
  sessionSyncBackendNonRateErrorCodes,
  sessionSyncBackendRequestSchema,
  sessionSyncBackendResponseSchema,
  submitSyncEnrollmentRequestSchema,
  type SessionSyncBackendErrorCode,
  type SessionSyncBackendRequest,
  type SessionSyncBackendResult,
} from "./sessionSyncSchemas";

const backendErrorCodeValidator = v.union(
  ...sessionSyncBackendErrorCodes.map((code) => v.literal(code)),
);
const backendNonRateErrorCodeValidator = v.union(
  ...sessionSyncBackendNonRateErrorCodes.map((code) => v.literal(code)),
);
const backendResultValidator = v.union(
  v.object({ ok: v.literal(true), responseJson: v.string() }),
  v.object({
    ok: v.literal(false),
    code: backendNonRateErrorCodeValidator,
  }),
  v.object({ ok: v.literal(false), code: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
const proofContextResultValidator = v.union(
  v.object({ ok: v.literal(true), contextJson: v.string() }),
  v.object({ ok: v.literal(false), code: backendErrorCodeValidator }),
);
const negotiationGateResultValidator = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({
    ok: v.literal(false),
    code: backendNonRateErrorCodeValidator,
  }),
  v.object({
    ok: v.literal(false),
    code: v.literal("RATE_LIMITED"),
    retryAfterMs: v.number(),
  }),
);
const recoveryContextResultValidator = v.union(
  v.object({ ok: v.literal(false), code: backendErrorCodeValidator }),
  v.object({
    ok: v.literal(true),
    kind: v.literal("current"),
    contextJson: v.string(),
  }),
  v.object({
    ok: v.literal(true),
    kind: v.literal("replay"),
    responseJson: v.string(),
  }),
);

type ReadCtx = QueryCtx | MutationCtx;
type AuthorizedSyncContext = Readonly<{
  vault: Doc<"syncVaults">;
  device: Doc<"syncDevices">;
}>;
type BackendFailure = Extract<SessionSyncBackendResult, { ok: false }>;

const MAX_ACTIVE_SNAPSHOT_PINS_PER_VAULT = 4;
const MAX_EXPIRED_SNAPSHOT_PINS_PER_SWEEP = 4;
const MAX_RETIREMENT_CHANGE_PURGE_PER_SWEEP = 128;
const MAX_ENROLLMENT_PROOF_NONCES_PER_DEVICE = 64;
const MAX_ACTIVE_PROOF_NONCES_PER_DEVICE = 256;
const SESSION_SYNC_RATE_LIMIT_WINDOW_MS = 60_000;
const SESSION_SYNC_RATE_LIMIT_RETENTION_MS = 2 * SESSION_SYNC_RATE_LIMIT_WINDOW_MS;

type SessionSyncRateClass =
  | "registration"
  | "heartbeat"
  | "read_poll"
  | "membership"
  | "ingest";
type SessionSyncRateSubject = Readonly<{
  kind: "human" | "vault" | "device";
  key: string;
}>;

const sessionSyncRateLimits = Object.freeze({
  registration: Object.freeze({ human: 30, vault: 30, device: 0 }),
  heartbeat: Object.freeze({ human: 0, vault: 480, device: 120 }),
  read_poll: Object.freeze({ human: 0, vault: 1_200, device: 300 }),
  membership: Object.freeze({ human: 0, vault: 120, device: 30 }),
  ingest: Object.freeze({ human: 0, vault: 1_200, device: 300 }),
} satisfies Record<SessionSyncRateClass, Record<SessionSyncRateSubject["kind"], number>>);

function failure(code: SessionSyncBackendErrorCode, retryAfterMs?: number): BackendFailure {
  if (code === "RATE_LIMITED") {
    if (retryAfterMs === undefined) throw new Error("rate-limit failure requires retryAfterMs");
    return { ok: false, code, retryAfterMs };
  }
  if (retryAfterMs !== undefined) throw new Error("non-rate failure cannot carry retryAfterMs");
  return { ok: false, code };
}

function rateClassForRequest(request: SessionSyncBackendRequest): SessionSyncRateClass {
  switch (request.operation) {
    case "establish_boot":
    case "heartbeat": return "heartbeat";
    case "read_membership":
    case "root_key_link_page":
    case "list_enrollment_requests":
    case "snapshot_page":
    case "change_page": return "read_poll";
    case "admit_membership_proposal":
    case "update_membership":
    case "approve_enrollment": return "membership";
    case "reserve_session":
    case "acquire_writer":
    case "publish_session":
    case "delete_session":
    case "begin_snapshot": return "ingest";
  }
}

export const authorizeNegotiation = internalMutation({
  args: {},
  returns: negotiationGateResultValidator,
  handler: async (ctx) => {
    if (!hraSessionSyncEnabled({
      HRA_SESSION_SYNC_ENABLED: process.env.HRA_SESSION_SYNC_ENABLED,
      OPRTE_SESSION_SYNC_ENABLED: process.env.OPRTE_SESSION_SYNC_ENABLED,
    })) {
      return failure("AUTHORIZATION_DENIED");
    }
    const human = await authorizeOrganizationHuman(ctx, {
      requestId: "session-sync-negotiate",
    });
    if (!human.ok) return failure("AUTHENTICATION_FAILED");
    const rateFailure = await consumeSessionSyncRateLimit(
      ctx,
      "registration",
      [{ kind: "human", key: human.authorization.user._id }],
      Date.now(),
    );
    return rateFailure ?? { ok: true as const };
  },
});

async function consumeSessionSyncRateLimit(
  ctx: MutationCtx,
  routeClass: SessionSyncRateClass,
  subjectsValue: readonly SessionSyncRateSubject[],
  now: number,
): Promise<BackendFailure | null> {
  if (!Number.isSafeInteger(now) || now < 0) return failure("SERVICE_UNAVAILABLE");
  const subjects = [...new Map(
    subjectsValue.map((subject) => [`${subject.kind}\u0000${subject.key}`, subject]),
  ).values()];
  const windowStartedAt = Math.floor(now / SESSION_SYNC_RATE_LIMIT_WINDOW_MS)
    * SESSION_SYNC_RATE_LIMIT_WINDOW_MS;
  const windowEndsAt = windowStartedAt + SESSION_SYNC_RATE_LIMIT_WINDOW_MS;
  const expiresAt = windowStartedAt + SESSION_SYNC_RATE_LIMIT_RETENTION_MS;
  const loaded = await Promise.all(subjects.map(async (subject) => ({
    subject,
    limit: sessionSyncRateLimits[routeClass][subject.kind],
    row: await ctx.db
      .query("syncRateLimitBuckets")
      .withIndex("by_subject_route_and_window", (query) =>
        query
          .eq("subjectKind", subject.kind)
          .eq("subjectKey", subject.key)
          .eq("routeClass", routeClass)
          .eq("windowStartedAt", windowStartedAt),
      )
      .unique(),
  })));
  if (loaded.some(({ limit }) => !Number.isSafeInteger(limit) || limit <= 0)) {
    return failure("SERVICE_UNAVAILABLE");
  }
  if (loaded.some(({ row, limit }) => (row?.count ?? 0) >= limit)) {
    return failure("RATE_LIMITED", Math.max(1, windowEndsAt - now));
  }
  for (const { subject, row } of loaded) {
    if (row === null) {
      await ctx.db.insert("syncRateLimitBuckets", {
        subjectKind: subject.kind,
        subjectKey: subject.key,
        routeClass,
        windowStartedAt,
        count: 1,
        expiresAt,
      });
    } else {
      await ctx.db.patch(row._id, { count: row.count + 1, expiresAt });
    }
  }
  return null;
}

async function consumeAuthorizedSessionSyncRateLimit(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: SessionSyncBackendRequest,
  now: number,
): Promise<BackendFailure | null> {
  return await consumeSessionSyncRateLimit(ctx, rateClassForRequest(request), [
    { kind: "vault", key: context.vault._id },
    { kind: "device", key: context.device._id },
  ], now);
}

async function consumeDeviceProofNonce(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  proof: SyncDeviceProof,
  now: number,
  exactReplay: "allow" | "reject",
): Promise<BackendFailure | null> {
  const existing = await ctx.db
    .query("syncProofNonces")
    .withIndex("by_device_and_nonce", (query) =>
      query.eq("deviceId", context.device._id).eq("proofNonce", proof.payload.nonce),
    )
    .unique();
  if (existing !== null) {
    const exact = existing.vaultId === context.vault._id
      && existing.route === proof.payload.route
      && existing.method === proof.payload.method
      && existing.bodyDigest === proof.payload.bodyDigest
      && existing.issuedAt === Number(decodeSyncUint64(proof.payload.issuedAt))
      && existing.expiresAt === Number(decodeSyncUint64(proof.payload.expiresAt));
    if (!exact) return failure(exactReplay === "allow" ? "CONFLICT" : "PROOF_REPLAYED");
    return exactReplay === "allow" ? null : failure("PROOF_REPLAYED");
  }
  const activeProofs = await ctx.db
    .query("syncProofNonces")
    .withIndex("by_device_and_expiry", (query) =>
      query.eq("deviceId", context.device._id).gt("expiresAt", now),
    )
    .order("asc")
    .take(MAX_ACTIVE_PROOF_NONCES_PER_DEVICE);
  if (activeProofs.length >= MAX_ACTIVE_PROOF_NONCES_PER_DEVICE) {
    return failure(
      "RATE_LIMITED",
      Math.max(1, Math.min(300_000, (activeProofs[0]?.expiresAt ?? now + 1) - now)),
    );
  }
  await ctx.db.insert("syncProofNonces", {
    vaultId: context.vault._id,
    deviceId: context.device._id,
    proofNonce: proof.payload.nonce,
    route: proof.payload.route,
    method: proof.payload.method,
    bodyDigest: proof.payload.bodyDigest,
    issuedAt: Number(decodeSyncUint64(proof.payload.issuedAt)),
    expiresAt: Number(decodeSyncUint64(proof.payload.expiresAt)),
    consumedAt: now,
  });
  return null;
}

function success(value: unknown): SessionSyncBackendResult {
  assertObservationOnlySyncValue(value);
  const responseJson = canonicalSessionSyncJson(sessionSyncBackendResponseSchema.parse(value));
  if (new TextEncoder().encode(responseJson).byteLength > MAX_SESSION_SYNC_RESPONSE_JSON_BYTES) {
    throw new Error("session sync response exceeds its byte bound");
  }
  return { ok: true, responseJson };
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function proofMethod(request: SessionSyncBackendRequest): "GET" | "POST" {
  switch (request.operation) {
    case "read_membership":
    case "root_key_link_page":
    case "list_enrollment_requests":
    case "snapshot_page":
    case "change_page":
      return "GET";
    case "admit_membership_proposal":
    case "update_membership":
    case "approve_enrollment":
    case "establish_boot":
    case "heartbeat":
    case "reserve_session":
    case "acquire_writer":
    case "publish_session":
    case "delete_session":
    case "begin_snapshot":
      return "POST";
  }
}

async function authorizeSyncContext(
  ctx: ReadCtx,
  proof: SyncDeviceProof,
): Promise<AuthorizedSyncContext | BackendFailure> {
  const human = await authorizeOrganizationHuman(ctx, { requestId: proof.payload.nonce });
  if (!human.ok) return failure("AUTHENTICATION_FAILED");
  const vault = await ctx.db
    .query("syncVaults")
    .withIndex("by_vault_id", (query) => query.eq("vaultId", proof.payload.vaultId))
    .unique();
  if (
    vault === null
    || vault.status !== "active"
    || vault.organizationId !== human.authorization.organization._id
    || vault.ownerUserId !== human.authorization.user._id
    || vault.tenantId !== proof.payload.tenantId
    || vault.organizationCoordinate !== proof.payload.organizationId
    || vault.ownerUserCoordinate !== proof.payload.ownerUserId
    || vault.vaultGeneration !== proof.payload.vaultGeneration
  ) {
    return failure("NOT_FOUND");
  }
  if (vault.membershipEpoch !== proof.payload.membershipEpoch) {
    return failure("STALE_MEMBERSHIP");
  }
  const device = await ctx.db
    .query("syncDevices")
    .withIndex("by_vault_and_device", (query) =>
      query.eq("vaultId", vault._id).eq("deviceId", proof.payload.deviceId),
    )
    .unique();
  if (
    device === null
    || device.status !== "active"
    || device.organizationId !== vault.organizationId
    || device.ownerUserId !== vault.ownerUserId
    || device.membershipEpoch !== vault.membershipEpoch
    || device.signingKeyId !== proof.signingKeyId
  ) {
    return failure("AUTHORIZATION_DENIED");
  }
  return { vault, device };
}

async function authorizeAndConsumeProof(
  ctx: MutationCtx,
  request: SessionSyncBackendRequest,
  proof: SyncDeviceProof,
  verifiedBodyDigest: string,
  now: number,
): Promise<AuthorizedSyncContext | BackendFailure> {
  if (
    proof.payload.bodyDigest !== verifiedBodyDigest
    || proof.payload.route !== routeForSessionSyncRequest(request)
    || proof.payload.method !== proofMethod(request)
  ) {
    return failure("PROOF_INVALID");
  }
  const issuedAt = Number(decodeSyncUint64(proof.payload.issuedAt));
  const expiresAt = Number(decodeSyncUint64(proof.payload.expiresAt));
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || now < issuedAt || now > expiresAt) {
    return failure("PROOF_EXPIRED");
  }
  const context = await authorizeSyncContext(ctx, proof);
  if ("ok" in context) return context;
  const nonceFailure = await consumeDeviceProofNonce(ctx, context, proof, now, "reject");
  if (nonceFailure !== null) return nonceFailure;
  return context;
}

function publicKeys(device: Doc<"syncDevices">) {
  return {
    version: 1 as const,
    signing: {
      keyId: device.signingKeyId,
      algorithm: "P256-SHA256" as const,
      publicKey: device.signingPublicKey,
      publicKeyDigest: device.signingPublicKeyDigest,
    },
    agreement: {
      keyId: device.agreementKeyId,
      algorithm: "P256-ECDH" as const,
      publicKey: device.agreementPublicKey,
      publicKeyDigest: device.agreementPublicKeyDigest,
    },
  };
}

async function consumeEnrollmentPossessionProof(
  ctx: MutationCtx,
  vault: Doc<"syncVaults">,
  request: ReturnType<typeof submitSyncEnrollmentRequestSchema.parse>
    | ReturnType<typeof claimSyncEnrollmentRequestSchema.parse>,
  now: number,
): Promise<BackendFailure | null> {
  const proof = request.possessionProof;
  const issuedAt = Number(decodeSyncUint64(proof.payload.issuedAt));
  const expiresAt = Number(decodeSyncUint64(proof.payload.expiresAt));
  if (
    !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || now < issuedAt
    || now > expiresAt
  ) return failure("PROOF_EXPIRED");
  const existing = await ctx.db
    .query("syncEnrollmentProofNonces")
    .withIndex("by_vault_device_and_nonce", (query) =>
      query
        .eq("vaultId", vault._id)
        .eq("deviceId", request.deviceId)
        .eq("proofNonce", proof.payload.nonce),
    )
    .unique();
  if (existing !== null) {
    return existing.purpose === proof.payload.purpose
      && existing.bodyDigest === proof.payload.bodyDigest
      ? null
      : failure("PROOF_REPLAYED");
  }
  const active = await ctx.db
    .query("syncEnrollmentProofNonces")
    .withIndex("by_vault_device_and_expiry", (query) =>
      query
        .eq("vaultId", vault._id)
        .eq("deviceId", request.deviceId)
        .gt("expiresAt", now),
    )
    .order("asc")
    .take(MAX_ENROLLMENT_PROOF_NONCES_PER_DEVICE);
  if (active.length >= MAX_ENROLLMENT_PROOF_NONCES_PER_DEVICE) {
    return failure(
      "RATE_LIMITED",
      Math.max(1, Math.min(300_000, (active[0]?.expiresAt ?? now + 1) - now)),
    );
  }
  await ctx.db.insert("syncEnrollmentProofNonces", {
    vaultId: vault._id,
    deviceId: request.deviceId,
    proofNonce: proof.payload.nonce,
    purpose: proof.payload.purpose,
    bodyDigest: proof.payload.bodyDigest,
    issuedAt,
    expiresAt,
    consumedAt: now,
  });
  return null;
}

export const readProofContext = internalQuery({
  args: { proofJson: v.string() },
  returns: proofContextResultValidator,
  handler: async (ctx, args) => {
    let proof: SyncDeviceProof;
    try {
      proof = syncDeviceProofSchema.parse(parseJson(args.proofJson));
    } catch {
      return { ok: false as const, code: "PROOF_INVALID" as const };
    }
    const authorized = await authorizeSyncContext(ctx, proof);
    if ("ok" in authorized) return authorized;
    const [head, activeDevices] = await Promise.all([
      ctx.db
        .query("syncMembershipHeads")
        .withIndex("by_vault_and_digest", (query) =>
          query.eq("vaultId", authorized.vault._id).eq("statementDigest", authorized.vault.membershipDigest),
        )
        .unique(),
      ctx.db
        .query("syncDevices")
        .withIndex("by_vault_status_and_device", (query) =>
          query.eq("vaultId", authorized.vault._id).eq("status", "active"),
        )
        .take(MAX_SYNC_DEVICES + 1),
    ]);
    if (head === null || activeDevices.length > MAX_SYNC_DEVICES) {
      return { ok: false as const, code: "CONFLICT" as const };
    }
    return {
      ok: true as const,
      contextJson: canonicalSessionSyncJson({
        activeDevices: activeDevices.map((device) => ({
          deviceId: device.deviceId,
          keys: publicKeys(device),
        })),
        currentDevice: {
          deviceId: authorized.device.deviceId,
          keys: publicKeys(authorized.device),
        },
        membershipHead: parseJson(head.headJson),
        rootKeyEpoch: authorized.vault.rootKeyEpoch,
      }),
    };
  },
});

export const readRecoveryContext = internalQuery({
  args: {
    vaultId: v.string(),
    vaultGeneration: v.string(),
    recoveryNonce: v.string(),
    requestDigest: v.string(),
  },
  returns: recoveryContextResultValidator,
  handler: async (ctx, args) => {
    const human = await authorizeOrganizationHuman(ctx, { requestId: args.recoveryNonce });
    if (!human.ok) return failure("AUTHENTICATION_FAILED");
    const vault = await ctx.db
      .query("syncVaults")
      .withIndex("by_vault_id", (query) => query.eq("vaultId", args.vaultId))
      .unique();
    if (
      vault === null
      || vault.status !== "active"
      || vault.vaultGeneration !== args.vaultGeneration
      || vault.organizationId !== human.authorization.organization._id
      || vault.ownerUserId !== human.authorization.user._id
    ) return failure("NOT_FOUND");
    const transition = await ctx.db
      .query("syncRecoveryTransitions")
      .withIndex("by_vault_and_nonce", (query) =>
        query.eq("vaultId", vault._id).eq("recoveryNonce", args.recoveryNonce),
      )
      .unique();
    if (transition !== null) {
      return transition.requestDigest === args.requestDigest
        ? { ok: true as const, kind: "replay" as const, responseJson: transition.responseJson }
        : failure("CONFLICT");
    }
    const head = await ctx.db
      .query("syncMembershipHeads")
      .withIndex("by_vault_and_digest", (query) =>
        query.eq("vaultId", vault._id).eq("statementDigest", vault.membershipDigest),
      )
      .unique();
    if (head === null) return failure("CONFLICT");
    return {
      ok: true as const,
      kind: "current" as const,
      contextJson: canonicalSessionSyncJson({
        authority: {
          version: 1,
          vault: vaultCoordinates(vault),
          recoveryGeneration: vault.recoveryGeneration,
          keyId: vault.recoveryKeyId,
          algorithm: "P256-SHA256",
          publicKey: vault.recoveryPublicKey,
          publicKeyDigest: vault.recoveryPublicKeyDigest,
          agreementKeyId: vault.recoveryAgreementKeyId,
          agreementAlgorithm: "P256-ECDH",
          agreementPublicKey: vault.recoveryAgreementPublicKey,
          agreementPublicKeyDigest: vault.recoveryAgreementPublicKeyDigest,
        },
        membershipHead: parseJson(head.headJson),
      }),
    };
  },
});

export const bootstrapVaultTransition = internalMutation({
  args: {
    requestJson: v.string(),
    proofJson: v.string(),
    verifiedBodyDigest: v.string(),
  },
  returns: backendResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    let request;
    let proof;
    try {
      request = bootstrapSyncVaultRequestSchema.parse(parseJson(args.requestJson));
      proof = syncDeviceProofSchema.parse(parseJson(args.proofJson));
    } catch {
      return failure("INVALID_REQUEST");
    }
    const human = await authorizeOrganizationHuman(ctx, { requestId: proof.payload.nonce });
    if (!human.ok) return failure("AUTHENTICATION_FAILED");
    const statement = request.membershipHead.statement;
    const member = statement.members[0];
    if (
      member === undefined
      || statement.members.length !== 1
      || member.status !== "active"
      || statement.membershipEpoch !== "1"
      || statement.previousMembershipDigest !== null
      || proof.payload.bodyDigest !== args.verifiedBodyDigest
      || proof.payload.method !== "POST"
      || proof.payload.route !== "sync.membership.update"
      || proof.payload.deviceId !== member.deviceId
      || proof.payload.tenantId !== statement.tenantId
      || proof.payload.organizationId !== statement.organizationId
      || proof.payload.ownerUserId !== statement.ownerUserId
      || proof.payload.vaultId !== statement.vaultId
      || proof.payload.vaultGeneration !== statement.vaultGeneration
      || proof.payload.membershipEpoch !== statement.membershipEpoch
      || proof.signingKeyId !== member.keys.signing.keyId
    ) return failure("PROOF_INVALID");
    const issuedAt = Number(decodeSyncUint64(proof.payload.issuedAt));
    const expiresAt = Number(decodeSyncUint64(proof.payload.expiresAt));
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || now < issuedAt || now > expiresAt) {
      return failure("PROOF_EXPIRED");
    }
    const wrap = request.wrappedRoot;
    const recoveryWrap = request.recoveryRootWrap;
    if (
      wrap.context.tenantId !== statement.tenantId
      || wrap.context.organizationId !== statement.organizationId
      || wrap.context.ownerUserId !== statement.ownerUserId
      || wrap.context.vaultId !== statement.vaultId
      || wrap.context.vaultGeneration !== statement.vaultGeneration
      || wrap.context.membershipEpoch !== statement.membershipEpoch
      || wrap.context.recipientDeviceId !== member.deviceId
      || wrap.context.recipientAgreementKeyId !== member.keys.agreement.keyId
      || statement.rootKeyEpoch !== wrap.context.rootKeyEpoch
      || canonicalSessionSyncJson(recoveryWrap.context.vault)
        !== canonicalSessionSyncJson({
          tenantId: statement.tenantId,
          organizationId: statement.organizationId,
          ownerUserId: statement.ownerUserId,
          vaultId: statement.vaultId,
          vaultGeneration: statement.vaultGeneration,
        })
      || recoveryWrap.context.membershipEpoch !== statement.membershipEpoch
      || recoveryWrap.context.recoveryGeneration !== statement.recoveryGeneration
      || recoveryWrap.context.rootKeyEpoch !== statement.rootKeyEpoch
      || recoveryWrap.context.rootKeyCommitment !== statement.rootKeyCommitment
      || recoveryWrap.context.recipientRecoveryAgreementKeyId
        !== request.recoveryAuthority.agreementKeyId
      || statement.rootKeyLinkDigest !== null
      || request.recoveryAuthority.recoveryGeneration !== statement.recoveryGeneration
      || canonicalSessionSyncJson(request.recoveryAuthority.vault)
        !== canonicalSessionSyncJson({
          tenantId: statement.tenantId,
          organizationId: statement.organizationId,
          ownerUserId: statement.ownerUserId,
          vaultId: statement.vaultId,
          vaultGeneration: statement.vaultGeneration,
        })
      || request.recoveryAuthority.keyId === member.keys.signing.keyId
      || request.recoveryAuthority.keyId === member.keys.agreement.keyId
      || request.recoveryAuthority.publicKeyDigest === member.keys.signing.publicKeyDigest
      || request.recoveryAuthority.publicKeyDigest === member.keys.agreement.publicKeyDigest
      || request.recoveryAuthority.agreementKeyId === member.keys.signing.keyId
      || request.recoveryAuthority.agreementKeyId === member.keys.agreement.keyId
      || request.recoveryAuthority.agreementPublicKeyDigest
        === member.keys.signing.publicKeyDigest
      || request.recoveryAuthority.agreementPublicKeyDigest
        === member.keys.agreement.publicKeyDigest
    ) return failure("CONFLICT");
    const [sameId, existingHumanVault] = await Promise.all([
      ctx.db.query("syncVaults").withIndex("by_vault_id", (query) => query.eq("vaultId", statement.vaultId)).unique(),
      ctx.db.query("syncVaults").withIndex("by_human_and_status", (query) =>
        query
          .eq("ownerUserId", human.authorization.user._id)
          .eq("organizationId", human.authorization.organization._id)
          .eq("status", "active"),
      ).unique(),
    ]);
    if (
      sameId !== null
      && (sameId.organizationId !== human.authorization.organization._id
        || sameId.ownerUserId !== human.authorization.user._id)
    ) return failure("NOT_FOUND");
    if (sameId !== null) {
      const [head, storedRecoveryWrap, device] = await Promise.all([
        ctx.db
          .query("syncMembershipHeads")
          .withIndex("by_vault_and_digest", (query) =>
            query.eq("vaultId", sameId._id).eq("statementDigest", request.membershipHead.statementDigest),
          )
          .unique(),
        ctx.db
          .query("syncRecoveryRootWraps")
          .withIndex("by_vault_and_membership", (query) =>
            query.eq("vaultId", sameId._id).eq("membershipEpoch", sameId.membershipEpoch),
          )
          .unique(),
        ctx.db
          .query("syncDevices")
          .withIndex("by_vault_and_device", (query) =>
            query.eq("vaultId", sameId._id).eq("deviceId", member.deviceId),
          )
          .unique(),
      ]);
      if (head === null || device === null) return failure("CONFLICT");
      const wraps = await ctx.db
        .query("syncVaultRootWraps")
        .withIndex("by_vault_device_and_epoch", (query) =>
          query.eq("vaultId", sameId._id).eq("deviceId", device._id),
        )
        .take(2);
      if (
        sameId.status !== "active"
        || sameId.tenantId !== statement.tenantId
        || sameId.organizationCoordinate !== statement.organizationId
        || sameId.ownerUserCoordinate !== statement.ownerUserId
        || sameId.vaultGeneration !== statement.vaultGeneration
        || sameId.membershipEpoch !== statement.membershipEpoch
        || sameId.membershipDigest !== request.membershipHead.statementDigest
        || sameId.recoveryGeneration !== request.recoveryAuthority.recoveryGeneration
        || sameId.recoveryKeyId !== request.recoveryAuthority.keyId
        || sameId.recoveryPublicKey !== request.recoveryAuthority.publicKey
        || sameId.recoveryPublicKeyDigest !== request.recoveryAuthority.publicKeyDigest
        || sameId.recoveryAgreementKeyId !== request.recoveryAuthority.agreementKeyId
        || sameId.recoveryAgreementPublicKey !== request.recoveryAuthority.agreementPublicKey
        || sameId.recoveryAgreementPublicKeyDigest
          !== request.recoveryAuthority.agreementPublicKeyDigest
        || sameId.rootKeyEpoch !== wrap.context.rootKeyEpoch
        || sameId.rootKeyCommitment !== statement.rootKeyCommitment
        || sameId.activeDeviceCount !== 1
        || head.requestDigest !== args.verifiedBodyDigest
        || head.headJson !== canonicalSessionSyncJson(request.membershipHead)
        || device.name !== member.name
        || device.status !== "active"
        || device.membershipEpoch !== statement.membershipEpoch
        || !sameDeviceKeys(device, member.keys)
        || wraps.length !== 1
        || wraps[0]?.wrappedRootJson !== canonicalSessionSyncJson(wrap)
        || storedRecoveryWrap === null
        || storedRecoveryWrap.wrapDigest !== statement.recoveryRootWrapDigest
        || storedRecoveryWrap.wrapJson !== canonicalSessionSyncJson(recoveryWrap)
      ) return failure("CONFLICT");
      const replayRateFailure = await consumeSessionSyncRateLimit(ctx, "registration", [
        {
          kind: "human",
          key: `${human.authorization.user._id}\u0000${human.authorization.organization._id}`,
        },
        { kind: "vault", key: sameId._id },
      ], now);
      if (replayRateFailure !== null) return replayRateFailure;
      const nonceFailure = await consumeDeviceProofNonce(
        ctx,
        { vault: sameId, device },
        proof,
        now,
        "allow",
      );
      if (nonceFailure !== null) return nonceFailure;
      return success({
        kind: "vault_created",
        vault: vaultCoordinates(sameId),
        membershipEpoch: statement.membershipEpoch,
        rootKeyEpoch: wrap.context.rootKeyEpoch,
        vaultId: statement.vaultId,
      });
    }
    if (existingHumanVault !== null) return failure("CONFLICT");
    const rateFailure = await consumeSessionSyncRateLimit(ctx, "registration", [{
      kind: "human",
      key: `${human.authorization.user._id}\u0000${human.authorization.organization._id}`,
    }], now);
    if (rateFailure !== null) return rateFailure;
    const vaultId = await ctx.db.insert("syncVaults", {
      tenantId: statement.tenantId,
      organizationCoordinate: statement.organizationId,
      ownerUserCoordinate: statement.ownerUserId,
      organizationId: human.authorization.organization._id,
      ownerUserId: human.authorization.user._id,
      vaultId: statement.vaultId,
      vaultGeneration: statement.vaultGeneration,
      status: "active",
      membershipEpoch: statement.membershipEpoch,
      membershipDigest: request.membershipHead.statementDigest,
      recoveryGeneration: statement.recoveryGeneration,
      recoveryKeyId: request.recoveryAuthority.keyId,
      recoveryPublicKey: request.recoveryAuthority.publicKey,
      recoveryPublicKeyDigest: request.recoveryAuthority.publicKeyDigest,
      recoveryAgreementKeyId: request.recoveryAuthority.agreementKeyId,
      recoveryAgreementPublicKey: request.recoveryAuthority.agreementPublicKey,
      recoveryAgreementPublicKeyDigest: request.recoveryAuthority.agreementPublicKeyDigest,
      rootKeyEpoch: wrap.context.rootKeyEpoch,
      rootKeyCommitment: statement.rootKeyCommitment,
      retainedRootKeyEpochs: [wrap.context.rootKeyEpoch],
      wrappedRootKeyEpochs: [wrap.context.rootKeyEpoch],
      directoryVersion: "0",
      directoryVersionOrderKey: syncUint64OrderKey("0"),
      changeFloorVersion: "0",
      nextDirectoryOrdinal: "0",
      activeDeviceCount: 1,
      directorySessionCount: 0,
      activeStreamCount: 0,
      retainedEventCount: 0,
      retainedCiphertextBytes: 96,
      compatibilityEvidenceCiphertextBytes: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("syncMembershipHeads", {
      vaultId,
      organizationId: human.authorization.organization._id,
      ownerUserId: human.authorization.user._id,
      membershipEpoch: statement.membershipEpoch,
      statementDigest: request.membershipHead.statementDigest,
      requestDigest: args.verifiedBodyDigest,
      headJson: canonicalSessionSyncJson(request.membershipHead),
      acceptedAt: now,
    });
    const deviceId = await ctx.db.insert("syncDevices", {
      vaultId,
      organizationId: human.authorization.organization._id,
      ownerUserId: human.authorization.user._id,
      deviceId: member.deviceId,
      name: member.name,
      status: "active",
      signingKeyId: member.keys.signing.keyId,
      signingPublicKey: member.keys.signing.publicKey,
      signingPublicKeyDigest: member.keys.signing.publicKeyDigest,
      agreementKeyId: member.keys.agreement.keyId,
      agreementPublicKey: member.keys.agreement.publicKey,
      agreementPublicKeyDigest: member.keys.agreement.publicKeyDigest,
      membershipEpoch: statement.membershipEpoch,
      approvedAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("syncVaultRootWraps", {
      vaultId,
      deviceId,
      recipientDeviceId: member.deviceId,
      membershipEpoch: statement.membershipEpoch,
      rootKeyEpoch: wrap.context.rootKeyEpoch,
      wrappedRootJson: canonicalSessionSyncJson(wrap),
      ciphertextBytes: 48,
      createdAt: now,
    });
    await ctx.db.insert("syncRecoveryRootWraps", {
      vaultId,
      membershipEpoch: statement.membershipEpoch,
      rootKeyEpoch: statement.rootKeyEpoch,
      recoveryGeneration: statement.recoveryGeneration,
      wrapDigest: statement.recoveryRootWrapDigest,
      wrapJson: canonicalSessionSyncJson(recoveryWrap),
      ciphertextBytes: 48,
      createdAt: now,
    });
    await ctx.db.insert("syncProofNonces", {
      vaultId,
      deviceId,
      proofNonce: proof.payload.nonce,
      route: proof.payload.route,
      method: proof.payload.method,
      bodyDigest: proof.payload.bodyDigest,
      issuedAt,
      expiresAt,
      consumedAt: now,
    });
    return success({
      kind: "vault_created",
      vault: {
        tenantId: statement.tenantId,
        organizationId: statement.organizationId,
        ownerUserId: statement.ownerUserId,
        vaultId: statement.vaultId,
        vaultGeneration: statement.vaultGeneration,
      },
      membershipEpoch: statement.membershipEpoch,
      rootKeyEpoch: wrap.context.rootKeyEpoch,
      vaultId: statement.vaultId,
    });
  },
});

export const recoverVaultTransition = internalMutation({
  args: { requestJson: v.string(), requestDigest: v.string() },
  returns: backendResultValidator,
  handler: async (ctx, args) => {
    let request: RecoverSyncVaultRequest;
    try {
      request = recoverSyncVaultRequestSchema.parse(parseJson(args.requestJson));
    } catch {
      return failure("INVALID_REQUEST");
    }
    const now = Date.now();
    const statement = request.authorization.statement;
    const human = await authorizeOrganizationHuman(ctx, { requestId: statement.recoveryNonce });
    if (!human.ok) return failure("AUTHENTICATION_FAILED");
    const vault = await ctx.db
      .query("syncVaults")
      .withIndex("by_vault_id", (query) => query.eq("vaultId", statement.vault.vaultId))
      .unique();
    if (
      vault === null
      || vault.status !== "active"
      || vault.vaultGeneration !== statement.vault.vaultGeneration
      || vault.organizationId !== human.authorization.organization._id
      || vault.ownerUserId !== human.authorization.user._id
      || vault.tenantId !== statement.vault.tenantId
      || vault.organizationCoordinate !== statement.vault.organizationId
      || vault.ownerUserCoordinate !== statement.vault.ownerUserId
    ) return failure("NOT_FOUND");
    const priorTransition = await ctx.db
      .query("syncRecoveryTransitions")
      .withIndex("by_vault_and_nonce", (query) =>
        query.eq("vaultId", vault._id).eq("recoveryNonce", statement.recoveryNonce),
      )
      .unique();
    if (priorTransition !== null) {
      if (priorTransition.requestDigest !== args.requestDigest) return failure("CONFLICT");
      const replay = sessionSyncBackendResponseSchema.parse(parseJson(priorTransition.responseJson));
      if (replay.kind !== "vault_recovered") return failure("CONFLICT");
      return success({ ...replay, replay: true });
    }
    const issuedAt = Number(decodeSyncUint64(statement.issuedAt));
    const expiresAt = Number(decodeSyncUint64(statement.expiresAt));
    if (
      !Number.isSafeInteger(issuedAt)
      || !Number.isSafeInteger(expiresAt)
      || now < issuedAt
      || now > expiresAt
    ) return failure("PROOF_EXPIRED");
    if (
      statement.currentMembershipEpoch !== vault.membershipEpoch
      || statement.currentMembershipDigest !== vault.membershipDigest
      || statement.currentRecoveryGeneration !== vault.recoveryGeneration
      || statement.currentRootKeyEpoch !== vault.rootKeyEpoch
      || statement.currentRootKeyCommitment !== vault.rootKeyCommitment
      || request.authorization.signingKeyId !== vault.recoveryKeyId
      || request.membershipHead.statement.membershipEpoch !== nextRequiredSyncUint64(vault.membershipEpoch)
      || request.membershipHead.statement.recoveryGeneration
        !== statement.nextRecoveryAuthority.recoveryGeneration
      || statement.replacementRootKeyEpoch !== nextRequiredSyncUint64(vault.rootKeyEpoch)
    ) return failure("STALE_MEMBERSHIP");
    if (
      decodeSyncUint64(vault.membershipEpoch) >= BigInt(MAX_SYNC_LIFETIME_MEMBERSHIP_EPOCHS)
      || decodeSyncUint64(vault.rootKeyEpoch) >= BigInt(MAX_SYNC_LIFETIME_ROOT_KEY_EPOCHS)
    ) return failure("MAINTENANCE_REQUIRED");
    const recoveryRootWrap = request.recoveryRootWrap;
    if (
      canonicalSessionSyncJson(recoveryRootWrap.context.vault)
        !== canonicalSessionSyncJson(vaultCoordinates(vault))
      || recoveryRootWrap.context.membershipEpoch !== statement.replacementMembershipEpoch
      || recoveryRootWrap.context.recoveryGeneration
        !== statement.nextRecoveryAuthority.recoveryGeneration
      || recoveryRootWrap.context.rootKeyEpoch !== statement.replacementRootKeyEpoch
      || recoveryRootWrap.context.rootKeyCommitment !== statement.replacementRootKeyCommitment
      || recoveryRootWrap.context.recipientRecoveryAgreementKeyId
        !== statement.nextRecoveryAuthority.agreementKeyId
    ) return failure("CONFLICT");
    const rateFailure = await consumeSessionSyncRateLimit(ctx, "registration", [
      {
        kind: "human",
        key: `${human.authorization.user._id}\u0000${human.authorization.organization._id}`,
      },
      { kind: "vault", key: vault._id },
    ], now);
    if (rateFailure !== null) return rateFailure;
    const retainedRootKeyEpochs = await retainedRootEpochsForTransition(
      ctx,
      vault,
      statement.replacementRootKeyEpoch,
    );
    if (retainedRootKeyEpochs === null) return failure("KEY_EPOCH_LIMIT");
    const requestedEpochs = request.wrappedRoots.map((wrap) => wrap.context.rootKeyEpoch);
    const signedWrapsByEpoch = new Map(
      statement.replacementRootWraps.map((wrap) => [wrap.keyEpoch, wrap]),
    );
    const replacement = statement.replacementDevice;
    if (
      requestedEpochs.length !== retainedRootKeyEpochs.length
      || signedWrapsByEpoch.size !== retainedRootKeyEpochs.length
      || requestedEpochs.some((epoch, index) => epoch !== retainedRootKeyEpochs[index])
      || request.wrappedRoots.some((wrap) => {
        const signed = signedWrapsByEpoch.get(wrap.context.rootKeyEpoch);
        return signed === undefined
          || signed.ciphertextDigest !== wrap.ciphertextDigest
          || wrap.context.tenantId !== vault.tenantId
          || wrap.context.organizationId !== vault.organizationCoordinate
          || wrap.context.ownerUserId !== vault.ownerUserCoordinate
          || wrap.context.vaultId !== vault.vaultId
          || wrap.context.vaultGeneration !== vault.vaultGeneration
          || wrap.context.membershipEpoch !== statement.replacementMembershipEpoch
          || wrap.context.recipientDeviceId !== replacement.deviceId
          || wrap.context.recipientAgreementKeyId !== replacement.keys.agreement.keyId;
      })
      || statement.replacementRootWrapManifestDigest
        !== await digestSyncVaultRootWrapManifest(request.wrappedRoots)
    ) return failure("CONFLICT");
    const existingReplacement = await ctx.db
      .query("syncDevices")
      .withIndex("by_vault_and_device", (query) =>
        query.eq("vaultId", vault._id).eq("deviceId", statement.replacementDevice.deviceId),
      )
      .unique();
    if (existingReplacement !== null) return failure("RETIRED");
    const activeDevices = await ctx.db
      .query("syncDevices")
      .withIndex("by_vault_status_and_device", (query) =>
        query.eq("vaultId", vault._id).eq("status", "active"),
      )
      .take(MAX_SYNC_DEVICES + 1);
    if (activeDevices.length > MAX_SYNC_DEVICES) return failure("CONFLICT");
    const currentKeyMaterial = await loadCurrentKeyMaterial(ctx, vault);
    if (currentKeyMaterial === null) return failure("CONFLICT");
    const compatibilityEvidenceCiphertextBytes =
      vault.compatibilityEvidenceCiphertextBytes + currentKeyMaterial.ciphertextBytes;
    if (compatibilityEvidenceCiphertextBytes > MAX_SYNC_RETAINED_CIPHERTEXT_BYTES) {
      return failure("MAINTENANCE_REQUIRED");
    }
    const retainedCiphertextBytes = vault.retainedCiphertextBytes
      - currentKeyMaterial.ciphertextBytes
      + request.wrappedRoots.length * 48
      + 96;
    if (
      retainedCiphertextBytes < 0
      || retainedCiphertextBytes + compatibilityEvidenceCiphertextBytes
        > MAX_SYNC_RETAINED_CIPHERTEXT_BYTES
    ) return failure("QUOTA_EXCEEDED");
    const existingLink = await ctx.db
      .query("syncVaultRootKeyLinks")
      .withIndex("by_vault_and_child_epoch", (query) =>
        query
          .eq("vaultId", vault._id)
          .eq(
            "childRootKeyEpochOrderKey",
            syncUint64OrderKey(statement.rootKeyLink.context.childRootKeyEpoch),
          ),
      )
      .unique();
    if (existingLink !== null) return failure("CONFLICT");
    const recoveryWrapCollision = await ctx.db
      .query("syncRecoveryRootWraps")
      .withIndex("by_vault_and_membership", (query) =>
        query
          .eq("vaultId", vault._id)
          .eq("membershipEpoch", statement.replacementMembershipEpoch),
      )
      .unique();
    if (recoveryWrapCollision !== null) return failure("CONFLICT");
    const supersededProposal = await ctx.db
      .query("syncMembershipProposals")
      .withIndex("by_vault_parent_and_state", (query) =>
        query
          .eq("vaultId", vault._id)
          .eq("parentMembershipEpoch", vault.membershipEpoch)
          .eq("state", "pending"),
      )
      .unique();
    if (supersededProposal !== null) {
      // Recovery is the only authority allowed to retire an unresolved signed
      // child. Keep the proposal and votes as immutable equivocation evidence.
      await ctx.db.patch(supersededProposal._id, { state: "expired", updatedAt: now });
      if (supersededProposal.enrollmentRequestId !== undefined) {
        const enrollment = await ctx.db
          .query("syncEnrollmentRequests")
          .withIndex("by_request_id", (query) =>
            query.eq("requestId", supersededProposal.enrollmentRequestId!),
          )
          .unique();
        if (enrollment !== null && enrollment.state === "pending") {
          await ctx.db.patch(enrollment._id, {
            state: "expired",
            purgeAfter: now + SESSION_SYNC_ENROLLMENT_RETENTION_MS,
            updatedAt: now,
          });
        }
      }
    }
    await archiveCurrentKeyMaterial(ctx, currentKeyMaterial, now);
    const forcedOffline = await forceOfflineRevokedOrigins(ctx, vault, activeDevices, now);
    for (const device of activeDevices) {
      await ctx.db.patch(device._id, {
        status: "revoked",
        membershipEpoch: statement.replacementMembershipEpoch,
        revokedAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.insert("syncVaultRootKeyLinks", {
      vaultId: vault._id,
      membershipEpoch: statement.replacementMembershipEpoch,
      parentRootKeyEpoch: statement.rootKeyLink.context.parentRootKeyEpoch,
      parentRootKeyEpochOrderKey: syncUint64OrderKey(
        statement.rootKeyLink.context.parentRootKeyEpoch,
      ),
      childRootKeyEpoch: statement.rootKeyLink.context.childRootKeyEpoch,
      childRootKeyEpochOrderKey: syncUint64OrderKey(
        statement.rootKeyLink.context.childRootKeyEpoch,
      ),
      linkDigest: statement.rootKeyLink.linkDigest,
      linkJson: canonicalSessionSyncJson(statement.rootKeyLink),
      ciphertextBytes: 48,
      createdAt: now,
    });
    await ctx.db.insert("syncRecoveryRootWraps", {
      vaultId: vault._id,
      membershipEpoch: statement.replacementMembershipEpoch,
      rootKeyEpoch: statement.replacementRootKeyEpoch,
      recoveryGeneration: statement.nextRecoveryAuthority.recoveryGeneration,
      wrapDigest: statement.replacementRecoveryRootWrapDigest,
      wrapJson: canonicalSessionSyncJson(recoveryRootWrap),
      ciphertextBytes: 48,
      createdAt: now,
    });
    await ctx.db.insert("syncMembershipHeads", {
      vaultId: vault._id,
      organizationId: vault.organizationId,
      ownerUserId: vault.ownerUserId,
      membershipEpoch: statement.replacementMembershipEpoch,
      previousMembershipDigest: vault.membershipDigest,
      statementDigest: statement.replacementMembershipDigest,
      requestDigest: args.requestDigest,
      headJson: canonicalSessionSyncJson(request.membershipHead),
      acceptedAt: now,
    });
    const replacementDeviceId = await ctx.db.insert("syncDevices", {
      vaultId: vault._id,
      organizationId: vault.organizationId,
      ownerUserId: vault.ownerUserId,
      deviceId: replacement.deviceId,
      name: replacement.name,
      status: "active",
      signingKeyId: replacement.keys.signing.keyId,
      signingPublicKey: replacement.keys.signing.publicKey,
      signingPublicKeyDigest: replacement.keys.signing.publicKeyDigest,
      agreementKeyId: replacement.keys.agreement.keyId,
      agreementPublicKey: replacement.keys.agreement.publicKey,
      agreementPublicKeyDigest: replacement.keys.agreement.publicKeyDigest,
      membershipEpoch: statement.replacementMembershipEpoch,
      approvedAt: now,
      updatedAt: now,
    });
    for (const wrap of request.wrappedRoots) {
      await ctx.db.insert("syncVaultRootWraps", {
        vaultId: vault._id,
        deviceId: replacementDeviceId,
        recipientDeviceId: replacement.deviceId,
        membershipEpoch: statement.replacementMembershipEpoch,
        rootKeyEpoch: wrap.context.rootKeyEpoch,
        wrappedRootJson: canonicalSessionSyncJson(wrap),
        ciphertextBytes: 48,
        createdAt: now,
      });
    }
    const receipt = syncRecoveryReceiptSchema.parse({
      version: 1,
      requestDigest: args.requestDigest,
      authorization: request.authorization,
      acceptedMembershipDigest: statement.replacementMembershipDigest,
      acceptedAt: encodeSyncUint64(BigInt(now)),
    });
    const response = sessionSyncBackendResponseSchema.parse({
      kind: "vault_recovered",
      vault: vaultCoordinates(vault),
      membershipEpoch: statement.replacementMembershipEpoch,
      recoveryGeneration: statement.nextRecoveryAuthority.recoveryGeneration,
      rootKeyEpoch: statement.replacementRootKeyEpoch,
      receipt,
      replay: false,
    });
    await ctx.db.insert("syncRecoveryTransitions", {
      vaultId: vault._id,
      organizationId: vault.organizationId,
      ownerUserId: vault.ownerUserId,
      recoveryNonce: statement.recoveryNonce,
      requestDigest: args.requestDigest,
      priorMembershipDigest: vault.membershipDigest,
      priorRecoveryGeneration: vault.recoveryGeneration,
      acceptedMembershipDigest: statement.replacementMembershipDigest,
      responseJson: canonicalSessionSyncJson(response),
      acceptedAt: now,
    });
    await ctx.db.patch(vault._id, {
      membershipEpoch: statement.replacementMembershipEpoch,
      membershipDigest: statement.replacementMembershipDigest,
      recoveryGeneration: statement.nextRecoveryAuthority.recoveryGeneration,
      recoveryKeyId: statement.nextRecoveryAuthority.keyId,
      recoveryPublicKey: statement.nextRecoveryAuthority.publicKey,
      recoveryPublicKeyDigest: statement.nextRecoveryAuthority.publicKeyDigest,
      recoveryAgreementKeyId: statement.nextRecoveryAuthority.agreementKeyId,
      recoveryAgreementPublicKey: statement.nextRecoveryAuthority.agreementPublicKey,
      recoveryAgreementPublicKeyDigest:
        statement.nextRecoveryAuthority.agreementPublicKeyDigest,
      rootKeyEpoch: statement.replacementRootKeyEpoch,
      rootKeyCommitment: statement.replacementRootKeyCommitment,
      retainedRootKeyEpochs,
      wrappedRootKeyEpochs: retainedRootKeyEpochs,
      activeDeviceCount: 1,
      activeStreamCount: forcedOffline.activeStreamCount,
      directoryVersion: forcedOffline.directoryVersion,
      directoryVersionOrderKey: syncUint64OrderKey(forcedOffline.directoryVersion),
      retainedCiphertextBytes,
      compatibilityEvidenceCiphertextBytes,
      updatedAt: now,
    });
    return success(response);
  },
});

async function humanVault(
  ctx: ReadCtx,
  requestId: string,
  vaultPublicId: string,
  vaultGeneration: string,
) {
  const human = await authorizeOrganizationHuman(ctx, { requestId });
  if (!human.ok) return failure("AUTHENTICATION_FAILED");
  const vault = await ctx.db
    .query("syncVaults")
    .withIndex("by_vault_id", (query) => query.eq("vaultId", vaultPublicId))
    .unique();
  if (
    vault === null
    || vault.status !== "active"
    || vault.vaultGeneration !== vaultGeneration
    || vault.organizationId !== human.authorization.organization._id
    || vault.ownerUserId !== human.authorization.user._id
  ) return failure("NOT_FOUND");
  return vault;
}

export const readEnrollmentPairingContext = internalQuery({
  args: {
    requestId: v.string(),
    vaultId: v.string(),
    vaultGeneration: v.string(),
  },
  returns: proofContextResultValidator,
  handler: async (ctx, args) => {
    const vault = await humanVault(ctx, args.requestId, args.vaultId, args.vaultGeneration);
    if ("ok" in vault) return vault;
    const expiresAt = Date.now() + SESSION_SYNC_ENROLLMENT_TTL_MS;
    return {
      ok: true as const,
      contextJson: canonicalSessionSyncJson({
        currentMembershipDigest: vault.membershipDigest,
        expiresAt: encodeSyncUint64(BigInt(expiresAt)),
      }),
    };
  },
});

export const readRecoveryPreparationTransition = internalMutation({
  args: { requestJson: v.string(), requestId: v.string() },
  returns: backendResultValidator,
  handler: async (ctx, args) => {
    let request;
    try {
      request = readSyncRecoveryContextRequestSchema.parse(parseJson(args.requestJson));
    } catch {
      return failure("INVALID_REQUEST");
    }
    const human = await authorizeOrganizationHuman(ctx, { requestId: args.requestId });
    if (!human.ok) return failure("AUTHENTICATION_FAILED");
    const vault = await ctx.db
      .query("syncVaults")
      .withIndex("by_vault_id", (query) => query.eq("vaultId", request.vault.vaultId))
      .unique();
    if (
      vault === null
      || vault.status !== "active"
      || vault.vaultGeneration !== request.vault.vaultGeneration
      || vault.tenantId !== request.vault.tenantId
      || vault.organizationCoordinate !== request.vault.organizationId
      || vault.ownerUserCoordinate !== request.vault.ownerUserId
      || vault.organizationId !== human.authorization.organization._id
      || vault.ownerUserId !== human.authorization.user._id
    ) return failure("NOT_FOUND");
    const now = Date.now();
    const rateFailure = await consumeSessionSyncRateLimit(ctx, "registration", [
      {
        kind: "human",
        key: `${human.authorization.user._id}\u0000${human.authorization.organization._id}`,
      },
      { kind: "vault", key: vault._id },
    ], now);
    if (rateFailure !== null) return rateFailure;
    const [headRow, recoveryWrapRow] = await Promise.all([
      ctx.db
        .query("syncMembershipHeads")
        .withIndex("by_vault_and_digest", (query) =>
          query.eq("vaultId", vault._id).eq("statementDigest", vault.membershipDigest),
        )
        .unique(),
      ctx.db
        .query("syncRecoveryRootWraps")
        .withIndex("by_vault_and_membership", (query) =>
          query.eq("vaultId", vault._id).eq("membershipEpoch", vault.membershipEpoch),
        )
        .unique(),
    ]);
    if (headRow === null || recoveryWrapRow === null) return failure("CONFLICT");
    const membershipHead = syncMembershipHeadSchema.parse(parseJson(headRow.headJson));
    const recoveryRootWrap = wrappedSyncRecoveryVaultRootKeySchema.parse(
      parseJson(recoveryWrapRow.wrapJson),
    );
    if (
      membershipHead.statement.recoveryRootWrapDigest !== recoveryWrapRow.wrapDigest
      || recoveryRootWrap.context.membershipEpoch !== vault.membershipEpoch
      || recoveryRootWrap.context.rootKeyEpoch !== vault.rootKeyEpoch
      || recoveryRootWrap.context.rootKeyCommitment !== vault.rootKeyCommitment
      || recoveryRootWrap.context.recoveryGeneration !== vault.recoveryGeneration
      || recoveryRootWrap.context.recipientRecoveryAgreementKeyId
        !== vault.recoveryAgreementKeyId
    ) return failure("CONFLICT");
    return success({
      kind: "recovery_context",
      vault: vaultCoordinates(vault),
      authority: {
        version: 1,
        vault: vaultCoordinates(vault),
        recoveryGeneration: vault.recoveryGeneration,
        keyId: vault.recoveryKeyId,
        algorithm: "P256-SHA256",
        publicKey: vault.recoveryPublicKey,
        publicKeyDigest: vault.recoveryPublicKeyDigest,
        agreementKeyId: vault.recoveryAgreementKeyId,
        agreementAlgorithm: "P256-ECDH",
        agreementPublicKey: vault.recoveryAgreementPublicKey,
        agreementPublicKeyDigest: vault.recoveryAgreementPublicKeyDigest,
      },
      membershipHead,
      recoveryRootWrap,
    });
  },
});

export const submitEnrollmentTransition = internalMutation({
  args: {
    requestJson: v.string(),
    requestDigest: v.string(),
    requestId: v.string(),
    pairingDigest: v.string(),
    pairingCode: v.string(),
    pairingTranscriptJson: v.string(),
  },
  returns: backendResultValidator,
  handler: async (ctx, args) => {
    let request;
    try {
      request = submitSyncEnrollmentRequestSchema.parse(parseJson(args.requestJson));
    } catch {
      return failure("INVALID_REQUEST");
    }
    if (request.possessionProof.payload.bodyDigest !== args.requestDigest) {
      return failure("PROOF_INVALID");
    }
    const now = Date.now();
    const vault = await humanVault(
      ctx,
      args.requestId,
      request.vaultId,
      request.vaultGeneration,
    );
    if ("ok" in vault) return vault;
    let pairingTranscript;
    try {
      pairingTranscript = syncEnrollmentPairingTranscriptSchema.parse(
        parseJson(args.pairingTranscriptJson),
      );
    } catch {
      return failure("INVALID_REQUEST");
    }
    const pairingExpiresAt = Number(decodeSyncUint64(pairingTranscript.expiresAt));
    if (
      pairingTranscript.vaultId !== request.vaultId
      || pairingTranscript.vaultGeneration !== request.vaultGeneration
      || pairingTranscript.requestId !== args.requestId
      || pairingTranscript.deviceId !== request.deviceId
      || pairingTranscript.candidateNonce !== request.possessionProof.payload.nonce
      || pairingTranscript.candidateIntentDigest !== args.requestDigest
      || pairingTranscript.currentMembershipDigest !== vault.membershipDigest
      || pairingTranscript.candidateSigningKeyDigest !== request.keys.signing.publicKeyDigest
      || pairingTranscript.candidateAgreementKeyDigest !== request.keys.agreement.publicKeyDigest
      || !Number.isSafeInteger(pairingExpiresAt)
      || pairingExpiresAt <= now
      || pairingExpiresAt > now + SESSION_SYNC_ENROLLMENT_TTL_MS
    ) return failure("CONFLICT");
    const existingDevice = await ctx.db
      .query("syncDevices")
      .withIndex("by_vault_and_device", (query) =>
        query.eq("vaultId", vault._id).eq("deviceId", request.deviceId),
      )
      .unique();
    if (existingDevice !== null) {
      return failure(existingDevice.status === "revoked" ? "RETIRED" : "CONFLICT");
    }
    const proofFailure = await consumeEnrollmentPossessionProof(ctx, vault, request, now);
    if (proofFailure !== null) return proofFailure;
    const existingPending = await ctx.db
      .query("syncEnrollmentRequests")
      .withIndex("by_vault_device_and_state", (query) =>
        query.eq("vaultId", vault._id).eq("deviceId", request.deviceId).eq("state", "pending"),
      )
      .unique();
    if (existingPending !== null && existingPending.expiresAt > now) {
      if (existingPending.requestDigest !== args.requestDigest) return failure("CONFLICT");
      return success({
        kind: "enrollment_submitted",
        vault: vaultCoordinates(vault),
        requestId: existingPending.requestId,
        deviceId: existingPending.deviceId,
        expiresAt: encodeSyncUint64(BigInt(existingPending.expiresAt)),
        pairingDigest: existingPending.pairingDigest,
        pairingCode: existingPending.pairingCode,
        pairingTranscript: syncEnrollmentPairingTranscriptSchema.parse(
          parseJson(existingPending.pairingTranscriptJson),
        ),
        replay: true,
      });
    }
    const rateFailure = await consumeSessionSyncRateLimit(ctx, "registration", [
      { kind: "human", key: `${vault.ownerUserId}\u0000${vault.organizationId}` },
      { kind: "vault", key: vault._id },
    ], now);
    if (rateFailure !== null) return rateFailure;
    if (existingPending !== null) {
      await ctx.db.patch(existingPending._id, { state: "expired", updatedAt: now });
    }
    const requestIdCollision = await ctx.db
      .query("syncEnrollmentRequests")
      .withIndex("by_request_id", (query) => query.eq("requestId", args.requestId))
      .unique();
    if (requestIdCollision !== null) return failure("CONFLICT");
    const pending = await ctx.db
      .query("syncEnrollmentRequests")
      .withIndex("by_vault_state_and_expiry", (query) =>
        query.eq("vaultId", vault._id).eq("state", "pending").gt("expiresAt", now),
      )
      .take(MAX_SESSION_SYNC_PENDING_ENROLLMENTS + 1);
    const enrollmentQuota = enrollmentQuotaFailure(pending.length, vault.activeDeviceCount);
    if (enrollmentQuota !== null) return failure(enrollmentQuota);
    const expiresAt = pairingExpiresAt;
    await ctx.db.insert("syncEnrollmentRequests", {
      vaultId: vault._id,
      organizationId: vault.organizationId,
      ownerUserId: vault.ownerUserId,
      requestId: args.requestId,
      requestDigest: args.requestDigest,
      deviceId: request.deviceId,
      name: request.name,
      keysJson: canonicalSessionSyncJson(request.keys),
      pairingDigest: args.pairingDigest,
      pairingCode: args.pairingCode,
      pairingTranscriptJson: canonicalSessionSyncJson(pairingTranscript),
      state: "pending",
      requestedMembershipEpoch: vault.membershipEpoch,
      expiresAt,
      purgeAfter: expiresAt + SESSION_SYNC_ENROLLMENT_RETENTION_MS,
      createdAt: now,
      updatedAt: now,
    });
    return success({
      kind: "enrollment_submitted",
      vault: vaultCoordinates(vault),
      requestId: args.requestId,
      deviceId: request.deviceId,
      expiresAt: encodeSyncUint64(BigInt(expiresAt)),
      pairingDigest: args.pairingDigest,
      pairingCode: args.pairingCode,
      pairingTranscript,
      replay: false,
    });
  },
});

export const claimEnrollmentTransition = internalMutation({
  args: { requestJson: v.string(), verifiedBodyDigest: v.string() },
  returns: backendResultValidator,
  handler: async (ctx, args) => {
    let request;
    try {
      request = claimSyncEnrollmentRequestSchema.parse(parseJson(args.requestJson));
    } catch {
      return failure("INVALID_REQUEST");
    }
    if (request.possessionProof.payload.bodyDigest !== args.verifiedBodyDigest) {
      return failure("PROOF_INVALID");
    }
    const now = Date.now();
    const vault = await humanVault(
      ctx,
      request.requestId,
      request.vaultId,
      request.vaultGeneration,
    );
    if ("ok" in vault) return vault;
    const enrollment = await ctx.db
      .query("syncEnrollmentRequests")
      .withIndex("by_request_id", (query) => query.eq("requestId", request.requestId))
      .unique();
    if (
      enrollment === null
      || enrollment.vaultId !== vault._id
      || enrollment.organizationId !== vault.organizationId
      || enrollment.ownerUserId !== vault.ownerUserId
      || enrollment.deviceId !== request.deviceId
      || enrollment.keysJson !== canonicalSessionSyncJson(request.keys)
      || enrollment.pairingDigest !== request.pairingDigest
    ) return failure("NOT_FOUND");
    const rateFailure = await consumeSessionSyncRateLimit(ctx, "registration", [
      { kind: "human", key: `${vault.ownerUserId}\u0000${vault.organizationId}` },
      { kind: "vault", key: vault._id },
    ], now);
    if (rateFailure !== null) return rateFailure;
    const proofFailure = await consumeEnrollmentPossessionProof(ctx, vault, request, now);
    if (proofFailure !== null) return proofFailure;
    if (enrollment.state === "pending") {
      const signedProposal = enrollment.expiresAt <= now
        ? await irrevocablePendingEnrollmentProposal(ctx, vault._id, enrollment.requestId)
        : null;
      if (enrollment.expiresAt <= now && signedProposal === null) {
        await ctx.db.patch(enrollment._id, { state: "expired", updatedAt: now });
        return failure("GRANT_EXPIRED");
      }
      return success({
        kind: "enrollment_pending",
        vault: vaultCoordinates(vault),
        requestId: enrollment.requestId,
        expiresAt: encodeSyncUint64(BigInt(enrollment.expiresAt)),
        pairingDigest: enrollment.pairingDigest,
        pairingCode: enrollment.pairingCode,
        pairingTranscript: syncEnrollmentPairingTranscriptSchema.parse(
          parseJson(enrollment.pairingTranscriptJson),
        ),
      });
    }
    if (enrollment.state === "expired") return failure("GRANT_EXPIRED");
    const device = await ctx.db
      .query("syncDevices")
      .withIndex("by_vault_and_device", (query) =>
        query.eq("vaultId", vault._id).eq("deviceId", enrollment.deviceId),
      )
      .unique();
    if (device === null || device.status !== "active") return failure("RETIRED");
    const [head, wraps, manifestRows] = await Promise.all([
      ctx.db
        .query("syncMembershipHeads")
        .withIndex("by_vault_and_digest", (query) =>
          query.eq("vaultId", vault._id).eq("statementDigest", vault.membershipDigest),
        )
        .unique(),
      ctx.db
        .query("syncVaultRootWraps")
        .withIndex("by_vault_device_membership_and_epoch", (query) =>
          query
            .eq("vaultId", vault._id)
            .eq("deviceId", device._id)
            .eq("membershipEpoch", vault.membershipEpoch),
        )
        .collect(),
      ctx.db
        .query("syncVaultRootWraps")
        .withIndex("by_vault_and_membership", (query) =>
          query.eq("vaultId", vault._id).eq("membershipEpoch", vault.membershipEpoch),
        )
        .take(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS + 1),
    ]);
    const currentWrap = wraps.find((wrap) => wrap.rootKeyEpoch === vault.rootKeyEpoch);
    const actualEpochs = wraps.map((wrap) => wrap.rootKeyEpoch)
      .sort((left, right) => compareSyncUint64(left, right));
    if (
      head === null
      || currentWrap === undefined
      || wraps.length !== vault.wrappedRootKeyEpochs.length
      || canonicalSessionSyncJson(actualEpochs)
        !== canonicalSessionSyncJson(vault.wrappedRootKeyEpochs)
      || wraps.some((wrap) => wrap.membershipEpoch !== vault.membershipEpoch)
      || manifestRows.length !== vault.activeDeviceCount * vault.wrappedRootKeyEpochs.length
      || manifestRows.length > MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS
    ) {
      return failure("CONFLICT");
    }
    const parsedWraps = wraps
      .sort((left, right) => compareSyncUint64(left.rootKeyEpoch, right.rootKeyEpoch))
      .map((wrap) => wrappedSyncVaultRootKeySchema.parse(parseJson(wrap.wrappedRootJson)));
    const rootWrapManifest = manifestRows
      .map((wrap) => wrappedSyncVaultRootKeySchema.parse(parseJson(wrap.wrappedRootJson)))
      .sort((left, right) => compareSyncIdentifier(
        `${left.context.recipientDeviceId}\u0000${syncUint64OrderKey(left.context.rootKeyEpoch)}`,
        `${right.context.recipientDeviceId}\u0000${syncUint64OrderKey(right.context.rootKeyEpoch)}`,
      ));
    return success({
      kind: "enrollment_claimed",
      vault: vaultCoordinates(vault),
      requestId: enrollment.requestId,
      head: syncMembershipHeadSchema.parse(parseJson(head.headJson)),
      wrappedRoot: wrappedSyncVaultRootKeySchema.parse(parseJson(currentWrap.wrappedRootJson)),
      wrappedRoots: parsedWraps,
      rootWrapManifest,
      pairingDigest: enrollment.pairingDigest,
      pairingTranscript: syncEnrollmentPairingTranscriptSchema.parse(
        parseJson(enrollment.pairingTranscriptJson),
      ),
    });
  },
});

async function currentBoot(
  context: AuthorizedSyncContext,
): Promise<{ bootId: string; bootGeneration: string } | SessionSyncBackendResult> {
  if (context.device.bootId === undefined || context.device.bootGeneration === undefined) {
    return failure("STALE_BOOT");
  }
  return { bootId: context.device.bootId, bootGeneration: context.device.bootGeneration };
}

type MembershipTransitionRequest = Extract<
  SessionSyncBackendRequest,
  {
    operation:
      | "admit_membership_proposal"
      | "update_membership"
      | "approve_enrollment";
  }
>;

async function deleteMembershipProposal(
  ctx: MutationCtx,
  proposal: Doc<"syncMembershipProposals">,
): Promise<void> {
  const [votes, intents] = await Promise.all([
    ctx.db
      .query("syncMembershipVotes")
      .withIndex("by_proposal", (query) => query.eq("proposalId", proposal._id))
      .take(MAX_SYNC_DEVICES + 1),
    ctx.db
      .query("syncMembershipSigningIntents")
      .withIndex("by_proposal", (query) => query.eq("proposalId", proposal._id))
      .take(MAX_SYNC_DEVICES + 1),
  ]);
  if (votes.length > MAX_SYNC_DEVICES || intents.length > MAX_SYNC_DEVICES) {
    throw new Error("membership proposal exceeds its signer bound");
  }
  for (const vote of votes) await ctx.db.delete(vote._id);
  for (const intent of intents) await ctx.db.delete(intent._id);
  await ctx.db.delete(proposal._id);
}

async function irrevocablePendingEnrollmentProposal(
  ctx: ReadCtx,
  vaultId: Id<"syncVaults">,
  enrollmentRequestId: string,
): Promise<Doc<"syncMembershipProposals"> | null> {
  const proposal = await ctx.db
    .query("syncMembershipProposals")
    .withIndex("by_vault_enrollment_and_state", (query) =>
      query
        .eq("vaultId", vaultId)
        .eq("enrollmentRequestId", enrollmentRequestId)
        .eq("state", "pending"),
    )
    .take(2);
  if (proposal.length > 1) throw new Error("enrollment has multiple pending membership proposals");
  const candidate = proposal[0];
  if (candidate === undefined) return null;
  const intent = await ctx.db
    .query("syncMembershipSigningIntents")
    .withIndex("by_proposal", (query) => query.eq("proposalId", candidate._id))
    .take(1);
  return intent.length === 0 ? null : candidate;
}

async function membershipProposalView(
  ctx: ReadCtx,
  proposal: Doc<"syncMembershipProposals">,
  requiredVotes: number,
) {
  const [votes, intents] = await Promise.all([
    ctx.db
      .query("syncMembershipVotes")
      .withIndex("by_proposal", (query) => query.eq("proposalId", proposal._id))
      .take(MAX_SYNC_DEVICES + 1),
    ctx.db
      .query("syncMembershipSigningIntents")
      .withIndex("by_proposal", (query) => query.eq("proposalId", proposal._id))
      .take(MAX_SYNC_DEVICES + 1),
  ]);
  if (
    votes.length >= requiredVotes
    || votes.length > MAX_SYNC_DEVICES
    || intents.length > MAX_SYNC_DEVICES
  ) throw new Error("pending membership proposal has an invalid vote count");
  const intentDevices = await Promise.all(intents.map(async (intent) => await ctx.db
    .query("syncDevices")
    .withIndex("by_vault_and_device", (query) =>
      query.eq("vaultId", proposal.vaultId).eq("deviceId", intent.signerDeviceId),
    )
    .unique()));
  if (intentDevices.some((device) =>
    device === null
    || device.status !== "active"
    || device.membershipEpoch !== proposal.parentMembershipEpoch)) {
    throw new Error("membership proposal signer intent lacks prior active-device authority");
  }
  const signatures = votes
    .map((vote) => syncMembershipSignatureSchema.parse(parseJson(vote.signatureJson)))
    .sort((left, right) => compareSyncIdentifier(left.deviceId, right.deviceId));
  return {
    proposalKind: proposal.kind,
    ...(proposal.enrollmentRequestId === undefined
      ? {}
      : { enrollmentRequestId: proposal.enrollmentRequestId }),
    candidate: {
      statement: parseJson(proposal.statementJson),
      statementDigest: proposal.childMembershipDigest,
    },
    signatures,
    signingIntentDeviceIds: intents
      .map((intent) => intent.signerDeviceId)
      .sort(compareSyncIdentifier),
    wrappedRoots: parseJson(proposal.wrappedRootsJson),
    collectedVotes: votes.length,
    requiredVotes,
    admissionExpiresAt: encodeSyncUint64(BigInt(proposal.expiresAt)),
    irrevocable: intents.length > 0,
    ...(proposal.rootKeyLinkJson === undefined
      ? {}
      : { rootKeyLink: parseJson(proposal.rootKeyLinkJson) }),
    recoveryRootWrap: wrappedSyncRecoveryVaultRootKeySchema.parse(
      parseJson(proposal.recoveryRootWrapJson),
    ),
  };
}

function sameDeviceKeys(
  device: Doc<"syncDevices">,
  keys: ReturnType<typeof syncDevicePublicKeysSchema.parse>,
): boolean {
  return canonicalSessionSyncJson(publicKeys(device)) === canonicalSessionSyncJson(keys);
}

type CurrentKeyMaterial = Readonly<{
  rootWraps: readonly Doc<"syncVaultRootWraps">[];
  recoveryRootWrap: Doc<"syncRecoveryRootWraps">;
  ciphertextBytes: number;
}>;

async function loadCurrentKeyMaterial(
  ctx: ReadCtx,
  vault: Doc<"syncVaults">,
): Promise<CurrentKeyMaterial | null> {
  const [rootWraps, recoveryRootWrap, activeDevices, head] = await Promise.all([
    ctx.db
      .query("syncVaultRootWraps")
      .withIndex("by_vault_and_membership", (query) =>
        query.eq("vaultId", vault._id).eq("membershipEpoch", vault.membershipEpoch),
      )
      .take(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS + 1),
    ctx.db
      .query("syncRecoveryRootWraps")
      .withIndex("by_vault_and_membership", (query) =>
        query.eq("vaultId", vault._id).eq("membershipEpoch", vault.membershipEpoch),
      )
      .unique(),
    ctx.db
      .query("syncDevices")
      .withIndex("by_vault_status_and_device", (query) =>
        query.eq("vaultId", vault._id).eq("status", "active"),
      )
      .take(MAX_SYNC_DEVICES + 1),
    ctx.db
      .query("syncMembershipHeads")
      .withIndex("by_vault_and_digest", (query) =>
        query.eq("vaultId", vault._id).eq("statementDigest", vault.membershipDigest),
      )
      .unique(),
  ]);
  if (
    recoveryRootWrap === null
    || head === null
    || activeDevices.length !== vault.activeDeviceCount
    || activeDevices.length > MAX_SYNC_DEVICES
    || rootWraps.length > MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS
  ) return null;
  try {
    const parsedHead = syncMembershipHeadSchema.parse(parseJson(head.headJson));
    const statement = parsedHead.statement;
    const expectedEpochs = [...vault.wrappedRootKeyEpochs]
      .sort((left, right) => compareSyncUint64(left, right));
    const activeMembers = statement.members.filter((member) => member.status === "active");
    if (
      head.headJson !== canonicalSessionSyncJson(parsedHead)
      || head.membershipEpoch !== vault.membershipEpoch
      || head.statementDigest !== vault.membershipDigest
      || parsedHead.statementDigest !== vault.membershipDigest
      || statement.tenantId !== vault.tenantId
      || statement.organizationId !== vault.organizationCoordinate
      || statement.ownerUserId !== vault.ownerUserCoordinate
      || statement.vaultId !== vault.vaultId
      || statement.vaultGeneration !== vault.vaultGeneration
      || statement.membershipEpoch !== vault.membershipEpoch
      || statement.recoveryGeneration !== vault.recoveryGeneration
      || statement.rootKeyEpoch !== vault.rootKeyEpoch
      || statement.rootKeyCommitment !== vault.rootKeyCommitment
      || statement.recoveryRootWrapDigest !== recoveryRootWrap.wrapDigest
      || expectedEpochs.length === 0
      || expectedEpochs.length > MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS
      || new Set(expectedEpochs).size !== expectedEpochs.length
      || canonicalSessionSyncJson(expectedEpochs)
        !== canonicalSessionSyncJson(vault.wrappedRootKeyEpochs)
      || canonicalSessionSyncJson(expectedEpochs)
        !== canonicalSessionSyncJson(vault.retainedRootKeyEpochs)
      || !expectedEpochs.includes(vault.rootKeyEpoch)
      || activeMembers.length !== activeDevices.length
    ) return null;
    const devicesByPublicId = new Map(activeDevices.map((device) => [device.deviceId, device]));
    for (const member of activeMembers) {
      const device = devicesByPublicId.get(member.deviceId);
      if (
        device === undefined
        || device.membershipEpoch !== vault.membershipEpoch
        || device.organizationId !== vault.organizationId
        || device.ownerUserId !== vault.ownerUserId
        || device.name !== member.name
        || canonicalSessionSyncJson(publicKeys(device)) !== canonicalSessionSyncJson(member.keys)
      ) return null;
    }
    const expectedRootWrapCount = activeDevices.length * expectedEpochs.length;
    if (rootWraps.length !== expectedRootWrapCount) return null;
    const parsedWraps = [];
    const pairs = new Set<string>();
    for (const row of rootWraps) {
      const device = devicesByPublicId.get(row.recipientDeviceId);
      const wrap = wrappedSyncVaultRootKeySchema.parse(parseJson(row.wrappedRootJson));
      const pair = `${row.recipientDeviceId}\u0000${row.rootKeyEpoch}`;
      if (
        device === undefined
        || pairs.has(pair)
        || row.deviceId !== device._id
        || row.membershipEpoch !== vault.membershipEpoch
        || row.ciphertextBytes !== 48
        || !expectedEpochs.includes(row.rootKeyEpoch)
        || row.wrappedRootJson !== canonicalSessionSyncJson(wrap)
        || wrap.context.tenantId !== vault.tenantId
        || wrap.context.organizationId !== vault.organizationCoordinate
        || wrap.context.ownerUserId !== vault.ownerUserCoordinate
        || wrap.context.vaultId !== vault.vaultId
        || wrap.context.vaultGeneration !== vault.vaultGeneration
        || wrap.context.membershipEpoch !== vault.membershipEpoch
        || wrap.context.recipientDeviceId !== device.deviceId
        || wrap.context.recipientAgreementKeyId !== device.agreementKeyId
        || wrap.context.rootKeyEpoch !== row.rootKeyEpoch
      ) return null;
      pairs.add(pair);
      parsedWraps.push(wrap);
    }
    for (const device of activeDevices) {
      for (const epoch of expectedEpochs) {
        if (!pairs.has(`${device.deviceId}\u0000${epoch}`)) return null;
      }
    }
    if (statement.rootWrapManifestDigest
      !== await digestSyncVaultRootWrapManifest(parsedWraps)) return null;
    const recoveryWrap = wrappedSyncRecoveryVaultRootKeySchema.parse(
      parseJson(recoveryRootWrap.wrapJson),
    );
    if (
      recoveryRootWrap.wrapJson !== canonicalSessionSyncJson(recoveryWrap)
      || recoveryRootWrap.membershipEpoch !== vault.membershipEpoch
      || recoveryRootWrap.rootKeyEpoch !== vault.rootKeyEpoch
      || recoveryRootWrap.recoveryGeneration !== vault.recoveryGeneration
      || recoveryRootWrap.ciphertextBytes !== 48
      || recoveryRootWrap.wrapDigest !== await digestSyncRecoveryVaultRootWrap(recoveryWrap)
      || canonicalSessionSyncJson(recoveryWrap.context.vault)
        !== canonicalSessionSyncJson(vaultCoordinates(vault))
      || recoveryWrap.context.membershipEpoch !== vault.membershipEpoch
      || recoveryWrap.context.recoveryGeneration !== vault.recoveryGeneration
      || recoveryWrap.context.rootKeyEpoch !== vault.rootKeyEpoch
      || recoveryWrap.context.rootKeyCommitment !== vault.rootKeyCommitment
      || recoveryWrap.context.recipientRecoveryAgreementKeyId !== vault.recoveryAgreementKeyId
    ) return null;
  } catch {
    return null;
  }
  return {
    rootWraps,
    recoveryRootWrap,
    ciphertextBytes: rootWraps.reduce((total, wrap) => total + wrap.ciphertextBytes, 0)
      + recoveryRootWrap.ciphertextBytes,
  };
}

async function archiveCurrentKeyMaterial(
  ctx: MutationCtx,
  material: CurrentKeyMaterial,
  now: number,
): Promise<void> {
  for (const wrap of material.rootWraps) {
    await ctx.db.insert("syncVaultRootWrapEvidence", {
      vaultId: wrap.vaultId,
      recipientDeviceId: wrap.recipientDeviceId,
      membershipEpoch: wrap.membershipEpoch,
      rootKeyEpoch: wrap.rootKeyEpoch,
      wrappedRootJson: wrap.wrappedRootJson,
      ciphertextBytes: wrap.ciphertextBytes,
      sourceCreatedAt: wrap.createdAt,
      archivedAt: now,
    });
    await ctx.db.delete(wrap._id);
  }
  const recovery = material.recoveryRootWrap;
  await ctx.db.insert("syncRecoveryRootWrapEvidence", {
    vaultId: recovery.vaultId,
    membershipEpoch: recovery.membershipEpoch,
    rootKeyEpoch: recovery.rootKeyEpoch,
    recoveryGeneration: recovery.recoveryGeneration,
    wrapDigest: recovery.wrapDigest,
    wrapJson: recovery.wrapJson,
    ciphertextBytes: recovery.ciphertextBytes,
    sourceCreatedAt: recovery.createdAt,
    archivedAt: now,
  });
  await ctx.db.delete(recovery._id);
}

async function retainedRootEpochsForTransition(
  ctx: MutationCtx,
  vault: Doc<"syncVaults">,
  nextRootKeyEpoch: string,
): Promise<string[] | null> {
  const [heads, events] = await Promise.all([
    ctx.db
      .query("syncSessionHeads")
      .withIndex("by_vault_and_session", (query) => query.eq("vaultId", vault._id))
      .collect(),
    ctx.db
      .query("syncSessionEvents")
      .withIndex("by_vault_and_observed", (query) => query.eq("vaultId", vault._id))
      .collect(),
  ]);
  const epochs = new Set<string>([nextRootKeyEpoch]);
  for (const head of heads) epochs.add(head.keyEpoch);
  for (const event of events) epochs.add(event.keyEpoch);
  if (epochs.size > MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS) return null;
  return [...epochs].sort((left, right) => compareSyncUint64(left, right));
}

async function forceOfflineRevokedOrigins(
  ctx: MutationCtx,
  vault: Doc<"syncVaults">,
  revokedDevices: readonly Doc<"syncDevices">[],
  now: number,
): Promise<Readonly<{ directoryVersion: string; activeStreamCount: number }>> {
  let directoryVersion = vault.directoryVersion;
  let activeStreamCount = vault.activeStreamCount;
  for (const device of revokedDevices) {
    const [reservations, activeEntries] = await Promise.all([
      ctx.db
        .query("syncSessionEntries")
        .withIndex("by_origin_and_state", (query) =>
          query.eq("originDeviceId", device._id).eq("state", "reserved"),
        )
        .collect(),
      ctx.db
        .query("syncSessionEntries")
        .withIndex("by_origin_and_state", (query) =>
          query.eq("originDeviceId", device._id).eq("state", "active"),
        )
        .collect(),
    ]);
    for (const reservation of reservations) {
      await ctx.db.patch(reservation._id, {
        creationGrantExpiresAt: Math.min(reservation.creationGrantExpiresAt, now),
        writerBootId: undefined,
        writerBootGeneration: undefined,
        streamActive: false,
        updatedAt: now,
      });
    }
    for (const entry of activeEntries) {
      directoryVersion = nextRequiredSyncUint64(directoryVersion);
      const mirrorEpoch = nextRequiredSyncUint64(entry.mirrorEpoch);
      const resetDigest = entry.currentDigest ?? entry.creationGrantDigest;
      const payload = {
        kind: "mirror_reset" as const,
        ...vaultCoordinates(vault),
        sessionId: entry.sessionId,
        directoryOrdinal: entry.directoryOrdinal,
        directoryVersion,
        mirrorEpoch,
        resetDigest,
      };
      await ctx.db.insert("syncDirectoryChanges", {
        vaultId: vault._id,
        directoryVersion,
        directoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
        kind: "mirror_reset",
        sessionEntryId: entry._id,
        payloadJson: canonicalSessionSyncJson(payload),
        createdAt: now,
      });
      await ctx.db.patch(entry._id, {
        mirrorEpoch,
        writerGeneration: nextRequiredSyncUint64(entry.writerGeneration),
        writerBootId: undefined,
        writerBootGeneration: undefined,
        streamActive: false,
        latestDirectoryVersion: directoryVersion,
        latestDirectoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
        updatedAt: now,
      });
      if (entry.streamActive) activeStreamCount -= 1;
    }
  }
  return { directoryVersion, activeStreamCount };
}

async function updateMembership(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: MembershipTransitionRequest,
  requestDigest: string,
  now: number,
): Promise<SessionSyncBackendResult> {
  const candidate = request.operation === "admit_membership_proposal"
    ? request.membershipCandidate
    : request.membershipHead;
  const signatures = request.operation === "admit_membership_proposal"
    ? []
    : request.membershipHead.signatures;
  const statement = candidate.statement;
  const proposalKind = request.operation === "admit_membership_proposal"
    ? request.proposalKind
    : request.operation === "approve_enrollment" ? "enrollment" : "update";
  const proposalEnrollmentRequestId = request.operation === "admit_membership_proposal"
    ? request.enrollmentRequestId
    : request.operation === "approve_enrollment" ? request.requestId : undefined;
  const existingHead = await ctx.db
    .query("syncMembershipHeads")
    .withIndex("by_vault_and_digest", (query) =>
      query.eq("vaultId", context.vault._id).eq("statementDigest", candidate.statementDigest),
    )
    .unique();
  if (
    existingHead !== null
    && context.vault.membershipDigest === candidate.statementDigest
    && canonicalSessionSyncJson(
      syncMembershipHeadSchema.parse(parseJson(existingHead.headJson)).statement,
    ) === canonicalSessionSyncJson(statement)
  ) {
    return success({
      kind: "membership_accepted",
      membershipEpoch: statement.membershipEpoch,
      membershipDigest: candidate.statementDigest,
    });
  }
  if (
    statement.tenantId !== context.vault.tenantId
    || statement.organizationId !== context.vault.organizationCoordinate
    || statement.ownerUserId !== context.vault.ownerUserCoordinate
    || statement.vaultId !== context.vault.vaultId
    || statement.vaultGeneration !== context.vault.vaultGeneration
    || statement.previousMembershipDigest !== context.vault.membershipDigest
    || (proposalKind === "update"
      && statement.enrollmentPairingDigest !== null)
    || statement.membershipEpoch !== nextRequiredSyncUint64(context.vault.membershipEpoch)
  ) return failure("STALE_MEMBERSHIP");
  if (decodeSyncUint64(context.vault.membershipEpoch)
    >= BigInt(MAX_SYNC_LIFETIME_MEMBERSHIP_EPOCHS)) {
    return failure("MAINTENANCE_REQUIRED");
  }
  const [currentActiveDevices, referencedDevices] = await Promise.all([
    ctx.db
      .query("syncDevices")
      .withIndex("by_vault_status_and_device", (query) =>
        query.eq("vaultId", context.vault._id).eq("status", "active"),
      )
      .take(MAX_SYNC_DEVICES + 1),
    Promise.all(statement.members.map(async (member) => await ctx.db
      .query("syncDevices")
      .withIndex("by_vault_and_device", (query) =>
        query.eq("vaultId", context.vault._id).eq("deviceId", member.deviceId),
      )
      .unique())),
  ]);
  if (currentActiveDevices.length > MAX_SYNC_DEVICES) return failure("CONFLICT");
  const currentByPublicId = new Map(
    referencedDevices
      .filter((device): device is Doc<"syncDevices"> => device !== null)
      .map((device) => [device.deviceId, device]),
  );
  if (currentActiveDevices.some((device) =>
    !statement.members.some((member) => member.deviceId === device.deviceId)
  )) return failure("CONFLICT");
  for (const member of statement.members) {
    const existing = currentByPublicId.get(member.deviceId);
    if (
      (existing === undefined
        && (member.status === "revoked" || proposalKind === "update"))
      || (existing !== undefined
        && (!sameDeviceKeys(existing, member.keys)
          || (existing.status === "revoked" && member.status !== "revoked")))
    ) return failure("CONFLICT");
  }
  const activeMembers = statement.members.filter((member) => member.status === "active");
  if (activeMembers.length > MAX_SYNC_DEVICES) return failure("DEVICE_LIMIT");
  const activeIds = new Set<string>(activeMembers.map((member) => member.deviceId));
  const newlyRevoked = currentActiveDevices.filter((device) => !activeIds.has(device.deviceId));
  const revokedCurrent = newlyRevoked.length > 0;
  if (statement.recoveryGeneration !== context.vault.recoveryGeneration) {
    return failure("CONFLICT");
  }
  const rootKeyEpoch = revokedCurrent
    ? nextRequiredSyncUint64(context.vault.rootKeyEpoch)
    : context.vault.rootKeyEpoch;
  if (statement.rootKeyEpoch !== rootKeyEpoch) return failure("CONFLICT");
  if (
    revokedCurrent
    && decodeSyncUint64(context.vault.rootKeyEpoch) >= BigInt(MAX_SYNC_LIFETIME_ROOT_KEY_EPOCHS)
  ) return failure("MAINTENANCE_REQUIRED");
  const recoveryRootWrap = request.recoveryRootWrap;
  if (
    canonicalSessionSyncJson(recoveryRootWrap.context.vault)
      !== canonicalSessionSyncJson(vaultCoordinates(context.vault))
    || recoveryRootWrap.context.membershipEpoch !== statement.membershipEpoch
    || recoveryRootWrap.context.recoveryGeneration !== statement.recoveryGeneration
    || recoveryRootWrap.context.rootKeyEpoch !== statement.rootKeyEpoch
    || recoveryRootWrap.context.rootKeyCommitment !== statement.rootKeyCommitment
    || recoveryRootWrap.context.recipientRecoveryAgreementKeyId
      !== context.vault.recoveryAgreementKeyId
  ) return failure("CONFLICT");
  if (revokedCurrent) {
    const link = request.rootKeyLink;
    if (
      link === undefined
      || statement.rootKeyCommitment === context.vault.rootKeyCommitment
      || statement.rootKeyLinkDigest !== link.linkDigest
      || link.context.tenantId !== context.vault.tenantId
      || link.context.organizationId !== context.vault.organizationCoordinate
      || link.context.ownerUserId !== context.vault.ownerUserCoordinate
      || link.context.vaultId !== context.vault.vaultId
      || link.context.vaultGeneration !== context.vault.vaultGeneration
      || link.context.membershipEpoch !== statement.membershipEpoch
      || link.context.parentRootKeyEpoch !== context.vault.rootKeyEpoch
      || link.context.parentRootKeyCommitment !== context.vault.rootKeyCommitment
      || link.context.childRootKeyEpoch !== statement.rootKeyEpoch
      || link.context.childRootKeyCommitment !== statement.rootKeyCommitment
    ) return failure("CONFLICT");
  } else if (
    request.rootKeyLink !== undefined
    || statement.rootKeyLinkDigest !== null
    || statement.rootKeyCommitment !== context.vault.rootKeyCommitment
  ) return failure("CONFLICT");
  const retainedRootKeyEpochs = await retainedRootEpochsForTransition(ctx, context.vault, rootKeyEpoch);
  if (retainedRootKeyEpochs === null) return failure("KEY_EPOCH_LIMIT");
  if (request.wrappedRoots.length !== activeMembers.length * retainedRootKeyEpochs.length) {
    return failure("CONFLICT");
  }
  const wrapsByDeviceAndEpoch = new Map(request.wrappedRoots.map((wrap) => [
    `${wrap.context.recipientDeviceId}\u0000${wrap.context.rootKeyEpoch}`,
    wrap,
  ]));
  if (wrapsByDeviceAndEpoch.size !== request.wrappedRoots.length) return failure("CONFLICT");
  for (const member of activeMembers) {
    for (const retainedRootKeyEpoch of retainedRootKeyEpochs) {
      const wrap = wrapsByDeviceAndEpoch.get(`${member.deviceId}\u0000${retainedRootKeyEpoch}`);
      if (
        wrap === undefined
        || wrap.context.tenantId !== context.vault.tenantId
        || wrap.context.organizationId !== context.vault.organizationCoordinate
        || wrap.context.ownerUserId !== context.vault.ownerUserCoordinate
        || wrap.context.vaultId !== context.vault.vaultId
        || wrap.context.vaultGeneration !== context.vault.vaultGeneration
        || wrap.context.membershipEpoch !== statement.membershipEpoch
        || wrap.context.rootKeyEpoch !== retainedRootKeyEpoch
        || wrap.context.recipientDeviceId !== member.deviceId
        || wrap.context.recipientAgreementKeyId !== member.keys.agreement.keyId
      ) return failure("CONFLICT");
    }
  }
  const currentKeyMaterial = await loadCurrentKeyMaterial(ctx, context.vault);
  if (currentKeyMaterial === null) return failure("CONFLICT");
  const compatibilityEvidenceCiphertextBytes =
    context.vault.compatibilityEvidenceCiphertextBytes + currentKeyMaterial.ciphertextBytes;
  if (compatibilityEvidenceCiphertextBytes > MAX_SYNC_RETAINED_CIPHERTEXT_BYTES) {
    return failure("MAINTENANCE_REQUIRED");
  }
  const nextWrapBytes = request.wrappedRoots.length * 48;
  const retainedCiphertextBytes = context.vault.retainedCiphertextBytes
    - currentKeyMaterial.ciphertextBytes
    + nextWrapBytes
    + 48
    + (request.rootKeyLink === undefined ? 0 : 48);
  if (
    retainedCiphertextBytes < 0
    || retainedCiphertextBytes + compatibilityEvidenceCiphertextBytes
      > MAX_SYNC_RETAINED_CIPHERTEXT_BYTES
  ) return failure("QUOTA_EXCEEDED");
  if (request.rootKeyLink !== undefined) {
    const existingLink = await ctx.db
      .query("syncVaultRootKeyLinks")
      .withIndex("by_vault_and_child_epoch", (query) =>
        query
          .eq("vaultId", context.vault._id)
          .eq(
            "childRootKeyEpochOrderKey",
            syncUint64OrderKey(request.rootKeyLink!.context.childRootKeyEpoch),
          ),
      )
      .unique();
    if (existingLink !== null) return failure("CONFLICT");
  }
  const recoveryWrapCollision = await ctx.db
    .query("syncRecoveryRootWraps")
    .withIndex("by_vault_and_membership", (query) =>
      query
        .eq("vaultId", context.vault._id)
        .eq("membershipEpoch", statement.membershipEpoch),
    )
    .unique();
  if (recoveryWrapCollision !== null) return failure("CONFLICT");
  const statementJson = canonicalSessionSyncJson(statement);
  const wrappedRootsJson = canonicalSessionSyncJson(request.wrappedRoots);
  const rootKeyLinkJson = request.rootKeyLink === undefined
    ? undefined
    : canonicalSessionSyncJson(request.rootKeyLink);
  const recoveryRootWrapJson = canonicalSessionSyncJson(request.recoveryRootWrap);
  let proposal = await ctx.db
    .query("syncMembershipProposals")
    .withIndex("by_vault_parent_and_state", (query) =>
      query
        .eq("vaultId", context.vault._id)
        .eq("parentMembershipEpoch", context.vault.membershipEpoch)
        .eq("state", "pending"),
    )
    .unique();
  if (proposal !== null && proposal.expiresAt <= now) {
    const signerIntents = await ctx.db
      .query("syncMembershipSigningIntents")
      .withIndex("by_proposal", (query) => query.eq("proposalId", proposal!._id))
      .take(1);
    if (signerIntents.length === 0) {
      await deleteMembershipProposal(ctx, proposal);
      proposal = null;
    }
  }
  const proposalMatches = proposal !== null
    && proposal.parentMembershipDigest === context.vault.membershipDigest
    && proposal.childMembershipEpoch === statement.membershipEpoch
    && proposal.childMembershipDigest === candidate.statementDigest
    && proposal.kind === proposalKind
    && proposal.enrollmentRequestId === proposalEnrollmentRequestId
    && proposal.statementJson === statementJson
    && proposal.wrappedRootsJson === wrappedRootsJson
    && proposal.rootKeyLinkJson === rootKeyLinkJson
    && proposal.recoveryRootWrapJson === recoveryRootWrapJson;
  if (proposal !== null && !proposalMatches) {
    if (request.operation === "admit_membership_proposal") {
      return success({
        kind: "membership_pending",
        proposal: await membershipProposalView(
          ctx,
          proposal,
          Math.floor(currentActiveDevices.length / 2) + 1,
        ),
      });
    }
    return failure("CONFLICT");
  }
  if (proposal === null) {
    if (request.operation !== "admit_membership_proposal") return failure("CONFLICT");
    const proposalId = await ctx.db.insert("syncMembershipProposals", {
      vaultId: context.vault._id,
      parentMembershipEpoch: context.vault.membershipEpoch,
      parentMembershipDigest: context.vault.membershipDigest,
      childMembershipEpoch: statement.membershipEpoch,
      childMembershipDigest: candidate.statementDigest,
      kind: proposalKind,
      ...(proposalEnrollmentRequestId === undefined
        ? {}
        : { enrollmentRequestId: proposalEnrollmentRequestId }),
      statementJson,
      wrappedRootsJson,
      ...(rootKeyLinkJson === undefined ? {} : { rootKeyLinkJson }),
      recoveryRootWrapJson,
      state: "pending",
      expiresAt: now + SESSION_SYNC_MEMBERSHIP_PROPOSAL_TTL_MS,
      createdAt: now,
      updatedAt: now,
    });
    proposal = await ctx.db.get(proposalId);
    if (proposal === null) throw new Error("inserted membership proposal disappeared");
  }
  if (request.operation === "admit_membership_proposal") {
    const existingIntent = await ctx.db
      .query("syncMembershipSigningIntents")
      .withIndex("by_proposal_and_signer", (query) =>
        query
          .eq("proposalId", proposal!._id)
          .eq("signerDeviceId", context.device.deviceId),
      )
      .unique();
    if (existingIntent === null) {
      await ctx.db.insert("syncMembershipSigningIntents", {
        vaultId: context.vault._id,
        proposalId: proposal._id,
        signerDeviceId: context.device.deviceId,
        createdAt: now,
      });
    }
  }
  const currentActiveByPublicId = new Map(
    currentActiveDevices.map((device) => [device.deviceId, device]),
  );
  const existingVotes = await ctx.db
    .query("syncMembershipVotes")
    .withIndex("by_proposal", (query) => query.eq("proposalId", proposal._id))
    .take(MAX_SYNC_DEVICES + 1);
  if (existingVotes.length > MAX_SYNC_DEVICES) {
    throw new Error("membership proposal exceeds the vote bound");
  }
  const existingVoteBySigner = new Map(
    existingVotes.map((vote) => [vote.signerDeviceId, vote]),
  );
  const storedVoteAuthorities = await Promise.all(existingVotes.map(async (vote) => ({
    vote,
    intent: await ctx.db
      .query("syncMembershipSigningIntents")
      .withIndex("by_proposal_and_signer", (query) =>
        query
          .eq("proposalId", proposal._id)
          .eq("signerDeviceId", vote.signerDeviceId),
      )
      .unique(),
  })));
  for (const { vote, intent } of storedVoteAuthorities) {
    const signer = currentActiveByPublicId.get(vote.signerDeviceId);
    const parsed = syncMembershipSignatureSchema.parse(parseJson(vote.signatureJson));
    if (
      intent === null
      || signer === undefined
      || parsed.deviceId !== vote.signerDeviceId
      || parsed.signingKeyId !== signer.signingKeyId
      || vote.signatureJson !== canonicalSessionSyncJson(parsed)
    ) throw new Error("stored membership vote lacks coherent signer authority");
  }
  const requestedVoteAuthorities = await Promise.all(signatures.map(async (signature) => ({
    signature,
    intent: await ctx.db
      .query("syncMembershipSigningIntents")
      .withIndex("by_proposal_and_signer", (query) =>
        query
          .eq("proposalId", proposal._id)
          .eq("signerDeviceId", signature.deviceId),
      )
      .unique(),
  })));
  const newSignatures = [];
  for (const { signature, intent } of requestedVoteAuthorities) {
    const signer = currentActiveByPublicId.get(signature.deviceId);
    const existingVote = existingVoteBySigner.get(signature.deviceId);
    const signatureJson = canonicalSessionSyncJson(signature);
    if (
      signer === undefined
      || signer.signingKeyId !== signature.signingKeyId
      || intent === null
      || (existingVote !== undefined && existingVote.signatureJson !== signatureJson)
    ) return failure("AUTHORIZATION_DENIED");
    if (existingVote === undefined) newSignatures.push({ signature, signatureJson });
  }
  if (existingVotes.length + newSignatures.length > MAX_SYNC_DEVICES) {
    return failure("CONFLICT");
  }
  for (const { signature, signatureJson } of newSignatures) {
    await ctx.db.insert("syncMembershipVotes", {
      vaultId: context.vault._id,
      proposalId: proposal._id,
      signerDeviceId: signature.deviceId,
      signatureJson,
      signedAt: now,
    });
  }
  const votes = await ctx.db
    .query("syncMembershipVotes")
    .withIndex("by_proposal", (query) => query.eq("proposalId", proposal._id))
    .take(MAX_SYNC_DEVICES + 1);
  const requiredVotes = Math.floor(currentActiveDevices.length / 2) + 1;
  if (votes.length < requiredVotes) {
    return success({
      kind: "membership_pending",
      proposal: await membershipProposalView(ctx, proposal, requiredVotes),
    });
  }
  if (votes.length > MAX_SYNC_DEVICES) {
    throw new Error("membership proposal exceeded its validated vote bound");
  }
  const acceptedHead = syncMembershipHeadSchema.parse({
    statement,
    statementDigest: candidate.statementDigest,
    signatures: votes
      .map((vote) => syncMembershipSignatureSchema.parse(parseJson(vote.signatureJson)))
      .sort((left, right) => compareSyncIdentifier(left.deviceId, right.deviceId)),
  });
  await ctx.db.insert("syncMembershipHeads", {
    vaultId: context.vault._id,
    organizationId: context.vault.organizationId,
    ownerUserId: context.vault.ownerUserId,
    membershipEpoch: statement.membershipEpoch,
    previousMembershipDigest: context.vault.membershipDigest,
    statementDigest: candidate.statementDigest,
    requestDigest,
    headJson: canonicalSessionSyncJson(acceptedHead),
    acceptedAt: now,
  });
  await archiveCurrentKeyMaterial(ctx, currentKeyMaterial, now);
  if (request.rootKeyLink !== undefined) {
    await ctx.db.insert("syncVaultRootKeyLinks", {
      vaultId: context.vault._id,
      membershipEpoch: statement.membershipEpoch,
      parentRootKeyEpoch: request.rootKeyLink.context.parentRootKeyEpoch,
      parentRootKeyEpochOrderKey: syncUint64OrderKey(
        request.rootKeyLink.context.parentRootKeyEpoch,
      ),
      childRootKeyEpoch: request.rootKeyLink.context.childRootKeyEpoch,
      childRootKeyEpochOrderKey: syncUint64OrderKey(
        request.rootKeyLink.context.childRootKeyEpoch,
      ),
      linkDigest: request.rootKeyLink.linkDigest,
      linkJson: canonicalSessionSyncJson(request.rootKeyLink),
      ciphertextBytes: 48,
      createdAt: now,
    });
  }
  await ctx.db.insert("syncRecoveryRootWraps", {
    vaultId: context.vault._id,
    membershipEpoch: statement.membershipEpoch,
    rootKeyEpoch: statement.rootKeyEpoch,
    recoveryGeneration: statement.recoveryGeneration,
    wrapDigest: statement.recoveryRootWrapDigest,
    wrapJson: canonicalSessionSyncJson(recoveryRootWrap),
    ciphertextBytes: 48,
    createdAt: now,
  });
  for (const member of statement.members) {
    const existing = currentByPublicId.get(member.deviceId);
    const record = {
      name: member.name,
      status: member.status,
      signingKeyId: member.keys.signing.keyId,
      signingPublicKey: member.keys.signing.publicKey,
      signingPublicKeyDigest: member.keys.signing.publicKeyDigest,
      agreementKeyId: member.keys.agreement.keyId,
      agreementPublicKey: member.keys.agreement.publicKey,
      agreementPublicKeyDigest: member.keys.agreement.publicKeyDigest,
      membershipEpoch: statement.membershipEpoch,
      ...(member.status === "revoked" ? { revokedAt: now } : {}),
      updatedAt: now,
    } as const;
    let deviceId: Id<"syncDevices">;
    if (existing === undefined) {
      deviceId = await ctx.db.insert("syncDevices", {
        vaultId: context.vault._id,
        organizationId: context.vault.organizationId,
        ownerUserId: context.vault.ownerUserId,
        deviceId: member.deviceId,
        ...record,
        approvedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, record);
      deviceId = existing._id;
    }
    if (member.status === "active") {
      for (const retainedRootKeyEpoch of retainedRootKeyEpochs) {
        const wrap = wrapsByDeviceAndEpoch.get(`${member.deviceId}\u0000${retainedRootKeyEpoch}`);
        if (wrap === undefined) throw new Error("validated sync root wrap disappeared");
        await ctx.db.insert("syncVaultRootWraps", {
          vaultId: context.vault._id,
          deviceId,
          recipientDeviceId: member.deviceId,
          membershipEpoch: statement.membershipEpoch,
          rootKeyEpoch: retainedRootKeyEpoch,
          wrappedRootJson: canonicalSessionSyncJson(wrap),
          ciphertextBytes: 48,
          createdAt: now,
        });
      }
    }
  }
  const forcedOffline = await forceOfflineRevokedOrigins(ctx, context.vault, newlyRevoked, now);
  await ctx.db.patch(context.vault._id, {
    membershipEpoch: statement.membershipEpoch,
    membershipDigest: candidate.statementDigest,
    recoveryGeneration: statement.recoveryGeneration,
    rootKeyEpoch,
    rootKeyCommitment: statement.rootKeyCommitment,
    retainedRootKeyEpochs,
    wrappedRootKeyEpochs: retainedRootKeyEpochs,
    activeDeviceCount: activeMembers.length,
    directoryVersion: forcedOffline.directoryVersion,
    directoryVersionOrderKey: syncUint64OrderKey(forcedOffline.directoryVersion),
    activeStreamCount: forcedOffline.activeStreamCount,
    retainedCiphertextBytes,
    compatibilityEvidenceCiphertextBytes,
    updatedAt: now,
  });
  await deleteMembershipProposal(ctx, proposal);
  return success({
    kind: "membership_accepted",
    membershipEpoch: statement.membershipEpoch,
    membershipDigest: candidate.statementDigest,
  });
}

async function listEnrollmentRequests(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  now: number,
): Promise<SessionSyncBackendResult> {
  const activeRows = await ctx.db
    .query("syncEnrollmentRequests")
    .withIndex("by_vault_state_and_expiry", (query) =>
      query.eq("vaultId", context.vault._id).eq("state", "pending").gt("expiresAt", now),
    )
    .take(MAX_SESSION_SYNC_PENDING_ENROLLMENTS + 1);
  if (activeRows.length > MAX_SESSION_SYNC_PENDING_ENROLLMENTS) return failure("CONFLICT");
  const currentProposal = await ctx.db
    .query("syncMembershipProposals")
    .withIndex("by_vault_parent_and_state", (query) =>
      query
        .eq("vaultId", context.vault._id)
        .eq("parentMembershipEpoch", context.vault.membershipEpoch)
        .eq("state", "pending"),
    )
    .unique();
  const lockedEnrollment = currentProposal?.enrollmentRequestId === undefined
    ? null
    : await irrevocablePendingEnrollmentProposal(
        ctx,
        context.vault._id,
        currentProposal.enrollmentRequestId,
      ) === null
      ? null
      : await ctx.db
        .query("syncEnrollmentRequests")
        .withIndex("by_request_id", (query) =>
          query.eq("requestId", currentProposal.enrollmentRequestId!),
        )
        .unique();
  const rows = lockedEnrollment === null
      || activeRows.some((row) => row._id === lockedEnrollment._id)
    ? activeRows
    : [...activeRows, lockedEnrollment];
  if (rows.length > MAX_SESSION_SYNC_PENDING_ENROLLMENTS) return failure("CONFLICT");
  return success({
    kind: "enrollment_requests",
    vault: vaultCoordinates(context.vault),
    requests: rows.map((row) => ({
      requestId: row.requestId,
      deviceId: row.deviceId,
      name: row.name,
      keys: syncDevicePublicKeysSchema.parse(parseJson(row.keysJson)),
      pairingDigest: row.pairingDigest,
      pairingCode: row.pairingCode,
      pairingTranscript: syncEnrollmentPairingTranscriptSchema.parse(
        parseJson(row.pairingTranscriptJson),
      ),
      createdAt: encodeSyncUint64(BigInt(row.createdAt)),
      expiresAt: encodeSyncUint64(BigInt(row.expiresAt)),
    })),
  });
}

async function admitMembershipProposal(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "admit_membership_proposal" }>,
  requestDigest: string,
  now: number,
): Promise<SessionSyncBackendResult> {
  if (request.proposalKind === "enrollment") {
    const enrollment = await ctx.db
      .query("syncEnrollmentRequests")
      .withIndex("by_request_id", (query) =>
        query.eq("requestId", request.enrollmentRequestId!),
      )
      .unique();
    if (
      enrollment === null
      || enrollment.vaultId !== context.vault._id
      || enrollment.organizationId !== context.vault.organizationId
      || enrollment.ownerUserId !== context.vault.ownerUserId
      || enrollment.state !== "pending"
      || enrollment.expiresAt <= now
      || enrollment.pairingDigest !== request.pairingDigest
    ) return failure(enrollment?.state === "expired" ? "GRANT_EXPIRED" : "NOT_FOUND");
    const currentHeadRow = await ctx.db
      .query("syncMembershipHeads")
      .withIndex("by_vault_and_digest", (query) =>
        query.eq("vaultId", context.vault._id).eq("statementDigest", context.vault.membershipDigest),
      )
      .unique();
    if (currentHeadRow === null) return failure("CONFLICT");
    const currentHead = syncMembershipHeadSchema.parse(parseJson(currentHeadRow.headJson));
    const requestedKeys = syncDevicePublicKeysSchema.parse(parseJson(enrollment.keysJson));
    const nextMembers = request.membershipCandidate.statement.members;
    const currentActiveMembers = currentHead.statement.members.filter(
      (member) => member.status === "active",
    );
    const joiningMember = nextMembers.find((member) => member.deviceId === enrollment.deviceId);
    if (
      request.membershipCandidate.statement.recoveryGeneration
        !== context.vault.recoveryGeneration
      || request.membershipCandidate.statement.enrollmentPairingDigest
        !== enrollment.pairingDigest
      || joiningMember === undefined
      || joiningMember.status !== "active"
      || joiningMember.name !== enrollment.name
      || canonicalSessionSyncJson(joiningMember.keys) !== canonicalSessionSyncJson(requestedKeys)
      || nextMembers.length !== currentActiveMembers.length + 1
      || currentActiveMembers.some((currentMember) => {
        const nextMember = nextMembers.find(
          (member) => member.deviceId === currentMember.deviceId,
        );
        return nextMember === undefined
          || canonicalSessionSyncJson(nextMember) !== canonicalSessionSyncJson(currentMember);
      })
    ) return failure("CONFLICT");
  }
  return await updateMembership(ctx, context, request, requestDigest, now);
}

async function approveEnrollment(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "approve_enrollment" }>,
  requestDigest: string,
  now: number,
): Promise<SessionSyncBackendResult> {
  const enrollment = await ctx.db
    .query("syncEnrollmentRequests")
    .withIndex("by_request_id", (query) => query.eq("requestId", request.requestId))
    .unique();
  if (
    enrollment === null
    || enrollment.vaultId !== context.vault._id
    || enrollment.organizationId !== context.vault.organizationId
    || enrollment.ownerUserId !== context.vault.ownerUserId
    || enrollment.pairingDigest !== request.pairingDigest
  ) return failure("NOT_FOUND");
  if (enrollment.state === "approved") {
    return enrollment.approvedMembershipEpoch === request.membershipHead.statement.membershipEpoch
      && context.vault.membershipDigest === request.membershipHead.statementDigest
      && enrollment.approvalRequestDigest === request.membershipHead.statementDigest
      ? success({
        kind: "enrollment_approved",
        vault: vaultCoordinates(context.vault),
        requestId: enrollment.requestId,
        membershipEpoch: enrollment.approvedMembershipEpoch,
      })
      : failure("CONFLICT");
  }
  const signedProposal = enrollment.state === "pending" && enrollment.expiresAt <= now
    ? await irrevocablePendingEnrollmentProposal(ctx, context.vault._id, enrollment.requestId)
    : null;
  if (
    enrollment.state === "expired"
    || (enrollment.expiresAt <= now && signedProposal === null)
  ) {
    if (enrollment.state !== "expired") {
      await ctx.db.patch(enrollment._id, { state: "expired", updatedAt: now });
    }
    return failure("GRANT_EXPIRED");
  }
  const currentHeadRow = await ctx.db
    .query("syncMembershipHeads")
    .withIndex("by_vault_and_digest", (query) =>
      query.eq("vaultId", context.vault._id).eq("statementDigest", context.vault.membershipDigest),
    )
    .unique();
  if (currentHeadRow === null) return failure("CONFLICT");
  const currentHead = syncMembershipHeadSchema.parse(parseJson(currentHeadRow.headJson));
  const requestedKeys = syncDevicePublicKeysSchema.parse(parseJson(enrollment.keysJson));
  const nextMembers = request.membershipHead.statement.members;
  const currentActiveMembers = currentHead.statement.members.filter((member) => member.status === "active");
  const joiningMember = nextMembers.find((member) => member.deviceId === enrollment.deviceId);
  if (
    request.membershipHead.statement.recoveryGeneration !== context.vault.recoveryGeneration
    || request.membershipHead.statement.enrollmentPairingDigest !== enrollment.pairingDigest
    || joiningMember === undefined
    || joiningMember.status !== "active"
    || joiningMember.name !== enrollment.name
    || canonicalSessionSyncJson(joiningMember.keys) !== canonicalSessionSyncJson(requestedKeys)
    || nextMembers.length !== currentActiveMembers.length + 1
    || currentActiveMembers.some((currentMember) => {
      const nextMember = nextMembers.find((member) => member.deviceId === currentMember.deviceId);
      return nextMember === undefined
        || canonicalSessionSyncJson(nextMember) !== canonicalSessionSyncJson(currentMember);
    })
  ) return failure("CONFLICT");
  const accepted = await updateMembership(ctx, context, request, requestDigest, now);
  if (!accepted.ok) return accepted;
  const acceptedResponse = sessionSyncBackendResponseSchema.parse(parseJson(accepted.responseJson));
  if (acceptedResponse.kind === "membership_pending") return accepted;
  if (acceptedResponse.kind !== "membership_accepted") {
    throw new Error("enrollment membership transition returned an impossible success kind");
  }
  await ctx.db.patch(enrollment._id, {
    state: "approved",
    approvedMembershipEpoch: request.membershipHead.statement.membershipEpoch,
    approvalRequestDigest: request.membershipHead.statementDigest,
    purgeAfter: now + SESSION_SYNC_ENROLLMENT_RETENTION_MS,
    updatedAt: now,
  });
  return success({
    kind: "enrollment_approved",
    vault: vaultCoordinates(context.vault),
    requestId: enrollment.requestId,
    membershipEpoch: request.membershipHead.statement.membershipEpoch,
  });
}

async function establishBoot(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "establish_boot" | "heartbeat" }>,
  requestDigest: string,
  now: number,
): Promise<SessionSyncBackendResult> {
  const currentGeneration = context.device.bootGeneration ?? "0";
  const currentSequence = context.device.heartbeatSequence ?? "0";
  let acceptedGeneration: string;
  let acceptedSequence: string;
  if (request.operation === "heartbeat") {
    if (
      context.device.bootId !== request.bootId
      || currentGeneration !== request.bootGeneration
      || (request.heartbeatSequence !== currentSequence
        && request.heartbeatSequence !== nextRequiredSyncUint64(currentSequence))
    ) return failure("STALE_BOOT");
    acceptedGeneration = request.bootGeneration;
    acceptedSequence = request.heartbeatSequence;
  } else {
    const exactReplay = context.device.bootId === request.bootId
      && context.device.bootEstablishRequestDigest === requestDigest;
    if (exactReplay) {
      if (request.bootGeneration !== undefined && request.bootGeneration !== currentGeneration) {
        return failure("STALE_BOOT");
      }
      acceptedGeneration = currentGeneration;
      acceptedSequence = currentSequence;
    } else {
      acceptedGeneration = nextRequiredSyncUint64(currentGeneration);
      acceptedSequence = "1";
      if (
        context.device.bootId === request.bootId
        || (request.bootGeneration !== undefined && request.bootGeneration !== acceptedGeneration)
        || request.heartbeatSequence !== "1"
      ) return failure("STALE_BOOT");
    }
  }
  if (acceptedSequence !== currentSequence || context.device.bootId !== request.bootId) {
    await ctx.db.patch(context.device._id, {
      bootId: request.bootId,
      bootGeneration: acceptedGeneration,
      ...(request.operation === "establish_boot" ? { bootEstablishRequestDigest: requestDigest } : {}),
      heartbeatSequence: acceptedSequence,
      lastHeartbeatAt: now,
      updatedAt: now,
    });
  }
  return success({
    kind: "boot_current",
    vault: vaultCoordinates(context.vault),
    bootGeneration: acceptedGeneration,
    bootId: request.bootId,
    heartbeatSequence: acceptedSequence,
  });
}

async function reserveSession(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "reserve_session" }>,
  now: number,
): Promise<SessionSyncBackendResult> {
  const boot = await currentBoot(context);
  if ("ok" in boot) return boot;
  const existing = await ctx.db
    .query("syncSessionEntries")
    .withIndex("by_vault_and_session", (query) =>
      query.eq("vaultId", context.vault._id).eq("sessionId", request.sessionId),
    )
    .unique();
  if (existing !== null) {
    if (
      existing.state === "reserved"
      && existing.creationGrantDigest === request.creationGrantDigest
      && existing.originDeviceId === context.device._id
    ) {
      if (existing.creationGrantExpiresAt < now) return failure("GRANT_EXPIRED");
      return success({
        kind: "session_reserved",
        vault: vaultCoordinates(context.vault),
        creationGrantDigest: existing.creationGrantDigest,
        directoryOrdinal: existing.directoryOrdinal,
        expiresAt: encodeSyncUint64(BigInt(existing.creationGrantExpiresAt)),
        sessionId: existing.sessionId,
      });
    }
    return failure(existing.state === "retired" || existing.state === "tombstone" ? "RETIRED" : "CONFLICT");
  }
  if (context.vault.directorySessionCount >= MAX_SYNC_DIRECTORY_SESSIONS) {
    return failure("DIRECTORY_LIMIT");
  }
  if (decodeSyncUint64(context.vault.nextDirectoryOrdinal)
    >= BigInt(MAX_SYNC_LIFETIME_DIRECTORY_IDENTITIES)) {
    return failure("MAINTENANCE_REQUIRED");
  }
  const ownedStates = await Promise.all(
    (["reserved", "active", "tombstone"] as const).map(async (state) =>
      await ctx.db
        .query("syncSessionEntries")
        .withIndex("by_origin_and_state", (query) =>
          query.eq("originDeviceId", context.device._id).eq("state", state),
        )
        .collect(),
    ),
  );
  if (ownedStates.reduce((count, rows) => count + rows.length, 0) >= MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE) {
    return failure("DIRECTORY_LIMIT");
  }
  const directoryOrdinal = nextRequiredSyncUint64(context.vault.nextDirectoryOrdinal);
  const expiresAt = now + SESSION_SYNC_CREATION_GRANT_TTL_MS;
  await ctx.db.insert("syncSessionEntries", {
    vaultId: context.vault._id,
    organizationId: context.vault.organizationId,
    ownerUserId: context.vault.ownerUserId,
    sessionId: request.sessionId,
    originDeviceId: context.device._id,
    originDevicePublicId: context.device.deviceId,
    directoryOrdinal,
    directoryOrdinalOrderKey: syncUint64OrderKey(directoryOrdinal),
    state: "reserved",
    creationGrantDigest: request.creationGrantDigest,
    creationGrantExpiresAt: expiresAt,
    mirrorEpoch: "1",
    writerGeneration: "0",
    currentSequence: "0",
    currentSourceRevision: "0",
    currentKeyEpoch: context.vault.rootKeyEpoch,
    streamActive: false,
    latestDirectoryVersion: "0",
    latestDirectoryVersionOrderKey: syncUint64OrderKey("0"),
    retainedEventCount: 0,
    retainedCiphertextBytes: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(context.vault._id, {
    nextDirectoryOrdinal: directoryOrdinal,
    directorySessionCount: context.vault.directorySessionCount + 1,
    updatedAt: now,
  });
  return success({
    kind: "session_reserved",
    vault: vaultCoordinates(context.vault),
    creationGrantDigest: request.creationGrantDigest,
    directoryOrdinal,
    expiresAt: encodeSyncUint64(BigInt(expiresAt)),
    sessionId: request.sessionId,
  });
}

async function acquireWriter(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "acquire_writer" }>,
  now: number,
): Promise<SessionSyncBackendResult> {
  const boot = await currentBoot(context);
  if ("ok" in boot) return boot;
  if (request.bootId !== boot.bootId || request.bootGeneration !== boot.bootGeneration) {
    return failure("STALE_BOOT");
  }
  const entry = await ctx.db
    .query("syncSessionEntries")
    .withIndex("by_vault_and_session", (query) =>
      query.eq("vaultId", context.vault._id).eq("sessionId", request.sessionId),
    )
    .unique();
  if (entry === null || entry.originDeviceId !== context.device._id) return failure("NOT_FOUND");
  if (entry.state === "retired" || entry.state === "tombstone") return failure("RETIRED");
  if (entry.state === "reserved" && entry.creationGrantExpiresAt < now) return failure("GRANT_EXPIRED");
  if (request.acknowledgedMirrorEpoch !== entry.mirrorEpoch) return failure("STALE_MIRROR");
  const exactAck = request.acknowledgedSequence === entry.currentSequence
    && request.acknowledgedDigest === (entry.currentDigest ?? null);
  if (!exactAck) {
    if (compareSyncUint64(request.acknowledgedSequence, entry.currentSequence) >= 0) {
      return failure("CONFLICT");
    }
    const acknowledgedEvent = await ctx.db
      .query("syncSessionEvents")
      .withIndex("by_session_and_sequence", (query) =>
        query
          .eq("sessionEntryId", entry._id)
          .eq("mirrorEpoch", entry.mirrorEpoch)
          .eq("syncSequence", request.acknowledgedSequence),
      )
      .unique();
    if (acknowledgedEvent === null || acknowledgedEvent.ciphertextDigest !== request.acknowledgedDigest) {
      return failure("CONFLICT");
    }
    return success({
      kind: "reconcile_required",
      vault: vaultCoordinates(context.vault),
      ciphertextDigest: entry.currentDigest,
      mirrorEpoch: entry.mirrorEpoch,
      sourceRevision: entry.currentSourceRevision,
      syncSequence: entry.currentSequence,
    });
  }
  if (
    entry.writerBootId === boot.bootId
    && entry.writerBootGeneration === boot.bootGeneration
    && entry.writerGeneration !== "0"
  ) {
    return success({
      kind: "writer_acquired",
      vault: vaultCoordinates(context.vault),
      bootGeneration: boot.bootGeneration,
      bootId: boot.bootId,
      mirrorEpoch: entry.mirrorEpoch,
      writerGeneration: entry.writerGeneration,
    });
  }
  const writerGeneration = nextRequiredSyncUint64(entry.writerGeneration);
  await ctx.db.patch(entry._id, {
    writerGeneration,
    writerBootId: boot.bootId,
    writerBootGeneration: boot.bootGeneration,
    updatedAt: now,
  });
  return success({
    kind: "writer_acquired",
    vault: vaultCoordinates(context.vault),
    bootGeneration: boot.bootGeneration,
    bootId: boot.bootId,
    mirrorEpoch: entry.mirrorEpoch,
    writerGeneration,
  });
}

type EventPrefixPruneDelta = Readonly<{ bytes: number; events: number }>;
type EventPrefixPrunePlan = Readonly<{
  sufficient: boolean;
  changeFloorVersion: string;
  retainedCiphertextBytes: number;
  retainedEventCount: number;
  changes: readonly Doc<"syncDirectoryChanges">[];
  events: readonly Doc<"syncSessionEvents">[];
  entryDeltas: ReadonlyMap<Id<"syncSessionEntries">, EventPrefixPruneDelta>;
}>;

function eventQuotaFits(
  vault: Doc<"syncVaults">,
  retainedEventCount: number,
  retainedCiphertextBytes: number,
  neededCiphertextBytes: number,
): boolean {
  return retainedEventCount + 1 <= MAX_SYNC_RETAINED_EVENTS
    && retainedCiphertextBytes
      + vault.compatibilityEvidenceCiphertextBytes
      + neededCiphertextBytes <= MAX_SYNC_RETAINED_CIPHERTEXT_BYTES;
}

async function planEventPrefixPrune(
  ctx: MutationCtx,
  vault: Doc<"syncVaults">,
  neededCiphertextBytes: number,
  now: number,
): Promise<EventPrefixPrunePlan | null> {
  let retainedCiphertextBytes = vault.retainedCiphertextBytes;
  let retainedEventCount = vault.retainedEventCount;
  if (eventQuotaFits(vault, retainedEventCount, retainedCiphertextBytes, neededCiphertextBytes)) {
    return {
      sufficient: true,
      changeFloorVersion: vault.changeFloorVersion,
      retainedCiphertextBytes,
      retainedEventCount,
      changes: [],
      events: [],
      entryDeltas: new Map(),
    };
  }
  const pins = await ctx.db
    .query("syncSnapshotPins")
    .withIndex("by_vault_and_expiry", (query) =>
      query.eq("vaultId", vault._id).gt("expiresAt", now),
    )
    .collect();
  let pruneThrough: string | undefined;
  for (const pin of pins) {
    if (pruneThrough === undefined || compareSyncUint64(pin.snapshotVersion, pruneThrough) < 0) {
      pruneThrough = pin.snapshotVersion;
    }
  }
  const changes = await ctx.db
    .query("syncDirectoryChanges")
    .withIndex("by_vault_and_version", (query) => query.eq("vaultId", vault._id))
    .order("asc")
    .take(256);
  let floor = vault.changeFloorVersion;
  const plannedChanges = [];
  const plannedEvents = [];
  const entryDeltas = new Map<Id<"syncSessionEntries">, { bytes: number; events: number }>();
  for (const change of changes) {
    if (pruneThrough !== undefined && compareSyncUint64(change.directoryVersion, pruneThrough) > 0) break;
    plannedChanges.push(change);
    floor = change.directoryVersion;
    if (change.eventId !== undefined) {
      const event = await ctx.db.get(change.eventId);
      if (event === null) throw new Error("directory change references missing session event");
      plannedEvents.push(event);
      retainedCiphertextBytes -= event.ciphertextBytes;
      retainedEventCount -= 1;
      const prior = entryDeltas.get(event.sessionEntryId) ?? { bytes: 0, events: 0 };
      entryDeltas.set(event.sessionEntryId, {
        bytes: prior.bytes + event.ciphertextBytes,
        events: prior.events + 1,
      });
    }
    if (eventQuotaFits(vault, retainedEventCount, retainedCiphertextBytes, neededCiphertextBytes)) {
      break;
    }
  }
  if (retainedCiphertextBytes < 0 || retainedEventCount < 0) {
    throw new Error("vault event retention counters are incoherent");
  }
  const sufficient = eventQuotaFits(
    vault,
    retainedEventCount,
    retainedCiphertextBytes,
    neededCiphertextBytes,
  );
  if (!sufficient && plannedChanges.length === 0) return null;
  return {
    sufficient,
    changeFloorVersion: floor,
    retainedCiphertextBytes,
    retainedEventCount,
    changes: plannedChanges,
    events: plannedEvents,
    entryDeltas,
  };
}

async function applyEventPrefixPrune(
  ctx: MutationCtx,
  vault: Doc<"syncVaults">,
  plan: EventPrefixPrunePlan,
  now: number,
): Promise<void> {
  for (const change of plan.changes) await ctx.db.delete(change._id);
  for (const event of plan.events) await ctx.db.delete(event._id);
  for (const [entryId, delta] of plan.entryDeltas) {
    const entry = await ctx.db.get(entryId);
    if (
      entry === null
      || entry.retainedCiphertextBytes < delta.bytes
      || entry.retainedEventCount < delta.events
    ) throw new Error("session event retention counters are incoherent");
    await ctx.db.patch(entry._id, {
      retainedCiphertextBytes: entry.retainedCiphertextBytes - delta.bytes,
      retainedEventCount: entry.retainedEventCount - delta.events,
    });
  }
  if (plan.changes.length > 0) {
    await ctx.db.patch(vault._id, {
      changeFloorVersion: plan.changeFloorVersion,
      retainedCiphertextBytes: plan.retainedCiphertextBytes,
      retainedEventCount: plan.retainedEventCount,
      updatedAt: now,
    });
  }
}

async function publishSession(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "publish_session" }>,
  now: number,
): Promise<SessionSyncBackendResult> {
  const boot = await currentBoot(context);
  if ("ok" in boot) return boot;
  const envelope = request.envelope;
  const entry = await ctx.db
    .query("syncSessionEntries")
    .withIndex("by_vault_and_session", (query) =>
      query.eq("vaultId", context.vault._id).eq("sessionId", envelope.header.sessionId),
    )
    .unique();
  if (entry === null) return failure("NOT_FOUND");
  const decision = decideSessionPublication({
    ...entry,
    originDeviceId: entry.originDevicePublicId,
  }, envelope, {
    expectedVault: {
      tenantId: context.vault.tenantId,
      organizationId: context.vault.organizationCoordinate,
      ownerUserId: context.vault.ownerUserCoordinate,
      vaultId: context.vault.vaultId,
      vaultGeneration: context.vault.vaultGeneration,
    },
    currentDeviceId: context.device.deviceId,
    currentBootId: boot.bootId,
    currentBootGeneration: boot.bootGeneration,
    currentMembershipEpoch: context.vault.membershipEpoch,
    currentRootKeyEpoch: context.vault.rootKeyEpoch,
    now,
  });
  if (decision.kind === "reject") return failure(decision.code);
  if (decision.kind === "replay") {
    const event = await ctx.db
      .query("syncSessionEvents")
      .withIndex("by_session_and_sequence", (query) =>
        query
          .eq("sessionEntryId", entry._id)
          .eq("mirrorEpoch", envelope.header.mirrorEpoch)
          .eq("syncSequence", envelope.header.syncSequence),
      )
      .unique();
    let replayEnvelope: unknown;
    let replayDirectoryVersion: string;
    let replayObservedAt: number;
    if (event !== null) {
      if (
        event.ciphertextDigest !== envelope.ciphertextDigest
        || event.envelopeJson !== canonicalSessionSyncJson(envelope)
      ) return failure("CONFLICT");
      replayEnvelope = parseJson(event.envelopeJson);
      replayDirectoryVersion = event.directoryVersion;
      replayObservedAt = event.observedAt;
    } else {
      const retainedHead = await ctx.db
        .query("syncSessionHeads")
        .withIndex("by_session_entry", (query) => query.eq("sessionEntryId", entry._id))
        .unique();
      if (
        retainedHead === null
        || retainedHead.mirrorEpoch !== envelope.header.mirrorEpoch
        || retainedHead.writerGeneration !== envelope.header.writerGeneration
        || retainedHead.bootId !== envelope.header.bootId
        || retainedHead.bootGeneration !== envelope.header.bootGeneration
        || retainedHead.syncSequence !== envelope.header.syncSequence
        || retainedHead.sourceRevision !== envelope.header.sourceRevision
        || retainedHead.keyEpoch !== envelope.header.keyEpoch
        || retainedHead.ciphertextDigest !== envelope.ciphertextDigest
        || retainedHead.envelopeJson !== canonicalSessionSyncJson(envelope)
      ) return failure("CONFLICT");
      replayEnvelope = parseJson(retainedHead.envelopeJson);
      replayDirectoryVersion = retainedHead.directoryVersion;
      replayObservedAt = retainedHead.observedAt;
    }
    const accepted = acceptedSessionHeadSchema.parse({
      envelope: replayEnvelope,
      createdDirectoryVersion: entry.createdDirectoryVersion,
      directoryVersion: replayDirectoryVersion,
      serverObservedAt: encodeSyncUint64(BigInt(replayObservedAt)),
    });
    return success({ kind: "session_accepted", accepted, replay: true });
  }
  const oldHead = await ctx.db
    .query("syncSessionHeads")
    .withIndex("by_session_entry", (query) => query.eq("sessionEntryId", entry._id))
    .unique();
  const headDelta = envelope.ciphertextBytes - (oldHead?.ciphertextBytes ?? 0);
  const neededBytes = envelope.ciphertextBytes + headDelta;
  const pruned = await planEventPrefixPrune(ctx, context.vault, neededBytes, now);
  if (pruned === null) return failure("QUOTA_EXCEEDED");
  if (!pruned.sufficient) {
    await applyEventPrefixPrune(ctx, context.vault, pruned, now);
    return failure("RATE_LIMITED", 1);
  }
  const streamActive = nextStreamState(entry.streamActive, envelope.header.eventKind);
  const activeStreamCount = context.vault.activeStreamCount
    + (streamActive ? 1 : 0)
    - (entry.streamActive ? 1 : 0);
  const quota = quotaFailure({
    activeDevices: context.vault.activeDeviceCount,
    directorySessions: context.vault.directorySessionCount,
    locallyOwnedSessions: 0,
    activeStreams: activeStreamCount,
    retainedEvents: pruned.retainedEventCount + 1,
    retainedCiphertextBytes: pruned.retainedCiphertextBytes
      + context.vault.compatibilityEvidenceCiphertextBytes
      + neededBytes,
  });
  if (quota !== null) return failure(quota);
  const directoryVersion = nextRequiredSyncUint64(context.vault.directoryVersion);
  const createdDirectoryVersion = entry.createdDirectoryVersion ?? directoryVersion;
  const envelopeJson = canonicalSessionSyncJson(envelope);
  const entryDelta = pruned.entryDeltas.get(entry._id) ?? { bytes: 0, events: 0 };
  if (
    entry.retainedCiphertextBytes < entryDelta.bytes
    || entry.retainedEventCount < entryDelta.events
  ) throw new Error("published session retention counters are incoherent");
  await applyEventPrefixPrune(ctx, context.vault, pruned, now);
  const eventId = await ctx.db.insert("syncSessionEvents", {
    vaultId: context.vault._id,
    sessionEntryId: entry._id,
    sessionId: entry.sessionId,
    directoryVersion,
    directoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
    mirrorEpoch: envelope.header.mirrorEpoch,
    syncSequence: envelope.header.syncSequence,
    sourceRevision: envelope.header.sourceRevision,
    keyEpoch: envelope.header.keyEpoch,
    eventKind: envelope.header.eventKind,
    ciphertextDigest: envelope.ciphertextDigest,
    ciphertextBytes: envelope.ciphertextBytes,
    envelopeJson,
    observedAt: now,
  });
  if (oldHead === null) {
    await ctx.db.insert("syncSessionHeads", {
      vaultId: context.vault._id,
      sessionEntryId: entry._id,
      sessionId: entry.sessionId,
      directoryOrdinal: entry.directoryOrdinal,
      directoryVersion,
      mirrorEpoch: envelope.header.mirrorEpoch,
      writerGeneration: envelope.header.writerGeneration,
      bootId: envelope.header.bootId,
      bootGeneration: envelope.header.bootGeneration,
      syncSequence: envelope.header.syncSequence,
      sourceRevision: envelope.header.sourceRevision,
      keyEpoch: envelope.header.keyEpoch,
      ciphertextDigest: envelope.ciphertextDigest,
      ciphertextBytes: envelope.ciphertextBytes,
      envelopeJson,
      observedAt: now,
    });
  } else {
    await ctx.db.patch(oldHead._id, {
      directoryVersion,
      mirrorEpoch: envelope.header.mirrorEpoch,
      writerGeneration: envelope.header.writerGeneration,
      bootId: envelope.header.bootId,
      bootGeneration: envelope.header.bootGeneration,
      syncSequence: envelope.header.syncSequence,
      sourceRevision: envelope.header.sourceRevision,
      keyEpoch: envelope.header.keyEpoch,
      ciphertextDigest: envelope.ciphertextDigest,
      ciphertextBytes: envelope.ciphertextBytes,
      envelopeJson,
      observedAt: now,
    });
  }
  await ctx.db.insert("syncDirectoryChanges", {
    vaultId: context.vault._id,
    directoryVersion,
    directoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
    kind: "upsert",
    sessionEntryId: entry._id,
    eventId,
    createdAt: now,
  });
  await ctx.db.patch(entry._id, {
    state: "active",
    ...(entry.creationGrantConsumedAt === undefined ? { creationGrantConsumedAt: now } : {}),
    createdDirectoryVersion,
    currentSequence: envelope.header.syncSequence,
    currentDigest: envelope.ciphertextDigest,
    currentSourceRevision: envelope.header.sourceRevision,
    currentKeyEpoch: envelope.header.keyEpoch,
    streamActive,
    latestDirectoryVersion: directoryVersion,
    latestDirectoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
    retainedEventCount: entry.retainedEventCount - entryDelta.events + 1,
    retainedCiphertextBytes: entry.retainedCiphertextBytes - entryDelta.bytes + neededBytes,
    updatedAt: now,
  });
  await ctx.db.patch(context.vault._id, {
    directoryVersion,
    directoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
    changeFloorVersion: pruned.changeFloorVersion,
    activeStreamCount,
    retainedEventCount: pruned.retainedEventCount + 1,
    retainedCiphertextBytes: pruned.retainedCiphertextBytes + neededBytes,
    updatedAt: now,
  });
  const accepted = acceptedSessionHeadSchema.parse({
    envelope,
    createdDirectoryVersion,
    directoryVersion,
    serverObservedAt: encodeSyncUint64(BigInt(now)),
  });
  return success({ kind: "session_accepted", accepted, replay: false });
}

async function deleteSession(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "delete_session" }>,
  now: number,
): Promise<SessionSyncBackendResult> {
  const boot = await currentBoot(context);
  if ("ok" in boot) return boot;
  const entry = await ctx.db
    .query("syncSessionEntries")
    .withIndex("by_vault_and_session", (query) =>
      query.eq("vaultId", context.vault._id).eq("sessionId", request.sessionId),
    )
    .unique();
  if (entry === null || entry.originDeviceId !== context.device._id) return failure("NOT_FOUND");
  if (entry.state === "retired") return failure("RETIRED");
  if (entry.state === "tombstone") {
    const tombstone = await ctx.db
      .query("syncSessionTombstones")
      .withIndex("by_session_entry", (query) => query.eq("sessionEntryId", entry._id))
      .unique();
    if (tombstone !== null && tombstone.tombstoneDigest === request.tombstoneDigest) {
      return success({ kind: "session_deleted", replay: true, tombstone: parseJson(tombstone.tombstoneJson) });
    }
    return failure("RETIRED");
  }
  if (
    request.originDeviceId !== context.device.deviceId
    || request.membershipEpoch !== context.vault.membershipEpoch
    || request.keyEpoch !== context.vault.rootKeyEpoch
    || request.mirrorEpoch !== entry.mirrorEpoch
    || request.writerGeneration !== entry.writerGeneration
    || request.bootId !== boot.bootId
    || request.bootGeneration !== boot.bootGeneration
    || request.bootId !== entry.writerBootId
    || request.bootGeneration !== entry.writerBootGeneration
  ) return failure("STALE_WRITER");
  if (
    request.syncSequence !== nextRequiredSyncUint64(entry.currentSequence)
    || request.previousDigest !== entry.currentDigest
  ) return failure("SEQUENCE_GAP");
  if (compareSyncUint64(request.sourceRevision, entry.currentSourceRevision) <= 0) {
    return failure("STALE_REVISION");
  }
  const directoryVersion = nextRequiredSyncUint64(context.vault.directoryVersion);
  const serverObservedAt = encodeSyncUint64(BigInt(now));
  const purgeAfter = encodeSyncUint64(BigInt(now + SESSION_SYNC_TOMBSTONE_RETENTION_MS));
  if (entry.createdDirectoryVersion === undefined) return failure("CONFLICT");
  const tombstone = sessionSyncTombstoneSchema.parse({
    protocol: "oprte.session-sync/v1",
    recordKind: "tombstone",
    tenantId: context.vault.tenantId,
    organizationId: context.vault.organizationCoordinate,
    ownerUserId: context.vault.ownerUserCoordinate,
    vaultId: context.vault.vaultId,
    vaultGeneration: context.vault.vaultGeneration,
    membershipEpoch: context.vault.membershipEpoch,
    originDeviceId: context.device.deviceId,
    sessionId: entry.sessionId,
    mirrorEpoch: entry.mirrorEpoch,
    writerGeneration: entry.writerGeneration,
    bootId: boot.bootId,
    bootGeneration: boot.bootGeneration,
    directoryOrdinal: entry.directoryOrdinal,
    createdDirectoryVersion: entry.createdDirectoryVersion,
    directoryVersion,
    keyEpoch: request.keyEpoch,
    syncSequence: request.syncSequence,
    sourceRevision: request.sourceRevision,
    previousDigest: request.previousDigest,
    tombstoneDigest: request.tombstoneDigest,
    serverObservedAt,
    purgeAfter,
  });
  const tombstoneId = await ctx.db.insert("syncSessionTombstones", {
    vaultId: context.vault._id,
    sessionEntryId: entry._id,
    sessionId: entry.sessionId,
    directoryOrdinal: entry.directoryOrdinal,
    directoryVersion,
    directoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
    tombstoneDigest: request.tombstoneDigest,
    tombstoneJson: canonicalSessionSyncJson(tombstone),
    purgeAfter: now + SESSION_SYNC_TOMBSTONE_RETENTION_MS,
    createdAt: now,
  });
  await ctx.db.insert("syncDirectoryChanges", {
    vaultId: context.vault._id,
    directoryVersion,
    directoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
    kind: "tombstone",
    sessionEntryId: entry._id,
    tombstoneId,
    createdAt: now,
  });
  await ctx.db.patch(entry._id, {
    state: "tombstone",
    currentSequence: request.syncSequence,
    currentDigest: request.tombstoneDigest,
    currentSourceRevision: request.sourceRevision,
    streamActive: false,
    latestDirectoryVersion: directoryVersion,
    latestDirectoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
    tombstoneDirectoryVersion: directoryVersion,
    updatedAt: now,
  });
  await ctx.db.patch(context.vault._id, {
    directoryVersion,
    directoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
    activeStreamCount: context.vault.activeStreamCount - (entry.streamActive ? 1 : 0),
    updatedAt: now,
  });
  return success({ kind: "session_deleted", replay: false, tombstone });
}

async function readMembership(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
): Promise<SessionSyncBackendResult> {
  const now = Date.now();
  const [head, wraps, manifestRows] = await Promise.all([
    ctx.db
      .query("syncMembershipHeads")
      .withIndex("by_vault_and_digest", (query) =>
        query.eq("vaultId", context.vault._id).eq("statementDigest", context.vault.membershipDigest),
      )
      .unique(),
    ctx.db
      .query("syncVaultRootWraps")
      .withIndex("by_vault_device_membership_and_epoch", (query) =>
        query
          .eq("vaultId", context.vault._id)
          .eq("deviceId", context.device._id)
          .eq("membershipEpoch", context.vault.membershipEpoch),
      )
      .collect(),
    ctx.db
      .query("syncVaultRootWraps")
      .withIndex("by_vault_and_membership", (query) =>
        query
          .eq("vaultId", context.vault._id)
          .eq("membershipEpoch", context.vault.membershipEpoch),
      )
      .take(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS + 1),
  ]);
  let proposal = await ctx.db
    .query("syncMembershipProposals")
    .withIndex("by_vault_parent_and_state", (query) =>
      query
        .eq("vaultId", context.vault._id)
        .eq("parentMembershipEpoch", context.vault.membershipEpoch)
        .eq("state", "pending"),
    )
    .unique();
  if (proposal !== null && proposal.expiresAt <= now) {
    const signerIntents = await ctx.db
      .query("syncMembershipSigningIntents")
      .withIndex("by_proposal", (query) => query.eq("proposalId", proposal!._id))
      .take(1);
    if (signerIntents.length === 0) {
      await deleteMembershipProposal(ctx, proposal);
      proposal = null;
    }
  }
  const currentWrap = wraps.find((wrap) => wrap.rootKeyEpoch === context.vault.rootKeyEpoch);
  const actualEpochs = wraps.map((wrap) => wrap.rootKeyEpoch)
    .sort((left, right) => compareSyncUint64(left, right));
  if (
    head === null
    || currentWrap === undefined
    || wraps.length !== context.vault.wrappedRootKeyEpochs.length
    || canonicalSessionSyncJson(actualEpochs)
      !== canonicalSessionSyncJson(context.vault.wrappedRootKeyEpochs)
    || wraps.some((wrap) => wrap.membershipEpoch !== context.vault.membershipEpoch)
    || manifestRows.length
      !== context.vault.activeDeviceCount * context.vault.wrappedRootKeyEpochs.length
    || manifestRows.length > MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS
  ) {
    return failure("CONFLICT");
  }
  const parsedHead = syncMembershipHeadSchema.parse(parseJson(head.headJson));
  const orderedMembers = parsedHead.statement.members.toSorted((left, right) =>
    compareSyncIdentifier(left.deviceId, right.deviceId)
  );
  const membershipDevices = await Promise.all(orderedMembers.map(async (member) =>
    await ctx.db
      .query("syncDevices")
      .withIndex("by_vault_and_device", (query) =>
        query.eq("vaultId", context.vault._id).eq("deviceId", member.deviceId),
      )
      .unique()
  ));
  if (membershipDevices.some((device, index) => {
    const member = orderedMembers[index];
    return device === null
      || member === undefined
      || device.organizationId !== context.vault.organizationId
      || device.ownerUserId !== context.vault.ownerUserId
      || device.deviceId !== member.deviceId
      || device.name !== member.name
      || device.status !== member.status
      || device.membershipEpoch !== context.vault.membershipEpoch
      || device.signingKeyId !== member.keys.signing.keyId
      || device.signingPublicKey !== member.keys.signing.publicKey
      || device.signingPublicKeyDigest !== member.keys.signing.publicKeyDigest
      || device.agreementKeyId !== member.keys.agreement.keyId
      || device.agreementPublicKey !== member.keys.agreement.publicKey
      || device.agreementPublicKeyDigest !== member.keys.agreement.publicKeyDigest;
  })) return failure("CONFLICT");
  const parsedWraps = wraps
    .sort((left, right) => compareSyncUint64(left.rootKeyEpoch, right.rootKeyEpoch))
    .map((wrap) => wrappedSyncVaultRootKeySchema.parse(parseJson(wrap.wrappedRootJson)));
  const rootWrapManifest = manifestRows
    .map((wrap) => wrappedSyncVaultRootKeySchema.parse(parseJson(wrap.wrappedRootJson)))
    .sort((left, right) => compareSyncIdentifier(
      `${left.context.recipientDeviceId}\u0000${syncUint64OrderKey(left.context.rootKeyEpoch)}`,
      `${right.context.recipientDeviceId}\u0000${syncUint64OrderKey(right.context.rootKeyEpoch)}`,
    ));
  return success({
    kind: "membership",
    head: parsedHead,
    wrappedRoot: wrappedSyncVaultRootKeySchema.parse(parseJson(currentWrap.wrappedRootJson)),
    wrappedRoots: parsedWraps,
    rootWrapManifest,
    devicePresence: orderedMembers.map((member, index) => ({
      deviceId: member.deviceId,
      connection: deviceConnectionState(
        member.status,
        membershipDevices[index]?.lastHeartbeatAt,
        now,
      ),
    })),
    ...(proposal === null
      ? {}
      : {
        proposal: await membershipProposalView(
          ctx,
          proposal,
          Math.floor(context.vault.activeDeviceCount / 2) + 1,
        ),
      }),
  });
}

async function rootKeyLinkPage(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "root_key_link_page" }>,
): Promise<SessionSyncBackendResult> {
  const beforeOrderKey = request.beforeChildRootKeyEpoch === undefined
    ? undefined
    : syncUint64OrderKey(request.beforeChildRootKeyEpoch);
  let cursorLink: ReturnType<typeof wrappedSyncVaultRootKeyLinkSchema.parse> | undefined;
  if (beforeOrderKey !== undefined) {
    const cursor = await ctx.db
      .query("syncVaultRootKeyLinks")
      .withIndex("by_vault_and_child_epoch", (query) =>
        query
          .eq("vaultId", context.vault._id)
          .eq("childRootKeyEpochOrderKey", beforeOrderKey),
      )
      .unique();
    if (cursor === null) return failure("CONFLICT");
    cursorLink = wrappedSyncVaultRootKeyLinkSchema.parse(parseJson(cursor.linkJson));
    if (
      cursor.childRootKeyEpoch !== cursorLink.context.childRootKeyEpoch
      || cursor.childRootKeyEpochOrderKey
        !== syncUint64OrderKey(cursorLink.context.childRootKeyEpoch)
      || cursor.parentRootKeyEpoch !== cursorLink.context.parentRootKeyEpoch
      || cursor.parentRootKeyEpochOrderKey
        !== syncUint64OrderKey(cursorLink.context.parentRootKeyEpoch)
      || cursor.linkDigest !== cursorLink.linkDigest
      || cursorLink.context.vaultId !== context.vault.vaultId
      || cursorLink.context.vaultGeneration !== context.vault.vaultGeneration
      || cursorLink.context.tenantId !== context.vault.tenantId
      || cursorLink.context.organizationId !== context.vault.organizationCoordinate
      || cursorLink.context.ownerUserId !== context.vault.ownerUserCoordinate
    ) throw new Error("stored root key link cursor failed its authenticated projection");
  }
  const rows = await ctx.db
    .query("syncVaultRootKeyLinks")
    .withIndex("by_vault_and_child_epoch", (query) => {
      const scoped = query.eq("vaultId", context.vault._id);
      return beforeOrderKey === undefined
        ? scoped
        : scoped.lt("childRootKeyEpochOrderKey", beforeOrderKey);
    })
    .order("desc")
    .take(request.pageSize + 1);
  const hasMore = rows.length > request.pageSize;
  const selected = rows.slice(0, request.pageSize);
  const links = selected.map((row) => {
    const link = wrappedSyncVaultRootKeyLinkSchema.parse(parseJson(row.linkJson));
    if (
      row.parentRootKeyEpoch !== link.context.parentRootKeyEpoch
      || row.parentRootKeyEpochOrderKey !== syncUint64OrderKey(link.context.parentRootKeyEpoch)
      || row.childRootKeyEpoch !== link.context.childRootKeyEpoch
      || row.childRootKeyEpochOrderKey !== syncUint64OrderKey(link.context.childRootKeyEpoch)
      || row.linkDigest !== link.linkDigest
      || link.context.vaultId !== context.vault.vaultId
      || link.context.vaultGeneration !== context.vault.vaultGeneration
      || link.context.tenantId !== context.vault.tenantId
      || link.context.organizationId !== context.vault.organizationCoordinate
      || link.context.ownerUserId !== context.vault.ownerUserCoordinate
    ) throw new Error("stored root key link failed its authenticated projection");
    return link;
  });
  for (let index = 1; index < links.length; index += 1) {
    if (
      links[index - 1]?.context.parentRootKeyEpoch
      !== links[index]?.context.childRootKeyEpoch
    ) throw new Error("stored root key link chain is discontinuous");
  }
  const first = links[0];
  if (cursorLink === undefined) {
    if (
      (first === undefined && context.vault.rootKeyEpoch !== "1")
      || (first !== undefined
        && first.context.childRootKeyEpoch !== context.vault.rootKeyEpoch)
    ) throw new Error("stored root key link chain does not begin at the current root");
  } else if (
    (first === undefined && cursorLink.context.parentRootKeyEpoch !== "1")
    || (first !== undefined
      && first.context.childRootKeyEpoch !== cursorLink.context.parentRootKeyEpoch)
  ) throw new Error("stored root key link chain is discontinuous across its page cursor");
  if (
    !hasMore
    && links.at(-1) !== undefined
    && links.at(-1)?.context.parentRootKeyEpoch !== "1"
  ) throw new Error("stored root key link chain does not terminate at the genesis root");
  return success({
    kind: "root_key_link_page",
    vault: vaultCoordinates(context.vault),
    links,
    hasMore,
    ...(hasMore
      ? { nextBeforeChildRootKeyEpoch: links.at(-1)?.context.childRootKeyEpoch }
      : {}),
  });
}

type MaterializedSnapshotEntry = Readonly<{
  directoryOrdinal: string;
  directoryOrdinalOrderKey: string;
  sessionId: string;
  entryJson: string;
}>;

async function deleteSnapshotPin(
  ctx: MutationCtx,
  pin: Doc<"syncSnapshotPins">,
): Promise<void> {
  const entries = await ctx.db
    .query("syncSnapshotEntries")
    .withIndex("by_pin", (query) => query.eq("snapshotPinId", pin._id))
    .take(MAX_SYNC_DIRECTORY_SESSIONS + 1);
  if (entries.length > MAX_SYNC_DIRECTORY_SESSIONS) {
    throw new Error("snapshot materialization exceeds its directory bound");
  }
  for (const entry of entries) await ctx.db.delete(entry._id);
  await ctx.db.delete(pin._id);
}

async function materializeSnapshot(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
): Promise<Readonly<{ ok: true; entries: readonly MaterializedSnapshotEntry[] }> | BackendFailure> {
  const [activeEntries, tombstoneEntries, reservedEntries, heads, tombstones] = await Promise.all([
    ctx.db
      .query("syncSessionEntries")
      .withIndex("by_vault_state_and_ordinal", (query) =>
        query.eq("vaultId", context.vault._id).eq("state", "active"),
      )
      .order("asc")
      .take(MAX_SYNC_DIRECTORY_SESSIONS + 1),
    ctx.db
      .query("syncSessionEntries")
      .withIndex("by_vault_state_and_ordinal", (query) =>
        query.eq("vaultId", context.vault._id).eq("state", "tombstone"),
      )
      .order("asc")
      .take(MAX_SYNC_DIRECTORY_SESSIONS + 1),
    ctx.db
      .query("syncSessionEntries")
      .withIndex("by_vault_state_and_ordinal", (query) =>
        query.eq("vaultId", context.vault._id).eq("state", "reserved"),
      )
      .order("asc")
      .take(MAX_SYNC_DIRECTORY_SESSIONS + 1),
    ctx.db
      .query("syncSessionHeads")
      .withIndex("by_vault_and_session", (query) => query.eq("vaultId", context.vault._id))
      .collect(),
    ctx.db
      .query("syncSessionTombstones")
      .withIndex("by_vault_and_session", (query) => query.eq("vaultId", context.vault._id))
      .collect(),
  ]);
  const activeOrigins = await Promise.all(
    activeEntries.map(async (entry) => await ctx.db.get(entry.originDeviceId)),
  );
  if (activeOrigins.some((origin) => origin === null)) return failure("CONFLICT");
  const originByEntry = new Map(activeEntries.map((entry, index) => [
    entry._id,
    activeOrigins[index],
  ]));
  const resetActiveEntries = activeEntries.filter((_entry, index) =>
    activeOrigins[index]?.status === "revoked"
  );
  if (resetActiveEntries.some((entry) =>
    entry.streamActive
    || entry.writerBootId !== undefined
    || entry.writerBootGeneration !== undefined)) return failure("CONFLICT");
  const directoryEntries = [...activeEntries, ...tombstoneEntries]
    .sort((left, right) => {
      const ordinal = compareSyncUint64(left.directoryOrdinal, right.directoryOrdinal);
      return ordinal === 0 ? compareSyncIdentifier(left.sessionId, right.sessionId) : ordinal;
    });
  if (
    directoryEntries.length + reservedEntries.length > MAX_SYNC_DIRECTORY_SESSIONS
    || directoryEntries.length + reservedEntries.length
      !== context.vault.directorySessionCount
    || reservedEntries.some((entry) =>
      entry.createdDirectoryVersion !== undefined
      || entry.retainedEventCount !== 0
      || entry.retainedCiphertextBytes !== 0)
  ) return failure("CONFLICT");

  const headsByEntry = new Map<string, Doc<"syncSessionHeads">>();
  for (const head of heads) {
    const key = head.sessionEntryId.toString();
    if (headsByEntry.has(key)) return failure("CONFLICT");
    headsByEntry.set(key, head);
  }
  const tombstonesByEntry = new Map<string, Doc<"syncSessionTombstones">>();
  for (const tombstone of tombstones) {
    const key = tombstone.sessionEntryId.toString();
    if (tombstonesByEntry.has(key)) return failure("CONFLICT");
    tombstonesByEntry.set(key, tombstone);
  }

  const entries: MaterializedSnapshotEntry[] = [];
  let priorOrdinal: string | undefined;
  for (const entry of directoryEntries) {
    if (
      entry.createdDirectoryVersion === undefined
      || compareSyncUint64(entry.createdDirectoryVersion, context.vault.directoryVersion) > 0
      || (priorOrdinal !== undefined && compareSyncUint64(entry.directoryOrdinal, priorOrdinal) <= 0)
    ) return failure("CONFLICT");
    priorOrdinal = entry.directoryOrdinal;

    let snapshotEntry: unknown;
    if (entry.state === "active") {
      const head = headsByEntry.get(entry._id.toString());
      const origin = originByEntry.get(entry._id);
      if (
        head === undefined
        || origin === undefined
        || origin === null
        || head.vaultId !== context.vault._id
        || head.sessionId !== entry.sessionId
        || head.directoryOrdinal !== entry.directoryOrdinal
        || head.ciphertextDigest !== entry.currentDigest
        || compareSyncUint64(head.directoryVersion, context.vault.directoryVersion) > 0
      ) return failure("CONFLICT");
      const accepted = acceptedSessionHeadSchema.parse({
        envelope: parseJson(head.envelopeJson),
        createdDirectoryVersion: entry.createdDirectoryVersion,
        directoryVersion: head.directoryVersion,
        serverObservedAt: encodeSyncUint64(BigInt(head.observedAt)),
      });
      snapshotEntry = origin.status === "revoked"
        ? {
            kind: "offline",
            accepted,
            reset: {
              kind: "mirror_reset",
              ...vaultCoordinates(context.vault),
              sessionId: entry.sessionId,
              directoryOrdinal: entry.directoryOrdinal,
              directoryVersion: entry.latestDirectoryVersion,
              mirrorEpoch: entry.mirrorEpoch,
              resetDigest: head.ciphertextDigest,
            },
          }
        : { kind: "head", accepted };
    } else {
      const tombstone = tombstonesByEntry.get(entry._id.toString());
      if (
        tombstone === undefined
        || tombstone.vaultId !== context.vault._id
        || tombstone.sessionId !== entry.sessionId
        || tombstone.directoryOrdinal !== entry.directoryOrdinal
        || compareSyncUint64(tombstone.directoryVersion, context.vault.directoryVersion) > 0
      ) return failure("CONFLICT");
      snapshotEntry = {
        kind: "tombstone",
        tombstone: sessionSyncTombstoneSchema.parse(parseJson(tombstone.tombstoneJson)),
      };
    }
    entries.push({
      directoryOrdinal: entry.directoryOrdinal,
      directoryOrdinalOrderKey: entry.directoryOrdinalOrderKey,
      sessionId: entry.sessionId,
      entryJson: canonicalSessionSyncJson(snapshotEntry),
    });
  }
  return { ok: true, entries };
}

async function beginSnapshot(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "begin_snapshot" }>,
  now: number,
): Promise<SessionSyncBackendResult> {
  const existing = await ctx.db
    .query("syncSnapshotPins")
    .withIndex("by_device_and_snapshot", (query) =>
      query.eq("deviceId", context.device._id).eq("snapshotId", request.snapshotId),
    )
    .unique();
  if (existing !== null) {
    if (existing.expiresAt < now) return failure("SNAPSHOT_EXPIRED");
    return success({
      kind: "snapshot_started",
      vault: vaultCoordinates(context.vault),
      expiresAt: encodeSyncUint64(BigInt(existing.expiresAt)),
      snapshotId: existing.snapshotId,
      snapshotVersion: existing.snapshotVersion,
    });
  }
  const activePins = await ctx.db
    .query("syncSnapshotPins")
    .withIndex("by_vault_and_expiry", (query) =>
      query.eq("vaultId", context.vault._id).gt("expiresAt", now),
    )
    .order("asc")
    .take(MAX_ACTIVE_SNAPSHOT_PINS_PER_VAULT);
  if (activePins.length >= MAX_ACTIVE_SNAPSHOT_PINS_PER_VAULT) {
    return failure(
      "RATE_LIMITED",
      Math.max(1, Math.min(300_000, (activePins[0]?.expiresAt ?? now + 1) - now)),
    );
  }
  const materialized = await materializeSnapshot(ctx, context);
  if (!materialized.ok) return materialized;
  const expiresAt = now + SESSION_SYNC_SNAPSHOT_TTL_MS;
  const pinId = await ctx.db.insert("syncSnapshotPins", {
    vaultId: context.vault._id,
    deviceId: context.device._id,
    snapshotId: request.snapshotId,
    snapshotVersion: context.vault.directoryVersion,
    snapshotVersionOrderKey: syncUint64OrderKey(context.vault.directoryVersion),
    expiresAt,
    createdAt: now,
  });
  for (const entry of materialized.entries) {
    await ctx.db.insert("syncSnapshotEntries", {
      vaultId: context.vault._id,
      snapshotPinId: pinId,
      ...entry,
      createdAt: now,
    });
  }
  return success({
    kind: "snapshot_started",
    vault: vaultCoordinates(context.vault),
    expiresAt: encodeSyncUint64(BigInt(expiresAt)),
    snapshotId: request.snapshotId,
    snapshotVersion: context.vault.directoryVersion,
  });
}

function vaultCoordinates(vault: Doc<"syncVaults">) {
  return {
    tenantId: vault.tenantId,
    organizationId: vault.organizationCoordinate,
    ownerUserId: vault.ownerUserCoordinate,
    vaultId: vault.vaultId,
    vaultGeneration: vault.vaultGeneration,
  };
}

async function snapshotPage(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "snapshot_page" }>,
  now: number,
): Promise<SessionSyncBackendResult> {
  const pin = await ctx.db
    .query("syncSnapshotPins")
    .withIndex("by_device_and_snapshot", (query) =>
      query.eq("deviceId", context.device._id).eq("snapshotId", request.snapshotId),
    )
    .unique();
  if (pin === null || pin.vaultId !== context.vault._id || pin.expiresAt < now) {
    return failure("SNAPSHOT_EXPIRED");
  }
  if (request.after !== undefined) {
    const cursorEntry = await ctx.db
      .query("syncSnapshotEntries")
      .withIndex("by_pin_and_ordinal", (query) =>
        query
          .eq("snapshotPinId", pin._id)
          .eq("directoryOrdinalOrderKey", syncUint64OrderKey(request.after!.directoryOrdinal))
          .eq("sessionId", request.after!.sessionId),
      )
      .unique();
    if (
      cursorEntry === null
      || cursorEntry.directoryOrdinal !== request.after.directoryOrdinal
    ) return failure("CONFLICT");
  }
  const storedEntries = await ctx.db
    .query("syncSnapshotEntries")
    .withIndex("by_pin_and_ordinal", (query) => {
      const byPin = query.eq("snapshotPinId", pin._id);
      return request.after === undefined
        ? byPin
        : byPin.gt(
          "directoryOrdinalOrderKey",
          syncUint64OrderKey(request.after.directoryOrdinal),
        );
    })
    .order("asc")
    .take(request.pageSize + 1);
  const selected = storedEntries.slice(0, request.pageSize + 1);
  const hasMore = selected.length > request.pageSize;
  const pageEntries = selected
    .slice(0, request.pageSize)
    .map((entry) => parseJson(entry.entryJson));
  const finalEntry = selected[Math.min(selected.length, request.pageSize) - 1];
  const page = sessionDirectorySnapshotPageSchema.parse({
    version: 1,
    vault: vaultCoordinates(context.vault),
    snapshotVersion: pin.snapshotVersion,
    ...(request.after === undefined ? {} : { after: request.after }),
    entries: pageEntries,
    complete: !hasMore,
    ...(hasMore && finalEntry !== undefined
      ? { nextCursor: { directoryOrdinal: finalEntry.directoryOrdinal, sessionId: finalEntry.sessionId } }
      : {}),
  });
  return success({ kind: "snapshot_page", page });
}

async function changePage(
  ctx: MutationCtx,
  context: AuthorizedSyncContext,
  request: Extract<SessionSyncBackendRequest, { operation: "change_page" }>,
): Promise<SessionSyncBackendResult> {
  if (
    compareSyncUint64(request.afterVersion, context.vault.changeFloorVersion) < 0
    || compareSyncUint64(request.afterVersion, context.vault.directoryVersion) > 0
  ) {
    return success({
      kind: "resnapshot_required",
      vault: vaultCoordinates(context.vault),
      floorVersion: context.vault.changeFloorVersion,
    });
  }
  const rows = await ctx.db
    .query("syncDirectoryChanges")
    .withIndex("by_vault_and_version", (query) =>
      query
        .eq("vaultId", context.vault._id)
        .gt("directoryVersionOrderKey", syncUint64OrderKey(request.afterVersion)),
    )
    .order("asc")
    .take(request.pageSize + 1);
  if (rows.length > 0 && rows[0]?.directoryVersion !== nextRequiredSyncUint64(request.afterVersion)) {
    return success({
      kind: "resnapshot_required",
      vault: vaultCoordinates(context.vault),
      floorVersion: context.vault.changeFloorVersion,
    });
  }
  const hasMore = rows.length > request.pageSize;
  const selected = rows.slice(0, request.pageSize);
  const changes = [];
  for (const row of selected) {
    if (row.kind === "upsert" && row.eventId !== undefined) {
      const event = await ctx.db.get(row.eventId);
      const entry = await ctx.db.get(row.sessionEntryId);
      if (event === null || entry === null || entry.createdDirectoryVersion === undefined) {
        return success({
          kind: "resnapshot_required",
          vault: vaultCoordinates(context.vault),
          floorVersion: context.vault.changeFloorVersion,
        });
      }
      changes.push({
        kind: "upsert" as const,
        accepted: acceptedSessionHeadSchema.parse({
          envelope: parseJson(event.envelopeJson),
          createdDirectoryVersion: entry.createdDirectoryVersion,
          directoryVersion: event.directoryVersion,
          serverObservedAt: encodeSyncUint64(BigInt(event.observedAt)),
        }),
      });
    } else if (row.kind === "tombstone" && row.tombstoneId !== undefined) {
      const tombstone = await ctx.db.get(row.tombstoneId);
      if (tombstone === null) {
        return success({
          kind: "resnapshot_required",
          vault: vaultCoordinates(context.vault),
          floorVersion: context.vault.changeFloorVersion,
        });
      }
      changes.push({ kind: "tombstone" as const, tombstone: parseJson(tombstone.tombstoneJson) });
    } else if (row.kind === "retired" && row.retiredFenceId !== undefined) {
      const fence = await ctx.db.get(row.retiredFenceId);
      if (fence === null) {
        return success({
          kind: "resnapshot_required",
          vault: vaultCoordinates(context.vault),
          floorVersion: context.vault.changeFloorVersion,
        });
      }
      changes.push({ kind: "retired" as const, fence: parseJson(fence.fenceJson) });
    } else if (row.kind === "mirror_reset" && row.payloadJson !== undefined) {
      changes.push(parseJson(row.payloadJson));
    } else {
      return success({
        kind: "resnapshot_required",
        vault: vaultCoordinates(context.vault),
        floorVersion: context.vault.changeFloorVersion,
      });
    }
  }
  const nextVersion = selected.at(-1)?.directoryVersion ?? request.afterVersion;
  const page = sessionDirectoryChangePageSchema.parse({
    version: 1,
    vault: vaultCoordinates(context.vault),
    afterVersion: request.afterVersion,
    changes,
    nextVersion,
    hasMore,
  });
  return success({ kind: "change_page", page });
}

export const commitAuthenticatedRequest = internalMutation({
  args: {
    requestJson: v.string(),
    proofJson: v.string(),
    verifiedBodyDigest: v.string(),
  },
  returns: backendResultValidator,
  handler: async (ctx, args) => {
    let request: SessionSyncBackendRequest;
    let proof: SyncDeviceProof;
    try {
      const rawRequest = parseJson(args.requestJson);
      assertObservationOnlySyncValue(rawRequest);
      request = sessionSyncBackendRequestSchema.parse(rawRequest);
      proof = syncDeviceProofSchema.parse(parseJson(args.proofJson));
    } catch {
      return failure("INVALID_REQUEST");
    }
    const now = Date.now();
    const context = await authorizeAndConsumeProof(ctx, request, proof, args.verifiedBodyDigest, now);
    if ("ok" in context) return context;
    const rateFailure = await consumeAuthorizedSessionSyncRateLimit(ctx, context, request, now);
    if (rateFailure !== null) return rateFailure;
    switch (request.operation) {
      case "admit_membership_proposal": return await admitMembershipProposal(
        ctx,
        context,
        request,
        proof.payload.bodyDigest,
        now,
      );
      case "update_membership": return await updateMembership(
        ctx,
        context,
        request,
        proof.payload.bodyDigest,
        now,
      );
      case "list_enrollment_requests": return await listEnrollmentRequests(ctx, context, now);
      case "approve_enrollment": return await approveEnrollment(
        ctx,
        context,
        request,
        proof.payload.bodyDigest,
        now,
      );
      case "read_membership": return await readMembership(ctx, context);
      case "root_key_link_page": return await rootKeyLinkPage(ctx, context, request);
      case "establish_boot":
      case "heartbeat": return await establishBoot(
        ctx,
        context,
        request,
        proof.payload.bodyDigest,
        now,
      );
      case "reserve_session": return await reserveSession(ctx, context, request, now);
      case "acquire_writer": return await acquireWriter(ctx, context, request, now);
      case "publish_session": return await publishSession(ctx, context, request, now);
      case "delete_session": return await deleteSession(ctx, context, request, now);
      case "begin_snapshot": return await beginSnapshot(ctx, context, request, now);
      case "snapshot_page": return await snapshotPage(ctx, context, request, now);
      case "change_page": return await changePage(ctx, context, request);
    }
  },
});

type RetirementEventPurge = Readonly<{
  blockedBySnapshot: boolean;
  complete: boolean;
  processedChanges: number;
}>;

async function purgeRetiringSessionEventPrefix(
  ctx: MutationCtx,
  vault: Doc<"syncVaults">,
  entry: Doc<"syncSessionEntries">,
  purgeThroughVersion: string | undefined,
  now: number,
  maximumChanges: number,
): Promise<RetirementEventPurge> {
  const target = await ctx.db
    .query("syncSessionEvents")
    .withIndex("by_session_and_directory_version", (query) =>
      query.eq("sessionEntryId", entry._id),
    )
    .order("desc")
    .first();
  if (target === null && purgeThroughVersion === undefined) {
    if (entry.retainedEventCount !== 0) {
      throw new Error("retiring session event counter lacks retained rows");
    }
    return { blockedBySnapshot: false, complete: true, processedChanges: 0 };
  }
  const targetVersion = target === null
    ? purgeThroughVersion!
    : purgeThroughVersion === undefined
        || compareSyncUint64(target.directoryVersion, purgeThroughVersion) >= 0
      ? target.directoryVersion
      : purgeThroughVersion;
  const activePin = await ctx.db
    .query("syncSnapshotPins")
    .withIndex("by_vault_and_expiry", (query) =>
      query.eq("vaultId", vault._id).gt("expiresAt", now),
    )
    .first();
  if (activePin !== null) {
    return { blockedBySnapshot: true, complete: false, processedChanges: 0 };
  }
  if (
    maximumChanges <= 0
    || compareSyncUint64(targetVersion, vault.changeFloorVersion) <= 0
  ) {
    if (maximumChanges <= 0) {
      return { blockedBySnapshot: false, complete: false, processedChanges: 0 };
    }
    if (
      target === null
      && entry.retainedEventCount === 0
      && compareSyncUint64(targetVersion, vault.changeFloorVersion) <= 0
    ) {
      return { blockedBySnapshot: false, complete: true, processedChanges: 0 };
    }
    throw new Error("retirement purge target is at or below the directory change floor");
  }
  const candidates = await ctx.db
    .query("syncDirectoryChanges")
    .withIndex("by_vault_and_version", (query) =>
      query
        .eq("vaultId", vault._id)
        .lte("directoryVersionOrderKey", syncUint64OrderKey(targetVersion)),
    )
    .order("asc")
    .take(maximumChanges + 1);
  const selected = candidates.slice(0, maximumChanges);
  if (
    selected.length === 0
    || selected[0]?.directoryVersion !== nextRequiredSyncUint64(vault.changeFloorVersion)
  ) throw new Error("retirement event purge found a discontinuous directory prefix");
  const events = [];
  const entryDeltas = new Map<Id<"syncSessionEntries">, { bytes: number; events: number }>();
  let totalBytes = 0;
  let totalEvents = 0;
  for (const change of selected) {
    if (change.eventId === undefined) continue;
    const event = await ctx.db.get(change.eventId);
    if (event === null) throw new Error("retirement prefix references missing session event");
    events.push(event);
    totalBytes += event.ciphertextBytes;
    totalEvents += 1;
    const prior = entryDeltas.get(event.sessionEntryId) ?? { bytes: 0, events: 0 };
    entryDeltas.set(event.sessionEntryId, {
      bytes: prior.bytes + event.ciphertextBytes,
      events: prior.events + 1,
    });
  }
  if (
    vault.retainedCiphertextBytes < totalBytes
    || vault.retainedEventCount < totalEvents
  ) throw new Error("vault event retention counters are incoherent");
  for (const [entryId, delta] of entryDeltas) {
    const storedEntry = await ctx.db.get(entryId);
    if (
      storedEntry === null
      || storedEntry.retainedCiphertextBytes < delta.bytes
      || storedEntry.retainedEventCount < delta.events
    ) throw new Error("session event retention counters are incoherent");
  }
  for (const change of selected) await ctx.db.delete(change._id);
  for (const event of events) await ctx.db.delete(event._id);
  for (const [entryId, delta] of entryDeltas) {
    const storedEntry = await ctx.db.get(entryId);
    if (storedEntry === null) throw new Error("retained session disappeared during event purge");
    await ctx.db.patch(storedEntry._id, {
      retainedCiphertextBytes: storedEntry.retainedCiphertextBytes - delta.bytes,
      retainedEventCount: storedEntry.retainedEventCount - delta.events,
      updatedAt: now,
    });
  }
  const finalChange = selected.at(-1);
  if (finalChange === undefined) throw new Error("retirement event purge selected no change");
  await ctx.db.patch(vault._id, {
    changeFloorVersion: finalChange.directoryVersion,
    retainedCiphertextBytes: vault.retainedCiphertextBytes - totalBytes,
    retainedEventCount: vault.retainedEventCount - totalEvents,
    updatedAt: now,
  });
  return {
    blockedBySnapshot: false,
    complete: compareSyncUint64(finalChange.directoryVersion, targetVersion) >= 0,
    processedChanges: selected.length,
  };
}

export const retireExpiredSyncState = internalMutation({
  args: {},
  returns: v.object({
    expiredEnrollments: v.number(),
    purgedEnrollments: v.number(),
    expiredRateBuckets: v.number(),
    retiredReservations: v.number(),
    retiredSessions: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const expiredPins = await ctx.db
      .query("syncSnapshotPins")
      .withIndex("by_expiry", (query) => query.lte("expiresAt", now))
      .take(MAX_EXPIRED_SNAPSHOT_PINS_PER_SWEEP);
    for (const pin of expiredPins) await deleteSnapshotPin(ctx, pin);
    const expiredProofs = await ctx.db
      .query("syncProofNonces")
      .withIndex("by_expiry", (query) => query.lte("expiresAt", now))
      .take(64);
    for (const nonce of expiredProofs) await ctx.db.delete(nonce._id);
    const expiredEnrollmentProofs = await ctx.db
      .query("syncEnrollmentProofNonces")
      .withIndex("by_expiry", (query) => query.lte("expiresAt", now))
      .take(64);
    for (const nonce of expiredEnrollmentProofs) await ctx.db.delete(nonce._id);
    const expiredRateBuckets = await ctx.db
      .query("syncRateLimitBuckets")
      .withIndex("by_expiry", (query) => query.lte("expiresAt", now))
      .take(128);
    for (const bucket of expiredRateBuckets) await ctx.db.delete(bucket._id);
    const expiredEnrollmentRows = await ctx.db
      .query("syncEnrollmentRequests")
      .withIndex("by_state_and_expiry", (query) =>
        query.eq("state", "pending").lte("expiresAt", now),
      )
      .take(64);
    let expiredEnrollments = 0;
    for (const enrollment of expiredEnrollmentRows) {
      if (await irrevocablePendingEnrollmentProposal(ctx, enrollment.vaultId, enrollment.requestId)) {
        continue;
      }
      await ctx.db.patch(enrollment._id, { state: "expired", updatedAt: now });
      expiredEnrollments += 1;
    }
    const purgeEnrollmentRows = await ctx.db
      .query("syncEnrollmentRequests")
      .withIndex("by_purge_after", (query) => query.lte("purgeAfter", now))
      .take(64);
    let purgedEnrollments = 0;
    for (const enrollment of purgeEnrollmentRows) {
      const current = await ctx.db.get(enrollment._id);
      if (current === null || current.state === "pending") continue;
      await ctx.db.delete(current._id);
      purgedEnrollments += 1;
    }

    let retiredReservations = 0;
    let retiredSessions = 0;
    let retirementChangeBudget = MAX_RETIREMENT_CHANGE_PURGE_PER_SWEEP;
    let retirementPurgeNeedsFollowup = false;
    const [expiredReservationRows, expiredTombstoneRows] = await Promise.all([
      ctx.db
        .query("syncSessionEntries")
        .withIndex("by_state_and_grant_expiry", (query) =>
          query.eq("state", "reserved").lte("creationGrantExpiresAt", now),
        )
        .take(64),
      ctx.db
        .query("syncSessionTombstones")
        .withIndex("by_purge_after", (query) => query.lte("purgeAfter", now))
        .take(64),
    ]);
    const targetEntryIds = [
      ...expiredReservationRows.map((entry) => entry._id),
      ...expiredTombstoneRows.map((tombstone) => tombstone.sessionEntryId),
    ].filter((entryId, index, values) => values.indexOf(entryId) === index).slice(0, 64);
    for (const entryId of targetEntryIds) {
      const entry = await ctx.db.get(entryId);
      if (entry === null || entry.state === "retired") continue;
      const vault = await ctx.db.get(entry.vaultId);
      if (vault === null || vault.status !== "active") continue;
      const activePins = await ctx.db
        .query("syncSnapshotPins")
        .withIndex("by_vault_and_expiry", (query) =>
          query.eq("vaultId", vault._id).gt("expiresAt", now),
        )
        .take(1);
      if (activePins.length > 0) continue;
      const tombstone = entry.state === "tombstone"
        ? await ctx.db
          .query("syncSessionTombstones")
          .withIndex("by_session_entry", (query) => query.eq("sessionEntryId", entry._id))
          .unique()
        : null;
      const expiredReservation = entry.state === "reserved" && entry.creationGrantExpiresAt <= now;
      const expiredTombstone = tombstone !== null && tombstone.purgeAfter <= now;
      if (!expiredReservation && !expiredTombstone) continue;
      const eventPurge = await purgeRetiringSessionEventPrefix(
        ctx,
        vault,
        entry,
        tombstone?.directoryVersion,
        now,
        retirementChangeBudget,
      );
      retirementChangeBudget -= eventPurge.processedChanges;
      if (eventPurge.blockedBySnapshot) continue;
      if (!eventPurge.complete) {
        retirementPurgeNeedsFollowup = true;
        if (retirementChangeBudget === 0) break;
        continue;
      }
      const [retiringEntry, retiringVault] = await Promise.all([
        ctx.db.get(entry._id),
        ctx.db.get(vault._id),
      ]);
      if (
        retiringEntry === null
        || retiringVault === null
        || retiringVault.status !== "active"
        || retiringEntry.retainedEventCount !== 0
      ) throw new Error("retirement event purge did not reach a coherent terminal state");
      const directoryVersion = nextRequiredSyncUint64(retiringVault.directoryVersion);
      const createdDirectoryVersion = retiringEntry.createdDirectoryVersion ?? directoryVersion;
      const tombstoneDigest = tombstone?.tombstoneDigest ?? retiringEntry.creationGrantDigest;
      const fence = retiredSessionIdFenceSchema.parse({
        protocol: "oprte.session-sync/v1",
        recordKind: "retired_session_id",
        tenantId: retiringVault.tenantId,
        organizationId: retiringVault.organizationCoordinate,
        ownerUserId: retiringVault.ownerUserCoordinate,
        vaultId: retiringVault.vaultId,
        vaultGeneration: retiringVault.vaultGeneration,
        sessionId: retiringEntry.sessionId,
        directoryOrdinal: retiringEntry.directoryOrdinal,
        createdDirectoryVersion,
        retirementDirectoryVersion: directoryVersion,
        retiredAt: encodeSyncUint64(BigInt(now)),
        tombstoneDigest,
      });
      const fenceId = await ctx.db.insert("syncRetiredSessionIds", {
        vaultId: retiringVault._id,
        sessionEntryId: retiringEntry._id,
        sessionId: retiringEntry.sessionId,
        directoryOrdinal: retiringEntry.directoryOrdinal,
        retirementDirectoryVersion: directoryVersion,
        retirementDirectoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
        tombstoneDigest,
        fenceJson: canonicalSessionSyncJson(fence),
        retiredAt: now,
      });
      await ctx.db.insert("syncDirectoryChanges", {
        vaultId: retiringVault._id,
        directoryVersion,
        directoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
        kind: "retired",
        sessionEntryId: retiringEntry._id,
        retiredFenceId: fenceId,
        createdAt: now,
      });
      const head = await ctx.db
        .query("syncSessionHeads")
        .withIndex("by_session_entry", (query) => query.eq("sessionEntryId", retiringEntry._id))
        .unique();
      const headBytes = head?.ciphertextBytes ?? 0;
      if (
        retiringEntry.retainedCiphertextBytes !== headBytes
        || retiringVault.retainedCiphertextBytes < headBytes
        || retiringVault.directorySessionCount <= 0
      ) throw new Error("retiring session ciphertext counters are incoherent");
      if (head !== null) await ctx.db.delete(head._id);
      if (tombstone !== null) await ctx.db.delete(tombstone._id);
      await ctx.db.patch(retiringEntry._id, {
        state: "retired",
        createdDirectoryVersion,
        retirementDirectoryVersion: directoryVersion,
        latestDirectoryVersion: directoryVersion,
        latestDirectoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
        retainedCiphertextBytes: 0,
        retainedEventCount: 0,
        streamActive: false,
        updatedAt: now,
      });
      await ctx.db.patch(retiringVault._id, {
        directoryVersion,
        directoryVersionOrderKey: syncUint64OrderKey(directoryVersion),
        directorySessionCount: retiringVault.directorySessionCount - 1,
        retainedCiphertextBytes: retiringVault.retainedCiphertextBytes - headBytes,
        updatedAt: now,
      });
      if (expiredReservation) retiredReservations += 1;
      else retiredSessions += 1;
    }
    if (
      expiredPins.length === MAX_EXPIRED_SNAPSHOT_PINS_PER_SWEEP
      || expiredProofs.length === 64
      || expiredEnrollmentProofs.length === 64
      || expiredRateBuckets.length === 128
      || expiredEnrollmentRows.length === 64
      || purgeEnrollmentRows.length === 64
      || retirementPurgeNeedsFollowup
      || ((retiredReservations + retiredSessions) > 0 && targetEntryIds.length === 64)
    ) {
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<"mutation">("sessionSyncModel:retireExpiredSyncState"),
        {},
      );
    }
    return {
      expiredEnrollments,
      purgedEnrollments,
      expiredRateBuckets: expiredRateBuckets.length,
      retiredReservations,
      retiredSessions,
    };
  },
});

export const sessionSyncInternalReferences = {
  bootstrapVaultTransition: makeFunctionReference<"mutation">("sessionSyncModel:bootstrapVaultTransition"),
  claimEnrollmentTransition: makeFunctionReference<"mutation">("sessionSyncModel:claimEnrollmentTransition"),
  commitAuthenticatedRequest: makeFunctionReference<"mutation">("sessionSyncModel:commitAuthenticatedRequest"),
  readProofContext: makeFunctionReference<"query">("sessionSyncModel:readProofContext"),
  retireExpiredSyncState: makeFunctionReference<"mutation">("sessionSyncModel:retireExpiredSyncState"),
  submitEnrollmentTransition: makeFunctionReference<"mutation">("sessionSyncModel:submitEnrollmentTransition"),
} as const;
