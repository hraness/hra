import { describe, expect, test } from "bun:test";

import {
  canonicalSessionSyncJson,
  commitSyncVaultRootKey,
  createSyncDeviceKeyPairs,
  createSyncProofNonce,
  createSyncRecoveryNonce,
  createSyncVaultRootKey,
  encodeSyncUint64,
  generateSyncRecoveryKit,
  digestSyncMembershipStatement,
  digestSyncRecoveryVaultRootWrap,
  digestSyncVaultRootWrapManifest,
  openSyncRecoveryKit,
  recoverSyncVaultRequestSchema,
  signSyncDeviceProof,
  signSyncMembershipStatement,
  signSyncRecoveryStatement,
  syncRecoveryKitSchema,
  syncRecoveryStatementSchema,
  syncRecoveryVaultRootWrapContextSchema,
  syncDeviceProofPayloadSchema,
  syncDeviceMemberSchema,
  syncMembershipHeadSchema,
  syncMembershipStatementSchema,
  syncVaultCoordinateSchema,
  syncVaultRootKeyLinkContextSchema,
  verifySyncRecoveryAuthorization,
  verifySyncRecoveryAuthority,
  unwrapSyncVaultRootKeyFromRecovery,
  wrapSyncParentVaultRootKey,
  wrapSyncVaultRootKey,
  wrapSyncVaultRootKeyForRecovery,
  syncVaultRootWrapContextSchema,
  wrappedSyncRecoveryVaultRootKeySchema,
} from "./index";

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

describe("session sync recovery custody", () => {
  test("rotates a dedicated authority while preserving only the bounded retained root keyring", async () => {
    const root1 = createSyncVaultRootKey();
    const first = await generateSyncRecoveryKit(vault, "1", "1", root1);
    expect(await verifySyncRecoveryAuthority(first.authority)).toBeTrue();
    const openedFirst = await openSyncRecoveryKit(first.recoveryKit, first.authority);
    expect(openedFirst.vaultRootKeys).toHaveLength(1);
    expect([...openedFirst.vaultRootKeys[0]!.rootKey]).toEqual([...root1]);

    const root2 = createSyncVaultRootKey();
    const second = await generateSyncRecoveryKit(
      vault,
      "2",
      "2",
      root2,
      openedFirst.vaultRootKeys,
    );
    const openedSecond = await openSyncRecoveryKit(second.recoveryKit, second.authority);
    expect(openedSecond.vaultRootKeys.map(({ keyEpoch }) => keyEpoch)).toEqual(["1", "2"]);
    expect([...openedSecond.vaultRootKeys[0]!.rootKey]).toEqual([...root1]);
    expect([...openedSecond.vaultRootKeys[1]!.rootKey]).toEqual([...root2]);
    expect(canonicalSessionSyncJson(second.authority)).not.toBe(canonicalSessionSyncJson(first.authority));

    const tooMany = Array.from({ length: 8 }, (_, index) => ({
      keyEpoch: String(index + 1),
      rootKey: createSyncVaultRootKey(),
    }));
    expect(generateSyncRecoveryKit(vault, "3", "9", createSyncVaultRootKey(), tooMany))
      .rejects.toThrow("exceeds");
    for (const item of tooMany) item.rootKey.fill(0);
    for (const item of openedFirst.vaultRootKeys) item.rootKey.fill(0);
    for (const item of openedSecond.vaultRootKeys) item.rootKey.fill(0);
    root1.fill(0);
    root2.fill(0);
  });

  test("a stale exported kit recovers a later root after every device is lost", async () => {
    const initialRoot = createSyncVaultRootKey();
    const exported = await generateSyncRecoveryKit(vault, "1", "1", initialRoot);
    const openedExport = await openSyncRecoveryKit(exported.recoveryKit, exported.authority);
    const device = await createSyncDeviceKeyPairs();
    const laterRoot = createSyncVaultRootKey();
    const context = syncRecoveryVaultRootWrapContextSchema.parse({
      version: 1,
      vault,
      membershipEpoch: "9",
      recoveryGeneration: exported.authority.recoveryGeneration,
      rootKeyEpoch: "9",
      rootKeyCommitment: await commitSyncVaultRootKey(laterRoot),
      recipientRecoveryAgreementKeyId: exported.authority.agreementKeyId,
    });
    const recoveryRootWrap = await wrapSyncVaultRootKeyForRecovery(
      laterRoot,
      context,
      exported.authority,
    );

    const recovered = await unwrapSyncVaultRootKeyFromRecovery(
      recoveryRootWrap,
      context,
      exported.authority,
      openedExport.recoveryAgreementPrivateKey,
    );
    expect(recovered).toEqual(laterRoot);
    expect(await digestSyncRecoveryVaultRootWrap(recoveryRootWrap))
      .toMatch(/^sha256_[0-9a-f]{64}$/u);

    expect(exported.authority.keyId).not.toBe(exported.authority.agreementKeyId);
    expect(exported.authority.publicKeyDigest)
      .not.toBe(exported.authority.agreementPublicKeyDigest);
    for (const key of [device.publicKeys.signing, device.publicKeys.agreement]) {
      expect(key.keyId).not.toBe(exported.authority.keyId);
      expect(key.keyId).not.toBe(exported.authority.agreementKeyId);
      expect(key.publicKeyDigest).not.toBe(exported.authority.publicKeyDigest);
      expect(key.publicKeyDigest).not.toBe(exported.authority.agreementPublicKeyDigest);
    }

    const other = await generateSyncRecoveryKit(
      vault,
      exported.authority.recoveryGeneration,
      "1",
      initialRoot,
    );
    const openedOther = await openSyncRecoveryKit(other.recoveryKit, other.authority);
    expect(unwrapSyncVaultRootKeyFromRecovery(
      recoveryRootWrap,
      context,
      other.authority,
      openedOther.recoveryAgreementPrivateKey,
    )).rejects.toThrow("authority context");
    expect(unwrapSyncVaultRootKeyFromRecovery(
      recoveryRootWrap,
      context,
      exported.authority,
      openedOther.recoveryAgreementPrivateKey,
    )).rejects.toThrow("authentication failed");

    const ciphertextTamper = wrappedSyncRecoveryVaultRootKeySchema.parse({
      ...recoveryRootWrap,
      ciphertext: flipBase64Url(recoveryRootWrap.ciphertext),
    });
    expect(unwrapSyncVaultRootKeyFromRecovery(
      ciphertextTamper,
      context,
      exported.authority,
      openedExport.recoveryAgreementPrivateKey,
    )).rejects.toThrow("ciphertext digest");

    const alteredContext = syncRecoveryVaultRootWrapContextSchema.parse({
      ...context,
      membershipEpoch: "10",
    });
    const contextTamper = wrappedSyncRecoveryVaultRootKeySchema.parse({
      ...recoveryRootWrap,
      context: alteredContext,
    });
    expect(unwrapSyncVaultRootKeyFromRecovery(
      contextTamper,
      alteredContext,
      exported.authority,
      openedExport.recoveryAgreementPrivateKey,
    )).rejects.toThrow("authentication failed");
    const ephemeralKeyTamper = wrappedSyncRecoveryVaultRootKeySchema.parse({
      ...recoveryRootWrap,
      ephemeralAgreementPublicKey: flipBase64Url(
        recoveryRootWrap.ephemeralAgreementPublicKey,
      ),
    });
    expect(unwrapSyncVaultRootKeyFromRecovery(
      ephemeralKeyTamper,
      context,
      exported.authority,
      openedExport.recoveryAgreementPrivateKey,
    )).rejects.toThrow("authentication failed");

    for (const item of openedExport.vaultRootKeys) item.rootKey.fill(0);
    for (const item of openedOther.vaultRootKeys) item.rootKey.fill(0);
    initialRoot.fill(0);
    laterRoot.fill(0);
    recovered.fill(0);
  });

  test("binds recovery authorization to the exact membership, root wraps, nonce, and next authority", async () => {
    const root = createSyncVaultRootKey();
    const current = await generateSyncRecoveryKit(vault, "1", "1", root);
    const nextRoot = createSyncVaultRootKey();
    const next = await generateSyncRecoveryKit(vault, "2", "2", nextRoot);
    const opened = await openSyncRecoveryKit(current.recoveryKit, current.authority);
    const device = await createSyncDeviceKeyPairs();
    const issuedAt = Date.now();
    const rootKeyLink = await wrapSyncParentVaultRootKey(
      root,
      nextRoot,
      syncVaultRootKeyLinkContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "2",
        parentRootKeyEpoch: "1",
        parentRootKeyCommitment: await commitSyncVaultRootKey(root),
        childRootKeyEpoch: "2",
        childRootKeyCommitment: await commitSyncVaultRootKey(nextRoot),
      }),
    );
    const replacementDevice = syncDeviceMemberSchema.parse({
      deviceId: opaque("syncdevice", "r"),
      name: "Replacement Mac",
      status: "active",
      keys: device.publicKeys,
      approvedAt: encodeSyncUint64(BigInt(issuedAt)),
    });
    const wrappedRoot = await wrapSyncVaultRootKey(
      nextRoot,
      syncVaultRootWrapContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "2",
        rootKeyEpoch: "2",
        recipientDeviceId: replacementDevice.deviceId,
        recipientAgreementKeyId: device.publicKeys.agreement.keyId,
      }),
      device.publicKeys.agreement.publicKey,
    );
    const replacementRootWrapManifestDigest = await digestSyncVaultRootWrapManifest([
      wrappedRoot,
    ]);
    const recoveryRootWrap = await wrapSyncVaultRootKeyForRecovery(
      nextRoot,
      syncRecoveryVaultRootWrapContextSchema.parse({
        version: 1,
        vault,
        membershipEpoch: "2",
        recoveryGeneration: next.authority.recoveryGeneration,
        rootKeyEpoch: "2",
        rootKeyCommitment: rootKeyLink.context.childRootKeyCommitment,
        recipientRecoveryAgreementKeyId: next.authority.agreementKeyId,
      }),
      next.authority,
    );
    const replacementRecoveryRootWrapDigest = await digestSyncRecoveryVaultRootWrap(
      recoveryRootWrap,
    );
    const membershipStatement = syncMembershipStatementSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "2",
      previousMembershipDigest: `sha256_${"1".repeat(64)}`,
      recoveryGeneration: "2",
      enrollmentPairingDigest: null,
      rootKeyEpoch: "2",
      rootKeyCommitment: rootKeyLink.context.childRootKeyCommitment,
      rootWrapManifestDigest: replacementRootWrapManifestDigest,
      rootKeyLinkDigest: rootKeyLink.linkDigest,
      recoveryRootWrapDigest: replacementRecoveryRootWrapDigest,
      members: [replacementDevice],
    });
    const replacementMembershipDigest = await digestSyncMembershipStatement(
      membershipStatement,
    );
    const statement = syncRecoveryStatementSchema.parse({
      version: 1,
      vault,
      recoveryNonce: createSyncRecoveryNonce(),
      issuedAt: encodeSyncUint64(BigInt(issuedAt)),
      expiresAt: encodeSyncUint64(BigInt(issuedAt + 60_000)),
      currentMembershipEpoch: "1",
      currentMembershipDigest: `sha256_${"1".repeat(64)}`,
      currentRecoveryGeneration: "1",
      currentRootKeyEpoch: "1",
      currentRootKeyCommitment: rootKeyLink.context.parentRootKeyCommitment,
      replacementDevice,
      replacementMembershipEpoch: "2",
      replacementMembershipDigest,
      replacementRootKeyEpoch: "2",
      replacementRootKeyCommitment: rootKeyLink.context.childRootKeyCommitment,
      replacementRootWrapManifestDigest,
      replacementRecoveryRootWrapDigest,
      replacementRootWraps: [{
        keyEpoch: "2",
        ciphertextDigest: wrappedRoot.ciphertextDigest,
      }],
      rootKeyLink,
      nextRecoveryAuthority: next.authority,
    });
    const authorization = await signSyncRecoveryStatement(
      statement,
      current.authority.keyId,
      opened.recoverySigningPrivateKey,
    );
    const membershipSignature = await signSyncMembershipStatement(
      membershipStatement,
      replacementDevice.deviceId,
      device.publicKeys.signing.keyId,
      device.signingPrivateKey,
    );
    const membershipHead = syncMembershipHeadSchema.parse({
      statement: membershipStatement,
      statementDigest: replacementMembershipDigest,
      signatures: [membershipSignature],
    });
    const replacementDeviceProof = await signSyncDeviceProof(
      syncDeviceProofPayloadSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "2",
        deviceId: replacementDevice.deviceId,
        method: "POST",
        route: "sync.membership.recover",
        bodyDigest: authorization.statementDigest,
        nonce: createSyncProofNonce(),
        issuedAt: encodeSyncUint64(BigInt(issuedAt)),
        expiresAt: encodeSyncUint64(BigInt(issuedAt + 60_000)),
      }),
      device.publicKeys.signing.keyId,
      device.signingPrivateKey,
    );
    const recoveryRequest = recoverSyncVaultRequestSchema.parse({
      version: 1,
      authorization,
      membershipHead,
      replacementDeviceProof,
      wrappedRoots: [wrappedRoot],
      recoveryRootWrap,
    });
    expect(recoverSyncVaultRequestSchema.safeParse({
      ...recoveryRequest,
      membershipHead: {
        ...membershipHead,
        statement: {
          ...membershipStatement,
          enrollmentPairingDigest: `sha256_${"f".repeat(64)}`,
        },
      },
    }).success).toBeFalse();
    expect(await verifySyncRecoveryAuthorization(authorization, current.authority)).toBeTrue();
    expect(await verifySyncRecoveryAuthorization({
      ...authorization,
      statement: { ...statement, recoveryNonce: createSyncRecoveryNonce() },
    }, current.authority)).toBeFalse();
    expect(await verifySyncRecoveryAuthorization({
      ...authorization,
      statement: {
        ...statement,
        rootKeyLink: {
          ...statement.rootKeyLink,
          ciphertext: flipBase64Url(statement.rootKeyLink.ciphertext),
        },
      },
    }, current.authority)).toBeFalse();
    expect(await verifySyncRecoveryAuthorization(authorization, next.authority)).toBeFalse();
    expect(syncRecoveryStatementSchema.safeParse({
      ...statement,
      rootKeyLink: undefined,
    }).success).toBeFalse();
    expect(syncRecoveryStatementSchema.safeParse({
      ...statement,
      replacementRootKeyEpoch: "1",
      rootKeyLink: {
        ...statement.rootKeyLink,
        context: {
          ...statement.rootKeyLink.context,
          childRootKeyEpoch: "1",
        },
      },
    }).success).toBeFalse();

    const alteredKit = {
      ...current.recoveryKit,
      vaultRootKeys: current.recoveryKit.vaultRootKeys.map((entry, index) => index === 0
        ? { ...entry, rootKey: flipBase64Url(entry.rootKey) }
        : entry),
    };
    expect(syncRecoveryKitSchema.safeParse(alteredKit).success).toBeTrue();
    expect(openSyncRecoveryKit(alteredKit, current.authority)).rejects.toThrow("digest");
    for (const item of opened.vaultRootKeys) item.rootKey.fill(0);
    root.fill(0);
    nextRoot.fill(0);
  });
});

function flipBase64Url(value: string): string {
  const first = value[0];
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}
