import {
  isCanonicalAuthEmail,
  type CanonicalAuthEmail,
} from "../src/cloud/authCredentials";
import { readAliasedEnvironment } from "./environmentAliases";

export const oompaOtpEmailFrom = "Oompa sign-in <oompa@auth.hraness.com>" as const;
export const oompaOtpReplyToEnvironmentName = "OOMPA_AUTH_EMAIL_REPLY_TO" as const;
export const defaultOompaOtpReplyTo = "ben@substrate.run" as CanonicalAuthEmail;

const knownSendingOnlyDomains = new Set([
  "auth.hraness.com",
  "news.hraness.com",
]);

export function isOompaOtpReplyTo(value: unknown): boolean {
  if (!isCanonicalAuthEmail(value) || value.includes("'")) return false;
  const separator = value.lastIndexOf("@");
  const domain = value.slice(separator + 1);
  return domain.includes(".") && !knownSendingOnlyDomains.has(domain);
}

export function resolveOompaOtpReplyTo(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CanonicalAuthEmail {
  const value = readAliasedEnvironment(environment, oompaOtpReplyToEnvironmentName) ?? defaultOompaOtpReplyTo;
  if (!isOompaOtpReplyTo(value)) throw new Error("Email delivery is unavailable.");
  return value as CanonicalAuthEmail;
}
