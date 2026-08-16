import {
  decodeSyncUint64,
  encodeSyncUint64,
  MAX_SYNC_ACTIVE_STREAMS,
  MAX_SYNC_DEVICES,
  MAX_SYNC_DIRECTORY_SESSIONS,
  MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE,
  MAX_SYNC_RETAINED_CIPHERTEXT_BYTES,
  MAX_SYNC_RETAINED_EVENTS,
  nextSyncUint64,
  SESSION_SYNC_DEVICE_ONLINE_TTL_MS,
  type SealedSessionSummary,
  type SyncUint64,
} from "@hraness/agent-tasks-protocol";

import {
  MAX_SESSION_SYNC_PENDING_ENROLLMENTS,
  type SessionSyncBackendErrorCode,
} from "./sessionSyncSchemas";

export const UINT64_ORDER_KEY_WIDTH = 20;

export type SyncDeviceConnection = "online" | "offline" | "unknown";

export function deviceConnectionState(
  status: "active" | "revoked",
  lastHeartbeatAt: number | undefined,
  now: number,
): SyncDeviceConnection {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("presence observation time must be a non-negative safe integer");
  }
  if (status === "revoked") return "offline";
  if (
    lastHeartbeatAt === undefined
    || !Number.isSafeInteger(lastHeartbeatAt)
    || lastHeartbeatAt < 0
    || lastHeartbeatAt > now
  ) return "unknown";
  return now - lastHeartbeatAt < SESSION_SYNC_DEVICE_ONLINE_TTL_MS
    ? "online"
    : "offline";
}

export function enrollmentQuotaFailure(
  activePendingRequests: number,
  activeDevices: number,
): SessionSyncBackendErrorCode | null {
  if (
    !Number.isInteger(activePendingRequests)
    || activePendingRequests < 0
    || !Number.isInteger(activeDevices)
    || activeDevices < 0
  ) throw new RangeError("session sync enrollment counts must be non-negative integers");
  if (activePendingRequests >= MAX_SESSION_SYNC_PENDING_ENROLLMENTS) return "QUOTA_EXCEEDED";
  if (activeDevices >= MAX_SYNC_DEVICES) return "DEVICE_LIMIT";
  return null;
}

export function syncUint64OrderKey(value: SyncUint64 | string): string {
  const parsed = decodeSyncUint64(value);
  return parsed.toString(10).padStart(UINT64_ORDER_KEY_WIDTH, "0");
}

export function compareSyncIdentifier(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function nextRequiredSyncUint64(value: SyncUint64 | string): SyncUint64 {
  const next = nextSyncUint64(value);
  if (next === null) throw new Error("session sync uint64 exhausted");
  return next;
}

export function syncUint64ToSafeNumber(value: SyncUint64 | string): number | null {
  const parsed = decodeSyncUint64(value);
  return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(parsed);
}

export interface StoredSessionFence {
  readonly state: "reserved" | "active" | "tombstone" | "retired";
  readonly originDeviceId: string;
  readonly directoryOrdinal: string;
  readonly creationGrantDigest: string;
  readonly creationGrantExpiresAt: number;
  readonly mirrorEpoch: string;
  readonly writerGeneration: string;
  readonly writerBootId?: string;
  readonly writerBootGeneration?: string;
  readonly currentSequence: string;
  readonly currentDigest?: string;
  readonly currentSourceRevision: string;
  readonly currentKeyEpoch: string;
}

export type PublicationDecision =
  | Readonly<{ kind: "accept" }>
  | Readonly<{ kind: "replay" }>
  | Readonly<{ kind: "reject"; code: SessionSyncBackendErrorCode }>;

export interface ExpectedSessionVaultCoordinate {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly vaultId: string;
  readonly vaultGeneration: string;
}

export function decideSessionPublication(
  stored: StoredSessionFence,
  envelope: SealedSessionSummary,
  args: Readonly<{
    expectedVault: ExpectedSessionVaultCoordinate;
    currentDeviceId: string;
    currentBootId: string;
    currentBootGeneration: string;
    currentMembershipEpoch: string;
    currentRootKeyEpoch: string;
    now: number;
  }>,
): PublicationDecision {
  const header = envelope.header;
  if (header.eventKind === "deleted") {
    return { kind: "reject", code: "INVALID_REQUEST" };
  }
  if (
    header.tenantId !== args.expectedVault.tenantId
    || header.organizationId !== args.expectedVault.organizationId
    || header.ownerUserId !== args.expectedVault.ownerUserId
    || header.vaultId !== args.expectedVault.vaultId
    || header.vaultGeneration !== args.expectedVault.vaultGeneration
  ) {
    return { kind: "reject", code: "AUTHORIZATION_DENIED" };
  }
  if (stored.state === "retired" || stored.state === "tombstone") {
    return { kind: "reject", code: "RETIRED" };
  }
  if (header.originDeviceId !== stored.originDeviceId || header.originDeviceId !== args.currentDeviceId) {
    return { kind: "reject", code: "AUTHORIZATION_DENIED" };
  }
  if (header.directoryOrdinal !== stored.directoryOrdinal) {
    return { kind: "reject", code: "CONFLICT" };
  }
  if (header.membershipEpoch !== args.currentMembershipEpoch) {
    return { kind: "reject", code: "STALE_MEMBERSHIP" };
  }
  if (header.keyEpoch !== args.currentRootKeyEpoch) {
    return { kind: "reject", code: "STALE_MEMBERSHIP" };
  }
  if (header.mirrorEpoch !== stored.mirrorEpoch) {
    return { kind: "reject", code: "STALE_MIRROR" };
  }
  if (header.writerGeneration !== stored.writerGeneration) {
    return { kind: "reject", code: "STALE_WRITER" };
  }
  if (
    header.bootId !== stored.writerBootId
    || header.bootGeneration !== stored.writerBootGeneration
    || header.bootId !== args.currentBootId
    || header.bootGeneration !== args.currentBootGeneration
  ) {
    return { kind: "reject", code: "STALE_BOOT" };
  }

  if (header.syncSequence === stored.currentSequence) {
    return envelope.ciphertextDigest === stored.currentDigest
      ? { kind: "replay" }
      : { kind: "reject", code: "CONFLICT" };
  }
  if (header.syncSequence !== nextRequiredSyncUint64(stored.currentSequence)) {
    return { kind: "reject", code: "SEQUENCE_GAP" };
  }
  if (header.previousDigest !== (stored.currentDigest ?? null)) {
    return { kind: "reject", code: "CONFLICT" };
  }
  if (decodeSyncUint64(header.sourceRevision) < decodeSyncUint64(stored.currentSourceRevision)) {
    return { kind: "reject", code: "STALE_REVISION" };
  }

  if (stored.state === "reserved") {
    if (args.now > stored.creationGrantExpiresAt) {
      return { kind: "reject", code: "GRANT_EXPIRED" };
    }
    if (
      header.eventKind !== "created"
      || header.syncSequence !== "1"
      || header.previousDigest !== null
      || header.creationGrantDigest !== stored.creationGrantDigest
    ) {
      return { kind: "reject", code: "CONFLICT" };
    }
  } else if (header.eventKind === "created" || header.creationGrantDigest !== undefined) {
    return { kind: "reject", code: "CONFLICT" };
  }
  return { kind: "accept" };
}

export interface SyncQuotaSnapshot {
  readonly activeDevices: number;
  readonly directorySessions: number;
  readonly locallyOwnedSessions: number;
  readonly activeStreams: number;
  readonly retainedEvents: number;
  readonly retainedCiphertextBytes: number;
}

export function quotaFailure(snapshot: SyncQuotaSnapshot): SessionSyncBackendErrorCode | null {
  if (snapshot.activeDevices > 8) return "DEVICE_LIMIT";
  if (snapshot.directorySessions > MAX_SYNC_DIRECTORY_SESSIONS) return "DIRECTORY_LIMIT";
  if (snapshot.locallyOwnedSessions > MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE) {
    return "DIRECTORY_LIMIT";
  }
  if (snapshot.activeStreams > MAX_SYNC_ACTIVE_STREAMS) return "QUOTA_EXCEEDED";
  if (snapshot.retainedEvents > MAX_SYNC_RETAINED_EVENTS) return "EVENT_LIMIT";
  if (snapshot.retainedCiphertextBytes > MAX_SYNC_RETAINED_CIPHERTEXT_BYTES) {
    return "QUOTA_EXCEEDED";
  }
  return null;
}

export function nextStreamState(
  current: boolean,
  eventKind: SealedSessionSummary["header"]["eventKind"],
): boolean {
  switch (eventKind) {
    case "turn_started":
    case "activity":
      return true;
    case "terminal":
    case "attention":
    case "archived":
    case "deleted":
      return false;
    case "created":
    case "projection_changed":
      return current;
  }
}

export function compareSyncUint64(left: string, right: string): number {
  const difference = decodeSyncUint64(left) - decodeSyncUint64(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function encodeServerCounter(value: number): SyncUint64 {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("server counter must be a nonnegative safe integer");
  }
  return encodeSyncUint64(BigInt(value));
}
