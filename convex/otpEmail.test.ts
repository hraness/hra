import { describe, expect, test } from "bun:test";

import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import { authOtpLifetimeMs } from "./authPolicy";
import {
  buildHraOtpEmailPayload,
} from "./otpEmail";
import {
  defaultHraOtpReplyTo,
  hraOtpEmailFrom,
  hraOtpReplyToEnvironmentName,
  isHraOtpReplyTo,
  resolveHraOtpReplyTo,
} from "./otpEmailConfig";

const email = "reader@example.com" as CanonicalAuthEmail;
const now = 1_787_968_800_000;

describe("HRA OTP email delivery", () => {
  test("pins the auth-subdomain sender and uses the receive-capable fallback", () => {
    expect(buildHraOtpEmailPayload({
      email,
      expiresAt: now + authOtpLifetimeMs,
      token: "12345678",
    }, {
      environment: {
        HRA_AUTH_EMAIL_FROM: "Attacker <attacker@example.com>",
      },
      now,
    })).toEqual({
      from: hraOtpEmailFrom,
      reply_to: defaultHraOtpReplyTo,
      subject: "Your HRA sign-in code",
      text: [
        "Your HRA sign-in code is 12345678.",
        "",
        "It expires in 10 minutes. If you did not request it, you can ignore this email.",
      ].join("\n"),
      to: [email],
    });
    expect(hraOtpEmailFrom).toBe("HRA sign-in <hra@auth.hraness.com>");
  });

  test("accepts one canonical configured reply mailbox and rejects unsafe values", () => {
    expect(resolveHraOtpReplyTo({
      [hraOtpReplyToEnvironmentName]: "support@example.com",
    })).toBe("support@example.com" as CanonicalAuthEmail);

    for (const value of [
      "Support <support@example.com>",
      "support@localhost",
      "support@auth.hraness.com",
      "support@news.hraness.com",
      "support@example.com\r\nBcc: attacker@example.com",
    ]) {
      expect(isHraOtpReplyTo(value)).toBe(false);
      expect(() => resolveHraOtpReplyTo({
        [hraOtpReplyToEnvironmentName]: value,
      })).toThrow("Email delivery is unavailable.");
    }
  });

  test("fails closed when the OTP request itself is malformed", () => {
    expect(() => buildHraOtpEmailPayload({
      email,
      expiresAt: now + authOtpLifetimeMs,
      token: "1234567",
    }, { environment: {}, now })).toThrow("Email delivery is unavailable.");
    expect(() => buildHraOtpEmailPayload({
      email,
      expiresAt: now,
      token: "12345678",
    }, { environment: {}, now })).toThrow("Email delivery is unavailable.");
  });
});
