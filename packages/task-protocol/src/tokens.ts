import { z } from "@hra-internal/schema";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BEARER_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const EMBEDDED_SECRET_TOKEN_PATTERN = /(?:agt|enr)_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}/gu;
const EMBEDDED_JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const SENSITIVE_JSON_FIELD_PATTERN =
  /("(?:accessToken|refreshToken|access_token|refresh_token|deviceCode|device_code|authorization)"\s*:\s*)"(?:\\(?:["\\/bfnrt]|u[0-9a-f]{4})|[^"\\])*"/giu;
const AUTHORIZATION_HEADER_PATTERN = /(Authorization\s*:\s*(?:Bearer\s+)?)[^\s,;]+/giu;
const SENSITIVE_FORM_FIELD_PATTERN =
  /((?:access_token|refresh_token|device_code|deviceCode|refreshToken|accessToken)=)[^&\s]*/giu;

export const locatorSchema = z
  .string()
  .length(26)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, "invalid Crockford locator");
export const bearerSecretSchema = z
  .string()
  .length(43)
  .regex(BEARER_SECRET_PATTERN, "invalid base64url secret")
  .refine((value) => decodeBearerSecret(value) !== null, "secret is not canonical 32-byte base64url");

export const credentialTokenSchema = z
  .string()
  .regex(/^agt_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/u, "invalid agent credential")
  .refine((value) => bearerSecretSchema.safeParse(value.slice(-43)).success, "non-canonical credential secret");
export const enrollmentTokenSchema = z
  .string()
  .regex(/^enr_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/u, "invalid enrollment token")
  .refine((value) => bearerSecretSchema.safeParse(value.slice(-43)).success, "non-canonical enrollment secret");
export const sessionIdSchema = z
  .string()
  .regex(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/u, "invalid agent session ID");
export const requestIdSchema = z
  .string()
  .regex(/^req_[0-9A-HJKMNP-TV-Z]{26}$/u, "invalid request ID");
export const uuidV7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    "idempotency key must be UUIDv7",
  );

export type CredentialToken = z.infer<typeof credentialTokenSchema>;
export type EnrollmentToken = z.infer<typeof enrollmentTokenSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type IdempotencyKey = z.infer<typeof uuidV7Schema>;

export interface ParsedSecretToken {
  readonly locator: string;
  readonly secret: string;
}

function parseSecretToken(prefix: "agt" | "enr", value: string): ParsedSecretToken | null {
  const expectedLength = prefix.length + 1 + 26 + 1 + 43;
  if (value.length !== expectedLength || !value.startsWith(`${prefix}_`)) {
    return null;
  }

  const locator = value.slice(prefix.length + 1, prefix.length + 1 + 26);
  const separatorIndex = prefix.length + 1 + 26;
  const secret = value.slice(separatorIndex + 1);
  if (!locatorSchema.safeParse(locator).success || !bearerSecretSchema.safeParse(secret).success) {
    return null;
  }
  return { locator, secret };
}

export function parseCredentialToken(value: string): ParsedSecretToken | null {
  return parseSecretToken("agt", value);
}

export function parseEnrollmentToken(value: string): ParsedSecretToken | null {
  return parseSecretToken("enr", value);
}

export function formatCredentialToken(locator: string, secret: string): CredentialToken {
  return credentialTokenSchema.parse(`agt_${locator}_${secret}`);
}

export function formatEnrollmentToken(locator: string, secret: string): EnrollmentToken {
  return enrollmentTokenSchema.parse(`enr_${locator}_${secret}`);
}

function randomCharacters(alphabet: string, length: number, randomBytes: Uint8Array): string {
  if (randomBytes.length < length) {
    throw new RangeError(`expected at least ${length} random bytes`);
  }
  let result = "";
  for (let index = 0; index < length; index += 1) {
    const byte = randomBytes[index];
    if (byte === undefined) {
      throw new RangeError(`missing random byte at index ${index}`);
    }
    result += alphabet[byte % alphabet.length];
  }
  return result;
}

export function createLocator(randomBytes: Uint8Array): string {
  return locatorSchema.parse(randomCharacters(CROCKFORD_ALPHABET, 26, randomBytes));
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Decode the canonical 32 bytes used as the HMAC message for a bearer secret. */
export function decodeBearerSecret(value: string): Uint8Array | null {
  if (!BEARER_SECRET_PATTERN.test(value)) {
    return null;
  }

  try {
    const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}=`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length === 32 && encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

export function createBearerSecret(randomBytes: Uint8Array): string {
  if (randomBytes.length !== 32) {
    throw new RangeError("bearer secrets require exactly 32 random bytes");
  }
  return bearerSecretSchema.parse(encodeBase64Url(randomBytes));
}

export function redactSecret(value: string): string {
  void value;
  return "[REDACTED]";
}

export function redactSecretsInText(value: string, knownSecrets: readonly string[] = []): string {
  const structurallyRedacted = value
    .replaceAll(EMBEDDED_SECRET_TOKEN_PATTERN, "[REDACTED]")
    .replaceAll(EMBEDDED_JWT_PATTERN, "[REDACTED]")
    .replace(SENSITIVE_JSON_FIELD_PATTERN, '$1"[REDACTED]"')
    .replace(AUTHORIZATION_HEADER_PATTERN, "$1[REDACTED]")
    .replace(SENSITIVE_FORM_FIELD_PATTERN, "$1[REDACTED]");
  return [...new Set(knownSecrets)]
    .filter((secret) => secret.length >= 8)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), structurallyRedacted);
}

export function createOpaqueId(prefix: "ses", randomBytes: Uint8Array): SessionId;
export function createOpaqueId(prefix: "req", randomBytes: Uint8Array): RequestId;
export function createOpaqueId(prefix: "ses" | "req", randomBytes: Uint8Array): string {
  const value = `${prefix}_${createLocator(randomBytes)}`;
  return prefix === "ses" ? sessionIdSchema.parse(value) : requestIdSchema.parse(value);
}

export function createUuidV7(timestamp: number, randomBytes: Uint8Array): IdempotencyKey {
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp >= 2 ** 48 ||
    randomBytes.length !== 10
  ) {
    throw new RangeError("UUIDv7 requires a 48-bit epoch millisecond timestamp and exactly 10 random bytes");
  }

  const bytes = new Uint8Array(16);
  let remainingTimestamp = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp % 256;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }
  bytes.set(randomBytes, 6);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("UUIDv7 byte allocation invariant failed");
  }
  bytes[6] = (versionByte & 0x0f) | 0x70;
  bytes[8] = (variantByte & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return uuidV7Schema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export function uuidV7Timestamp(value: string): number | null {
  if (!uuidV7Schema.safeParse(value).success) {
    return null;
  }
  const parsed = Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
