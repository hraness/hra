import {
  isCanonicalAuthEmail,
  type CanonicalAuthEmail,
} from "../src/cloud/authCredentials";

const minimumHmacSecretLength = 32;

function requireHmacSecret(): string {
  const secret = process.env.HRA_AUTH_HMAC_SECRET;
  if (secret === undefined || secret.length < minimumHmacSecretLength) {
    throw new Error("Authentication is not configured.");
  }
  return secret;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function digest(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(requireHmacSecret()),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function digestAuthEmail(email: CanonicalAuthEmail): Promise<string> {
  if (!isCanonicalAuthEmail(email)) throw new Error("Authentication could not be completed.");
  return await digest(`hra-control-plane-auth-email:v1:${email}`);
}

export async function digestAuthOtp(
  email: CanonicalAuthEmail,
  code: string,
): Promise<string> {
  if (!isCanonicalAuthEmail(email) || !/^[0-9]{8}$/u.test(code)) {
    throw new Error("Authentication could not be completed.");
  }
  return await digest(`hra-control-plane-auth-otp:v1:${email}:${code}`);
}
