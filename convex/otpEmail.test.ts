import { describe, expect, spyOn, test } from "bun:test";

import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import { authOtpLifetimeMs } from "./authPolicy";
import {
  buildHraOtpEmailPayload,
  sendOtpEmail,
} from "./otpEmail";
import {
  defaultHraOtpReplyTo,
  hraOtpEmailFrom,
  hraOtpReplyToEnvironmentName,
  isHraOtpReplyTo,
  resolveHraOtpReplyTo,
} from "./otpEmailConfig";
import {
  hraAttentionResendApiKeyEnvironmentName,
  hraResendApiKeyEnvironmentName,
  requireHraResendApiKey,
} from "./resendApiKey";

const email = "reader@example.com" as CanonicalAuthEmail;
const now = 1_787_968_800_000;

describe("HRA OTP email delivery", () => {
  test("keeps the authentication accessor independent of attention readiness", () => {
    const authKey = "re_auth_fixture";
    for (const attentionKey of [undefined, "invalid", authKey, "re_attention_fixture"]) {
      expect(requireHraResendApiKey({
        [hraResendApiKeyEnvironmentName]: authKey,
        [hraAttentionResendApiKeyEnvironmentName]: attentionKey,
      })).toBe(authKey);
    }
    // Preserve the existing OTP validation boundary rather than tightening it
    // indirectly when the separate attention credential contract changes.
    expect(requireHraResendApiKey({
      [hraResendApiKeyEnvironmentName]: "re_legacy.key",
    })).toBe("re_legacy.key");
    expect(() => requireHraResendApiKey({
      [hraAttentionResendApiKeyEnvironmentName]: "re_attention_fixture",
    })).toThrow("Email delivery is unavailable.");
  });

  test("sends authentication mail with only the auth key even when attention is unavailable", async () => {
    const names = [
      hraResendApiKeyEnvironmentName,
      hraAttentionResendApiKeyEnvironmentName,
      hraOtpReplyToEnvironmentName,
    ] as const;
    const previous = names.map((name) => [name, process.env[name]] as const);
    const authKey = "re_auth_test";
    const authorizations: (string | null)[] = [];
    const provider = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      async (...[, init]: Parameters<typeof fetch>): Promise<Response> => {
        authorizations.push(new Headers(init?.headers).get("Authorization"));
        return new Response(null, { status: 200 });
      },
      { preconnect: () => undefined },
    ));
    try {
      process.env[hraResendApiKeyEnvironmentName] = authKey;
      Reflect.deleteProperty(process.env, hraOtpReplyToEnvironmentName);
      for (const attentionKey of [undefined, "invalid", authKey, "re_attention_fixture"]) {
        if (attentionKey === undefined) {
          Reflect.deleteProperty(process.env, hraAttentionResendApiKeyEnvironmentName);
        } else process.env[hraAttentionResendApiKeyEnvironmentName] = attentionKey;
        await sendOtpEmail({
          email,
          expiresAt: Date.now() + authOtpLifetimeMs,
          token: "12345678",
        });
      }
      expect(authorizations).toEqual(Array.from({ length: 4 }, () => `Bearer ${authKey}`));
      Reflect.deleteProperty(process.env, hraResendApiKeyEnvironmentName);
      await expect(sendOtpEmail({
        email,
        expiresAt: Date.now() + authOtpLifetimeMs,
        token: "12345678",
      })).rejects.toThrow("Email delivery is unavailable.");
      expect(provider).toHaveBeenCalledTimes(4);
    } finally {
      provider.mockRestore();
      for (const [name, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });

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
      "o'hare@example.com",
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
