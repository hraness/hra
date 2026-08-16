import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  syncDeviceProofPayloadSchema,
  syncVaultCoordinateSchema,
  syncVaultRootWrapContextSchema,
} from "./session-sync";
import {
  createSyncVaultRootKey,
  deriveSyncDevicePublicKeys,
  generateSyncDeviceKeyCustody,
  importSyncDeviceKeyPairs,
  signSyncDeviceProof,
  unwrapSyncVaultRootKey,
  verifySyncDeviceKeyCustody,
  verifySyncDeviceProof,
  wrapSyncVaultRootKey,
} from "./session-sync-crypto";

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

const vault = syncVaultCoordinateSchema.parse({
  tenantId: opaque("synctenant", "t"),
  organizationId: opaque("syncorg", "o"),
  ownerUserId: opaque("syncuser", "u"),
  vaultId: opaque("syncvault", "v"),
  vaultGeneration: "1",
});
describe("session sync device key custody", () => {
  test("exports custody material once and reimports only nonextractable runtime keys", async () => {
    const generated = await generateSyncDeviceKeyCustody();
    expect(generated.privateKeyMaterial.signingPkcs8.length).toBeGreaterThan(100);
    expect(generated.privateKeyMaterial.agreementPkcs8.length).toBeGreaterThan(100);
    expect(await verifySyncDeviceKeyCustody(
      generated.privateKeyMaterial,
      generated.publicKeys,
    )).toBeTrue();
    expect(await deriveSyncDevicePublicKeys(generated.privateKeyMaterial, {
      signingKeyId: generated.publicKeys.signing.keyId,
      agreementKeyId: generated.publicKeys.agreement.keyId,
    })).toEqual(generated.publicKeys);

    const runtime = await importSyncDeviceKeyPairs(
      generated.privateKeyMaterial,
      generated.publicKeys,
    );
    expect(runtime.signingPrivateKey.extractable).toBeFalse();
    expect(runtime.agreementPrivateKey.extractable).toBeFalse();
    expect(runtime.signingPrivateKey.usages).toEqual(["sign"]);
    expect(runtime.agreementPrivateKey.usages).toEqual(["deriveBits"]);
    expect("privateKeyMaterial" in runtime).toBeFalse();

    const payload = syncDeviceProofPayloadSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "1",
      deviceId: opaque("syncdevice", "d"),
      method: "GET",
      route: "sync.membership.read",
      bodyDigest: `sha256_${"a".repeat(64)}`,
      nonce: opaque("syncproof", "n"),
      issuedAt: "1000",
      expiresAt: "121000",
    });
    const proof = await signSyncDeviceProof(
      payload,
      runtime.publicKeys.signing.keyId,
      runtime.signingPrivateKey,
    );
    expect(await verifySyncDeviceProof(proof, runtime.publicKeys, "60000")).toBeTrue();

    const root = createSyncVaultRootKey();
    const context = syncVaultRootWrapContextSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "1",
      rootKeyEpoch: "1",
      recipientDeviceId: payload.deviceId,
      recipientAgreementKeyId: runtime.publicKeys.agreement.keyId,
    });
    const wrapped = await wrapSyncVaultRootKey(
      root,
      context,
      runtime.publicKeys.agreement.publicKey,
    );
    expect(await unwrapSyncVaultRootKey(
      wrapped,
      context,
      runtime.agreementPrivateKey,
    )).toEqual(root);
  });

  test("property: every single-character custody mutation fails closed", async () => {
    const generated = await generateSyncDeviceKeyCustody();
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("signingPkcs8" as const, "agreementPkcs8" as const),
      fc.nat(),
      async (field, offset) => {
        const original = generated.privateKeyMaterial[field];
        const index = offset % original.length;
        const replacement = original[index] === "A" ? "B" : "A";
        const mutated = `${original.slice(0, index)}${replacement}${original.slice(index + 1)}`;
        expect(await verifySyncDeviceKeyCustody({
          ...generated.privateKeyMaterial,
          [field]: mutated,
        }, generated.publicKeys)).toBeFalse();
      },
    ), { numRuns: 24 });
  });
});
