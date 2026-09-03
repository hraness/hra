import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import { isCanonicalAuthEmail } from "../src/cloud/authCredentials";
import { sha256Hex } from "../src/cloud/crypto";
import { authOtpLifetimeMs } from "./authPolicy";
import {
  hraOtpEmailFrom,
  resolveHraOtpReplyTo,
} from "./otpEmailConfig";

const resendEndpoint = "https://api.resend.com/emails";
const deliveryTimeoutMs = 8_000;

function requireResendApiKey(): string {
  const value = process.env.HRA_RESEND_API_KEY;
  if (
    value === undefined
    || !value.startsWith("re_")
    || value.length < 8
    || value.length > 512
    || /\s/u.test(value)
  ) throw new Error("Email delivery is unavailable.");
  return value;
}

export type HraOtpEmailPayload = Readonly<{
  from: typeof hraOtpEmailFrom;
  reply_to: CanonicalAuthEmail;
  subject: "Your HRA sign-in code";
  text: string;
  to: readonly [CanonicalAuthEmail];
}>;

export function buildHraOtpEmailPayload(
  input: Readonly<{
    email: CanonicalAuthEmail;
    expiresAt: number;
    token: string;
  }>,
  options: Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    now?: number;
  }> = {},
): HraOtpEmailPayload {
  const now = options.now ?? Date.now();
  if (
    !isCanonicalAuthEmail(input.email)
    || !/^[0-9]{8}$/u.test(input.token)
    || !Number.isFinite(input.expiresAt)
    || input.expiresAt <= now
    || input.expiresAt > now + authOtpLifetimeMs
  ) throw new Error("Email delivery is unavailable.");

  return {
    from: hraOtpEmailFrom,
    reply_to: resolveHraOtpReplyTo(options.environment),
    subject: "Your HRA sign-in code",
    text: [
      `Your HRA sign-in code is ${input.token}.`,
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
  const body = buildHraOtpEmailPayload(input);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMs);
  try {
    const response = await fetch(resendEndpoint, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${requireResendApiKey()}`,
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
