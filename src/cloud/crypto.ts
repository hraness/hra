import {
  isBase64Url,
  isRecord,
  type EncryptedEnvelope,
  type WrappedKeyEnvelope,
} from "./contracts";

const encoder = new TextEncoder();
const accountWrapSalt = encoder.encode("hra-control-plane-account-key-wrap-salt:v1");
const publicJwkCoordinateCharacters = 43;

export type DevicePublicKey = Readonly<{
  crv: "P-256";
  kty: "EC";
  x: string;
  y: string;
}>;

export type DevicePrivateKey = DevicePublicKey & Readonly<{ d: string }>;

export type AccountKeyWrapAuthority = Readonly<{
  accountKeyVersion: number;
  devicePublicId: string;
  userPublicId: string;
}>;

export type DeviceBindAuthority = Readonly<{
  challengeId: string;
  devicePublicId: string;
  nonce: string;
}>;

function bytesToBinary(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return output;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!isBase64Url(value, 1, 1_000_000)) throw new Error("Invalid base64url value.");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return toHex(await crypto.subtle.digest("SHA-256", ownedBuffer(bytes)));
}

export async function hmacSha256Hex(
  keyBytes: Uint8Array,
  purpose: string,
  value: string,
): Promise<string> {
  if (keyBytes.byteLength !== 32 || !/^[a-z0-9:-]{3,80}$/u.test(purpose)) {
    throw new Error("Invalid keyed digest input.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(keyBytes),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    ownedBuffer(encoder.encode(`hra-control-plane:${purpose}:v1:${value}`)),
  );
  return toHex(digest);
}

export function randomKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

export function parseDevicePublicKey(value: unknown): DevicePublicKey | null {
  if (!isRecord(value)) return null;
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (
    keys.length !== 4
    || !keys.every((key) =>
      typeof key === "string" && ["crv", "kty", "x", "y"].includes(key))
    || value.crv !== "P-256"
    || value.kty !== "EC"
    || !isBase64Url(value.x, publicJwkCoordinateCharacters, publicJwkCoordinateCharacters)
    || !isBase64Url(value.y, publicJwkCoordinateCharacters, publicJwkCoordinateCharacters)
  ) return null;
  return { crv: value.crv, kty: value.kty, x: value.x, y: value.y };
}

export function parseDevicePublicKeyJson(value: unknown): DevicePublicKey | null {
  if (typeof value !== "string" || value.length < 100 || value.length > 512) return null;
  try {
    return parseDevicePublicKey(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

export function parseDevicePrivateKey(value: unknown): DevicePrivateKey | null {
  if (!isRecord(value)) return null;
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (
    keys.length !== 5
    || !keys.every((key) =>
      typeof key === "string" && ["crv", "d", "kty", "x", "y"].includes(key))
    || !isBase64Url(value.d, publicJwkCoordinateCharacters, publicJwkCoordinateCharacters)
  ) return null;
  const publicKey = parseDevicePublicKey({
    crv: value.crv,
    kty: value.kty,
    x: value.x,
    y: value.y,
  });
  return publicKey === null ? null : { ...publicKey, d: value.d };
}

export function parseDevicePrivateKeyJson(value: unknown): DevicePrivateKey | null {
  if (typeof value !== "string" || value.length < 140 || value.length > 640) return null;
  try {
    return parseDevicePrivateKey(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

export function canonicalDevicePublicKeyJson(value: DevicePublicKey): string {
  return JSON.stringify({ crv: value.crv, kty: value.kty, x: value.x, y: value.y });
}

export async function exportDevicePublicKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("jwk", key);
  const parsed = parseDevicePublicKey({
    crv: exported.crv,
    kty: exported.kty,
    x: exported.x,
    y: exported.y,
  });
  if (parsed === null) throw new Error("Unsupported device public key.");
  return canonicalDevicePublicKeyJson(parsed);
}

export async function exportDevicePrivateKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("jwk", key);
  const parsed = parseDevicePrivateKey({
    crv: exported.crv,
    d: exported.d,
    kty: exported.kty,
    x: exported.x,
    y: exported.y,
  });
  if (parsed === null) throw new Error("Unsupported device private key.");
  return JSON.stringify({
    crv: parsed.crv,
    d: parsed.d,
    kty: parsed.kty,
    x: parsed.x,
    y: parsed.y,
  });
}

export async function importP256PublicKey(
  encoded: string,
  usage: "signing" | "wrapping",
): Promise<CryptoKey> {
  const parsed = parseDevicePublicKeyJson(encoded);
  if (parsed === null) throw new Error("Unsupported device public key.");
  return await crypto.subtle.importKey(
    "jwk",
    parsed,
    usage === "signing"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "ECDH", namedCurve: "P-256" },
    false,
    usage === "signing" ? ["verify"] : [],
  );
}

export async function importP256PrivateKey(
  encoded: string,
  usage: "signing" | "wrapping",
): Promise<CryptoKey> {
  const parsed = parseDevicePrivateKeyJson(encoded);
  if (parsed === null) throw new Error("Unsupported device private key.");
  return await crypto.subtle.importKey(
    "jwk",
    parsed,
    usage === "signing"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "ECDH", namedCurve: "P-256" },
    false,
    usage === "signing" ? ["sign"] : ["deriveBits"],
  );
}

export async function generateDeviceSigningKeyPair(
  extractable = false,
): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    extractable,
    ["sign", "verify"],
  );
}

export async function generateDeviceWrappingKeyPair(
  extractable = false,
): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    extractable,
    ["deriveBits"],
  );
}

function accountWrapAad(authority: AccountKeyWrapAuthority): Uint8Array {
  if (
    !Number.isSafeInteger(authority.accountKeyVersion)
    || authority.accountKeyVersion < 1
    || authority.devicePublicId.length < 8
    || authority.devicePublicId.length > 96
    || authority.userPublicId.length < 8
    || authority.userPublicId.length > 96
  ) throw new Error("Invalid account-key wrap authority.");
  return encoder.encode([
    "hra-control-plane-account-key-wrap:v1",
    authority.userPublicId,
    authority.devicePublicId,
    String(authority.accountKeyVersion),
  ].join("\n"));
}

async function deriveWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  aad: Uint8Array,
): Promise<CryptoKey> {
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, [
    "deriveKey",
  ]);
  return await crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      info: ownedBuffer(aad),
      name: "HKDF",
      salt: ownedBuffer(accountWrapSalt),
    },
    hkdfKey,
    { length: 256, name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptBytes(
  plaintext: Uint8Array,
  accountKey: Uint8Array,
  keyVersion: number,
  aad: Uint8Array,
): Promise<EncryptedEnvelope> {
  if (accountKey.byteLength !== 32 || !Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error("Invalid account data key.");
  }
  const nonce = randomNonce();
  const key = await crypto.subtle.importKey("raw", ownedBuffer(accountKey), "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    {
      additionalData: ownedBuffer(aad),
      iv: ownedBuffer(nonce),
      name: "AES-GCM",
      tagLength: 128,
    },
    key,
    ownedBuffer(plaintext),
  );
  return {
    algorithm: "A256GCM",
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    keyVersion,
    nonce: encodeBase64Url(nonce),
  };
}

export async function decryptBytes(
  envelope: EncryptedEnvelope,
  accountKey: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (accountKey.byteLength !== 32) throw new Error("Invalid account data key.");
  const key = await crypto.subtle.importKey("raw", ownedBuffer(accountKey), "AES-GCM", false, [
    "decrypt",
  ]);
  const plaintext = await crypto.subtle.decrypt(
    {
      additionalData: ownedBuffer(aad),
      iv: ownedBuffer(decodeBase64Url(envelope.nonce)),
      name: "AES-GCM",
      tagLength: 128,
    },
    key,
    ownedBuffer(decodeBase64Url(envelope.ciphertext)),
  );
  return new Uint8Array(plaintext);
}

export async function wrapAccountDataKey(
  accountDataKey: Uint8Array,
  recipientPublicKeyJson: string,
  authority: AccountKeyWrapAuthority,
): Promise<WrappedKeyEnvelope> {
  if (accountDataKey.byteLength !== 32) throw new Error("Invalid account data key.");
  const recipientPublicKey = await importP256PublicKey(recipientPublicKeyJson, "wrapping");
  const ephemeral = await generateDeviceWrappingKeyPair();
  const aad = accountWrapAad(authority);
  const wrappingKey = await deriveWrappingKey(ephemeral.privateKey, recipientPublicKey, aad);
  const nonce = randomNonce();
  const ciphertext = await crypto.subtle.encrypt(
    {
      additionalData: ownedBuffer(aad),
      iv: ownedBuffer(nonce),
      name: "AES-GCM",
      tagLength: 128,
    },
    wrappingKey,
    ownedBuffer(accountDataKey),
  );
  return {
    algorithm: "P256-HKDF-SHA256+A256GCM",
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    ephemeralPublicKey: await exportDevicePublicKey(ephemeral.publicKey),
    keyVersion: authority.accountKeyVersion,
    nonce: encodeBase64Url(nonce),
  };
}

export async function unwrapAccountDataKey(
  envelope: WrappedKeyEnvelope,
  recipientPrivateKey: CryptoKey,
  authority: AccountKeyWrapAuthority,
): Promise<Uint8Array> {
  if (envelope.keyVersion !== authority.accountKeyVersion) {
    throw new Error("Account-key envelope version mismatch.");
  }
  const ephemeralPublicKey = await importP256PublicKey(
    envelope.ephemeralPublicKey,
    "wrapping",
  );
  const aad = accountWrapAad(authority);
  const wrappingKey = await deriveWrappingKey(
    recipientPrivateKey,
    ephemeralPublicKey,
    aad,
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      additionalData: ownedBuffer(aad),
      iv: ownedBuffer(decodeBase64Url(envelope.nonce)),
      name: "AES-GCM",
      tagLength: 128,
    },
    wrappingKey,
    ownedBuffer(decodeBase64Url(envelope.ciphertext)),
  );
  const key = new Uint8Array(plaintext);
  if (key.byteLength !== 32) throw new Error("Invalid unwrapped account data key.");
  return key;
}

export function deviceBindMessage(authority: DeviceBindAuthority): Uint8Array {
  if (
    authority.challengeId.length < 8
    || authority.challengeId.length > 96
    || authority.devicePublicId.length < 8
    || authority.devicePublicId.length > 96
    || !isBase64Url(authority.nonce, 32, 64)
  ) throw new Error("Invalid device bind authority.");
  return encoder.encode([
    "hra-control-plane-device-bind:v1",
    authority.challengeId,
    authority.devicePublicId,
    authority.nonce,
  ].join("\n"));
}

export async function signDeviceBind(
  privateKey: CryptoKey,
  authority: DeviceBindAuthority,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { hash: "SHA-256", name: "ECDSA" },
    privateKey,
    ownedBuffer(deviceBindMessage(authority)),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyDeviceBind(
  publicKeyJson: string,
  authority: DeviceBindAuthority,
  signature: string,
): Promise<boolean> {
  if (!isBase64Url(signature, 80, 128)) return false;
  const publicKey = await importP256PublicKey(publicKeyJson, "signing");
  return await crypto.subtle.verify(
    { hash: "SHA-256", name: "ECDSA" },
    publicKey,
    ownedBuffer(decodeBase64Url(signature)),
    ownedBuffer(deviceBindMessage(authority)),
  );
}
