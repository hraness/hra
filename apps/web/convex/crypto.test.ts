import { describe, expect, test } from "bun:test";

import {
  decodeBase64Url32,
  digestArrayBuffer,
  hmacSha256Base64Url,
  hmacSha256Utf8KeyBase64Url,
  verifyHmacSha256,
} from "./crypto";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // gitleaks:allow - deterministic test vector
const MESSAGE = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const EXPECTED_HMAC = "YiFd573c6n4sQEf_a7lPjRgmL8iz82SBNLt9RBWP-E0";

describe("canonical 32-byte bearer HMAC", () => {
  test("matches the fixed SHA-256 vector", async () => {
    const message = decodeBase64Url32(MESSAGE);
    expect(message).not.toBeNull();
    if (message === null) throw new Error("Fixed message vector must decode.");
    expect(await hmacSha256Base64Url(KEY, message)).toBe(EXPECTED_HMAC);
  });

  test("rejects non-canonical base64url encodings", () => {
    expect(decodeBase64Url32(`${KEY}=`)).toBeNull();
    expect(decodeBase64Url32(KEY.slice(0, -1))).toBeNull();
    expect(decodeBase64Url32(`${KEY.slice(0, -1)}!`)).toBeNull();
  });

  test("verifies stored digest bytes and rejects the equal-cost dummy digest", async () => {
    const message = decodeBase64Url32(MESSAGE);
    const expected = digestArrayBuffer(EXPECTED_HMAC);
    if (message === null || expected === null) throw new Error("Fixed verification vector must decode.");
    expect(await verifyHmacSha256(KEY, message, expected)).toBeTrue();
    expect(await verifyHmacSha256(KEY, message, new Uint8Array(32).buffer)).toBeFalse();
  });
});

test("UTF-8 HMAC matches the domain-keyed refresh fingerprint vector", async () => {
  expect(
    await hmacSha256Utf8KeyBase64Url(
      "key",
      "The quick brown fox jumps over the lazy dog",
    ),
  ).toBe("97yD9DBThCSxMpjmqm-xQ-9NWaFJRhdZl0edvC0aPNg");
});
