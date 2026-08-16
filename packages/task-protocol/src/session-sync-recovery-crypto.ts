import { z } from "@hra-internal/schema";

import {
  canonicalSessionSyncJson,
  commitSyncVaultRootKey,
  digestSyncRequestBody,
} from "./session-sync-crypto";
import {
  MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS,
  SESSION_SYNC_PROTOCOL,
  positiveSyncUint64Schema,
  syncKeyIdSchema,
  syncP256PublicKeySchema,
  syncP256SignatureSchema,
  syncSha256DigestSchema,
  syncVaultCoordinateSchema,
  type SyncKeyId,
  type SyncSha256Digest,
  type SyncVaultCoordinate,
} from "./session-sync";
import {
  syncRecoveryAuthoritySchema,
  syncRecoveryAuthorizationSchema,
  syncRecoveryNonceSchema,
  syncRecoveryVaultRootWrapContextSchema,
  recoverSyncVaultRequestSchema,
  syncRecoveryStatementSchema,
  wrappedSyncRecoveryVaultRootKeySchema,
  type RecoverSyncVaultRequest,
  type SyncRecoveryAuthority,
  type SyncRecoveryAuthorization,
  type SyncRecoveryStatement,
  type SyncRecoveryVaultRootWrapContext,
  type WrappedSyncRecoveryVaultRootKey,
} from "./session-sync-recovery";

const textEncoder = new TextEncoder();
const RECOVERY_ROOT_WRAP_INFO = textEncoder.encode(
  "oprte.session-sync.recovery-root-wrap.v1",
);
const RECOVERY_ROOT_WRAP_ALGORITHM = "P256-HKDF-SHA256-A256GCM" as const;

const recoveryPkcs8Schema = z.string().min(128).max(342)
  .regex(/^[A-Za-z0-9_-]+$/u, "invalid recovery PKCS8 base64url");
const vaultRootKeySchema = z.string().length(43)
  .regex(/^[A-Za-z0-9_-]+$/u, "invalid recovery vault root key base64url");
const syncRecoveryRootKeySchema = z.object({
  keyEpoch: positiveSyncUint64Schema,
  rootKey: vaultRootKeySchema,
}).strict();

/** Explicitly sensitive recovery material. It must never cross the sync transport boundary. */
export const syncRecoveryKitSchema = z.object({
  version: z.literal(1),
  vault: syncVaultCoordinateSchema,
  recoveryGeneration: z.string().regex(/^(0|[1-9][0-9]{0,19})$/u),
  recoveryKeyId: syncKeyIdSchema,
  recoveryAgreementKeyId: syncKeyIdSchema,
  recoverySigningPkcs8: recoveryPkcs8Schema,
  recoveryAgreementPkcs8: recoveryPkcs8Schema,
  vaultRootKeys: z.array(syncRecoveryRootKeySchema)
    .min(1)
    .max(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
  keyringDigest: syncSha256DigestSchema,
  keyringSignature: syncP256SignatureSchema,
}).strict().superRefine((kit, context) => {
  if (kit.recoveryKeyId === kit.recoveryAgreementKeyId) {
    context.addIssue({
      code: "custom",
      message: "recovery signing and agreement key identifiers must be distinct",
      path: ["recoveryAgreementKeyId"],
    });
  }
  const epochs = kit.vaultRootKeys.map(({ keyEpoch }) => keyEpoch);
  if (new Set(epochs).size !== epochs.length) {
    context.addIssue({ code: "custom", message: "recovery root key epochs must be unique", path: ["vaultRootKeys"] });
  }
  if (epochs.some((epoch, index) => index > 0 && BigInt(epoch) <= BigInt(epochs[index - 1]!))) {
    context.addIssue({ code: "custom", message: "recovery root key epochs must be ordered", path: ["vaultRootKeys"] });
  }
});
export type SyncRecoveryKit = z.infer<typeof syncRecoveryKitSchema>;

export interface GeneratedSyncRecoveryKit {
  readonly authority: SyncRecoveryAuthority;
  readonly recoveryKit: SyncRecoveryKit;
}

export interface OpenedSyncRecoveryKit {
  readonly authority: SyncRecoveryAuthority;
  readonly recoverySigningPrivateKey: CryptoKey;
  readonly recoveryAgreementPrivateKey: CryptoKey;
  readonly vaultRootKeys: readonly Readonly<{ keyEpoch: string; rootKey: Uint8Array }>[];
}

export function createSyncRecoveryNonce(): string {
  const bytes = new Uint8Array(16);
  requireWebCrypto().getRandomValues(bytes);
  return syncRecoveryNonceSchema.parse(`syncrecovery_${hex(bytes)}`);
}

export async function generateSyncRecoveryKit(
  vaultValue: SyncVaultCoordinate,
  recoveryGenerationValue: string,
  rootKeyEpochValue: string = "1",
  rootKeyValue?: Uint8Array,
  retainedRootKeys: readonly Readonly<{ keyEpoch: string; rootKey: Uint8Array }>[] = [],
): Promise<GeneratedSyncRecoveryKit> {
  const vault = syncVaultCoordinateSchema.parse(vaultValue);
  const recoveryGeneration = syncRecoveryAuthoritySchema.shape.recoveryGeneration.parse(
    recoveryGenerationValue,
  );
  const rootKeyEpoch = positiveSyncUint64Schema.parse(rootKeyEpochValue);
  const retained = retainedRootKeys.map(({ keyEpoch, rootKey }) => ({
    keyEpoch: positiveSyncUint64Schema.parse(keyEpoch),
    rootKey: exactRecoveryRootKey(rootKey),
  }));
  if (
    retained.some(({ keyEpoch }) => keyEpoch === rootKeyEpoch)
    || new Set(retained.map(({ keyEpoch }) => keyEpoch)).size !== retained.length
    || retained.length + 1 > MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS
  ) {
    for (const item of retained) item.rootKey.fill(0);
    throw new Error("sync recovery root keyring is invalid or exceeds its bound");
  }
  const crypto = requireWebCrypto();
  const [signingPair, agreementPair] = await Promise.all([
    crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ),
    crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ),
  ]);
  if (
    !("privateKey" in signingPair)
    || !("publicKey" in signingPair)
    || !("privateKey" in agreementPair)
    || !("publicKey" in agreementPair)
  ) {
    throw new Error("The platform did not create distinct P-256 recovery key pairs");
  }
  const [signingPublicBytes, agreementPublicBytes, signingPkcs8Bytes, agreementPkcs8Bytes] =
    await Promise.all([
      crypto.subtle.exportKey("raw", signingPair.publicKey)
        .then((value) => new Uint8Array(value)),
      crypto.subtle.exportKey("raw", agreementPair.publicKey)
        .then((value) => new Uint8Array(value)),
      crypto.subtle.exportKey("pkcs8", signingPair.privateKey)
        .then((value) => new Uint8Array(value)),
      crypto.subtle.exportKey("pkcs8", agreementPair.privateKey)
        .then((value) => new Uint8Array(value)),
    ]);
  const rootKey = rootKeyValue === undefined
    ? crypto.getRandomValues(new Uint8Array(32))
    : exactRecoveryRootKey(rootKeyValue);
  try {
    const recoveryKeyId = syncKeyIdSchema.parse(`synckey_${randomHex(16)}`);
    const recoveryAgreementKeyId = syncKeyIdSchema.parse(`synckey_${randomHex(16)}`);
    const authority = syncRecoveryAuthoritySchema.parse({
      version: 1,
      vault,
      recoveryGeneration,
      keyId: recoveryKeyId,
      algorithm: "P256-SHA256",
      publicKey: base64UrlEncode(signingPublicBytes),
      publicKeyDigest: await digestBytes(signingPublicBytes),
      agreementKeyId: recoveryAgreementKeyId,
      agreementAlgorithm: "P256-ECDH",
      agreementPublicKey: base64UrlEncode(agreementPublicBytes),
      agreementPublicKeyDigest: await digestBytes(agreementPublicBytes),
    });
    const vaultRootKeys = [
      ...retained.map(({ keyEpoch, rootKey: priorRootKey }) => ({
        keyEpoch,
        rootKey: base64UrlEncode(priorRootKey),
      })),
      { keyEpoch: rootKeyEpoch, rootKey: base64UrlEncode(rootKey) },
    ].sort((left, right) => BigInt(left.keyEpoch) < BigInt(right.keyEpoch)
      ? -1
      : BigInt(left.keyEpoch) > BigInt(right.keyEpoch)
        ? 1
        : 0);
    const keyringDigest = await digestSyncRequestBody(vaultRootKeys);
    const keyringSignature = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingPair.privateKey,
      ownedBuffer(recoveryKeyringPayload({
        vault,
        recoveryGeneration,
        recoveryKeyId,
        recoveryAgreementKeyId,
        vaultRootKeys,
        keyringDigest,
      })),
    ));
    return {
      authority,
      recoveryKit: syncRecoveryKitSchema.parse({
        version: 1,
        vault,
        recoveryGeneration,
        recoveryKeyId,
        recoveryAgreementKeyId,
        recoverySigningPkcs8: base64UrlEncode(signingPkcs8Bytes),
        recoveryAgreementPkcs8: base64UrlEncode(agreementPkcs8Bytes),
        vaultRootKeys,
        keyringDigest,
        keyringSignature: base64UrlEncode(keyringSignature),
      }),
    };
  } finally {
    signingPkcs8Bytes.fill(0);
    agreementPkcs8Bytes.fill(0);
    rootKey.fill(0);
    for (const item of retained) item.rootKey.fill(0);
  }
}

export async function deriveSyncRecoveryAuthority(
  kitValue: SyncRecoveryKit,
): Promise<SyncRecoveryAuthority> {
  const kit = syncRecoveryKitSchema.parse(kitValue);
  const signingPkcs8 = base64UrlDecode(kit.recoverySigningPkcs8);
  const agreementPkcs8 = base64UrlDecode(kit.recoveryAgreementPkcs8);
  try {
    const [signingPublicBytes, agreementPublicBytes] = await Promise.all([
      publicRawFromPrivatePkcs8(signingPkcs8, "ECDSA"),
      publicRawFromPrivatePkcs8(agreementPkcs8, "ECDH"),
    ]);
    return syncRecoveryAuthoritySchema.parse({
      version: 1,
      vault: kit.vault,
      recoveryGeneration: kit.recoveryGeneration,
      keyId: kit.recoveryKeyId,
      algorithm: "P256-SHA256",
      publicKey: base64UrlEncode(signingPublicBytes),
      publicKeyDigest: await digestBytes(signingPublicBytes),
      agreementKeyId: kit.recoveryAgreementKeyId,
      agreementAlgorithm: "P256-ECDH",
      agreementPublicKey: base64UrlEncode(agreementPublicBytes),
      agreementPublicKeyDigest: await digestBytes(agreementPublicBytes),
    });
  } finally {
    signingPkcs8.fill(0);
    agreementPkcs8.fill(0);
  }
}

export async function verifySyncRecoveryAuthority(
  authorityValue: SyncRecoveryAuthority,
): Promise<boolean> {
  try {
    const authority = syncRecoveryAuthoritySchema.parse(authorityValue);
    if (
      authority.publicKeyDigest !== await digestBytes(base64UrlDecode(authority.publicKey))
      || authority.agreementPublicKeyDigest
        !== await digestBytes(base64UrlDecode(authority.agreementPublicKey))
    ) return false;
    await Promise.all([
      importP256PublicKey(authority.publicKey, "ECDSA"),
      importP256PublicKey(authority.agreementPublicKey, "ECDH"),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function openSyncRecoveryKit(
  kitValue: SyncRecoveryKit,
  expectedAuthorityValue: SyncRecoveryAuthority,
): Promise<OpenedSyncRecoveryKit> {
  const kit = syncRecoveryKitSchema.parse(kitValue);
  const expectedAuthority = syncRecoveryAuthoritySchema.parse(expectedAuthorityValue);
  const derivedAuthority = await deriveSyncRecoveryAuthority(kit);
  if (canonicalSessionSyncJson(derivedAuthority) !== canonicalSessionSyncJson(expectedAuthority)) {
    throw new Error("sync recovery kit does not match the expected recovery authority");
  }
  if (kit.keyringDigest !== await digestSyncRequestBody(kit.vaultRootKeys)) {
    throw new Error("sync recovery keyring digest does not match");
  }
  const authorityKey = await requireWebCrypto().subtle.importKey(
    "raw",
    ownedBuffer(base64UrlDecode(expectedAuthority.publicKey)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  if (!await requireWebCrypto().subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    authorityKey,
    ownedBuffer(base64UrlDecode(kit.keyringSignature)),
    ownedBuffer(recoveryKeyringPayload(kit)),
  )) {
    throw new Error("sync recovery keyring signature does not match");
  }
  const signingPkcs8 = base64UrlDecode(kit.recoverySigningPkcs8);
  const agreementPkcs8 = base64UrlDecode(kit.recoveryAgreementPkcs8);
  const rootKeys = kit.vaultRootKeys.map(({ keyEpoch, rootKey }) => ({
    keyEpoch,
    rootKey: base64UrlDecode(rootKey),
  }));
  try {
    const [recoverySigningPrivateKey, recoveryAgreementPrivateKey] = await Promise.all([
      requireWebCrypto().subtle.importKey(
        "pkcs8",
        ownedBuffer(signingPkcs8),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
      requireWebCrypto().subtle.importKey(
        "pkcs8",
        ownedBuffer(agreementPkcs8),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      ),
    ]);
    return {
      authority: expectedAuthority,
      recoverySigningPrivateKey,
      recoveryAgreementPrivateKey,
      vaultRootKeys: rootKeys.map(({ keyEpoch, rootKey }) => ({
        keyEpoch,
        rootKey: new Uint8Array(rootKey),
      })),
    };
  } finally {
    signingPkcs8.fill(0);
    agreementPkcs8.fill(0);
    for (const item of rootKeys) item.rootKey.fill(0);
  }
}

export async function digestSyncRecoveryVaultRootWrap(
  envelopeValue: WrappedSyncRecoveryVaultRootKey,
): Promise<SyncSha256Digest> {
  const envelope = wrappedSyncRecoveryVaultRootKeySchema.parse(envelopeValue);
  return await digestSyncRequestBody({
    protocol: SESSION_SYNC_PROTOCOL,
    purpose: "recovery_vault_root_wrap_envelope",
    envelope,
  });
}

export async function wrapSyncVaultRootKeyForRecovery(
  rootKeyValue: Uint8Array,
  contextValue: SyncRecoveryVaultRootWrapContext,
  authorityValue: SyncRecoveryAuthority,
): Promise<WrappedSyncRecoveryVaultRootKey> {
  const rootKey = exactRecoveryRootKey(rootKeyValue);
  try {
    const context = syncRecoveryVaultRootWrapContextSchema.parse(contextValue);
    const authority = syncRecoveryAuthoritySchema.parse(authorityValue);
    if (!await verifySyncRecoveryAuthority(authority)) {
      throw new Error("sync recovery authority is invalid");
    }
    if (
      canonicalSessionSyncJson(context.vault) !== canonicalSessionSyncJson(authority.vault)
      || context.recoveryGeneration !== authority.recoveryGeneration
      || context.recipientRecoveryAgreementKeyId !== authority.agreementKeyId
    ) {
      throw new Error("sync recovery root wrap has the wrong authority context");
    }
    if (context.rootKeyCommitment !== await commitSyncVaultRootKey(rootKey)) {
      throw new Error("sync recovery root wrap commitment does not match the supplied root");
    }
    const crypto = requireWebCrypto();
    const ephemeral = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    if (!("privateKey" in ephemeral) || !("publicKey" in ephemeral)) {
      throw new Error("The platform did not create an ephemeral P-256 recovery key pair");
    }
    const recipient = await importP256PublicKey(
      authority.agreementPublicKey,
      "ECDH",
    );
    const aad = recoveryRootWrapAad(context);
    const wrappingKey = await deriveRecoveryAgreementKey(
      ephemeral.privateKey,
      recipient,
      aad,
      ["encrypt"],
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(nonce),
        additionalData: ownedBuffer(aad),
        tagLength: 128,
      },
      wrappingKey,
      ownedBuffer(rootKey),
    ));
    const ephemeralPublicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", ephemeral.publicKey),
    );
    return wrappedSyncRecoveryVaultRootKeySchema.parse({
      context,
      algorithm: RECOVERY_ROOT_WRAP_ALGORITHM,
      ephemeralAgreementPublicKey: base64UrlEncode(ephemeralPublicKey),
      nonce: base64UrlEncode(nonce),
      ciphertext: base64UrlEncode(ciphertext),
      ciphertextDigest: await digestBytes(ciphertext),
    });
  } finally {
    rootKey.fill(0);
  }
}

export async function unwrapSyncVaultRootKeyFromRecovery(
  envelopeValue: WrappedSyncRecoveryVaultRootKey,
  expectedContextValue: SyncRecoveryVaultRootWrapContext,
  authorityValue: SyncRecoveryAuthority,
  recoveryAgreementPrivateKey: CryptoKey,
): Promise<Uint8Array> {
  const envelope = wrappedSyncRecoveryVaultRootKeySchema.parse(envelopeValue);
  const expectedContext = syncRecoveryVaultRootWrapContextSchema.parse(expectedContextValue);
  const authority = syncRecoveryAuthoritySchema.parse(authorityValue);
  if (
    canonicalSessionSyncJson(envelope.context) !== canonicalSessionSyncJson(expectedContext)
    || canonicalSessionSyncJson(expectedContext.vault) !== canonicalSessionSyncJson(authority.vault)
    || expectedContext.recoveryGeneration !== authority.recoveryGeneration
    || expectedContext.recipientRecoveryAgreementKeyId !== authority.agreementKeyId
    || !await verifySyncRecoveryAuthority(authority)
  ) {
    throw new Error("sync recovery root wrap has the wrong authority context");
  }
  const ciphertext = base64UrlDecode(envelope.ciphertext);
  if (envelope.ciphertextDigest !== await digestBytes(ciphertext)) {
    throw new Error("sync recovery root wrap ciphertext digest does not match");
  }
  let plaintext: Uint8Array;
  try {
    const ephemeral = await importP256PublicKey(
      envelope.ephemeralAgreementPublicKey,
      "ECDH",
    );
    const aad = recoveryRootWrapAad(envelope.context);
    const wrappingKey = await deriveRecoveryAgreementKey(
      recoveryAgreementPrivateKey,
      ephemeral,
      aad,
      ["decrypt"],
    );
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
  } catch {
    throw new Error("sync recovery root wrap authentication failed");
  }
  let rootKey: Uint8Array;
  try {
    rootKey = exactRecoveryRootKey(plaintext);
  } finally {
    plaintext.fill(0);
  }
  if (envelope.context.rootKeyCommitment !== await commitSyncVaultRootKey(rootKey)) {
    rootKey.fill(0);
    throw new Error("sync recovery root wrap commitment does not match");
  }
  return rootKey;
}

export async function digestSyncRecoveryStatement(
  statementValue: SyncRecoveryStatement,
): Promise<SyncSha256Digest> {
  return await digestSyncRequestBody(syncRecoveryStatementSchema.parse(statementValue));
}

/** Stable recovery intent identity; replacement possession proofs may be refreshed on retry. */
export async function digestSyncRecoveryRequestIntent(
  requestValue: RecoverSyncVaultRequest,
): Promise<SyncSha256Digest> {
  const request = recoverSyncVaultRequestSchema.parse(requestValue);
  return await digestSyncRequestBody({
    version: request.version,
    authorization: request.authorization,
    membershipHead: request.membershipHead,
    wrappedRoots: request.wrappedRoots,
    recoveryRootWrap: request.recoveryRootWrap,
  });
}

function recoverySigningPayload(
  statement: SyncRecoveryStatement,
  statementDigest: SyncSha256Digest,
  signingKeyId: SyncKeyId,
): Uint8Array {
  return new TextEncoder().encode(canonicalSessionSyncJson({
    protocol: "oprte.session-sync/v1",
    purpose: "vault_recovery",
    signingKeyId,
    statementDigest,
    statement,
  }));
}

function recoveryKeyringPayload(value: Pick<
  SyncRecoveryKit,
  | "vault"
  | "recoveryGeneration"
  | "recoveryKeyId"
  | "recoveryAgreementKeyId"
  | "vaultRootKeys"
  | "keyringDigest"
>): Uint8Array {
  return new TextEncoder().encode(canonicalSessionSyncJson({
    protocol: "oprte.session-sync/v1",
    purpose: "recovery_keyring",
    vault: value.vault,
    recoveryGeneration: value.recoveryGeneration,
    recoveryKeyId: value.recoveryKeyId,
    recoveryAgreementKeyId: value.recoveryAgreementKeyId,
    vaultRootKeys: value.vaultRootKeys,
    keyringDigest: value.keyringDigest,
  }));
}

export async function signSyncRecoveryStatement(
  statementValue: SyncRecoveryStatement,
  signingKeyIdValue: SyncKeyId,
  privateKey: CryptoKey,
): Promise<SyncRecoveryAuthorization> {
  const statement = syncRecoveryStatementSchema.parse(statementValue);
  const signingKeyId = syncKeyIdSchema.parse(signingKeyIdValue);
  const statementDigest = await digestSyncRecoveryStatement(statement);
  const signature = new Uint8Array(await requireWebCrypto().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    ownedBuffer(recoverySigningPayload(statement, statementDigest, signingKeyId)),
  ));
  return syncRecoveryAuthorizationSchema.parse({
    statement,
    statementDigest,
    signingKeyId,
    signature: base64UrlEncode(signature),
  });
}

export async function verifySyncRecoveryAuthorization(
  authorizationValue: SyncRecoveryAuthorization,
  authorityValue: SyncRecoveryAuthority,
): Promise<boolean> {
  try {
    const authorization = syncRecoveryAuthorizationSchema.parse(authorizationValue);
    const authority = syncRecoveryAuthoritySchema.parse(authorityValue);
    if (
      authorization.signingKeyId !== authority.keyId
      || authorization.statement.currentRecoveryGeneration !== authority.recoveryGeneration
      || canonicalSessionSyncJson(authorization.statement.vault)
        !== canonicalSessionSyncJson(authority.vault)
      || authorization.statementDigest !== await digestSyncRecoveryStatement(authorization.statement)
      || !await verifySyncRecoveryAuthority(authority)
    ) return false;
    const publicKey = await requireWebCrypto().subtle.importKey(
      "raw",
      ownedBuffer(base64UrlDecode(authority.publicKey)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await requireWebCrypto().subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      ownedBuffer(base64UrlDecode(authorization.signature)),
      ownedBuffer(recoverySigningPayload(
        authorization.statement,
        authorization.statementDigest,
        authorization.signingKeyId,
      )),
    );
  } catch {
    return false;
  }
}

function recoveryRootWrapAad(context: SyncRecoveryVaultRootWrapContext): Uint8Array {
  return textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    algorithm: RECOVERY_ROOT_WRAP_ALGORITHM,
    purpose: "recovery_vault_root_wrap",
    context,
  }));
}

async function deriveRecoveryAgreementKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  aad: Uint8Array,
  usages: readonly ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  const subtle = requireWebCrypto().subtle;
  const shared = new Uint8Array(await subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  ));
  try {
    const material = await subtle.importKey("raw", ownedBuffer(shared), "HKDF", false, ["deriveKey"]);
    const salt = await subtle.digest("SHA-256", ownedBuffer(aad));
    return await subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: ownedBuffer(RECOVERY_ROOT_WRAP_INFO),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      [...usages],
    );
  } finally {
    shared.fill(0);
  }
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
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new TypeError("sync recovery PKCS8 is not a P-256 private key");
  }
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      ext: true,
      key_ops: algorithm === "ECDSA" ? ["verify"] : [],
    },
    { name: algorithm, namedCurve: "P-256" },
    true,
    algorithm === "ECDSA" ? ["verify"] : [],
  );
  return new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
}

async function digestBytes(bytes: Uint8Array): Promise<SyncSha256Digest> {
  const digest = new Uint8Array(await requireWebCrypto().subtle.digest("SHA-256", ownedBuffer(bytes)));
  return syncSha256DigestSchema.parse(`sha256_${hex(digest)}`);
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  requireWebCrypto().getRandomValues(bytes);
  return hex(bytes);
}

function requireWebCrypto(): Crypto {
  if (globalThis.crypto === undefined) throw new Error("Web Crypto is unavailable");
  return globalThis.crypto;
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
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) throw new TypeError("invalid canonical base64url");
  return bytes;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function exactRecoveryRootKey(value: Uint8Array): Uint8Array {
  if (value.byteLength !== 32) throw new TypeError("sync recovery vault root key must be 32 bytes");
  return new Uint8Array(value);
}
