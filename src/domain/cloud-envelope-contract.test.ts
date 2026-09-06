import { describe, expect, test } from "bun:test";

import { cloudEnvelopeLimits, jsonValueFitsCloudEnvelope } from "./cloud-envelope-contract";

describe("cloud envelope contract", () => {
  test("derives the exact JSON plaintext boundary from AES-GCM base64url", () => {
    const atLimit = "x".repeat(cloudEnvelopeLimits.plaintextBytes - 2);
    expect(jsonValueFitsCloudEnvelope(atLimit)).toBe(true);
    expect(jsonValueFitsCloudEnvelope(`${atLimit}x`)).toBe(false);
    const encryptedBytes = cloudEnvelopeLimits.plaintextBytes + 16;
    expect(Math.floor((4 * encryptedBytes + 2) / 3))
      .toBe(cloudEnvelopeLimits.ciphertextCharacters);
  });
});
