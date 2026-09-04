/**
 * Every value that arrives from Convex is parsed from `unknown` here before a
 * component sees it. Nothing in this file touches React or the document, so it
 * runs under `bun test ./app` without a DOM.
 */
import {
  cloudLimits,
  isCommandKind,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  parseEncryptedEnvelope,
  parseWrappedKeyEnvelope,
  type AuthorityTuple,
  type CommandKind,
  type CommandState,
  type EncryptedEnvelope,
  type SyncStream,
  type WrappedKeyEnvelope,
} from "../hra/cloud";

export type WireEncryptedEnvelope = EncryptedEnvelope;

export type DeviceStatus = "pending" | "active" | "revoked";
export type SessionStatus = "active" | "idle" | "terminal" | "orphaned";

const deviceStatuses = new Set<DeviceStatus>(["pending", "active", "revoked"]);
const sessionStatuses = new Set<SessionStatus>(["active", "idle", "terminal", "orphaned"]);
const commandStates = new Set<CommandState>([
  "pending",
  "prepared",
  "effect_started",
  "applied",
  "failed",
  "ambiguous",
  "cancelled",
  "expired",
]);

export class WireShapeError extends Error {
  constructor(readonly shape: string) {
    super(`Cloud response is not a valid ${shape}.`);
    this.name = "WireShapeError";
  }
}

function requireShape<T>(value: T | null, shape: string): T {
  if (value === null) throw new WireShapeError(shape);
  return value;
}

export type DeviceSummary = Readonly<{
  publicId: string;
  revision: number;
  status: DeviceStatus;
}>;

export function parseDeviceSummary(value: unknown): DeviceSummary | null {
  if (
    !isRecord(value)
    || !isOpaqueIdentifier(value.publicId)
    || !isSafePositiveInteger(value.revision)
    || typeof value.status !== "string"
    || !deviceStatuses.has(value.status as DeviceStatus)
  ) return null;
  return {
    publicId: value.publicId,
    revision: value.revision,
    status: value.status as DeviceStatus,
  };
}

export type AccountContext = Readonly<{
  authEpoch: number;
  device: Readonly<{
    credentialGeneration: number;
    keyVersion: number;
    publicId: string;
    revision: number;
    status: DeviceStatus;
  }> | null;
  hasActiveDevices: boolean;
  userPublicId: string;
}>;

export function parseAccountContext(value: unknown): AccountContext | null {
  if (
    !isRecord(value)
    || !isSafePositiveInteger(value.authEpoch)
    || typeof value.hasActiveDevices !== "boolean"
    || !isOpaqueIdentifier(value.userPublicId)
  ) return null;
  if (value.device === null) {
    return {
      authEpoch: value.authEpoch,
      device: null,
      hasActiveDevices: value.hasActiveDevices,
      userPublicId: value.userPublicId,
    };
  }
  const device = value.device;
  if (
    !isRecord(device)
    || !isSafePositiveInteger(device.credentialGeneration)
    || !isSafePositiveInteger(device.keyVersion)
    || !isOpaqueIdentifier(device.publicId)
    || !isSafePositiveInteger(device.revision)
    || typeof device.status !== "string"
    || !deviceStatuses.has(device.status as DeviceStatus)
  ) return null;
  return {
    authEpoch: value.authEpoch,
    device: {
      credentialGeneration: device.credentialGeneration,
      keyVersion: device.keyVersion,
      publicId: device.publicId,
      revision: device.revision,
      status: device.status as DeviceStatus,
    },
    hasActiveDevices: value.hasActiveDevices,
    userPublicId: value.userPublicId,
  };
}

export type SessionHead = Readonly<{
  compactHeadSequence: number;
  compactStreamEpoch: number;
  createdAt: number;
  detailHeadSequence: number;
  detailStreamEpoch: number | null;
  executionDevicePublicId: string;
  metadata: EncryptedEnvelope | null;
  metadataRevision: number;
  projectionRevision: number;
  publicId: string;
  state: SessionStatus;
  updatedAt: number;
}>;

export function parseSessionHead(value: unknown): SessionHead | null {
  if (
    !isRecord(value)
    || !isSafeNonNegativeInteger(value.compactHeadSequence)
    || !isSafeNonNegativeInteger(value.compactStreamEpoch)
    || !isFiniteTimestamp(value.createdAt)
    || !isSafeNonNegativeInteger(value.detailHeadSequence)
    || !isOpaqueIdentifier(value.executionDevicePublicId)
    || !isSafeNonNegativeInteger(value.metadataRevision)
    || !isSafeNonNegativeInteger(value.projectionRevision)
    || !isOpaqueIdentifier(value.publicId)
    || typeof value.state !== "string"
    || !sessionStatuses.has(value.state as SessionStatus)
    || !isFiniteTimestamp(value.updatedAt)
    || (value.detailStreamEpoch !== undefined
      && !isSafeNonNegativeInteger(value.detailStreamEpoch))
  ) return null;
  const metadata = value.metadata === undefined
    ? null
    : parseEncryptedEnvelope(value.metadata, cloudLimits.metadataCiphertextCharacters);
  if (value.metadata !== undefined && metadata === null) return null;
  return {
    compactHeadSequence: value.compactHeadSequence,
    compactStreamEpoch: value.compactStreamEpoch,
    createdAt: value.createdAt,
    detailHeadSequence: value.detailHeadSequence,
    detailStreamEpoch: typeof value.detailStreamEpoch === "number"
      ? value.detailStreamEpoch
      : null,
    executionDevicePublicId: value.executionDevicePublicId,
    metadata,
    metadataRevision: value.metadataRevision,
    projectionRevision: value.projectionRevision,
    publicId: value.publicId,
    state: value.state as SessionStatus,
    updatedAt: value.updatedAt,
  };
}

export function parseSessionHeads(value: unknown): readonly SessionHead[] {
  if (!Array.isArray(value)) throw new WireShapeError("session head page");
  return value.map((entry) => requireShape(parseSessionHead(entry), "session head"));
}

export type SessionChunk = Readonly<{
  authority: AuthorityTuple;
  createdAt: number;
  digest: string;
  envelope: EncryptedEnvelope;
  firstSequence: number;
  lastSequence: number;
  previousDigest: string | null;
  sourceDevicePublicId: string;
  stream: SyncStream;
  streamEpoch: number;
}>;

const digestPattern = /^[0-9a-f]{64}$/u;

export function parseSessionChunk(value: unknown): SessionChunk | null {
  if (!isRecord(value) || !isRecord(value.authority)) return null;
  const authority = value.authority;
  if (
    !isSafePositiveInteger(authority.bootGeneration)
    || !isOpaqueIdentifier(authority.bootId)
    || !isSafePositiveInteger(authority.fence)
    || !isFiniteTimestamp(value.createdAt)
    || typeof value.digest !== "string"
    || !digestPattern.test(value.digest)
    || !isSafePositiveInteger(value.firstSequence)
    || !isSafePositiveInteger(value.lastSequence)
    || value.lastSequence < value.firstSequence
    || !isOpaqueIdentifier(value.sourceDevicePublicId)
    || (value.stream !== "compact" && value.stream !== "detail")
    || !isSafeNonNegativeInteger(value.streamEpoch)
    || (value.previousDigest !== undefined
      && (typeof value.previousDigest !== "string" || !digestPattern.test(value.previousDigest)))
  ) return null;
  const envelope = parseEncryptedEnvelope(value.envelope);
  if (envelope === null) return null;
  return {
    authority: {
      bootGeneration: authority.bootGeneration,
      bootId: authority.bootId,
      fence: authority.fence,
    },
    createdAt: value.createdAt,
    digest: value.digest,
    envelope,
    firstSequence: value.firstSequence,
    lastSequence: value.lastSequence,
    previousDigest: typeof value.previousDigest === "string" ? value.previousDigest : null,
    sourceDevicePublicId: value.sourceDevicePublicId,
    stream: value.stream,
    streamEpoch: value.streamEpoch,
  };
}

export function parseSessionChunks(value: unknown): readonly SessionChunk[] {
  if (!Array.isArray(value) || value.length > cloudLimits.pageSize) {
    throw new WireShapeError("session chunk page");
  }
  return value.map((entry) => requireShape(parseSessionChunk(entry), "session chunk"));
}

export type KeyEnvelopeEntry = Readonly<{
  createdAt: number;
  envelope: WrappedKeyEnvelope;
}>;

export function parseKeyEnvelopes(value: unknown): readonly KeyEnvelopeEntry[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new WireShapeError("account key envelope list");
  }
  return value.map((entry) => {
    if (!isRecord(entry) || !isFiniteTimestamp(entry.createdAt)) {
      throw new WireShapeError("account key envelope");
    }
    return {
      createdAt: entry.createdAt,
      envelope: requireShape(parseWrappedKeyEnvelope(entry.envelope), "account key envelope"),
    };
  });
}

export type BindChallenge = Readonly<{
  challengeId: string;
  devicePublicId: string;
  nonce: string;
}>;

export function parseBindChallenge(value: unknown): BindChallenge | null {
  if (
    !isRecord(value)
    || !isOpaqueIdentifier(value.challengeId)
    || !isOpaqueIdentifier(value.devicePublicId)
    || typeof value.nonce !== "string"
  ) return null;
  return {
    challengeId: value.challengeId,
    devicePublicId: value.devicePublicId,
    nonce: value.nonce,
  };
}

export type CommandRecord = Readonly<{
  createdAt: number;
  deadline: number;
  kind: CommandKind;
  publicId: string;
  resultCode: string | null;
  sessionPublicId: string;
  state: CommandState;
  updatedAt: number;
}>;

export function parseCommandRecord(value: unknown): CommandRecord | null {
  if (
    !isRecord(value)
    || !isFiniteTimestamp(value.createdAt)
    || !isFiniteTimestamp(value.deadline)
    || !isCommandKind(value.kind)
    || !isUuidV7(value.publicId)
    || !isOpaqueIdentifier(value.sessionPublicId)
    || typeof value.state !== "string"
    || !commandStates.has(value.state as CommandState)
    || !isFiniteTimestamp(value.updatedAt)
    || (value.resultCode !== undefined
      && (typeof value.resultCode !== "string"
        || value.resultCode.length > cloudLimits.resultCodeCharacters))
  ) return null;
  return {
    createdAt: value.createdAt,
    deadline: value.deadline,
    kind: value.kind,
    publicId: value.publicId,
    resultCode: typeof value.resultCode === "string" ? value.resultCode : null,
    sessionPublicId: value.sessionPublicId,
    state: value.state as CommandState,
    updatedAt: value.updatedAt,
  };
}

export type PresenceResponse = Readonly<{
  connectionId: string | null;
  online: boolean;
  serverNow: number;
}>;

export function parsePresenceResponse(value: unknown): PresenceResponse | null {
  if (
    !isRecord(value)
    || typeof value.online !== "boolean"
    || !isFiniteTimestamp(value.serverNow)
    || (value.connectionId !== null && !isOpaqueIdentifier(value.connectionId))
  ) return null;
  return {
    connectionId: typeof value.connectionId === "string" ? value.connectionId : null,
    online: value.online,
    serverNow: value.serverNow,
  };
}
