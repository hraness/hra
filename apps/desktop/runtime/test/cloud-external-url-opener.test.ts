import { describe, expect, test } from "bun:test";

import {
  safeWorkOsVerificationUrl,
} from "../src/cloud/external-url-opener";

describe("WorkOS external verification URL", () => {
  test("accepts credential-free HTTPS across provider origins", () => {
    expect(
      safeWorkOsVerificationUrl("https://authkit.example.com/device?code=ABCD"),
    ).toBe("https://authkit.example.com/device?code=ABCD");
  });

  test.each([
    "http://authkit.example.com/device",
    "file:///tmp/device",
    "https://user:password@authkit.example.com/device",
    "not a URL",
  ])("rejects unsafe verification URL %s", (value) => {
    expect(() => safeWorkOsVerificationUrl(value)).toThrow();
  });
});
