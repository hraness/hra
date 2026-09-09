import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { cloudLimits, type EncryptedEnvelope } from "./contracts";
import { encryptBytes, randomKeyBytes, sha256Hex } from "./crypto";
import {
  cloudPayloadAad,
  decryptProfileBinding,
  encryptProfileBinding,
  parseDeviceRegistryPayload,
  parseProfileBindingPayload,
  profileBindingRegistryDigest,
  type ProfileBindingPayload,
} from "./payloads";

const pairs = [
  ["low", "codex:gpt-5.6-luna:max"],
  ["high", "codex:gpt-5.6-sol:max"],
  ["high", "codex:gpt-6-astra:max"],
  ["ultra", "codex:gpt-5.6-sol:ultra"],
  ["ultra", "codex:gpt-6-astra:ultra"],
] as const;
const binding = {
  version: 1,
  preset: "ultra",
  profileKey: "codex:gpt-5.6-sol:ultra",
  observedAt: 1_900_000_000_000,
  registryRevision: 2,
  registryEnvelopeDigest: "a".repeat(64),
} as const satisfies ProfileBindingPayload;
const authority = {
  entityPublicId: "device_profile_binding",
  keyVersion: 1,
  kind: "profile_binding",
  userPublicId: "user_profile_binding",
} as const;
const registryEnvelope = {
  algorithm: "A256GCM",
  ciphertext: "A".repeat(32),
  keyVersion: 1,
  nonce: "B".repeat(16),
} as const satisfies EncryptedEnvelope;

describe("read-only profile binding payload", () => {
  test("accepts only the five coherent frozen Codex alias/key pairs", () => {
    for (const [preset, profileKey] of pairs) {
      const payload = { ...binding, preset, profileKey };
      expect(parseProfileBindingPayload(payload)).toEqual(payload);
      for (const otherPreset of ["low", "high", "ultra"] as const) {
        if (otherPreset !== preset) {
          expect(parseProfileBindingPayload({ ...payload, preset: otherPreset })).toBeNull();
        }
      }
    }
    for (const profileKey of ["claude:claude-fable-5-1:max", "devin:gpt-6-astra:provider-default", "codex:future:ultra"]) {
      expect(parseProfileBindingPayload({ ...binding, profileKey })).toBeNull();
    }
  });

  test("rejects extra fields, unknown versions, unsafe numbers and malformed digests", () => {
    for (const patch of [
      { version: 2 }, { version: "1" }, { provider: "codex" }, { preset: "fable-max" },
      { observedAt: -0 }, { observedAt: 0 }, { observedAt: -1 }, { observedAt: 0.5 }, { observedAt: Infinity },
      { observedAt: Number.MAX_SAFE_INTEGER + 1 }, { registryRevision: -0 },
      { registryRevision: 0 }, { registryRevision: 1.5 }, { registryRevision: Number.MAX_SAFE_INTEGER + 1 },
      { registryEnvelopeDigest: "A".repeat(64) }, { registryEnvelopeDigest: "a".repeat(63) },
      { registryEnvelopeDigest: "a".repeat(65_537) }, { profileKey: null },
    ]) expect(parseProfileBindingPayload({ ...binding, ...patch })).toBeNull();
    expect(parseProfileBindingPayload({ ...binding, observedAt: 1 })).toEqual({ ...binding, observedAt: 1 });
    expect(parseProfileBindingPayload({ ...binding, observedAt: Number.MAX_SAFE_INTEGER, registryRevision: Number.MAX_SAFE_INTEGER }))
      .not.toBeNull();
    for (const value of [null, undefined, [], "binding", 1]) expect(parseProfileBindingPayload(value)).toBeNull();
  });

  test("snapshots hostile foreign values without invoking accessors", () => {
    let reads = 0;
    const accessor = { ...binding, get profileKey() { reads += 1; return binding.profileKey; } };
    expect(parseProfileBindingPayload(accessor)).toBeNull();
    expect(reads).toBe(0);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hidden = Object.defineProperty({ ...binding }, "hidden", { value: true });
    for (const value of [
      revoked.proxy,
      new Proxy(binding, { ownKeys() { throw new Error("untrusted"); } }),
      hidden,
      { ...binding, [Symbol("extra")]: 1 },
      { ...binding, profileKey: revoked.proxy },
      Object.create(binding) as unknown,
    ]) expect(parseProfileBindingPayload(value)).toBeNull();
    const source: Omit<ProfileBindingPayload, "registryRevision"> & { registryRevision: number } = { ...binding };
    const parsed = parseProfileBindingPayload(source);
    source.registryRevision = 3;
    expect(parsed?.registryRevision).toBe(2);
  });

  test("round-trips coherent observations with property-controlled revisions and times", async () => {
    const key = randomKeyBytes();
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...pairs),
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      async ([preset, profileKey], registryRevision, observedAt) => {
        const payload: ProfileBindingPayload = { ...binding, preset, profileKey, registryRevision, observedAt };
        const envelope = await encryptProfileBinding(payload, key, authority);
        expect(envelope.ciphertext.length).toBeLessThanOrEqual(cloudLimits.profileBindingCiphertextCharacters);
        expect(await decryptProfileBinding(envelope, key, authority)).toEqual(payload);
      },
    ), { numRuns: 100 });
  });

  test("refuses wrong purpose, user, device, key version, key and authenticated malformed payloads", async () => {
    const key = randomKeyBytes();
    const envelope = await encryptProfileBinding(binding, key, authority);
    for (const wrong of [
      { ...authority, kind: "device_registry" as const },
      { ...authority, userPublicId: "user_other_binding" },
      { ...authority, entityPublicId: "device_other_binding" },
      { ...authority, keyVersion: 2 },
    ]) await expect(decryptProfileBinding(envelope, key, wrong)).rejects.toThrow();
    await expect(encryptProfileBinding(binding, key, { ...authority, kind: "notification_hours" })).rejects.toThrow();
    await expect(decryptProfileBinding(envelope, randomKeyBytes(), authority)).rejects.toThrow();
    for (const payload of [{ ...binding, preset: "high" }, { ...binding, version: 2 }]) {
      const malformed = await encryptBytes(new TextEncoder().encode(JSON.stringify(payload)), key, 1, cloudPayloadAad(authority));
      await expect(decryptProfileBinding(malformed, key, authority)).rejects.toThrow();
      await expect(encryptProfileBinding(payload as ProfileBindingPayload, key, authority)).rejects.toThrow();
    }
    await expect(decryptProfileBinding({ ...envelope, ciphertext: "A".repeat(2_049) }, key, authority)).rejects.toThrow();
    await expect(decryptProfileBinding({ ...envelope, extra: true } as EncryptedEnvelope, key, authority)).rejects.toThrow();
  });

  test("digests the exact bounded registry envelope with its own stable domain separator", async () => {
    const expected = await sha256Hex("hra-profile-binding-registry-envelope:v1\n" + JSON.stringify(registryEnvelope));
    expect(await profileBindingRegistryDigest(registryEnvelope)).toBe(expected);
    expect(await profileBindingRegistryDigest({ nonce: registryEnvelope.nonce, keyVersion: 1, ciphertext: registryEnvelope.ciphertext, algorithm: "A256GCM" }))
      .toBe(expected);
    expect(expected).not.toBe(await sha256Hex(JSON.stringify(registryEnvelope)));
    for (const patch of [{ ciphertext: "C".repeat(32) }, { nonce: "D".repeat(16) }, { keyVersion: 2 }]) {
      expect(await profileBindingRegistryDigest({ ...registryEnvelope, ...patch })).not.toBe(expected);
    }
    for (const malformed of [
      { ...registryEnvelope, keyVersion: -0 },
      { ...registryEnvelope, ciphertext: "A".repeat(cloudLimits.registryCiphertextCharacters + 1) },
      { ...registryEnvelope, algorithm: "other" },
      { ...registryEnvelope, extra: true },
      { ...registryEnvelope, get nonce() { throw new Error("must not read"); } },
    ]) await expect(profileBindingRegistryDigest(malformed as EncryptedEnvelope)).rejects.toThrow();
  });

  test("leaves existing AAD bytes unchanged and domain-separates the companion", () => {
    for (const kind of ["device_registry", "memory_summary", "notification_hours", "notification_email"] as const) {
      expect(new TextDecoder().decode(cloudPayloadAad({ ...authority, kind })))
        .toBe(`hra-control-plane-cloud-payload:v1\n${kind}\nuser_profile_binding\ndevice_profile_binding\n1`);
      expect(cloudPayloadAad({ ...authority, kind })).not.toEqual(cloudPayloadAad(authority));
    }
  });

  test("keeps canonical identity out of the frozen registry-v1 payload", () => {
    const registry = {
      accounts: [],
      daemonVersion: "0.7.0",
      defaultApprovalMode: "auto:all",
      defaultPreset: "ultra",
      heartbeatAt: binding.observedAt,
      machineLabel: "Studio",
      projects: [],
      proseAutorespondConfigured: false,
      scheduledTasks: [],
      showThinkingDefault: false,
      version: 1,
    } as const;
    expect(parseDeviceRegistryPayload(registry)).toEqual(registry);
    for (const extra of [
      { profileKey: binding.profileKey },
      { profileBinding: binding },
      { profileBindingEnvelope: registryEnvelope },
      { profileBindingProjectionVersion: 1 },
    ]) expect(parseDeviceRegistryPayload({ ...registry, ...extra })).toBeNull();
  });
});
