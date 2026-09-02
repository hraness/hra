import { describe, expect, test } from "bun:test";

import {
  decryptBytes,
  encodeBase64Url,
  encryptBytes,
  exportDevicePrivateKey,
  exportDevicePublicKey,
  GcmMessageBudget,
  gcmMessageBudgetKey,
  gcmMessageBudgetPerKey,
  generateDeviceSigningKeyPair,
  generateDeviceWrappingKeyPair,
  importP256PrivateKey,
  KeyRotationRequiredError,
  maximumTrackedGcmKeys,
  processGcmMessageBudget,
  randomKeyBytes,
  signDeviceBind,
  unwrapAccountDataKey,
  verifyDeviceBind,
  wrapAccountDataKey,
} from "./crypto";
import { expectPromiseToReject } from "./testAssertions";

describe("cloud cryptography", () => {
  test("AES-GCM round trips, randomizes, and binds AAD", async () => {
    const key = randomKeyBytes();
    const plaintext = new TextEncoder().encode("bounded projection");
    const aad = new TextEncoder().encode("authority-a");
    const first = await encryptBytes(plaintext, key, 1, aad);
    const second = await encryptBytes(plaintext, key, 1, aad);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(new TextDecoder().decode(await decryptBytes(first, key, aad)))
      .toBe("bounded projection");
    await expectPromiseToReject(
      decryptBytes(first, key, new TextEncoder().encode("authority-b")),
    );
    await expectPromiseToReject(
      decryptBytes({ ...first, nonce: encodeBase64Url(new Uint8Array(12).fill(1)) }, key, aad),
    );
  });

  test("P-256 wrapping exposes no account key and binds device authority", async () => {
    const recipient = await generateDeviceWrappingKeyPair();
    const publicKey = await exportDevicePublicKey(recipient.publicKey);
    const accountKey = randomKeyBytes();
    const authority = {
      accountKeyVersion: 1,
      devicePublicId: "device_12345678",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await wrapAccountDataKey(accountKey, publicKey, authority);
    expect(JSON.stringify(envelope)).not.toContain(encodeBase64Url(accountKey));
    expect(await unwrapAccountDataKey(envelope, recipient.privateKey, authority))
      .toEqual(accountKey);
    await expectPromiseToReject(unwrapAccountDataKey(envelope, recipient.privateKey, {
      ...authority,
      devicePublicId: "device_87654321",
    }));
  });

  test("device binding verifies only the exact challenge tuple", async () => {
    const signing = await generateDeviceSigningKeyPair(true);
    const publicKey = await exportDevicePublicKey(signing.publicKey);
    const restoredPrivateKey = await importP256PrivateKey(
      await exportDevicePrivateKey(signing.privateKey),
      "signing",
    );
    const authority = {
      challengeId: "challenge_12345678",
      devicePublicId: "device_12345678",
      nonce: encodeBase64Url(new Uint8Array(24).fill(7)),
    } as const;
    const signature = await signDeviceBind(restoredPrivateKey, authority);
    expect(await verifyDeviceBind(publicKey, authority, signature)).toBe(true);
    expect(await verifyDeviceBind(publicKey, {
      ...authority,
      challengeId: "challenge_87654321",
    }, signature)).toBe(false);
  });

  test("refuses further AES-GCM messages once a key version reaches its budget", async () => {
    const key = randomKeyBytes();
    const plaintext = new TextEncoder().encode("chunk");
    const aad = new TextEncoder().encode("authority-a");
    const budget = new GcmMessageBudget();
    const budgetKey = await gcmMessageBudgetKey(key, 1);
    expect(budgetKey.fingerprint).toMatch(/^[0-9a-f]{32}$/u);
    expect((await gcmMessageBudgetKey(key, 2)).fingerprint).not.toBe(budgetKey.fingerprint);
    expect((await gcmMessageBudgetKey(randomKeyBytes(), 1)).fingerprint)
      .not.toBe(budgetKey.fingerprint);

    expect(budget.restore(budgetKey, gcmMessageBudgetPerKey - 1)).toBe(gcmMessageBudgetPerKey - 1);
    // A later restore never moves a key the process already counts.
    expect(budget.restore(budgetKey, 5)).toBe(gcmMessageBudgetPerKey - 1);
    expect(budget.restore(budgetKey, gcmMessageBudgetPerKey)).toBe(gcmMessageBudgetPerKey - 1);
    const last = await encryptBytes(plaintext, key, 1, aad, budget);
    expect(new TextDecoder().decode(await decryptBytes(last, key, aad))).toBe("chunk");
    expect(budget.observe(budgetKey)).toBe(gcmMessageBudgetPerKey);

    const refused = await encryptBytes(plaintext, key, 1, aad, budget)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(KeyRotationRequiredError);
    expect(refused).toMatchObject({ code: "KEY_ROTATION_REQUIRED", keyVersion: 1 });
    expect(budget.observe(budgetKey)).toBe(gcmMessageBudgetPerKey);

    // A rotated key version starts its own count under the same budget.
    const rotated = await encryptBytes(plaintext, key, 2, aad, budget);
    expect(rotated.keyVersion).toBe(2);
    expect(budget.observe(await gcmMessageBudgetKey(key, 2))).toBe(1);
  });

  test("counts every encryption in the process-wide budget and bounds tracked keys", async () => {
    const key = randomKeyBytes();
    const budgetKey = await gcmMessageBudgetKey(key, 1);
    const before = processGcmMessageBudget.observe(budgetKey);
    await encryptBytes(new Uint8Array(1), key, 1, new Uint8Array(0));
    await encryptBytes(new Uint8Array(1), key, 1, new Uint8Array(0));
    expect(processGcmMessageBudget.observe(budgetKey)).toBe(before + 2);

    const bounded = new GcmMessageBudget();
    for (let index = 0; index < maximumTrackedGcmKeys; index += 1) {
      bounded.consume({ fingerprint: index.toString(16).padStart(32, "0"), keyVersion: 1 });
    }
    expect(() => bounded.consume({ fingerprint: "f".repeat(32), keyVersion: 1 }))
      .toThrow(/at most 65536/u);
    expect(bounded.consume({ fingerprint: "0".repeat(32), keyVersion: 1 })).toBe(2);
    expect(() => bounded.restore(budgetKey, gcmMessageBudgetPerKey + 1)).toThrow(/high-water/u);
    expect(() => bounded.observe({ fingerprint: "nothex", keyVersion: 1 })).toThrow(/budget key/u);
    expect(() => bounded.observe({ fingerprint: "0".repeat(32), keyVersion: 0 })).toThrow(/budget key/u);
  });
});
