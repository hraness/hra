import {
  isCanonicalAuthEmail,
  type CanonicalAuthEmail,
} from "../src/cloud/authCredentials";

export const hraOtpEmailFrom = "HRA sign-in <hra@auth.hraness.com>" as const;
export const hraOtpReplyToEnvironmentName = "HRA_AUTH_EMAIL_REPLY_TO" as const;
export const defaultHraOtpReplyTo = "ben@substrate.run" as CanonicalAuthEmail;

const knownSendingOnlyDomains = new Set([
  "auth.hraness.com",
  "news.hraness.com",
]);

export function isHraOtpReplyTo(value: unknown): boolean {
  if (!isCanonicalAuthEmail(value) || value.includes("'")) return false;
  const separator = value.lastIndexOf("@");
  const domain = value.slice(separator + 1);
  return domain.includes(".") && !knownSendingOnlyDomains.has(domain);
}

export function resolveHraOtpReplyTo(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CanonicalAuthEmail {
  const value = environment[hraOtpReplyToEnvironmentName] ?? defaultHraOtpReplyTo;
  if (!isHraOtpReplyTo(value)) throw new Error("Email delivery is unavailable.");
  return value as CanonicalAuthEmail;
}
