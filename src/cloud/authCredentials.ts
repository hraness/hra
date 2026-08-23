import { hasExactKeys, isRecord } from "./contracts";

declare const canonicalAuthEmailBrand: unique symbol;
declare const authVerificationCodeBrand: unique symbol;
declare const identityInviteCapabilityBrand: unique symbol;

export type CanonicalAuthEmail = string & {
  readonly [canonicalAuthEmailBrand]: "CanonicalAuthEmail";
};

export type AuthVerificationCode = string & {
  readonly [authVerificationCodeBrand]: "AuthVerificationCode";
};

export type IdentityInviteCapability = string & {
  readonly [identityInviteCapabilityBrand]: "IdentityInviteCapability";
};

export type AuthCredentials =
  | Readonly<{
      email: CanonicalAuthEmail;
      invite?: IdentityInviteCapability;
      kind: "request_code";
    }>
  | Readonly<{
      code: AuthVerificationCode;
      email: CanonicalAuthEmail;
      kind: "verify_code";
    }>;

export type AuthCredentialsParseResult =
  | AuthCredentials
  | Readonly<{ kind: "rejected" }>;

export const maximumAuthEmailLength = 254;
export const authVerificationCodeLength = 8;
export const identityInviteCapabilityPrefix = "hra_invite_identity_v1_";
export const identityInviteSecretLength = 43;

const localPartPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;
const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const verificationCodePattern = /^[0-9]{8}$/u;
const identityInviteCapabilityPattern = new RegExp(
  `^${identityInviteCapabilityPrefix}[A-Za-z0-9_-]{${identityInviteSecretLength}}$`,
  "u",
);
const rejected = Object.freeze({ kind: "rejected" } as const);

export function isCanonicalAuthEmail(value: unknown): value is CanonicalAuthEmail {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > maximumAuthEmailLength
    || value !== value.trim()
    || value !== value.toLowerCase()
  ) return false;

  const separator = value.indexOf("@");
  if (separator <= 0 || separator !== value.lastIndexOf("@")) return false;

  const localPart = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (
    localPart.length > 64
    || !localPartPattern.test(localPart)
    || localPart.startsWith(".")
    || localPart.endsWith(".")
    || localPart.includes("..")
    || domain.length === 0
    || domain.length > 253
  ) return false;

  return domain.split(".").every((label) => domainLabelPattern.test(label));
}

export function isIdentityInviteCapability(
  value: unknown,
): value is IdentityInviteCapability {
  return typeof value === "string" && identityInviteCapabilityPattern.test(value);
}

function readOwnDataProperty(
  input: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<{ found: boolean; value?: unknown }> {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) return { found: false };
    if (!("value" in descriptor) || descriptor.enumerable !== true) return { found: false };
    return { found: true, value: descriptor.value };
  } catch {
    return { found: false };
  }
}

export function parseAuthCredentials(input: unknown): AuthCredentialsParseResult {
  if (!isRecord(input)) return rejected;
  if (
    !hasExactKeys(input, ["email"])
    && !hasExactKeys(input, ["email", "invite"])
    && !hasExactKeys(input, ["email", "code"])
  ) return rejected;

  const email = readOwnDataProperty(input, "email");
  if (!email.found || !isCanonicalAuthEmail(email.value)) return rejected;

  if (hasExactKeys(input, ["email"])) {
    return { email: email.value, kind: "request_code" };
  }
  if (hasExactKeys(input, ["email", "invite"])) {
    const invite = readOwnDataProperty(input, "invite");
    if (!invite.found || !isIdentityInviteCapability(invite.value)) return rejected;
    return { email: email.value, invite: invite.value, kind: "request_code" };
  }
  const code = readOwnDataProperty(input, "code");
  if (
    !code.found
    || typeof code.value !== "string"
    || !verificationCodePattern.test(code.value)
  ) return rejected;

  return {
    code: code.value as AuthVerificationCode,
    email: email.value,
    kind: "verify_code",
  };
}

export type OtpEntropySource = () => Uint8Array;

export function generateEightDigitOtpFromEntropy(source: OtpEntropySource): string {
  let code = "";
  while (code.length < authVerificationCodeLength) {
    const bytes = source();
    if (bytes.length === 0) throw new Error("OTP entropy source returned no bytes.");
    for (const byte of bytes) {
      if (byte < 250) code += String(byte % 10);
      if (code.length === authVerificationCodeLength) break;
    }
  }
  return code;
}

export function generateEightDigitOtp(): string {
  return generateEightDigitOtpFromEntropy(
    () => crypto.getRandomValues(new Uint8Array(16)),
  );
}
