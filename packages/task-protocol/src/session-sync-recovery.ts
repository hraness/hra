import { z } from "@hra-internal/schema";

import {
  MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS,
  nextSyncUint64,
  positiveSyncUint64Schema,
  syncDeviceMemberSchema,
  syncDeviceProofSchema,
  syncKeyIdSchema,
  syncMembershipHeadSchema,
  syncP256PublicKeySchema,
  syncP256SignatureSchema,
  syncSha256DigestSchema,
  syncUint64Schema,
  syncVaultCoordinateSchema,
  wrappedSyncVaultRootKeyLinkSchema,
  wrappedSyncVaultRootKeySchema,
} from "./session-sync";

export const SESSION_SYNC_RECOVERY_STATEMENT_TTL_MS = 2 * 60_000;

export const syncRecoveryNonceSchema = z.string()
  .regex(/^syncrecovery_[A-Za-z0-9_-]{32}$/u, "invalid sync recovery nonce");

export const syncRecoveryAuthoritySchema = z.object({
  version: z.literal(1),
  vault: syncVaultCoordinateSchema,
  recoveryGeneration: positiveSyncUint64Schema,
  keyId: syncKeyIdSchema,
  algorithm: z.literal("P256-SHA256"),
  publicKey: syncP256PublicKeySchema,
  publicKeyDigest: syncSha256DigestSchema,
  agreementKeyId: syncKeyIdSchema,
  agreementAlgorithm: z.literal("P256-ECDH"),
  agreementPublicKey: syncP256PublicKeySchema,
  agreementPublicKeyDigest: syncSha256DigestSchema,
}).strict().superRefine((authority, context) => {
  if (
    authority.keyId === authority.agreementKeyId
    || authority.publicKeyDigest === authority.agreementPublicKeyDigest
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery signing and agreement authorities must be distinct",
      path: ["agreementKeyId"],
    });
  }
});
export type SyncRecoveryAuthority = z.infer<typeof syncRecoveryAuthoritySchema>;

export const syncRecoveryVaultRootWrapContextSchema = z.object({
  version: z.literal(1),
  vault: syncVaultCoordinateSchema,
  membershipEpoch: positiveSyncUint64Schema,
  recoveryGeneration: positiveSyncUint64Schema,
  rootKeyEpoch: positiveSyncUint64Schema,
  rootKeyCommitment: syncSha256DigestSchema,
  recipientRecoveryAgreementKeyId: syncKeyIdSchema,
}).strict();
export type SyncRecoveryVaultRootWrapContext = z.infer<
  typeof syncRecoveryVaultRootWrapContextSchema
>;

export const wrappedSyncRecoveryVaultRootKeySchema = z.object({
  context: syncRecoveryVaultRootWrapContextSchema,
  algorithm: z.literal("P256-HKDF-SHA256-A256GCM"),
  ephemeralAgreementPublicKey: syncP256PublicKeySchema,
  nonce: wrappedSyncVaultRootKeySchema.shape.nonce,
  ciphertext: wrappedSyncVaultRootKeySchema.shape.ciphertext,
  ciphertextDigest: syncSha256DigestSchema,
}).strict();
export type WrappedSyncRecoveryVaultRootKey = z.infer<
  typeof wrappedSyncRecoveryVaultRootKeySchema
>;

export const syncRecoveryWrappedRootDigestSchema = z.object({
  keyEpoch: positiveSyncUint64Schema,
  ciphertextDigest: syncSha256DigestSchema,
}).strict();

export const syncRecoveryStatementSchema = z.object({
  version: z.literal(1),
  vault: syncVaultCoordinateSchema,
  recoveryNonce: syncRecoveryNonceSchema,
  issuedAt: syncUint64Schema,
  expiresAt: syncUint64Schema,
  currentMembershipEpoch: positiveSyncUint64Schema,
  currentMembershipDigest: syncSha256DigestSchema,
  currentRecoveryGeneration: positiveSyncUint64Schema,
  currentRootKeyEpoch: positiveSyncUint64Schema,
  currentRootKeyCommitment: syncSha256DigestSchema,
  replacementDevice: syncDeviceMemberSchema,
  replacementMembershipEpoch: positiveSyncUint64Schema,
  replacementMembershipDigest: syncSha256DigestSchema,
  replacementRootKeyEpoch: positiveSyncUint64Schema,
  replacementRootKeyCommitment: syncSha256DigestSchema,
  replacementRootWrapManifestDigest: syncSha256DigestSchema,
  replacementRecoveryRootWrapDigest: syncSha256DigestSchema,
  replacementRootWraps: z.array(syncRecoveryWrappedRootDigestSchema)
    .min(1)
    .max(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  rootKeyLink: wrappedSyncVaultRootKeyLinkSchema,
  nextRecoveryAuthority: syncRecoveryAuthoritySchema,
}).strict().superRefine((statement, context) => {
  const issuedAt = BigInt(statement.issuedAt);
  const expiresAt = BigInt(statement.expiresAt);
  if (
    expiresAt < issuedAt
    || expiresAt - issuedAt > BigInt(SESSION_SYNC_RECOVERY_STATEMENT_TTL_MS)
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery statement lifetime is invalid",
      path: ["expiresAt"],
    });
  }
  if (statement.replacementDevice.status !== "active") {
    context.addIssue({
      code: "custom",
      message: "sync recovery replacement device must be active",
      path: ["replacementDevice", "status"],
    });
  }
  const epochs = statement.replacementRootWraps.map(({ keyEpoch }) => keyEpoch);
  if (
    new Set(epochs).size !== epochs.length
    || [...epochs].sort((left, right) => BigInt(left) < BigInt(right)
      ? -1
      : BigInt(left) > BigInt(right)
        ? 1
        : 0).join("\u0000")
      !== epochs.join("\u0000")
    || !epochs.includes(statement.replacementRootKeyEpoch)
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery root wrap epochs must be unique, ordered, and include the replacement epoch",
      path: ["replacementRootWraps"],
    });
  }
  if (nextSyncUint64(statement.currentRootKeyEpoch) !== statement.replacementRootKeyEpoch) {
    context.addIssue({
      code: "custom",
      message: "sync recovery root key epoch must advance exactly once",
      path: ["replacementRootKeyEpoch"],
    });
  }
  const link = statement.rootKeyLink;
  if (
    link.context.tenantId !== statement.vault.tenantId
    || link.context.organizationId !== statement.vault.organizationId
    || link.context.ownerUserId !== statement.vault.ownerUserId
    || link.context.vaultId !== statement.vault.vaultId
    || link.context.vaultGeneration !== statement.vault.vaultGeneration
    || link.context.membershipEpoch !== statement.replacementMembershipEpoch
    || link.context.parentRootKeyEpoch !== statement.currentRootKeyEpoch
    || link.context.parentRootKeyCommitment !== statement.currentRootKeyCommitment
    || link.context.childRootKeyEpoch !== statement.replacementRootKeyEpoch
    || link.context.childRootKeyCommitment !== statement.replacementRootKeyCommitment
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery backward root key link does not match the signed transition",
      path: ["rootKeyLink"],
    });
  }
  if (nextSyncUint64(statement.currentMembershipEpoch) !== statement.replacementMembershipEpoch) {
    context.addIssue({
      code: "custom",
      message: "sync recovery membership epoch must advance exactly once",
      path: ["replacementMembershipEpoch"],
    });
  }
  const nextRecoveryGeneration = nextSyncUint64(statement.currentRecoveryGeneration);
  if (
    nextRecoveryGeneration !== statement.nextRecoveryAuthority.recoveryGeneration
    || statement.replacementDevice.keys.signing.keyId === statement.nextRecoveryAuthority.keyId
    || statement.replacementDevice.keys.agreement.keyId === statement.nextRecoveryAuthority.keyId
    || statement.replacementDevice.keys.signing.publicKeyDigest
      === statement.nextRecoveryAuthority.publicKeyDigest
    || statement.replacementDevice.keys.agreement.publicKeyDigest
      === statement.nextRecoveryAuthority.publicKeyDigest
    || statement.replacementDevice.keys.signing.keyId
      === statement.nextRecoveryAuthority.agreementKeyId
    || statement.replacementDevice.keys.agreement.keyId
      === statement.nextRecoveryAuthority.agreementKeyId
    || statement.replacementDevice.keys.signing.publicKeyDigest
      === statement.nextRecoveryAuthority.agreementPublicKeyDigest
    || statement.replacementDevice.keys.agreement.publicKeyDigest
      === statement.nextRecoveryAuthority.agreementPublicKeyDigest
    || statement.nextRecoveryAuthority.vault.tenantId !== statement.vault.tenantId
    || statement.nextRecoveryAuthority.vault.organizationId !== statement.vault.organizationId
    || statement.nextRecoveryAuthority.vault.ownerUserId !== statement.vault.ownerUserId
    || statement.nextRecoveryAuthority.vault.vaultId !== statement.vault.vaultId
    || statement.nextRecoveryAuthority.vault.vaultGeneration !== statement.vault.vaultGeneration
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery authority must rotate exactly once to a dedicated key",
      path: ["nextRecoveryAuthority"],
    });
  }
});
export type SyncRecoveryStatement = z.infer<typeof syncRecoveryStatementSchema>;

export const syncRecoveryAuthorizationSchema = z.object({
  statement: syncRecoveryStatementSchema,
  statementDigest: syncSha256DigestSchema,
  signingKeyId: syncKeyIdSchema,
  signature: syncP256SignatureSchema,
}).strict();
export type SyncRecoveryAuthorization = z.infer<typeof syncRecoveryAuthorizationSchema>;

export const recoverSyncVaultRequestSchema = z.object({
  version: z.literal(1),
  authorization: syncRecoveryAuthorizationSchema,
  membershipHead: syncMembershipHeadSchema,
  replacementDeviceProof: syncDeviceProofSchema,
  wrappedRoots: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  recoveryRootWrap: wrappedSyncRecoveryVaultRootKeySchema,
}).strict().superRefine((request, context) => {
  const statement = request.authorization.statement;
  const membership = request.membershipHead.statement;
  const replacement = membership.members[0];
  const replacementProof = request.replacementDeviceProof;
  if (
    membership.tenantId !== statement.vault.tenantId
    || membership.organizationId !== statement.vault.organizationId
    || membership.ownerUserId !== statement.vault.ownerUserId
    || membership.vaultId !== statement.vault.vaultId
    || membership.vaultGeneration !== statement.vault.vaultGeneration
    || membership.membershipEpoch !== statement.replacementMembershipEpoch
    || membership.previousMembershipDigest !== statement.currentMembershipDigest
    || membership.recoveryGeneration !== statement.nextRecoveryAuthority.recoveryGeneration
    || membership.enrollmentPairingDigest !== null
    || membership.rootKeyEpoch !== statement.replacementRootKeyEpoch
    || membership.rootKeyCommitment !== statement.replacementRootKeyCommitment
    || membership.rootWrapManifestDigest !== statement.replacementRootWrapManifestDigest
    || membership.rootKeyLinkDigest !== statement.rootKeyLink.linkDigest
    || membership.recoveryRootWrapDigest !== statement.replacementRecoveryRootWrapDigest
    || request.membershipHead.statementDigest !== statement.replacementMembershipDigest
    || membership.members.length !== 1
    || replacement === undefined
    || JSON.stringify(replacement) !== JSON.stringify(statement.replacementDevice)
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery membership does not match its signed replacement",
      path: ["membershipHead"],
    });
  }
  if (
    replacementProof.payload.tenantId !== statement.vault.tenantId
    || replacementProof.payload.organizationId !== statement.vault.organizationId
    || replacementProof.payload.ownerUserId !== statement.vault.ownerUserId
    || replacementProof.payload.vaultId !== statement.vault.vaultId
    || replacementProof.payload.vaultGeneration !== statement.vault.vaultGeneration
    || replacementProof.payload.membershipEpoch !== statement.replacementMembershipEpoch
    || replacementProof.payload.deviceId !== statement.replacementDevice.deviceId
    || replacementProof.payload.method !== "POST"
    || replacementProof.payload.route !== "sync.membership.recover"
    || replacementProof.payload.bodyDigest !== request.authorization.statementDigest
    || replacementProof.signingKeyId !== statement.replacementDevice.keys.signing.keyId
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery replacement proof does not match the signed replacement",
      path: ["replacementDeviceProof"],
    });
  }
  const signedWraps = new Map(statement.replacementRootWraps.map((wrap) => [wrap.keyEpoch, wrap]));
  const requestEpochs = request.wrappedRoots.map((wrap) => wrap.context.rootKeyEpoch);
  if (
    request.wrappedRoots.length !== signedWraps.size
    || new Set(requestEpochs).size !== requestEpochs.length
    || request.wrappedRoots.some((wrap) => {
      const signed = signedWraps.get(wrap.context.rootKeyEpoch);
      return wrap.context.tenantId !== statement.vault.tenantId
        || wrap.context.organizationId !== statement.vault.organizationId
        || wrap.context.ownerUserId !== statement.vault.ownerUserId
        || wrap.context.vaultId !== statement.vault.vaultId
        || wrap.context.vaultGeneration !== statement.vault.vaultGeneration
        || wrap.context.membershipEpoch !== statement.replacementMembershipEpoch
        || wrap.context.recipientDeviceId !== statement.replacementDevice.deviceId
        || wrap.context.recipientAgreementKeyId !== statement.replacementDevice.keys.agreement.keyId
        || signed === undefined
        || wrap.ciphertextDigest !== signed.ciphertextDigest;
    })
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery root wraps do not match their signed replacement",
      path: ["wrappedRoots"],
    });
  }
  const recoveryWrap = request.recoveryRootWrap;
  if (
    recoveryWrap.context.vault.tenantId !== statement.vault.tenantId
    || recoveryWrap.context.vault.organizationId !== statement.vault.organizationId
    || recoveryWrap.context.vault.ownerUserId !== statement.vault.ownerUserId
    || recoveryWrap.context.vault.vaultId !== statement.vault.vaultId
    || recoveryWrap.context.vault.vaultGeneration !== statement.vault.vaultGeneration
    || recoveryWrap.context.membershipEpoch !== statement.replacementMembershipEpoch
    || recoveryWrap.context.recoveryGeneration
      !== statement.nextRecoveryAuthority.recoveryGeneration
    || recoveryWrap.context.rootKeyEpoch !== statement.replacementRootKeyEpoch
    || recoveryWrap.context.rootKeyCommitment !== statement.replacementRootKeyCommitment
    || recoveryWrap.context.recipientRecoveryAgreementKeyId
      !== statement.nextRecoveryAuthority.agreementKeyId
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery authority root wrap does not match the signed replacement",
      path: ["recoveryRootWrap"],
    });
  }
});
export type RecoverSyncVaultRequest = z.infer<typeof recoverSyncVaultRequestSchema>;

export const syncRecoveryReceiptSchema = z.object({
  version: z.literal(1),
  requestDigest: syncSha256DigestSchema,
  authorization: syncRecoveryAuthorizationSchema,
  acceptedMembershipDigest: syncSha256DigestSchema,
  acceptedAt: positiveSyncUint64Schema,
}).strict();
export type SyncRecoveryReceipt = z.infer<typeof syncRecoveryReceiptSchema>;
