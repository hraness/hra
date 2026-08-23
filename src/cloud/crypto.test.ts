import { describe, expect, test } from "bun:test";

import {
  decryptBytes,
  encodeBase64Url,
  encryptBytes,
  exportDevicePrivateKey,
  exportDevicePublicKey,
  generateDeviceSigningKeyPair,
  generateDeviceWrappingKeyPair,
  importP256PrivateKey,
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
});
