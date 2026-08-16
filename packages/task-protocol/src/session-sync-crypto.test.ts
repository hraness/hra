import { describe, expect, test } from "bun:test";

import {
  SESSION_SYNC_PROTOCOL,
  sealedSessionSummarySchema,
  sessionContentKeyContextSchema,
  sessionSummarySchema,
  sessionSyncHeaderSchema,
  syncDeviceIdSchema,
  syncDeviceProofPayloadSchema,
  syncEnrollmentPossessionProofPayloadSchema,
  syncMembershipStatementSchema,
  syncVaultCoordinateSchema,
  syncVaultRootKeyLinkContextSchema,
  syncVaultRootWrapContextSchema,
  wrappedSyncVaultRootKeyLinkSchema,
  wrappedSyncVaultRootKeySchema,
  type SessionSyncHeader,
} from "./session-sync";
import {
  allocateSessionSyncNonce,
  canonicalSessionSyncJson,
  commitSyncVaultRootKey,
  createSessionSyncNonceState,
  createSyncDeviceKeyPairs,
  createSyncProofNonce,
  createSyncVaultRootKey,
  deriveSessionContentKey,
  digestSyncMembershipStatement,
  digestSyncRequestBody,
  digestSyncVaultRootKeyLink,
  digestSyncVaultRootWrapManifest,
  generateSyncDeviceKeyCustody,
  openSessionSummary,
  sealSessionSummary,
  signSyncDeviceProof,
  signSyncEnrollmentPossessionProof,
  signSyncMembershipStatement,
  unwrapSyncVaultRootKey,
  unwrapSyncParentVaultRootKey,
  verifySyncDeviceProof,
  verifySyncDevicePublicKeys,
  verifySyncEnrollmentPossessionProof,
  verifySyncMembershipSignature,
  wrapSyncVaultRootKey,
  wrapSyncParentVaultRootKey,
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
const deviceId = syncDeviceIdSchema.parse(opaque("syncdevice", "d"));
const sessionId = opaque("syncsession", "s");
const predecessor = `sha256_${"a".repeat(64)}`;

function header(overrides: Record<string, unknown> = {}): SessionSyncHeader {
  return sessionSyncHeaderSchema.parse({
    protocol: SESSION_SYNC_PROTOCOL,
    payloadVersion: 1,
    payloadKind: "session_summary",
    ...vault,
    membershipEpoch: "3",
    originDeviceId: deviceId,
    sessionId,
    mirrorEpoch: "2",
    writerGeneration: "4",
    bootId: opaque("syncboot", "b"),
    bootGeneration: "5",
    directoryOrdinal: "6",
    keyEpoch: "8",
    syncSequence: "9",
    sourceRevision: "10",
    eventKind: "projection_changed",
    previousDigest: predecessor,
    ...overrides,
  });
}

function summary(overrides: Record<string, unknown> = {}) {
  const currentHeader = header();
  return sessionSummarySchema.parse({
    version: 1,
    sessionId: currentHeader.sessionId,
    ownerDeviceId: currentHeader.originDeviceId,
    directoryOrdinal: currentHeader.directoryOrdinal,
    sourceRevision: currentHeader.sourceRevision,
    title: "Harden gateway recovery",
    repositoryDisplayName: "example",
    modelEffort: "ultra",
    state: "working",
    originUpdatedAt: "9007199254740993",
    deleted: false,
    ...overrides,
  });
}

describe("session sync cryptography", () => {
  test("creates separate non-extractable signing and agreement keys with verified public envelopes", async () => {
    const keys = await createSyncDeviceKeyPairs();
    expect(keys.signingPrivateKey.extractable).toBeFalse();
    expect(keys.agreementPrivateKey.extractable).toBeFalse();
    expect(keys.publicKeys.signing.keyId).not.toBe(keys.publicKeys.agreement.keyId);
    expect(await verifySyncDevicePublicKeys(keys.publicKeys)).toBeTrue();
    expect(await verifySyncDevicePublicKeys({
      ...keys.publicKeys,
      signing: {
        ...keys.publicKeys.signing,
        publicKeyDigest: keys.publicKeys.agreement.publicKeyDigest,
      },
    })).toBeFalse();
  });

  test("signs a canonical, short-lived device proof over every route coordinate", async () => {
    const keys = await createSyncDeviceKeyPairs();
    const payload = syncDeviceProofPayloadSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "3",
      deviceId,
      method: "POST",
      route: "sync.session.publish",
      bodyDigest: await digestSyncRequestBody({ envelopeDigest: predecessor }),
      nonce: createSyncProofNonce(),
      issuedAt: "1000",
      expiresAt: "121000",
    });
    const proof = await signSyncDeviceProof(
      payload,
      keys.publicKeys.signing.keyId,
      keys.signingPrivateKey,
    );
    expect(await verifySyncDeviceProof(proof, keys.publicKeys, "1000")).toBeTrue();
    expect(await verifySyncDeviceProof(proof, keys.publicKeys, "121000")).toBeTrue();
    expect(await verifySyncDeviceProof(proof, keys.publicKeys, "121001")).toBeFalse();

    const alteredCoordinates = [
      { tenantId: opaque("synctenant", "x") },
      { organizationId: opaque("syncorg", "x") },
      { ownerUserId: opaque("syncuser", "x") },
      { vaultId: opaque("syncvault", "x") },
      { vaultGeneration: "2" },
      { membershipEpoch: "4" },
      { deviceId: opaque("syncdevice", "x") },
      { method: "GET" },
      { route: "sync.session.delete" },
      { bodyDigest: `sha256_${"b".repeat(64)}` },
      { nonce: opaque("syncproof", "x") },
      { issuedAt: "1001" },
      { expiresAt: "120999" },
    ] as const;
    for (const mutation of alteredCoordinates) {
      const tampered = {
        ...proof,
        payload: syncDeviceProofPayloadSchema.parse({ ...proof.payload, ...mutation }),
      };
      expect(await verifySyncDeviceProof(tampered, keys.publicKeys, "1000")).toBeFalse();
    }
    const other = await createSyncDeviceKeyPairs();
    expect(await verifySyncDeviceProof(proof, other.publicKeys, "1000")).toBeFalse();
  });

  test("proves independent signing and agreement key possession for enrollment", async () => {
    const custody = await generateSyncDeviceKeyCustody();
    const payload = syncEnrollmentPossessionProofPayloadSchema.parse({
      version: 1,
      purpose: "submit",
      vaultId: vault.vaultId,
      vaultGeneration: vault.vaultGeneration,
      deviceId,
      bodyDigest: await digestSyncRequestBody({ candidate: custody.publicKeys }),
      nonce: createSyncProofNonce(),
      issuedAt: "1000",
      expiresAt: "121000",
    });
    const proof = await signSyncEnrollmentPossessionProof(
      payload,
      custody.privateKeyMaterial,
      custody.publicKeys,
    );
    expect(await verifySyncEnrollmentPossessionProof(
      proof,
      custody.publicKeys,
      "1000",
    )).toBeTrue();
    expect(await verifySyncEnrollmentPossessionProof(
      proof,
      custody.publicKeys,
      "121000",
    )).toBeTrue();
    expect(await verifySyncEnrollmentPossessionProof(
      proof,
      custody.publicKeys,
      "121001",
    )).toBeFalse();

    const tamperedPayloads = [
      { purpose: "claim" },
      { vaultId: opaque("syncvault", "x") },
      { vaultGeneration: "2" },
      { deviceId: opaque("syncdevice", "x") },
      { bodyDigest: `sha256_${"b".repeat(64)}` },
      { nonce: opaque("syncproof", "x") },
    ] as const;
    for (const mutation of tamperedPayloads) {
      expect(await verifySyncEnrollmentPossessionProof({
        ...proof,
        payload: syncEnrollmentPossessionProofPayloadSchema.parse({
          ...proof.payload,
          ...mutation,
        }),
      }, custody.publicKeys, "1000")).toBeFalse();
    }
    expect(await verifySyncEnrollmentPossessionProof({
      ...proof,
      signingSignature: proof.agreementSignature,
      agreementSignature: proof.signingSignature,
    }, custody.publicKeys, "1000")).toBeFalse();
    expect(await verifySyncEnrollmentPossessionProof({
      ...proof,
      signingKeyId: proof.agreementKeyId,
      agreementKeyId: proof.signingKeyId,
    }, custody.publicKeys, "1000")).toBeFalse();

    const other = await generateSyncDeviceKeyCustody();
    expect(await verifySyncEnrollmentPossessionProof(
      proof,
      other.publicKeys,
      "1000",
    )).toBeFalse();
    expect(signSyncEnrollmentPossessionProof(
      payload,
      other.privateKeyMaterial,
      custody.publicKeys,
    )).rejects.toThrow("do not match");
  });

  test("signs the canonical membership statement and rejects statement or key substitution", async () => {
    const keys = await createSyncDeviceKeyPairs();
    const statement = syncMembershipStatementSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "1",
      previousMembershipDigest: null,
      recoveryGeneration: "1",
      enrollmentPairingDigest: null,
      rootKeyEpoch: "1",
      rootKeyCommitment: predecessor,
      rootWrapManifestDigest: `sha256_${"b".repeat(64)}`,
      rootKeyLinkDigest: null,
      recoveryRootWrapDigest: `sha256_${"d".repeat(64)}`,
      members: [{
        deviceId,
        name: "Studio Mac",
        status: "active",
        keys: keys.publicKeys,
        approvedAt: "1000",
      }],
    });
    const signature = await signSyncMembershipStatement(
      statement,
      deviceId,
      keys.publicKeys.signing.keyId,
      keys.signingPrivateKey,
    );
    expect(await verifySyncMembershipSignature(statement, signature, keys.publicKeys)).toBeTrue();
    expect(await digestSyncMembershipStatement(statement)).toMatch(/^sha256_[a-f0-9]{64}$/u);
    const mutated = syncMembershipStatementSchema.parse({
      ...statement,
      rootKeyCommitment: `sha256_${"c".repeat(64)}`,
    });
    expect(await verifySyncMembershipSignature(mutated, signature, keys.publicKeys)).toBeFalse();
    expect(await verifySyncMembershipSignature(
      { ...statement },
      { ...signature, deviceId: syncDeviceIdSchema.parse(opaque("syncdevice", "x")) },
      keys.publicKeys,
    )).toBeFalse();
    const other = await createSyncDeviceKeyPairs();
    expect(await verifySyncMembershipSignature(statement, signature, other.publicKeys)).toBeFalse();
  });

  test("wraps the vault root only to the exact approved device and authority context", async () => {
    const recipient = await createSyncDeviceKeyPairs();
    const root = createSyncVaultRootKey();
    const context = syncVaultRootWrapContextSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "3",
      rootKeyEpoch: "4",
      recipientDeviceId: deviceId,
      recipientAgreementKeyId: recipient.publicKeys.agreement.keyId,
    });
    const first = await wrapSyncVaultRootKey(
      root,
      context,
      recipient.publicKeys.agreement.publicKey,
    );
    const second = await wrapSyncVaultRootKey(
      root,
      context,
      recipient.publicKeys.agreement.publicKey,
    );
    expect(first).not.toEqual(second);
    expect(JSON.stringify(first)).not.toContain(Array.from(root).join(","));
    expect(await unwrapSyncVaultRootKey(
      first,
      context,
      recipient.agreementPrivateKey,
    )).toEqual(root);

    const contextMutations = [
      { tenantId: opaque("synctenant", "x") },
      { organizationId: opaque("syncorg", "x") },
      { ownerUserId: opaque("syncuser", "x") },
      { vaultId: opaque("syncvault", "x") },
      { vaultGeneration: "2" },
      { membershipEpoch: "4" },
      { rootKeyEpoch: "5" },
      { recipientDeviceId: opaque("syncdevice", "x") },
      { recipientAgreementKeyId: opaque("synckey", "x") },
    ] as const;
    for (const mutation of contextMutations) {
      const altered = syncVaultRootWrapContextSchema.parse({ ...context, ...mutation });
      expect(unwrapSyncVaultRootKey(
        { ...first, context: altered },
        altered,
        recipient.agreementPrivateKey,
      )).rejects.toThrow("authentication");
    }
    const other = await createSyncDeviceKeyPairs();
    expect(unwrapSyncVaultRootKey(first, context, other.agreementPrivateKey)).rejects.toThrow();
  });

  test("commits the exact current root-wrap manifest independent of transport order", async () => {
    const firstRecipient = await createSyncDeviceKeyPairs();
    const secondRecipient = await createSyncDeviceKeyPairs();
    const root = createSyncVaultRootKey();
    const first = await wrapSyncVaultRootKey(
      root,
      syncVaultRootWrapContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "3",
        rootKeyEpoch: "4",
        recipientDeviceId: deviceId,
        recipientAgreementKeyId: firstRecipient.publicKeys.agreement.keyId,
      }),
      firstRecipient.publicKeys.agreement.publicKey,
    );
    const second = await wrapSyncVaultRootKey(
      root,
      syncVaultRootWrapContextSchema.parse({
        ...first.context,
        recipientDeviceId: opaque("syncdevice", "e"),
        recipientAgreementKeyId: secondRecipient.publicKeys.agreement.keyId,
      }),
      secondRecipient.publicKeys.agreement.publicKey,
    );
    const digest = await digestSyncVaultRootWrapManifest([first, second]);
    expect(await digestSyncVaultRootWrapManifest([second, first])).toBe(digest);
    expect(await digestSyncVaultRootWrapManifest([first, wrappedSyncVaultRootKeySchema.parse({
      ...second,
      nonce: flipBase64Url(second.nonce),
    })])).not.toBe(digest);
    expect(digestSyncVaultRootWrapManifest([first, wrappedSyncVaultRootKeySchema.parse({
      ...second,
      context: { ...second.context, recipientDeviceId: deviceId },
    })])).rejects.toThrow("pairs");
    expect(await digestSyncVaultRootWrapManifest([first, wrappedSyncVaultRootKeySchema.parse({
      ...second,
      context: { ...second.context, rootKeyEpoch: "5" },
    })])).not.toBe(digest);
    expect(digestSyncVaultRootWrapManifest([first, wrappedSyncVaultRootKeySchema.parse({
      ...second,
      context: { ...second.context, membershipEpoch: "4" },
    })])).rejects.toThrow("authority");
  });

  test("opens authenticated backward root links and rejects every substitution", async () => {
    const parentRoot = createSyncVaultRootKey();
    const childRoot = createSyncVaultRootKey();
    const context = syncVaultRootKeyLinkContextSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "4",
      parentRootKeyEpoch: "4",
      parentRootKeyCommitment: await commitSyncVaultRootKey(parentRoot),
      childRootKeyEpoch: "5",
      childRootKeyCommitment: await commitSyncVaultRootKey(childRoot),
    });
    const link = await wrapSyncParentVaultRootKey(parentRoot, childRoot, context);
    expect(link.linkDigest).toBe(await digestSyncVaultRootKeyLink(link));
    expect(await unwrapSyncParentVaultRootKey(link, context, childRoot)).toEqual(parentRoot);
    expect(syncVaultRootKeyLinkContextSchema.safeParse({
      ...context,
      childRootKeyEpoch: context.parentRootKeyEpoch,
    }).success).toBeFalse();
    expect(syncVaultRootKeyLinkContextSchema.safeParse({
      ...context,
      childRootKeyEpoch: "3",
    }).success).toBeFalse();

    expect(unwrapSyncParentVaultRootKey(wrappedSyncVaultRootKeyLinkSchema.parse({
      ...link,
      ciphertext: flipBase64Url(link.ciphertext),
    }), context, childRoot)).rejects.toThrow("ciphertext digest");
    expect(unwrapSyncParentVaultRootKey(wrappedSyncVaultRootKeyLinkSchema.parse({
      ...link,
      linkDigest: `sha256_${"f".repeat(64)}`,
    }), context, childRoot)).rejects.toThrow("link digest");
    const wrongChildRoot = createSyncVaultRootKey();
    expect(unwrapSyncParentVaultRootKey(
      link,
      context,
      wrongChildRoot,
    )).rejects.toThrow("child commitment");
    const substitutedContext = syncVaultRootKeyLinkContextSchema.parse({
      ...context,
      membershipEpoch: "5",
    });
    expect(unwrapSyncParentVaultRootKey(
      { ...link, context: substitutedContext },
      substitutedContext,
      childRoot,
    )).rejects.toThrow("link digest");
  });

  test("derives per-session epoch keys and authenticates every summary routing coordinate", async () => {
    const root = createSyncVaultRootKey();
    const currentHeader = header();
    const keyContext = sessionContentKeyContextSchema.parse({
      version: 1,
      ...vault,
      sessionId: currentHeader.sessionId,
      keyEpoch: currentHeader.keyEpoch,
      originDeviceId: currentHeader.originDeviceId,
      mirrorEpoch: currentHeader.mirrorEpoch,
      writerGeneration: currentHeader.writerGeneration,
    });
    const key = await deriveSessionContentKey(root, keyContext);
    const nonceState = createSessionSyncNonceState(currentHeader.keyEpoch, currentHeader.syncSequence);
    const { allocation } = allocateSessionSyncNonce(nonceState, currentHeader.syncSequence);
    const encrypted = await sealSessionSummary(summary(), currentHeader, key, allocation);
    expect(sealSessionSummary(summary(), currentHeader, key, {
      ...allocation,
      nonce: "AAAAAAAAAAAAAAAA" as never,
    })).rejects.toThrow("closed sequence domain");
    expect(JSON.stringify(encrypted)).not.toContain("Harden gateway recovery");
    expect(await openSessionSummary(encrypted, currentHeader, key)).toEqual(summary());

    const coordinateMutations = [
      { tenantId: opaque("synctenant", "x") },
      { organizationId: opaque("syncorg", "x") },
      { ownerUserId: opaque("syncuser", "x") },
      { vaultId: opaque("syncvault", "x") },
      { vaultGeneration: "2" },
      { membershipEpoch: "4" },
      { originDeviceId: opaque("syncdevice", "x") },
      { sessionId: opaque("syncsession", "x") },
      { mirrorEpoch: "3" },
      { writerGeneration: "5" },
      { bootId: opaque("syncboot", "x") },
      { bootGeneration: "6" },
      { directoryOrdinal: "7" },
      { keyEpoch: "9" },
      { syncSequence: "10" },
      { sourceRevision: "11" },
      { eventKind: "terminal" },
      { previousDigest: `sha256_${"b".repeat(64)}` },
    ] as const;
    for (const mutation of coordinateMutations) {
      const alteredHeader = header(mutation);
      expect(openSessionSummary(
        { ...encrypted, header: alteredHeader },
        alteredHeader,
        key,
      )).rejects.toThrow();
    }
    expect(openSessionSummary(
      sealedSessionSummarySchema.parse({
        ...encrypted,
        nonce: flipBase64Url(encrypted.nonce),
      }),
      currentHeader,
      key,
    )).rejects.toThrow("nonce");
    expect(sealedSessionSummarySchema.safeParse({
      ...encrypted,
      ciphertext: flipBase64Url(encrypted.ciphertext),
    }).success).toBeTrue();
    expect(openSessionSummary(
      sealedSessionSummarySchema.parse({
        ...encrypted,
        ciphertext: flipBase64Url(encrypted.ciphertext),
      }),
      currentHeader,
      key,
    )).rejects.toThrow("digest");

    const foreignContext = sessionContentKeyContextSchema.parse({
      ...keyContext,
      sessionId: opaque("syncsession", "x"),
    });
    const foreignKey = await deriveSessionContentKey(root, foreignContext);
    expect(openSessionSummary(encrypted, currentHeader, foreignKey)).rejects.toThrow("authentication");
    for (const mutation of [
      { originDeviceId: opaque("syncdevice", "x") },
      { mirrorEpoch: "3" },
      { writerGeneration: "5" },
    ]) {
      const writerKey = await deriveSessionContentKey(root, sessionContentKeyContextSchema.parse({
        ...keyContext,
        ...mutation,
      }));
      expect(openSessionSummary(encrypted, currentHeader, writerKey)).rejects.toThrow("authentication");
    }
  });

  test("requires durable contiguous nonce state and rotates before uint64 exhaustion", () => {
    const state = createSessionSyncNonceState("8", "9");
    const first = allocateSessionSyncNonce(state, "9");
    expect(String(first.allocation.sequence)).toBe("9");
    expect(String(first.nextState?.nextSequence)).toBe("10");
    expect(() => allocateSessionSyncNonce(state, "10")).toThrow("contiguous");
    const second = allocateSessionSyncNonce(first.nextState!, "10");
    expect(first.allocation.nonce).not.toBe(second.allocation.nonce);

    const final = allocateSessionSyncNonce(
      createSessionSyncNonceState("8", "18446744073709551615"),
      "18446744073709551615",
    );
    expect(final.nextState).toBeNull();
  });

  test("rejects summary/header mismatches and plaintext fields before encryption", async () => {
    const root = createSyncVaultRootKey();
    const currentHeader = header();
    const key = await deriveSessionContentKey(root, sessionContentKeyContextSchema.parse({
      version: 1,
      ...vault,
      sessionId: currentHeader.sessionId,
      keyEpoch: currentHeader.keyEpoch,
      originDeviceId: currentHeader.originDeviceId,
      mirrorEpoch: currentHeader.mirrorEpoch,
      writerGeneration: currentHeader.writerGeneration,
    }));
    const allocation = allocateSessionSyncNonce(
      createSessionSyncNonceState(currentHeader.keyEpoch, currentHeader.syncSequence),
    ).allocation;
    expect(sealSessionSummary(
      sessionSummarySchema.parse({ ...summary(), sourceRevision: "11" }),
      currentHeader,
      key,
      allocation,
    )).rejects.toThrow("routing coordinates");
    const forbiddenSummary: ReturnType<typeof summary> & { readonly prompt: string } = {
      ...summary(),
      prompt: "private prompt",
    };
    expect(sealSessionSummary(
      forbiddenSummary,
      currentHeader,
      key,
      allocation,
    )).rejects.toThrow("prompt");
  });

  test("canonical JSON is insertion-order independent and rejects unsafe values", () => {
    expect(canonicalSessionSyncJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalSessionSyncJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(canonicalSessionSyncJson({ "ä": 1, z: 2, A: 3 })).toBe(
      '{"A":3,"z":2,"ä":1}',
    );
    expect(() => canonicalSessionSyncJson({ unsafe: Number.MAX_SAFE_INTEGER + 1 })).toThrow("safe integers");
    expect(() => canonicalSessionSyncJson({ missing: undefined })).toThrow("unsupported");
  });
});

function flipBase64Url(value: string): string {
  const first = value[0];
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}
