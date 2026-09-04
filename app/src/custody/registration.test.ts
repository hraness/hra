import { describe, expect, test } from "bun:test";

import {
  decodeBase64Url,
  encodeBase64Url,
  hmacSha256Hex,
  randomKeyBytes,
  type EncryptedEnvelope,
  type WrappedKeyEnvelope,
} from "../hra/cloud";
import type { KeyEnvelopeEntry } from "../data/wire";
import {
  browserDeviceLabel,
  commandEnqueueDigestPurpose,
  deviceLabelAad,
  deviceRegisterDigestPurpose,
  encryptDeviceLabel,
  enqueueRequest,
  enqueueRequestDigest,
  isDeviceClassValidatorRejection,
  randomBindNonce,
  randomOpaqueId,
  registrationIntent,
  registrationRequestDigest,
  selectKeyEnvelope,
} from "./registration";

const userPublicId = "user_0123456789abcdef";
const devicePublicId = "device_0123456789abcdef";
const keyVersion = 1;

const envelope: EncryptedEnvelope = {
  algorithm: "A256GCM",
  ciphertext: encodeBase64Url(new Uint8Array(48).fill(7)),
  keyVersion,
  nonce: encodeBase64Url(new Uint8Array(12).fill(3)),
};

function wrapped(version: number): WrappedKeyEnvelope {
  return {
    algorithm: "P256-HKDF-SHA256+A256GCM",
    ciphertext: encodeBase64Url(new Uint8Array(48).fill(1)),
    ephemeralPublicKey: JSON.stringify({
      crv: "P-256",
      kty: "EC",
      x: "A".repeat(43),
      y: "B".repeat(43),
    }),
    keyVersion: version,
    nonce: encodeBase64Url(new Uint8Array(12).fill(2)),
  };
}

describe("device label authority", () => {
  test("is the daemon's device-label additional authenticated data", () => {
    const expected = new TextEncoder().encode([
      "hra-control-plane-device-label:v1",
      userPublicId,
      devicePublicId,
      "1",
    ].join("\n"));
    expect(deviceLabelAad(userPublicId, devicePublicId, keyVersion)).toEqual(expected);
  });

  test("refuses an identifier that is not opaque", () => {
    expect(() => deviceLabelAad("no", devicePublicId, keyVersion)).toThrow();
    expect(() => deviceLabelAad(userPublicId, devicePublicId, 0)).toThrow();
  });

  test("encrypts the label under the provisional key and its own authority", async () => {
    const provisionalKey = randomKeyBytes();
    const sealed = await encryptDeviceLabel({
      devicePublicId,
      keyVersion,
      label: "Browser on macOS",
      provisionalKey,
      userPublicId,
    });
    expect(sealed.algorithm).toBe("A256GCM");
    expect(sealed.keyVersion).toBe(keyVersion);
    expect(sealed.ciphertext.length).toBeGreaterThan(0);
  });
});

describe("browserDeviceLabel", () => {
  test("names the platform", () => {
    expect(browserDeviceLabel("MacIntel")).toBe("Browser on MacIntel");
  });

  test("falls back when the platform is unknown", () => {
    expect(browserDeviceLabel(null)).toBe("Browser");
    expect(browserDeviceLabel("   ")).toBe("Browser");
  });

  test("strips characters that could carry a path or an escape", () => {
    expect(browserDeviceLabel("Linux /home/somebody [31m x86_64"))
      .toBe("Browser on Linux home somebody 31m x86_64");
  });

  test("is bounded", () => {
    expect(browserDeviceLabel("x".repeat(500)).length).toBeLessThanOrEqual("Browser on ".length + 40);
  });
});

describe("registration digest", () => {
  const intent = registrationIntent({
    encryptedLabel: envelope,
    idempotencyKey: "01931f2a-7c00-7000-8000-000000000001",
    keyVersion,
    publicId: devicePublicId,
    signingPublicKey: "signing",
    wrappingPublicKey: "wrapping",
  });

  test("serializes in the daemon's key order", () => {
    expect(Object.keys(intent)).toEqual([
      "encryptedLabel",
      "idempotencyKey",
      "keyVersion",
      "publicId",
      "signingPublicKey",
      "wrappingPublicKey",
    ]);
  });

  test("is the keyed digest over exactly that serialization", async () => {
    const key = randomKeyBytes();
    const expected = await hmacSha256Hex(
      key,
      deviceRegisterDigestPurpose,
      JSON.stringify(intent),
    );
    expect(await registrationRequestDigest(key, intent)).toBe(expected);
  });

  test("is stable across an equivalent object with different member order", async () => {
    const key = randomKeyBytes();
    const reordered = registrationIntent({
      wrappingPublicKey: "wrapping",
      signingPublicKey: "signing",
      publicId: devicePublicId,
      keyVersion,
      idempotencyKey: "01931f2a-7c00-7000-8000-000000000001",
      encryptedLabel: envelope,
    });
    expect(await registrationRequestDigest(key, reordered))
      .toBe(await registrationRequestDigest(key, intent));
  });

  test("changes when any digested field changes", async () => {
    const key = randomKeyBytes();
    const changed = registrationIntent({ ...intent, publicId: "device_ffffffffffffffff" });
    expect(await registrationRequestDigest(key, changed))
      .not.toBe(await registrationRequestDigest(key, intent));
  });
});

describe("enqueue digest", () => {
  const request = enqueueRequest({
    deadline: 1_700_000_000_000,
    expectedTargetDevicePublicId: devicePublicId,
    kind: "send_or_steer",
    payload: envelope,
    publicId: "01931f2a-7c00-7000-8000-000000000002",
    sessionPublicId: "session_0123456789abcdef",
  });

  test("serializes in the daemon's key order", () => {
    expect(Object.keys(request)).toEqual([
      "deadline",
      "expectedTargetDevicePublicId",
      "kind",
      "payload",
      "publicId",
      "sessionPublicId",
    ]);
  });

  test("is the keyed digest over exactly that serialization", async () => {
    const key = randomKeyBytes();
    const expected = await hmacSha256Hex(
      key,
      commandEnqueueDigestPurpose,
      JSON.stringify(request),
    );
    expect(await enqueueRequestDigest(key, request)).toBe(expected);
  });

  test("binds the expected custodian device", async () => {
    const key = randomKeyBytes();
    const moved = enqueueRequest({
      ...request,
      expectedTargetDevicePublicId: "device_ffffffffffffffff",
    });
    expect(await enqueueRequestDigest(key, moved))
      .not.toBe(await enqueueRequestDigest(key, request));
  });
});

describe("selectKeyEnvelope", () => {
  const entries: readonly KeyEnvelopeEntry[] = [
    { createdAt: 100, envelope: wrapped(1) },
    { createdAt: 300, envelope: wrapped(1) },
    { createdAt: 400, envelope: wrapped(2) },
  ];

  test("takes the newest envelope at the device's key version", () => {
    const selected = selectKeyEnvelope(entries, 1);
    expect(selected).not.toBeNull();
    expect(selected?.keyVersion).toBe(1);
    expect(selected).toBe(entries[1]?.envelope as WrappedKeyEnvelope);
  });

  test("never falls back to another key version", () => {
    expect(selectKeyEnvelope(entries, 3)).toBeNull();
    expect(selectKeyEnvelope([], 1)).toBeNull();
  });
});

describe("identifiers", () => {
  test("device and bind identifiers are opaque and prefixed", () => {
    expect(randomOpaqueId("device")).toMatch(/^device_[A-Za-z0-9_-]{24}$/u);
    expect(randomOpaqueId("bind")).toMatch(/^bind_[A-Za-z0-9_-]{24}$/u);
  });

  test("device identifiers do not repeat", () => {
    const ids = new Set(Array.from({ length: 64 }, () => randomOpaqueId("device")));
    expect(ids.size).toBe(64);
  });

  test("a bind nonce is 24 random bytes in base64url", () => {
    const nonce = randomBindNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(decodeBase64Url(nonce).byteLength).toBe(24);
  });
});

describe("isDeviceClassValidatorRejection", () => {
  test("recognises an argument validator rejection naming the field", () => {
    expect(isDeviceClassValidatorRejection(new Error(
      "ArgumentValidationError: Object contains extra field `deviceClass` that is not in the validator.",
    ))).toBe(true);
  });

  test("does not swallow a handler failure", () => {
    expect(isDeviceClassValidatorRejection(new Error("Cloud authority is not current."))).toBe(false);
    expect(isDeviceClassValidatorRejection(new Error("deviceClass is revoked"))).toBe(false);
  });
});
