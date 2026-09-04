import { describe, expect, test } from "bun:test";

import {
  canonicalDevicePublicKeyJson,
  exportDevicePublicKey,
  generateDeviceSigningKeyPair,
  generateDeviceWrappingKeyPair,
  parseDevicePublicKeyJson,
  sha256Hex,
} from "../hra/cloud";
import {
  deviceKeyFingerprint,
  fingerprintGroupCount,
  fingerprintGroupSize,
  groupFingerprintDigest,
} from "./fingerprint";

async function keyPairPublicKeys(): Promise<Readonly<{ signing: string; wrapping: string }>> {
  const [signing, wrapping] = await Promise.all([
    generateDeviceSigningKeyPair(false),
    generateDeviceWrappingKeyPair(false),
  ]);
  return {
    signing: await exportDevicePublicKey(signing.publicKey),
    wrapping: await exportDevicePublicKey(wrapping.publicKey),
  };
}

describe("deviceKeyFingerprint", () => {
  test("is the first 32 hex characters of the digest in eight groups of four", async () => {
    const keys = await keyPairPublicKeys();
    const fingerprint = await deviceKeyFingerprint(keys.signing, keys.wrapping);
    const groups = fingerprint.split("-");
    expect(groups).toHaveLength(fingerprintGroupCount);
    for (const group of groups) {
      expect(group).toMatch(/^[0-9a-f]{4}$/u);
      expect(group.length).toBe(fingerprintGroupSize);
    }
  });

  test("matches the digest computed independently from the definition", async () => {
    const keys = await keyPairPublicKeys();
    const digest = await sha256Hex(`${keys.signing}\n${keys.wrapping}`);
    const expected = [
      digest.slice(0, 4),
      digest.slice(4, 8),
      digest.slice(8, 12),
      digest.slice(12, 16),
      digest.slice(16, 20),
      digest.slice(20, 24),
      digest.slice(24, 28),
      digest.slice(28, 32),
    ].join("-");
    expect(await deviceKeyFingerprint(keys.signing, keys.wrapping)).toBe(expected);
  });

  test("is insensitive to key member order in the encoding", async () => {
    const keys = await keyPairPublicKeys();
    const parsed = parseDevicePublicKeyJson(keys.signing);
    if (parsed === null) throw new Error("test fixture is invalid");
    const reordered = JSON.stringify({
      y: parsed.y,
      x: parsed.x,
      kty: parsed.kty,
      crv: parsed.crv,
    });
    expect(canonicalDevicePublicKeyJson(parsed)).toBe(keys.signing);
    expect(await deviceKeyFingerprint(reordered, keys.wrapping))
      .toBe(await deviceKeyFingerprint(keys.signing, keys.wrapping));
  });

  test("binds both keys: swapping them changes the fingerprint", async () => {
    const keys = await keyPairPublicKeys();
    expect(await deviceKeyFingerprint(keys.wrapping, keys.signing))
      .not.toBe(await deviceKeyFingerprint(keys.signing, keys.wrapping));
  });

  test("refuses a key that is not a P-256 public JWK", async () => {
    const keys = await keyPairPublicKeys();
    await expect(deviceKeyFingerprint("{}", keys.wrapping)).rejects.toThrow();
  });

  test("refuses a digest that is not hexadecimal", () => {
    expect(() => groupFingerprintDigest("zzzz")).toThrow();
  });
});
