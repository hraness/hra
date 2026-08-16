import { describe, expect, test } from "bun:test";

import {
  MAX_SYNC_ACTIVE_STREAMS,
  MAX_SYNC_DEVICES,
  MAX_SYNC_DIRECTORY_PAGE_SIZE,
  MAX_SYNC_DIRECTORY_SESSIONS,
  MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE,
  MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
  MAX_SYNC_RETAINED_EVENTS,
  SESSION_SYNC_FORBIDDEN_FIELDS,
  SESSION_SYNC_PROTOCOL,
  SYNC_UINT64_MAX,
  assertObservationOnlySyncValue,
  decodeSyncUint64,
  encodeSyncUint64,
  nextSyncUint64,
  retiredSessionIdFenceSchema,
  sealedSessionSummarySchema,
  sessionDirectoryChangePageSchema,
  sessionDirectorySnapshotPageSchema,
  sessionSummarySchema,
  sessionSyncHeaderSchema,
  sessionSyncHelloSchema,
  sessionSyncQuotaUsageSchema,
  sessionSyncTombstoneSchema,
  syncDeviceProofPayloadSchema,
  syncDevicePublicKeysSchema,
  syncEnrollmentPossessionProofPayloadSchema,
  syncMembershipHeadSchema,
  syncMembershipStatementSchema,
  syncUint64Schema,
  syncVaultCoordinateSchema,
  type SealedSessionSummary,
  type SessionSyncTombstone,
  type SyncDevicePublicKeys,
} from "./session-sync";

const digestA = `sha256_${"a".repeat(64)}`;
const digestB = `sha256_${"b".repeat(64)}`;
const digestC = `sha256_${"c".repeat(64)}`;

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

const tenant = {
  tenantId: opaque("synctenant", "t"),
  organizationId: opaque("syncorg", "o"),
  ownerUserId: opaque("syncuser", "u"),
} as const;
const vault = syncVaultCoordinateSchema.parse({
  ...tenant,
  vaultId: opaque("syncvault", "v"),
  vaultGeneration: "1",
});
const originDeviceId = opaque("syncdevice", "d");
const sessionId = opaque("syncsession", "s");

function header(overrides: Record<string, unknown> = {}) {
  return sessionSyncHeaderSchema.parse({
    protocol: SESSION_SYNC_PROTOCOL,
    payloadVersion: 1,
    payloadKind: "session_summary",
    ...vault,
    membershipEpoch: "1",
    originDeviceId,
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
    creationGrantDigest: digestA,
    ...overrides,
  });
}

function sealed(overrides: Record<string, unknown> = {}): SealedSessionSummary {
  return sealedSessionSummarySchema.parse({
    header: header(),
    algorithm: "P256-HKDF-SHA256-A256GCM",
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(23),
    ciphertextBytes: 17,
    ciphertextDigest: digestB,
    ...overrides,
  });
}

function tombstone(overrides: Record<string, unknown> = {}): SessionSyncTombstone {
  return sessionSyncTombstoneSchema.parse({
    protocol: SESSION_SYNC_PROTOCOL,
    recordKind: "tombstone",
    ...vault,
    membershipEpoch: "2",
    originDeviceId,
    sessionId,
    mirrorEpoch: "1",
    writerGeneration: "2",
    bootId: opaque("syncboot", "b"),
    bootGeneration: "2",
    directoryOrdinal: "1",
    createdDirectoryVersion: "1",
    directoryVersion: "2",
    keyEpoch: "2",
    syncSequence: "2",
    sourceRevision: "2",
    previousDigest: digestB,
    tombstoneDigest: digestC,
    serverObservedAt: "1000",
    purgeAfter: "2000",
    ...overrides,
  });
}

const publicKeys = syncDevicePublicKeysSchema.parse({
  version: 1,
  signing: {
    keyId: opaque("synckey", "k"),
    algorithm: "P256-SHA256",
    publicKey: "A".repeat(87),
    publicKeyDigest: digestA,
  },
  agreement: {
    keyId: opaque("synckey", "l"),
    algorithm: "P256-ECDH",
    publicKey: `B${"A".repeat(86)}`,
    publicKeyDigest: digestB,
  },
});

describe("observation-only session sync wire", () => {
  test("encodes the entire uint64 range canonically without JSON number loss", () => {
    expect(String(encodeSyncUint64(0n))).toBe("0");
    expect(String(encodeSyncUint64(SYNC_UINT64_MAX))).toBe("18446744073709551615");
    expect(decodeSyncUint64("9007199254740993")).toBe(9_007_199_254_740_993n);
    expect(String(nextSyncUint64("9007199254740993"))).toBe("9007199254740994");
    expect(nextSyncUint64("18446744073709551615")).toBeNull();

    for (const invalid of ["", "00", "01", "-1", "+1", "1.0", "18446744073709551616"]) {
      expect(syncUint64Schema.safeParse(invalid).success).toBeFalse();
    }
    expect(() => encodeSyncUint64(-1n)).toThrow(RangeError);
    expect(() => encodeSyncUint64(SYNC_UINT64_MAX + 1n)).toThrow(RangeError);
  });

  test("accepts only the bounded SessionSummary projection and rejects local or provider data", () => {
    const summary = sessionSummarySchema.parse({
      version: 1,
      sessionId,
      ownerDeviceId: originDeviceId,
      directoryOrdinal: "1",
      sourceRevision: "7",
      title: "Fix projection recovery",
      repositoryDisplayName: "example",
      modelEffort: "ultra",
      state: "working",
      originUpdatedAt: "9007199254740993",
      deleted: false,
    });
    expect(summary.title).toBe("Fix projection recovery");
    expect(sessionSummarySchema.safeParse({ ...summary, prompt: "secret" }).success).toBeFalse();
    expect(sessionSummarySchema.safeParse({ ...summary, title: "x".repeat(257) }).success).toBeFalse();
    expect(sessionSummarySchema.safeParse({ ...summary, title: "line\nbreak" }).success).toBeFalse();
    for (const dangerous of [
      "right\u202eto-left",
      "isolate\u2066payload\u2069",
      "zero\u200bwidth",
      "word\u2060joiner",
      "bom\ufeffmarker",
    ]) {
      expect(sessionSummarySchema.safeParse({ ...summary, title: dangerous }).success).toBeFalse();
    }
    expect(sessionSummarySchema.safeParse({
      ...summary,
      title: "Fix 👩‍💻 sync café 日本語",
    }).success).toBeTrue();

    for (const field of SESSION_SYNC_FORBIDDEN_FIELDS) {
      expect(() => assertObservationOnlySyncValue({ safe: { [field]: "private" } })).toThrow(field);
    }
    expect(() => assertObservationOnlySyncValue(summary)).not.toThrow();
    for (const field of [
      "response",
      "transcript",
      "reasoning",
      "assistantMessage",
      "userMessage",
      "content",
      "body",
    ]) {
      expect(() => assertObservationOnlySyncValue({ envelope: [{ [field]: "private" }] }))
        .toThrow(field);
    }
  });

  test("locks genesis, predecessor, grant, and measured-ciphertext invariants", () => {
    expect(String(header().syncSequence)).toBe("1");
    expect(() => header({ creationGrantDigest: undefined })).toThrow("creation grant");
    expect(() => header({ previousDigest: digestA })).toThrow("sequence one");
    expect(() => header({
      eventKind: "projection_changed",
      syncSequence: "2",
      previousDigest: digestA,
      creationGrantDigest: undefined,
    })).not.toThrow();
    expect(() => header({
      eventKind: "projection_changed",
      syncSequence: "2",
      previousDigest: null,
      creationGrantDigest: undefined,
    })).toThrow("predecessor");
    expect(sealedSessionSummarySchema.safeParse({ ...sealed(), ciphertextBytes: 18 }).success).toBeFalse();
  });

  test("models hash-chained membership with unique devices and signatures", () => {
    const member = {
      deviceId: originDeviceId,
      name: "Studio Mac",
      status: "active",
      keys: publicKeys,
      approvedAt: "100",
    } as const;
    const statement = syncMembershipStatementSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "1",
      previousMembershipDigest: null,
      recoveryGeneration: "1",
      enrollmentPairingDigest: null,
      rootKeyEpoch: "1",
      rootKeyCommitment: digestA,
      rootWrapManifestDigest: digestB,
      rootKeyLinkDigest: null,
      recoveryRootWrapDigest: digestC,
      members: [member],
    });
    expect(syncMembershipHeadSchema.parse({
      statement,
      statementDigest: digestA,
      signatures: [{
        deviceId: originDeviceId,
        signingKeyId: publicKeys.signing.keyId,
        signature: "A".repeat(86),
      }],
    }).signatures).toHaveLength(1);
    expect(syncMembershipStatementSchema.safeParse({
      ...statement,
      members: [member, member],
    }).success).toBeFalse();
    expect(syncMembershipStatementSchema.safeParse({
      ...statement,
      members: [{ ...member, status: "revoked", revokedAt: "200" }],
    }).success).toBeFalse();
    expect(syncMembershipStatementSchema.safeParse({
      ...statement,
      rootKeyEpoch: "2",
    }).success).toBeFalse();
    expect(syncMembershipStatementSchema.safeParse({
      ...statement,
      rootKeyLinkDigest: digestC,
    }).success).toBeFalse();
    expect(syncMembershipStatementSchema.safeParse({
      ...statement,
      enrollmentPairingDigest: digestC,
    }).success).toBeFalse();
    expect(syncMembershipHeadSchema.safeParse({
      statement,
      statementDigest: digestA,
      signatures: [
        { deviceId: originDeviceId, signingKeyId: publicKeys.signing.keyId, signature: "A".repeat(86) },
        { deviceId: originDeviceId, signingKeyId: publicKeys.signing.keyId, signature: "B".repeat(86) },
      ],
    }).success).toBeFalse();
  });

  test("binds short-lived device proofs to a closed method, route, body, and scope", () => {
    const proof = syncDeviceProofPayloadSchema.parse({
      version: 1,
      ...vault,
      membershipEpoch: "3",
      deviceId: originDeviceId,
      method: "POST",
      route: "sync.session.publish",
      bodyDigest: digestA,
      nonce: opaque("syncproof", "n"),
      issuedAt: "1000",
      expiresAt: "121000",
    });
    expect(proof.route).toBe("sync.session.publish");
    expect(syncDeviceProofPayloadSchema.safeParse({ ...proof, route: "/arbitrary" }).success).toBeFalse();
    expect(syncDeviceProofPayloadSchema.safeParse({ ...proof, method: "PUT" }).success).toBeFalse();
    expect(syncDeviceProofPayloadSchema.safeParse({ ...proof, expiresAt: "121001" }).success).toBeFalse();

    const enrollment = syncEnrollmentPossessionProofPayloadSchema.parse({
      version: 1,
      purpose: "submit",
      vaultId: vault.vaultId,
      vaultGeneration: vault.vaultGeneration,
      deviceId: originDeviceId,
      bodyDigest: digestA,
      nonce: opaque("syncproof", "e"),
      issuedAt: "1000",
      expiresAt: "121000",
    });
    expect(syncEnrollmentPossessionProofPayloadSchema.safeParse({
      ...enrollment,
      expiresAt: "120999",
    }).success).toBeFalse();
  });

  test("pages a pinned directory in stable ordinal/session order", () => {
    const secondHeader = header({
      sessionId: opaque("syncsession", "z"),
      directoryOrdinal: "2",
    });
    const second = sealed({ header: secondHeader });
    const page = sessionDirectorySnapshotPageSchema.parse({
      version: 1,
      vault,
      snapshotVersion: "2",
      entries: [
        {
          kind: "head",
          accepted: {
            envelope: sealed(),
            createdDirectoryVersion: "1",
            directoryVersion: "1",
            serverObservedAt: "1000",
          },
        },
        {
          kind: "head",
          accepted: {
            envelope: second,
            createdDirectoryVersion: "2",
            directoryVersion: "2",
            serverObservedAt: "1001",
          },
        },
      ],
      complete: false,
      nextCursor: { directoryOrdinal: "2", sessionId: secondHeader.sessionId },
    });
    expect(page.entries).toHaveLength(2);
    expect(sessionDirectorySnapshotPageSchema.safeParse({
      ...page,
      entries: [...page.entries].reverse(),
    }).success).toBeFalse();
    expect(sessionDirectorySnapshotPageSchema.safeParse({
      ...page,
      snapshotVersion: "1",
    }).success).toBeFalse();
    expect(sessionDirectorySnapshotPageSchema.safeParse({
      ...page,
      complete: true,
    }).success).toBeFalse();
  });

  test("requires contiguous directory changes and preserves absorbing retirement fences", () => {
    const retired = retiredSessionIdFenceSchema.parse({
      protocol: SESSION_SYNC_PROTOCOL,
      recordKind: "retired_session_id",
      ...vault,
      sessionId,
      directoryOrdinal: "1",
      createdDirectoryVersion: "1",
      retirementDirectoryVersion: "3",
      retiredAt: "3000",
      tombstoneDigest: digestC,
    });
    const page = sessionDirectoryChangePageSchema.parse({
      version: 1,
      vault,
      afterVersion: "0",
      changes: [
        {
          kind: "upsert",
          accepted: {
            envelope: sealed(),
            createdDirectoryVersion: "1",
            directoryVersion: "1",
            serverObservedAt: "1000",
          },
        },
        { kind: "tombstone", tombstone: tombstone() },
        { kind: "retired", fence: retired },
      ],
      nextVersion: "3",
      hasMore: false,
    });
    expect(page.changes.map(({ kind }) => kind)).toEqual(["upsert", "tombstone", "retired"]);
    expect(sessionDirectoryChangePageSchema.safeParse({
      ...page,
      changes: [page.changes[0], page.changes[2]],
      nextVersion: "3",
    }).success).toBeFalse();
    expect(sessionSyncTombstoneSchema.safeParse({ ...tombstone(), purgeAfter: "999" }).success).toBeFalse();
  });

  test("round trips retired fences in imported directory snapshots", () => {
    const retired = retiredSessionIdFenceSchema.parse({
      protocol: SESSION_SYNC_PROTOCOL,
      recordKind: "retired_session_id",
      ...vault,
      sessionId,
      directoryOrdinal: "1",
      createdDirectoryVersion: "1",
      retirementDirectoryVersion: "3",
      retiredAt: "3000",
      tombstoneDigest: digestC,
    });
    const page = sessionDirectorySnapshotPageSchema.parse({
      version: 1,
      vault,
      snapshotVersion: "3",
      entries: [{ kind: "retired", fence: retired }],
      complete: true,
    });
    expect(sessionDirectorySnapshotPageSchema.parse(
      JSON.parse(JSON.stringify(page)) as unknown,
    )).toEqual(page);
    expect(sessionDirectorySnapshotPageSchema.safeParse({
      ...page,
      snapshotVersion: "2",
    }).success).toBeFalse();
  });

  test("enforces every declared product and allocation quota before admission", () => {
    const atLimit = sessionSyncQuotaUsageSchema.parse({
      activeDevices: MAX_SYNC_DEVICES,
      locallyOwnedSessions: MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE,
      directorySessions: MAX_SYNC_DIRECTORY_SESSIONS,
      activeStreams: MAX_SYNC_ACTIVE_STREAMS,
      retainedEvents: MAX_SYNC_RETAINED_EVENTS,
      retainedCiphertextBytes: String(MAX_SYNC_RETAINED_CIPHERTEXT_BYTES),
    });
    expect(atLimit.directorySessions).toBe(512);
    for (const [field, value] of [
      ["activeDevices", MAX_SYNC_DEVICES + 1],
      ["locallyOwnedSessions", MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE + 1],
      ["directorySessions", MAX_SYNC_DIRECTORY_SESSIONS + 1],
      ["activeStreams", MAX_SYNC_ACTIVE_STREAMS + 1],
      ["retainedEvents", MAX_SYNC_RETAINED_EVENTS + 1],
    ] as const) {
      expect(sessionSyncQuotaUsageSchema.safeParse({ ...atLimit, [field]: value }).success).toBeFalse();
    }
    expect(sessionSyncQuotaUsageSchema.safeParse({
      ...atLimit,
      retainedCiphertextBytes: String(MAX_SYNC_RETAINED_CIPHERTEXT_BYTES + 1),
    }).success).toBeFalse();
    expect(MAX_SYNC_DIRECTORY_PAGE_SIZE).toBe(100);
  });

  test("negotiates only the observation release's closed capabilities", () => {
    expect(sessionSyncHelloSchema.parse({
      protocol: SESSION_SYNC_PROTOCOL,
      minimumVersion: 1,
      maximumVersion: 1,
      capabilities: ["device_enrollment", "summary_publication", "remote_observation"],
    }).capabilities).toHaveLength(3);
    expect(sessionSyncHelloSchema.safeParse({
      protocol: SESSION_SYNC_PROTOCOL,
      minimumVersion: 1,
      maximumVersion: 1,
      capabilities: ["remote_commands"],
    }).success).toBeFalse();
  });
});

void (publicKeys satisfies SyncDevicePublicKeys);
