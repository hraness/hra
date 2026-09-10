import { parseEncryptedEnvelope, snapshotForeignJson, type EncryptedEnvelope } from "./contracts";
import {
  decodeBase64Url,
  decryptBytes,
  encodeBase64Url,
  encryptBytes,
  KeyRotationRequiredError,
} from "./crypto";
import { parseUsageHeadContextV2, usageHeadAadV2, type UsageHeadContextV2 } from "./usage-context-v2";
import {
  parseUsageHeadV2,
  USAGE_HEAD_V2_CLAUDE_MAX_JSON_BYTES,
  USAGE_HEAD_V2_CODEX_MAX_JSON_BYTES,
  type UsageHeadV2,
} from "./usage-head-v2";
import { snapshotUsageAccountKeyV2 } from "./usage-key-v2";

// Unpadded base64url of at most P plaintext bytes plus the 16-byte GCM tag.
// These limits exclude envelope framing and do not admit hosted publication.
export const USAGE_ENVELOPE_V2_CODEX_MAX_CIPHERTEXT_CHARACTERS = 93_303;
export const USAGE_ENVELOPE_V2_CLAUDE_MAX_CIPHERTEXT_CHARACTERS = 25_991;
export const USAGE_ENVELOPE_V2_MAX_CIPHERTEXT_CHARACTERS = USAGE_ENVELOPE_V2_CODEX_MAX_CIPHERTEXT_CHARACTERS;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function plaintextLimit(context: UsageHeadContextV2): number {
  return context.provider === "codex" ? USAGE_HEAD_V2_CODEX_MAX_JSON_BYTES : USAGE_HEAD_V2_CLAUDE_MAX_JSON_BYTES;
}

function parseEnvelope(input: unknown, context: UsageHeadContextV2): EncryptedEnvelope | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const maximum = context.provider === "codex"
    ? USAGE_ENVELOPE_V2_CODEX_MAX_CIPHERTEXT_CHARACTERS : USAGE_ENVELOPE_V2_CLAUDE_MAX_CIPHERTEXT_CHARACTERS;
  const envelope = parseEncryptedEnvelope(snapshot.value, maximum);
  if (envelope === null || envelope.keyVersion !== context.keyVersion) return null;
  // The V1 shape parser intentionally remains unchanged. V2 refuses alternate
  // textual spellings instead of normalizing bytes belonging to an exact outbox.
  const nonce = decodeBase64Url(envelope.nonce);
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 16
    || ciphertext.byteLength > plaintextLimit(context) + 16
    || encodeBase64Url(nonce) !== envelope.nonce || encodeBase64Url(ciphertext) !== envelope.ciphertext) return null;
  return Object.freeze(envelope);
}

/**
 * Encrypt one canonical head with independently selected context. The caller
 * still owns trusted-context acquisition, persistent key budgeting and exact
 * revision/outbox admission. This function creates no retry or dispatch right.
 */
export async function encryptUsageHeadV2(
  input: unknown,
  accountKey: Uint8Array,
  expectedContext: unknown,
): Promise<EncryptedEnvelope> {
  try {
    const key = snapshotUsageAccountKeyV2(accountKey);
    if (key === null) throw new Error("Invalid key.");
    const context = parseUsageHeadContextV2(expectedContext);
    if (context === null) throw new Error("Invalid context.");
    const head = parseUsageHeadV2(input, context);
    if (head === null) throw new Error("Invalid head.");
    const plaintext = encoder.encode(JSON.stringify(head));
    if (plaintext.byteLength > plaintextLimit(context)) throw new Error("Invalid plaintext length.");
    const aad = usageHeadAadV2(context);
    // Only owned key/plaintext/AAD cross an await. Deliberately omit the optional
    // budget argument: V1 and V2 share the existing key/version process bucket.
    const encrypted = await encryptBytes(plaintext, key, context.keyVersion, aad);
    const envelope = parseEnvelope(encrypted, context);
    if (envelope === null) throw new Error("Invalid envelope.");
    return envelope;
  } catch (error) {
    if (error instanceof KeyRotationRequiredError) throw error;
    throw new Error("Usage head encryption failed.");
  }
}

/** Authenticate and parse V2 only. No failed V2 operation falls back to V1. */
export async function decryptUsageHeadV2(
  input: unknown,
  accountKey: Uint8Array,
  expectedContext: unknown,
): Promise<UsageHeadV2> {
  try {
    const key = snapshotUsageAccountKeyV2(accountKey);
    if (key === null) throw new Error("Invalid key.");
    const context = parseUsageHeadContextV2(expectedContext);
    if (context === null) throw new Error("Invalid context.");
    const envelope = parseEnvelope(input, context);
    if (envelope === null) throw new Error("Invalid envelope.");
    const aad = usageHeadAadV2(context);
    const plaintext = await decryptBytes(envelope, key, aad);
    if (plaintext.byteLength > plaintextLimit(context)) throw new Error("Invalid plaintext length.");
    const value: unknown = JSON.parse(decoder.decode(plaintext));
    const head = parseUsageHeadV2(value, context);
    if (head === null) throw new Error("Invalid head.");
    return head;
  } catch {
    throw new Error("Usage head decryption failed.");
  }
}
