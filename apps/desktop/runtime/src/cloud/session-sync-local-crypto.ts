import {
  MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS,
  MAX_SYNC_REPOSITORY_DISPLAY_NAME_UTF8_BYTES,
  MAX_SYNC_SUMMARY_PLAINTEXT_BYTES,
  MAX_SYNC_TITLE_UTF8_BYTES,
  SESSION_SYNC_PROTOCOL,
  assertObservationOnlySyncValue,
  canonicalSessionSyncJson,
  digestSyncRequestBody,
  positiveSyncUint64Schema,
  sessionPublicIdSchema,
  sessionSummaryStateSchema,
  sessionSyncEventKindSchema,
  sessionSyncNonceAllocationSchema,
  syncNonceForSequence,
  syncAesGcmNonceSchema,
  syncSha256DigestSchema,
  syncVaultCoordinateSchema,
  type PositiveSyncUint64,
  type SessionPublicId,
  type SessionSyncEventKind,
  type SessionSyncNonceAllocation,
  type SyncSha256Digest,
  type SyncVaultCoordinate,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const LOCAL_OUTBOX_INFO = textEncoder.encode(
  "oprte.session-sync.local-outbox.v1",
);

function boundedText(maximumBytes: number, label: string) {
  return z.string().min(1).refine(
    (value) => textEncoder.encode(value).byteLength <= maximumBytes,
    `${label} exceeds its byte bound`,
  ).refine((value) => {
    for (const character of value) {
      const codePoint = character.codePointAt(0);
      if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
        return false;
      }
    }
    return true;
  }, `${label} contains a control character`);
}

export const localSessionSyncIntentSchema = z.object({
  version: z.literal(1),
  sessionId: sessionPublicIdSchema,
  sourceRevision: positiveSyncUint64Schema,
  eventKind: sessionSyncEventKindSchema,
  title: boundedText(MAX_SYNC_TITLE_UTF8_BYTES, "session title"),
  repositoryDisplayName: boundedText(
    MAX_SYNC_REPOSITORY_DISPLAY_NAME_UTF8_BYTES,
    "repository display name",
  ).optional(),
  state: sessionSummaryStateSchema,
  deleted: z.boolean(),
}).strict().superRefine((intent, context) => {
  if ((intent.eventKind === "deleted") !== intent.deleted) {
    context.addIssue({
      code: "custom",
      message: "local intent deletion state does not match its event kind",
      path: ["deleted"],
    });
  }
});

export interface LocalSessionSyncIntent {
  readonly version: 1;
  readonly sessionId: SessionPublicId;
  readonly sourceRevision: PositiveSyncUint64;
  readonly eventKind: SessionSyncEventKind;
  readonly title: string;
  readonly repositoryDisplayName?: string;
  readonly state: "ready" | "working" | "attention" | "error" | "offline";
  readonly deleted: boolean;
}

const localCiphertextSchema = z.string()
  .min(23)
  .max(2_048)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const sealedLocalSessionSyncIntentSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("HKDF-SHA256-A256GCM"),
  vault: syncVaultCoordinateSchema,
  sessionId: sessionPublicIdSchema,
  keyEpoch: positiveSyncUint64Schema,
  sourceRevision: positiveSyncUint64Schema,
  eventKind: sessionSyncEventKindSchema,
  nonceSequence: positiveSyncUint64Schema,
  nonce: syncAesGcmNonceSchema,
  ciphertext: localCiphertextSchema,
  ciphertextBytes: z.number().int().min(17).max(
    MAX_SYNC_SUMMARY_PLAINTEXT_BYTES + 16,
  ),
  ciphertextDigest: syncSha256DigestSchema,
}).strict().superRefine((envelope, context) => {
  if (decodeBase64Url(envelope.ciphertext).byteLength !== envelope.ciphertextBytes) {
    context.addIssue({
      code: "custom",
      message: "local intent ciphertext byte count does not match",
      path: ["ciphertextBytes"],
    });
  }
});

export interface SealedLocalSessionSyncIntent {
  readonly version: 1;
  readonly algorithm: "HKDF-SHA256-A256GCM";
  readonly vault: SyncVaultCoordinate;
  readonly sessionId: SessionPublicId;
  readonly keyEpoch: PositiveSyncUint64;
  readonly sourceRevision: PositiveSyncUint64;
  readonly eventKind: SessionSyncEventKind;
  readonly nonceSequence: PositiveSyncUint64;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly ciphertextBytes: number;
  readonly ciphertextDigest: SyncSha256Digest;
}

export interface LocalSessionSyncRootKeyring {
  readonly vault: SyncVaultCoordinate;
  readonly currentRootKeyEpoch: PositiveSyncUint64;
  readonly rootKeys: readonly Readonly<{
    readonly keyEpoch: PositiveSyncUint64;
    readonly rootKey: Uint8Array;
  }>[];
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("invalid local session sync encoding");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError("invalid local session sync encoding");
  }
  const decoded = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
  if (encodeBase64Url(decoded) !== value) {
    throw new TypeError("invalid local session sync encoding");
  }
  return decoded;
}

function envelopeCoordinates(input: {
  readonly vault: SyncVaultCoordinate;
  readonly sessionId: SessionPublicId;
  readonly keyEpoch: PositiveSyncUint64;
  readonly sourceRevision: PositiveSyncUint64;
  readonly eventKind: SessionSyncEventKind;
  readonly nonceSequence: PositiveSyncUint64;
}) {
  return {
    protocol: SESSION_SYNC_PROTOCOL,
    purpose: "local_outbox_intent",
    version: 1,
    algorithm: "HKDF-SHA256-A256GCM",
    ...input,
  } as const;
}

async function deriveLocalOutboxKey(
  rootKey: Uint8Array,
  coordinates: ReturnType<typeof envelopeCoordinates>,
  usages: readonly ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  if (rootKey.byteLength !== 32) {
    throw new TypeError("Session sync vault root must contain 32 bytes.");
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error("Web Crypto is unavailable.");
  const context = textEncoder.encode(canonicalSessionSyncJson({
    protocol: SESSION_SYNC_PROTOCOL,
    purpose: "local_outbox_key",
    vault: coordinates.vault,
    sessionId: coordinates.sessionId,
    keyEpoch: coordinates.keyEpoch,
  }));
  const salt = await subtle.digest("SHA-256", ownedBuffer(context));
  const material = await subtle.importKey(
    "raw",
    ownedBuffer(rootKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: ownedBuffer(LOCAL_OUTBOX_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [...usages],
  );
}

export async function sealLocalSessionSyncIntent(input: {
  readonly intent: LocalSessionSyncIntent;
  readonly vault: SyncVaultCoordinate;
  readonly keyEpoch: PositiveSyncUint64;
  readonly rootKey: Uint8Array;
  readonly nonce: SessionSyncNonceAllocation;
}): Promise<SealedLocalSessionSyncIntent> {
  assertObservationOnlySyncValue(input.intent);
  const intent = localSessionSyncIntentSchema.parse(input.intent);
  const vault = syncVaultCoordinateSchema.parse(input.vault);
  const keyEpoch = positiveSyncUint64Schema.parse(input.keyEpoch);
  const nonce = sessionSyncNonceAllocationSchema.parse(input.nonce);
  if (nonce.keyEpoch !== keyEpoch) {
    throw new Error("Local session sync nonce belongs to another key epoch.");
  }
  if (nonce.nonce !== syncNonceForSequence(nonce.sequence)) {
    throw new Error("Local session sync nonce is outside its sequence domain.");
  }
  const coordinates = envelopeCoordinates({
    vault,
    sessionId: intent.sessionId,
    keyEpoch,
    sourceRevision: intent.sourceRevision,
    eventKind: intent.eventKind,
    nonceSequence: nonce.sequence,
  });
  const plaintext = textEncoder.encode(canonicalSessionSyncJson(intent));
  if (plaintext.byteLength > MAX_SYNC_SUMMARY_PLAINTEXT_BYTES) {
    throw new Error("Local session sync intent exceeds its plaintext bound.");
  }
  const key = await deriveLocalOutboxKey(input.rootKey, coordinates, [
    "encrypt",
  ]);
  const aad = textEncoder.encode(canonicalSessionSyncJson(coordinates));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ownedBuffer(decodeBase64Url(nonce.nonce)),
      additionalData: ownedBuffer(aad),
      tagLength: 128,
    },
    key,
    ownedBuffer(plaintext),
  ));
  return sealedLocalSessionSyncIntentSchema.parse({
    version: 1,
    algorithm: "HKDF-SHA256-A256GCM",
    vault,
    sessionId: intent.sessionId,
    keyEpoch,
    sourceRevision: intent.sourceRevision,
    eventKind: intent.eventKind,
    nonceSequence: nonce.sequence,
    nonce: nonce.nonce,
    ciphertext: encodeBase64Url(ciphertext),
    ciphertextBytes: ciphertext.byteLength,
    ciphertextDigest: await digestSyncRequestBody(ciphertext),
  });
}

export async function openLocalSessionSyncIntent(input: {
  readonly envelope: SealedLocalSessionSyncIntent;
  readonly expectedVault: SyncVaultCoordinate;
  readonly rootKey: Uint8Array;
}): Promise<LocalSessionSyncIntent> {
  const envelope = sealedLocalSessionSyncIntentSchema.parse(input.envelope);
  const expectedVault = syncVaultCoordinateSchema.parse(input.expectedVault);
  if (!sameValue(envelope.vault, expectedVault)) {
    throw new Error("Local session sync intent belongs to another vault.");
  }
  if (envelope.nonce !== syncNonceForSequence(envelope.nonceSequence)) {
    throw new Error("Local session sync nonce is outside its sequence domain.");
  }
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  if (
    envelope.ciphertextDigest !== await digestSyncRequestBody(ciphertext)
  ) {
    throw new Error("Local session sync intent digest does not match.");
  }
  const coordinates = envelopeCoordinates({
    vault: envelope.vault,
    sessionId: envelope.sessionId,
    keyEpoch: envelope.keyEpoch,
    sourceRevision: envelope.sourceRevision,
    eventKind: envelope.eventKind,
    nonceSequence: envelope.nonceSequence,
  });
  const key = await deriveLocalOutboxKey(input.rootKey, coordinates, [
    "decrypt",
  ]);
  const aad = textEncoder.encode(canonicalSessionSyncJson(coordinates));
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(decodeBase64Url(envelope.nonce)),
        additionalData: ownedBuffer(aad),
        tagLength: 128,
      },
      key,
      ownedBuffer(ciphertext),
    ));
  } catch {
    throw new Error("Local session sync intent authentication failed.");
  }
  if (plaintext.byteLength > MAX_SYNC_SUMMARY_PLAINTEXT_BYTES) {
    throw new Error("Local session sync intent exceeds its plaintext bound.");
  }
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(plaintext)) as unknown;
  } catch {
    throw new Error("Local session sync intent is invalid.");
  }
  assertObservationOnlySyncValue(value);
  const intent = localSessionSyncIntentSchema.parse(value);
  if (
    intent.sessionId !== envelope.sessionId
    || intent.sourceRevision !== envelope.sourceRevision
    || intent.eventKind !== envelope.eventKind
    || canonicalSessionSyncJson(intent) !== textDecoder.decode(plaintext)
  ) {
    throw new Error("Local session sync intent coordinates do not match.");
  }
  return intent as LocalSessionSyncIntent;
}

function validatedRootKeyring(
  input: LocalSessionSyncRootKeyring,
): LocalSessionSyncRootKeyring {
  const vault = syncVaultCoordinateSchema.parse(input.vault);
  const currentRootKeyEpoch = positiveSyncUint64Schema.parse(
    input.currentRootKeyEpoch,
  );
  if (
    input.rootKeys.length < 1
    || input.rootKeys.length > MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS
  ) {
    throw new Error("Local session sync root keyring exceeds its direct cache bound.");
  }
  const rootKeys = input.rootKeys.map(({ keyEpoch, rootKey }) => {
    const parsedEpoch = positiveSyncUint64Schema.parse(keyEpoch);
    if (rootKey.byteLength !== 32) {
      throw new TypeError("Session sync vault root must contain 32 bytes.");
    }
    return { keyEpoch: parsedEpoch, rootKey };
  });
  const sorted = [...rootKeys].sort((left, right) => {
    const difference = BigInt(left.keyEpoch) - BigInt(right.keyEpoch);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  });
  if (
    new Set(rootKeys.map(({ keyEpoch }) => keyEpoch)).size !== rootKeys.length
    || rootKeys.some(({ keyEpoch }, index) => keyEpoch !== sorted[index]?.keyEpoch)
    || rootKeys.at(-1)?.keyEpoch !== currentRootKeyEpoch
  ) {
    throw new Error("Local session sync root keyring is not canonical.");
  }
  return { vault, currentRootKeyEpoch, rootKeys };
}

export function selectLocalSessionSyncRootKey(input: {
  readonly keyring: LocalSessionSyncRootKeyring;
  readonly expectedVault: SyncVaultCoordinate;
  readonly keyEpoch: PositiveSyncUint64;
}): Uint8Array {
  const keyring = validatedRootKeyring(input.keyring);
  const expectedVault = syncVaultCoordinateSchema.parse(input.expectedVault);
  if (!sameValue(keyring.vault, expectedVault)) {
    throw new Error("Local session sync root keyring belongs to another vault.");
  }
  const keyEpoch = positiveSyncUint64Schema.parse(input.keyEpoch);
  const selected = keyring.rootKeys.find((candidate) =>
    candidate.keyEpoch === keyEpoch
  );
  if (selected === undefined) {
    throw new Error("Local session sync intent requires unavailable root history.");
  }
  return new Uint8Array(selected.rootKey);
}

export async function openLocalSessionSyncIntentFromKeyring(input: {
  readonly envelope: SealedLocalSessionSyncIntent;
  readonly expectedVault: SyncVaultCoordinate;
  readonly keyring: LocalSessionSyncRootKeyring;
}): Promise<LocalSessionSyncIntent> {
  const envelope = sealedLocalSessionSyncIntentSchema.parse(input.envelope);
  const rootKey = selectLocalSessionSyncRootKey({
    keyring: input.keyring,
    expectedVault: input.expectedVault,
    keyEpoch: envelope.keyEpoch,
  });
  try {
    return await openLocalSessionSyncIntent({
      envelope,
      expectedVault: input.expectedVault,
      rootKey,
    });
  } finally {
    rootKey.fill(0);
  }
}

/**
 * Authenticates a prepared old-epoch intent before resealing it under a fresh
 * root epoch. The source envelope is immutable; a failed open or seal leaves
 * it usable for restart reconciliation.
 */
export async function resealLocalSessionSyncIntent(input: {
  readonly envelope: SealedLocalSessionSyncIntent;
  readonly expectedVault: SyncVaultCoordinate;
  readonly sourceKeyring: LocalSessionSyncRootKeyring;
  readonly targetKeyEpoch: PositiveSyncUint64;
  readonly targetRootKey: Uint8Array;
  readonly targetNonce: SessionSyncNonceAllocation;
}): Promise<SealedLocalSessionSyncIntent> {
  const envelope = sealedLocalSessionSyncIntentSchema.parse(input.envelope);
  const targetKeyEpoch = positiveSyncUint64Schema.parse(input.targetKeyEpoch);
  if (BigInt(targetKeyEpoch) <= BigInt(envelope.keyEpoch)) {
    throw new Error("Local session sync reseal must advance the root key epoch.");
  }
  const sourceRootKey = selectLocalSessionSyncRootKey({
    keyring: input.sourceKeyring,
    expectedVault: input.expectedVault,
    keyEpoch: envelope.keyEpoch,
  });
  try {
    if (
      input.targetRootKey.byteLength !== 32
      || sourceRootKey.every((byte, index) => byte === input.targetRootKey[index])
    ) {
      throw new Error("Local session sync reseal requires a fresh root key.");
    }
    const intent = await openLocalSessionSyncIntent({
      envelope,
      expectedVault: input.expectedVault,
      rootKey: sourceRootKey,
    });
    return await sealLocalSessionSyncIntent({
      intent,
      vault: input.expectedVault,
      keyEpoch: targetKeyEpoch,
      rootKey: input.targetRootKey,
      nonce: input.targetNonce,
    });
  } finally {
    sourceRootKey.fill(0);
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalSessionSyncJson(left) === canonicalSessionSyncJson(right);
}
