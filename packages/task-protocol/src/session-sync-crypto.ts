import { z } from "@hra-internal/schema";

import {
  MAX_SYNC_DEVICES,
  MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS,
  MAX_SYNC_SUMMARY_PLAINTEXT_BYTES,
  SESSION_SYNC_NONCE_DOMAIN_PREFIX,
  SESSION_SYNC_PROTOCOL,
  assertObservationOnlySyncValue,
  decodeSyncUint64,
  nextSyncUint64,
  positiveSyncUint64Schema,
  sealedSessionSummarySchema,
  sessionContentKeyContextSchema,
  sessionSummarySchema,
  sessionSyncHeaderSchema,
  sessionSyncNonceAllocationSchema,
  sessionSyncNonceStateSchema,
  syncEnrollmentPossessionProofPayloadSchema,
  syncEnrollmentPossessionProofSchema,
  syncDeviceProofPayloadSchema,
  syncDeviceProofSchema,
  syncDevicePublicKeysSchema,
  syncKeyIdSchema,
  syncMembershipSignatureSchema,
  syncMembershipStatementSchema,
  syncP256PublicKeySchema,
  syncProofNonceSchema,
  syncSha256DigestSchema,
  syncUint64Schema,
  syncVaultRootWrapContextSchema,
  syncVaultRootKeyLinkContextSchema,
  wrappedSyncVaultRootKeyLinkSchema,
  wrappedSyncVaultRootKeySchema,
  type PositiveSyncUint64,
  type SealedSessionSummary,
  type SessionContentKeyContext,
  type SessionSummary,
  type SessionSyncHeader,
  type SessionSyncNonceAllocation,
  type SessionSyncNonceState,
  type SyncDeviceId,
  type SyncDeviceProof,
  type SyncDeviceProofPayload,
  type SyncDevicePublicKeys,
  type SyncEnrollmentPossessionProof,
  type SyncEnrollmentPossessionProofPayload,
  type SyncKeyId,
  type SyncMembershipSignature,
  type SyncMembershipStatement,
  type SyncProofNonce,
  type SyncSha256Digest,
  type SyncUint64,
  type SyncVaultRootWrapContext,
  type SyncVaultRootKeyLinkContext,
  type WrappedSyncVaultRootKeyLink,
  type WrappedSyncVaultRootKey,
} from "./session-sync";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const SESSION_SUMMARY_ALGORITHM = "P256-HKDF-SHA256-A256GCM" as const;
const VAULT_ROOT_LINK_ALGORITHM = "HKDF-SHA256-A256GCM" as const;
const VAULT_ROOT_WRAP_INFO = textEncoder.encode("oprte.session-sync.vault-root-wrap.v1");
const VAULT_ROOT_LINK_INFO = textEncoder.encode("oprte.session-sync.vault-root-backward-link.v1");
const SESSION_CONTENT_KEY_INFO = textEncoder.encode("oprte.session-sync.content-key.v1");

export interface SyncDeviceKeyPairs {
  readonly publicKeys: SyncDevicePublicKeys;
  readonly signingPrivateKey: CryptoKey;
  readonly agreementPrivateKey: CryptoKey;
}

const syncPkcs8Schema = z.string().min(128).max(342)
  .regex(/^[A-Za-z0-9_-]+$/u, "invalid canonical PKCS8 base64url");

/** Explicitly sensitive bytes. Callers must move these strings into Keychain custody immediately. */
export const syncDevicePrivateKeyMaterialSchema = z.object({
  version: z.literal(1),
  signingPkcs8: syncPkcs8Schema,
  agreementPkcs8: syncPkcs8Schema,
}).strict();
export type SyncDevicePrivateKeyMaterial = z.infer<typeof syncDevicePrivateKeyMaterialSchema>;

export interface GeneratedSyncDeviceKeyCustody {
  readonly publicKeys: SyncDevicePublicKeys;
  readonly privateKeyMaterial: SyncDevicePrivateKeyMaterial;
}

export interface AllocatedSessionSyncNonce {
  readonly allocation: SessionSyncNonceAllocation;
  /** Null means the caller must rotate the content key before another seal. */
  readonly nextState: SessionSyncNonceState | null;
}

export async function createSyncDeviceKeyPairs(): Promise<SyncDeviceKeyPairs> {
  const generated = await generateSyncDeviceKeyCustody();
  return await importSyncDeviceKeyPairs(
    generated.privateKeyMaterial,
    generated.publicKeys,
  );
}

export async function generateSyncDeviceKeyCustody(): Promise<GeneratedSyncDeviceKeyCustody> {
  const crypto = requireWebCrypto();
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const agreement = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  if (
    !("privateKey" in signing)
    || !("publicKey" in signing)
    || !("privateKey" in agreement)
    || !("publicKey" in agreement)
  ) {
    throw new Error("The platform did not create P-256 device key pairs");
  }
  const signingPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey));
  const agreementPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", agreement.publicKey));
  const publicKeys = syncDevicePublicKeysSchema.parse({
    version: 1,
    signing: {
      keyId: randomOpaqueId("synckey", syncKeyIdSchema),
      algorithm: "P256-SHA256",
      publicKey: base64UrlEncode(signingPublicBytes),
      publicKeyDigest: await sha256Digest(signingPublicBytes),
    },
    agreement: {
      keyId: randomOpaqueId("synckey", syncKeyIdSchema),
      algorithm: "P256-ECDH",
      publicKey: base64UrlEncode(agreementPublicBytes),
      publicKeyDigest: await sha256Digest(agreementPublicBytes),
    },
  });
  return {
    publicKeys,
    privateKeyMaterial: {
      version: 1,
      signingPkcs8: await exportPrivateKeyPkcs8(signing.privateKey),
      agreementPkcs8: await exportPrivateKeyPkcs8(agreement.privateKey),
    },
  };
}

async function exportPrivateKeyPkcs8(privateKey: CryptoKey): Promise<string> {
  const bytes = new Uint8Array(await requireWebCrypto().subtle.exportKey("pkcs8", privateKey));
  try {
    return base64UrlEncode(bytes);
  } finally {
    bytes.fill(0);
  }
}

function parsePrivateKeyMaterial(
  value: SyncDevicePrivateKeyMaterial,
): Readonly<{ signing: Uint8Array; agreement: Uint8Array }> {
  const parsed = syncDevicePrivateKeyMaterialSchema.parse(value);
  const signing = base64UrlDecode(parsed.signingPkcs8);
  const agreement = base64UrlDecode(parsed.agreementPkcs8);
  if (signing.byteLength < 96 || signing.byteLength > 256) {
    throw new TypeError("sync signing PKCS8 has an invalid size");
  }
  if (agreement.byteLength < 96 || agreement.byteLength > 256) {
    throw new TypeError("sync agreement PKCS8 has an invalid size");
  }
  return { signing, agreement };
}

async function publicRawFromPrivatePkcs8(
  pkcs8: Uint8Array,
  algorithm: "ECDSA" | "ECDH",
): Promise<Uint8Array> {
  const crypto = requireWebCrypto();
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    ownedBuffer(pkcs8),
    { name: algorithm, namedCurve: "P-256" },
    true,
    algorithm === "ECDSA" ? ["sign"] : ["deriveBits"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (
    privateJwk.kty !== "EC"
    || privateJwk.crv !== "P-256"
    || typeof privateJwk.x !== "string"
    || typeof privateJwk.y !== "string"
  ) throw new TypeError("sync device PKCS8 is not a P-256 private key");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: privateJwk.x,
      y: privateJwk.y,
      ext: true,
      key_ops: algorithm === "ECDSA" ? ["verify"] : [],
    },
    { name: algorithm, namedCurve: "P-256" },
    true,
    algorithm === "ECDSA" ? ["verify"] : [],
  );
  return new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
}

export async function deriveSyncDevicePublicKeys(
  privateKeyMaterial: SyncDevicePrivateKeyMaterial,
  keyIds: Readonly<{ signingKeyId: SyncKeyId; agreementKeyId: SyncKeyId }>,
): Promise<SyncDevicePublicKeys> {
  const material = parsePrivateKeyMaterial(privateKeyMaterial);
  try {
    const [signingPublicBytes, agreementPublicBytes] = await Promise.all([
      publicRawFromPrivatePkcs8(material.signing, "ECDSA"),
      publicRawFromPrivatePkcs8(material.agreement, "ECDH"),
    ]);
    return syncDevicePublicKeysSchema.parse({
      version: 1,
      signing: {
        keyId: syncKeyIdSchema.parse(keyIds.signingKeyId),
        algorithm: "P256-SHA256",
        publicKey: base64UrlEncode(signingPublicBytes),
        publicKeyDigest: await sha256Digest(signingPublicBytes),
      },
      agreement: {
        keyId: syncKeyIdSchema.parse(keyIds.agreementKeyId),
        algorithm: "P256-ECDH",
        publicKey: base64UrlEncode(agreementPublicBytes),
        publicKeyDigest: await sha256Digest(agreementPublicBytes),
      },
    });
  } finally {
    material.signing.fill(0);
    material.agreement.fill(0);
  }
}

export async function verifySyncDeviceKeyCustody(
  privateKeyMaterial: SyncDevicePrivateKeyMaterial,
  expectedPublicKeysValue: SyncDevicePublicKeys,
): Promise<boolean> {
  try {
    const expected = syncDevicePublicKeysSchema.parse(expectedPublicKeysValue);
    const derived = await deriveSyncDevicePublicKeys(privateKeyMaterial, {
      signingKeyId: expected.signing.keyId,
      agreementKeyId: expected.agreement.keyId,
    });
    return canonicalSessionSyncJson(derived) === canonicalSessionSyncJson(expected);
  } catch {
    return false;
  }
}

export async function importSyncDeviceKeyPairs(
  privateKeyMaterial: SyncDevicePrivateKeyMaterial,
  expectedPublicKeysValue: SyncDevicePublicKeys,
): Promise<SyncDeviceKeyPairs> {
  const expected = syncDevicePublicKeysSchema.parse(expectedPublicKeysValue);
  if (!await verifySyncDeviceKeyCustody(privateKeyMaterial, expected)) {
    throw new Error("sync device private keys do not match the expected public keys");
  }
  const material = parsePrivateKeyMaterial(privateKeyMaterial);
  const crypto = requireWebCrypto();
  try {
    const [signingPrivateKey, agreementPrivateKey] = await Promise.all([
      crypto.subtle.importKey(
        "pkcs8",
        ownedBuffer(material.signing),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
      crypto.subtle.importKey(
        "pkcs8",
        ownedBuffer(material.agreement),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      ),
    ]);
    return { publicKeys: expected, signingPrivateKey, agreementPrivateKey };
  } finally {
    material.signing.fill(0);
    material.agreement.fill(0);
  }
}

export function createSyncProofNonce(): SyncProofNonce {
  return randomOpaqueId("syncproof", syncProofNonceSchema);
}

export function createSyncVaultRootKey(): Uint8Array {
  const key = new Uint8Array(32);
  requireWebCrypto().getRandomValues(key);
  return key;
}

export async function commitSyncVaultRootKey(
  rootKeyValue: Uint8Array,
): Promise<SyncSha256Digest> {
  const rootKey = exactBytes(rootKeyValue, 32, "sync vault root key");
  const preimage = concatBytes(
    textEncoder.encode("oprte.session-sync.vault-root-commitment.v1\0"),
    rootKey,
  );
  try {
    return await sha256Digest(preimage);
  } finally {
    preimage.fill(0);
    rootKey.fill(0);
  }
}

export async function verifySyncDevicePublicKeys(
  value: SyncDevicePublicKeys,
): Promise<boolean> {
  const keys = syncDevicePublicKeysSchema.parse(value);
  return keys.signing.publicKeyDigest === await sha256Digest(base64UrlDecode(keys.signing.publicKey))
    && keys.agreement.publicKeyDigest === await sha256Digest(base64UrlDecode(keys.agreement.publicKey));
}

export async function digestSyncRequestBody(
  value: unknown,
): Promise<SyncSha256Digest> {
  const bytes = value instanceof Uint8Array
    ? value
    : textEncoder.encode(canonicalSessionSyncJson(value));
  return await sha256Digest(bytes);
}

export function canonicalSyncDeviceProofPayload(
  value: SyncDeviceProofPayload,
): Uint8Array {
  const proof = syncDeviceProofPayloadSchema.parse(value);
  return textEncoder.encode(canonicalSessionSyncJson(proof));
}

function canonicalSyncDeviceProofSigningPayload(
  payload: SyncDeviceProofPayload,
  signingKeyId: SyncKeyId,
): Uint8Array {
  return textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    purpose: "device_proof",
    signingKeyId,
    payload,
  }));
}

export async function signSyncDeviceProof(
  payloadValue: SyncDeviceProofPayload,
  signingKeyIdValue: SyncKeyId,
  privateKey: CryptoKey,
): Promise<SyncDeviceProof> {
  const payload = syncDeviceProofPayloadSchema.parse(payloadValue);
  const signingKeyId = syncKeyIdSchema.parse(signingKeyIdValue);
  const signature = new Uint8Array(await requireWebCrypto().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    ownedBuffer(canonicalSyncDeviceProofSigningPayload(payload, signingKeyId)),
  ));
  return syncDeviceProofSchema.parse({
    payload,
    signingKeyId,
    signature: base64UrlEncode(signature),
  });
}

export async function verifySyncDeviceProof(
  proofValue: SyncDeviceProof,
  publicKeysValue: SyncDevicePublicKeys,
  nowValue: SyncUint64 | string,
): Promise<boolean> {
  const proof = syncDeviceProofSchema.parse(proofValue);
  const keys = syncDevicePublicKeysSchema.parse(publicKeysValue);
  const now = decodeSyncUint64(syncUint64Schema.parse(nowValue));
  if (
    proof.signingKeyId !== keys.signing.keyId
    || now < decodeSyncUint64(proof.payload.issuedAt)
    || now > decodeSyncUint64(proof.payload.expiresAt)
    || !await verifySyncDevicePublicKeys(keys)
  ) return false;
  const publicKey = await importP256PublicKey(keys.signing.publicKey, "ECDSA");
  return await requireWebCrypto().subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    ownedBuffer(base64UrlDecode(proof.signature)),
    ownedBuffer(canonicalSyncDeviceProofSigningPayload(proof.payload, proof.signingKeyId)),
  );
}

function canonicalSyncEnrollmentPossessionSignaturePayload(
  payload: SyncEnrollmentPossessionProofPayload,
  keyRole: "signing" | "agreement",
  keyId: SyncKeyId,
  publicKeyDigest: SyncSha256Digest,
): Uint8Array {
  return textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    purpose: "enrollment_possession",
    enrollmentPurpose: payload.purpose,
    keyRole,
    keyId,
    publicKeyDigest,
    payload,
  }));
}

/**
 * Proves custody of both candidate keys before enrollment can create durable
 * state. The agreement PKCS8 is imported transiently as ECDSA over the same
 * P-256 scalar and is never retained in that role.
 */
export async function signSyncEnrollmentPossessionProof(
  payloadValue: SyncEnrollmentPossessionProofPayload,
  privateKeyMaterial: SyncDevicePrivateKeyMaterial,
  publicKeysValue: SyncDevicePublicKeys,
): Promise<SyncEnrollmentPossessionProof> {
  const payload = syncEnrollmentPossessionProofPayloadSchema.parse(payloadValue);
  const publicKeys = syncDevicePublicKeysSchema.parse(publicKeysValue);
  if (!await verifySyncDeviceKeyCustody(privateKeyMaterial, publicKeys)) {
    throw new Error("sync enrollment private keys do not match the candidate public keys");
  }
  const material = parsePrivateKeyMaterial(privateKeyMaterial);
  try {
    const subtle = requireWebCrypto().subtle;
    const [signingPrivateKey, agreementSigningPrivateKey] = await Promise.all([
      subtle.importKey(
        "pkcs8",
        ownedBuffer(material.signing),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
      subtle.importKey(
        "pkcs8",
        ownedBuffer(material.agreement),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
    ]);
    const [signingSignature, agreementSignature] = await Promise.all([
      subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signingPrivateKey,
        ownedBuffer(canonicalSyncEnrollmentPossessionSignaturePayload(
          payload,
          "signing",
          publicKeys.signing.keyId,
          publicKeys.signing.publicKeyDigest,
        )),
      ),
      subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        agreementSigningPrivateKey,
        ownedBuffer(canonicalSyncEnrollmentPossessionSignaturePayload(
          payload,
          "agreement",
          publicKeys.agreement.keyId,
          publicKeys.agreement.publicKeyDigest,
        )),
      ),
    ]);
    return syncEnrollmentPossessionProofSchema.parse({
      payload,
      signingKeyId: publicKeys.signing.keyId,
      signingSignature: base64UrlEncode(new Uint8Array(signingSignature)),
      agreementKeyId: publicKeys.agreement.keyId,
      agreementSignature: base64UrlEncode(new Uint8Array(agreementSignature)),
    });
  } finally {
    material.signing.fill(0);
    material.agreement.fill(0);
  }
}

export async function verifySyncEnrollmentPossessionProof(
  proofValue: SyncEnrollmentPossessionProof,
  publicKeysValue: SyncDevicePublicKeys,
  nowValue: SyncUint64 | string,
): Promise<boolean> {
  try {
    const proof = syncEnrollmentPossessionProofSchema.parse(proofValue);
    const publicKeys = syncDevicePublicKeysSchema.parse(publicKeysValue);
    const now = decodeSyncUint64(syncUint64Schema.parse(nowValue));
    if (
      proof.signingKeyId !== publicKeys.signing.keyId
      || proof.agreementKeyId !== publicKeys.agreement.keyId
      || now < decodeSyncUint64(proof.payload.issuedAt)
      || now > decodeSyncUint64(proof.payload.expiresAt)
      || !await verifySyncDevicePublicKeys(publicKeys)
    ) return false;
    const [signingPublicKey, agreementSigningPublicKey] = await Promise.all([
      importP256PublicKey(publicKeys.signing.publicKey, "ECDSA"),
      importP256PublicKey(publicKeys.agreement.publicKey, "ECDSA"),
    ]);
    const subtle = requireWebCrypto().subtle;
    const [signingVerified, agreementVerified] = await Promise.all([
      subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        signingPublicKey,
        ownedBuffer(base64UrlDecode(proof.signingSignature)),
        ownedBuffer(canonicalSyncEnrollmentPossessionSignaturePayload(
          proof.payload,
          "signing",
          proof.signingKeyId,
          publicKeys.signing.publicKeyDigest,
        )),
      ),
      subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        agreementSigningPublicKey,
        ownedBuffer(base64UrlDecode(proof.agreementSignature)),
        ownedBuffer(canonicalSyncEnrollmentPossessionSignaturePayload(
          proof.payload,
          "agreement",
          proof.agreementKeyId,
          publicKeys.agreement.publicKeyDigest,
        )),
      ),
    ]);
    return signingVerified && agreementVerified;
  } catch {
    return false;
  }
}

export function canonicalSyncMembershipStatement(
  value: SyncMembershipStatement,
): Uint8Array {
  return textEncoder.encode(canonicalSessionSyncJson(
    syncMembershipStatementSchema.parse(value),
  ));
}

export async function digestSyncMembershipStatement(
  value: SyncMembershipStatement,
): Promise<SyncSha256Digest> {
  return await sha256Digest(canonicalSyncMembershipStatement(value));
}

export async function signSyncMembershipStatement(
  statementValue: SyncMembershipStatement,
  deviceId: SyncDeviceId,
  signingKeyIdValue: SyncKeyId,
  privateKey: CryptoKey,
): Promise<SyncMembershipSignature> {
  const statement = syncMembershipStatementSchema.parse(statementValue);
  const signingKeyId = syncKeyIdSchema.parse(signingKeyIdValue);
  const signature = new Uint8Array(await requireWebCrypto().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    ownedBuffer(canonicalSyncMembershipSignaturePayload(statement, deviceId, signingKeyId)),
  ));
  return syncMembershipSignatureSchema.parse({
    deviceId,
    signingKeyId,
    signature: base64UrlEncode(signature),
  });
}

export async function verifySyncMembershipSignature(
  statementValue: SyncMembershipStatement,
  signatureValue: SyncMembershipSignature,
  publicKeysValue: SyncDevicePublicKeys,
): Promise<boolean> {
  const statement = syncMembershipStatementSchema.parse(statementValue);
  const signature = syncMembershipSignatureSchema.parse(signatureValue);
  const keys = syncDevicePublicKeysSchema.parse(publicKeysValue);
  if (
    signature.signingKeyId !== keys.signing.keyId
    || !await verifySyncDevicePublicKeys(keys)
  ) return false;
  const publicKey = await importP256PublicKey(keys.signing.publicKey, "ECDSA");
  return await requireWebCrypto().subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    ownedBuffer(base64UrlDecode(signature.signature)),
    ownedBuffer(canonicalSyncMembershipSignaturePayload(
      statement,
      signature.deviceId,
      signature.signingKeyId,
    )),
  );
}

function canonicalSyncMembershipSignaturePayload(
  statement: SyncMembershipStatement,
  deviceId: SyncDeviceId,
  signingKeyId: SyncKeyId,
): Uint8Array {
  return textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    purpose: "membership_statement",
    deviceId,
    signingKeyId,
    statement,
  }));
}

export async function wrapSyncVaultRootKey(
  rootKeyValue: Uint8Array,
  contextValue: SyncVaultRootWrapContext,
  recipientAgreementPublicKeyValue: string,
): Promise<WrappedSyncVaultRootKey> {
  const rootKey = exactBytes(rootKeyValue, 32, "sync vault root key");
  try {
    const context = syncVaultRootWrapContextSchema.parse(contextValue);
    const recipientAgreementPublicKey = syncP256PublicKeySchema.parse(
      recipientAgreementPublicKeyValue,
    );
    const crypto = requireWebCrypto();
    const ephemeral = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    if (!("privateKey" in ephemeral) || !("publicKey" in ephemeral)) {
      throw new Error("The platform did not create an ephemeral P-256 key pair");
    }
    const recipient = await importP256PublicKey(recipientAgreementPublicKey, "ECDH");
    const aad = vaultRootWrapAad(context);
    const wrappingKey = await deriveAgreementKey(
      ephemeral.privateKey,
      recipient,
      aad,
      VAULT_ROOT_WRAP_INFO,
      ["encrypt"],
    );
    const nonceBytes = new Uint8Array(12);
    crypto.getRandomValues(nonceBytes);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(nonceBytes),
        additionalData: ownedBuffer(aad),
        tagLength: 128,
      },
      wrappingKey,
      ownedBuffer(rootKey),
    ));
    const ephemeralPublicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", ephemeral.publicKey),
    );
    return wrappedSyncVaultRootKeySchema.parse({
      context,
      algorithm: SESSION_SUMMARY_ALGORITHM,
      ephemeralAgreementPublicKey: base64UrlEncode(ephemeralPublicKey),
      nonce: base64UrlEncode(nonceBytes),
      ciphertext: base64UrlEncode(ciphertext),
      ciphertextDigest: await sha256Digest(ciphertext),
    });
  } finally {
    rootKey.fill(0);
  }
}

export async function unwrapSyncVaultRootKey(
  envelopeValue: WrappedSyncVaultRootKey,
  expectedContextValue: SyncVaultRootWrapContext,
  recipientAgreementPrivateKey: CryptoKey,
): Promise<Uint8Array> {
  const envelope = wrappedSyncVaultRootKeySchema.parse(envelopeValue);
  const expectedContext = syncVaultRootWrapContextSchema.parse(expectedContextValue);
  if (canonicalSessionSyncJson(envelope.context) !== canonicalSessionSyncJson(expectedContext)) {
    throw new Error("Wrapped sync vault root key has the wrong authority context");
  }
  const ciphertext = base64UrlDecode(envelope.ciphertext);
  if (envelope.ciphertextDigest !== await sha256Digest(ciphertext)) {
    throw new Error("Wrapped sync vault root key digest does not match");
  }
  const ephemeral = await importP256PublicKey(envelope.ephemeralAgreementPublicKey, "ECDH");
  const aad = vaultRootWrapAad(envelope.context);
  const wrappingKey = await deriveAgreementKey(
    recipientAgreementPrivateKey,
    ephemeral,
    aad,
    VAULT_ROOT_WRAP_INFO,
    ["decrypt"],
  );
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(await requireWebCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(base64UrlDecode(envelope.nonce)),
        additionalData: ownedBuffer(aad),
        tagLength: 128,
      },
      wrappingKey,
      ownedBuffer(ciphertext),
    ));
    return exactBytes(plaintext, 32, "unwrapped sync vault root key");
  } catch {
    throw new Error("Wrapped sync vault root key authentication failed");
  } finally {
    plaintext?.fill(0);
  }
}

export async function digestSyncVaultRootWrapManifest(
  wrapValues: readonly WrappedSyncVaultRootKey[],
): Promise<SyncSha256Digest> {
  const wraps = z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS)
    .parse(wrapValues);
  const first = wraps[0];
  if (first === undefined) throw new Error("sync vault root wrap manifest cannot be empty");
  const recipientDeviceIds = new Set(wraps.map(({ context }) => context.recipientDeviceId));
  const rootKeyEpochs = new Set(wraps.map(({ context }) => context.rootKeyEpoch));
  if (
    recipientDeviceIds.size > MAX_SYNC_DEVICES
    || rootKeyEpochs.size > MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS
  ) {
    throw new Error("sync vault root wrap manifest exceeds its device or epoch bound");
  }
  const recipientEpochPairs = wraps.map(({ context }) => (
    `${context.recipientDeviceId}\0${context.rootKeyEpoch}`
  ));
  if (new Set(recipientEpochPairs).size !== recipientEpochPairs.length) {
    throw new Error("sync vault root wrap manifest recipient and epoch pairs must be unique");
  }
  if (wraps.some(({ context }) => !sameRootWrapAuthority(
    context,
    first.context,
  ))) {
    throw new Error("sync vault root wrap manifest mixes authority coordinates");
  }
  const canonicalWraps = [...wraps].sort((left, right) => {
    const epochComparison = decodeSyncUint64(left.context.rootKeyEpoch)
      - decodeSyncUint64(right.context.rootKeyEpoch);
    if (epochComparison < 0n) return -1;
    if (epochComparison > 0n) return 1;
    const deviceComparison = compareCanonicalStrings(
      left.context.recipientDeviceId,
      right.context.recipientDeviceId,
    );
    return deviceComparison !== 0
      ? deviceComparison
      : compareCanonicalStrings(
          left.context.recipientAgreementKeyId,
          right.context.recipientAgreementKeyId,
        );
  });
  return await digestSyncRequestBody({
    protocol: SESSION_SYNC_PROTOCOL,
    purpose: "vault_root_wrap_manifest",
    vault: {
      tenantId: first.context.tenantId,
      organizationId: first.context.organizationId,
      ownerUserId: first.context.ownerUserId,
      vaultId: first.context.vaultId,
      vaultGeneration: first.context.vaultGeneration,
    },
    membershipEpoch: first.context.membershipEpoch,
    rootKeyEpochs: [...rootKeyEpochs].sort((left, right) => {
      const comparison = decodeSyncUint64(left) - decodeSyncUint64(right);
      return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
    }),
    wraps: canonicalWraps,
  });
}

export async function digestSyncVaultRootKeyLink(
  linkValue: WrappedSyncVaultRootKeyLink,
): Promise<SyncSha256Digest> {
  const link = wrappedSyncVaultRootKeyLinkSchema.parse(linkValue);
  const authenticatedLink = {
    context: link.context,
    algorithm: link.algorithm,
    nonce: link.nonce,
    ciphertext: link.ciphertext,
    ciphertextDigest: link.ciphertextDigest,
  } as const;
  return await digestSyncRequestBody({
    protocol: SESSION_SYNC_PROTOCOL,
    purpose: "vault_root_backward_link_envelope",
    link: authenticatedLink,
  });
}

export async function wrapSyncParentVaultRootKey(
  parentRootKeyValue: Uint8Array,
  childRootKeyValue: Uint8Array,
  contextValue: SyncVaultRootKeyLinkContext,
): Promise<WrappedSyncVaultRootKeyLink> {
  const parentRootKey = exactBytes(parentRootKeyValue, 32, "parent sync vault root key");
  const childRootKey = exactBytes(childRootKeyValue, 32, "child sync vault root key");
  try {
    const context = syncVaultRootKeyLinkContextSchema.parse(contextValue);
    const [parentCommitment, childCommitment] = await Promise.all([
      commitSyncVaultRootKey(parentRootKey),
      commitSyncVaultRootKey(childRootKey),
    ]);
    if (
      context.parentRootKeyCommitment !== parentCommitment
      || context.childRootKeyCommitment !== childCommitment
    ) {
      throw new Error("backward root key link commitments do not match the supplied keys");
    }
    const crypto = requireWebCrypto();
    const aad = vaultRootKeyLinkAad(context);
    const wrappingKey = await deriveRootKeyLinkKey(childRootKey, aad, ["encrypt"]);
    const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(nonceBytes),
        additionalData: ownedBuffer(aad),
        tagLength: 128,
      },
      wrappingKey,
      ownedBuffer(parentRootKey),
    ));
    const authenticatedLink = {
      context,
      algorithm: VAULT_ROOT_LINK_ALGORITHM,
      nonce: base64UrlEncode(nonceBytes),
      ciphertext: base64UrlEncode(ciphertext),
      ciphertextDigest: await sha256Digest(ciphertext),
    } as const;
    const provisional = wrappedSyncVaultRootKeyLinkSchema.parse({
      ...authenticatedLink,
      linkDigest: await digestSyncRequestBody({
        protocol: SESSION_SYNC_PROTOCOL,
        purpose: "vault_root_backward_link_envelope",
        link: authenticatedLink,
      }),
    });
    if (provisional.linkDigest !== await digestSyncVaultRootKeyLink(provisional)) {
      throw new Error("backward root key link digest construction failed");
    }
    return provisional;
  } finally {
    parentRootKey.fill(0);
    childRootKey.fill(0);
  }
}

export async function unwrapSyncParentVaultRootKey(
  linkValue: WrappedSyncVaultRootKeyLink,
  expectedContextValue: SyncVaultRootKeyLinkContext,
  childRootKeyValue: Uint8Array,
): Promise<Uint8Array> {
  const link = wrappedSyncVaultRootKeyLinkSchema.parse(linkValue);
  const expectedContext = syncVaultRootKeyLinkContextSchema.parse(expectedContextValue);
  const childRootKey = exactBytes(childRootKeyValue, 32, "child sync vault root key");
  let parentRootKey: Uint8Array | undefined;
  try {
    if (canonicalSessionSyncJson(link.context) !== canonicalSessionSyncJson(expectedContext)) {
      throw new Error("backward root key link has the wrong authority context");
    }
    if (link.context.childRootKeyCommitment !== await commitSyncVaultRootKey(childRootKey)) {
      throw new Error("backward root key link child commitment does not match");
    }
    const ciphertext = base64UrlDecode(link.ciphertext);
    if (link.ciphertextDigest !== await sha256Digest(ciphertext)) {
      throw new Error("backward root key link ciphertext digest does not match");
    }
    if (link.linkDigest !== await digestSyncVaultRootKeyLink(link)) {
      throw new Error("backward root key link digest does not match");
    }
    const aad = vaultRootKeyLinkAad(link.context);
    const wrappingKey = await deriveRootKeyLinkKey(childRootKey, aad, ["decrypt"]);
    let plaintext: Uint8Array;
    try {
      plaintext = new Uint8Array(await requireWebCrypto().subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ownedBuffer(base64UrlDecode(link.nonce)),
          additionalData: ownedBuffer(aad),
          tagLength: 128,
        },
        wrappingKey,
        ownedBuffer(ciphertext),
      ));
    } catch {
      throw new Error("backward root key link authentication failed");
    }
    try {
      parentRootKey = exactBytes(plaintext, 32, "unwrapped parent sync vault root key");
    } finally {
      plaintext.fill(0);
    }
    if (link.context.parentRootKeyCommitment !== await commitSyncVaultRootKey(parentRootKey)) {
      throw new Error("backward root key link parent commitment does not match");
    }
    const result = parentRootKey;
    parentRootKey = undefined;
    return result;
  } finally {
    childRootKey.fill(0);
    parentRootKey?.fill(0);
  }
}

export async function deriveSessionContentKey(
  rootKeyValue: Uint8Array,
  contextValue: SessionContentKeyContext,
  usages: readonly ("encrypt" | "decrypt")[] = ["encrypt", "decrypt"],
): Promise<CryptoKey> {
  const rootKey = exactBytes(rootKeyValue, 32, "sync vault root key");
  let contextBytes: Uint8Array | undefined;
  let saltBytes: Uint8Array | undefined;
  try {
    const context = sessionContentKeyContextSchema.parse(contextValue);
    const subtle = requireWebCrypto().subtle;
    const material = await subtle.importKey(
      "raw",
      ownedBuffer(rootKey),
      "HKDF",
      false,
      ["deriveKey"],
    );
    contextBytes = textEncoder.encode(canonicalSessionSyncJson({
      protocol: SESSION_SYNC_PROTOCOL,
      purpose: "session_content_key",
      context,
    }));
    saltBytes = new Uint8Array(await subtle.digest("SHA-256", ownedBuffer(contextBytes)));
    return await subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: ownedBuffer(saltBytes),
        info: ownedBuffer(SESSION_CONTENT_KEY_INFO),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      [...usages],
    );
  } finally {
    rootKey.fill(0);
    contextBytes?.fill(0);
    saltBytes?.fill(0);
  }
}

export function createSessionSyncNonceState(
  keyEpochValue: PositiveSyncUint64 | string,
  firstSequenceValue: PositiveSyncUint64 | string = "1",
): SessionSyncNonceState {
  return sessionSyncNonceStateSchema.parse({
    version: 1,
    keyEpoch: positiveSyncUint64Schema.parse(keyEpochValue),
    prefix: SESSION_SYNC_NONCE_DOMAIN_PREFIX,
    nextSequence: positiveSyncUint64Schema.parse(firstSequenceValue),
  });
}

export function syncNonceForSequence(sequenceValue: PositiveSyncUint64 | string): string {
  const sequence = positiveSyncUint64Schema.parse(sequenceValue);
  const nonceBytes = new Uint8Array(12);
  nonceBytes.set(base64UrlDecode(SESSION_SYNC_NONCE_DOMAIN_PREFIX), 0);
  new DataView(nonceBytes.buffer).setBigUint64(4, decodeSyncUint64(sequence), false);
  return base64UrlEncode(nonceBytes);
}

export function allocateSessionSyncNonce(
  stateValue: SessionSyncNonceState,
  sequenceValue: PositiveSyncUint64 | string = stateValue.nextSequence,
): AllocatedSessionSyncNonce {
  const state = sessionSyncNonceStateSchema.parse(stateValue);
  const sequence = positiveSyncUint64Schema.parse(sequenceValue);
  if (sequence !== state.nextSequence) {
    throw new Error("session sync nonce allocation must be contiguous");
  }
  const nextSequence = nextSyncUint64(sequence);
  return {
    allocation: sessionSyncNonceAllocationSchema.parse({
      keyEpoch: state.keyEpoch,
      sequence,
      nonce: syncNonceForSequence(sequence),
    }),
    nextState: nextSequence === null
      ? null
      : sessionSyncNonceStateSchema.parse({ ...state, nextSequence }),
  };
}

export function sessionSummaryAad(headerValue: SessionSyncHeader): Uint8Array {
  const header = sessionSyncHeaderSchema.parse(headerValue);
  return textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    algorithm: SESSION_SUMMARY_ALGORITHM,
    header,
  }));
}

export async function sealSessionSummary(
  summaryValue: SessionSummary,
  headerValue: SessionSyncHeader,
  contentKey: CryptoKey,
  nonceAllocationValue: SessionSyncNonceAllocation,
): Promise<SealedSessionSummary> {
  assertObservationOnlySyncValue(summaryValue);
  const summary = sessionSummarySchema.parse(summaryValue);
  const header = sessionSyncHeaderSchema.parse(headerValue);
  const allocation = sessionSyncNonceAllocationSchema.parse(nonceAllocationValue);
  assertSummaryMatchesHeader(summary, header);
  if (allocation.keyEpoch !== header.keyEpoch || allocation.sequence !== header.syncSequence) {
    throw new Error("session sync nonce allocation does not match the encrypted coordinates");
  }
  if (allocation.nonce !== syncNonceForSequence(header.syncSequence)) {
    throw new Error("session sync nonce does not match its closed sequence domain");
  }
  const plaintext = textEncoder.encode(canonicalSessionSyncJson(summary));
  try {
    if (plaintext.byteLength > MAX_SYNC_SUMMARY_PLAINTEXT_BYTES) {
      throw new Error("session summary exceeds the encrypted plaintext bound");
    }
    const aad = sessionSummaryAad(header);
    const ciphertext = new Uint8Array(await requireWebCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(base64UrlDecode(allocation.nonce)),
        additionalData: ownedBuffer(aad),
        tagLength: 128,
      },
      contentKey,
      ownedBuffer(plaintext),
    ));
    return sealedSessionSummarySchema.parse({
      header,
      algorithm: SESSION_SUMMARY_ALGORITHM,
      nonce: allocation.nonce,
      ciphertext: base64UrlEncode(ciphertext),
      ciphertextBytes: ciphertext.byteLength,
      ciphertextDigest: await sha256Digest(ciphertext),
    });
  } finally {
    plaintext.fill(0);
  }
}

export async function openSessionSummary(
  envelopeValue: SealedSessionSummary,
  expectedHeaderValue: SessionSyncHeader,
  contentKey: CryptoKey,
): Promise<SessionSummary> {
  const envelope = sealedSessionSummarySchema.parse(envelopeValue);
  const expectedHeader = sessionSyncHeaderSchema.parse(expectedHeaderValue);
  if (canonicalSessionSyncJson(envelope.header) !== canonicalSessionSyncJson(expectedHeader)) {
    throw new Error("Sealed session summary has the wrong authority coordinates");
  }
  const ciphertext = base64UrlDecode(envelope.ciphertext);
  if (envelope.ciphertextDigest !== await sha256Digest(ciphertext)) {
    throw new Error("Sealed session summary digest does not match");
  }
  if (envelope.nonce !== syncNonceForSequence(envelope.header.syncSequence)) {
    throw new Error("Sealed session summary nonce does not match its sequence");
  }
  const aad = sessionSummaryAad(envelope.header);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(await requireWebCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(base64UrlDecode(envelope.nonce)),
        additionalData: ownedBuffer(aad),
        tagLength: 128,
      },
      contentKey,
      ownedBuffer(ciphertext),
    ));
  } catch {
    throw new Error("Sealed session summary authentication failed");
  }
  try {
    if (plaintext.byteLength > MAX_SYNC_SUMMARY_PLAINTEXT_BYTES) {
      throw new Error("Sealed session summary exceeds the plaintext bound");
    }
    let value: unknown;
    try {
      value = JSON.parse(textDecoder.decode(plaintext)) as unknown;
    } catch {
      throw new Error("Sealed session summary is not valid canonical JSON");
    }
    assertObservationOnlySyncValue(value);
    const summary = sessionSummarySchema.parse(value);
    if (canonicalSessionSyncJson(summary) !== textDecoder.decode(plaintext)) {
      throw new Error("Sealed session summary is not canonical JSON");
    }
    assertSummaryMatchesHeader(summary, envelope.header);
    return summary;
  } finally {
    plaintext.fill(0);
  }
}

/** Deterministic JSON for signatures, digests, HKDF contexts, and AEAD AAD. */
export function canonicalSessionSyncJson(value: unknown): string {
  return canonicalJsonValue(value, new Set<object>());
}

function canonicalJsonValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("canonical sync JSON permits only finite safe integers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("canonical sync JSON contains an unsupported value");
  }
  if (seen.has(value)) throw new TypeError("canonical sync JSON contains a reference cycle");
  seen.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => canonicalJsonValue(item, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical sync JSON requires plain records");
    }
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    serialized = `{${entries.map(([key, item]) => (
      `${JSON.stringify(key)}:${canonicalJsonValue(item, seen)}`
    )).join(",")}}`;
  }
  seen.delete(value);
  return serialized;
}

function assertSummaryMatchesHeader(summary: SessionSummary, header: SessionSyncHeader): void {
  if (
    summary.sessionId !== header.sessionId
    || summary.ownerDeviceId !== header.originDeviceId
    || summary.directoryOrdinal !== header.directoryOrdinal
    || summary.sourceRevision !== header.sourceRevision
  ) {
    throw new Error("session summary does not match its routing coordinates");
  }
  if ((header.eventKind === "deleted") !== summary.deleted) {
    throw new Error("session summary deletion state does not match its event kind");
  }
}

function vaultRootWrapAad(context: SyncVaultRootWrapContext): Uint8Array {
  return textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    algorithm: SESSION_SUMMARY_ALGORITHM,
    purpose: "vault_root_wrap",
    context,
  }));
}

function vaultRootKeyLinkAad(context: SyncVaultRootKeyLinkContext): Uint8Array {
  return textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    algorithm: VAULT_ROOT_LINK_ALGORITHM,
    purpose: "vault_root_backward_link",
    context,
  }));
}

async function deriveRootKeyLinkKey(
  childRootKey: Uint8Array,
  aad: Uint8Array,
  usages: readonly ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  const subtle = requireWebCrypto().subtle;
  const material = await subtle.importKey(
    "raw",
    ownedBuffer(childRootKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const salt = await subtle.digest("SHA-256", ownedBuffer(aad));
  return await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: ownedBuffer(VAULT_ROOT_LINK_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [...usages],
  );
}

function sameRootWrapAuthority(
  left: SyncVaultRootWrapContext,
  right: SyncVaultRootWrapContext,
): boolean {
  return left.tenantId === right.tenantId
    && left.organizationId === right.organizationId
    && left.ownerUserId === right.ownerUserId
    && left.vaultId === right.vaultId
    && left.vaultGeneration === right.vaultGeneration
    && left.membershipEpoch === right.membershipEpoch;
}

async function deriveAgreementKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  aad: Uint8Array,
  info: Uint8Array,
  usages: readonly ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  const subtle = requireWebCrypto().subtle;
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = await subtle.digest("SHA-256", ownedBuffer(aad));
  return await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: ownedBuffer(info) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [...usages],
  );
}

async function importP256PublicKey(
  value: string,
  algorithm: "ECDSA" | "ECDH",
): Promise<CryptoKey> {
  const encoded = syncP256PublicKeySchema.parse(value);
  return await requireWebCrypto().subtle.importKey(
    "raw",
    ownedBuffer(base64UrlDecode(encoded)),
    { name: algorithm, namedCurve: "P-256" },
    false,
    algorithm === "ECDSA" ? ["verify"] : [],
  );
}

async function sha256Digest(value: Uint8Array): Promise<SyncSha256Digest> {
  const digest = new Uint8Array(await requireWebCrypto().subtle.digest(
    "SHA-256",
    ownedBuffer(value),
  ));
  return syncSha256DigestSchema.parse(`sha256_${hex(digest)}`);
}

function randomOpaqueId<S extends { parse: (value: unknown) => unknown }>(
  prefix: string,
  schema: S,
): ReturnType<S["parse"]> {
  const bytes = new Uint8Array(16);
  requireWebCrypto().getRandomValues(bytes);
  return schema.parse(`${prefix}_${hex(bytes)}`) as ReturnType<S["parse"]>;
}

function exactBytes(value: Uint8Array, length: number, label: string): Uint8Array {
  if (value.byteLength !== length) throw new TypeError(`${label} must contain exactly ${length} bytes`);
  const copy = new Uint8Array(length);
  copy.set(value);
  return copy;
}

function requireWebCrypto(): Crypto {
  const crypto = globalThis.crypto;
  if (crypto === undefined) throw new Error("Web Crypto is unavailable");
  return crypto;
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("invalid canonical base64url");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(decoded) !== value) throw new TypeError("invalid canonical base64url");
  return decoded;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
