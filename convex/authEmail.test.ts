import { afterEach, describe, expect, test } from "bun:test";

import { parseAuthCredentials } from "../src/cloud/authCredentials";
import { digestAuthEmail, digestAuthOtp, timingSafeEqualAuthDigest } from "./authEmail";

afterEach(() => {
  delete process.env.HRA_AUTH_HMAC_SECRET;
});

describe("purpose-separated auth digests", () => {
  test("stores neither canonical email nor low-entropy code", async () => {
    process.env.HRA_AUTH_HMAC_SECRET = ["test", "secret", "at", "least", "thirty", "two", "characters"].join("-");
    const parsed = parseAuthCredentials({ email: "reader@example.com", code: "01234567" });
    if (parsed.kind !== "verify_code") throw new Error("invalid auth fixture");
    const emailDigest = await digestAuthEmail(parsed.email);
    const otpDigest = await digestAuthOtp(parsed.email, parsed.code);
    expect(emailDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(otpDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(otpDigest).not.toBe(emailDigest);
    expect(`${emailDigest}${otpDigest}`).not.toContain(parsed.email);
    expect(`${emailDigest}${otpDigest}`).not.toContain(parsed.code);
  });

  test("fails closed without the server HMAC secret", async () => {
    const parsed = parseAuthCredentials({ email: "reader@example.com" });
    if (parsed.kind !== "request_code") throw new Error("invalid auth fixture");
    let rejected = false;
    try {
      await digestAuthEmail(parsed.email);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

describe("constant-time OTP digest comparison", () => {
  const digest = "0123456789abcdef".repeat(4);

  test("accepts only the exact stored digest", () => {
    expect(timingSafeEqualAuthDigest(digest, digest)).toBe(true);
    expect(timingSafeEqualAuthDigest(digest, `${digest.slice(0, 63)}0`)).toBe(false);
    expect(timingSafeEqualAuthDigest(digest, `f${digest.slice(1)}`)).toBe(false);
  });

  test("rejects malformed candidates without comparing bytes", () => {
    expect(timingSafeEqualAuthDigest(digest, digest.slice(0, 63))).toBe(false);
    expect(timingSafeEqualAuthDigest(digest, `${digest}0`)).toBe(false);
    expect(timingSafeEqualAuthDigest(digest, digest.toUpperCase())).toBe(false);
    expect(timingSafeEqualAuthDigest("", "")).toBe(false);
    expect(timingSafeEqualAuthDigest(digest.toUpperCase(), digest.toUpperCase())).toBe(false);
  });

  test("agrees with strict equality for every well-formed pair", async () => {
    process.env.HRA_AUTH_HMAC_SECRET = ["test", "secret", "at", "least", "thirty", "two", "characters"].join("-");
    const parsed = parseAuthCredentials({ email: "reader@example.com", code: "01234567" });
    if (parsed.kind !== "verify_code") throw new Error("invalid auth fixture");
    const stored = await digestAuthOtp(parsed.email, parsed.code);
    const other = await digestAuthOtp(parsed.email, "76543210");
    expect(stored).not.toBe(other);
    expect(timingSafeEqualAuthDigest(stored, stored)).toBe(true);
    expect(timingSafeEqualAuthDigest(stored, other)).toBe(false);
    expect(timingSafeEqualAuthDigest(other, stored)).toBe(false);
  });
});
