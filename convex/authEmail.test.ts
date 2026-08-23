import { afterEach, describe, expect, test } from "bun:test";

import { parseAuthCredentials } from "../src/cloud/authCredentials";
import { digestAuthEmail, digestAuthOtp } from "./authEmail";

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
