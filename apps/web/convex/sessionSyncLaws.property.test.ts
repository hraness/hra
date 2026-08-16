import { describe, expect, test } from "bun:test";
import {
  encodeSyncUint64,
  MAX_SYNC_DEVICES,
  MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
  SESSION_SYNC_DEVICE_ONLINE_TTL_MS,
  sealedSessionSummarySchema,
  type SealedSessionSummary,
} from "@hraness/agent-tasks-protocol";
import { assertProperty, fc } from "@hra-internal/test";

import {
  compareSyncIdentifier,
  decideSessionPublication,
  deviceConnectionState,
  enrollmentQuotaFailure,
  quotaFailure,
  syncUint64OrderKey,
  type StoredSessionFence,
} from "./sessionSyncLaws";
import { MAX_SESSION_SYNC_PENDING_ENROLLMENTS } from "./sessionSyncSchemas";

const digest = (character: string) => `sha256_${character.repeat(64)}`;
const id = (prefix: string, character: string) => `${prefix}_${character.repeat(32)}`;
const expectedVault = Object.freeze({
  tenantId: id("synctenant", "t"),
  organizationId: id("syncorg", "o"),
  ownerUserId: id("syncuser", "u"),
  vaultId: id("syncvault", "v"),
  vaultGeneration: "1",
});

function stored(sequence: number): StoredSessionFence {
  return {
    state: "active",
    originDeviceId: id("syncdevice", "d"),
    directoryOrdinal: "4",
    creationGrantDigest: digest("1"),
    creationGrantExpiresAt: 10_000,
    mirrorEpoch: "1",
    writerGeneration: "3",
    writerBootId: id("syncboot", "b"),
    writerBootGeneration: "7",
    currentSequence: encodeSyncUint64(BigInt(sequence)),
    currentDigest: digest("a"),
    currentSourceRevision: encodeSyncUint64(BigInt(sequence)),
    currentKeyEpoch: "2",
  };
}

function envelope(sequence: number, overrides: Record<string, unknown> = {}): SealedSessionSummary {
  return sealedSessionSummarySchema.parse({
    header: {
      protocol: "oprte.session-sync/v1",
      payloadVersion: 1,
      payloadKind: "session_summary",
      ...expectedVault,
      membershipEpoch: "5",
      originDeviceId: id("syncdevice", "d"),
      sessionId: id("syncsession", "s"),
      mirrorEpoch: "1",
      writerGeneration: "3",
      bootId: id("syncboot", "b"),
      bootGeneration: "7",
      directoryOrdinal: "4",
      keyEpoch: "2",
      syncSequence: encodeSyncUint64(BigInt(sequence)),
      sourceRevision: encodeSyncUint64(BigInt(sequence)),
      eventKind: "projection_changed",
      previousDigest: digest("a"),
      ...overrides,
    },
    algorithm: "P256-HKDF-SHA256-A256GCM",
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA",
    ciphertextBytes: 17,
    ciphertextDigest: digest("b"),
  });
}

describe("session sync replication laws", () => {
  test("derives privacy-preserving presence at the exact server-time boundary", () => {
    const now = 1_000_000;
    expect(deviceConnectionState("active", undefined, now)).toBe("unknown");
    expect(deviceConnectionState(
      "active",
      now - SESSION_SYNC_DEVICE_ONLINE_TTL_MS + 1,
      now,
    )).toBe("online");
    expect(deviceConnectionState(
      "active",
      now - SESSION_SYNC_DEVICE_ONLINE_TTL_MS,
      now,
    )).toBe("offline");
    expect(deviceConnectionState(
      "active",
      now - SESSION_SYNC_DEVICE_ONLINE_TTL_MS - 1,
      now,
    )).toBe("offline");
    expect(deviceConnectionState("active", now + 1, now)).toBe("unknown");
    expect(deviceConnectionState("revoked", now, now)).toBe("offline");
    expect(deviceConnectionState("revoked", undefined, now)).toBe("offline");
  });

  test("admits enrollment only below both exact independent quotas", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: MAX_SESSION_SYNC_PENDING_ENROLLMENTS + 2 }),
      fc.integer({ min: 0, max: MAX_SYNC_DEVICES + 2 }),
      (pending, devices) => {
        expect(enrollmentQuotaFailure(pending, devices)).toBe(
          pending >= MAX_SESSION_SYNC_PENDING_ENROLLMENTS
            ? "QUOTA_EXCEEDED"
            : devices >= MAX_SYNC_DEVICES
              ? "DEVICE_LIMIT"
              : null,
        );
      },
    ), { numRuns: 200 });
  });

  test("orders the complete uint64 domain lexicographically without number coercion", () => {
    assertProperty(
      fc.property(
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (left, right) => {
          expect(Math.sign(syncUint64OrderKey(left.toString()).localeCompare(syncUint64OrderKey(right.toString()))))
            .toBe(Math.sign(Number(left - right)));
        },
      ),
      { numRuns: 300 },
    );
  });

  test("orders opaque cursors by deterministic code units across adversarial Unicode", () => {
    const adversarial = [
      "",
      "I",
      "i",
      "z",
      "ä",
      "a\u0308",
      "\u0000",
      "\ud83d",
      "\ude00",
      "\ud83d\ude00",
    ];
    expect(adversarial.toSorted(compareSyncIdentifier)).toEqual([
      "",
      "\u0000",
      "I",
      "a\u0308",
      "i",
      "z",
      "ä",
      "\ud83d",
      "\ud83d\ude00",
      "\ude00",
    ]);
    assertProperty(
      fc.property(fc.string({ maxLength: 24 }), fc.string({ maxLength: 24 }), (left, right) => {
        const expected = left < right ? -1 : left > right ? 1 : 0;
        expect(compareSyncIdentifier(left, right)).toBe(expected);
        const reversed = expected === 0 ? 0 : expected === 1 ? -1 : 1;
        expect(compareSyncIdentifier(right, left)).toBe(reversed);
      }),
      { numRuns: 500 },
    );
  });

  test("accepts exactly the contiguous chain and makes a lost acknowledgement replay stable", () => {
    assertProperty(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (sequence) => {
        const state = stored(sequence);
        expect(decideSessionPublication(state, envelope(sequence + 1), {
          expectedVault,
          currentDeviceId: state.originDeviceId,
          currentBootId: state.writerBootId!,
          currentBootGeneration: state.writerBootGeneration!,
          currentMembershipEpoch: "5",
          currentRootKeyEpoch: "2",
          now: 1,
        })).toEqual({ kind: "accept" });
        expect(decideSessionPublication(
          { ...state, currentDigest: digest("b") },
          envelope(sequence),
          {
            expectedVault,
            currentDeviceId: state.originDeviceId,
            currentBootId: state.writerBootId!,
            currentBootGeneration: state.writerBootGeneration!,
            currentMembershipEpoch: "5",
            currentRootKeyEpoch: "2",
            now: 1,
          },
        )).toEqual({ kind: "replay" });
      }),
      { numRuns: 200 },
    );
  });

  test("rejects gaps, conflicting duplicates, stale writers, boots, memberships, and revisions", () => {
    const state = stored(8);
    const context = {
      expectedVault,
      currentDeviceId: state.originDeviceId,
      currentBootId: state.writerBootId!,
      currentBootGeneration: state.writerBootGeneration!,
      currentMembershipEpoch: "5",
      currentRootKeyEpoch: "2",
      now: 1,
    };
    expect(decideSessionPublication(state, envelope(10), context)).toEqual({ kind: "reject", code: "SEQUENCE_GAP" });
    expect(decideSessionPublication(state, envelope(8), context)).toEqual({ kind: "reject", code: "CONFLICT" });
    expect(decideSessionPublication(state, envelope(9, { writerGeneration: "2" }), context)).toEqual({ kind: "reject", code: "STALE_WRITER" });
    expect(decideSessionPublication(state, envelope(9, { bootGeneration: "6" }), context)).toEqual({ kind: "reject", code: "STALE_BOOT" });
    expect(decideSessionPublication(state, envelope(9, { membershipEpoch: "4" }), context)).toEqual({ kind: "reject", code: "STALE_MEMBERSHIP" });
    expect(decideSessionPublication(state, envelope(9, { sourceRevision: "7" }), context)).toEqual({ kind: "reject", code: "STALE_REVISION" });
    expect(decideSessionPublication(state, envelope(9, { eventKind: "deleted" }), context)).toEqual({ kind: "reject", code: "INVALID_REQUEST" });
  });

  test("rejects every foreign vault coordinate before publication can mutate state", () => {
    const state = stored(8);
    const context = {
      expectedVault,
      currentDeviceId: state.originDeviceId,
      currentBootId: state.writerBootId!,
      currentBootGeneration: state.writerBootGeneration!,
      currentMembershipEpoch: "5",
      currentRootKeyEpoch: "2",
      now: 1,
    };
    const foreignCoordinates = [
      ["tenantId", id("synctenant", "x")],
      ["organizationId", id("syncorg", "x")],
      ["ownerUserId", id("syncuser", "x")],
      ["vaultId", id("syncvault", "x")],
      ["vaultGeneration", "2"],
    ] as const;
    for (const [field, value] of foreignCoordinates) {
      expect(decideSessionPublication(state, envelope(9, { [field]: value }), context))
        .toEqual({ kind: "reject", code: "AUTHORIZATION_DENIED" });
    }
  });

  test("enforces every exact counter at its boundary", () => {
    const base = {
      activeDevices: 8,
      directorySessions: 512,
      locallyOwnedSessions: 64,
      activeStreams: 64,
      retainedEvents: 8_192,
      retainedCiphertextBytes: MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
    };
    expect(quotaFailure(base)).toBeNull();
    expect(quotaFailure({ ...base, activeDevices: 9 })).toBe("DEVICE_LIMIT");
    expect(quotaFailure({ ...base, directorySessions: 513 })).toBe("DIRECTORY_LIMIT");
    expect(quotaFailure({ ...base, locallyOwnedSessions: 65 })).toBe("DIRECTORY_LIMIT");
    expect(quotaFailure({ ...base, activeStreams: 65 })).toBe("QUOTA_EXCEEDED");
    expect(quotaFailure({ ...base, retainedEvents: 8_193 })).toBe("EVENT_LIMIT");
    expect(quotaFailure({ ...base, retainedCiphertextBytes: MAX_SYNC_RETAINED_CIPHERTEXT_BYTES + 1 })).toBe("QUOTA_EXCEEDED");
  });
});
