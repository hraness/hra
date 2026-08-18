import { z } from "@hra-internal/schema";

export const SESSION_SYNC_PROTOCOL = "oprte.session-sync/v1" as const;
export const SESSION_SYNC_PAYLOAD_VERSION = 1 as const;
export const MAX_SYNC_DEVICES = 8;
export const MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS = 8;
export const MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE = 64;
export const MAX_SYNC_DIRECTORY_SESSIONS = 512;
/** A fail-closed lifetime fence; retired identities remain non-resurrectable evidence. */
export const MAX_SYNC_LIFETIME_DIRECTORY_IDENTITIES = 65_536;
/** Immutable membership evidence is retained until an explicit vault maintenance migration. */
export const MAX_SYNC_LIFETIME_MEMBERSHIP_EPOCHS = 8_192;
export const MAX_SYNC_LIFETIME_ROOT_KEY_EPOCHS = 8_192;
export const MAX_SYNC_DIRECTORY_PAGE_SIZE = 100;
export const MAX_SYNC_ACTIVE_STREAMS = 64;
export const MAX_SYNC_TITLE_UTF8_BYTES = 256;
export const MAX_SYNC_REPOSITORY_DISPLAY_NAME_UTF8_BYTES = 160;
export const MAX_SYNC_SUMMARY_PLAINTEXT_BYTES = 1_024;
export const MAX_SYNC_SUMMARY_CIPHERTEXT_BYTES =
  MAX_SYNC_SUMMARY_PLAINTEXT_BYTES + 16;
export const MAX_SYNC_RETAINED_CIPHERTEXT_BYTES = 64 * 1_024 * 1_024;
export const MAX_SYNC_RETAINED_EVENTS = 8_192;
export const MAX_SYNC_PROOF_TTL_MS = 2 * 60 * 1_000;
export const SYNC_ENROLLMENT_POSSESSION_PROOF_TTL_MS = 2 * 60 * 1_000;
export const SYNC_UINT64_MAX = (1n << 64n) - 1n;
/** Four-byte closed nonce domain (`OPRT`) followed by the uint64 sync sequence. */
export const SESSION_SYNC_NONCE_DOMAIN_PREFIX = "T1BSVA" as const;

const textEncoder = new TextEncoder();
const OPAQUE_SUFFIX = "[A-Za-z0-9_-]{32}";

function opaqueId<Brand extends string>(prefix: string) {
  return z.string()
    .regex(new RegExp(`^${prefix}_${OPAQUE_SUFFIX}$`, "u"), `invalid ${prefix} ID`)
    .brand<Brand>();
}

export const syncTenantIdSchema = opaqueId<"SyncTenantId">("synctenant");
export const syncOrganizationIdSchema = opaqueId<"SyncOrganizationId">("syncorg");
export const syncOwnerUserIdSchema = opaqueId<"SyncOwnerUserId">("syncuser");
export const syncVaultIdSchema = opaqueId<"SyncVaultId">("syncvault");
export const syncDeviceIdSchema = opaqueId<"SyncDeviceId">("syncdevice");
export const sessionPublicIdSchema = opaqueId<"SessionPublicId">("syncsession");
export const syncBootIdSchema = opaqueId<"SyncBootId">("syncboot");
export const syncKeyIdSchema = opaqueId<"SyncKeyId">("synckey");
export const syncProofNonceSchema = opaqueId<"SyncProofNonce">("syncproof");
export const sessionSyncEnrollmentRequestIdSchema = z.string()
  .regex(/^syncenroll_[A-Za-z0-9_-]{32}$/u, "invalid sync enrollment request ID");

export type SyncTenantId = z.infer<typeof syncTenantIdSchema>;
export type SyncOrganizationId = z.infer<typeof syncOrganizationIdSchema>;
export type SyncOwnerUserId = z.infer<typeof syncOwnerUserIdSchema>;
export type SyncVaultId = z.infer<typeof syncVaultIdSchema>;
export type SyncDeviceId = z.infer<typeof syncDeviceIdSchema>;
export type SessionPublicId = z.infer<typeof sessionPublicIdSchema>;
export type SyncBootId = z.infer<typeof syncBootIdSchema>;
export type SyncKeyId = z.infer<typeof syncKeyIdSchema>;
export type SyncProofNonce = z.infer<typeof syncProofNonceSchema>;

/** Canonical decimal JSON encoding for an unsigned 64-bit integer. */
export const syncUint64Schema = z.string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/u, "invalid canonical uint64")
  .refine(isUint64InRange, "uint64 is out of range")
  .brand<"SyncUint64">();
export const positiveSyncUint64Schema = syncUint64Schema.refine(
  (value) => value !== "0",
  "uint64 must be positive",
);
export type SyncUint64 = z.infer<typeof syncUint64Schema>;
export type PositiveSyncUint64 = z.infer<typeof positiveSyncUint64Schema>;

export function encodeSyncUint64(value: bigint): SyncUint64 {
  if (value < 0n || value > SYNC_UINT64_MAX) {
    throw new RangeError("sync sequence is outside the unsigned 64-bit range");
  }
  return syncUint64Schema.parse(value.toString(10));
}

export function decodeSyncUint64(value: SyncUint64 | string): bigint {
  return BigInt(syncUint64Schema.parse(value));
}

export function nextSyncUint64(value: SyncUint64 | string): SyncUint64 | null {
  const parsed = decodeSyncUint64(value);
  return parsed === SYNC_UINT64_MAX ? null : encodeSyncUint64(parsed + 1n);
}

export const syncSha256DigestSchema = z.string()
  .regex(/^sha256_[a-f0-9]{64}$/u, "invalid SHA-256 digest")
  .brand<"SyncSha256Digest">();
export type SyncSha256Digest = z.infer<typeof syncSha256DigestSchema>;

const base64UrlSchema = (minimumBytes: number, maximumBytes: number) => z.string()
  .regex(/^[A-Za-z0-9_-]+$/u, "invalid canonical base64url")
  .refine((value) => value.length % 4 !== 1, "invalid canonical base64url length")
  .refine(isCanonicalBase64Url, "invalid canonical base64url trailing bits")
  .refine((value) => {
    const bytes = Math.floor(value.length * 3 / 4);
    return bytes >= minimumBytes && bytes <= maximumBytes;
  }, `base64url bytes must be between ${minimumBytes} and ${maximumBytes}`);

export const syncP256PublicKeySchema = base64UrlSchema(65, 65)
  .length(87)
  .brand<"SyncP256PublicKey">();
export const syncP256SignatureSchema = base64UrlSchema(64, 64)
  .length(86)
  .brand<"SyncP256Signature">();
export const syncAesGcmNonceSchema = base64UrlSchema(12, 12)
  .length(16)
  .brand<"SyncAesGcmNonce">();
export type SyncP256PublicKey = z.infer<typeof syncP256PublicKeySchema>;
export type SyncP256Signature = z.infer<typeof syncP256SignatureSchema>;
export type SyncAesGcmNonce = z.infer<typeof syncAesGcmNonceSchema>;

const tenantCoordinateShape = {
  tenantId: syncTenantIdSchema,
  organizationId: syncOrganizationIdSchema,
  ownerUserId: syncOwnerUserIdSchema,
} as const;
const vaultCoordinateShape = {
  ...tenantCoordinateShape,
  vaultId: syncVaultIdSchema,
  vaultGeneration: positiveSyncUint64Schema,
} as const;
const membershipCoordinateShape = {
  ...vaultCoordinateShape,
  membershipEpoch: positiveSyncUint64Schema,
} as const;
const writerCoordinateShape = {
  ...membershipCoordinateShape,
  originDeviceId: syncDeviceIdSchema,
  sessionId: sessionPublicIdSchema,
  mirrorEpoch: positiveSyncUint64Schema,
  writerGeneration: positiveSyncUint64Schema,
  bootId: syncBootIdSchema,
  bootGeneration: positiveSyncUint64Schema,
} as const;

export const syncTenantCoordinateSchema = z.object(tenantCoordinateShape).strict();
export const syncVaultCoordinateSchema = z.object(vaultCoordinateShape).strict();
export const syncMembershipCoordinateSchema = z.object(membershipCoordinateShape).strict();
export const syncWriterCoordinateSchema = z.object(writerCoordinateShape).strict();
export type SyncTenantCoordinate = z.infer<typeof syncTenantCoordinateSchema>;
export type SyncVaultCoordinate = z.infer<typeof syncVaultCoordinateSchema>;
export type SyncMembershipCoordinate = z.infer<typeof syncMembershipCoordinateSchema>;
export type SyncWriterCoordinate = z.infer<typeof syncWriterCoordinateSchema>;

function boundedDisplayText(maximumBytes: number, label: string) {
  return z.string().min(1).refine(
    (value) => textEncoder.encode(value).byteLength <= maximumBytes,
    `${label} exceeds ${maximumBytes} UTF-8 bytes`,
  ).refine((value) => {
    for (const character of value) {
      const codePoint = character.codePointAt(0);
      if (
        codePoint !== undefined
        && (codePoint <= 31
          || (codePoint >= 127 && codePoint <= 159)
          || codePoint === 0x00ad
          || codePoint === 0x061c
          || codePoint === 0x180e
          || codePoint === 0x200b
          || codePoint === 0x200e
          || codePoint === 0x200f
          || (codePoint >= 0x2028 && codePoint <= 0x202e)
          || (codePoint >= 0x2060 && codePoint <= 0x2069)
          || codePoint === 0xfeff)
      ) return false;
    }
    return true;
  }, `${label} contains a control character`);
}

export const sessionSummaryStateValues = [
  "ready",
  "working",
  "attention",
  "error",
  "offline",
] as const;
export const sessionSummaryStateSchema = z.enum(sessionSummaryStateValues);
export const sessionSummarySchema = z.object({
  version: z.literal(SESSION_SYNC_PAYLOAD_VERSION),
  sessionId: sessionPublicIdSchema,
  ownerDeviceId: syncDeviceIdSchema,
  directoryOrdinal: positiveSyncUint64Schema,
  sourceRevision: positiveSyncUint64Schema,
  title: boundedDisplayText(MAX_SYNC_TITLE_UTF8_BYTES, "session title"),
  repositoryDisplayName: boundedDisplayText(
    MAX_SYNC_REPOSITORY_DISPLAY_NAME_UTF8_BYTES,
    "repository display name",
  ).optional(),
  state: sessionSummaryStateSchema,
  originUpdatedAt: syncUint64Schema.optional(),
  deleted: z.boolean(),
}).strict();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionSyncEventKindValues = [
  "created",
  "projection_changed",
  "turn_started",
  "activity",
  "terminal",
  "attention",
  "archived",
  "deleted",
] as const;
export const sessionSyncEventKindSchema = z.enum(sessionSyncEventKindValues);
export type SessionSyncEventKind = z.infer<typeof sessionSyncEventKindSchema>;

export const sessionSyncHeaderSchema = z.object({
  protocol: z.literal(SESSION_SYNC_PROTOCOL),
  payloadVersion: z.literal(SESSION_SYNC_PAYLOAD_VERSION),
  payloadKind: z.literal("session_summary"),
  ...writerCoordinateShape,
  directoryOrdinal: positiveSyncUint64Schema,
  keyEpoch: positiveSyncUint64Schema,
  syncSequence: positiveSyncUint64Schema,
  sourceRevision: positiveSyncUint64Schema,
  eventKind: sessionSyncEventKindSchema,
  previousDigest: syncSha256DigestSchema.nullable(),
  creationGrantDigest: syncSha256DigestSchema.optional(),
}).strict().superRefine((header, context) => {
  if (header.eventKind === "created") {
    if (header.creationGrantDigest === undefined) {
      context.addIssue({
        code: "custom",
        message: "initial publication requires a creation grant digest",
        path: ["creationGrantDigest"],
      });
    }
    if (header.previousDigest !== null || header.syncSequence !== "1") {
      context.addIssue({
        code: "custom",
        message: "initial publication must be sequence one with no predecessor",
        path: ["syncSequence"],
      });
    }
  } else if (header.creationGrantDigest !== undefined) {
    context.addIssue({
      code: "custom",
      message: "only initial publication may carry a creation grant",
      path: ["creationGrantDigest"],
    });
  }
  if (header.syncSequence !== "1" && header.previousDigest === null) {
    context.addIssue({
      code: "custom",
      message: "non-genesis publication requires a predecessor digest",
      path: ["previousDigest"],
    });
  }
});
export type SessionSyncHeader = z.infer<typeof sessionSyncHeaderSchema>;

export const sealedSessionSummarySchema = z.object({
  header: sessionSyncHeaderSchema,
  algorithm: z.literal("P256-HKDF-SHA256-A256GCM"),
  nonce: syncAesGcmNonceSchema,
  ciphertext: base64UrlSchema(17, MAX_SYNC_SUMMARY_CIPHERTEXT_BYTES),
  ciphertextBytes: z.number().int().min(17).max(MAX_SYNC_SUMMARY_CIPHERTEXT_BYTES),
  ciphertextDigest: syncSha256DigestSchema,
}).strict().superRefine((envelope, context) => {
  const measured = Math.floor(envelope.ciphertext.length * 3 / 4);
  if (measured !== envelope.ciphertextBytes) {
    context.addIssue({
      code: "custom",
      message: "ciphertext byte count does not match the envelope",
      path: ["ciphertextBytes"],
    });
  }
});
export type SealedSessionSummary = z.infer<typeof sealedSessionSummarySchema>;

/**
 * A relay assigns the vault-global directory version only after accepting a
 * semantic publication. It cannot be part of client AEAD coordinates because
 * concurrent publishers cannot predict the next global value. Exact replay
 * returns this already-stored wrapper without advancing the version.
 */
export const acceptedSessionHeadSchema = z.object({
  envelope: sealedSessionSummarySchema,
  createdDirectoryVersion: positiveSyncUint64Schema,
  directoryVersion: positiveSyncUint64Schema,
  serverObservedAt: syncUint64Schema,
}).strict().refine(
  (head) => decodeSyncUint64(head.createdDirectoryVersion)
    <= decodeSyncUint64(head.directoryVersion),
  {
    message: "accepted head cannot predate its directory creation",
    path: ["directoryVersion"],
  },
);
export type AcceptedSessionHead = z.infer<typeof acceptedSessionHeadSchema>;

export const syncDevicePublicKeysSchema = z.object({
  version: z.literal(1),
  signing: z.object({
    keyId: syncKeyIdSchema,
    algorithm: z.literal("P256-SHA256"),
    publicKey: syncP256PublicKeySchema,
    publicKeyDigest: syncSha256DigestSchema,
  }).strict(),
  agreement: z.object({
    keyId: syncKeyIdSchema,
    algorithm: z.literal("P256-ECDH"),
    publicKey: syncP256PublicKeySchema,
    publicKeyDigest: syncSha256DigestSchema,
  }).strict(),
}).strict().refine(
  (keys) => keys.signing.keyId !== keys.agreement.keyId,
  { message: "signing and agreement keys require distinct identifiers" },
);
export type SyncDevicePublicKeys = z.infer<typeof syncDevicePublicKeysSchema>;

export const syncEnrollmentPossessionProofPayloadSchema = z.object({
  version: z.literal(1),
  purpose: z.enum(["submit", "claim"]),
  vaultId: syncVaultIdSchema,
  vaultGeneration: positiveSyncUint64Schema,
  deviceId: syncDeviceIdSchema,
  bodyDigest: syncSha256DigestSchema,
  nonce: syncProofNonceSchema,
  issuedAt: syncUint64Schema,
  expiresAt: syncUint64Schema,
}).strict().superRefine((payload, context) => {
  const issuedAt = decodeSyncUint64(payload.issuedAt);
  const expiresAt = decodeSyncUint64(payload.expiresAt);
  if (expiresAt - issuedAt !== BigInt(SYNC_ENROLLMENT_POSSESSION_PROOF_TTL_MS)) {
    context.addIssue({
      code: "custom",
      message: "enrollment possession proof lifetime must be exactly two minutes",
      path: ["expiresAt"],
    });
  }
});
export type SyncEnrollmentPossessionProofPayload = z.infer<
  typeof syncEnrollmentPossessionProofPayloadSchema
>;

export const syncEnrollmentPossessionProofSchema = z.object({
  payload: syncEnrollmentPossessionProofPayloadSchema,
  signingKeyId: syncKeyIdSchema,
  signingSignature: syncP256SignatureSchema,
  agreementKeyId: syncKeyIdSchema,
  agreementSignature: syncP256SignatureSchema,
}).strict().refine(
  (proof) => proof.signingKeyId !== proof.agreementKeyId,
  { message: "enrollment possession proof key identifiers must be distinct" },
);
export type SyncEnrollmentPossessionProof = z.infer<
  typeof syncEnrollmentPossessionProofSchema
>;

export const syncDeviceMemberSchema = z.object({
  deviceId: syncDeviceIdSchema,
  name: boundedDisplayText(80, "device name"),
  status: z.enum(["active", "revoked"]),
  keys: syncDevicePublicKeysSchema,
  approvedAt: syncUint64Schema,
  revokedAt: syncUint64Schema.optional(),
}).strict().superRefine((member, context) => {
  if ((member.status === "revoked") !== (member.revokedAt !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "revoked device state and timestamp must agree",
      path: ["revokedAt"],
    });
  }
});
export type SyncDeviceMember = z.infer<typeof syncDeviceMemberSchema>;

export const syncMembershipStatementSchema = z.object({
  version: z.literal(1),
  ...vaultCoordinateShape,
  membershipEpoch: positiveSyncUint64Schema,
  previousMembershipDigest: syncSha256DigestSchema.nullable(),
  recoveryGeneration: positiveSyncUint64Schema,
  enrollmentPairingDigest: syncSha256DigestSchema.nullable(),
  rootKeyEpoch: positiveSyncUint64Schema,
  rootKeyCommitment: syncSha256DigestSchema,
  rootWrapManifestDigest: syncSha256DigestSchema,
  rootKeyLinkDigest: syncSha256DigestSchema.nullable(),
  recoveryRootWrapDigest: syncSha256DigestSchema,
  members: z.array(syncDeviceMemberSchema).min(1).max(MAX_SYNC_DEVICES),
}).strict().superRefine((statement, context) => {
  const deviceIds = statement.members.map(({ deviceId }) => deviceId);
  if (new Set(deviceIds).size !== deviceIds.length) {
    context.addIssue({ code: "custom", message: "membership device IDs must be unique", path: ["members"] });
  }
  if (!statement.members.some(({ status }) => status === "active")) {
    context.addIssue({ code: "custom", message: "membership requires an active device", path: ["members"] });
  }
  if (statement.membershipEpoch === "1" && statement.previousMembershipDigest !== null) {
    context.addIssue({ code: "custom", message: "genesis membership cannot have a predecessor", path: ["previousMembershipDigest"] });
  }
  if (statement.membershipEpoch !== "1" && statement.previousMembershipDigest === null) {
    context.addIssue({ code: "custom", message: "non-genesis membership requires a predecessor", path: ["previousMembershipDigest"] });
  }
  if (statement.membershipEpoch === "1" && statement.rootKeyEpoch !== "1") {
    context.addIssue({
      code: "custom",
      message: "genesis membership must begin at root key epoch one",
      path: ["rootKeyEpoch"],
    });
  }
  if (statement.membershipEpoch === "1" && statement.rootKeyLinkDigest !== null) {
    context.addIssue({
      code: "custom",
      message: "genesis membership cannot have a backward root key link",
      path: ["rootKeyLinkDigest"],
    });
  }
  if (statement.membershipEpoch === "1" && statement.enrollmentPairingDigest !== null) {
    context.addIssue({
      code: "custom",
      message: "genesis membership cannot carry enrollment pairing authority",
      path: ["enrollmentPairingDigest"],
    });
  }
});
export type SyncMembershipStatement = z.infer<typeof syncMembershipStatementSchema>;

export const syncMembershipCandidateSchema = z.object({
  statement: syncMembershipStatementSchema,
  statementDigest: syncSha256DigestSchema,
}).strict();
export type SyncMembershipCandidate = z.infer<typeof syncMembershipCandidateSchema>;

export const syncMembershipSignatureSchema = z.object({
  deviceId: syncDeviceIdSchema,
  signingKeyId: syncKeyIdSchema,
  signature: syncP256SignatureSchema,
}).strict();
export type SyncMembershipSignature = z.infer<typeof syncMembershipSignatureSchema>;

export const syncMembershipHeadSchema = z.object({
  statement: syncMembershipStatementSchema,
  statementDigest: syncSha256DigestSchema,
  signatures: z.array(syncMembershipSignatureSchema).min(1).max(MAX_SYNC_DEVICES),
}).strict().superRefine((head, context) => {
  const signerIds = head.signatures.map(({ deviceId }) => deviceId);
  if (new Set(signerIds).size !== signerIds.length) {
    context.addIssue({ code: "custom", message: "membership signers must be unique", path: ["signatures"] });
  }
});
export type SyncMembershipHead = z.infer<typeof syncMembershipHeadSchema>;

export const syncRouteValues = [
  "sync.membership.read",
  "sync.membership.update",
  "sync.membership.recover",
  "sync.device.heartbeat",
  "sync.directory.snapshot",
  "sync.directory.changes",
  "sync.session.publish",
  "sync.session.delete",
  "sync.vault.delete",
] as const;
export const syncRouteSchema = z.enum(syncRouteValues);
export const syncDeviceProofPayloadSchema = z.object({
  version: z.literal(1),
  ...membershipCoordinateShape,
  deviceId: syncDeviceIdSchema,
  method: z.enum(["GET", "POST"]),
  route: syncRouteSchema,
  bodyDigest: syncSha256DigestSchema,
  nonce: syncProofNonceSchema,
  issuedAt: syncUint64Schema,
  expiresAt: syncUint64Schema,
}).strict().superRefine((proof, context) => {
  const issuedAt = decodeSyncUint64(proof.issuedAt);
  const expiresAt = decodeSyncUint64(proof.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > BigInt(MAX_SYNC_PROOF_TTL_MS)) {
    context.addIssue({ code: "custom", message: "device proof lifetime is invalid", path: ["expiresAt"] });
  }
});
export type SyncDeviceProofPayload = z.infer<typeof syncDeviceProofPayloadSchema>;

export const syncDeviceProofSchema = z.object({
  payload: syncDeviceProofPayloadSchema,
  signingKeyId: syncKeyIdSchema,
  signature: syncP256SignatureSchema,
}).strict();
export type SyncDeviceProof = z.infer<typeof syncDeviceProofSchema>;

export const syncVaultRootWrapContextSchema = z.object({
  version: z.literal(1),
  ...membershipCoordinateShape,
  rootKeyEpoch: positiveSyncUint64Schema,
  recipientDeviceId: syncDeviceIdSchema,
  recipientAgreementKeyId: syncKeyIdSchema,
}).strict();
export type SyncVaultRootWrapContext = z.infer<typeof syncVaultRootWrapContextSchema>;

export const wrappedSyncVaultRootKeySchema = z.object({
  context: syncVaultRootWrapContextSchema,
  algorithm: z.literal("P256-HKDF-SHA256-A256GCM"),
  ephemeralAgreementPublicKey: syncP256PublicKeySchema,
  nonce: syncAesGcmNonceSchema,
  ciphertext: base64UrlSchema(48, 48).length(64),
  ciphertextDigest: syncSha256DigestSchema,
}).strict();
export type WrappedSyncVaultRootKey = z.infer<typeof wrappedSyncVaultRootKeySchema>;

export const syncVaultRootKeyLinkContextSchema = z.object({
  version: z.literal(1),
  ...membershipCoordinateShape,
  parentRootKeyEpoch: positiveSyncUint64Schema,
  parentRootKeyCommitment: syncSha256DigestSchema,
  childRootKeyEpoch: positiveSyncUint64Schema,
  childRootKeyCommitment: syncSha256DigestSchema,
}).strict().refine(
  (context) => decodeSyncUint64(context.parentRootKeyEpoch)
    < decodeSyncUint64(context.childRootKeyEpoch),
  {
    message: "backward root key link child epoch must follow its parent epoch",
    path: ["childRootKeyEpoch"],
  },
);
export type SyncVaultRootKeyLinkContext = z.infer<
  typeof syncVaultRootKeyLinkContextSchema
>;

export const wrappedSyncVaultRootKeyLinkSchema = z.object({
  context: syncVaultRootKeyLinkContextSchema,
  algorithm: z.literal("HKDF-SHA256-A256GCM"),
  nonce: syncAesGcmNonceSchema,
  ciphertext: base64UrlSchema(48, 48).length(64),
  ciphertextDigest: syncSha256DigestSchema,
  linkDigest: syncSha256DigestSchema,
}).strict();
export type WrappedSyncVaultRootKeyLink = z.infer<
  typeof wrappedSyncVaultRootKeyLinkSchema
>;

export const sessionContentKeyContextSchema = z.object({
  version: z.literal(1),
  ...vaultCoordinateShape,
  sessionId: sessionPublicIdSchema,
  keyEpoch: positiveSyncUint64Schema,
  originDeviceId: syncDeviceIdSchema,
  mirrorEpoch: positiveSyncUint64Schema,
  writerGeneration: positiveSyncUint64Schema,
}).strict();
export type SessionContentKeyContext = z.infer<typeof sessionContentKeyContextSchema>;

export const sessionSyncNonceStateSchema = z.object({
  version: z.literal(1),
  keyEpoch: positiveSyncUint64Schema,
  prefix: z.literal(SESSION_SYNC_NONCE_DOMAIN_PREFIX),
  nextSequence: positiveSyncUint64Schema,
}).strict();
export type SessionSyncNonceState = z.infer<typeof sessionSyncNonceStateSchema>;

export const sessionSyncNonceAllocationSchema = z.object({
  keyEpoch: positiveSyncUint64Schema,
  sequence: positiveSyncUint64Schema,
  nonce: syncAesGcmNonceSchema,
}).strict();
export type SessionSyncNonceAllocation = z.infer<typeof sessionSyncNonceAllocationSchema>;

export const sessionSyncTombstoneSchema = z.object({
  protocol: z.literal(SESSION_SYNC_PROTOCOL),
  recordKind: z.literal("tombstone"),
  ...writerCoordinateShape,
  directoryOrdinal: positiveSyncUint64Schema,
  createdDirectoryVersion: positiveSyncUint64Schema,
  directoryVersion: positiveSyncUint64Schema,
  keyEpoch: positiveSyncUint64Schema,
  syncSequence: positiveSyncUint64Schema,
  sourceRevision: positiveSyncUint64Schema,
  previousDigest: syncSha256DigestSchema,
  tombstoneDigest: syncSha256DigestSchema,
  serverObservedAt: syncUint64Schema,
  purgeAfter: syncUint64Schema,
}).strict().superRefine((tombstone, context) => {
  if (decodeSyncUint64(tombstone.purgeAfter) <= decodeSyncUint64(tombstone.serverObservedAt)) {
    context.addIssue({ code: "custom", message: "tombstone purge time must follow observation", path: ["purgeAfter"] });
  }
  if (decodeSyncUint64(tombstone.createdDirectoryVersion) > decodeSyncUint64(tombstone.directoryVersion)) {
    context.addIssue({ code: "custom", message: "tombstone cannot predate directory creation", path: ["directoryVersion"] });
  }
});
export type SessionSyncTombstone = z.infer<typeof sessionSyncTombstoneSchema>;

export const retiredSessionIdFenceSchema = z.object({
  protocol: z.literal(SESSION_SYNC_PROTOCOL),
  recordKind: z.literal("retired_session_id"),
  ...vaultCoordinateShape,
  sessionId: sessionPublicIdSchema,
  directoryOrdinal: positiveSyncUint64Schema,
  createdDirectoryVersion: positiveSyncUint64Schema,
  retirementDirectoryVersion: positiveSyncUint64Schema,
  retiredAt: syncUint64Schema,
  tombstoneDigest: syncSha256DigestSchema,
}).strict().refine(
  (fence) => decodeSyncUint64(fence.createdDirectoryVersion)
    <= decodeSyncUint64(fence.retirementDirectoryVersion),
  {
    message: "retirement cannot predate directory creation",
    path: ["retirementDirectoryVersion"],
  },
);
export type RetiredSessionIdFence = z.infer<typeof retiredSessionIdFenceSchema>;

export const sessionDirectoryCursorSchema = z.object({
  directoryOrdinal: positiveSyncUint64Schema,
  sessionId: sessionPublicIdSchema,
}).strict();
export type SessionDirectoryCursor = z.infer<typeof sessionDirectoryCursorSchema>;

export const sessionMirrorResetSchema = z.object({
  kind: z.literal("mirror_reset"),
  ...vaultCoordinateShape,
  sessionId: sessionPublicIdSchema,
  directoryOrdinal: positiveSyncUint64Schema,
  directoryVersion: positiveSyncUint64Schema,
  mirrorEpoch: positiveSyncUint64Schema,
  resetDigest: syncSha256DigestSchema,
}).strict();
export type SessionMirrorReset = z.infer<typeof sessionMirrorResetSchema>;

export const sessionDirectoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("head"), accepted: acceptedSessionHeadSchema }).strict(),
  z.object({
    kind: z.literal("offline"),
    accepted: acceptedSessionHeadSchema,
    reset: sessionMirrorResetSchema,
  }).strict(),
  z.object({ kind: z.literal("tombstone"), tombstone: sessionSyncTombstoneSchema }).strict(),
  z.object({ kind: z.literal("retired"), fence: retiredSessionIdFenceSchema }).strict(),
]).superRefine((entry, context) => {
  if (entry.kind !== "offline") return;
  const header = entry.accepted.envelope.header;
  const reset = entry.reset;
  if (
    !sameVault(vaultCoordinatesFrom(header), vaultCoordinatesFrom(reset))
    || reset.sessionId !== header.sessionId
    || reset.directoryOrdinal !== header.directoryOrdinal
    || decodeSyncUint64(reset.directoryVersion)
      <= decodeSyncUint64(entry.accepted.directoryVersion)
    || decodeSyncUint64(reset.mirrorEpoch) <= decodeSyncUint64(header.mirrorEpoch)
    || reset.resetDigest !== entry.accepted.envelope.ciphertextDigest
  ) {
    context.addIssue({
      code: "custom",
      message: "offline session entry must overlay its exact accepted head with a newer reset fence",
      path: ["reset"],
    });
  }
});
export type SessionDirectoryEntry = z.infer<typeof sessionDirectoryEntrySchema>;

export const sessionDirectorySnapshotPageSchema = z.object({
  version: z.literal(1),
  vault: syncVaultCoordinateSchema,
  snapshotVersion: syncUint64Schema,
  after: sessionDirectoryCursorSchema.optional(),
  entries: z.array(sessionDirectoryEntrySchema).max(MAX_SYNC_DIRECTORY_PAGE_SIZE),
  complete: z.boolean(),
  nextCursor: sessionDirectoryCursorSchema.optional(),
}).strict().superRefine((page, context) => {
  let previous = page.after;
  for (const [index, entry] of page.entries.entries()) {
    const coordinates = directoryEntryCoordinates(entry);
    if (!sameVault(page.vault, coordinates.vault)) {
      context.addIssue({ code: "custom", message: "directory entry belongs to another vault", path: ["entries", index] });
    }
    if (decodeSyncUint64(coordinates.createdDirectoryVersion) > decodeSyncUint64(page.snapshotVersion)) {
      context.addIssue({ code: "custom", message: "directory entry was created after the pinned snapshot", path: ["entries", index] });
    }
    if (decodeSyncUint64(coordinates.directoryVersion) > decodeSyncUint64(page.snapshotVersion)) {
      context.addIssue({ code: "custom", message: "directory entry changed after the pinned snapshot", path: ["entries", index] });
    }
    if (previous !== undefined && compareDirectoryCoordinates(previous, coordinates) >= 0) {
      context.addIssue({ code: "custom", message: "directory entries must be strictly cursor ordered", path: ["entries", index] });
    }
    previous = coordinates;
  }
  const expectedCursor = page.entries.length === 0
    ? undefined
    : directoryEntryCoordinates(page.entries[page.entries.length - 1] as SessionDirectoryEntry);
  if (page.complete && page.nextCursor !== undefined) {
    context.addIssue({ code: "custom", message: "a complete page cannot have a next cursor", path: ["nextCursor"] });
  }
  if (!page.complete && (expectedCursor === undefined || page.nextCursor === undefined)) {
    context.addIssue({ code: "custom", message: "an incomplete page requires an entry cursor", path: ["nextCursor"] });
  }
  if (page.nextCursor !== undefined && (
    expectedCursor === undefined || compareDirectoryCoordinates(page.nextCursor, expectedCursor) !== 0
  )) {
    context.addIssue({ code: "custom", message: "next cursor must equal the final complete entry", path: ["nextCursor"] });
  }
});
export type SessionDirectorySnapshotPage = z.infer<typeof sessionDirectorySnapshotPageSchema>;

export const sessionDirectoryChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert"), accepted: acceptedSessionHeadSchema }).strict(),
  z.object({ kind: z.literal("tombstone"), tombstone: sessionSyncTombstoneSchema }).strict(),
  z.object({ kind: z.literal("retired"), fence: retiredSessionIdFenceSchema }).strict(),
  sessionMirrorResetSchema,
]);
export type SessionDirectoryChange = z.infer<typeof sessionDirectoryChangeSchema>;

export const sessionDirectoryChangePageSchema = z.object({
  version: z.literal(1),
  vault: syncVaultCoordinateSchema,
  afterVersion: syncUint64Schema,
  changes: z.array(sessionDirectoryChangeSchema).max(MAX_SYNC_DIRECTORY_PAGE_SIZE),
  nextVersion: syncUint64Schema,
  hasMore: z.boolean(),
}).strict().superRefine((page, context) => {
  let expected = nextSyncUint64(page.afterVersion);
  for (const [index, change] of page.changes.entries()) {
    const coordinates = directoryChangeCoordinates(change);
    if (!sameVault(page.vault, coordinates.vault)) {
      context.addIssue({ code: "custom", message: "directory change belongs to another vault", path: ["changes", index] });
    }
    if (expected === null || coordinates.directoryVersion !== expected) {
      context.addIssue({ code: "custom", message: "directory changes must be contiguous", path: ["changes", index] });
    }
    expected = nextSyncUint64(coordinates.directoryVersion);
  }
  const expectedNext = page.changes.length === 0
    ? page.afterVersion
    : directoryChangeCoordinates(page.changes[page.changes.length - 1] as SessionDirectoryChange).directoryVersion;
  if (page.nextVersion !== expectedNext) {
    context.addIssue({ code: "custom", message: "next version must equal the final applied version", path: ["nextVersion"] });
  }
  if (page.hasMore && page.changes.length === 0) {
    context.addIssue({ code: "custom", message: "a nonterminal change page cannot be empty", path: ["changes"] });
  }
});
export type SessionDirectoryChangePage = z.infer<typeof sessionDirectoryChangePageSchema>;

export const sessionSyncQuotaUsageSchema = z.object({
  activeDevices: z.number().int().nonnegative().max(MAX_SYNC_DEVICES),
  locallyOwnedSessions: z.number().int().nonnegative().max(MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE),
  directorySessions: z.number().int().nonnegative().max(MAX_SYNC_DIRECTORY_SESSIONS),
  activeStreams: z.number().int().nonnegative().max(MAX_SYNC_ACTIVE_STREAMS),
  retainedEvents: z.number().int().nonnegative().max(MAX_SYNC_RETAINED_EVENTS),
  retainedCiphertextBytes: syncUint64Schema.refine(
    (value) => decodeSyncUint64(value) <= BigInt(MAX_SYNC_RETAINED_CIPHERTEXT_BYTES),
    "retained ciphertext quota exceeded",
  ),
}).strict();
export type SessionSyncQuotaUsage = z.infer<typeof sessionSyncQuotaUsageSchema>;

export const sessionSyncCapabilityValues = [
  "device_enrollment",
  "summary_publication",
  "remote_observation",
] as const;
export const sessionSyncCapabilitySchema = z.enum(sessionSyncCapabilityValues);
export const sessionSyncHelloSchema = z.object({
  protocol: z.literal(SESSION_SYNC_PROTOCOL),
  minimumVersion: z.literal(1),
  maximumVersion: z.literal(1),
  capabilities: z.array(sessionSyncCapabilitySchema).max(sessionSyncCapabilityValues.length),
}).strict().refine(
  (hello) => new Set(hello.capabilities).size === hello.capabilities.length,
  { message: "sync capabilities must be unique" },
);
export const sessionSyncNegotiationSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("accepted"),
    version: z.literal(1),
    capabilities: z.array(sessionSyncCapabilitySchema).max(sessionSyncCapabilityValues.length),
    serverObservedAt: syncUint64Schema,
    maximumProofTtlMs: z.literal(MAX_SYNC_PROOF_TTL_MS),
  }).strict(),
  z.object({
    outcome: z.literal("update_required"),
    minimumSupportedVersion: z.number().int().positive().max(65_535),
    maximumSupportedVersion: z.number().int().positive().max(65_535),
  }).strict().refine(
    (result) => result.minimumSupportedVersion <= result.maximumSupportedVersion,
    { message: "supported version range is invalid" },
  ),
]);

export const SESSION_SYNC_FORBIDDEN_FIELDS = [
  "accountId",
  "accountProfileId",
  "canonicalPath",
  "content",
  "body",
  "command",
  "credential",
  "diagnostics",
  "environment",
  "history",
  "localPaneId",
  "messages",
  "assistantMessage",
  "path",
  "prompt",
  "providerError",
  "providerId",
  "providerThreadId",
  "rawError",
  "rawReasoning",
  "reasoning",
  "repositoryId",
  "threadId",
  "transcript",
  "token",
  "toolArguments",
  "toolId",
  "toolName",
  "toolOutput",
  "usage",
  "userMessage",
  "response",
  "workingDirectory",
] as const;

const forbiddenSyncFields = new Set<string>(SESSION_SYNC_FORBIDDEN_FIELDS);

/** Fail closed before a value is handed to an observation-only sync schema. */
export function assertObservationOnlySyncValue(value: unknown): void {
  visitObservationValue(value, new Set<object>());
}

function visitObservationValue(value: unknown, seen: Set<object>): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) throw new TypeError("session sync value contains a reference cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitObservationValue(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenSyncFields.has(key)) {
        throw new TypeError(`session sync value contains forbidden field: ${key}`);
      }
      visitObservationValue(item, seen);
    }
  }
  seen.delete(value);
}

function sameVault(
  left: SyncVaultCoordinate,
  right: SyncVaultCoordinate,
): boolean {
  return left.tenantId === right.tenantId
    && left.organizationId === right.organizationId
    && left.ownerUserId === right.ownerUserId
    && left.vaultId === right.vaultId
    && left.vaultGeneration === right.vaultGeneration;
}

function isUint64InRange(value: string): boolean {
  return /^(?:0|[1-9][0-9]{0,19})$/u.test(value)
    && BigInt(value) <= SYNC_UINT64_MAX;
}

function isCanonicalBase64Url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return false;
  const remainder = value.length % 4;
  if (remainder === 0) return true;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalValue = alphabet.indexOf(value[value.length - 1] ?? "");
  return remainder === 2 ? finalValue % 16 === 0 : finalValue % 4 === 0;
}

function vaultCoordinatesFrom(record: {
  readonly tenantId: SyncTenantId;
  readonly organizationId: SyncOrganizationId;
  readonly ownerUserId: SyncOwnerUserId;
  readonly vaultId: SyncVaultId;
  readonly vaultGeneration: PositiveSyncUint64;
}): SyncVaultCoordinate {
  return syncVaultCoordinateSchema.parse({
    tenantId: record.tenantId,
    organizationId: record.organizationId,
    ownerUserId: record.ownerUserId,
    vaultId: record.vaultId,
    vaultGeneration: record.vaultGeneration,
  });
}

function compareDirectoryCoordinates(
  left: SessionDirectoryCursor,
  right: SessionDirectoryCursor,
): number {
  const ordinalComparison = decodeSyncUint64(left.directoryOrdinal) - decodeSyncUint64(right.directoryOrdinal);
  if (ordinalComparison < 0n) return -1;
  if (ordinalComparison > 0n) return 1;
  return left.sessionId < right.sessionId
    ? -1
    : left.sessionId > right.sessionId
      ? 1
      : 0;
}

function directoryEntryCoordinates(entry: SessionDirectoryEntry): SessionDirectoryCursor & {
  readonly createdDirectoryVersion: PositiveSyncUint64;
  readonly directoryVersion: PositiveSyncUint64;
  readonly vault: SyncVaultCoordinate;
} {
  const record = entry.kind === "head"
    ? {
        ...entry.accepted.envelope.header,
        createdDirectoryVersion: entry.accepted.createdDirectoryVersion,
        directoryVersion: entry.accepted.directoryVersion,
      }
    : entry.kind === "offline"
      ? {
          ...entry.accepted.envelope.header,
          createdDirectoryVersion: entry.accepted.createdDirectoryVersion,
          directoryVersion: entry.reset.directoryVersion,
        }
    : entry.kind === "tombstone"
      ? entry.tombstone
      : {
          ...entry.fence,
          directoryVersion: entry.fence.retirementDirectoryVersion,
        };
  return {
    directoryOrdinal: record.directoryOrdinal,
    sessionId: record.sessionId,
    createdDirectoryVersion: record.createdDirectoryVersion,
    directoryVersion: record.directoryVersion,
    vault: vaultCoordinatesFrom(record),
  };
}

function directoryChangeCoordinates(change: SessionDirectoryChange): {
  readonly directoryVersion: PositiveSyncUint64;
  readonly vault: SyncVaultCoordinate;
} {
  const record = change.kind === "upsert"
    ? {
        ...change.accepted.envelope.header,
        directoryVersion: change.accepted.directoryVersion,
      }
    : change.kind === "tombstone"
      ? change.tombstone
      : change.kind === "retired"
        ? { ...change.fence, directoryVersion: change.fence.retirementDirectoryVersion }
        : change;
  return {
    directoryVersion: record.directoryVersion,
    vault: vaultCoordinatesFrom(record),
  };
}
