import {
  identityInviteCapabilityPrefix,
  identityInviteSecretLength,
  isIdentityInviteCapability,
} from "./authCredentials";

export type InvitePurpose = "device" | "identity";

export const invitePublicIdPrefix = "invite_";
export const deviceInviteCapabilityPrefix = "hra_invite_device_v1_";
export const identityInviteLifetimeMs = 24 * 60 * 60 * 1_000;

const invitePublicIdPattern = /^invite_[A-Za-z0-9_-]{32}$/u;
const deviceInviteCapabilityPattern =
  /^hra_invite_device_v1_[A-Za-z0-9_-]{43}$/u;
const authDigestPattern = /^[a-f0-9]{64}$/u;
const base64UrlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      encoded += base64UrlAlphabet.charAt((buffer >>> bits) & 63);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += base64UrlAlphabet.charAt((buffer << (6 - bits)) & 63);
  return encoded;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isInvitePublicId(value: unknown): value is string {
  return typeof value === "string" && invitePublicIdPattern.test(value);
}

export function isInviteCapability(
  value: unknown,
  purpose: InvitePurpose,
): value is string {
  return purpose === "identity"
    ? isIdentityInviteCapability(value)
    : typeof value === "string" && deviceInviteCapabilityPattern.test(value);
}

export async function digestInviteCapability(
  capability: string,
  purpose: InvitePurpose,
): Promise<string> {
  if (!isInviteCapability(capability, purpose)) {
    throw new Error("invalid invite capability");
  }
  const bytes = new TextEncoder().encode(
    `hra-control-plane-invite-capability:v1:${purpose}:${capability}`,
  );
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

export function invitePublicIdFromCapabilityDigest(
  capabilityDigest: string,
): string {
  if (!authDigestPattern.test(capabilityDigest)) {
    throw new Error("invalid invite capability digest");
  }
  const publicIdBytes = new Uint8Array(24);
  for (let index = 0; index < publicIdBytes.length; index += 1) {
    publicIdBytes[index] = Number.parseInt(
      capabilityDigest.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  const encoded = encodeBase64Url(publicIdBytes);
  if (encoded.length !== 32) throw new Error("invalid invite public identity");
  return `${invitePublicIdPrefix}${encoded}`;
}

export async function generateInviteAuthority(
  purpose: InvitePurpose,
): Promise<Readonly<{
  capability: string;
  capabilityDigest: string;
  publicId: string;
}>> {
  const capabilitySecret = encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  if (capabilitySecret.length !== identityInviteSecretLength) {
    throw new Error("invalid invite entropy");
  }
  const capability = `${purpose === "identity"
    ? identityInviteCapabilityPrefix
    : deviceInviteCapabilityPrefix}${capabilitySecret}`;
  const capabilityDigest = await digestInviteCapability(capability, purpose);
  return {
    capability,
    capabilityDigest,
    publicId: invitePublicIdFromCapabilityDigest(capabilityDigest),
  };
}
