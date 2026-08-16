const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CANONICAL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url32(value: string): Uint8Array | null {
  if (!CANONICAL_SECRET_PATTERN.test(value)) return null;
  try {
    const binary = atob(`${value.replaceAll("-", "+").replaceAll("_", "/") }=`);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length === 32 && encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function decodeCanonicalKey(value: string): Uint8Array | null {
  return decodeBase64Url32(value);
}

export function isVerifierDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value) && decodeBase64Url32(value) !== null;
}

export function digestArrayBuffer(value: string): ArrayBuffer | null {
  const bytes = decodeBase64Url32(value);
  return bytes === null ? null : copiedArrayBuffer(bytes);
}

export function encodeDigest(value: ArrayBuffer): string {
  return encodeBase64Url(new Uint8Array(value));
}

export async function hmacSha256Base64Url(
  canonicalBase64UrlKey: string,
  message: Uint8Array,
): Promise<string> {
  const keyBytes = decodeCanonicalKey(canonicalBase64UrlKey);
  if (keyBytes === null || message.length !== 32) {
    throw new Error("Invalid HMAC key or message length.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    copiedArrayBuffer(keyBytes),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, copiedArrayBuffer(message));
  return encodeBase64Url(new Uint8Array(digest));
}

export async function hmacSha256Utf8KeyBase64Url(
  utf8Key: string,
  message: string,
): Promise<string> {
  if (utf8Key.length === 0) throw new Error("HMAC key must not be empty.");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    copiedArrayBuffer(encoder.encode(utf8Key)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    copiedArrayBuffer(encoder.encode(message)),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

export async function verifyHmacSha256(
  canonicalBase64UrlKey: string,
  message: Uint8Array,
  expectedDigest: ArrayBuffer,
): Promise<boolean> {
  const keyBytes = decodeCanonicalKey(canonicalBase64UrlKey);
  if (keyBytes === null || message.length !== 32 || expectedDigest.byteLength !== 32) {
    throw new Error("Invalid HMAC verification material.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    copiedArrayBuffer(keyBytes),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    copiedArrayBuffer(new Uint8Array(expectedDigest)),
    copiedArrayBuffer(message),
  );
}

export async function sha256Base64Url(
  value: string | Uint8Array,
): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copiedArrayBuffer(bytes),
  );
  return encodeBase64Url(new Uint8Array(digest));
}
