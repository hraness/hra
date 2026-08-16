import { z } from "@hra-internal/schema";

import {
  acceptedSessionHeadSchema,
  decodeSyncUint64,
  MAX_SYNC_DEVICES,
  MAX_SYNC_DIRECTORY_PAGE_SIZE,
  MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS,
  positiveSyncUint64Schema,
  sealedSessionSummarySchema,
  sessionDirectoryChangePageSchema,
  sessionDirectoryCursorSchema,
  sessionDirectorySnapshotPageSchema,
  sessionPublicIdSchema,
  sessionSyncEnrollmentRequestIdSchema,
  sessionSyncHelloSchema,
  sessionSyncNegotiationSchema,
  sessionSyncTombstoneSchema,
  syncBootIdSchema,
  syncDeviceIdSchema,
  syncEnrollmentPossessionProofSchema,
  syncDevicePublicKeysSchema,
  syncDeviceProofSchema,
  syncMembershipCandidateSchema,
  syncMembershipHeadSchema,
  syncMembershipSignatureSchema,
  syncSha256DigestSchema,
  syncTenantIdSchema,
  syncOrganizationIdSchema,
  syncOwnerUserIdSchema,
  syncUint64Schema,
  syncVaultIdSchema,
  syncVaultCoordinateSchema,
  wrappedSyncVaultRootKeySchema,
  wrappedSyncVaultRootKeyLinkSchema,
} from "./session-sync";
import {
  syncEnrollmentPairingCodeSchema,
  syncEnrollmentPairingTranscriptSchema,
} from "./session-sync-pairing";
import {
  recoverSyncVaultRequestSchema,
  syncRecoveryAuthoritySchema,
  syncRecoveryReceiptSchema,
  wrappedSyncRecoveryVaultRootKeySchema,
} from "./session-sync-recovery";

export const SESSION_SYNC_BACKEND_REQUEST_VERSION = 1 as const;
/** Fits the exact 8-device by 8-retained-epoch wrapped-root cross product. */
export const MAX_SESSION_SYNC_REQUEST_JSON_BYTES = 64 * 1_024;
export const MAX_SESSION_SYNC_RESPONSE_JSON_BYTES = 512 * 1_024;
export const MAX_SESSION_SYNC_HTTP_BODY_BYTES = 96 * 1_024;
/** Three missed 20-second heartbeats before another device is rendered offline. */
export const SESSION_SYNC_DEVICE_ONLINE_TTL_MS = 60_000;

export const sessionSyncHttpRoutes = Object.freeze({
  negotiate: "/v1/hra/session-sync/negotiate",
  bootstrap: "/v1/hra/session-sync/bootstrap",
  enrollmentSubmit: "/v1/hra/session-sync/enrollments",
  enrollmentClaim: "/v1/hra/session-sync/enrollments/claim",
  recoveryContext: "/v1/hra/session-sync/recovery-context",
  recover: "/v1/hra/session-sync/recover",
  execute: "/v1/hra/session-sync/execute",
});

/** Input-only aliases for clients deployed before the HRA route cutover. */
export const legacyOprteSessionSyncHttpRoutes = Object.freeze({
  negotiate: "/v1/oprte/session-sync/negotiate",
  bootstrap: "/v1/oprte/session-sync/bootstrap",
  enrollmentSubmit: "/v1/oprte/session-sync/enrollments",
  enrollmentClaim: "/v1/oprte/session-sync/enrollments/claim",
  recoveryContext: "/v1/oprte/session-sync/recovery-context",
  recover: "/v1/oprte/session-sync/recover",
  execute: "/v1/oprte/session-sync/execute",
});

export const sessionSyncSnapshotIdSchema = z.string()
  .regex(/^syncsnapshot_[A-Za-z0-9_-]{32}$/u, "invalid sync snapshot ID");
const sessionSyncDeviceNameSchema = z.string().trim().min(1).max(80)
  .refine(
    (value) => [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    }),
    "device name contains control characters",
  );

const requestBase = { version: z.literal(SESSION_SYNC_BACKEND_REQUEST_VERSION) } as const;

export const bootstrapSyncVaultRequestSchema = z.object({
  ...requestBase,
  membershipHead: syncMembershipHeadSchema,
  wrappedRoot: wrappedSyncVaultRootKeySchema,
  recoveryAuthority: syncRecoveryAuthoritySchema,
  recoveryRootWrap: wrappedSyncRecoveryVaultRootKeySchema,
}).strict();
export type BootstrapSyncVaultRequest = z.infer<typeof bootstrapSyncVaultRequestSchema>;

export const submitSyncEnrollmentIntentSchema = z.object({
  ...requestBase,
  vaultId: syncVaultIdSchema,
  vaultGeneration: positiveSyncUint64Schema,
  deviceId: syncDeviceIdSchema,
  name: sessionSyncDeviceNameSchema,
  keys: syncDevicePublicKeysSchema,
}).strict();
export const submitSyncEnrollmentRequestSchema = submitSyncEnrollmentIntentSchema.extend({
  possessionProof: syncEnrollmentPossessionProofSchema,
}).strict().superRefine((request, context) => {
  const payload = request.possessionProof.payload;
  if (
    payload.purpose !== "submit"
    || payload.vaultId !== request.vaultId
    || payload.vaultGeneration !== request.vaultGeneration
    || payload.deviceId !== request.deviceId
  ) {
    context.addIssue({
      code: "custom",
      message: "enrollment submit proof does not match its candidate intent",
      path: ["possessionProof"],
    });
  }
});
export type SubmitSyncEnrollmentRequest = z.infer<typeof submitSyncEnrollmentRequestSchema>;

export const claimSyncEnrollmentIntentSchema = z.object({
  ...requestBase,
  vaultId: syncVaultIdSchema,
  vaultGeneration: positiveSyncUint64Schema,
  requestId: sessionSyncEnrollmentRequestIdSchema,
  deviceId: syncDeviceIdSchema,
  keys: syncDevicePublicKeysSchema,
  pairingDigest: syncSha256DigestSchema,
}).strict();
export const claimSyncEnrollmentRequestSchema = claimSyncEnrollmentIntentSchema.extend({
  possessionProof: syncEnrollmentPossessionProofSchema,
}).strict().superRefine((request, context) => {
  const payload = request.possessionProof.payload;
  if (
    payload.purpose !== "claim"
    || payload.vaultId !== request.vaultId
    || payload.vaultGeneration !== request.vaultGeneration
    || payload.deviceId !== request.deviceId
  ) {
    context.addIssue({
      code: "custom",
      message: "enrollment claim proof does not match its candidate intent",
      path: ["possessionProof"],
    });
  }
});
export type ClaimSyncEnrollmentRequest = z.infer<typeof claimSyncEnrollmentRequestSchema>;

export const updateSyncMembershipRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("update_membership"),
  membershipHead: syncMembershipHeadSchema,
  wrappedRoots: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  rootKeyLink: wrappedSyncVaultRootKeyLinkSchema.optional(),
  recoveryRootWrap: wrappedSyncRecoveryVaultRootKeySchema,
}).strict();

export const admitSyncMembershipProposalRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("admit_membership_proposal"),
  proposalKind: z.enum(["update", "enrollment"]),
  enrollmentRequestId: sessionSyncEnrollmentRequestIdSchema.optional(),
  pairingDigest: syncSha256DigestSchema.optional(),
  membershipCandidate: syncMembershipCandidateSchema,
  wrappedRoots: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  rootKeyLink: wrappedSyncVaultRootKeyLinkSchema.optional(),
  recoveryRootWrap: wrappedSyncRecoveryVaultRootKeySchema,
}).strict().superRefine((request, context) => {
  const enrollment = request.proposalKind === "enrollment";
  if (
    enrollment !== (request.enrollmentRequestId !== undefined)
    || enrollment !== (request.pairingDigest !== undefined)
    || (enrollment
      ? request.membershipCandidate.statement.enrollmentPairingDigest !== request.pairingDigest
      : request.membershipCandidate.statement.enrollmentPairingDigest !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "membership proposal kind and enrollment authority must agree",
      path: ["proposalKind"],
    });
  }
});

export const readSyncMembershipRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("read_membership"),
}).strict();

export const listSyncEnrollmentRequestsSchema = z.object({
  ...requestBase,
  operation: z.literal("list_enrollment_requests"),
}).strict();

export const approveSyncEnrollmentRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("approve_enrollment"),
  requestId: sessionSyncEnrollmentRequestIdSchema,
  pairingDigest: syncSha256DigestSchema,
  membershipHead: syncMembershipHeadSchema,
  wrappedRoots: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  rootKeyLink: wrappedSyncVaultRootKeyLinkSchema.optional(),
  recoveryRootWrap: wrappedSyncRecoveryVaultRootKeySchema,
}).strict();

export const readSyncRecoveryContextRequestSchema = z.object({
  ...requestBase,
  vault: z.object({
    tenantId: syncTenantIdSchema,
    organizationId: syncOrganizationIdSchema,
    ownerUserId: syncOwnerUserIdSchema,
    vaultId: syncVaultIdSchema,
    vaultGeneration: positiveSyncUint64Schema,
  }).strict(),
}).strict();


export const readSyncRootKeyLinkPageRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("root_key_link_page"),
  beforeChildRootKeyEpoch: positiveSyncUint64Schema.optional(),
  pageSize: z.number().int().min(1).max(MAX_SYNC_DIRECTORY_PAGE_SIZE),
}).strict();

export const establishSyncBootRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("establish_boot"),
  bootId: syncBootIdSchema,
  /** Omit after local database loss; the relay assigns the next fenced generation. */
  bootGeneration: positiveSyncUint64Schema.optional(),
  heartbeatSequence: positiveSyncUint64Schema,
}).strict();

export const syncHeartbeatRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("heartbeat"),
  bootId: syncBootIdSchema,
  bootGeneration: positiveSyncUint64Schema,
  heartbeatSequence: positiveSyncUint64Schema,
}).strict();

export const reserveSyncSessionRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("reserve_session"),
  sessionId: sessionPublicIdSchema,
  creationGrantDigest: syncSha256DigestSchema,
}).strict();

export const acquireSyncWriterRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("acquire_writer"),
  sessionId: sessionPublicIdSchema,
  bootId: syncBootIdSchema,
  bootGeneration: positiveSyncUint64Schema,
  acknowledgedMirrorEpoch: positiveSyncUint64Schema,
  acknowledgedSequence: syncUint64Schema,
  acknowledgedDigest: syncSha256DigestSchema.nullable(),
}).strict();

export const publishSyncSessionRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("publish_session"),
  envelope: sealedSessionSummarySchema,
}).strict();

export const deleteSyncSessionRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("delete_session"),
  sessionId: sessionPublicIdSchema,
  originDeviceId: syncDeviceIdSchema,
  mirrorEpoch: positiveSyncUint64Schema,
  writerGeneration: positiveSyncUint64Schema,
  bootId: syncBootIdSchema,
  bootGeneration: positiveSyncUint64Schema,
  membershipEpoch: positiveSyncUint64Schema,
  keyEpoch: positiveSyncUint64Schema,
  syncSequence: positiveSyncUint64Schema,
  sourceRevision: positiveSyncUint64Schema,
  previousDigest: syncSha256DigestSchema,
  tombstoneDigest: syncSha256DigestSchema,
}).strict();

export const beginSyncSnapshotRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("begin_snapshot"),
  snapshotId: sessionSyncSnapshotIdSchema,
}).strict();

export const readSyncSnapshotPageRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("snapshot_page"),
  snapshotId: sessionSyncSnapshotIdSchema,
  after: sessionDirectoryCursorSchema.optional(),
  pageSize: z.number().int().min(1).max(MAX_SYNC_DIRECTORY_PAGE_SIZE),
}).strict();

export const readSyncChangePageRequestSchema = z.object({
  ...requestBase,
  operation: z.literal("change_page"),
  afterVersion: syncUint64Schema,
  pageSize: z.number().int().min(1).max(MAX_SYNC_DIRECTORY_PAGE_SIZE),
}).strict();

export const sessionSyncBackendRequestSchema = z.discriminatedUnion("operation", [
  admitSyncMembershipProposalRequestSchema,
  updateSyncMembershipRequestSchema,
  readSyncMembershipRequestSchema,
  readSyncRootKeyLinkPageRequestSchema,
  listSyncEnrollmentRequestsSchema,
  approveSyncEnrollmentRequestSchema,
  establishSyncBootRequestSchema,
  syncHeartbeatRequestSchema,
  reserveSyncSessionRequestSchema,
  acquireSyncWriterRequestSchema,
  publishSyncSessionRequestSchema,
  deleteSyncSessionRequestSchema,
  beginSyncSnapshotRequestSchema,
  readSyncSnapshotPageRequestSchema,
  readSyncChangePageRequestSchema,
]);
export type SessionSyncBackendRequest = z.infer<typeof sessionSyncBackendRequestSchema>;

export const sessionSyncBackendNonRateErrorCodes = [
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_DENIED",
  "CONFLICT",
  "DIRECTORY_LIMIT",
  "DEVICE_LIMIT",
  "EVENT_LIMIT",
  "FORBIDDEN_CONTENT",
  "GRANT_EXPIRED",
  "INVALID_REQUEST",
  "MAINTENANCE_REQUIRED",
  "NOT_FOUND",
  "PROOF_EXPIRED",
  "PROOF_INVALID",
  "PROOF_REPLAYED",
  "QUOTA_EXCEEDED",
  "KEY_EPOCH_LIMIT",
  "RETIRED",
  "SEQUENCE_GAP",
  "SERVICE_UNAVAILABLE",
  "SNAPSHOT_EXPIRED",
  "STALE_BOOT",
  "STALE_MEMBERSHIP",
  "STALE_MIRROR",
  "STALE_REVISION",
  "STALE_WRITER",
  "UPDATE_REQUIRED",
] as const;
export const sessionSyncBackendErrorCodes = [
  ...sessionSyncBackendNonRateErrorCodes,
  "RATE_LIMITED",
] as const;
export const sessionSyncBackendErrorCodeSchema = z.enum(sessionSyncBackendErrorCodes);
export const sessionSyncBackendNonRateErrorCodeSchema = z.enum(
  sessionSyncBackendNonRateErrorCodes,
);
export type SessionSyncBackendErrorCode = z.infer<typeof sessionSyncBackendErrorCodeSchema>;

const vaultCreatedResponseSchema = z.object({
  kind: z.literal("vault_created"),
  vault: syncVaultCoordinateSchema,
  membershipEpoch: positiveSyncUint64Schema,
  rootKeyEpoch: positiveSyncUint64Schema,
  vaultId: syncVaultIdSchema,
}).strict();
const membershipAcceptedResponseSchema = z.object({
  kind: z.literal("membership_accepted"),
  membershipEpoch: positiveSyncUint64Schema,
  membershipDigest: syncSha256DigestSchema,
}).strict();
export const syncMembershipProposalViewSchema = z.object({
  proposalKind: z.enum(["update", "enrollment"]),
  enrollmentRequestId: sessionSyncEnrollmentRequestIdSchema.optional(),
  candidate: syncMembershipCandidateSchema,
  signatures: z.array(syncMembershipSignatureSchema).max(MAX_SYNC_DEVICES),
  signingIntentDeviceIds: z.array(syncDeviceIdSchema).max(MAX_SYNC_DEVICES),
  wrappedRoots: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  collectedVotes: z.number().int().min(0).max(MAX_SYNC_DEVICES),
  requiredVotes: z.number().int().min(1).max(MAX_SYNC_DEVICES),
  admissionExpiresAt: positiveSyncUint64Schema,
  irrevocable: z.boolean(),
  rootKeyLink: wrappedSyncVaultRootKeyLinkSchema.optional(),
  recoveryRootWrap: wrappedSyncRecoveryVaultRootKeySchema,
}).strict().superRefine((proposal, context) => {
  if ((proposal.proposalKind === "enrollment") !== (proposal.enrollmentRequestId !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "only enrollment proposals carry an enrollment request ID",
      path: ["enrollmentRequestId"],
    });
  }
  if (
    proposal.collectedVotes !== proposal.signatures.length
    || proposal.collectedVotes >= proposal.requiredVotes
    || proposal.irrevocable !== (proposal.signingIntentDeviceIds.length > 0)
    || new Set(proposal.signingIntentDeviceIds).size !== proposal.signingIntentDeviceIds.length
    || proposal.signatures.some(
      (signature) => !proposal.signingIntentDeviceIds.includes(signature.deviceId),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "pending membership proposal vote counts are incoherent",
      path: ["collectedVotes"],
    });
  }
});
export type SyncMembershipProposalView = z.infer<typeof syncMembershipProposalViewSchema>;
const membershipPendingResponseSchema = z.object({
  kind: z.literal("membership_pending"),
  proposal: syncMembershipProposalViewSchema,
}).strict();
export const syncDeviceConnectionSchema = z.enum(["online", "offline", "unknown"]);
export type SyncDeviceConnection = z.infer<typeof syncDeviceConnectionSchema>;
export const syncDevicePresenceSchema = z.object({
  deviceId: syncDeviceIdSchema,
  connection: syncDeviceConnectionSchema,
}).strict();
export type SyncDevicePresence = z.infer<typeof syncDevicePresenceSchema>;
const membershipResponseSchema = z.object({
  kind: z.literal("membership"),
  head: syncMembershipHeadSchema,
  wrappedRoot: wrappedSyncVaultRootKeySchema,
  wrappedRoots: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  rootWrapManifest: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  devicePresence: z.array(syncDevicePresenceSchema).max(MAX_SYNC_DEVICES),
  proposal: syncMembershipProposalViewSchema.optional(),
}).strict().superRefine((response, context) => {
  const members = response.head.statement.members.toSorted((left, right) =>
    left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0
  );
  if (
    response.devicePresence.length !== members.length
    || response.devicePresence.some((presence, index) =>
      presence.deviceId !== members[index]?.deviceId
      || (members[index]?.status === "revoked" && presence.connection !== "offline")
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "device presence must exactly cover the ordered current membership",
      path: ["devicePresence"],
    });
  }
});
const enrollmentRequestViewSchema = z.object({
  requestId: sessionSyncEnrollmentRequestIdSchema,
  deviceId: syncDeviceIdSchema,
  name: sessionSyncDeviceNameSchema,
  keys: syncDevicePublicKeysSchema,
  pairingDigest: syncSha256DigestSchema,
  pairingCode: syncEnrollmentPairingCodeSchema,
  pairingTranscript: syncEnrollmentPairingTranscriptSchema,
  createdAt: positiveSyncUint64Schema,
  expiresAt: positiveSyncUint64Schema,
}).strict();
const enrollmentSubmittedResponseSchema = z.object({
  kind: z.literal("enrollment_submitted"),
  vault: syncVaultCoordinateSchema,
  requestId: sessionSyncEnrollmentRequestIdSchema,
  deviceId: syncDeviceIdSchema,
  expiresAt: positiveSyncUint64Schema,
  pairingDigest: syncSha256DigestSchema,
  pairingCode: syncEnrollmentPairingCodeSchema,
  pairingTranscript: syncEnrollmentPairingTranscriptSchema,
  replay: z.boolean(),
}).strict();
const enrollmentRequestsResponseSchema = z.object({
  kind: z.literal("enrollment_requests"),
  vault: syncVaultCoordinateSchema,
  requests: z.array(enrollmentRequestViewSchema).max(8),
}).strict();
const enrollmentApprovedResponseSchema = z.object({
  kind: z.literal("enrollment_approved"),
  vault: syncVaultCoordinateSchema,
  requestId: sessionSyncEnrollmentRequestIdSchema,
  membershipEpoch: positiveSyncUint64Schema,
}).strict();
const enrollmentPendingResponseSchema = z.object({
  kind: z.literal("enrollment_pending"),
  vault: syncVaultCoordinateSchema,
  requestId: sessionSyncEnrollmentRequestIdSchema,
  expiresAt: positiveSyncUint64Schema,
  pairingDigest: syncSha256DigestSchema,
  pairingCode: syncEnrollmentPairingCodeSchema,
  pairingTranscript: syncEnrollmentPairingTranscriptSchema,
}).strict();
const enrollmentClaimedResponseSchema = z.object({
  kind: z.literal("enrollment_claimed"),
  vault: syncVaultCoordinateSchema,
  requestId: sessionSyncEnrollmentRequestIdSchema,
  head: syncMembershipHeadSchema,
  wrappedRoot: wrappedSyncVaultRootKeySchema,
  wrappedRoots: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  rootWrapManifest: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  pairingDigest: syncSha256DigestSchema,
  pairingTranscript: syncEnrollmentPairingTranscriptSchema,
}).strict();
const vaultRecoveredResponseSchema = z.object({
  kind: z.literal("vault_recovered"),
  vault: syncVaultCoordinateSchema,
  membershipEpoch: positiveSyncUint64Schema,
  recoveryGeneration: positiveSyncUint64Schema,
  rootKeyEpoch: positiveSyncUint64Schema,
  receipt: syncRecoveryReceiptSchema,
  replay: z.boolean(),
}).strict();
const recoveryContextResponseSchema = z.object({
  kind: z.literal("recovery_context"),
  vault: syncVaultCoordinateSchema,
  authority: syncRecoveryAuthoritySchema,
  membershipHead: syncMembershipHeadSchema,
  recoveryRootWrap: wrappedSyncRecoveryVaultRootKeySchema,
}).strict();
const bootCurrentResponseSchema = z.object({
  kind: z.literal("boot_current"),
  vault: syncVaultCoordinateSchema,
  bootGeneration: positiveSyncUint64Schema,
  bootId: syncBootIdSchema,
  heartbeatSequence: positiveSyncUint64Schema,
}).strict();
const sessionReservedResponseSchema = z.object({
  kind: z.literal("session_reserved"),
  vault: syncVaultCoordinateSchema,
  creationGrantDigest: syncSha256DigestSchema,
  directoryOrdinal: positiveSyncUint64Schema,
  expiresAt: positiveSyncUint64Schema,
  sessionId: sessionPublicIdSchema,
}).strict();
const writerAcquiredResponseSchema = z.object({
  kind: z.literal("writer_acquired"),
  vault: syncVaultCoordinateSchema,
  bootGeneration: positiveSyncUint64Schema,
  bootId: syncBootIdSchema,
  mirrorEpoch: positiveSyncUint64Schema,
  writerGeneration: positiveSyncUint64Schema,
}).strict();
const reconcileRequiredResponseSchema = z.object({
  kind: z.literal("reconcile_required"),
  vault: syncVaultCoordinateSchema,
  ciphertextDigest: syncSha256DigestSchema,
  mirrorEpoch: positiveSyncUint64Schema,
  sourceRevision: positiveSyncUint64Schema,
  syncSequence: positiveSyncUint64Schema,
}).strict();
const sessionAcceptedResponseSchema = z.object({
  kind: z.literal("session_accepted"),
  accepted: acceptedSessionHeadSchema,
  replay: z.boolean(),
}).strict();
const sessionDeletedResponseSchema = z.object({
  kind: z.literal("session_deleted"),
  replay: z.boolean(),
  tombstone: sessionSyncTombstoneSchema,
}).strict();
const snapshotStartedResponseSchema = z.object({
  kind: z.literal("snapshot_started"),
  vault: syncVaultCoordinateSchema,
  expiresAt: positiveSyncUint64Schema,
  snapshotId: sessionSyncSnapshotIdSchema,
  snapshotVersion: syncUint64Schema,
}).strict();
const snapshotPageResponseSchema = z.object({
  kind: z.literal("snapshot_page"),
  page: sessionDirectorySnapshotPageSchema,
}).strict();
const changePageResponseSchema = z.object({
  kind: z.literal("change_page"),
  page: sessionDirectoryChangePageSchema,
}).strict();
const resnapshotRequiredResponseSchema = z.object({
  kind: z.literal("resnapshot_required"),
  vault: syncVaultCoordinateSchema,
  floorVersion: syncUint64Schema,
}).strict();
const rootKeyLinkPageResponseSchema = z.object({
  kind: z.literal("root_key_link_page"),
  vault: syncVaultCoordinateSchema,
  links: z.array(wrappedSyncVaultRootKeyLinkSchema).max(MAX_SYNC_DIRECTORY_PAGE_SIZE),
  hasMore: z.boolean(),
  nextBeforeChildRootKeyEpoch: positiveSyncUint64Schema.optional(),
}).strict().superRefine((page, context) => {
  if (page.hasMore !== (page.nextBeforeChildRootKeyEpoch !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "root key link continuation and hasMore must agree",
      path: ["nextBeforeChildRootKeyEpoch"],
    });
  }
  if (page.hasMore && page.links.length === 0) {
    context.addIssue({
      code: "custom",
      message: "continued root key link pages cannot be empty",
      path: ["links"],
    });
  }
  for (let index = 1; index < page.links.length; index += 1) {
    const previous = page.links[index - 1];
    const current = page.links[index];
    if (
      previous === undefined
      || current === undefined
      || decodeSyncUint64(previous.context.childRootKeyEpoch)
        <= decodeSyncUint64(current.context.childRootKeyEpoch)
    ) {
      context.addIssue({
        code: "custom",
        message: "root key links must be unique and strictly descending by child epoch",
        path: ["links", index],
      });
      break;
    }
  }
  if (
    page.hasMore
    && page.nextBeforeChildRootKeyEpoch
      !== page.links.at(-1)?.context.childRootKeyEpoch
  ) {
    context.addIssue({
      code: "custom",
      message: "root key link continuation must equal the final returned child epoch",
      path: ["nextBeforeChildRootKeyEpoch"],
    });
  }
});

export const sessionSyncBackendResponseSchema = z.discriminatedUnion("kind", [
  vaultCreatedResponseSchema,
  membershipAcceptedResponseSchema,
  membershipPendingResponseSchema,
  membershipResponseSchema,
  enrollmentSubmittedResponseSchema,
  enrollmentRequestsResponseSchema,
  enrollmentApprovedResponseSchema,
  enrollmentPendingResponseSchema,
  enrollmentClaimedResponseSchema,
  vaultRecoveredResponseSchema,
  recoveryContextResponseSchema,
  bootCurrentResponseSchema,
  sessionReservedResponseSchema,
  writerAcquiredResponseSchema,
  reconcileRequiredResponseSchema,
  sessionAcceptedResponseSchema,
  sessionDeletedResponseSchema,
  snapshotStartedResponseSchema,
  snapshotPageResponseSchema,
  changePageResponseSchema,
  resnapshotRequiredResponseSchema,
  rootKeyLinkPageResponseSchema,
]);
export type SessionSyncBackendResponse = z.infer<typeof sessionSyncBackendResponseSchema>;

export const sessionSyncBackendResultSchema = z.union([
  z.object({ ok: z.literal(true), responseJson: z.string() }).strict(),
  z.object({
    ok: z.literal(false),
    code: sessionSyncBackendNonRateErrorCodeSchema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.literal("RATE_LIMITED"),
    retryAfterMs: z.number().int().min(1).max(300_000),
  }).strict(),
]);
export type SessionSyncBackendResult = z.infer<typeof sessionSyncBackendResultSchema>;

export const sessionSyncInvocationSchema = z.object({
  requestJson: z.string(),
  proofJson: z.string(),
}).strict();
export const sessionSyncHumanInvocationSchema = z.object({
  requestJson: z.string(),
}).strict();
export const sessionSyncNegotiationInvocationSchema = z.object({
  helloJson: z.string(),
}).strict();

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseBoundedJson<Schema extends { parse: (value: unknown) => unknown }>(
  value: string,
  maximumBytes: number,
  schema: Schema,
): ReturnType<Schema["parse"]> {
  if (utf8Bytes(value) > maximumBytes) throw new RangeError("session sync JSON exceeds its byte bound");
  return schema.parse(JSON.parse(value) as unknown) as ReturnType<Schema["parse"]>;
}

export function parseSessionSyncRequestJson(value: string): SessionSyncBackendRequest {
  return parseBoundedJson(value, MAX_SESSION_SYNC_REQUEST_JSON_BYTES, sessionSyncBackendRequestSchema);
}

export function parseBootstrapSyncVaultRequestJson(value: string): BootstrapSyncVaultRequest {
  return parseBoundedJson(value, MAX_SESSION_SYNC_REQUEST_JSON_BYTES, bootstrapSyncVaultRequestSchema);
}

export function parseSubmitSyncEnrollmentRequestJson(value: string): SubmitSyncEnrollmentRequest {
  return parseBoundedJson(value, MAX_SESSION_SYNC_REQUEST_JSON_BYTES, submitSyncEnrollmentRequestSchema);
}

export function parseClaimSyncEnrollmentRequestJson(value: string): ClaimSyncEnrollmentRequest {
  return parseBoundedJson(value, MAX_SESSION_SYNC_REQUEST_JSON_BYTES, claimSyncEnrollmentRequestSchema);
}

export function parseRecoverSyncVaultRequestJson(value: string) {
  return parseBoundedJson(value, MAX_SESSION_SYNC_REQUEST_JSON_BYTES, recoverSyncVaultRequestSchema);
}


export function parseReadSyncRecoveryContextRequestJson(value: string) {
  return parseBoundedJson(value, MAX_SESSION_SYNC_REQUEST_JSON_BYTES, readSyncRecoveryContextRequestSchema);
}

export function parseSessionSyncProofJson(value: string) {
  return parseBoundedJson(value, MAX_SESSION_SYNC_REQUEST_JSON_BYTES, syncDeviceProofSchema);
}

export function parseSessionSyncResponseJson(value: string): SessionSyncBackendResponse {
  return parseBoundedJson(value, MAX_SESSION_SYNC_RESPONSE_JSON_BYTES, sessionSyncBackendResponseSchema);
}

export function parseSessionSyncHelloJson(value: string) {
  return parseBoundedJson(value, MAX_SESSION_SYNC_REQUEST_JSON_BYTES, sessionSyncHelloSchema);
}

export function parseSessionSyncNegotiationJson(value: string) {
  return parseBoundedJson(value, MAX_SESSION_SYNC_RESPONSE_JSON_BYTES, sessionSyncNegotiationSchema);
}

export function routeForSessionSyncRequest(request: SessionSyncBackendRequest): string {
  switch (request.operation) {
    case "read_membership": return "sync.membership.read";
    case "root_key_link_page": return "sync.membership.read";
    case "list_enrollment_requests": return "sync.membership.read";
    case "admit_membership_proposal": return "sync.membership.update";
    case "update_membership": return "sync.membership.update";
    case "approve_enrollment": return "sync.membership.update";
    case "establish_boot":
    case "heartbeat": return "sync.device.heartbeat";
    case "reserve_session":
    case "acquire_writer":
    case "publish_session": return "sync.session.publish";
    case "delete_session": return "sync.session.delete";
    case "begin_snapshot":
    case "snapshot_page": return "sync.directory.snapshot";
    case "change_page": return "sync.directory.changes";
  }
}
