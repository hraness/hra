export const cloudLimits = Object.freeze({
  ciphertextCharacters: 350_000,
  detailChunkBytes: 256 * 1024,
  deviceLabelCiphertextCharacters: 2_048,
  identifierCharacters: 96,
  metadataCiphertextCharacters: 16_384,
  pageSize: 100,
  resultCodeCharacters: 64,
} as const);

export type EncryptedEnvelope = Readonly<{
  algorithm: "A256GCM";
  ciphertext: string;
  keyVersion: number;
  nonce: string;
}>;

export type WrappedKeyEnvelope = Readonly<{
  algorithm: "P256-HKDF-SHA256+A256GCM";
  ciphertext: string;
  ephemeralPublicKey: string;
  keyVersion: number;
  nonce: string;
}>;

export type AuthorityTuple = Readonly<{
  bootGeneration: number;
  bootId: string;
  fence: number;
}>;

export type CommandKind =
  | "send"
  | "queue"
  | "steer"
  | "stop"
  | "set_model"
  | "set_fast";

export type CommandState =
  | "pending"
  | "prepared"
  | "effect_started"
  | "applied"
  | "failed"
  | "ambiguous"
  | "cancelled"
  | "expired";

export type SyncStream = "compact" | "detail";

export type CloudProjectionRecoveryAdmissionFailure =
  | "identity_or_session_conflict"
  | "idempotency_authority_invalid"
  | "journal_capacity"
  | "unsettled_session";

export class CloudProjectionRecoveryAdmissionError extends Error {
  readonly code: CloudProjectionRecoveryAdmissionFailure;

  constructor(code: CloudProjectionRecoveryAdmissionFailure) {
    super(`Cloud projection recovery admission failed: ${code}.`);
    this.name = "CloudProjectionRecoveryAdmissionError";
    this.code = code;
  }
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const opaqueIdentifierPattern = /^[A-Za-z0-9_-]{8,96}$/u;
const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length
      && keys.every((key) => typeof key === "string" && expected.includes(key));
  } catch {
    return false;
  }
}

export function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

export function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

export function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string" && opaqueIdentifierPattern.test(value);
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && uuidV7Pattern.test(value);
}

const absolutePathTokenPattern = /(^|[^\p{L}\p{N}_/\\])((?:file:\/\/+|~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>{}[\](),;]+[\\/]|\/(?!\/))[^\s"'`<>{}[\](),;]*)/iu;
const absolutePathTokenGlobalPattern = /(^|[^\p{L}\p{N}_/\\])((?:file:\/\/+|~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>{}[\](),;]+[\\/]|\/(?!\/))[^\s"'`<>{}[\](),;]*)/giu;
const repeatedLeadingSlashPathPattern = /(^|[\s"'`<>{}[\](),;])\/{2,}[^\s"'`<>{}[\](),;]*/u;
const repeatedLeadingSlashPathGlobalPattern = /(^|[\s"'`<>{}[\](),;])\/{2,}[^\s"'`<>{}[\](),;]*/gu;
const unsafeTerminalScalarPattern = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function containsAbsolutePath(value: string): boolean {
  return absolutePathTokenPattern.test(value) || repeatedLeadingSlashPathPattern.test(value);
}

export function redactAbsolutePaths(value: string): string {
  return value
    .replace(repeatedLeadingSlashPathGlobalPattern, (_match, prefix: string) =>
      `${prefix}[local-path]`)
    .replace(absolutePathTokenGlobalPattern, (_match, prefix: string) =>
      `${prefix}[local-path]`);
}

export function containsUnsafeTerminalScalar(value: string, allowLineFeeds = false): boolean {
  for (const scalar of value) {
    if (allowLineFeeds && scalar === "\n") continue;
    if (unsafeTerminalScalarPattern.test(scalar)) return true;
  }
  return false;
}

export function isBase64Url(
  value: unknown,
  minimumCharacters: number,
  maximumCharacters: number,
): value is string {
  return typeof value === "string"
    && value.length >= minimumCharacters
    && value.length <= maximumCharacters
    && base64UrlPattern.test(value);
}

export function parseEncryptedEnvelope(
  value: unknown,
  maximumCiphertextCharacters: number = cloudLimits.ciphertextCharacters,
): EncryptedEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "algorithm",
    "ciphertext",
    "keyVersion",
    "nonce",
  ])) return null;
  if (
    value.algorithm !== "A256GCM"
    || !isBase64Url(value.ciphertext, 22, maximumCiphertextCharacters)
    || !isSafePositiveInteger(value.keyVersion)
    || !isBase64Url(value.nonce, 16, 16)
  ) return null;
  return {
    algorithm: value.algorithm,
    ciphertext: value.ciphertext,
    keyVersion: value.keyVersion,
    nonce: value.nonce,
  };
}

export function parseWrappedKeyEnvelope(value: unknown): WrappedKeyEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "algorithm",
    "ciphertext",
    "ephemeralPublicKey",
    "keyVersion",
    "nonce",
  ])) return null;
  if (
    value.algorithm !== "P256-HKDF-SHA256+A256GCM"
    || !isBase64Url(value.ciphertext, 64, 96)
    || typeof value.ephemeralPublicKey !== "string"
    || value.ephemeralPublicKey.length < 100
    || value.ephemeralPublicKey.length > 512
    || !isSafePositiveInteger(value.keyVersion)
    || !isBase64Url(value.nonce, 16, 16)
  ) return null;
  return {
    algorithm: value.algorithm,
    ciphertext: value.ciphertext,
    ephemeralPublicKey: value.ephemeralPublicKey,
    keyVersion: value.keyVersion,
    nonce: value.nonce,
  };
}

export function parseAuthorityTuple(value: unknown): AuthorityTuple | null {
  if (!isRecord(value) || !hasExactKeys(value, ["bootGeneration", "bootId", "fence"])) {
    return null;
  }
  if (
    !isSafePositiveInteger(value.bootGeneration)
    || !isOpaqueIdentifier(value.bootId)
    || !isSafePositiveInteger(value.fence)
  ) return null;
  return {
    bootGeneration: value.bootGeneration,
    bootId: value.bootId,
    fence: value.fence,
  };
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected closed-union value: ${String(value)}`);
}
