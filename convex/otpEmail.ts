import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import { isCanonicalAuthEmail } from "../src/cloud/authCredentials";
import { sha256Hex } from "../src/cloud/crypto";
import { authOtpLifetimeMs } from "./authPolicy";
import {
  oompaOtpEmailFrom,
  resolveOompaOtpReplyTo,
} from "./otpEmailConfig";
import { requireOompaResendApiKey } from "./resendApiKey";

const resendEndpoint = "https://api.resend.com/emails";
const deliveryTimeoutMs = 8_000;

export type OompaOtpEmailPayload = Readonly<{
  from: typeof oompaOtpEmailFrom;
  reply_to: CanonicalAuthEmail;
  subject: "Your Oompa sign-in code";
  text: string;
  to: readonly [CanonicalAuthEmail];
}>;

export function buildOompaOtpEmailPayload(
  input: Readonly<{
    email: CanonicalAuthEmail;
    expiresAt: number;
    token: string;
  }>,
  options: Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    now?: number;
  }> = {},
): OompaOtpEmailPayload {
  const now = options.now ?? Date.now();
  if (
    !isCanonicalAuthEmail(input.email)
    || !/^[0-9]{8}$/u.test(input.token)
    || !Number.isFinite(input.expiresAt)
    || input.expiresAt <= now
    || input.expiresAt > now + authOtpLifetimeMs
  ) throw new Error("Email delivery is unavailable.");

  return {
    from: oompaOtpEmailFrom,
    reply_to: resolveOompaOtpReplyTo(options.environment),
    subject: "Your Oompa sign-in code",
    text: [
      `Your Oompa sign-in code is ${input.token}.`,
      "",
      "It expires in 10 minutes. If you did not request it, you can ignore this email.",
    ].join("\n"),
    to: [input.email],
  };
}

export async function sendOtpEmail(input: Readonly<{
  email: CanonicalAuthEmail;
  expiresAt: number;
  token: string;
}>): Promise<void> {
  const body = buildOompaOtpEmailPayload(input);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMs);
  try {
    const response = await fetch(resendEndpoint, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${requireOompaResendApiKey()}`,
        "Content-Type": "application/json",
        "Idempotency-Key": await sha256Hex(
          `hra-control-plane-resend-otp:v1:${input.email}:${input.token}:${String(input.expiresAt)}`,
        ),
      },
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error("Email delivery is unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}
