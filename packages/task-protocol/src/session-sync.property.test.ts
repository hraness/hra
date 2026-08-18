import { expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  SESSION_SYNC_FORBIDDEN_FIELDS,
  SESSION_SYNC_PROTOCOL,
  SYNC_UINT64_MAX,
  assertObservationOnlySyncValue,
  decodeSyncUint64,
  encodeSyncUint64,
  retiredSessionIdFenceSchema,
  sealedSessionSummarySchema,
  sessionDirectoryChangePageSchema,
  sessionDirectorySnapshotPageSchema,
  sessionContentKeyContextSchema,
  sessionSummarySchema,
  sessionSyncHeaderSchema,
  sessionSyncQuotaUsageSchema,
  sessionSyncTombstoneSchema,
  syncDeviceProofPayloadSchema,
  syncDeviceProofSchema,
  syncDevicePublicKeysSchema,
  syncEnrollmentPossessionProofPayloadSchema,
  syncEnrollmentPossessionProofSchema,
  syncMembershipHeadSchema,
  syncMembershipStatementSchema,
  syncRouteValues,
  syncUint64Schema,
  syncVaultCoordinateSchema,
  syncVaultRootKeyLinkContextSchema,
  syncVaultRootWrapContextSchema,
  wrappedSyncVaultRootKeyLinkSchema,
  wrappedSyncVaultRootKeySchema,
  type WrappedSyncVaultRootKey,
} from "./session-sync";
import {
  allocateSessionSyncNonce,
  commitSyncVaultRootKey,
  createSessionSyncNonceState,
  createSyncDeviceKeyPairs,
  createSyncProofNonce,
  createSyncVaultRootKey,
  deriveSessionContentKey,
  digestSyncRequestBody,
  digestSyncVaultRootWrapManifest,
  openSessionSummary,
  sealSessionSummary,
  signSyncDeviceProof,
  verifySyncDeviceProof,
  unwrapSyncParentVaultRootKey,
  wrapSyncParentVaultRootKey,
  wrapSyncVaultRootKey,
} from "./session-sync-crypto";
import {
  recoverSyncVaultRequestSchema,
  syncRecoveryAuthorizationSchema,
  syncRecoveryStatementSchema,
  syncRecoveryVaultRootWrapContextSchema,
  wrappedSyncRecoveryVaultRootKeySchema,
} from "./session-sync-recovery";
import { syncRecoveryKitSchema } from "./session-sync-recovery-crypto";

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
const deviceId = opaque("syncdevice", "d");
const sessionId = opaque("syncsession", "s");
const header = sessionSyncHeaderSchema.parse({
  protocol: SESSION_SYNC_PROTOCOL,
  payloadVersion: 1,
  payloadKind: "session_summary",
  ...vault,
  membershipEpoch: "1",
  originDeviceId: deviceId,
  sessionId,
  mirrorEpoch: "1",
  writerGeneration: "1",
  bootId: opaque("syncboot", "b"),
  bootGeneration: "1",
  directoryOrdinal: "1",
  keyEpoch: "1",
  syncSequence: "1",
  sourceRevision: "1",
  eventKind: "created",
  previousDigest: null,
  creationGrantDigest: `sha256_${"a".repeat(64)}`,
});

test("property: canonical uint64 encoding round trips without number coercion", () => {
  fc.assert(fc.property(
    fc.bigInt({ min: 0n, max: SYNC_UINT64_MAX }),
    (value) => {
      const encoded = encodeSyncUint64(value);
      expect(decodeSyncUint64(encoded)).toBe(value);
      expect(syncUint64Schema.parse(String(encoded))).toBe(encoded);
    },
  ), { numRuns: 200 });
});

test("property: sync schemas remain total over arbitrary foreign JSON-like values", () => {
  fc.assert(fc.property(fc.anything(), (value) => {
    for (const schema of [
      sessionSummarySchema,
      sessionSyncHeaderSchema,
      sealedSessionSummarySchema,
      syncDevicePublicKeysSchema,
      syncMembershipStatementSchema,
      syncMembershipHeadSchema,
      syncDeviceProofPayloadSchema,
      syncDeviceProofSchema,
      syncEnrollmentPossessionProofPayloadSchema,
      syncEnrollmentPossessionProofSchema,
      syncVaultRootKeyLinkContextSchema,
      wrappedSyncVaultRootKeyLinkSchema,
      sessionSyncTombstoneSchema,
      retiredSessionIdFenceSchema,
      sessionDirectorySnapshotPageSchema,
      sessionDirectoryChangePageSchema,
      sessionSyncQuotaUsageSchema,
      syncRecoveryStatementSchema,
      syncRecoveryAuthorizationSchema,
      recoverSyncVaultRequestSchema,
      syncRecoveryVaultRootWrapContextSchema,
      wrappedSyncRecoveryVaultRootKeySchema,
      syncRecoveryKitSchema,
    ]) expect(() => schema.safeParse(value)).not.toThrow();
  }), { numRuns: 300 });
});

test("property: every persisted contiguous allocation has a unique 96-bit nonce", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 1_000_000 }),
    (start) => {
      let state = createSessionSyncNonceState("1", String(start));
      const nonces = new Set<string>();
      for (let offset = 0; offset < 64; offset += 1) {
        const sequence = String(start + offset);
        const allocated = allocateSessionSyncNonce(state, sequence);
        nonces.add(allocated.allocation.nonce);
        if (allocated.nextState === null) throw new Error("unexpected uint64 exhaustion");
        state = allocated.nextState;
      }
      expect(nonces.size).toBe(64);
    },
  ), { numRuns: 100 });
});

test("property: every authenticated child root opens its exact backward parent link", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uint8Array({ minLength: 32, maxLength: 32 }),
    fc.uint8Array({ minLength: 32, maxLength: 32 }),
    fc.integer({ min: 1, max: 10_000 }),
    fc.integer({ min: 1, max: 1_000 }),
    async (parentRoot, childRoot, parentEpoch, epochAdvance) => {
      const context = syncVaultRootKeyLinkContextSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "2",
        parentRootKeyEpoch: String(parentEpoch),
        parentRootKeyCommitment: await commitSyncVaultRootKey(parentRoot),
        childRootKeyEpoch: String(parentEpoch + epochAdvance),
        childRootKeyCommitment: await commitSyncVaultRootKey(childRoot),
      });
      const link = await wrapSyncParentVaultRootKey(parentRoot, childRoot, context);
      expect(await unwrapSyncParentVaultRootKey(link, context, childRoot)).toEqual(parentRoot);
    },
  ), { numRuns: 30 });
});

test("property: historical root-wrap manifests ignore order and detect epoch substitution", async () => {
  const recipients = await Promise.all([
    createSyncDeviceKeyPairs(),
    createSyncDeviceKeyPairs(),
  ]);
  const recipientIds = [
    opaque("syncdevice", "d"),
    opaque("syncdevice", "e"),
  ] as const;
  const roots = [createSyncVaultRootKey(), createSyncVaultRootKey()];
  const wraps: WrappedSyncVaultRootKey[] = [];
  for (const [rootIndex, root] of roots.entries()) {
    for (const [recipientIndex, recipient] of recipients.entries()) {
      wraps.push(await wrapSyncVaultRootKey(
        root,
        syncVaultRootWrapContextSchema.parse({
          version: 1,
          ...vault,
          membershipEpoch: "3",
          rootKeyEpoch: String(rootIndex + 1),
          recipientDeviceId: recipientIds[recipientIndex],
          recipientAgreementKeyId: recipient.publicKeys.agreement.keyId,
        }),
        recipient.publicKeys.agreement.publicKey,
      ));
    }
  }
  const expected = await digestSyncVaultRootWrapManifest(wraps);
  await fc.assert(fc.asyncProperty(
    fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 4, maxLength: 4 }),
    fc.integer({ min: 0, max: 3 }),
    async (sortKeys, substitutedIndex) => {
      const permutation = wraps.map((wrap, index) => ({ wrap, index }))
        .sort((left, right) => (sortKeys[left.index] ?? 0) - (sortKeys[right.index] ?? 0)
          || left.index - right.index)
        .map(({ wrap }) => wrap);
      expect(await digestSyncVaultRootWrapManifest(permutation)).toBe(expected);
      const substituted = permutation.map((wrap, index) => index === substitutedIndex
        ? wrappedSyncVaultRootKeySchema.parse({
            ...wrap,
            context: { ...wrap.context, rootKeyEpoch: "3" },
          })
        : wrap);
      expect(await digestSyncVaultRootWrapManifest(substituted)).not.toBe(expected);
    },
  ), { numRuns: 50 });
});

test("property: bounded observation summaries encrypt and round trip exactly", async () => {
  const root = createSyncVaultRootKey();
  const key = await deriveSessionContentKey(root, sessionContentKeyContextSchema.parse({
    version: 1,
    ...vault,
    sessionId,
    keyEpoch: "1",
    originDeviceId: deviceId,
    mirrorEpoch: "1",
    writerGeneration: "1",
  }));
  const titleArbitrary = fc.array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz 0123456789"),
    { minLength: 1, maxLength: 80 },
  ).map((characters) => characters.join(""));
  await fc.assert(fc.asyncProperty(
    titleArbitrary,
    fc.constantFrom("ready", "working", "attention", "error", "offline"),
    async (title, state) => {
      const value = sessionSummarySchema.parse({
        version: 1,
        sessionId,
        ownerDeviceId: deviceId,
        directoryOrdinal: "1",
        sourceRevision: "1",
        title,
        state,
        deleted: false,
      });
      const allocation = allocateSessionSyncNonce(
        createSessionSyncNonceState("1", "1"),
      ).allocation;
      const sealed = await sealSessionSummary(value, header, key, allocation);
      expect(JSON.stringify(sealed)).not.toContain('"title":');
      expect(await openSessionSummary(sealed, header, key)).toEqual(value);
    },
  ), { numRuns: 40 });
});

test("property: every forbidden observation field is rejected at arbitrary depth", () => {
  fc.assert(fc.property(
    fc.constantFrom(...SESSION_SYNC_FORBIDDEN_FIELDS),
    fc.integer({ min: 0, max: 5 }),
    (field, depth) => {
      let value: unknown = { [field]: "private" };
      for (let index = 0; index < depth; index += 1) value = { nested: [value] };
      expect(() => assertObservationOnlySyncValue(value)).toThrow(field);
    },
  ), { numRuns: SESSION_SYNC_FORBIDDEN_FIELDS.length * 2 });
});

test("property: canonical proof signatures cover every closed route and method", async () => {
  const keys = await createSyncDeviceKeyPairs();
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...syncRouteValues),
    fc.constantFrom("GET", "POST"),
    async (route, method) => {
      const payload = syncDeviceProofPayloadSchema.parse({
        version: 1,
        ...vault,
        membershipEpoch: "1",
        deviceId,
        method,
        route,
        bodyDigest: await digestSyncRequestBody({ route, method }),
        nonce: createSyncProofNonce(),
        issuedAt: "1000",
        expiresAt: "121000",
      });
      const proof = await signSyncDeviceProof(
        payload,
        keys.publicKeys.signing.keyId,
        keys.signingPrivateKey,
      );
      expect(await verifySyncDeviceProof(proof, keys.publicKeys, "60000")).toBeTrue();
    },
  ), { numRuns: syncRouteValues.length * 2 });
});
