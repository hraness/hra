import {
  assertObservationOnlySyncValue,
  canonicalSessionSyncJson,
  digestSyncMembershipStatement,
  digestSyncRecoveryRequestIntent,
  digestSyncRecoveryVaultRootWrap,
  digestSyncRequestBody,
  digestSyncVaultRootKeyLink,
  digestSyncVaultRootWrapManifest,
  deriveSyncEnrollmentPairing,
  encodeSyncUint64,
  decodeSyncUint64,
  recoverSyncVaultRequestSchema,
  MAX_SYNC_DEVICES,
  MAX_SYNC_PROOF_TTL_MS,
  positiveSyncUint64Schema,
  sessionSyncHelloSchema,
  syncDeviceProofSchema,
  syncDevicePublicKeysSchema,
  syncSha256DigestSchema,
  verifySyncEnrollmentPossessionProof,
  syncMembershipHeadSchema,
  syncNonceForSequence,
  syncRecoveryAuthoritySchema,
  verifySyncDeviceProof,
  verifySyncDevicePublicKeys,
  verifySyncMembershipSignature,
  verifySyncRecoveryAuthority,
  verifySyncRecoveryAuthorization,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { action, type ActionCtx } from "./_generated/server";
import { hraSessionSyncEnabled } from "./hraEnvironment";
import {
  bootstrapSyncVaultRequestSchema,
  claimSyncEnrollmentIntentSchema,
  claimSyncEnrollmentRequestSchema,
  MAX_SESSION_SYNC_REQUEST_JSON_BYTES,
  routeForSessionSyncRequest,
  readSyncRecoveryContextRequestSchema,
  sessionSyncEnrollmentRequestIdSchema,
  sessionSyncBackendErrorCodes,
  sessionSyncBackendNonRateErrorCodes,
  sessionSyncBackendRequestSchema,
  sessionSyncBackendResponseSchema,
  submitSyncEnrollmentRequestSchema,
  submitSyncEnrollmentIntentSchema,
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

const bootstrapTransition = makeFunctionReference<
  "mutation",
  Readonly<{ requestJson: string; proofJson: string; verifiedBodyDigest: string }>,
  SessionSyncBackendResult
>("sessionSyncModel:bootstrapVaultTransition");
const commitRequest = makeFunctionReference<
  "mutation",
  Readonly<{ requestJson: string; proofJson: string; verifiedBodyDigest: string }>,
  SessionSyncBackendResult
>("sessionSyncModel:commitAuthenticatedRequest");
const submitEnrollmentTransition = makeFunctionReference<
  "mutation",
  Readonly<{
    requestJson: string;
    requestDigest: string;
    requestId: string;
    pairingDigest: string;
    pairingCode: string;
    pairingTranscriptJson: string;
  }>,
  SessionSyncBackendResult
>("sessionSyncModel:submitEnrollmentTransition");
const claimEnrollmentTransition = makeFunctionReference<
  "mutation",
  Readonly<{ requestJson: string; verifiedBodyDigest: string }>,
  SessionSyncBackendResult
>("sessionSyncModel:claimEnrollmentTransition");
const recoverVaultTransition = makeFunctionReference<
  "mutation",
  Readonly<{ requestJson: string; requestDigest: string }>,
  SessionSyncBackendResult
>("sessionSyncModel:recoverVaultTransition");
const proofContext = makeFunctionReference<
  "query",
  Readonly<{ proofJson: string }>,
  | Readonly<{ ok: true; contextJson: string }>
  | Readonly<{ ok: false; code: typeof sessionSyncBackendErrorCodes[number] }>
>("sessionSyncModel:readProofContext");
const recoveryContext = makeFunctionReference<
  "query",
  Readonly<{
    vaultId: string;
    vaultGeneration: string;
    recoveryNonce: string;
    requestDigest: string;
  }>,
  | Readonly<{ ok: false; code: typeof sessionSyncBackendErrorCodes[number] }>
  | Readonly<{ ok: true; kind: "current"; contextJson: string }>
  | Readonly<{ ok: true; kind: "replay"; responseJson: string }>
>("sessionSyncModel:readRecoveryContext");
const recoveryPreparationTransition = makeFunctionReference<
  "mutation",
  Readonly<{ requestJson: string; requestId: string }>,
  SessionSyncBackendResult
>("sessionSyncModel:readRecoveryPreparationTransition");
const enrollmentPairingContext = makeFunctionReference<
  "query",
  Readonly<{ requestId: string; vaultId: string; vaultGeneration: string }>,
  | Readonly<{ ok: true; contextJson: string }>
  | Readonly<{ ok: false; code: typeof sessionSyncBackendNonRateErrorCodes[number] }>
>("sessionSyncModel:readEnrollmentPairingContext");
const authorizeNegotiationTransition = makeFunctionReference<
  "mutation",
  Record<string, never>,
  | Readonly<{ ok: true }>
  | Extract<SessionSyncBackendResult, { ok: false }>
>("sessionSyncModel:authorizeNegotiation");

const proofContextSchema = z.object({
  activeDevices: z.array(z.object({
    deviceId: z.string(),
    keys: syncDevicePublicKeysSchema,
  }).strict()).min(1).max(MAX_SYNC_DEVICES),
  currentDevice: z.object({
    deviceId: z.string(),
    keys: syncDevicePublicKeysSchema,
  }).strict(),
  membershipHead: syncMembershipHeadSchema,
  rootKeyEpoch: z.string(),
}).strict();
const recoveryContextSchema = z.object({
  authority: syncRecoveryAuthoritySchema,
  membershipHead: syncMembershipHeadSchema,
}).strict();
const enrollmentPairingContextSchema = z.object({
  currentMembershipDigest: syncSha256DigestSchema,
  expiresAt: positiveSyncUint64Schema,
}).strict();

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalidRequest(): SessionSyncBackendResult {
  return { ok: false, code: "INVALID_REQUEST" };
}

function sessionSyncEnabled(): boolean {
  return hraSessionSyncEnabled({
    HRA_SESSION_SYNC_ENABLED: process.env.HRA_SESSION_SYNC_ENABLED,
    OPRTE_SESSION_SYNC_ENABLED: process.env.OPRTE_SESSION_SYNC_ENABLED,
  });
}

function parseBoundedJson(value: string): unknown {
  if (utf8Bytes(value) > MAX_SESSION_SYNC_REQUEST_JSON_BYTES) {
    throw new Error("session sync request exceeds its byte bound");
  }
  return JSON.parse(value) as unknown;
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

function proofMatchesRequest(
  request: SessionSyncBackendRequest,
  bodyDigest: string,
  proof: ReturnType<typeof syncDeviceProofSchema.parse>,
): boolean {
  return proof.payload.bodyDigest === bodyDigest
    && proof.payload.route === routeForSessionSyncRequest(request)
    && proof.payload.method === proofMethod(request);
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer));
  return `sha256_${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function hasValidCiphertextDigest(value: {
  readonly ciphertext: string;
  readonly ciphertextDigest: string;
}): Promise<boolean> {
  return value.ciphertextDigest === await digestBytes(base64UrlBytes(value.ciphertext));
}

async function hasValidWrappedRoot(value: {
  readonly ciphertext: string;
  readonly ciphertextDigest: string;
  readonly ephemeralAgreementPublicKey: string;
}): Promise<boolean> {
  if (!await hasValidCiphertextDigest(value)) return false;
  try {
    const decoded = base64UrlBytes(value.ephemeralAgreementPublicKey);
    const publicKeyBytes = new Uint8Array(decoded.byteLength);
    publicKeyBytes.set(decoded);
    await crypto.subtle.importKey(
      "raw",
      publicKeyBytes.buffer,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    return true;
  } catch {
    return false;
  }
}

async function hasValidRootKeyLink(
  value: Parameters<typeof digestSyncVaultRootKeyLink>[0],
): Promise<boolean> {
  return await hasValidCiphertextDigest(value)
    && value.linkDigest === await digestSyncVaultRootKeyLink(value);
}

async function validateMembershipTransitionCryptography(
  request: Extract<SessionSyncBackendRequest, {
    operation: "admit_membership_proposal" | "update_membership" | "approve_enrollment";
  }>,
  context: z.infer<typeof proofContextSchema>,
): Promise<boolean> {
  const candidate = request.operation === "admit_membership_proposal"
    ? request.membershipCandidate
    : request.membershipHead;
  const signatures = request.operation === "admit_membership_proposal"
    ? []
    : request.membershipHead.signatures;
  if (
    candidate.statement.rootWrapManifestDigest
      !== await digestSyncVaultRootWrapManifest(request.wrappedRoots)
    || candidate.statement.recoveryRootWrapDigest
      !== await digestSyncRecoveryVaultRootWrap(request.recoveryRootWrap)
    || !await hasValidWrappedRoot(request.recoveryRootWrap)
    || (candidate.statement.rootKeyLinkDigest === null) !== (request.rootKeyLink === undefined)
    || (request.rootKeyLink !== undefined
      && (candidate.statement.rootKeyLinkDigest !== request.rootKeyLink.linkDigest
        || !await hasValidRootKeyLink(request.rootKeyLink)))
  ) return false;
  if (
    request.operation !== "admit_membership_proposal"
    && candidate.statementDigest === context.membershipHead.statementDigest
    && canonicalSessionSyncJson(request.membershipHead) === canonicalSessionSyncJson(context.membershipHead)
  ) {
    return (await Promise.all(request.wrappedRoots.map(hasValidWrappedRoot))).every(Boolean);
  }
  if (candidate.statementDigest !== await digestSyncMembershipStatement(candidate.statement)) return false;
  const priorActive = new Map(context.activeDevices.map((device) => [device.deviceId, device.keys]));
  for (const signature of signatures) {
    const keys = priorActive.get(signature.deviceId);
    if (
      keys === undefined
      || !await verifySyncMembershipSignature(candidate.statement, signature, keys)
    ) {
      return false;
    }
  }
  for (const member of candidate.statement.members) {
    if (!await verifySyncDevicePublicKeys(member.keys)) return false;
  }
  for (const wrap of request.wrappedRoots) {
    if (!await hasValidWrappedRoot(wrap)) return false;
  }
  return true;
}

export function negotiateSessionSync(helloJson: string) {
  try {
    const hello = sessionSyncHelloSchema.parse(parseBoundedJson(helloJson));
    return {
      outcome: "accepted" as const,
      version: 1 as const,
      capabilities: hello.capabilities,
      serverObservedAt: encodeSyncUint64(BigInt(Date.now())),
      maximumProofTtlMs: MAX_SYNC_PROOF_TTL_MS,
    };
  } catch {
    return {
      outcome: "update_required" as const,
      minimumSupportedVersion: 1,
      maximumSupportedVersion: 1,
    };
  }
}

export async function authorizeSessionSyncNegotiation(
  ctx: ActionCtx,
): Promise<
  | Readonly<{ ok: true }>
  | Extract<SessionSyncBackendResult, { ok: false }>
> {
  return await ctx.runMutation(authorizeNegotiationTransition, {});
}

type SessionSyncInvocation = Readonly<{ requestJson: string; proofJson: string }>;

export async function bootstrapSessionSyncVault(
  ctx: ActionCtx,
  args: SessionSyncInvocation,
): Promise<SessionSyncBackendResult> {
  if (!sessionSyncEnabled()) return { ok: false, code: "AUTHORIZATION_DENIED" };
  let request: ReturnType<typeof bootstrapSyncVaultRequestSchema.parse>;
  let proof: ReturnType<typeof syncDeviceProofSchema.parse>;
  let bodyDigest: string;
  try {
    const rawRequest = parseBoundedJson(args.requestJson);
    const rawProof = parseBoundedJson(args.proofJson);
    assertObservationOnlySyncValue(rawRequest);
    request = bootstrapSyncVaultRequestSchema.parse(rawRequest);
    proof = syncDeviceProofSchema.parse(rawProof);
    bodyDigest = await digestSyncRequestBody(request);
    const statement = request.membershipHead.statement;
    const member = statement.members[0];
    if (
      member === undefined
      || statement.members.length !== 1
      || request.membershipHead.statementDigest !== await digestSyncMembershipStatement(statement)
      || request.membershipHead.signatures.length !== 1
      || request.membershipHead.signatures[0]?.deviceId !== member.deviceId
      || proof.payload.bodyDigest !== bodyDigest
      || proof.payload.method !== "POST"
      || proof.payload.route !== "sync.membership.update"
      || proof.payload.deviceId !== member.deviceId
      || proof.payload.vaultId !== statement.vaultId
      || proof.payload.vaultGeneration !== statement.vaultGeneration
      || proof.payload.membershipEpoch !== statement.membershipEpoch
      || !await verifySyncDevicePublicKeys(member.keys)
      || !await verifySyncMembershipSignature(
        statement,
        request.membershipHead.signatures[0],
        member.keys,
      )
      || !await verifySyncRecoveryAuthority(request.recoveryAuthority)
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
      || request.recoveryAuthority.agreementPublicKeyDigest === member.keys.signing.publicKeyDigest
      || request.recoveryAuthority.agreementPublicKeyDigest === member.keys.agreement.publicKeyDigest
      || !await verifySyncDeviceProof(proof, member.keys, encodeSyncUint64(BigInt(Date.now())))
      || !await hasValidWrappedRoot(request.wrappedRoot)
      || statement.rootKeyEpoch !== request.wrappedRoot.context.rootKeyEpoch
      || statement.rootWrapManifestDigest
        !== await digestSyncVaultRootWrapManifest([request.wrappedRoot])
      || statement.recoveryRootWrapDigest
        !== await digestSyncRecoveryVaultRootWrap(request.recoveryRootWrap)
      || !await hasValidWrappedRoot(request.recoveryRootWrap)
      || statement.rootKeyLinkDigest !== null
    ) return { ok: false, code: "PROOF_INVALID" };
  } catch {
    return invalidRequest();
  }
  try {
    return await ctx.runMutation(bootstrapTransition, {
      requestJson: canonicalSessionSyncJson(request),
      proofJson: canonicalSessionSyncJson(proof),
      verifiedBodyDigest: bodyDigest,
    });
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}

export const bootstrapVault = action({
  args: { requestJson: v.string(), proofJson: v.string() },
  returns: backendResultValidator,
  handler: bootstrapSessionSyncVault,
});

function randomEnrollmentRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return sessionSyncEnrollmentRequestIdSchema.parse(
    `syncenroll_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}

export async function submitSessionSyncEnrollment(
  ctx: ActionCtx,
  args: Readonly<{ requestJson: string }>,
): Promise<SessionSyncBackendResult> {
  if (!sessionSyncEnabled()) return { ok: false, code: "AUTHORIZATION_DENIED" };
  let request: ReturnType<typeof submitSyncEnrollmentRequestSchema.parse>;
  let requestDigest: Awaited<ReturnType<typeof digestSyncRequestBody>>;
  let requestId: string;
  let pairing: Awaited<ReturnType<typeof deriveSyncEnrollmentPairing>>;
  try {
    const rawRequest = parseBoundedJson(args.requestJson);
    assertObservationOnlySyncValue(rawRequest);
    request = submitSyncEnrollmentRequestSchema.parse(rawRequest);
    const { possessionProof, ...intentValue } = request;
    const intent = submitSyncEnrollmentIntentSchema.parse(intentValue);
    requestDigest = await digestSyncRequestBody(intent);
    if (
      possessionProof.payload.bodyDigest !== requestDigest
      || !await verifySyncEnrollmentPossessionProof(
        possessionProof,
        request.keys,
        encodeSyncUint64(BigInt(Date.now())),
      )
    ) {
      return { ok: false, code: "PROOF_INVALID" };
    }
    requestId = randomEnrollmentRequestId();
    const pairingContextResult = await ctx.runQuery(enrollmentPairingContext, {
      requestId,
      vaultId: request.vaultId,
      vaultGeneration: request.vaultGeneration,
    });
    if (!pairingContextResult.ok) return pairingContextResult;
    const pairingContext = enrollmentPairingContextSchema.parse(
      parseBoundedJson(pairingContextResult.contextJson),
    );
    pairing = await deriveSyncEnrollmentPairing({
      version: 1,
      vaultId: request.vaultId,
      vaultGeneration: request.vaultGeneration,
      requestId,
      deviceId: request.deviceId,
      candidateNonce: request.possessionProof.payload.nonce,
      candidateIntentDigest: requestDigest,
      currentMembershipDigest: pairingContext.currentMembershipDigest,
      candidateSigningKeyDigest: request.keys.signing.publicKeyDigest,
      candidateAgreementKeyDigest: request.keys.agreement.publicKeyDigest,
      expiresAt: pairingContext.expiresAt,
    });
  } catch {
    return invalidRequest();
  }
  try {
    return await ctx.runMutation(submitEnrollmentTransition, {
      requestJson: canonicalSessionSyncJson(request),
      requestDigest,
      requestId,
      pairingDigest: pairing.pairingDigest,
      pairingCode: pairing.pairingCode,
      pairingTranscriptJson: canonicalSessionSyncJson(pairing.transcript),
    });
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}

export const submitEnrollment = action({
  args: { requestJson: v.string() },
  returns: backendResultValidator,
  handler: submitSessionSyncEnrollment,
});

export async function claimSessionSyncEnrollment(
  ctx: ActionCtx,
  args: Readonly<{ requestJson: string }>,
): Promise<SessionSyncBackendResult> {
  if (!sessionSyncEnabled()) return { ok: false, code: "AUTHORIZATION_DENIED" };
  let request: ReturnType<typeof claimSyncEnrollmentRequestSchema.parse>;
  let bodyDigest: string;
  try {
    const rawRequest = parseBoundedJson(args.requestJson);
    assertObservationOnlySyncValue(rawRequest);
    request = claimSyncEnrollmentRequestSchema.parse(rawRequest);
    const { possessionProof, ...intentValue } = request;
    bodyDigest = await digestSyncRequestBody(
      claimSyncEnrollmentIntentSchema.parse(intentValue),
    );
    if (
      possessionProof.payload.bodyDigest !== bodyDigest
      || !await verifySyncEnrollmentPossessionProof(
        possessionProof,
        request.keys,
        encodeSyncUint64(BigInt(Date.now())),
      )
    ) return { ok: false, code: "PROOF_INVALID" };
  } catch {
    return invalidRequest();
  }
  try {
    return await ctx.runMutation(claimEnrollmentTransition, {
      requestJson: canonicalSessionSyncJson(request),
      verifiedBodyDigest: bodyDigest,
    });
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}

export const claimEnrollment = action({
  args: { requestJson: v.string() },
  returns: backendResultValidator,
  handler: claimSessionSyncEnrollment,
});

export async function readSessionSyncRecoveryContext(
  ctx: ActionCtx,
  args: Readonly<{ requestJson: string }>,
): Promise<SessionSyncBackendResult> {
  if (!sessionSyncEnabled()) return { ok: false, code: "AUTHORIZATION_DENIED" };
  let request;
  try {
    const rawRequest = parseBoundedJson(args.requestJson);
    assertObservationOnlySyncValue(rawRequest);
    request = readSyncRecoveryContextRequestSchema.parse(rawRequest);
  } catch {
    return invalidRequest();
  }
  try {
    return await ctx.runMutation(recoveryPreparationTransition, {
      requestJson: canonicalSessionSyncJson(request),
      requestId: randomEnrollmentRequestId(),
    });
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}

export const readRecoveryContext = action({
  args: { requestJson: v.string() },
  returns: backendResultValidator,
  handler: readSessionSyncRecoveryContext,
});

export async function recoverSessionSyncVault(
  ctx: ActionCtx,
  args: Readonly<{ requestJson: string }>,
): Promise<SessionSyncBackendResult> {
  if (!sessionSyncEnabled()) return { ok: false, code: "AUTHORIZATION_DENIED" };
  let request: ReturnType<typeof recoverSyncVaultRequestSchema.parse>;
  let requestDigest: string;
  try {
    const rawRequest = parseBoundedJson(args.requestJson);
    assertObservationOnlySyncValue(rawRequest);
    request = recoverSyncVaultRequestSchema.parse(rawRequest);
    requestDigest = await digestSyncRecoveryRequestIntent(request);
  } catch {
    return invalidRequest();
  }
  let loaded: Awaited<ReturnType<ActionCtx["runQuery"]>>;
  try {
    loaded = await ctx.runQuery(recoveryContext, {
      vaultId: request.authorization.statement.vault.vaultId,
      vaultGeneration: request.authorization.statement.vault.vaultGeneration,
      recoveryNonce: request.authorization.statement.recoveryNonce,
      requestDigest,
    });
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
  if (!loaded.ok) return loaded;
  if (loaded.kind === "replay") {
    try {
      const response = sessionSyncBackendResponseSchema.parse(parseBoundedJson(loaded.responseJson));
      return response.kind === "vault_recovered"
        ? { ok: true, responseJson: canonicalSessionSyncJson({ ...response, replay: true }) }
        : { ok: false, code: "CONFLICT" };
    } catch {
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    }
  }
  try {
    const context = recoveryContextSchema.parse(parseBoundedJson(loaded.contextJson));
    const statement = request.authorization.statement;
    const membership = request.membershipHead;
    const replacement = statement.replacementDevice;
    const proof = request.replacementDeviceProof;
    const issuedAt = Number(decodeSyncUint64(statement.issuedAt));
    const expiresAt = Number(decodeSyncUint64(statement.expiresAt));
    const now = Date.now();
    if (
      !Number.isSafeInteger(issuedAt)
      || !Number.isSafeInteger(expiresAt)
      || now < issuedAt
      || now > expiresAt
      || context.membershipHead.statementDigest !== statement.currentMembershipDigest
      || context.membershipHead.statement.rootKeyEpoch !== statement.currentRootKeyEpoch
      || context.membershipHead.statement.rootKeyCommitment !== statement.currentRootKeyCommitment
      || context.authority.recoveryGeneration !== statement.currentRecoveryGeneration
      || !await verifySyncRecoveryAuthorization(request.authorization, context.authority)
      || !await verifySyncRecoveryAuthority(statement.nextRecoveryAuthority)
      || membership.statementDigest !== await digestSyncMembershipStatement(membership.statement)
      || membership.signatures.length !== 1
      || membership.signatures[0]?.deviceId !== replacement.deviceId
      || !await verifySyncDevicePublicKeys(replacement.keys)
      || !await verifySyncMembershipSignature(
        membership.statement,
        membership.signatures[0],
        replacement.keys,
      )
      || !await verifySyncDeviceProof(
        proof,
        replacement.keys,
        encodeSyncUint64(BigInt(now)),
      )
      || statement.replacementRootWrapManifestDigest
        !== await digestSyncVaultRootWrapManifest(request.wrappedRoots)
      || statement.replacementRecoveryRootWrapDigest
        !== await digestSyncRecoveryVaultRootWrap(request.recoveryRootWrap)
      || !await hasValidWrappedRoot(request.recoveryRootWrap)
      || statement.rootKeyLink.linkDigest !== await digestSyncVaultRootKeyLink(statement.rootKeyLink)
      || !await hasValidRootKeyLink(statement.rootKeyLink)
      || !(await Promise.all(request.wrappedRoots.map(hasValidWrappedRoot))).every(Boolean)
    ) return { ok: false, code: "PROOF_INVALID" };
  } catch {
    return { ok: false, code: "PROOF_INVALID" };
  }
  try {
    return await ctx.runMutation(recoverVaultTransition, {
      requestJson: canonicalSessionSyncJson(request),
      requestDigest,
    });
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}

export const recoverVault = action({
  args: { requestJson: v.string() },
  returns: backendResultValidator,
  handler: recoverSessionSyncVault,
});

export async function executeSessionSyncRequest(
  ctx: ActionCtx,
  args: SessionSyncInvocation,
): Promise<SessionSyncBackendResult> {
  if (!sessionSyncEnabled()) return { ok: false, code: "AUTHORIZATION_DENIED" };
  let request: SessionSyncBackendRequest;
  let proof: ReturnType<typeof syncDeviceProofSchema.parse>;
  let bodyDigest: string;
  try {
    const rawRequest = parseBoundedJson(args.requestJson);
    const rawProof = parseBoundedJson(args.proofJson);
    assertObservationOnlySyncValue(rawRequest);
    request = sessionSyncBackendRequestSchema.parse(rawRequest);
    proof = syncDeviceProofSchema.parse(rawProof);
    bodyDigest = await digestSyncRequestBody(request);
    if (!proofMatchesRequest(request, bodyDigest, proof)) {
      return { ok: false, code: "PROOF_INVALID" };
    }
  } catch {
    return { ok: false, code: "PROOF_INVALID" };
  }
  let loaded: Awaited<ReturnType<ActionCtx["runQuery"]>>;
  try {
    loaded = await ctx.runQuery(proofContext, {
      proofJson: canonicalSessionSyncJson(proof),
    });
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
  if (!loaded.ok) return loaded;
  try {
    const context = proofContextSchema.parse(parseBoundedJson(loaded.contextJson));
    if (
      context.currentDevice.deviceId !== proof.payload.deviceId
      || !await verifySyncDeviceProof(
        proof,
        context.currentDevice.keys,
        encodeSyncUint64(BigInt(Date.now())),
      )
    ) return { ok: false, code: "PROOF_INVALID" };
    if (
      request.operation === "publish_session"
      && (request.envelope.nonce !== syncNonceForSequence(request.envelope.header.syncSequence)
        || !await hasValidCiphertextDigest(request.envelope))
    ) return { ok: false, code: "PROOF_INVALID" };
    if (
      (request.operation === "admit_membership_proposal"
        || request.operation === "update_membership"
        || request.operation === "approve_enrollment")
      && !await validateMembershipTransitionCryptography(request, context)
    ) return { ok: false, code: "PROOF_INVALID" };
    if (request.operation === "delete_session") {
      const unsignedDelete = Object.fromEntries(
        Object.entries(request).filter(([key]) => key !== "tombstoneDigest"),
      );
      if (request.tombstoneDigest !== await digestSyncRequestBody(unsignedDelete)) {
        return { ok: false, code: "PROOF_INVALID" };
      }
    }
  } catch {
    return { ok: false, code: "PROOF_INVALID" };
  }
  try {
    return await ctx.runMutation(commitRequest, {
      requestJson: canonicalSessionSyncJson(request),
      proofJson: canonicalSessionSyncJson(proof),
      verifiedBodyDigest: bodyDigest,
    });
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}

export const execute = action({
  args: { requestJson: v.string(), proofJson: v.string() },
  returns: backendResultValidator,
  handler: executeSessionSyncRequest,
});

export const sessionSyncPublicSurface = {
  bootstrapVault,
  claimEnrollment,
  execute,
  recoverVault,
  readRecoveryContext,
  submitEnrollment,
} as const;

void proofContextResultValidator;
