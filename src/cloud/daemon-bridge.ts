import { parseAuthSignInResult } from "./authSession";
import {
  createConvexCloudTransport,
  type CloudArgs,
  type CloudMutation,
  type CloudTransport,
} from "./client";
import {
  cloudLimits,
  CloudProjectionRecoveryAdmissionError,
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  hasExactKeys,
  isCommandKind,
  isDeviceCommandKind,
  isDigest,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  parseAuthorityTuple,
  parseEncryptedEnvelope,
  type AuthorityTuple,
  type CommandKind,
  type CommandState,
  type DeviceCommandKind,
  type EncryptedEnvelope,
} from "./contracts";
import {
  decodeBase64Url,
  decryptBytes,
  encryptBytes,
  hmacSha256Hex,
  parseDevicePrivateKeyJson,
  parseDevicePublicKeyJson,
  sha256Hex,
} from "./crypto";
import {
  type CloudCommandJournalEntry,
  type CloudDaemonJournalPort,
  type CloudDaemonJournalState,
  type CloudDeviceCommandJournalEntry,
  type CloudProjectionRecoveryAppliedResponse,
  type CloudProjectionRecoveryBaselineInteraction,
  type CloudProjectionRecoveryJournalEntry,
  type CloudProjectionRecoveryTerminalReceipt,
  type CloudSessionSyncCursorObservation,
  type CloudSessionSyncCursorPort,
  type CloudUsageAccountCursor,
  type PendingCloudUsageAccount,
  addCloudCommandJournalEntry,
  addCloudDeviceCommandJournalEntry,
  addCloudProjectionRecovery,
  advanceCloudSessionRemoteCursor,
  assertCloudDaemonJournalFutureCapacity,
  cloudProjectionRecoveryReceiptResult,
  completePendingCloudUsageAccount,
  createCloudProjectionRecoveryTerminalReceipt,
  CustodyCloudDaemonJournal,
  CustodyCloudSessionSyncCursor,
  hasUnsettledCompactProjectionRecovery,
  hasUnsettledCompactProjectionRecoveryForProfile,
  invalidIdempotencyProjectionRecoveryCode,
  matchesCloudProjectionRecoveryIdentity,
  parseCloudProjectionRecoveryEntry,
  providerDeletionProjectionRecoveryCode,
  pruneExpiredCloudProjectionRecoveryReceipts,
  removeCloudDeviceCommandJournalEntry,
  supersedeCloudProjectionRecoveryForProviderDeletion,
  terminalizeUnreservedPreparedCloudCommands,
  transitionCloudCommandJournalEntry,
  transitionCloudDeviceCommandJournalEntry,
  transitionCloudProjectionRecovery,
} from "./daemon-journal";
import {
  decryptDeviceCommand,
  decryptRemoteCommand,
  decryptSessionMetadata,
  encryptDeviceCommandResult,
  encryptDeviceRegistry,
  encryptSessionMetadata,
  encryptUsageProjection,
  parseSessionMetadataPayload,
  type DeviceCommandPayload,
  type DeviceCommandResultPayload,
  type DeviceRegistryPayload,
  type RemoteCommandPayload,
  type SessionMetadataPayload,
} from "./payloads";
import type { SessionEvent } from "../domain/session-events";
import { assignDetailSequences, LiveBatcher } from "./live-uploader";
import {
  decryptCompactEvents,
  encryptCompactEvents,
  encryptDetailEvents,
  parseCompactSessionEvents,
  type CompactSessionEvent,
} from "./projection";
import {
  createCloudPushWake,
  createConvexPushWakeSubscriber,
  type CloudPushWakePort,
} from "./push-wake";
import { parseUsageProjection, type UsageProjection } from "./usage";
import {
  deploymentFencedCloudTransport,
  deploymentFencedSecretCustody,
  LocalCloudControl,
  type CloudDeviceRegistrationPort,
  type CloudSecretCustodyPort,
} from "./local-control";
import {
  acquireCloudDeploymentAuthority,
  canonicalCloudDeploymentUrl,
  cloudDeploymentSelectionFromEnvironment,
  CloudDeploymentAuthorityError,
  DeploymentScopedCloudSecretCustody,
  IdentityScopedCloudSecretCustody,
  type CloudDeploymentAuthority,
  type CloudDeploymentSelection,
} from "./identity-custody";

const maximumLocalSessions = 25;
const maximumRemoteSessions = 25;
const maximumEventsPerChunk = 128;
const maximumChunksPerRemoteSession = 8;
const maximumProjectionRecoveryBaselineInteractions = 200;
const maximumCommandsPerCycle = 32;
const maximumJournalRecoveriesPerCycle = 4;
// Device commands are foreground requests. A small per-cycle budget keeps a
// burst from crowding out session steering, and the daily cap bounds the rest.
const maximumDeviceCommandsPerCycle = 8;
const maximumUsageAccounts = 32;
const maximumUsageSnapshotsPerCycle = 32;
const maximumIdempotencyLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const maximumIdempotencyFutureSkewMs = 5 * 60 * 1_000;
const refreshAfterMs = 10 * 60 * 1_000;
const defaultLeaseDurationMs = 60_000;
/*
 * The device registry is republished whenever its inputs change and, when
 * nothing changed, at most once a minute so the settings screen can tell a
 * live daemon from a stale one without a per-cycle write.
 */
const deviceRegistryHeartbeatMs = 60_000;
const defaultOptionalSyncBudgetMs = 10_000;
const minimumPresenceCycleTtlMs = 15_000;
const maximumPresenceTtlMs = 120_000;
const peerPresenceRefreshMs = 10_000;
const authLogoutCustodySlot = "cloud-auth-logout";
const unreservedPreparedCommandResultCode = "LOCAL_JOURNAL_CAPACITY_BEFORE_EFFECT";

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

export type ActiveCloudIdentity = Readonly<{
  accountKey: Uint8Array;
  devicePublicId: string;
  keyVersion: number;
  userPublicId: string;
}>;

export type RegisteredCloudIdentity =
  | Readonly<{
      activeIdentity: ActiveCloudIdentity;
      authEpoch: number;
      credentialGeneration: number;
      devicePublicId: string;
      status: "active";
      userPublicId: string;
    }>
  | Readonly<{
      activeIdentity: null;
      authEpoch: number;
      credentialGeneration: number;
      devicePublicId: string;
      status: "pending";
      userPublicId: string;
    }>;

export interface CloudDaemonIdentityPort {
  requireActive(signal: AbortSignal): Promise<ActiveCloudIdentity>;
  requireRegistered?(signal: AbortSignal): Promise<RegisteredCloudIdentity>;
}

export type CloudLocalSessionHead = Readonly<{
  createdAt: number;
  metadata: SessionMetadataPayload;
  publicId: string;
  state: "active" | "idle" | "terminal";
  updatedAt: number;
}>;

export type CloudLocalSessionPage = Readonly<{
  continueAfterPublicId: string | null;
  isDone: boolean;
  sessions: readonly CloudLocalSessionHead[];
}>;

export type CloudLocalUsageSnapshot = Readonly<{
  localReference: string;
  matchReference: string;
  metadata: Readonly<Record<string, string | boolean | number | null>>;
  observedAt: number;
  projection: UsageProjection;
  sourceGeneration: number;
  sourceRevision: number;
}>;

export type CloudLocalCommandAuthority = Readonly<{
  localSessionId: string;
  profileGeneration: number;
  profileId: string;
  providerThreadId: string;
}>;

export interface CloudDaemonLocalSourcePort {
  activateCompactProjectionRecovery?(input: Readonly<{
    baselineCompletedTurns: readonly Readonly<{ bodyDigest: string; turnId: string }>[];
    baselineInteractions: readonly CloudProjectionRecoveryBaselineInteraction[];
    boundaryHeadSequence: number;
    boundaryTailDigest: string;
    compactStreamEpoch: number;
    idempotencyKey: string;
    localAuthority: Readonly<{
      profileGeneration: number;
      profileId: string;
      providerThreadId: string;
      providerUpdatedAt: number | null;
      sessionRevision: number;
    }>;
    replacementCacheId: string;
    sessionPublicId: string;
    signal: AbortSignal;
    sourceCacheId: string | null;
  }>): Promise<void>;
  discardCompactProjectionRecovery?(input: Readonly<{
    idempotencyKey: string;
    sessionPublicId: string;
  }>): Promise<void>;
  /*
   * Cadence hint only: true while any local session is mid-turn. It is read
   * once per cycle, so it must be cheap and must never throw a cycle down.
   */
  hasActiveTurn?(): boolean | Promise<boolean>;
  isSessionTerminal?(sessionPublicId: string): boolean | Promise<boolean>;
  listSessions(input: Readonly<{
    afterPublicId: string | null;
    limit: number;
    signal: AbortSignal;
  }>): Promise<CloudLocalSessionPage>;
  planCompactProjectionRecovery?(input: Readonly<{
    idempotencyKey: string;
    observedInteractionIds: readonly string[];
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    baselineCompletedTurns: readonly Readonly<{ bodyDigest: string; turnId: string }>[];
    baselineInteractions: readonly CloudProjectionRecoveryBaselineInteraction[];
    localAuthority: Readonly<{
      profileGeneration: number;
      profileId: string;
      providerThreadId: string;
      providerUpdatedAt: number | null;
      sessionRevision: number;
    }>;
    replacementCacheId: string;
    sessionPublicId: string;
    sourceCacheId: string | null;
  }>>;
  stageCompactProjectionRecovery?(input: Readonly<{
    baselineCompletedTurns: readonly Readonly<{ bodyDigest: string; turnId: string }>[];
    baselineInteractions: readonly CloudProjectionRecoveryBaselineInteraction[];
    boundaryHeadSequence: number;
    boundaryTailDigest: string;
    compactStreamEpoch: number;
    idempotencyKey: string;
    localAuthority: Readonly<{
      profileGeneration: number;
      profileId: string;
      providerThreadId: string;
      providerUpdatedAt: number | null;
      sessionRevision: number;
    }>;
    replacementCacheId: string;
    sessionPublicId: string;
    signal: AbortSignal;
    sourceCacheId: string | null;
  }>): Promise<void>;
  readCompactEvents(input: Readonly<{
    afterSequence: number;
    limit: number;
    remoteStreamEpoch: number;
    remoteTailDigest?: string;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    cacheId: string;
    complete: boolean;
    events: readonly CompactSessionEvent[];
  }>>;
  /*
   * Live projection source: local ledger events after a local sequence for
   * one session, in ledger order, already filtered to the event kinds the
   * live batcher consumes. `includeThinking` reports the session's current
   * show-thinking setting so the bridge can decide whether reasoning summary
   * deltas are projected.
   */
  readLiveEvents?(input: Readonly<{
    afterLocalSequence: number | null;
    limit: number;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    events: readonly SessionEvent[];
    includeThinking: boolean;
    observedThroughSequence: number;
  }>>;
  /*
   * The device settings projection (machine, daemon defaults, accounts,
   * projects, scheduled tasks) as labels only. The bridge encrypts it under
   * the account key and publishes it to `devices:updateRegistry`.
   */
  readDeviceRegistry?(input: Readonly<{ signal: AbortSignal }>): Promise<DeviceRegistryPayload>;
  recordCompactUploadIntent?(input: Readonly<{
    cacheId: string;
    digest: string;
    expectedHeadSequence: number;
    expectedStreamEpoch: number;
    expectedTailDigest?: string;
    headSequence: number;
    sessionPublicId: string;
  }>): Promise<void>;
  acknowledgeCompactUpload?(input: Readonly<{
    cacheId: string;
    digest: string;
    expectedHeadSequence: number;
    expectedStreamEpoch: number;
    expectedTailDigest?: string;
    headSequence: number;
    sessionPublicId: string;
  }>): Promise<void>;
  listUsage(input: Readonly<{
    limit: number;
    signal: AbortSignal;
  }>): Promise<readonly CloudLocalUsageSnapshot[]>;
  listUsageHistory?(input: Readonly<{
    afterSourceRevision: number;
    limit: number;
    localReference: string;
    signal: AbortSignal;
    sourceGeneration: number;
  }>): Promise<readonly CloudLocalUsageSnapshot[]>;
  resolveCommandAuthority(input: Readonly<{
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudLocalCommandAuthority | null>;
}

export type CloudCommandExecutionResult = Readonly<{
  code: string;
  state: "applied" | "failed" | "ambiguous";
}>;

export type CloudDeviceCommandExecutionResult = Readonly<{
  code: string;
  /** Settled back to the requester, account-key encrypted, when present. */
  result?: DeviceCommandResultPayload;
  /**
   * Marks the result readable exactly once. Only the account-linking handoff
   * sets it; the hosted row erases the ciphertext on the requester's first read.
   */
  singleUseResult?: boolean;
  state: "applied" | "failed" | "ambiguous";
}>;

/**
 * Executes one device command. Unlike `CloudCommandExecutorPort` this carries
 * no session and no lease: the device itself is the authority, so the port only
 * needs the requesting device's identity (for the per-device guards) and the
 * command's own idempotency key.
 */
export interface CloudDeviceCommandExecutorPort {
  executeDeviceCommand(input: Readonly<{
    idempotencyKey: string;
    payload: DeviceCommandPayload;
    requestingDevicePublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudDeviceCommandExecutionResult>;
}

export interface CloudCommandExecutorPort {
  execute(input: Readonly<{
    authority: CloudLocalCommandAuthority;
    idempotencyKey: string;
    leaseAuthority: AuthorityTuple;
    payload: RemoteCommandPayload;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudCommandExecutionResult>;
}

export type RemoteCloudSession = Readonly<{
  complete: boolean;
  events: readonly CompactSessionEvent[];
  executionDevicePublicId: string;
  metadata: SessionMetadataPayload | null;
  publicId: string;
  recoveryGap?: Readonly<{
    kind: "projection_cache_recovery";
    streamEpoch: number;
  }>;
  state: "active" | "idle" | "terminal" | "orphaned";
  updatedAt: number;
}>;

/*
 * The cadence hint the lifecycle uses to pick its poll interval. Both fields
 * are best effort: a failed probe keeps the previous observation rather than
 * failing a cycle, because nothing but the sleep length depends on them.
 */
export type CloudDaemonActivity = Readonly<{
  localTurnActive: boolean;
  peerDevicePresent: boolean;
}>;

export type CloudDaemonCycleResult = Readonly<{
  activity?: CloudDaemonActivity;
  commandsApplied: number;
  commandsUnsettled: number;
  errors: readonly string[];
  online: boolean;
  remoteSessions: readonly RemoteCloudSession[];
  sessionsUploaded: number;
  usageUploaded: number;
}>;

export type CompactProjectionRecoveryResult = Readonly<{
  boundaryHeadSequence: number;
  compactHasRecoveryGap: true;
  compactStreamEpoch: number;
  idempotencyKey: string;
  phase: "applied";
  projectionRevision: number;
  sessionPublicId: string;
}> | Readonly<{
  idempotencyKey: string;
  phase: "rejected";
  rejectionCode: string;
  sessionPublicId: string;
}>;

type OptionalCloudSyncResult = Readonly<{
  errors: readonly string[];
  remoteSessions: readonly RemoteCloudSession[];
  sessionsUploaded: number;
  usageUploaded: number;
}>;

type OptionalCloudSyncOutcome =
  | Readonly<{ result: OptionalCloudSyncResult; state: "completed" }>
  | Readonly<{ error: unknown; state: "failed" }>;

type OptionalCloudSyncTask = Readonly<{
  controller: AbortController;
  promise: Promise<OptionalCloudSyncOutcome>;
  state: { outcome: OptionalCloudSyncOutcome | null };
}>;

type CloudPresenceRequest = Readonly<{
  connectionId: string;
  credentialGeneration: number;
  fingerprint: string;
  kind: "connect" | "heartbeat";
  sequence: number;
}>;

type CloudPresenceResponse = Readonly<{
  connectionId: string;
  lastSeenAt: number;
  online: boolean;
  presenceUntil: number;
  sequence: number;
  serverNow: number;
  serverTtlMs: number;
}>;

/*
 * What this process last published to `devices:updateRegistry`: the digest of
 * the projection with its heartbeat removed (so a heartbeat alone is not a
 * change), when it went out, and the revision the server returned, which is
 * the expected revision of the next write.
 */
type CloudDeviceRegistryState = Readonly<{
  digest: string;
  publishedAt: number;
  revision: number;
}>;

type CloudPresenceState = {
  acknowledged: CloudPresenceRequest | null;
  connectionId: string;
  identity: Readonly<{
    authEpoch: number;
    credentialGeneration: number;
    devicePublicId: string;
    userPublicId: string;
  }>;
  pending: CloudPresenceRequest | null;
  response: CloudPresenceResponse | null;
};

const maximumProjectionRecoveryStatusEntries = 128;

export type CloudProjectionRecoveryStatus = Readonly<{
  recoveries: readonly Readonly<{
    cacheActivated?: boolean;
    idempotencyKey: string;
    phase: "prepared" | "effect_started" | "applied" | "rejected";
    sessionPublicId: string;
  }>[];
  recoveriesTruncated: boolean;
  totalRecoveries: number;
}>;

export function projectionRecoveryStatusFromJournalState(
  state: CloudDaemonJournalState,
): CloudProjectionRecoveryStatus {
  const active = state.projectionRecoveries.map((entry) => ({
    ...(entry.phase === "applied" ? { cacheActivated: false } : {}),
    idempotencyKey: entry.idempotencyKey,
    phase: entry.phase,
    sessionPublicId: entry.sessionPublicId,
  }));
  const receiptCapacity = Math.max(0, maximumProjectionRecoveryStatusEntries - active.length);
  const retainedReceipts = receiptCapacity === 0
    ? []
    : [...state.projectionRecoveryReceipts]
      .sort((left, right) => left.requestedAt - right.requestedAt
        || left.idempotencyKey.localeCompare(right.idempotencyKey))
      .slice(-receiptCapacity);
  const totalRecoveries = active.length + state.projectionRecoveryReceipts.length;
  return {
    recoveries: [
      ...active,
      ...retainedReceipts.map((receipt) => ({
        ...(receipt.phase === "applied" ? { cacheActivated: true } : {}),
        idempotencyKey: receipt.idempotencyKey,
        phase: receipt.phase,
        sessionPublicId: receipt.sessionPublicId,
      })),
    ],
    recoveriesTruncated: totalRecoveries > maximumProjectionRecoveryStatusEntries,
    totalRecoveries,
  };
}

export type CloudLiveTickResult = Readonly<{
  errors: readonly string[];
  sessionsUploaded: number;
}>;

export interface CloudDaemonBridge {
  close?(): Promise<void>;
  cycle(signal: AbortSignal): Promise<CloudDaemonCycleResult>;
  /** Uploads coalesced live text for sessions this daemon executes; safe to call every second. */
  liveTick?(signal: AbortSignal): Promise<CloudLiveTickResult>;
  /**
   * The hosted push-wake subscription, when this bridge opened one. The
   * lifecycle waits on it beside its adaptive timer; the bridge owns its
   * lifetime and drains its diagnostics into each cycle result.
   */
  pushWake?(): CloudPushWakePort | null;
  projectionRecoveryStatus?(): Promise<CloudProjectionRecoveryStatus>;
  isCompactProjectionRecoveryUnsettledForProfile?(profileId: string): Promise<boolean>;
  isCompactProjectionRecoveryUnsettled?(sessionPublicId: string): Promise<boolean>;
  supersedeCompactProjectionRecoveryForProviderDeletion?(
    sessionPublicId: string,
  ): Promise<{ superseded: boolean }>;
  supersedeTerminalCompactProjectionRecoveries?(): Promise<{ superseded: number }>;
  readCompactProjectionRecoveryReceipt?(input: Readonly<{
    idempotencyKey: string;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<
    | Readonly<{ status: "absent" | "conflict" }>
    | Readonly<{ status: "found"; result: CompactProjectionRecoveryResult }>
  >;
  pullRemoteSessions(signal: AbortSignal): Promise<readonly RemoteCloudSession[]>;
  recoverCompactProjection?(input: Readonly<{
    acknowledgeGap: true;
    idempotencyKey: string;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<CompactProjectionRecoveryResult>;
}

export type LocalCloudDaemonBridgeOptions = Readonly<{
  daemonAuthority: Readonly<{ bootGeneration: number; bootId: string }>;
  daemonAuthorityFence: Readonly<{ assertCurrent(): Promise<void> }>;
  deploymentAuthority: CloudDeploymentAuthority;
  /** Device-command executor (default: none; every device command is refused). */
  deviceExecutor?: CloudDeviceCommandExecutorPort;
  executor: CloudCommandExecutorPort;
  identity: CloudDaemonIdentityPort;
  journal: CloudDaemonJournalPort;
  leaseDurationMs?: number;
  local: CloudDaemonLocalSourcePort;
  now?: () => number;
  optionalSyncBudgetMs?: number;
  pushWake?: CloudPushWakePort;
  randomConnectionUuid?: () => string;
  randomUuid?: () => string;
  sessionSyncCursor: CloudSessionSyncCursorPort;
  transport: CloudTransport;
}>;

export type LocalCloudDaemonBridgeEnvironmentOptions = Readonly<{
  daemonAuthority: Readonly<{ bootGeneration: number; bootId: string }>;
  daemonAuthorityFence: Readonly<{ assertCurrent(): Promise<void> }>;
  deploymentUrl?: string;
  deploymentAuthority?: CloudDeploymentAuthority;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Device-command executor (default: none; every device command is refused). */
  deviceExecutor?: CloudDeviceCommandExecutorPort;
  executor: CloudCommandExecutorPort;
  journal?: CloudDaemonJournalPort;
  leaseDurationMs?: number;
  lifetimeSignal?: AbortSignal;
  local: CloudDaemonLocalSourcePort;
  now?: () => number;
  /** Pass `null` to run without a push-wake subscription (polling only). */
  pushWake?: CloudPushWakePort | null;
  randomConnectionUuid?: () => string;
  randomUuid?: () => string;
  registration?: CloudDeviceRegistrationPort;
  sessionSyncCursor?: CloudSessionSyncCursorPort;
  secretCustody: CloudSecretCustodyPort;
  transport?: CloudTransport;
}>;

type CloudSessionHead = Readonly<{
  compactHasRecoveryGap: boolean;
  compactHeadSequence: number;
  compactStreamEpoch: number;
  compactTailDigest?: string;
  detailHeadSequence: number;
  detailStreamEpoch: number;
  detailTailDigest?: string;
  executionDevicePublicId: string;
  metadata?: EncryptedEnvelope;
  metadataRevision: number;
  projectionRevision: number;
  publicId: string;
  state: "active" | "idle" | "terminal" | "orphaned";
  updatedAt: number;
}>;

type LiveSessionState = {
  afterLocalSequence: number | null;
  batcher: LiveBatcher | null;
  detailHeadSequence: number;
  detailStreamEpoch: number;
  detailTailDigest: string | undefined;
  lease: CloudLease;
  publicId: string;
};

const maximumLiveEventsPerTick = 200;

type CloudSessionHeadPage = Readonly<{
  continueCursor: string;
  isDone: boolean;
  page: readonly CloudSessionHead[];
}>;

type CloudSessionChunk = Readonly<{
  authority: AuthorityTuple;
  digest: string;
  envelope: EncryptedEnvelope;
  firstSequence: number;
  lastSequence: number;
  previousDigest?: string;
  sourceDevicePublicId: string;
  streamEpoch: number;
}>;

type CloudLease = Readonly<{
  bootGeneration: number;
  bootId: string;
  devicePublicId: string;
  fence: number;
  heartbeatFingerprint: string;
  heartbeatSequence: number;
  leaseUntil: number;
}>;

type CloudCommand = Readonly<{
  boundAuthority?: AuthorityTuple;
  createdAt: number;
  deadline: number;
  kind: CommandKind;
  payload: EncryptedEnvelope;
  publicId: string;
  // Populated only by `commands:get` (the exact per-command lookup used
  // before a prepared command's effect starts). Metadata pages never carry
  // it; nothing in the fair-scheduling scan needs it before that point.
  requestingDevicePublicId?: string;
  sessionPublicId: string;
  state: CommandState;
}>;

type CloudCommandMetadata = Omit<CloudCommand, "payload">;

type CloudCommandMetadataPage = Readonly<{
  continueCursor: string;
  isDone: boolean;
  page: readonly CloudCommandMetadata[];
}>;

type CloudUsageAccountBinding = Readonly<{
  binding: null | Readonly<{
    encryptedLocalReference: EncryptedEnvelope;
    sourceGeneration: number;
    state: "present" | "removed";
    usageSourceRevision: number;
  }>;
  encryptedMetadata: EncryptedEnvelope;
  matchKey: string;
  publicId: string;
}>;

type CustodyAuth = Readonly<{
  email: string;
  generation: number;
  obtainedAt: number;
  refreshToken: string;
  token: string;
}>;

function abortBeforeEffect(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted.");
  }
}

function isBoundedToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 32
    && value.length <= 16_384
    && !/\s/u.test(value);
}

function parseCustodyAuth(
  value: string,
  generation: number,
): CustodyAuth | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud auth custody is corrupt.");
  }
  if (
    isRecord(decoded)
    && decoded.version === 2
    && decoded.phase === "logout_claim"
  ) throw new Error("Cloud sign-out recovery is pending; daemon cloud effects are paused.");
  if (
    isRecord(decoded)
    && decoded.version === 3
    && decoded.phase === "signed_out"
    && hasExactKeys(decoded, [
      "phase",
      "requestedAt",
      "retiredAuthDigest",
      "retiredAuthGeneration",
      "version",
    ])
    && isFiniteTimestamp(decoded.requestedAt)
    && (
      (decoded.retiredAuthDigest === null && decoded.retiredAuthGeneration === null)
      || (
        isDigest(decoded.retiredAuthDigest)
        && isSafeNonNegativeInteger(decoded.retiredAuthGeneration)
      )
    )
  ) return null;
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, ["email", "obtainedAt", "refreshToken", "token", "version"])
    || decoded.version !== 1
    || typeof decoded.email !== "string"
    || decoded.email.length < 3
    || decoded.email.length > 320
    || !isFiniteTimestamp(decoded.obtainedAt)
    || !isBoundedToken(decoded.refreshToken)
    || !isBoundedToken(decoded.token)
  ) throw new Error("Cloud auth custody is corrupt.");
  return {
    email: decoded.email,
    generation,
    obtainedAt: decoded.obtainedAt,
    refreshToken: decoded.refreshToken,
    token: decoded.token,
  };
}

async function readCustodyAuth(
  custody: CloudSecretCustodyPort,
): Promise<CustodyAuth | null> {
  const observation = await custody.read("cloud-auth");
  return observation === null
    ? null
    : parseCustodyAuth(observation.value, observation.generation);
}

async function requireExactCustodyAuth(
  custody: CloudSecretCustodyPort,
  expected: CustodyAuth,
): Promise<void> {
  const current = await readCustodyAuth(custody);
  if (
    current === null
    || current.generation !== expected.generation
    || current.email !== expected.email
    || current.obtainedAt !== expected.obtainedAt
    || current.refreshToken !== expected.refreshToken
    || current.token !== expected.token
  ) throw new Error("Cloud auth changed during daemon identity acquisition.");
}

export class CustodyCloudDaemonIdentity implements CloudDaemonIdentityPort {
  readonly #custody: CloudSecretCustodyPort;
  readonly #now: () => number;
  readonly #registration: CloudDeviceRegistrationPort | null;
  readonly #transport: CloudTransport;

  constructor(input: Readonly<{
    custody: CloudSecretCustodyPort;
    now?: () => number;
    registration?: CloudDeviceRegistrationPort;
    transport: CloudTransport;
  }>) {
    this.#custody = input.custody;
    this.#now = input.now ?? Date.now;
    this.#registration = input.registration ?? null;
    this.#transport = input.transport;
  }

  async requireActive(signal: AbortSignal): Promise<ActiveCloudIdentity> {
    const identity = await this.#requireRegistered(signal);
    if (identity.status !== "active") {
      throw new Error("An active paired cloud device is required.");
    }
    return identity.activeIdentity;
  }

  async requireRegistered(signal: AbortSignal): Promise<RegisteredCloudIdentity> {
    return await this.#requireRegistered(signal);
  }

  async #requireRegistered(signal: AbortSignal): Promise<RegisteredCloudIdentity> {
    abortBeforeEffect(signal);
    if (await this.#custody.read(authLogoutCustodySlot) !== null) {
      throw new Error("Cloud sign-out recovery is pending; daemon cloud effects are paused.");
    }
    // Registration is an identity-scoped durable outbox operation. Running it
    // before identity acquisition makes a verified login sufficient to bring
    // a device online while preserving exact retry/restart custody.
    await this.#registration?.ensureDeviceRegistered(signal);
    abortBeforeEffect(signal);
    if (await this.#custody.read(authLogoutCustodySlot) !== null) {
      throw new Error("Cloud sign-out recovery started during device registration.");
    }
    let auth = await readCustodyAuth(this.#custody);
    if (auth === null) throw new Error("Cloud auth is unavailable.");
    if (this.#now() - auth.obtainedAt >= refreshAfterMs) {
      const result = parseAuthSignInResult(await this.#transport.action("auth:signIn", {
        refreshToken: auth.refreshToken,
      }));
      if (result?.kind !== "authenticated") {
        throw new Error("Cloud auth refresh response is invalid.");
      }
      if (await this.#custody.read(authLogoutCustodySlot) !== null) {
        throw new Error("Cloud sign-out recovery started during auth refresh.");
      }
      const value = JSON.stringify({
        email: auth.email,
        obtainedAt: this.#now(),
        refreshToken: result.refreshToken,
        token: result.token,
        version: 1,
      });
      const committed = await this.#custody.compareAndSwap("cloud-auth", auth.generation, value);
      if (committed === null) {
        auth = await readCustodyAuth(this.#custody);
        if (auth === null) throw new Error("Cloud auth changed during refresh.");
      } else {
        const committedAuth = parseCustodyAuth(committed.value, committed.generation);
        if (committedAuth === null) throw new Error("Cloud auth changed during refresh.");
        auth = committedAuth;
        if (await this.#custody.read(authLogoutCustodySlot) !== null) {
          throw new Error("Cloud sign-out recovery started during auth refresh.");
        }
      }
    }
    const accountValue = await this.#transport.query("account:current", {});
    const deviceKeys = isRecord(accountValue)
      && isRecord(accountValue.device)
      && Object.hasOwn(accountValue.device, "credentialGeneration")
      ? ["credentialGeneration", "keyVersion", "publicId", "revision", "status"]
      : ["keyVersion", "publicId", "revision", "status"];
    if (
      !isRecord(accountValue)
      || !hasExactKeys(accountValue, ["authEpoch", "device", "hasActiveDevices", "userPublicId"])
      || !isSafePositiveInteger(accountValue.authEpoch)
      || typeof accountValue.hasActiveDevices !== "boolean"
      || !isOpaqueIdentifier(accountValue.userPublicId)
      || !isRecord(accountValue.device)
      || !hasExactKeys(accountValue.device, deviceKeys)
      || (
        accountValue.device.credentialGeneration !== undefined
        && !isSafePositiveInteger(accountValue.device.credentialGeneration)
      )
      || !isSafePositiveInteger(accountValue.device.keyVersion)
      || !isOpaqueIdentifier(accountValue.device.publicId)
      || !isSafePositiveInteger(accountValue.device.revision)
      || (accountValue.device.status !== "active" && accountValue.device.status !== "pending")
    ) throw new Error("A registered cloud device is required.");
    const credentialGeneration = accountValue.device.credentialGeneration ?? 1;
    const deviceObservation = await this.#custody.read("cloud-device");
    if (deviceObservation === null) throw new Error("The registered cloud device key is unavailable.");
    let device: unknown;
    try {
      device = JSON.parse(deviceObservation.value) as unknown;
    } catch {
      throw new Error("Cloud device custody is corrupt.");
    }
    if (
      !isRecord(device)
      || !hasExactKeys(device, [
        "publicId",
        "registered",
        "signingPrivateKey",
        "signingPublicKey",
        "userPublicId",
        "version",
        "wrappingPrivateKey",
        "wrappingPublicKey",
      ])
      || device.version !== 1
      || device.registered !== true
      || device.publicId !== accountValue.device.publicId
      || device.userPublicId !== accountValue.userPublicId
      || parseDevicePrivateKeyJson(device.signingPrivateKey) === null
      || parseDevicePublicKeyJson(device.signingPublicKey) === null
      || parseDevicePrivateKeyJson(device.wrappingPrivateKey) === null
      || parseDevicePublicKeyJson(device.wrappingPublicKey) === null
    ) throw new Error("Cloud device custody is inconsistent.");
    if (await this.#custody.read(authLogoutCustodySlot) !== null) {
      throw new Error("Cloud sign-out recovery started during daemon identity acquisition.");
    }
    await requireExactCustodyAuth(this.#custody, auth);
    const registered = {
      authEpoch: accountValue.authEpoch,
      credentialGeneration,
      devicePublicId: accountValue.device.publicId,
      userPublicId: accountValue.userPublicId,
    } as const;
    if (accountValue.device.status === "pending") {
      return { ...registered, activeIdentity: null, status: "pending" };
    }
    const keyObservation = await this.#custody.read("cloud-account-key");
    if (keyObservation === null) throw new Error("The active cloud device key is unavailable.");
    let key: unknown;
    try {
      key = JSON.parse(keyObservation.value) as unknown;
    } catch {
      throw new Error("Cloud account-key custody is corrupt.");
    }
    if (
      !isRecord(key)
      || !hasExactKeys(key, ["key", "keyVersion", "provisional", "userPublicId", "version"])
      || key.version !== 1
      || key.provisional !== false
      || key.userPublicId !== accountValue.userPublicId
      || key.keyVersion !== accountValue.device.keyVersion
      || typeof key.key !== "string"
    ) throw new Error("Cloud device custody is inconsistent.");
    let accountKey: Uint8Array;
    try {
      accountKey = decodeBase64Url(key.key);
    } catch {
      throw new Error("Cloud account-key custody is corrupt.");
    }
    if (accountKey.byteLength !== 32) throw new Error("Cloud account-key custody is corrupt.");
    if (await this.#custody.read(authLogoutCustodySlot) !== null) {
      throw new Error("Cloud sign-out recovery started during daemon identity acquisition.");
    }
    await requireExactCustodyAuth(this.#custody, auth);
    return {
      ...registered,
      activeIdentity: {
        accountKey,
        devicePublicId: accountValue.device.publicId,
        keyVersion: accountValue.device.keyVersion,
        userPublicId: accountValue.userPublicId,
      },
      status: "active",
    };
  }
}

/*
 * Reads the cadence hint out of a device summary page. Only the three fields
 * the hint needs are inspected, and an unparseable row is ignored rather than
 * rejected: a malformed summary must not decide the poll interval by throwing.
 */
export function hasPresentPeerDevice(value: unknown, devicePublicId: string): boolean {
  if (!Array.isArray(value)) return false;
  for (const entry of value as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    if (entry.online !== true) continue;
    if (entry.status !== "active") continue;
    if (typeof entry.publicId !== "string" || entry.publicId === devicePublicId) continue;
    if (typeof entry.deviceClass === "string" && entry.deviceClass !== "browser") continue;
    return true;
  }
  return false;
}

function parseSessionHead(value: unknown): CloudSessionHead {
  if (!isRecord(value)) throw new Error("Cloud session response is invalid.");
  const optional = [
    "compactHasRecoveryGap",
    "compactStreamEpoch",
    "compactTailDigest",
    "detailStreamEpoch",
    "detailTailDigest",
    "metadata",
  ];
  const required = [
    "compactHeadSequence",
    "createdAt",
    "detailHeadSequence",
    "executionDevicePublicId",
    "metadataRevision",
    "projectionRevision",
    "publicId",
    "state",
    "updatedAt",
  ];
  const expected = [...required, ...optional.filter((key) => Object.hasOwn(value, key))];
  const metadata = value.metadata === undefined ? undefined : parseEncryptedEnvelope(value.metadata);
  if (
    !hasExactKeys(value, expected)
    || (value.compactHasRecoveryGap !== undefined
      && typeof value.compactHasRecoveryGap !== "boolean")
    || !isSafeNonNegativeInteger(value.compactHeadSequence)
    || (value.compactStreamEpoch !== undefined
      && !isSafeNonNegativeInteger(value.compactStreamEpoch))
    || (value.compactHeadSequence === 0 && (
      value.compactTailDigest !== undefined
      || (value.compactStreamEpoch ?? 0) !== 0
      || (value.compactHasRecoveryGap ?? false)
    ))
    || (value.compactHeadSequence > 0 && !isDigest(value.compactTailDigest))
    || ((value.compactHasRecoveryGap ?? false) && (value.compactStreamEpoch ?? 0) < 1)
    || (!(value.compactHasRecoveryGap ?? false) && (value.compactStreamEpoch ?? 0) !== 0)
    || !isOpaqueIdentifier(value.executionDevicePublicId)
    || !isSafeNonNegativeInteger(value.metadataRevision)
    || !isSafeNonNegativeInteger(value.projectionRevision)
    || !isOpaqueIdentifier(value.publicId)
    || (value.state !== "active"
      && value.state !== "idle"
      && value.state !== "terminal"
      && value.state !== "orphaned")
    || !isFiniteTimestamp(value.updatedAt)
    || (value.compactTailDigest !== undefined && !isDigest(value.compactTailDigest))
    || !isSafeNonNegativeInteger(value.detailHeadSequence)
    || (value.detailStreamEpoch !== undefined && !isSafeNonNegativeInteger(value.detailStreamEpoch))
    || (value.detailHeadSequence === 0 && value.detailTailDigest !== undefined)
    || (value.detailHeadSequence > 0 && !isDigest(value.detailTailDigest))
    || (value.metadata !== undefined && metadata === null)
  ) throw new Error("Cloud session response is invalid.");
  return {
    compactHasRecoveryGap: value.compactHasRecoveryGap ?? false,
    compactHeadSequence: value.compactHeadSequence,
    compactStreamEpoch: value.compactStreamEpoch ?? 0,
    ...(typeof value.compactTailDigest === "string"
      ? { compactTailDigest: value.compactTailDigest }
      : {}),
    detailHeadSequence: value.detailHeadSequence,
    detailStreamEpoch: value.detailStreamEpoch ?? 0,
    ...(typeof value.detailTailDigest === "string"
      ? { detailTailDigest: value.detailTailDigest }
      : {}),
    executionDevicePublicId: value.executionDevicePublicId,
    ...(metadata === undefined || metadata === null ? {} : { metadata }),
    metadataRevision: value.metadataRevision,
    projectionRevision: value.projectionRevision,
    publicId: value.publicId,
    state: value.state,
    updatedAt: value.updatedAt,
  };
}

function parseSessionHeads(value: unknown): readonly CloudSessionHead[] {
  if (!Array.isArray(value) || value.length > cloudLimits.pageSize) {
    throw new Error("Cloud session response is invalid.");
  }
  const heads = value.map(parseSessionHead);
  if (new Set(heads.map((head) => head.publicId)).size !== heads.length) {
    throw new Error("Cloud session response is invalid.");
  }
  return heads;
}

function parseSessionHeadPage(value: unknown): CloudSessionHeadPage {
  if (!isRecord(value)) throw new Error("Cloud session page is invalid.");
  const optional = ["pageStatus", "splitCursor"].filter((key) =>
    Object.hasOwn(value, key));
  if (
    !hasExactKeys(value, ["continueCursor", "isDone", "page", ...optional])
    || typeof value.continueCursor !== "string"
    || value.continueCursor.length > 16_384
    || (value.isDone === false && value.continueCursor.length < 1)
    || typeof value.isDone !== "boolean"
    || (value.pageStatus !== undefined
      && value.pageStatus !== null
      && value.pageStatus !== "SplitRecommended"
      && value.pageStatus !== "SplitRequired")
    || (value.splitCursor !== undefined
      && value.splitCursor !== null
      && (typeof value.splitCursor !== "string" || value.splitCursor.length > 16_384))
  ) throw new Error("Cloud session page is invalid.");
  const page = parseSessionHeads(value.page);
  if (page.length > maximumRemoteSessions) {
    throw new Error("Cloud session page is invalid.");
  }
  return {
    continueCursor: value.continueCursor,
    isDone: value.isDone,
    page,
  };
}

function validateLocalSessionPage(
  value: CloudLocalSessionPage,
  afterPublicId: string | null,
): CloudLocalSessionPage {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["continueAfterPublicId", "isDone", "sessions"])
    || typeof value.isDone !== "boolean"
    || !Array.isArray(value.sessions)
    || value.sessions.length > maximumLocalSessions
    || (value.continueAfterPublicId !== null
      && !isOpaqueIdentifier(value.continueAfterPublicId))
    || (value.isDone !== (value.continueAfterPublicId === null))
  ) throw new Error("Local cloud session page is invalid.");
  const sessions = value.sessions.map((session) =>
    validateLocalSession(session as CloudLocalSessionHead));
  if (new Set(sessions.map((session) => session.publicId)).size !== sessions.length) {
    throw new Error("Local cloud session projection contains duplicate identifiers.");
  }
  for (let index = 0; index < sessions.length; index += 1) {
    const current = sessions[index];
    const previous = sessions[index - 1];
    if (
      current === undefined
      || (afterPublicId !== null && current.publicId <= afterPublicId)
      || (previous !== undefined && current.publicId <= previous.publicId)
      || (value.continueAfterPublicId !== null
        && current.publicId > value.continueAfterPublicId)
    ) throw new Error("Local cloud session page is invalid.");
  }
  if (
    value.continueAfterPublicId !== null
    && afterPublicId !== null
    && value.continueAfterPublicId <= afterPublicId
  ) throw new Error("Local cloud session page is invalid.");
  return {
    continueAfterPublicId: value.continueAfterPublicId,
    isDone: value.isDone,
    sessions,
  };
}

function parseCompactProjectionRecoveryResponse(
  value: unknown,
): CloudProjectionRecoveryAppliedResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "boundaryHeadSequence",
      "boundaryTailDigest",
      "compactHasRecoveryGap",
      "compactStreamEpoch",
      "epochPublicId",
      "projectionRevision",
      "sessionPublicId",
    ])
    || !isSafePositiveInteger(value.boundaryHeadSequence)
    || !isDigest(value.boundaryTailDigest)
    || value.compactHasRecoveryGap !== true
    || !isSafePositiveInteger(value.compactStreamEpoch)
    || !isUuidV7(value.epochPublicId)
    || !isSafePositiveInteger(value.projectionRevision)
    || !isOpaqueIdentifier(value.sessionPublicId)
  ) throw new Error("Cloud projection recovery response is invalid.");
  return {
    boundaryHeadSequence: value.boundaryHeadSequence,
    boundaryTailDigest: value.boundaryTailDigest,
    compactHasRecoveryGap: true,
    compactStreamEpoch: value.compactStreamEpoch,
    epochPublicId: value.epochPublicId,
    projectionRevision: value.projectionRevision,
    sessionPublicId: value.sessionPublicId,
  };
}

function parseSessionChunk(value: unknown): CloudSessionChunk {
  if (!isRecord(value)) throw new Error("Cloud session chunk is invalid.");
  const optional = [
    ...(value.previousDigest === undefined ? [] : ["previousDigest"]),
    ...(value.streamEpoch === undefined ? [] : ["streamEpoch"]),
  ];
  if (!hasExactKeys(value, [
    "authority",
    "createdAt",
    "digest",
    "envelope",
    "firstSequence",
    "lastSequence",
    ...optional,
    "sourceDevicePublicId",
    "stream",
  ])) throw new Error("Cloud session chunk is invalid.");
  const authority = parseAuthorityTuple(value.authority);
  const envelope = parseEncryptedEnvelope(value.envelope);
  if (
    authority === null
    || !isDigest(value.digest)
    || envelope === null
    || !isSafePositiveInteger(value.firstSequence)
    || !isSafePositiveInteger(value.lastSequence)
    || value.lastSequence < value.firstSequence
    || (value.previousDigest !== undefined && !isDigest(value.previousDigest))
    || !isOpaqueIdentifier(value.sourceDevicePublicId)
    || (value.streamEpoch !== undefined && !isSafeNonNegativeInteger(value.streamEpoch))
    || value.stream !== "compact"
  ) throw new Error("Cloud session chunk is invalid.");
  return {
    authority,
    digest: value.digest,
    envelope,
    firstSequence: value.firstSequence,
    lastSequence: value.lastSequence,
    ...(typeof value.previousDigest === "string" ? { previousDigest: value.previousDigest } : {}),
    sourceDevicePublicId: value.sourceDevicePublicId,
    streamEpoch: value.streamEpoch ?? 0,
  };
}

function parseLease(value: unknown): CloudLease {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "bootGeneration",
      "bootId",
      "devicePublicId",
      "fence",
      "heartbeatFingerprint",
      "heartbeatSequence",
      "leaseUntil",
    ])
    || !isSafePositiveInteger(value.bootGeneration)
    || !isOpaqueIdentifier(value.bootId)
    || !isOpaqueIdentifier(value.devicePublicId)
    || !isSafePositiveInteger(value.fence)
    || typeof value.heartbeatFingerprint !== "string"
    || (value.heartbeatFingerprint !== "initial" && !isDigest(value.heartbeatFingerprint))
    || !isSafeNonNegativeInteger(value.heartbeatSequence)
    || !isFiniteTimestamp(value.leaseUntil)
  ) throw new Error("Cloud execution lease response is invalid.");
  return value as CloudLease;
}

function parseCommandState(value: unknown): CommandState | null {
  return value === "pending"
    || value === "prepared"
    || value === "effect_started"
    || value === "applied"
    || value === "failed"
    || value === "ambiguous"
    || value === "cancelled"
    || value === "expired"
    ? value
    : null;
}

function isTerminalCommandState(state: CommandState): boolean {
  return state === "applied"
    || state === "failed"
    || state === "ambiguous"
    || state === "cancelled"
    || state === "expired";
}

function parseCommandKind(value: unknown): CommandKind | null {
  return isCommandKind(value) ? value : null;
}

function parseCloudCommand(value: unknown): CloudCommand {
  if (!isRecord(value)) throw new Error("Cloud command response is invalid.");
  const optional = ["boundAuthority", "requestingDevicePublicId", "result", "resultCode"]
    .filter((key) => Object.hasOwn(value, key));
  if (!hasExactKeys(value, [
    ...optional,
    "createdAt",
    "deadline",
    "kind",
    "payload",
    "publicId",
    "sessionPublicId",
    "state",
    "updatedAt",
  ])) throw new Error("Cloud command response is invalid.");
  const boundAuthority = value.boundAuthority === undefined
    ? undefined
    : parseAuthorityTuple(value.boundAuthority);
  const kind = parseCommandKind(value.kind);
  const payload = parseEncryptedEnvelope(value.payload);
  const state = parseCommandState(value.state);
  if (
    (value.boundAuthority !== undefined && boundAuthority === null)
    || !isFiniteTimestamp(value.createdAt)
    || !isFiniteTimestamp(value.deadline)
    || kind === null
    || payload === null
    || !isUuidV7(value.publicId)
    || (value.requestingDevicePublicId !== undefined && !isOpaqueIdentifier(value.requestingDevicePublicId))
    || !isOpaqueIdentifier(value.sessionPublicId)
    || state === null
    || (value.result !== undefined && parseEncryptedEnvelope(value.result) === null)
    || (value.resultCode !== undefined
      && (typeof value.resultCode !== "string"
        || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.resultCode)))
  ) throw new Error("Cloud command response is invalid.");
  return {
    ...(boundAuthority === undefined || boundAuthority === null ? {} : { boundAuthority }),
    createdAt: value.createdAt,
    deadline: value.deadline,
    kind,
    payload,
    publicId: value.publicId,
    ...(typeof value.requestingDevicePublicId === "string"
      ? { requestingDevicePublicId: value.requestingDevicePublicId }
      : {}),
    sessionPublicId: value.sessionPublicId,
    state,
  };
}

type CloudDeviceCommand = Readonly<{
  boundAuthority?: AuthorityTuple;
  createdAt: number;
  deadline: number;
  kind: DeviceCommandKind;
  payload: EncryptedEnvelope;
  publicId: string;
  requestDigest?: string;
  requestingDevicePublicId: string;
  resultCode?: string;
  resultConsumed?: boolean;
  resultSingleUse?: true;
  state: CommandState;
  targetDevicePublicId?: string;
}>;

function parseCloudDeviceCommands(value: unknown): readonly CloudDeviceCommand[] {
  if (!Array.isArray(value) || value.length > cloudLimits.pageSize) {
    throw new Error("Cloud device command response is invalid.");
  }
  const commands = value.map((entry): CloudDeviceCommand => {
    if (!isRecord(entry)) throw new Error("Cloud device command response is invalid.");
    const optional = [
      "boundAuthority",
      "requestDigest",
      "result",
      "resultCode",
      "resultConsumed",
      "resultSingleUse",
      "targetDevicePublicId",
    ].filter((key) => Object.hasOwn(entry, key));
    const boundAuthority = entry.boundAuthority === undefined
      ? undefined
      : parseAuthorityTuple(entry.boundAuthority);
    const payload = parseEncryptedEnvelope(entry.payload);
    const state = parseCommandState(entry.state);
    if (
      !hasExactKeys(entry, [
        ...optional,
        "createdAt",
        "deadline",
        "kind",
        "payload",
        "publicId",
        "requestingDevicePublicId",
        "state",
        "updatedAt",
      ])
      || (entry.boundAuthority !== undefined && boundAuthority === null)
      || !isFiniteTimestamp(entry.createdAt)
      || !isFiniteTimestamp(entry.deadline)
      || !isDeviceCommandKind(entry.kind)
      || payload === null
      || !isUuidV7(entry.publicId)
      || !isOpaqueIdentifier(entry.requestingDevicePublicId)
      || (entry.requestDigest !== undefined && !isDigest(entry.requestDigest))
      || (entry.result !== undefined && parseEncryptedEnvelope(entry.result) === null)
      || (entry.resultCode !== undefined
        && (typeof entry.resultCode !== "string"
          || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.resultCode)))
      || (entry.resultConsumed !== undefined && typeof entry.resultConsumed !== "boolean")
      || (entry.resultSingleUse !== undefined && entry.resultSingleUse !== true)
      || (entry.resultConsumed !== undefined && entry.resultSingleUse !== true)
      || (entry.targetDevicePublicId !== undefined
        && !isOpaqueIdentifier(entry.targetDevicePublicId))
      || state === null
    ) throw new Error("Cloud device command response is invalid.");
    return {
      ...(boundAuthority === undefined || boundAuthority === null ? {} : { boundAuthority }),
      createdAt: entry.createdAt,
      deadline: entry.deadline,
      kind: entry.kind,
      payload,
      publicId: entry.publicId,
      ...(typeof entry.requestDigest === "string" ? { requestDigest: entry.requestDigest } : {}),
      requestingDevicePublicId: entry.requestingDevicePublicId,
      ...(typeof entry.resultCode === "string" ? { resultCode: entry.resultCode } : {}),
      ...(typeof entry.resultConsumed === "boolean"
        ? { resultConsumed: entry.resultConsumed }
        : {}),
      ...(entry.resultSingleUse === true ? { resultSingleUse: true as const } : {}),
      state,
      ...(typeof entry.targetDevicePublicId === "string"
        ? { targetDevicePublicId: entry.targetDevicePublicId }
        : {}),
    };
  });
  if (new Set(commands.map((command) => command.publicId)).size !== commands.length) {
    throw new Error("Cloud device command response is invalid.");
  }
  return commands;
}

function parseCloudCommandMetadata(value: unknown): CloudCommandMetadata {
  if (!isRecord(value)) throw new Error("Cloud command metadata is invalid.");
  const optional = ["boundAuthority", "result", "resultCode"]
    .filter((key) => Object.hasOwn(value, key));
  if (!hasExactKeys(value, [
    ...optional,
    "createdAt",
    "deadline",
    "kind",
    "publicId",
    "sessionPublicId",
    "state",
    "updatedAt",
  ])) throw new Error("Cloud command metadata is invalid.");
  const boundAuthority = value.boundAuthority === undefined
    ? undefined
    : parseAuthorityTuple(value.boundAuthority);
  const kind = parseCommandKind(value.kind);
  const state = parseCommandState(value.state);
  if (
    (value.boundAuthority !== undefined && boundAuthority === null)
    || !isFiniteTimestamp(value.createdAt)
    || !isFiniteTimestamp(value.deadline)
    || kind === null
    || !isUuidV7(value.publicId)
    || !isOpaqueIdentifier(value.sessionPublicId)
    || state === null
    || (value.result !== undefined && parseEncryptedEnvelope(value.result) === null)
    || (value.resultCode !== undefined
      && (typeof value.resultCode !== "string"
        || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.resultCode)))
  ) throw new Error("Cloud command metadata is invalid.");
  return {
    ...(boundAuthority === undefined || boundAuthority === null ? {} : { boundAuthority }),
    createdAt: value.createdAt,
    deadline: value.deadline,
    kind,
    publicId: value.publicId,
    sessionPublicId: value.sessionPublicId,
    state,
  };
}

function parseCloudCommandMetadataPage(value: unknown): CloudCommandMetadataPage {
  if (!isRecord(value)) throw new Error("Cloud command metadata page is invalid.");
  const optional = ["pageStatus", "splitCursor"].filter((key) => Object.hasOwn(value, key));
  if (!hasExactKeys(value, ["continueCursor", "isDone", "page", ...optional])) {
    throw new Error("Cloud command metadata page is invalid.");
  }
  if (
    typeof value.continueCursor !== "string"
    || value.continueCursor.length > 16_384
    || typeof value.isDone !== "boolean"
    || !Array.isArray(value.page)
    || value.page.length > cloudLimits.pageSize
  ) throw new Error("Cloud command metadata page is invalid.");
  const page = value.page.map(parseCloudCommandMetadata);
  if (new Set(page.map((command) => command.publicId)).size !== page.length) {
    throw new Error("Cloud command metadata page is invalid.");
  }
  return { continueCursor: value.continueCursor, isDone: value.isDone, page };
}

function sameCloudCommandMetadata(
  metadata: CloudCommandMetadata,
  command: CloudCommand,
): boolean {
  return metadata.publicId === command.publicId
    && metadata.sessionPublicId === command.sessionPublicId
    && metadata.kind === command.kind
    && metadata.state === command.state
    && metadata.deadline === command.deadline
    && metadata.createdAt === command.createdAt
    && (
      metadata.boundAuthority === undefined
        ? command.boundAuthority === undefined
        : command.boundAuthority !== undefined
          && sameAuthority(metadata.boundAuthority, command.boundAuthority)
    );
}

function parseCloudUsageAccountBinding(value: unknown): CloudUsageAccountBinding | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, [
    "binding",
    "encryptedMetadata",
    "matchKey",
    "publicId",
  ])) throw new Error("Cloud usage account response is invalid.");
  const encryptedMetadata = parseEncryptedEnvelope(
    value.encryptedMetadata,
    cloudLimits.metadataCiphertextCharacters,
  );
  if (
    encryptedMetadata === null
    || !isDigest(value.matchKey)
    || !isOpaqueIdentifier(value.publicId)
  ) throw new Error("Cloud usage account response is invalid.");
  if (value.binding === null) return {
    binding: null,
    encryptedMetadata,
    matchKey: value.matchKey,
    publicId: value.publicId,
  };
  if (!isRecord(value.binding) || !hasExactKeys(value.binding, [
    "encryptedLocalReference",
    "sourceGeneration",
    "state",
    "usageSourceRevision",
  ])) throw new Error("Cloud usage account response is invalid.");
  const encryptedLocalReference = parseEncryptedEnvelope(
    value.binding.encryptedLocalReference,
    cloudLimits.metadataCiphertextCharacters,
  );
  if (
    encryptedLocalReference === null
    || !isSafePositiveInteger(value.binding.sourceGeneration)
    || !isSafeNonNegativeInteger(value.binding.usageSourceRevision)
    || (value.binding.state !== "present" && value.binding.state !== "removed")
  ) throw new Error("Cloud usage account response is invalid.");
  return {
    binding: {
      encryptedLocalReference,
      sourceGeneration: value.binding.sourceGeneration,
      state: value.binding.state,
      usageSourceRevision: value.binding.usageSourceRevision,
    },
    encryptedMetadata,
    matchKey: value.matchKey,
    publicId: value.publicId,
  };
}

function parseExactCloudCommand(value: unknown): CloudCommand | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || !isDigest(value.requestDigest)
    || !isOpaqueIdentifier(value.targetDevicePublicId)
  ) throw new Error("Cloud command response is invalid.");
  const commandValue = { ...value };
  delete commandValue.requestDigest;
  delete commandValue.targetDevicePublicId;
  return parseCloudCommand(commandValue);
}

function authorityOf(lease: CloudLease): AuthorityTuple {
  return {
    bootGeneration: lease.bootGeneration,
    bootId: lease.bootId,
    fence: lease.fence,
  };
}

function sameAuthority(left: AuthorityTuple, right: AuthorityTuple): boolean {
  return left.bootGeneration === right.bootGeneration
    && left.bootId === right.bootId
    && left.fence === right.fence;
}

type ProjectionRecoveryProofInput = Readonly<Pick<
  CloudProjectionRecoveryJournalEntry,
  | "authority"
  | "baselineCompletedTurns"
  | "baselineInteractions"
  | "epochPublicId"
  | "expectedCompactStreamEpoch"
  | "expectedHeadSequence"
  | "expectedTailDigest"
  | "idempotencyKey"
  | "localAuthority"
  | "replacementCacheId"
  | "sessionPublicId"
  | "sourceCacheId"
  | "sourceDevicePublicId"
  | "userPublicId"
>>;

async function projectionRecoveryProofs(
  accountKey: Uint8Array,
  input: ProjectionRecoveryProofInput,
): Promise<Readonly<{ lineageCommitment: string; requestDigest: string }>> {
  const lineageCommitment = await hmacSha256Hex(
    accountKey,
    "projection-epoch-lineage",
    JSON.stringify({
      authority: input.authority,
      baselineCompletedTurns: input.baselineCompletedTurns,
      baselineInteractions: input.baselineInteractions ?? [],
      epochPublicId: input.epochPublicId,
      expectedCompactStreamEpoch: input.expectedCompactStreamEpoch,
      expectedHeadSequence: input.expectedHeadSequence,
      expectedTailDigest: input.expectedTailDigest,
      localAuthority: input.localAuthority,
      replacementCacheId: input.replacementCacheId,
      sessionPublicId: input.sessionPublicId,
      sourceDevicePublicId: input.sourceDevicePublicId,
      sourceCacheId: input.sourceCacheId,
      userPublicId: input.userPublicId,
    }),
  );
  const request = {
    authority: input.authority,
    epochPublicId: input.epochPublicId,
    expectedCompactStreamEpoch: input.expectedCompactStreamEpoch,
    expectedHeadSequence: input.expectedHeadSequence,
    expectedTailDigest: input.expectedTailDigest,
    idempotencyKey: input.idempotencyKey,
    lineageCommitment,
    sessionPublicId: input.sessionPublicId,
  } as const;
  return {
    lineageCommitment,
    requestDigest: await hmacSha256Hex(
      accountKey,
      "projection-epoch-request",
      JSON.stringify(request),
    ),
  };
}

function samePendingUsageAccount(
  left: PendingCloudUsageAccount | null,
  right: PendingCloudUsageAccount,
): boolean {
  return left !== null
    && left.accountPublicId === right.accountPublicId
    && JSON.stringify(left.encryptedLocalReference)
      === JSON.stringify(right.encryptedLocalReference)
    && JSON.stringify(left.encryptedMetadata) === JSON.stringify(right.encryptedMetadata)
    && left.idempotencyKey === right.idempotencyKey
    && left.matchKey === right.matchKey
    && left.requestDigest === right.requestDigest
    && left.sourceGeneration === right.sourceGeneration
    && left.sourceRevision === right.sourceRevision;
}

function sameUsageCursor(
  left: CloudUsageAccountCursor | undefined,
  right: CloudUsageAccountCursor,
): boolean {
  return left !== undefined
    && left.accountPublicId === right.accountPublicId
    && left.sourceGeneration === right.sourceGeneration
    && left.sourceRevision === right.sourceRevision;
}

function normalizedUsageMatchReference(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function parseUsageSnapshotReceipt(
  value: unknown,
  sourceRevision: number,
): void {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["disposition", "sourceRevision"])
    || (value.disposition !== "replace"
      && value.disposition !== "store"
      && value.disposition !== "coalesced"
      && value.disposition !== "replay")
    || value.sourceRevision !== sourceRevision
  ) throw new Error("Cloud usage snapshot receipt is invalid.");
}

function sameCommandJournalEntry(
  left: CloudCommandJournalEntry,
  right: CloudCommandJournalEntry,
): boolean {
  return left.commandPublicId === right.commandPublicId
    && left.kind === right.kind
    && left.localAuthorityDigest === right.localAuthorityDigest
    && left.payloadDigest === right.payloadDigest
    && left.phase === right.phase
    && left.sessionPublicId === right.sessionPublicId
    && sameAuthority(left.authority, right.authority)
    && (left.phase !== "terminal" || right.phase !== "terminal" || (
      left.resultCode === right.resultCode
      && left.resultDigest === right.resultDigest
      && left.terminalState === right.terminalState
    ));
}

function uuidV7(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new Error("System clock cannot produce a cloud idempotency key.");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  const byteSix = bytes[6];
  const byteEight = bytes[8];
  if (byteSix === undefined || byteEight === undefined) {
    throw new Error("Cryptographic randomness is unavailable.");
  }
  bytes[6] = 0x70 | (byteSix & 0x0f);
  bytes[8] = 0x80 | (byteEight & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateConnectionUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value)
  ) throw new Error("Cloud presence connection generator returned an invalid UUID.");
  return value.toLowerCase();
}

function samePresenceIdentity(
  left: CloudPresenceState["identity"],
  right: RegisteredCloudIdentity,
): boolean {
  return left.authEpoch === right.authEpoch
    && left.credentialGeneration === right.credentialGeneration
    && left.devicePublicId === right.devicePublicId
    && left.userPublicId === right.userPublicId;
}

function validateRegisteredIdentity(value: RegisteredCloudIdentity): RegisteredCloudIdentity {
  if (
    !isSafePositiveInteger(value.authEpoch)
    || !isSafePositiveInteger(value.credentialGeneration)
    || !isOpaqueIdentifier(value.devicePublicId)
    || !isOpaqueIdentifier(value.userPublicId)
  ) throw new Error("Cloud registered-device identity is invalid.");
  if (value.status === "pending") {
    return value;
  }
  if (
    !(value.activeIdentity.accountKey instanceof Uint8Array)
    || value.activeIdentity.accountKey.byteLength !== 32
    || value.activeIdentity.devicePublicId !== value.devicePublicId
    || !isSafePositiveInteger(value.activeIdentity.keyVersion)
    || value.activeIdentity.userPublicId !== value.userPublicId
  ) throw new Error("Cloud registered-device identity is invalid.");
  return value;
}

async function presenceRequest(
  identity: RegisteredCloudIdentity,
  connectionId: string,
  kind: CloudPresenceRequest["kind"],
  sequence: number,
): Promise<CloudPresenceRequest> {
  if (!isSafeNonNegativeInteger(sequence)) {
    throw new Error("Cloud presence sequence is exhausted.");
  }
  const fingerprint = await sha256Hex([
    "hra-control-plane-cloud-presence:v1",
    identity.userPublicId,
    String(identity.authEpoch),
    identity.devicePublicId,
    String(identity.credentialGeneration),
    connectionId,
    kind,
    String(sequence),
  ].join("\n"));
  return {
    connectionId,
    credentialGeneration: identity.credentialGeneration,
    fingerprint,
    kind,
    sequence,
  };
}

function parsePresenceResponse(
  value: unknown,
  expected: Pick<CloudPresenceRequest, "connectionId" | "sequence">,
  expectedOnline?: boolean,
): CloudPresenceResponse {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "connectionId",
      "lastSeenAt",
      "online",
      "presenceUntil",
      "sequence",
      "serverNow",
    ])
    || !isOpaqueIdentifier(value.connectionId)
    || !isFiniteTimestamp(value.lastSeenAt)
    || typeof value.online !== "boolean"
    || !isFiniteTimestamp(value.presenceUntil)
    || !isSafeNonNegativeInteger(value.sequence)
    || !isFiniteTimestamp(value.serverNow)
    || value.connectionId !== expected.connectionId
    || value.sequence !== expected.sequence
    || value.lastSeenAt > value.serverNow
    || value.presenceUntil < value.lastSeenAt
    || value.online !== (value.presenceUntil > value.serverNow)
    || (expectedOnline !== undefined && value.online !== expectedOnline)
  ) throw new Error("Cloud presence response is invalid.");
  const serverTtlMs = value.presenceUntil - value.serverNow;
  if (
    value.online
    && (!Number.isSafeInteger(serverTtlMs) || serverTtlMs < 1 || serverTtlMs > maximumPresenceTtlMs)
  ) throw new Error("Cloud presence response is invalid.");
  return {
    connectionId: value.connectionId,
    lastSeenAt: value.lastSeenAt,
    online: value.online,
    presenceUntil: value.presenceUntil,
    sequence: value.sequence,
    serverNow: value.serverNow,
    serverTtlMs,
  };
}

function validateUuid(value: string): string {
  if (!isUuidV7(value)) throw new Error("Cloud idempotency generator returned an invalid UUIDv7.");
  return value;
}

function uuidV7Timestamp(value: string): number | null {
  if (!isUuidV7(value)) return null;
  const timestamp = Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function idempotencyExpired(value: string, now: number): boolean {
  const timestamp = uuidV7Timestamp(value);
  return timestamp === null || timestamp < now - maximumIdempotencyLifetimeMs;
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Cloud operation failed.";
  if (
    containsAbsolutePath(message)
    || containsUnsafeTerminalScalar(message, true)
    || /(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:sk|re)_[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~-]{8,})/u
      .test(message)
  ) return "Cloud operation failed with a redacted diagnostic.";
  return message.slice(0, 256);
}

function projectionRecoveryRejectionCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.message.includes("SESSION_COMPACT_EPOCH_CONFLICT")) {
    return "SESSION_COMPACT_EPOCH_CONFLICT";
  }
  if (error.message.includes("IDEMPOTENCY_CONFLICT")) return "IDEMPOTENCY_CONFLICT";
  if (error.message.includes("Cloud authority is not current")) {
    return "AUTHORITY_NOT_CURRENT";
  }
  if (error.message.includes("Invalid idempotency authority")) {
    return invalidIdempotencyProjectionRecoveryCode;
  }
  return null;
}

function validateLocalSession(value: CloudLocalSessionHead): CloudLocalSessionHead {
  if (
    !isOpaqueIdentifier(value.publicId)
    || !isFiniteTimestamp(value.createdAt)
    || !isFiniteTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt
    || parseSessionMetadataPayload(value.metadata) === null
  ) throw new Error("Local cloud session projection is invalid.");
  return value;
}

function validateUsage(value: CloudLocalUsageSnapshot): CloudLocalUsageSnapshot {
  const metadataJson = JSON.stringify(value.metadata);
  if (
    typeof value.localReference !== "string"
    || value.localReference.length < 1
    || value.localReference.length > 512
    || typeof value.matchReference !== "string"
    || value.matchReference.length < 3
    || value.matchReference.length > 320
    || !isFiniteTimestamp(value.observedAt)
    || !isSafePositiveInteger(value.sourceGeneration)
    || !isSafePositiveInteger(value.sourceRevision)
    || parseUsageProjection(value.projection) === null
    || new TextEncoder().encode(metadataJson).byteLength > 4_096
  ) throw new Error("Local cloud usage projection is invalid.");
  return value;
}

function validateLocalCommandAuthority(
  value: CloudLocalCommandAuthority | null,
): CloudLocalCommandAuthority {
  if (
    value === null
    || !isOpaqueIdentifier(value.localSessionId)
    || !isSafePositiveInteger(value.profileGeneration)
    || !isOpaqueIdentifier(value.profileId)
    || typeof value.providerThreadId !== "string"
    || value.providerThreadId.length < 1
    || value.providerThreadId.length > 200
  ) throw new Error("Local provider command authority is unavailable.");
  return value;
}

async function encryptPrivateJson(
  value: unknown,
  identity: ActiveCloudIdentity,
  entityPublicId: string,
  kind: "account_metadata" | "account_local_reference",
): Promise<EncryptedEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  if (plaintext.byteLength > 8_192) throw new Error("Private cloud metadata is too large.");
  const aad = new TextEncoder().encode([
    "hra-control-plane-private-json:v1",
    kind,
    identity.userPublicId,
    entityPublicId,
    String(identity.keyVersion),
  ].join("\n"));
  return await encryptBytes(
    plaintext,
    identity.accountKey,
    identity.keyVersion,
    aad,
  );
}

async function decryptPrivateLocalReference(
  envelope: EncryptedEnvelope,
  identity: ActiveCloudIdentity,
  entityPublicId: string,
): Promise<string> {
  const aad = new TextEncoder().encode([
    "hra-control-plane-private-json:v1",
    "account_local_reference",
    identity.userPublicId,
    entityPublicId,
    String(envelope.keyVersion),
  ].join("\n"));
  const plaintext = await decryptBytes(envelope, identity.accountKey, aad);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    throw new Error("Cloud account local-reference evidence is invalid.");
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["value"])
    || !isOpaqueIdentifier(value.value)
  ) throw new Error("Cloud account local-reference evidence is invalid.");
  return value.value;
}

export class LocalCloudDaemonBridge implements CloudDaemonBridge {
  readonly #daemonAuthority: Readonly<{ bootGeneration: number; bootId: string }>;
  readonly #daemonAuthorityFence: Readonly<{ assertCurrent(): Promise<void> }>;
  readonly #deploymentAuthority: CloudDeploymentAuthority;
  readonly #executor: CloudCommandExecutorPort;
  readonly #deviceExecutor: CloudDeviceCommandExecutorPort | null;
  readonly #identity: CloudDaemonIdentityPort;
  readonly #journal: CloudDaemonJournalPort;
  readonly #leaseDurationMs: number;
  readonly #live = new Map<string, LiveSessionState>();
  readonly #local: CloudDaemonLocalSourcePort;
  readonly #now: () => number;
  readonly #optionalSyncBudgetMs: number;
  readonly #pushWake: CloudPushWakePort | null;
  #peerPresence: Readonly<{ observedAt: number; present: boolean }> | null = null;
  readonly #randomConnectionUuid: () => string;
  readonly #randomUuid: () => string;
  readonly #sessionSyncCursor: CloudSessionSyncCursorPort;
  readonly #transport: CloudTransport;
  #closed = false;
  #optionalTask: OptionalCloudSyncTask | null = null;
  #presenceState: CloudPresenceState | null = null;
  #deviceRegistryState: CloudDeviceRegistryState | null = null;
  readonly #projectionRecoverySupersededSessions = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: LocalCloudDaemonBridgeOptions) {
    const leaseDurationMs = options.leaseDurationMs ?? defaultLeaseDurationMs;
    const optionalSyncBudgetMs = options.optionalSyncBudgetMs ?? defaultOptionalSyncBudgetMs;
    if (
      !Number.isSafeInteger(leaseDurationMs)
      || leaseDurationMs < 5_000
      || leaseDurationMs > 120_000
    ) throw new Error("Cloud lease duration is invalid.");
    if (
      !Number.isSafeInteger(optionalSyncBudgetMs)
      || optionalSyncBudgetMs < 1
      || optionalSyncBudgetMs > 60_000
    ) throw new Error("Cloud optional sync budget is invalid.");
    if (
      !isSafePositiveInteger(options.daemonAuthority.bootGeneration)
      || !isOpaqueIdentifier(options.daemonAuthority.bootId)
    ) throw new Error("Cloud daemon authority is invalid.");
    this.#daemonAuthority = options.daemonAuthority;
    this.#daemonAuthorityFence = options.daemonAuthorityFence;
    this.#deploymentAuthority = options.deploymentAuthority;
    this.#executor = options.executor;
    this.#deviceExecutor = options.deviceExecutor ?? null;
    this.#identity = options.identity;
    this.#journal = options.journal;
    this.#leaseDurationMs = leaseDurationMs;
    this.#local = options.local;
    this.#now = options.now ?? Date.now;
    this.#optionalSyncBudgetMs = optionalSyncBudgetMs;
    this.#pushWake = options.pushWake ?? null;
    this.#randomConnectionUuid = options.randomConnectionUuid ?? (() => crypto.randomUUID());
    this.#randomUuid = options.randomUuid ?? (() => uuidV7(this.#now()));
    this.#sessionSyncCursor = options.sessionSyncCursor;
    this.#transport = deploymentFencedCloudTransport(
      options.transport,
      this.#deploymentAuthority,
    );
  }

  pushWake(): CloudPushWakePort | null {
    return this.#pushWake;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pushWake?.close().catch(() => undefined);
    await this.#tail.catch(() => undefined);
    const optional = this.#optionalTask;
    if (optional !== null) {
      optional.controller.abort(new Error("Cloud daemon bridge is closing."));
      let resolveDeadline!: () => void;
      const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve; });
      const timer = setTimeout(resolveDeadline, this.#optionalSyncBudgetMs);
      await Promise.race([optional.promise.then(() => undefined), deadline]);
      clearTimeout(timer);
      if (optional.state.outcome !== null && this.#optionalTask === optional) {
        this.#optionalTask = null;
      }
    }
    await this.#disconnectPresenceBestEffort();
  }

  async cycle(signal: AbortSignal): Promise<CloudDaemonCycleResult> {
    if (this.#closed) throw new Error("The cloud daemon bridge is closed.");
    return await this.#exclusive(async () => {
      const result = {
        activity: { localTurnActive: false, peerDevicePresent: false } as CloudDaemonActivity,
        commandsApplied: 0,
        commandsUnsettled: 0,
        errors: [] as string[],
        online: true,
        remoteSessions: [] as RemoteCloudSession[],
        sessionsUploaded: 0,
        usageUploaded: 0,
      };
      try {
        await this.#assertDaemonCurrent(signal);
        const registeredIdentity = await this.#requireRegisteredIdentity(signal);
        await this.#maintainPresence(registeredIdentity, signal);
        result.activity = { ...result.activity, localTurnActive: await this.#localTurnActive() };
        if (registeredIdentity.status === "pending") return result;
        const identity = registeredIdentity.activeIdentity;
        result.activity = {
          ...result.activity,
          peerDevicePresent: await this.#peerDevicePresent(identity, signal),
        };
        await this.#assertDaemonCurrent(signal);
        try {
          await this.#publishDeviceRegistry(identity, signal);
        } catch (error: unknown) {
          if (signal.aborted) throw error;
          // The settings projection is auxiliary: a failed publish is
          // reported and retried next cycle, it never stops command
          // execution or session sync.
          this.#deviceRegistryState = null;
          result.errors.push(`device registry: ${normalizeError(error)}`);
        }
        await this.#assertDaemonCurrent(signal);
        const heads = parseSessionHeadPage(await this.#transport.query(
          "sessions:listHeadsPage",
          { paginationOpts: { cursor: null, numItems: maximumRemoteSessions } },
        )).page;
        const headById = new Map(heads.map((head) => [head.publicId, head]));
        const leases = new Map<string, CloudLease>();
        const recoveryJournal = await this.#journal.read();
        await this.#assertDaemonCurrent(signal);
        const projectionRecoveryBlockedSessionIds = new Set(
          recoveryJournal.state.projectionRecoveries
            .map((entry) => entry.sessionPublicId),
        );
        const commandResult = await this.#processCommands(
          identity,
          headById,
          leases,
          projectionRecoveryBlockedSessionIds,
          signal,
          result.errors,
        );
        result.commandsApplied = commandResult.applied;
        result.commandsUnsettled = commandResult.unsettled;
        const deviceCommandResult = await this.#processDeviceCommands(
          identity,
          signal,
          result.errors,
        );
        result.commandsApplied += deviceCommandResult.applied;
        const previousOptional = this.#optionalTask;
        if (previousOptional !== null) {
          if (previousOptional.state.outcome === null) {
            result.errors.push("optional sync: A prior bounded projection sync is still settling; this cycle skipped optional work.");
          } else {
            this.#optionalTask = null;
            const outcome = previousOptional.state.outcome;
            if (outcome.state === "completed") {
              result.errors.push(...outcome.result.errors);
              result.remoteSessions = [...outcome.result.remoteSessions];
              result.sessionsUploaded = outcome.result.sessionsUploaded;
              result.usageUploaded = outcome.result.usageUploaded;
            } else {
              result.errors.push(`optional sync: ${normalizeError(outcome.error)}`);
            }
          }
        } else {
        const optionalController = new AbortController();
        const abortOptional = () => optionalController.abort(signal.reason);
        signal.addEventListener("abort", abortOptional, { once: true });
        const optionalResult = {
          errors: [] as string[],
          remoteSessions: [] as RemoteCloudSession[],
          sessionsUploaded: 0,
          usageUploaded: 0,
        };
        const optionalTask = (async () => {
          const terminalUpdates: Array<Readonly<{
            head: CloudSessionHead;
            lease: CloudLease;
            session: CloudLocalSessionHead;
          }>> = [];
          const localCursor = await this.#sessionSyncCursor.read();
          const localPage = validateLocalSessionPage(await this.#local.listSessions({
            afterPublicId: localCursor.state.localAfterPublicId,
            limit: maximumLocalSessions,
            signal: optionalController.signal,
          }), localCursor.state.localAfterPublicId);
          const localSessions = localPage.sessions;
          abortBeforeEffect(optionalController.signal);
          for (const session of localSessions) {
            abortBeforeEffect(optionalController.signal);
            try {
              let head = headById.get(session.publicId);
              if (head === undefined) {
                const existing = await this.#transport.query("sessions:getHead", {
                  publicId: session.publicId,
                });
                abortBeforeEffect(optionalController.signal);
                if (existing === null) {
                  await this.#createSession(identity, session, optionalController.signal);
                  const refreshed = await this.#transport.query("sessions:getHead", {
                    publicId: session.publicId,
                  });
                  abortBeforeEffect(optionalController.signal);
                  if (refreshed === null) throw new Error("Created cloud session is unavailable.");
                  head = parseSessionHead(refreshed);
                } else {
                  head = parseSessionHead(existing);
                }
                headById.set(head.publicId, head);
              }
              if (head.executionDevicePublicId !== identity.devicePublicId) continue;
              if (projectionRecoveryBlockedSessionIds.has(session.publicId)) continue;
              const lease = await this.#ensureLease(session.publicId, identity);
              abortBeforeEffect(optionalController.signal);
              leases.set(session.publicId, lease);
              this.#registerLive(session, head, lease);
              head = await this.#updateMetadata(
                identity,
                session,
                head,
                optionalController.signal,
              );
              abortBeforeEffect(optionalController.signal);
              const compact = await this.#appendCompact(
                identity,
                session,
                head,
                lease,
                optionalController.signal,
              );
              if (compact.uploaded) {
                optionalResult.sessionsUploaded += 1;
              }
              if (head.state !== session.state && head.state !== "orphaned" && head.state !== "terminal") {
                if (session.state === "terminal") {
                  if (compact.complete) terminalUpdates.push({ head, lease, session });
                } else {
                  abortBeforeEffect(optionalController.signal);
                  await this.#mutation("sessions:updateState", {
                    authority: authorityOf(lease),
                    expectedState: head.state,
                    sessionPublicId: session.publicId,
                    state: session.state,
                  });
                }
              }
            } catch (error: unknown) {
              if (optionalController.signal.aborted) throw error;
              optionalResult.errors.push(`${session.publicId}: ${normalizeError(error)}`);
            }
          }
          await this.#advanceLocalSessionCursor(
            localCursor,
            localPage.continueAfterPublicId,
          );
          optionalResult.usageUploaded = await this.#uploadUsage(
            identity,
            optionalController.signal,
            optionalResult.errors,
          );
          for (const update of terminalUpdates) {
            abortBeforeEffect(optionalController.signal);
            if (
              !commandResult.pendingScanComplete
              || commandResult.blockedSessionIds.has(update.session.publicId)
            ) continue;
            await this.#mutation("sessions:updateState", {
              authority: authorityOf(update.lease),
              expectedState: update.head.state,
              sessionPublicId: update.session.publicId,
              state: "terminal",
            });
          }
          abortBeforeEffect(optionalController.signal);
          const remoteCursor = await this.#sessionSyncCursor.read();
          const refreshedPage = parseSessionHeadPage(await this.#transport.query(
            "sessions:listHeadsPage",
            {
              paginationOpts: {
                cursor: remoteCursor.state.remoteContinueCursor,
                numItems: maximumRemoteSessions,
              },
            },
          ));
          if (
            !refreshedPage.isDone
            && refreshedPage.continueCursor === remoteCursor.state.remoteContinueCursor
          ) throw new Error("Cloud session pagination made no progress.");
          abortBeforeEffect(optionalController.signal);
          optionalResult.remoteSessions = [...await this.#pullHeads(
            identity,
            refreshedPage.page,
            optionalController.signal,
          )];
          await this.#advanceRemoteSessionCursor(
            remoteCursor,
            refreshedPage.isDone ? null : refreshedPage.continueCursor,
          );
        })();
        const optionalState = { outcome: null as OptionalCloudSyncOutcome | null };
        const trackedOptional: Promise<OptionalCloudSyncOutcome> = optionalTask.then(
          () => ({ result: optionalResult, state: "completed" as const }),
          (error: unknown) => ({ error, state: "failed" as const }),
        );
        const trackedRecord: OptionalCloudSyncTask = {
          controller: optionalController,
          promise: trackedOptional,
          state: optionalState,
        };
        this.#optionalTask = trackedRecord;
        void trackedOptional.then((outcome) => {
          optionalState.outcome = outcome;
          signal.removeEventListener("abort", abortOptional);
        });
        let resolveDeadline!: () => void;
        const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve; });
        const optionalTimer = setTimeout(() => {
          optionalController.abort(new Error("Optional cloud projection sync exceeded its cycle budget."));
          resolveDeadline();
        }, this.#optionalSyncBudgetMs);
        const outcome = await Promise.race([
          trackedOptional,
          deadline.then(() => ({ state: "deadline" as const })),
        ]);
        clearTimeout(optionalTimer);
        if (outcome.state === "completed") {
          if (this.#optionalTask === trackedRecord) this.#optionalTask = null;
          result.errors.push(...outcome.result.errors);
          result.remoteSessions = [...outcome.result.remoteSessions];
          result.sessionsUploaded = outcome.result.sessionsUploaded;
          result.usageUploaded = outcome.result.usageUploaded;
        } else if (outcome.state === "failed") {
          if (this.#optionalTask === trackedRecord) this.#optionalTask = null;
          if (signal.aborted) throw outcome.error;
          result.errors.push(`optional sync: ${normalizeError(outcome.error)}`);
        } else {
          result.errors.push("optional sync: Optional cloud projection sync exceeded its cycle budget.");
        }
        }
      } catch (error: unknown) {
        result.online = false;
        result.errors.push(normalizeError(error));
        result.commandsUnsettled = (await this.#journal.read().catch(() => null))
          ?.state.commands.length ?? result.commandsUnsettled;
      } finally {
        // Push wake runs outside the cycle, so its diagnostics reach the
        // operator through the same background path as every other cycle
        // error rather than through a second reporting channel.
        result.errors.push(...(this.#pushWake?.takeDiagnostics() ?? []));
      }
      return result;
    });
  }

  /*
   * A device other than this daemon that is currently present is treated as a
   * browser-class device until device summaries carry an explicit class. The
   * probe is cached because the fast cadence would otherwise list devices
   * every second, and a stale hint only changes how long the loop sleeps.
   */
  async #peerDevicePresent(
    identity: ActiveCloudIdentity,
    signal: AbortSignal,
  ): Promise<boolean> {
    const now = this.#now();
    const cached = this.#peerPresence;
    if (cached !== null && now - cached.observedAt < peerPresenceRefreshMs) return cached.present;
    try {
      const devices = await this.#transport.query("devices:list", {});
      abortBeforeEffect(signal);
      const present = hasPresentPeerDevice(devices, identity.devicePublicId);
      this.#peerPresence = { observedAt: now, present };
      return present;
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      return cached?.present ?? false;
    }
  }

  async #localTurnActive(): Promise<boolean> {
    try {
      return await this.#local.hasActiveTurn?.() ?? false;
    } catch {
      return false;
    }
  }

  async projectionRecoveryStatus(): Promise<CloudProjectionRecoveryStatus> {
    const observed = await this.#journal.read();
    return projectionRecoveryStatusFromJournalState(observed.state);
  }

  async readCompactProjectionRecoveryReceipt(input: Readonly<{
    idempotencyKey: string;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<
    | Readonly<{ status: "absent" | "conflict" }>
    | Readonly<{ status: "found"; result: CompactProjectionRecoveryResult }>
  > {
    if (!isUuidV7(input.idempotencyKey) || !isOpaqueIdentifier(input.sessionPublicId)) {
      throw new Error("Cloud projection recovery receipt selector is invalid.");
    }
    if (this.#closed) throw new Error("The cloud daemon bridge is closed.");
    await this.#assertDaemonCurrent(input.signal);
    // The journal is already fenced to the daemon's bound deployment and
    // identity namespace. Exact terminal replay is therefore a local receipt
    // read; it must remain available after logout or while transport is down.
    const observed = await this.#journal.read();
    await this.#assertDaemonCurrent(input.signal);
    const receipt = observed.state.projectionRecoveryReceipts.find((entry) =>
      entry.idempotencyKey === input.idempotencyKey);
    if (receipt === undefined) return { status: "absent" };
    if (receipt.sessionPublicId !== input.sessionPublicId) return { status: "conflict" };
    return {
      result: cloudProjectionRecoveryReceiptResult(receipt),
      status: "found",
    };
  }

  async isCompactProjectionRecoveryUnsettled(sessionPublicId: string): Promise<boolean> {
    const observed = await this.#journal.read();
    return hasUnsettledCompactProjectionRecovery(observed.state, sessionPublicId);
  }

  async isCompactProjectionRecoveryUnsettledForProfile(profileId: string): Promise<boolean> {
    const observed = await this.#journal.read();
    return hasUnsettledCompactProjectionRecoveryForProfile(observed.state, profileId);
  }

  async supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: string,
  ): Promise<{ superseded: boolean }> {
    if (!isOpaqueIdentifier(sessionPublicId)) {
      throw new Error("Cloud projection recovery session authority is invalid.");
    }
    this.#projectionRecoverySupersededSessions.add(sessionPublicId);
    const committed = await this.#mutateJournal((state) =>
      supersedeCloudProjectionRecoveryForProviderDeletion(
        state,
        sessionPublicId,
        this.#now(),
      ));
    const receipts = committed.state.projectionRecoveryReceipts.filter((receipt) =>
      receipt.sessionPublicId === sessionPublicId
      && receipt.phase === "rejected"
      && receipt.rejectionCode === providerDeletionProjectionRecoveryCode);
    if (this.#local.discardCompactProjectionRecovery !== undefined) {
      for (const receipt of receipts) {
        await this.#local.discardCompactProjectionRecovery({
          idempotencyKey: receipt.idempotencyKey,
          sessionPublicId,
        });
      }
    }
    await this.#assertDaemonCurrent();
    return { superseded: receipts.length > 0 };
  }

  async supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    if (this.#local.isSessionTerminal === undefined) return { superseded: 0 };
    const observed = await this.#journal.read();
    await this.#assertDaemonCurrent();
    const candidates = new Set([
      ...observed.state.projectionRecoveries.map((entry) => entry.sessionPublicId),
      ...observed.state.projectionRecoveryReceipts.flatMap((receipt) =>
        receipt.phase === "rejected"
          && receipt.rejectionCode === providerDeletionProjectionRecoveryCode
          ? [receipt.sessionPublicId]
          : []),
    ]);
    const terminal: string[] = [];
    for (const sessionPublicId of [...candidates].sort((left, right) =>
      left.localeCompare(right))) {
      if (await this.#local.isSessionTerminal(sessionPublicId)) {
        this.#projectionRecoverySupersededSessions.add(sessionPublicId);
        terminal.push(sessionPublicId);
      }
    }
    if (terminal.length === 0) return { superseded: 0 };
    const committed = await this.#mutateJournal((state) => terminal.reduce(
      (next, sessionPublicId) => supersedeCloudProjectionRecoveryForProviderDeletion(
        next,
        sessionPublicId,
        this.#now(),
      ),
      state,
    ));
    if (this.#local.discardCompactProjectionRecovery !== undefined) {
      for (const receipt of committed.state.projectionRecoveryReceipts) {
        if (
          terminal.includes(receipt.sessionPublicId)
          && receipt.phase === "rejected"
          && receipt.rejectionCode === providerDeletionProjectionRecoveryCode
        ) {
          await this.#local.discardCompactProjectionRecovery({
            idempotencyKey: receipt.idempotencyKey,
            sessionPublicId: receipt.sessionPublicId,
          });
        }
      }
    }
    await this.#assertDaemonCurrent();
    return { superseded: terminal.length };
  }

  async recoverCompactProjection(input: Readonly<{
    acknowledgeGap: boolean;
    idempotencyKey: string;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<CompactProjectionRecoveryResult> {
    if (
      !input.acknowledgeGap
      || !isUuidV7(input.idempotencyKey)
      || !isOpaqueIdentifier(input.sessionPublicId)
    ) throw new Error("Cloud projection recovery input is invalid.");
    if (this.#closed) throw new Error("The cloud daemon bridge is closed.");
    try {
      return await this.#exclusive(async () => {
        if (await this.#projectionRecoveryIsSuperseded(input.sessionPublicId)) {
          await this.supersedeCompactProjectionRecoveryForProviderDeletion(
            input.sessionPublicId,
          );
          await this.#discardSupersededProjectionRecovery(
            input.sessionPublicId,
            input.idempotencyKey,
          );
          return this.#providerDeletionRecoveryResult(input);
        }
      await this.#assertDaemonCurrent(input.signal);
      await this.#quiesceOptionalSync(input.signal);
      await this.#assertDaemonCurrent(input.signal);
      const identity = await this.#identity.requireActive(input.signal);
      await this.#assertDaemonCurrent(input.signal);
      const observed = await this.#journal.read();
      await this.#assertDaemonCurrent(input.signal);
      const requestedAt = this.#now();
      if (!isSafeNonNegativeInteger(requestedAt)) {
        throw new CloudProjectionRecoveryAdmissionError("idempotency_authority_invalid");
      }
      const currentState = pruneExpiredCloudProjectionRecoveryReceipts(
        observed.state,
        requestedAt,
      );
      const receipt = currentState.projectionRecoveryReceipts.find((entry) =>
        entry.idempotencyKey === input.idempotencyKey);
      if (receipt !== undefined) {
        if (
          receipt.sessionPublicId !== input.sessionPublicId
          || !matchesCloudProjectionRecoveryIdentity(
            receipt,
            identity.userPublicId,
            identity.devicePublicId,
          )
        ) throw new CloudProjectionRecoveryAdmissionError("identity_or_session_conflict");
        return cloudProjectionRecoveryReceiptResult(receipt);
      }
      const existing = observed.state.projectionRecoveries.find((entry) =>
        entry.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.sessionPublicId !== input.sessionPublicId
          || !matchesCloudProjectionRecoveryIdentity(
            existing,
            identity.userPublicId,
            identity.devicePublicId,
          )
        ) throw new CloudProjectionRecoveryAdmissionError("identity_or_session_conflict");
        return await this.#resumeCompactProjectionRecovery(
          identity,
          existing,
          input.signal,
        );
      }
      if (observed.state.projectionRecoveries.some((entry) =>
        entry.sessionPublicId === input.sessionPublicId)) {
        throw new CloudProjectionRecoveryAdmissionError("unsettled_session");
      }
      const idempotencyTimestamp = uuidV7Timestamp(input.idempotencyKey);
      if (
        idempotencyTimestamp === null
        || idempotencyTimestamp < requestedAt - maximumIdempotencyLifetimeMs
        || idempotencyTimestamp > requestedAt + maximumIdempotencyFutureSkewMs
        || !isSafeNonNegativeInteger(requestedAt)
      ) throw new CloudProjectionRecoveryAdmissionError("idempotency_authority_invalid");
      if (observed.state.projectionRecoveries.length >= 25) {
        throw new CloudProjectionRecoveryAdmissionError("journal_capacity");
      }
      const headValue = await this.#transport.query("sessions:getHead", {
        publicId: input.sessionPublicId,
      });
      await this.#assertDaemonCurrent(input.signal);
      if (headValue === null) throw new Error("Cloud projection recovery session is unavailable.");
      const head = parseSessionHead(headValue);
      if (
        head.publicId !== input.sessionPublicId
        || head.executionDevicePublicId !== identity.devicePublicId
        || head.compactHeadSequence < 1
        || head.compactTailDigest === undefined
        || head.state === "terminal"
        || head.state === "orphaned"
      ) throw new Error("Cloud projection recovery session authority is unavailable.");
      const lease = await this.#ensureLease(input.sessionPublicId, identity);
      await this.#assertDaemonCurrent(input.signal);
      if (
        this.#local.planCompactProjectionRecovery === undefined
        || this.#local.stageCompactProjectionRecovery === undefined
      ) {
        throw new Error("Cloud projection recovery is unavailable in this daemon.");
      }
      const recoverable = (await this.#pullHeads(identity, [head], input.signal))[0];
      await this.#assertDaemonCurrent(input.signal);
      if (recoverable === undefined || recoverable.publicId !== input.sessionPublicId) {
        throw new Error("Cloud projection recovery baseline is unavailable.");
      }
      const observedInteractionIds = [...new Set(recoverable.events.flatMap((event) =>
        event.kind === "interaction_state" ? [event.interactionId] : []))]
        .sort((left, right) => left.localeCompare(right));
      if (observedInteractionIds.length > maximumProjectionRecoveryBaselineInteractions) {
        throw new Error("Cloud projection recovery interaction baseline is too large.");
      }
      const plan = await this.#local.planCompactProjectionRecovery({
        idempotencyKey: input.idempotencyKey,
        observedInteractionIds,
        sessionPublicId: input.sessionPublicId,
        signal: input.signal,
      });
      await this.#assertDaemonCurrent(input.signal);
      if (
        !isRuntimeArray(plan.baselineInteractions)
        || plan.baselineInteractions.length !== observedInteractionIds.length
        || plan.baselineInteractions.some((interaction, index) =>
          interaction.interactionId !== observedInteractionIds[index])
      ) throw new Error("Cloud projection recovery interaction baseline is incomplete.");
      const refreshedValue = await this.#transport.query("sessions:getHead", {
        publicId: input.sessionPublicId,
      });
      await this.#assertDaemonCurrent(input.signal);
      if (refreshedValue === null) {
        throw new Error("Cloud projection recovery session disappeared.");
      }
      const refreshed = parseSessionHead(refreshedValue);
      if (
        refreshed.publicId !== head.publicId
        || refreshed.executionDevicePublicId !== head.executionDevicePublicId
        || refreshed.compactHeadSequence !== head.compactHeadSequence
        || refreshed.compactTailDigest !== head.compactTailDigest
        || refreshed.compactStreamEpoch !== head.compactStreamEpoch
        || refreshed.compactHasRecoveryGap !== head.compactHasRecoveryGap
        || refreshed.projectionRevision !== head.projectionRevision
        || refreshed.state !== head.state
        || plan.sessionPublicId !== input.sessionPublicId
      ) throw new Error("Cloud projection recovery session changed during baseline read.");
      const authority = authorityOf(lease);
      const epochPublicId = validateUuid(this.#randomUuid());
      const proofInput = {
        authority,
        baselineCompletedTurns: plan.baselineCompletedTurns,
        baselineInteractions: plan.baselineInteractions,
        epochPublicId,
        expectedCompactStreamEpoch: head.compactStreamEpoch,
        expectedHeadSequence: head.compactHeadSequence,
        expectedTailDigest: head.compactTailDigest,
        idempotencyKey: input.idempotencyKey,
        localAuthority: plan.localAuthority,
        replacementCacheId: plan.replacementCacheId,
        sessionPublicId: input.sessionPublicId,
        sourceCacheId: plan.sourceCacheId,
        sourceDevicePublicId: identity.devicePublicId,
        userPublicId: identity.userPublicId,
      } as const;
      const proofs = await projectionRecoveryProofs(identity.accountKey, proofInput);
      await this.#assertDaemonCurrent(input.signal);
      const prepared = parseCloudProjectionRecoveryEntry({
        ...proofInput,
        ...proofs,
        phase: "prepared",
        requestedAt,
      });
      const installation = this.#projectionRecoveryInstallation(
        prepared,
        prepared.expectedCompactStreamEpoch + 1,
      );
      await this.#local.stageCompactProjectionRecovery({
        ...installation,
        signal: input.signal,
      });
      await this.#assertDaemonCurrent(input.signal);
      await this.#addProjectionRecovery(prepared);
      await this.#assertDaemonCurrent(input.signal);
        return await this.#resumeCompactProjectionRecovery(identity, prepared, input.signal);
      });
    } catch (error: unknown) {
      if (!await this.#projectionRecoveryIsSuperseded(input.sessionPublicId)) throw error;
      await this.supersedeCompactProjectionRecoveryForProviderDeletion(
        input.sessionPublicId,
      );
      await this.#discardSupersededProjectionRecovery(
        input.sessionPublicId,
        input.idempotencyKey,
      );
      return this.#providerDeletionRecoveryResult(input);
    }
  }

  async pullRemoteSessions(signal: AbortSignal): Promise<readonly RemoteCloudSession[]> {
    if (this.#closed) throw new Error("The cloud daemon bridge is closed.");
    return await this.#exclusive(async () => {
      await this.#assertDaemonCurrent(signal);
      const identity = await this.#identity.requireActive(signal);
      const cursor = await this.#sessionSyncCursor.read();
      const page = parseSessionHeadPage(await this.#transport.query(
        "sessions:listHeadsPage",
        {
          paginationOpts: {
            cursor: cursor.state.remoteContinueCursor,
            numItems: maximumRemoteSessions,
          },
        },
      ));
      if (!page.isDone && page.continueCursor === cursor.state.remoteContinueCursor) {
        throw new Error("Cloud session pagination made no progress.");
      }
      const sessions = await this.#pullHeads(identity, page.page, signal);
      await this.#advanceRemoteSessionCursor(
        cursor,
        page.isDone ? null : page.continueCursor,
      );
      return sessions;
    });
  }

  async #quiesceOptionalSync(signal: AbortSignal): Promise<void> {
    const optional = this.#optionalTask;
    if (optional === null) return;
    optional.controller.abort(new Error("Cloud projection recovery requires an idle sync lane."));
    let resolveDeadline!: (settled: false) => void;
    const deadline = new Promise<false>((resolve) => { resolveDeadline = resolve; });
    const timer = setTimeout(() => resolveDeadline(false), this.#optionalSyncBudgetMs);
    const settled = await Promise.race([
      optional.promise.then(() => true as const),
      deadline,
    ]);
    clearTimeout(timer);
    await this.#assertDaemonCurrent(signal);
    if (!settled) {
      throw new Error("A prior cloud projection sync is still settling; recovery made no changes.");
    }
    if (this.#optionalTask === optional) this.#optionalTask = null;
  }

  #projectionRecoveryInstallation(
    entry: CloudProjectionRecoveryJournalEntry,
    compactStreamEpoch: number,
  ): Readonly<{
    baselineCompletedTurns: readonly Readonly<{ bodyDigest: string; turnId: string }>[];
    baselineInteractions: readonly CloudProjectionRecoveryBaselineInteraction[];
    boundaryHeadSequence: number;
    boundaryTailDigest: string;
    compactStreamEpoch: number;
    idempotencyKey: string;
    localAuthority: CloudProjectionRecoveryJournalEntry["localAuthority"];
    replacementCacheId: string;
    sessionPublicId: string;
    sourceCacheId: string | null;
  }> {
    return {
      baselineCompletedTurns: entry.baselineCompletedTurns,
      baselineInteractions: entry.baselineInteractions ?? [],
      boundaryHeadSequence: entry.expectedHeadSequence,
      boundaryTailDigest: entry.expectedTailDigest,
      compactStreamEpoch,
      idempotencyKey: entry.idempotencyKey,
      localAuthority: entry.localAuthority,
      replacementCacheId: entry.replacementCacheId,
      sessionPublicId: entry.sessionPublicId,
      sourceCacheId: entry.sourceCacheId,
    };
  }

  async #projectionRecoveryIsSuperseded(sessionPublicId: string): Promise<boolean> {
    if (this.#projectionRecoverySupersededSessions.has(sessionPublicId)) return true;
    if (this.#local.isSessionTerminal === undefined) return false;
    const terminal = await this.#local.isSessionTerminal(sessionPublicId);
    if (terminal) this.#projectionRecoverySupersededSessions.add(sessionPublicId);
    return terminal;
  }

  #providerDeletionRecoveryResult(input: Readonly<{
    idempotencyKey: string;
    sessionPublicId: string;
  }>): CompactProjectionRecoveryResult {
    return {
      idempotencyKey: input.idempotencyKey,
      phase: "rejected",
      rejectionCode: providerDeletionProjectionRecoveryCode,
      sessionPublicId: input.sessionPublicId,
    };
  }

  async #discardSupersededProjectionRecovery(
    sessionPublicId: string,
    idempotencyKey: string,
  ): Promise<void> {
    if (this.#local.discardCompactProjectionRecovery === undefined) return;
    await this.#local.discardCompactProjectionRecovery({
      idempotencyKey,
      sessionPublicId,
    });
  }

  async #resumeCompactProjectionRecovery(
    identity: ActiveCloudIdentity,
    original: CloudProjectionRecoveryJournalEntry,
    signal: AbortSignal,
  ): Promise<CompactProjectionRecoveryResult> {
    let entry = original;
    if (await this.#projectionRecoveryIsSuperseded(entry.sessionPublicId)) {
      return await this.#finishProviderDeletionProjectionRecovery(entry);
    }
    if (entry.phase === "prepared") {
      if (idempotencyExpired(entry.idempotencyKey, this.#now())) {
        return await this.#finishInvalidPreparedProjectionRecovery(entry, signal);
      }
      entry = await this.#rebindPreparedProjectionRecovery(identity, entry, signal);
    }
    if (entry.phase === "prepared" || entry.phase === "effect_started") {
      if (this.#local.stageCompactProjectionRecovery === undefined) {
        throw new Error("Cloud projection recovery is unavailable in this daemon.");
      }
      await this.#local.stageCompactProjectionRecovery({
        ...this.#projectionRecoveryInstallation(
          entry,
          entry.expectedCompactStreamEpoch + 1,
        ),
        signal,
      });
      await this.#assertDaemonCurrent(signal);
    }
    if (entry.phase === "prepared") {
      const effectStarted = parseCloudProjectionRecoveryEntry({
        ...entry,
        phase: "effect_started",
      });
      await this.#replaceProjectionRecovery(entry, effectStarted);
      await this.#assertDaemonCurrent(signal);
      entry = effectStarted;
    }
    if (entry.phase === "effect_started") {
      if (await this.#projectionRecoveryIsSuperseded(entry.sessionPublicId)) {
        return await this.#finishProviderDeletionProjectionRecovery(entry);
      }
      abortBeforeEffect(signal);
      let response: CloudProjectionRecoveryAppliedResponse;
      try {
        response = parseCompactProjectionRecoveryResponse(
          await this.#mutation("sessions:beginCompactEpoch", {
            authority: entry.authority,
            epochPublicId: entry.epochPublicId,
            expectedCompactStreamEpoch: entry.expectedCompactStreamEpoch,
            expectedHeadSequence: entry.expectedHeadSequence,
            expectedTailDigest: entry.expectedTailDigest,
            idempotencyKey: entry.idempotencyKey,
            lineageCommitment: entry.lineageCommitment,
            requestDigest: entry.requestDigest,
            sessionPublicId: entry.sessionPublicId,
          }),
        );
      } catch (error: unknown) {
        if (await this.#projectionRecoveryIsSuperseded(entry.sessionPublicId)) {
          return await this.#finishProviderDeletionProjectionRecovery(entry);
        }
        await this.#assertDaemonCurrent(signal);
        const rejectionCode = projectionRecoveryRejectionCode(error);
        if (rejectionCode === null) throw error;
        if (this.#local.discardCompactProjectionRecovery === undefined) {
          throw new Error("Cloud projection recovery cleanup is unavailable in this daemon.");
        }
        await this.#local.discardCompactProjectionRecovery({
          idempotencyKey: entry.idempotencyKey,
          sessionPublicId: entry.sessionPublicId,
        });
        await this.#assertDaemonCurrent(signal);
        const rejected = createCloudProjectionRecoveryTerminalReceipt(entry, {
          phase: "rejected",
          rejectionCode,
        });
        await this.#replaceProjectionRecovery(entry, rejected);
        await this.#assertDaemonCurrent(signal);
        return cloudProjectionRecoveryReceiptResult(rejected);
      }
      if (await this.#projectionRecoveryIsSuperseded(entry.sessionPublicId)) {
        return await this.#finishProviderDeletionProjectionRecovery(entry);
      }
      await this.#assertDaemonCurrent(signal);
      const applied = parseCloudProjectionRecoveryEntry({
        ...entry,
        cacheActivated: false,
        phase: "applied",
        response,
      });
      if (applied.phase !== "applied") {
        throw new Error("Cloud projection recovery application is invalid.");
      }
      await this.#replaceProjectionRecovery(entry, applied);
      await this.#assertDaemonCurrent(signal);
      entry = applied;
    }
    if (entry.phase !== "applied") {
      throw new Error("Cloud projection recovery journal changed unexpectedly.");
    }
    if (this.#local.activateCompactProjectionRecovery === undefined) {
      throw new Error("Cloud projection recovery is unavailable in this daemon.");
    }
    if (await this.#projectionRecoveryIsSuperseded(entry.sessionPublicId)) {
      return await this.#finishProviderDeletionProjectionRecovery(entry);
    }
    await this.#assertProjectionRecoveryActivationAuthority(identity, entry, signal);
    await this.#local.activateCompactProjectionRecovery({
      ...this.#projectionRecoveryInstallation(entry, entry.response.compactStreamEpoch),
      signal,
    });
    if (await this.#projectionRecoveryIsSuperseded(entry.sessionPublicId)) {
      return await this.#finishProviderDeletionProjectionRecovery(entry);
    }
    await this.#assertDaemonCurrent(signal);
    await this.#assertProjectionRecoveryActivationAuthority(identity, entry, signal);
    const activated = createCloudProjectionRecoveryTerminalReceipt(entry, {
      phase: "applied",
    });
    await this.#replaceProjectionRecovery(entry, activated);
    await this.#assertDaemonCurrent(signal);
    return cloudProjectionRecoveryReceiptResult(activated);
  }

  async #rebindPreparedProjectionRecovery(
    identity: ActiveCloudIdentity,
    entry: CloudProjectionRecoveryJournalEntry,
    signal: AbortSignal,
  ): Promise<CloudProjectionRecoveryJournalEntry> {
    if (
      entry.phase !== "prepared"
      || !matchesCloudProjectionRecoveryIdentity(
        entry,
        identity.userPublicId,
        identity.devicePublicId,
      )
    ) throw new Error("Cloud projection recovery prepared authority changed.");
    const lease = await this.#ensureLease(entry.sessionPublicId, identity);
    await this.#assertDaemonCurrent(signal);
    const authority = authorityOf(lease);
    if (sameAuthority(authority, entry.authority)) return entry;
    const proofs = await projectionRecoveryProofs(identity.accountKey, {
      ...entry,
      authority,
    });
    await this.#assertDaemonCurrent(signal);
    const rebound = parseCloudProjectionRecoveryEntry({
      ...entry,
      ...proofs,
      authority,
    });
    await this.#replaceProjectionRecovery(entry, rebound);
    await this.#assertDaemonCurrent(signal);
    return rebound;
  }

  async #finishInvalidPreparedProjectionRecovery(
    entry: CloudProjectionRecoveryJournalEntry,
    signal: AbortSignal,
  ): Promise<CompactProjectionRecoveryResult> {
    if (entry.phase !== "prepared") {
      throw new Error("Cloud projection recovery no-effect authority changed.");
    }
    if (this.#local.discardCompactProjectionRecovery === undefined) {
      throw new Error("Cloud projection recovery cleanup is unavailable in this daemon.");
    }
    await this.#local.discardCompactProjectionRecovery({
      idempotencyKey: entry.idempotencyKey,
      sessionPublicId: entry.sessionPublicId,
    });
    await this.#assertDaemonCurrent(signal);
    const rejected = createCloudProjectionRecoveryTerminalReceipt(entry, {
      phase: "rejected",
      rejectionCode: invalidIdempotencyProjectionRecoveryCode,
    });
    await this.#replaceProjectionRecovery(entry, rejected);
    await this.#assertDaemonCurrent(signal);
    return cloudProjectionRecoveryReceiptResult(rejected);
  }

  async #finishProviderDeletionProjectionRecovery(
    entry: CloudProjectionRecoveryJournalEntry,
  ): Promise<CompactProjectionRecoveryResult> {
    await this.supersedeCompactProjectionRecoveryForProviderDeletion(
      entry.sessionPublicId,
    );
    await this.#discardSupersededProjectionRecovery(
      entry.sessionPublicId,
      entry.idempotencyKey,
    );
    return this.#providerDeletionRecoveryResult(entry);
  }

  async #assertProjectionRecoveryActivationAuthority(
    identity: ActiveCloudIdentity,
    entry: Extract<CloudProjectionRecoveryJournalEntry, { phase: "applied" }>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#assertDaemonCurrent(signal);
    const value = await this.#transport.query("sessions:getHead", {
      publicId: entry.sessionPublicId,
    });
    await this.#assertDaemonCurrent(signal);
    if (value === null) throw new Error("Cloud projection recovery session is unavailable.");
    const head = parseSessionHead(value);
    if (
      head.publicId !== entry.sessionPublicId
      || head.executionDevicePublicId !== identity.devicePublicId
      || !head.compactHasRecoveryGap
      || head.compactHeadSequence !== entry.response.boundaryHeadSequence
      || head.compactTailDigest !== entry.response.boundaryTailDigest
      || head.compactStreamEpoch !== entry.response.compactStreamEpoch
      || head.projectionRevision !== entry.response.projectionRevision
      || head.state === "terminal"
      || head.state === "orphaned"
    ) throw new Error("Cloud projection recovery authority changed before cache activation.");
    await this.#ensureLease(entry.sessionPublicId, identity);
    await this.#assertDaemonCurrent(signal);
  }

  /**
   * Publish this device's settings projection. The payload is republished
   * when any input changed and otherwise at most every
   * `deviceRegistryHeartbeatMs`, under an expected revision so two daemons
   * that both believe they own the device cannot silently overwrite each
   * other: a conflict drops the cached revision and the next cycle re-reads
   * the server's.
   */
  async #publishDeviceRegistry(
    identity: ActiveCloudIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const readRegistry = this.#local.readDeviceRegistry?.bind(this.#local);
    if (readRegistry === undefined) return;
    const payload = await readRegistry({ signal });
    await this.#assertDaemonCurrent(signal);
    const digest = await sha256Hex(JSON.stringify({ ...payload, heartbeatAt: 0 }));
    const now = this.#now();
    const cached = this.#deviceRegistryState;
    if (
      cached !== null
      && cached.digest === digest
      && now - cached.publishedAt < deviceRegistryHeartbeatMs
    ) return;
    const expectedRevision = cached?.revision ?? await this.#readDeviceRegistryRevision(identity);
    await this.#assertDaemonCurrent(signal);
    const envelope = await encryptDeviceRegistry(payload, identity.accountKey, {
      entityPublicId: identity.devicePublicId,
      keyVersion: identity.keyVersion,
      kind: "device_registry",
      userPublicId: identity.userPublicId,
    });
    abortBeforeEffect(signal);
    const response = await this.#mutation("devices:updateRegistry", {
      envelope,
      expectedRevision,
      keyVersion: identity.keyVersion,
    });
    if (
      !isRecord(response)
      || response.devicePublicId !== identity.devicePublicId
      || !isSafePositiveInteger(response.revision)
    ) throw new Error("Device registry publish response is invalid.");
    this.#deviceRegistryState = { digest, publishedAt: now, revision: response.revision };
  }

  async #readDeviceRegistryRevision(identity: ActiveCloudIdentity): Promise<number> {
    const value = await this.#transport.query("devices:getRegistry", {
      devicePublicId: identity.devicePublicId,
    });
    if (value === null) return 0;
    if (
      !isRecord(value)
      || value.devicePublicId !== identity.devicePublicId
      || !isSafePositiveInteger(value.revision)
    ) throw new Error("Device registry response is invalid.");
    return value.revision;
  }

  async #createSession(
    identity: ActiveCloudIdentity,
    session: CloudLocalSessionHead,
    signal: AbortSignal,
  ): Promise<void> {
    const metadata = await encryptSessionMetadata(
      session.metadata,
      identity.accountKey,
      {
        entityPublicId: session.publicId,
        keyVersion: identity.keyVersion,
        kind: "session_metadata",
        userPublicId: identity.userPublicId,
      },
    );
    const idempotencyKey = validateUuid(this.#randomUuid());
    const request = { metadata, publicId: session.publicId } as const;
    const requestDigest = await hmacSha256Hex(
      identity.accountKey,
      "session-create",
      JSON.stringify(request),
    );
    abortBeforeEffect(signal);
    await this.#mutation("sessions:create", {
      idempotencyKey,
      metadata,
      publicId: session.publicId,
      requestDigest,
    });
  }

  async #updateMetadata(
    identity: ActiveCloudIdentity,
    session: CloudLocalSessionHead,
    head: CloudSessionHead,
    signal: AbortSignal,
  ): Promise<CloudSessionHead> {
    if (head.metadata !== undefined) {
      const current = await decryptSessionMetadata(
        head.metadata,
        identity.accountKey,
        {
          entityPublicId: head.publicId,
          keyVersion: head.metadata.keyVersion,
          kind: "session_metadata",
          userPublicId: identity.userPublicId,
        },
      );
      abortBeforeEffect(signal);
      if (
        current.name === session.metadata.name
        && current.note === session.metadata.note
        && (current.archived ?? false) === (session.metadata.archived ?? false)
      ) {
        return head;
      }
    }
    const metadata = await encryptSessionMetadata(
      session.metadata,
      identity.accountKey,
      {
        entityPublicId: session.publicId,
        keyVersion: identity.keyVersion,
        kind: "session_metadata",
        userPublicId: identity.userPublicId,
      },
    );
    const idempotencyKey = validateUuid(this.#randomUuid());
    const request = {
      expectedRevision: head.metadataRevision,
      metadata,
      sessionPublicId: session.publicId,
    } as const;
    const requestDigest = await hmacSha256Hex(
      identity.accountKey,
      "session-metadata",
      JSON.stringify(request),
    );
    abortBeforeEffect(signal);
    await this.#mutation("sessions:updateMetadata", {
      ...request,
      idempotencyKey,
      requestDigest,
    });
    const refreshed = await this.#transport.query("sessions:getHead", {
      publicId: session.publicId,
    });
    abortBeforeEffect(signal);
    if (refreshed === null) throw new Error("Updated cloud session is unavailable.");
    return parseSessionHead(refreshed);
  }

  async #appendCompact(
    identity: ActiveCloudIdentity,
    session: CloudLocalSessionHead,
    head: CloudSessionHead,
    lease: CloudLease,
    signal: AbortSignal,
  ): Promise<Readonly<{ complete: boolean; uploaded: boolean }>> {
    const local = await this.#local.readCompactEvents({
      afterSequence: head.compactHeadSequence,
      limit: maximumEventsPerChunk,
      remoteStreamEpoch: head.compactStreamEpoch,
      ...(head.compactTailDigest === undefined
        ? {}
        : { remoteTailDigest: head.compactTailDigest }),
      sessionPublicId: session.publicId,
      signal,
    });
    abortBeforeEffect(signal);
    if (
      !Array.isArray(local.events)
      || typeof local.complete !== "boolean"
      || !isOpaqueIdentifier(local.cacheId)
    ) {
      throw new Error("Local compact projection response is invalid.");
    }
    if (local.events.length === 0) {
      return { complete: local.complete, uploaded: false };
    }
    const parsed = parseCompactSessionEvents(local.events);
    if (
      parsed === null
      || parsed.length > maximumEventsPerChunk
      || parsed[0]?.sequence !== head.compactHeadSequence + 1
    ) throw new Error("Local compact projection is not contiguous.");
    const firstSequence = parsed[0].sequence;
    const last = parsed.at(-1);
    if (last === undefined) throw new Error("Local compact projection is empty.");
    const authority = authorityOf(lease);
    const envelope = await encryptCompactEvents(parsed, identity.accountKey, {
      firstSequence,
      keyVersion: identity.keyVersion,
      lastSequence: last.sequence,
      ...(head.compactTailDigest === undefined
        ? {}
        : { previousDigest: head.compactTailDigest }),
      sessionPublicId: session.publicId,
      sourceBootId: authority.bootId,
      sourceDevicePublicId: identity.devicePublicId,
      sourceFence: authority.fence,
      stream: "compact",
      userPublicId: identity.userPublicId,
    });
    const digest = await sha256Hex(JSON.stringify({
      authority,
      envelope,
      firstSequence,
      lastSequence: last.sequence,
      previousDigest: head.compactTailDigest ?? null,
      sessionPublicId: session.publicId,
      stream: "compact",
    }));
    const checkpoint = {
      cacheId: local.cacheId,
      digest,
      expectedHeadSequence: head.compactHeadSequence,
      expectedStreamEpoch: head.compactStreamEpoch,
      ...(head.compactTailDigest === undefined
        ? {}
        : { expectedTailDigest: head.compactTailDigest }),
      headSequence: last.sequence,
      sessionPublicId: session.publicId,
    } as const;
    await this.#local.recordCompactUploadIntent?.(checkpoint);
    abortBeforeEffect(signal);
    const receipt = await this.#mutation("sessions:appendChunk", {
      authority,
      digest,
      envelope,
      expectedHeadSequence: head.compactHeadSequence,
      expectedStreamEpoch: head.compactStreamEpoch,
      ...(head.compactTailDigest === undefined
        ? {}
        : { expectedTailDigest: head.compactTailDigest }),
      firstSequence,
      lastSequence: last.sequence,
      ...(head.compactTailDigest === undefined
        ? {}
        : { previousDigest: head.compactTailDigest }),
      sessionPublicId: session.publicId,
      stream: "compact",
    });
    if (
      !isRecord(receipt)
      || receipt.digest !== digest
      || receipt.headSequence !== last.sequence
      || receipt.streamEpoch !== head.compactStreamEpoch
      || (receipt.replay !== undefined && typeof receipt.replay !== "boolean")
    ) throw new Error("Cloud session append receipt is invalid.");
    abortBeforeEffect(signal);
    await this.#local.acknowledgeCompactUpload?.(checkpoint);
    return { complete: local.complete, uploaded: true };
  }

  /*
   * Live projection. The full cycle registers every session this daemon
   * executes together with its current head and lease; liveTick then streams
   * new ledger text for those sessions on its own short cadence. A session
   * leaves the live set when it goes terminal, when its lease is lost, or when
   * the remote detail head no longer matches what this daemon believes, in
   * which case the next full cycle re-registers it with a fresh head.
   */
  #registerLive(session: CloudLocalSessionHead, head: CloudSessionHead, lease: CloudLease): void {
    if (this.#local.readLiveEvents === undefined) return;
    if (session.state === "terminal" || head.state === "terminal" || head.state === "orphaned") {
      this.#live.delete(session.publicId);
      return;
    }
    const existing = this.#live.get(session.publicId);
    if (
      existing !== undefined
      && existing.detailHeadSequence === head.detailHeadSequence
      && existing.detailStreamEpoch === head.detailStreamEpoch
    ) {
      existing.lease = lease;
      return;
    }
    this.#live.set(session.publicId, {
      afterLocalSequence: null,
      batcher: null,
      detailHeadSequence: head.detailHeadSequence,
      detailStreamEpoch: head.detailStreamEpoch,
      detailTailDigest: head.detailTailDigest,
      lease,
      publicId: session.publicId,
    });
  }

  async liveTick(signal: AbortSignal): Promise<CloudLiveTickResult> {
    const errors: string[] = [];
    let sessionsUploaded = 0;
    if (this.#live.size === 0 || this.#local.readLiveEvents === undefined) {
      return { errors, sessionsUploaded };
    }
    let identity: ActiveCloudIdentity;
    try {
      identity = await this.#identity.requireActive(signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      return { errors: [normalizeError(error)], sessionsUploaded };
    }
    for (const state of [...this.#live.values()]) {
      try {
        abortBeforeEffect(signal);
        if (state.lease.leaseUntil <= this.#now()) {
          this.#live.delete(state.publicId);
          continue;
        }
        if (await this.#appendLive(identity, state, signal)) sessionsUploaded += 1;
      } catch (error: unknown) {
        if (signal.aborted) throw error;
        this.#live.delete(state.publicId);
        errors.push(`${state.publicId}: ${normalizeError(error)}`);
      }
    }
    return { errors, sessionsUploaded };
  }

  async #appendLive(
    identity: ActiveCloudIdentity,
    state: LiveSessionState,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.#local.readLiveEvents === undefined) return false;
    const local = await this.#local.readLiveEvents({
      afterLocalSequence: state.afterLocalSequence,
      limit: maximumLiveEventsPerTick,
      sessionPublicId: state.publicId,
      signal,
    });
    abortBeforeEffect(signal);
    if (state.afterLocalSequence === null) {
      // First observation: start streaming from now rather than replaying
      // history the compact stream already carries.
      state.afterLocalSequence = local.observedThroughSequence;
      state.batcher = new LiveBatcher({ includeThinking: local.includeThinking });
      return false;
    }
    const batcher = state.batcher ?? new LiveBatcher({ includeThinking: local.includeThinking });
    state.batcher = batcher;
    for (const event of local.events) batcher.observe(event);
    if (local.events.length > 0) {
      state.afterLocalSequence = local.events[local.events.length - 1]?.sequence ?? state.afterLocalSequence;
    }
    const batch = batcher.drain();
    if (batch.bodies.length === 0) return false;
    const events = assignDetailSequences(batch.bodies, state.detailHeadSequence);
    const first = events[0];
    const last = events[events.length - 1];
    if (first === undefined || last === undefined) return false;
    const authority = authorityOf(state.lease);
    const envelope = await encryptDetailEvents(events, identity.accountKey, {
      firstSequence: first.sequence,
      keyVersion: identity.keyVersion,
      lastSequence: last.sequence,
      ...(state.detailTailDigest === undefined ? {} : { previousDigest: state.detailTailDigest }),
      sessionPublicId: state.publicId,
      sourceBootId: authority.bootId,
      sourceDevicePublicId: identity.devicePublicId,
      sourceFence: authority.fence,
      stream: "detail",
      userPublicId: identity.userPublicId,
    });
    const digest = await sha256Hex(JSON.stringify({
      authority,
      envelope,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      previousDigest: state.detailTailDigest ?? null,
      sessionPublicId: state.publicId,
      stream: "detail",
    }));
    abortBeforeEffect(signal);
    const receipt = await this.#mutation("sessions:appendChunk", {
      authority,
      digest,
      envelope,
      expectedHeadSequence: state.detailHeadSequence,
      expectedStreamEpoch: state.detailStreamEpoch,
      ...(state.detailTailDigest === undefined ? {} : { expectedTailDigest: state.detailTailDigest }),
      firstSequence: first.sequence,
      lastSequence: last.sequence,
      ...(state.detailTailDigest === undefined ? {} : { previousDigest: state.detailTailDigest }),
      sessionPublicId: state.publicId,
      stream: "detail",
    });
    if (
      !isRecord(receipt)
      || receipt.digest !== digest
      || receipt.headSequence !== last.sequence
      || (receipt.replay !== undefined && typeof receipt.replay !== "boolean")
      || !isSafeNonNegativeInteger(receipt.streamEpoch)
    ) throw new Error("Cloud live append receipt is invalid.");
    state.detailHeadSequence = last.sequence;
    state.detailTailDigest = digest;
    state.detailStreamEpoch = receipt.streamEpoch;
    return true;
  }

  async #requestingDeviceActive(requestingDevicePublicId: string | undefined): Promise<boolean> {
    if (requestingDevicePublicId === undefined) return false;
    const device = await this.#transport.query("devices:get", { publicId: requestingDevicePublicId });
    return isRecord(device)
      && device.publicId === requestingDevicePublicId
      && device.status === "active";
  }

  async #ensureLease(
    sessionPublicId: string,
    identity: ActiveCloudIdentity,
  ): Promise<CloudLease> {
    const value = await this.#transport.query("leases:current", { sessionPublicId });
    let lease: CloudLease;
    if (value === null) {
      lease = parseLease(await this.#mutation("leases:acquire", {
        bootGeneration: this.#daemonAuthority.bootGeneration,
        bootId: this.#daemonAuthority.bootId,
        leaseDurationMs: this.#leaseDurationMs,
        sessionPublicId,
      }));
    } else {
      const current = parseLease(value);
      if (current.devicePublicId !== identity.devicePublicId) {
        throw new Error("Cloud session is leased to another device.");
      }
      const sameDaemon = current.bootGeneration === this.#daemonAuthority.bootGeneration
        && current.bootId === this.#daemonAuthority.bootId;
      const expired = current.leaseUntil <= this.#now();
      if (!sameDaemon && !expired) {
        throw new Error("Cloud session lease belongs to another daemon generation.");
      }
      if (!sameDaemon || expired) {
        lease = parseLease(await this.#mutation("leases:acquire", {
          bootGeneration: this.#daemonAuthority.bootGeneration,
          bootId: this.#daemonAuthority.bootId,
          leaseDurationMs: this.#leaseDurationMs,
          sessionPublicId,
        }));
      } else {
        lease = current;
      }
    }
    if (lease.leaseUntil - this.#now() <= this.#leaseDurationMs / 2) {
      const sequence = lease.heartbeatSequence + 1;
      const fingerprint = await sha256Hex(JSON.stringify({
        authority: authorityOf(lease),
        sequence,
        sessionPublicId,
      }));
      lease = parseLease(await this.#mutation("leases:heartbeat", {
        authority: authorityOf(lease),
        fingerprint,
        leaseDurationMs: this.#leaseDurationMs,
        sequence,
        sessionPublicId,
      }));
    }
    return lease;
  }

  async #completePendingUsageAccount(
    pending: PendingCloudUsageAccount,
    sourceGeneration: number = pending.sourceGeneration,
    sourceRevision: number = pending.sourceRevision,
  ): Promise<Readonly<{ generation: number | null; state: CloudDaemonJournalState }>> {
    return await this.#mutateJournal((state) => {
      if (!samePendingUsageAccount(state.pendingUsageAccount, pending)) {
        throw new Error("Cloud usage account outbox changed concurrently.");
      }
      return completePendingCloudUsageAccount(
        state,
        pending,
        sourceGeneration,
        sourceRevision,
      );
    });
  }

  async #reconcilePendingUsageAccount(
    identity: ActiveCloudIdentity,
    original: PendingCloudUsageAccount,
  ): Promise<Readonly<{ generation: number | null; state: CloudDaemonJournalState }>> {
    let pending = original;
    if (idempotencyExpired(pending.idempotencyKey, this.#now())) {
      const remote = parseCloudUsageAccountBinding(await this.#transport.query(
        "usage:getAccountBinding",
        { publicId: pending.accountPublicId },
      ));
      if (remote !== null && (
        remote.publicId !== pending.accountPublicId
        || remote.matchKey !== pending.matchKey
      )) throw new Error("Cloud usage account recovery changed authority.");
      const binding = remote?.binding ?? null;
      if (
        binding?.state === "present"
        && binding.sourceGeneration === pending.sourceGeneration
        && JSON.stringify(binding.encryptedLocalReference)
          === JSON.stringify(pending.encryptedLocalReference)
      ) {
        if (binding.usageSourceRevision < pending.sourceRevision) {
          throw new Error("Cloud usage account recovery regressed its snapshot cursor.");
        }
        return await this.#completePendingUsageAccount(
          pending,
          binding.sourceGeneration,
          binding.usageSourceRevision,
        );
      }
      if (binding !== null && binding.sourceGeneration > pending.sourceGeneration) {
        // A strictly newer binding from this exact device makes the old intent
        // obsolete. Preserve the remote generation in the cursor while
        // clearing only the exact aged outbox value.
        if (binding.usageSourceRevision < pending.sourceRevision) {
          throw new Error("Cloud usage account recovery regressed its snapshot cursor.");
        }
        return await this.#completePendingUsageAccount(
          pending,
          binding.sourceGeneration,
          binding.usageSourceRevision,
        );
      }
      if (binding !== null) {
        throw new Error("Cloud usage account recovery found conflicting binding evidence.");
      }
      const request = {
        accountPublicId: pending.accountPublicId,
        encryptedLocalReference: pending.encryptedLocalReference,
        encryptedMetadata: pending.encryptedMetadata,
        matchKey: pending.matchKey,
        sourceGeneration: pending.sourceGeneration,
      } as const;
      const fresh: PendingCloudUsageAccount = {
        ...request,
        idempotencyKey: validateUuid(this.#randomUuid()),
        requestDigest: await hmacSha256Hex(
          identity.accountKey,
          "usage-account",
          JSON.stringify(request),
        ),
        sourceRevision: pending.sourceRevision,
      };
      await this.#mutateJournal((state) => {
        if (!samePendingUsageAccount(state.pendingUsageAccount, pending)) {
          throw new Error("Cloud usage account outbox changed concurrently.");
        }
        return assertCloudDaemonJournalFutureCapacity({
          ...state,
          pendingUsageAccount: fresh,
        });
      });
      pending = fresh;
    }
    await this.#mutation("usage:upsertAccount", {
      encryptedLocalReference: pending.encryptedLocalReference,
      encryptedMetadata: pending.encryptedMetadata,
      idempotencyKey: pending.idempotencyKey,
      matchKey: pending.matchKey,
      publicId: pending.accountPublicId,
      requestDigest: pending.requestDigest,
      sourceGeneration: pending.sourceGeneration,
    });
    return await this.#completePendingUsageAccount(pending);
  }

  async #uploadUsage(
    identity: ActiveCloudIdentity,
    signal: AbortSignal,
    errors: string[],
  ): Promise<number> {
    let uploaded = 0;
    let journal = await this.#journal.read();
    if (journal.state.pendingUsageAccount !== null) {
      journal = await this.#reconcilePendingUsageAccount(
        identity,
        journal.state.pendingUsageAccount,
      );
    }
    const usageHeads = (await this.#local.listUsage({
      limit: maximumUsageAccounts,
      signal,
    })).map(validateUsage);
    const seen = new Set<string>();
    const prepared: Array<Readonly<{
      accountPublicId: string;
      cursor: CloudUsageAccountCursor;
      head: CloudLocalUsageSnapshot;
    }>> = [];
    for (const snapshot of usageHeads) {
      try {
        abortBeforeEffect(signal);
        const matchReference = normalizedUsageMatchReference(snapshot.matchReference);
        const matchKey = await hmacSha256Hex(
          identity.accountKey,
          "codex-account-match",
          matchReference,
        );
        const accountPublicId = `codex_${matchKey.slice(0, 48)}`;
        if (seen.has(accountPublicId)) {
          throw new Error("Local usage projection contains a duplicate Codex account.");
        }
        seen.add(accountPublicId);
        let cursor = journal.state.usageAccounts.find((entry) =>
          entry.accountPublicId === accountPublicId);
        if (cursor === undefined) {
          const remote = parseCloudUsageAccountBinding(await this.#transport.query(
            "usage:getAccountBinding",
            { publicId: accountPublicId },
          ));
          abortBeforeEffect(signal);
          if (remote !== null) {
            if (remote.publicId !== accountPublicId || remote.matchKey !== matchKey) {
              throw new Error("Cloud usage account binding changed authority.");
            }
            if (remote.binding?.state === "present") {
              const localReference = await decryptPrivateLocalReference(
                remote.binding.encryptedLocalReference,
                identity,
                accountPublicId,
              );
              if (localReference !== snapshot.localReference) {
                throw new Error("Cloud usage account binding belongs to another local profile.");
              }
              const recovered = {
                accountPublicId,
                sourceGeneration: remote.binding.sourceGeneration,
                sourceRevision: remote.binding.usageSourceRevision,
              } as const;
              journal = await this.#mutateJournal((state) => {
                const current = state.usageAccounts.find((entry) =>
                  entry.accountPublicId === accountPublicId);
                if (current !== undefined) return state;
                return assertCloudDaemonJournalFutureCapacity({
                  ...state,
                  usageAccounts: [...state.usageAccounts, recovered],
                });
              });
              cursor = journal.state.usageAccounts.find((entry) =>
                entry.accountPublicId === accountPublicId);
            }
          }
        }
        if (cursor !== undefined && snapshot.sourceGeneration < cursor.sourceGeneration) continue;
        if (cursor === undefined || snapshot.sourceGeneration > cursor.sourceGeneration) {
          const encryptedMetadata = await encryptPrivateJson(
            snapshot.metadata,
            identity,
            accountPublicId,
            "account_metadata",
          );
          const encryptedLocalReference = await encryptPrivateJson(
            { value: snapshot.localReference },
            identity,
            accountPublicId,
            "account_local_reference",
          );
          const idempotencyKey = validateUuid(this.#randomUuid());
          const request = {
            accountPublicId,
            encryptedLocalReference,
            encryptedMetadata,
            matchKey,
            sourceGeneration: snapshot.sourceGeneration,
          } as const;
          const requestDigest = await hmacSha256Hex(
            identity.accountKey,
            "usage-account",
            JSON.stringify(request),
          );
          const pending: PendingCloudUsageAccount = {
            ...request,
            idempotencyKey,
            requestDigest,
            sourceRevision: cursor?.sourceRevision ?? 0,
          };
          journal = await this.#mutateJournal((state) => {
            if (state.pendingUsageAccount !== null) {
              throw new Error("Cloud usage account outbox changed concurrently.");
            }
            return assertCloudDaemonJournalFutureCapacity({
              ...state,
              pendingUsageAccount: pending,
            });
          });
          await this.#mutation("usage:upsertAccount", {
            encryptedLocalReference,
            encryptedMetadata,
            idempotencyKey,
            matchKey,
            publicId: accountPublicId,
            requestDigest,
            sourceGeneration: snapshot.sourceGeneration,
          });
          journal = await this.#completePendingUsageAccount(pending);
          cursor = journal.state.usageAccounts.find((entry) =>
            entry.accountPublicId === accountPublicId);
        }
        if (cursor === undefined) {
          throw new Error("Cloud usage account cursor is unavailable after binding.");
        }
        prepared.push({ accountPublicId, cursor, head: snapshot });
      } catch (error: unknown) {
        errors.push(`usage: ${normalizeError(error)}`);
      }
    }

    if (prepared.length === 0) return uploaded;
    const historyPageLimit = Math.max(
      1,
      Math.floor(maximumUsageSnapshotsPerCycle / prepared.length),
    );
    const pages: Array<{
      accountPublicId: string;
      cursor: CloudUsageAccountCursor;
      failed: boolean;
      snapshots: readonly CloudLocalUsageSnapshot[];
    }> = [];
    for (const account of prepared) {
      try {
        const snapshots = this.#local.listUsageHistory === undefined
          ? account.head.sourceRevision > account.cursor.sourceRevision
            ? [account.head]
            : []
          : (await this.#local.listUsageHistory({
              afterSourceRevision: account.cursor.sourceRevision,
              limit: historyPageLimit,
              localReference: account.head.localReference,
              signal,
              sourceGeneration: account.head.sourceGeneration,
            })).map(validateUsage);
        let previousRevision = account.cursor.sourceRevision;
        for (const snapshot of snapshots) {
          if (
            snapshot.localReference !== account.head.localReference
            || normalizedUsageMatchReference(snapshot.matchReference)
              !== normalizedUsageMatchReference(account.head.matchReference)
            || snapshot.sourceGeneration !== account.head.sourceGeneration
            || snapshot.sourceRevision <= previousRevision
          ) throw new Error("Local cloud usage history changed source authority or order.");
          previousRevision = snapshot.sourceRevision;
        }
        pages.push({
          accountPublicId: account.accountPublicId,
          cursor: account.cursor,
          failed: false,
          snapshots,
        });
      } catch (error: unknown) {
        errors.push(`usage: ${normalizeError(error)}`);
      }
    }

    for (let offset = 0; uploaded < maximumUsageSnapshotsPerCycle; offset += 1) {
      let found = false;
      for (const page of pages) {
        const snapshot = page.snapshots[offset];
        if (snapshot === undefined || page.failed) continue;
        found = true;
        try {
          abortBeforeEffect(signal);
          if (
            page.cursor.sourceGeneration !== snapshot.sourceGeneration
            || snapshot.sourceRevision <= page.cursor.sourceRevision
          ) throw new Error("Cloud usage upload cursor changed source authority or order.");
          const envelope = await encryptUsageProjection(
            snapshot.projection,
            identity.accountKey,
            {
              entityPublicId: page.accountPublicId,
              keyVersion: identity.keyVersion,
              kind: "usage",
              userPublicId: identity.userPublicId,
            },
          );
          // Usage digests are server-visible equality tokens. Key them with the
          // account data key and a dedicated purpose so low-entropy projections
          // cannot be recognized through an offline raw-SHA dictionary.
          const digest = await hmacSha256Hex(
            identity.accountKey,
            "usage-projection",
            JSON.stringify(snapshot.projection),
          );
          const nextCursor = {
            accountPublicId: page.accountPublicId,
            sourceGeneration: snapshot.sourceGeneration,
            sourceRevision: snapshot.sourceRevision,
          } as const;
          assertCloudDaemonJournalFutureCapacity({
            ...journal.state,
            usageAccounts: [
              ...journal.state.usageAccounts.filter((entry) =>
                entry.accountPublicId !== page.accountPublicId),
              nextCursor,
            ],
          });
          const receipt = await this.#mutation("usage:upsertSnapshot", {
            accountPublicId: page.accountPublicId,
            digest,
            envelope,
            observedAt: snapshot.observedAt,
            sourceGeneration: snapshot.sourceGeneration,
            sourceRevision: snapshot.sourceRevision,
          });
          parseUsageSnapshotReceipt(receipt, snapshot.sourceRevision);
          journal = await this.#mutateJournal((state) => {
            const current = state.usageAccounts.find((entry) =>
              entry.accountPublicId === page.accountPublicId);
            if (sameUsageCursor(current, nextCursor)) return state;
            if (!sameUsageCursor(current, page.cursor)) {
              throw new Error("Cloud usage upload cursor changed concurrently.");
            }
            return assertCloudDaemonJournalFutureCapacity({
              ...state,
              usageAccounts: [
                ...state.usageAccounts.filter((entry) =>
                  entry.accountPublicId !== page.accountPublicId),
                nextCursor,
              ],
            });
          });
          page.cursor = nextCursor;
          uploaded += 1;
          if (uploaded >= maximumUsageSnapshotsPerCycle) break;
        } catch (error: unknown) {
          page.failed = true;
          errors.push(`usage: ${normalizeError(error)}`);
        }
      }
      if (!found) break;
    }
    return uploaded;
  }

  /*
   * Device commands. One bounded pass per cycle, mirroring `#processCommands`
   * exactly: claim the pending row, journal `prepared` before the server call,
   * flip the journal to `effect_started` before the effect, execute, settle.
   *
   * The two differences are the whole point of the separate table. There is no
   * lease, so the fence is this daemon's own boot authority; and there is no
   * session FIFO, so nothing queues behind a prepared head.
   *
   * Recovery is deliberately one-way across an effect boundary. `prepared`
   * proves the provider was not called and may resume after an exact hosted
   * read. `effect_started` may resume only when that read still says `prepared`,
   * proving the hosted boundary never committed. Once both records say
   * `effect_started`, the command is closed as `ambiguous` and never re-executed.
   */
  async #processDeviceCommands(
    identity: ActiveCloudIdentity,
    signal: AbortSignal,
    errors: string[],
  ): Promise<Readonly<{ applied: number }>> {
    const executor = this.#deviceExecutor;
    // A daemon built without a device-command executor never reads the device
    // command table at all. Rows addressed to it stay pending and expire on
    // their own deadline rather than being claimed by something that cannot
    // run them.
    if (executor === null) return { applied: 0 };
    let applied = 0;
    let commandBudgetRemaining = maximumDeviceCommandsPerCycle;
    const journalState = (await this.#journal.read()).state;
    const journalCommandPublicIds = new Set(
      journalState.deviceCommands.map((entry) => entry.commandPublicId),
    );
    await this.#assertDaemonCurrent(signal);

    // Close every stale entry first, so a crashed effect is quarantined before
    // this boot claims anything new.
    for (const entry of journalState.deviceCommands.slice(0, maximumDeviceCommandsPerCycle)) {
      abortBeforeEffect(signal);
      try {
        if (entry.phase === "terminal") {
          if (
            entry.kind === "account_login_start"
            && entry.terminalState === "applied"
            && entry.legacyResultMissing === true
          ) {
            await this.#quarantineLegacyLoginTerminal(entry, identity);
          } else {
            await this.#settleOrConfirmRevokedDeviceCommand(entry);
          }
          await this.#mutateJournal((state) =>
            removeCloudDeviceCommandJournalEntry(state, entry.commandPublicId));
          continue;
        }
        if (sameAuthority(entry.authority, this.#deviceCommandAuthority())) {
          // Count the attempt before its exact read. Even a failed read or a
          // fail-closed terminalization consumed this cycle's chance to cross
          // the provider boundary, so it cannot make room for fresh work.
          if (commandBudgetRemaining === 0) continue;
          commandBudgetRemaining -= 1;
          if (await this.#resumeCurrentDeviceCommand(entry, identity, executor, signal)) {
            applied += 1;
          }
          continue;
        }
        await this.#quarantineDeviceCommand(entry, identity);
      } catch (error: unknown) {
        errors.push(`device command ${entry.commandPublicId}: ${normalizeError(error)}`);
      }
    }

    if (commandBudgetRemaining === 0) return { applied };
    const pending = parseCloudDeviceCommands(
      await this.#transport.query("deviceCommands:listPendingForTarget", {
        limit: maximumDeviceCommandsPerCycle,
      }),
    );
    await this.#assertDaemonCurrent(signal);
    for (const command of pending) {
      // An entry observed at cycle start owns recovery for this exact command.
      // If recovery retained it after an error, never rediscover the pending row
      // below and attempt to add or execute it through a second path.
      if (journalCommandPublicIds.has(command.publicId)) continue;
      if (commandBudgetRemaining === 0) break;
      commandBudgetRemaining -= 1;
      abortBeforeEffect(signal);
      try {
        const authority = this.#deviceCommandAuthority();
        const payloadDigest = await sha256Hex(JSON.stringify(command.payload));
        const prepared: CloudDeviceCommandJournalEntry = {
          authority,
          commandPublicId: command.publicId,
          kind: command.kind,
          payloadDigest,
          phase: "prepared",
          requestingDevicePublicId: command.requestingDevicePublicId,
        };
        await this.#mutateJournal((state) =>
          addCloudDeviceCommandJournalEntry(state, prepared));
        if (await this.#prepareDeviceCommand(prepared) === "expired") {
          await this.#mutateJournal((state) =>
            removeCloudDeviceCommandJournalEntry(state, command.publicId));
          continue;
        }
        if (await this.#markExecuteAndSettleDeviceCommand(
          command,
          prepared,
          identity,
          executor,
          signal,
        )) applied += 1;
      } catch (error: unknown) {
        errors.push(`device command ${command.publicId}: ${normalizeError(error)}`);
        break;
      }
    }
    return { applied };
  }

  async #prepareDeviceCommand(
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "prepared" }>,
  ): Promise<"prepared" | "expired"> {
    const claim = await this.#mutation("deviceCommands:prepare", {
      authority: entry.authority,
      commandPublicId: entry.commandPublicId,
      localPhase: "prepared_no_effect",
    });
    if (
      !isRecord(claim)
      || claim.publicId !== entry.commandPublicId
      || (claim.state !== "prepared" && claim.state !== "expired")
    ) throw new Error("Cloud device command prepare response is invalid.");
    return claim.state;
  }

  async #readDeviceCommandRecovery(
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "prepared" | "effect_started" }>,
    identity: ActiveCloudIdentity,
  ): Promise<CloudDeviceCommand> {
    const remoteValue = await this.#transport.query("deviceCommands:get", {
      commandPublicId: entry.commandPublicId,
    });
    const remote = parseCloudDeviceCommands(remoteValue === null ? [] : [remoteValue])[0];
    if (
      remote === undefined
      || remote.publicId !== entry.commandPublicId
      || remote.kind !== entry.kind
      || remote.requestingDevicePublicId !== entry.requestingDevicePublicId
      || remote.requestDigest === undefined
      || remote.targetDevicePublicId !== identity.devicePublicId
      || remote.payload.keyVersion !== identity.keyVersion
    ) throw new Error("Cloud device command recovery identity is invalid.");
    let authenticatedPayload: DeviceCommandPayload;
    try {
      authenticatedPayload = await decryptDeviceCommand(remote.payload, identity.accountKey, {
        entityPublicId: remote.publicId,
        keyVersion: identity.keyVersion,
        kind: "device_command",
        userPublicId: identity.userPublicId,
      });
    } catch {
      throw new Error("Cloud device command recovery identity is invalid.");
    }
    const payloadDigest = await sha256Hex(JSON.stringify(remote.payload));
    const requestDigest = await hmacSha256Hex(
      identity.accountKey,
      "device-command-enqueue",
      JSON.stringify({
        deadline: remote.deadline,
        expectedTargetDevicePublicId: identity.devicePublicId,
        kind: remote.kind,
        payload: remote.payload,
        publicId: remote.publicId,
      }),
    );
    if (
      authenticatedPayload.kind !== remote.kind
      || payloadDigest !== entry.payloadDigest
      || requestDigest !== remote.requestDigest
    ) throw new Error("Cloud device command recovery identity is invalid.");

    if (remote.state === "pending") {
      if (remote.boundAuthority !== undefined) {
        throw new Error("Cloud device command recovery authority is invalid.");
      }
      return remote;
    }
    if (remote.boundAuthority !== undefined) {
      if (!sameAuthority(remote.boundAuthority, entry.authority)) {
        throw new Error("Cloud device command recovery authority is invalid.");
      }
      return remote;
    }
    // Only a terminal won while the command was still pending can legitimately
    // have no bound daemon authority. The confirming mutation below must still
    // prove that exact terminal before local evidence is retired.
    if (remote.state !== "cancelled" && remote.state !== "expired") {
      throw new Error("Cloud device command recovery authority is invalid.");
    }
    return remote;
  }

  async #confirmDeviceCommandTerminalRecovery(
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "prepared" | "effect_started" }>,
    expectedState: "ambiguous" | "cancelled" | "expired",
  ): Promise<void> {
    const confirmed = await this.#mutation("deviceCommands:confirmTerminalRecovery", {
      commandPublicId: entry.commandPublicId,
      localPhase: entry.phase === "prepared" ? "prepared_no_effect" : "effect_started",
      staleAuthority: entry.authority,
    });
    if (
      !isRecord(confirmed)
      || confirmed.publicId !== entry.commandPublicId
      || confirmed.replay !== true
      || confirmed.state !== expectedState
    ) throw new Error("Cloud device command terminal recovery confirmation is invalid.");
    await this.#mutateJournal((state) =>
      removeCloudDeviceCommandJournalEntry(state, entry.commandPublicId));
  }

  async #settleIndeterminateDeviceCommand(
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "prepared" | "effect_started" }>,
    identity: ActiveCloudIdentity,
  ): Promise<void> {
    const resultCode = "LOCAL_EFFECT_RECOVERY_REQUIRED";
    const terminalState = "ambiguous" as const;
    const resultDigest = await hmacSha256Hex(
      identity.accountKey,
      "device-command-result",
      JSON.stringify({ code: resultCode, result: null, state: terminalState }),
    );
    const terminal: CloudDeviceCommandJournalEntry = {
      ...entry,
      phase: "terminal",
      resultCode,
      resultDigest,
      terminalState,
    };
    await this.#mutateJournal((state) =>
      transitionCloudDeviceCommandJournalEntry(state, terminal));
    await this.#settleOrConfirmRevokedDeviceCommand(terminal);
    await this.#mutateJournal((state) =>
      removeCloudDeviceCommandJournalEntry(state, entry.commandPublicId));
  }

  async #resumeCurrentDeviceCommand(
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "prepared" | "effect_started" }>,
    identity: ActiveCloudIdentity,
    executor: CloudDeviceCommandExecutorPort,
    signal: AbortSignal,
  ): Promise<boolean> {
    const remote = await this.#readDeviceCommandRecovery(entry, identity);
    await this.#assertDaemonCurrent(signal);
    if (
      remote.state === "cancelled"
      || remote.state === "expired"
      || (remote.state === "ambiguous" && entry.phase === "effect_started")
    ) {
      await this.#confirmDeviceCommandTerminalRecovery(entry, remote.state);
      return false;
    }
    if (isTerminalCommandState(remote.state)) {
      throw new Error("Cloud device command recovery terminal is inconsistent.");
    }

    if (entry.phase === "prepared") {
      if (remote.state === "effect_started") {
        // The hosted boundary advanced without the corresponding local record.
        // That contradiction can never authorize a provider replay.
        await this.#settleIndeterminateDeviceCommand(entry, identity);
        return false;
      }
      if (remote.state !== "pending" && remote.state !== "prepared") {
        throw new Error("Cloud device command recovery state is invalid.");
      }
      if (await this.#prepareDeviceCommand(entry) === "expired") {
        await this.#mutateJournal((state) =>
          removeCloudDeviceCommandJournalEntry(state, entry.commandPublicId));
        return false;
      }
      return await this.#markExecuteAndSettleDeviceCommand(
        remote,
        entry,
        identity,
        executor,
        signal,
      );
    }

    if (remote.state === "effect_started") {
      // This is the ambiguous half-open boundary: a lost mark response and an
      // executor that began before interruption have the same durable shape.
      await this.#settleIndeterminateDeviceCommand(entry, identity);
      return false;
    }
    if (remote.state !== "prepared") {
      throw new Error("Cloud device command recovery state is invalid.");
    }
    // The local journal was advanced before the mark mutation. An authoritative
    // hosted `prepared` read therefore proves the mark did not commit and the
    // provider executor could not have been reached.
    return await this.#markExecuteAndSettleDeviceCommand(
      remote,
      entry,
      identity,
      executor,
      signal,
    );
  }

  async #markExecuteAndSettleDeviceCommand(
    command: CloudDeviceCommand,
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "prepared" | "effect_started" }>,
    identity: ActiveCloudIdentity,
    executor: CloudDeviceCommandExecutorPort,
    signal: AbortSignal,
  ): Promise<boolean> {
    const started: Extract<CloudDeviceCommandJournalEntry, { phase: "effect_started" }> =
      entry.phase === "effect_started" ? entry : { ...entry, phase: "effect_started" };
    if (entry.phase === "prepared") {
      await this.#mutateJournal((state) =>
        transitionCloudDeviceCommandJournalEntry(state, started));
    }
    abortBeforeEffect(signal);
    const begin = await this.#mutation("deviceCommands:markEffectStarted", {
      authority: started.authority,
      commandPublicId: command.publicId,
    });
    if (
      !isRecord(begin)
      || begin.publicId !== command.publicId
      || (begin.state !== "effect_started" && begin.state !== "expired")
    ) throw new Error("Cloud device command effect-start response is invalid.");
    if (begin.state === "expired") {
      await this.#mutateJournal((state) =>
        removeCloudDeviceCommandJournalEntry(state, command.publicId));
      return false;
    }

    let outcome: CloudDeviceCommandExecutionResult;
    try {
      const payload = await decryptDeviceCommand(command.payload, identity.accountKey, {
        entityPublicId: command.publicId,
        keyVersion: command.payload.keyVersion,
        kind: "device_command",
        userPublicId: identity.userPublicId,
      });
      if (payload.kind !== command.kind) {
        throw new Error("Cloud device command kind is inconsistent.");
      }
      await this.#assertDaemonCurrent(signal);
      outcome = await this.#requestingDeviceActive(command.requestingDevicePublicId)
        ? await executor.executeDeviceCommand({
            idempotencyKey: command.publicId,
            payload,
            requestingDevicePublicId: command.requestingDevicePublicId,
            signal,
          })
        : { code: "REQUESTING_DEVICE_INACTIVE", state: "failed" };
      if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(outcome.code)) {
        throw new Error("Local device command executor returned an invalid result.");
      }
      if (
        (outcome.result !== undefined && outcome.result.kind !== command.kind)
        || (outcome.singleUseResult === true
          && (command.kind !== "account_login_start" || outcome.result === undefined))
        || (command.kind === "account_login_start"
          && outcome.state === "applied"
          && (outcome.result === undefined || outcome.singleUseResult !== true))
      ) throw new Error("Local device command executor returned an invalid result.");
    } catch {
      outcome = { code: "LOCAL_EFFECT_INDETERMINATE", state: "ambiguous" };
    }
    const resultDigest = await hmacSha256Hex(
      identity.accountKey,
      "device-command-result",
      JSON.stringify({
        code: outcome.code,
        result: outcome.result ?? null,
        state: outcome.state,
      }),
    );
    const encryptedResult = outcome.result === undefined
      ? undefined
      : await encryptDeviceCommandResult(outcome.result, identity.accountKey, {
          entityPublicId: command.publicId,
          keyVersion: identity.keyVersion,
          kind: "device_command_result",
          userPublicId: identity.userPublicId,
        });
    const terminal: CloudDeviceCommandJournalEntry = {
      ...started,
      phase: "terminal",
      ...(encryptedResult === undefined ? {} : { result: encryptedResult }),
      resultCode: outcome.code,
      resultDigest,
      ...(outcome.singleUseResult === true ? { singleUseResult: true } : {}),
      terminalState: outcome.state,
    };
    await this.#mutateJournal((state) =>
      transitionCloudDeviceCommandJournalEntry(state, terminal));
    await this.#settleOrConfirmRevokedDeviceCommand(terminal);
    await this.#mutateJournal((state) =>
      removeCloudDeviceCommandJournalEntry(state, command.publicId));
    return outcome.state === "applied";
  }

  #deviceCommandAuthority(): AuthorityTuple {
    return {
      bootGeneration: this.#daemonAuthority.bootGeneration,
      bootId: this.#daemonAuthority.bootId,
      // A device command has no lease, so the boot generation and id are the
      // whole fence. Fence 1 keeps the tuple shape valid for the shared
      // authority validator without inventing a second counter.
      fence: 1,
    };
  }

  async #settleDeviceCommand(
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "terminal" }>,
  ): Promise<void> {
    await this.#mutation("deviceCommands:settle", {
      authority: entry.authority,
      commandPublicId: entry.commandPublicId,
      ...(entry.result === undefined ? {} : { result: entry.result }),
      resultCode: entry.resultCode,
      resultDigest: entry.resultDigest,
      ...(entry.singleUseResult === true ? { singleUseResult: true } : {}),
      state: entry.terminalState,
    });
  }

  async #settleOrConfirmRevokedDeviceCommand(
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "terminal" }>,
  ): Promise<void> {
    try {
      await this.#settleDeviceCommand(entry);
      return;
    } catch (settleError: unknown) {
      try {
        const confirmed = await this.#mutation("deviceCommands:confirmRevokedTerminal", {
          authority: entry.authority,
          commandPublicId: entry.commandPublicId,
        });
        if (
          !isRecord(confirmed)
          || confirmed.publicId !== entry.commandPublicId
          || confirmed.replay !== true
          || confirmed.state !== "ambiguous"
        ) throw new Error("Cloud device command revocation confirmation is invalid.");
        return;
      } catch {
        // Settlement remains the authoritative error unless the server proves
        // the exact result-less revocation terminal. Network failure, a
        // different terminal result, or an authority mismatch all retain the
        // local journal for a later exact replay.
        throw settleError;
      }
    }
  }

  async #quarantineDeviceCommand(
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "prepared" | "effect_started" }>,
    identity: ActiveCloudIdentity,
  ): Promise<void> {
    // `prepared` never began an effect, so it is honestly a failure. An
    // `effect_started` entry may have created a session; the only truthful
    // terminal state a later boot can publish is `ambiguous`.
    const terminalState = entry.phase === "prepared" ? "failed" as const : "ambiguous" as const;
    const resultCode = entry.phase === "prepared"
      ? "LOCAL_AUTHORITY_CHANGED_BEFORE_EFFECT"
      : "LOCAL_EFFECT_RECOVERY_REQUIRED";
    const resultDigest = await hmacSha256Hex(
      identity.accountKey,
      "device-command-result",
      JSON.stringify({ code: resultCode, result: null, state: terminalState }),
    );
    const localPhase = entry.phase === "prepared" ? "prepared_no_effect" as const : "effect_started" as const;
    try {
      const recovered = await this.#mutation("deviceCommands:recoverEffectStarted", {
        commandPublicId: entry.commandPublicId,
        localPhase,
        recoveryAuthority: this.#deviceCommandAuthority(),
        resultCode,
        resultDigest,
        staleAuthority: entry.authority,
        state: terminalState,
      });
      if (
        !isRecord(recovered)
        || recovered.publicId !== entry.commandPublicId
        || typeof recovered.replay !== "boolean"
        || recovered.state !== terminalState
      ) throw new Error("Cloud device command recovery response is invalid.");
    } catch (recoveryError: unknown) {
      try {
        const confirmed = await this.#mutation("deviceCommands:confirmTerminalRecovery", {
          commandPublicId: entry.commandPublicId,
          localPhase,
          staleAuthority: entry.authority,
        });
        const confirmedState = isRecord(confirmed) ? confirmed.state : undefined;
        const stateMatches = confirmedState === "cancelled"
          || confirmedState === "expired"
          || (localPhase === "effect_started" && confirmedState === "ambiguous");
        if (
          !isRecord(confirmed)
          || confirmed.publicId !== entry.commandPublicId
          || confirmed.replay !== true
          || !stateMatches
        ) throw new Error("Cloud device command terminal recovery confirmation is invalid.");
      } catch {
        // A query result is not enough to retire durable effect evidence. If the
        // server cannot prove the exact result-less terminal, preserve the
        // journal and the original recovery error for another cycle.
        throw recoveryError;
      }
    }
    await this.#mutateJournal((state) =>
      removeCloudDeviceCommandJournalEntry(state, entry.commandPublicId));
  }

  async #quarantineLegacyLoginTerminal(
    entry: Extract<CloudDeviceCommandJournalEntry, { phase: "terminal" }>,
    identity: ActiveCloudIdentity,
  ): Promise<void> {
    const remoteValue = await this.#transport.query("deviceCommands:get", {
      commandPublicId: entry.commandPublicId,
    });
    const remote = parseCloudDeviceCommands(remoteValue === null ? [] : [remoteValue])[0];
    if (
      remote === undefined
      || remote.publicId !== entry.commandPublicId
      || remote.kind !== "account_login_start"
    ) throw new Error("Cloud device command recovery response is invalid.");
    if (remote.state === "applied") {
      if (
        remote.resultCode !== entry.resultCode
        || remote.resultSingleUse !== true
        || remote.resultConsumed === undefined
      ) throw new Error("Cloud device command legacy result is unavailable.");
      await this.#settleDeviceCommand(entry);
      return;
    }
    if (remote.state === "ambiguous") {
      const confirmed = await this.#mutation("deviceCommands:confirmRevokedTerminal", {
        authority: entry.authority,
        commandPublicId: entry.commandPublicId,
      });
      if (
        !isRecord(confirmed)
        || confirmed.publicId !== entry.commandPublicId
        || confirmed.replay !== true
        || confirmed.state !== "ambiguous"
      ) throw new Error("Cloud device command revocation confirmation is invalid.");
      return;
    }
    const resultCode = "LOCAL_RESULT_RECOVERY_REQUIRED";
    const terminalState = "ambiguous" as const;
    const resultDigest = await hmacSha256Hex(
      identity.accountKey,
      "device-command-result",
      JSON.stringify({ code: resultCode, result: null, state: terminalState }),
    );
    await this.#mutation("deviceCommands:recoverEffectStarted", {
      commandPublicId: entry.commandPublicId,
      localPhase: "effect_started",
      recoveryAuthority: this.#deviceCommandAuthority(),
      resultCode,
      resultDigest,
      staleAuthority: entry.authority,
      state: terminalState,
    });
  }

  async #processCommands(
    identity: ActiveCloudIdentity,
    heads: Map<string, CloudSessionHead>,
    leases: Map<string, CloudLease>,
    projectionRecoveryBlockedSessionIds: ReadonlySet<string>,
    signal: AbortSignal,
    errors: string[],
  ): Promise<Readonly<{
    applied: number;
    blockedSessionIds: ReadonlySet<string>;
    pendingScanComplete: boolean;
    unsettled: number;
  }>> {
    let applied = 0;
    let journalAtStartObservation = await this.#journal.read();
    try {
      assertCloudDaemonJournalFutureCapacity(journalAtStartObservation.state);
    } catch (error: unknown) {
      if (
        !(error instanceof Error)
        || error.message !== "Cloud daemon journal is corrupt."
      ) throw error;
      const outcome = {
        code: unreservedPreparedCommandResultCode,
        state: "failed" as const,
      };
      const resultDigest = await sha256Hex(JSON.stringify(outcome));
      journalAtStartObservation = await this.#mutateJournal((state) =>
        terminalizeUnreservedPreparedCloudCommands(state, {
          resultCode: outcome.code,
          resultDigest,
        }));
    }
    const journalAtStart = journalAtStartObservation.state.commands;
    const initiallyBlockedSessionIds = new Set(
      [
        ...journalAtStart.map((entry) => entry.sessionPublicId),
        ...projectionRecoveryBlockedSessionIds,
      ],
    );
    const blockedSessionIds = new Set(initiallyBlockedSessionIds);
    const nonterminal: CloudCommandMetadata[] = [];
    const nonterminalIds = new Set<string>();
    let cursor: string | null = null;
    let pendingScanComplete = false;
    for (let pageNumber = 0; pageNumber < 50 && !pendingScanComplete; pageNumber += 1) {
      const result = parseCloudCommandMetadataPage(await this.#transport.query(
        "commands:listNonterminalForTargetPage",
        { paginationOpts: { cursor, numItems: cloudLimits.pageSize } },
      ));
      for (const command of result.page) {
        if (nonterminalIds.has(command.publicId) || isTerminalCommandState(command.state)) {
          throw new Error("Cloud command pagination repeated an identity.");
        }
        nonterminalIds.add(command.publicId);
        nonterminal.push(command);
        blockedSessionIds.add(command.sessionPublicId);
      }
      cursor = result.continueCursor;
      pendingScanComplete = result.isDone;
    }

    // The server index is authoritative for equal-millisecond insertion order.
    // Choose only the oldest unsettled command per session, then order those
    // heads by deadline. A prepared/effect-started head blocks its successors,
    // except `resolve_interaction`, which gets its own per-session scheduling
    // lane so a decision is never stuck behind a long-prepared `send` head.
    const alreadyJournaled = new Set(journalAtStart.map((entry) => entry.commandPublicId));
    const sessionHeads: Array<Readonly<{ command: CloudCommandMetadata; ordinal: number }>> = [];
    const selectedLaneKeys = new Set<string>();
    for (const [ordinal, command] of nonterminal.entries()) {
      const decisionLane = command.kind === "resolve_interaction";
      const laneKey = `${command.sessionPublicId} ${decisionLane ? "decision" : "default"}`;
      if (selectedLaneKeys.has(laneKey)) continue;
      selectedLaneKeys.add(laneKey);
      if (
        command.state !== "pending"
        || alreadyJournaled.has(command.publicId)
        || (!decisionLane && initiallyBlockedSessionIds.has(command.sessionPublicId))
      ) continue;
      sessionHeads.push({ command, ordinal });
    }
    sessionHeads.sort((left, right) =>
      left.command.deadline - right.command.deadline || left.ordinal - right.ordinal);
    let failedFreshAttempts = 0;
    for (const { command } of sessionHeads.slice(0, maximumCommandsPerCycle)) {
      try {
        const exact = await this.#findCommand(command.sessionPublicId, command.publicId);
        if (
          exact === null
          || exact.state !== "pending"
          || !sameCloudCommandMetadata(command, exact)
        ) throw new Error("Cloud command changed after fair scheduling.");
        let head = heads.get(command.sessionPublicId);
        if (head === undefined) {
          const value = await this.#transport.query("sessions:getHead", {
            publicId: command.sessionPublicId,
          });
          if (value === null) throw new Error("Cloud command session is unavailable.");
          head = parseSessionHead(value);
          heads.set(head.publicId, head);
        }
        if (head.executionDevicePublicId !== identity.devicePublicId) {
          throw new Error("Cloud command target does not match this device.");
        }
        const lease = await this.#leaseForCommand(
          command.sessionPublicId,
          identity,
          leases,
        );
        const payloadDigest = await sha256Hex(JSON.stringify(exact.payload));
        const localAuthority = validateLocalCommandAuthority(
          await this.#local.resolveCommandAuthority({
            sessionPublicId: command.sessionPublicId,
            signal,
          }),
        );
        if (localAuthority.localSessionId !== command.sessionPublicId) {
          throw new Error("Local provider command authority does not match its cloud session.");
        }
        const entry: CloudCommandJournalEntry = {
          authority: authorityOf(lease),
          commandPublicId: command.publicId,
          kind: command.kind,
          localAuthorityDigest: await sha256Hex(JSON.stringify(localAuthority)),
          payloadDigest,
          phase: "prepared",
          sessionPublicId: command.sessionPublicId,
        };
        await this.#addCommand(entry);
        if (await this.#executePrepared(
          identity,
          command.sessionPublicId,
          exact,
          lease,
          localAuthority,
          signal,
        )) applied += 1;
      } catch (error: unknown) {
        errors.push(`${command.publicId}: ${normalizeError(error)}`);
        failedFreshAttempts += 1;
        // Every cloud request already has a strict transport deadline. Bound
        // unrelated failures so 31 timeouts cannot delay the next poll, while
        // still reserving progress for later independent session heads.
        if (failedFreshAttempts >= 4) break;
      }
    }

    // Missing local journal custody is not an empty recovery state. Rebuild a
    // bounded, conservative receipt from server authority. Prepared proves no
    // provider effect began; effect_started must never be replayed.
    const journalIds = new Set(journalAtStart.map((entry) => entry.commandPublicId));
    const recoveryIds = new Set(journalIds);
    const missingRecovery = nonterminal
      .filter((command) =>
        (command.state === "prepared" || command.state === "effect_started")
        && !journalIds.has(command.publicId))
      .sort((left, right) =>
        Number(right.state === "effect_started") - Number(left.state === "effect_started")
        || left.createdAt - right.createdAt);
    for (const command of missingRecovery.slice(0, maximumJournalRecoveriesPerCycle)) {
      try {
        const exact = await this.#findCommand(command.sessionPublicId, command.publicId);
        if (
          exact === null
          || !sameCloudCommandMetadata(command, exact)
          || exact.boundAuthority === undefined
        ) {
          throw new Error("Cloud nonterminal command has no bound execution authority.");
        }
        const entry: CloudCommandJournalEntry = {
          authority: exact.boundAuthority,
          commandPublicId: command.publicId,
          kind: command.kind,
          localAuthorityDigest: await sha256Hex(
            "hra-control-plane-cloud-command-missing-local-journal:v1",
          ),
          payloadDigest: await sha256Hex(JSON.stringify(exact.payload)),
          phase: command.state === "effect_started" ? "effect_started" : "prepared",
          sessionPublicId: command.sessionPublicId,
        };
        await this.#addCommand(entry);
        journalIds.add(command.publicId);
        recoveryIds.add(command.publicId);
      } catch (error: unknown) {
        errors.push(`${command.publicId}: ${normalizeError(error)}`);
        break;
      }
    }

    const recoveryCandidates = (await this.#journal.read()).state.commands
      .filter((entry) => recoveryIds.has(entry.commandPublicId))
      .map((entry, ordinal) => ({ entry, ordinal }))
      .sort((left, right) => {
        const priority = (entry: CloudCommandJournalEntry): number =>
          entry.phase === "effect_started" ? 0 : entry.phase === "terminal" ? 1 : 2;
        return priority(left.entry) - priority(right.entry) || left.ordinal - right.ordinal;
      })
      .slice(0, maximumJournalRecoveriesPerCycle);
    for (const { entry } of recoveryCandidates) {
      try {
        if (entry.phase === "terminal") {
          const remote = await this.#findCommand(
            entry.sessionPublicId,
            entry.commandPublicId,
          );
          if (remote === null) {
            await this.#removeExactCommand(entry);
            continue;
          }
          if (
            (remote.state === "applied"
              || remote.state === "failed"
              || remote.state === "ambiguous")
            && remote.state !== entry.terminalState
          ) throw new Error("Cloud terminal command recovery changed its outcome.");
          await this.#settleTerminal(identity, entry);
          await this.#removeExactCommand(entry);
          continue;
        }
        const resumed = await this.#findCommand(entry.sessionPublicId, entry.commandPublicId);
        if (resumed === null || isTerminalCommandState(resumed.state)) {
          await this.#removeExactCommand(entry);
          continue;
        }
        if (await sha256Hex(JSON.stringify(resumed.payload)) !== entry.payloadDigest) {
          throw new Error("Prepared cloud command payload changed.");
        }
        if (entry.phase === "effect_started" || resumed.state === "effect_started") {
          const effectEntry: Extract<CloudCommandJournalEntry, { phase: "effect_started" }> = {
            ...entry,
            phase: "effect_started",
          };
          if (entry.phase !== "effect_started") await this.#replaceCommand(effectEntry);
          await this.#settleEffectStartedAsAmbiguous(identity, effectEntry);
          continue;
        }
        const lease = await this.#leaseForCommand(
          entry.sessionPublicId,
          identity,
          leases,
        );
        if (projectionRecoveryBlockedSessionIds.has(entry.sessionPublicId)) {
          await this.#failPreparedWithoutEffect(
            entry,
            resumed,
            lease,
            "PROJECTION_RECOVERY_BLOCKED_BEFORE_EFFECT",
          );
          continue;
        }
        if (
          entry.localAuthorityDigest
          === await sha256Hex("hra-control-plane-cloud-command-missing-local-journal:v1")
        ) {
          await this.#failPreparedWithoutEffect(
            entry,
            resumed,
            lease,
            "LOCAL_JOURNAL_EVIDENCE_MISSING_BEFORE_EFFECT",
          );
          continue;
        }
        const localAuthority = validateLocalCommandAuthority(
          await this.#local.resolveCommandAuthority({
            sessionPublicId: entry.sessionPublicId,
            signal,
          }),
        );
        if (localAuthority.localSessionId !== entry.sessionPublicId) {
          throw new Error("Local provider command authority does not match its cloud session.");
        }
        if (await sha256Hex(JSON.stringify(localAuthority)) !== entry.localAuthorityDigest) {
          await this.#failPreparedWithoutEffect(
            entry,
            resumed,
            lease,
            "LOCAL_AUTHORITY_CHANGED_BEFORE_EFFECT",
          );
          continue;
        }
        if (await this.#executePrepared(
          identity,
          entry.sessionPublicId,
          resumed,
          lease,
          localAuthority,
          signal,
        )) applied += 1;
      } catch (error: unknown) {
        errors.push(`${entry.commandPublicId}: ${normalizeError(error)}`);
        break;
      }
    }
    return {
      applied,
      blockedSessionIds,
      pendingScanComplete,
      unsettled: (await this.#journal.read()).state.commands.length,
    };
  }

  async #leaseForCommand(
    sessionPublicId: string,
    identity: ActiveCloudIdentity,
    leases: Map<string, CloudLease>,
  ): Promise<CloudLease> {
    const cached = leases.get(sessionPublicId);
    if (cached !== undefined && cached.leaseUntil > this.#now()) return cached;
    const lease = await this.#ensureLease(sessionPublicId, identity);
    leases.set(sessionPublicId, lease);
    return lease;
  }

  async #failPreparedWithoutEffect(
    entry: Extract<CloudCommandJournalEntry, { phase: "prepared" }>,
    command: CloudCommand,
    lease: CloudLease,
    resultCode: string,
  ): Promise<void> {
    if (command.state !== "pending" && command.state !== "prepared") {
      throw new Error("Cloud command is no longer safely recoverable before effect.");
    }
    const authority = authorityOf(lease);
    const prepared = await this.#mutation("commands:prepare", {
      authority,
      commandPublicId: command.publicId,
      localPhase: "prepared_no_effect",
    });
    if (
      !isRecord(prepared)
      || prepared.publicId !== command.publicId
      || (prepared.state !== "prepared" && prepared.state !== "expired")
    ) throw new Error("Cloud command prepare response is invalid.");
    if (prepared.state === "expired") {
      await this.#removeExactCommand(entry);
      return;
    }
    const outcome = { code: resultCode, state: "failed" as const };
    const terminal: CloudCommandJournalEntry = {
      ...entry,
      authority,
      phase: "terminal",
      resultCode,
      resultDigest: await sha256Hex(JSON.stringify(outcome)),
      terminalState: "failed",
    };
    await this.#replaceCommand(terminal);
    await this.#settle(terminal);
    await this.#removeExactCommand(terminal);
  }

  async #executePrepared(
    identity: ActiveCloudIdentity,
    sessionPublicId: string,
    command: CloudCommand,
    lease: CloudLease,
    localAuthority: CloudLocalCommandAuthority,
    signal: AbortSignal,
  ): Promise<boolean> {
    const authority = authorityOf(lease);
    const payloadDigest = await sha256Hex(JSON.stringify(command.payload));
    const current = (await this.#journal.read()).state.commands.find((entry) =>
      entry.commandPublicId === command.publicId);
    if (
      current?.phase !== "prepared"
      || current.payloadDigest !== payloadDigest
      || current.kind !== command.kind
      || current.sessionPublicId !== sessionPublicId
      || current.localAuthorityDigest !== await sha256Hex(JSON.stringify(localAuthority))
    ) throw new Error("Prepared cloud command journal does not match its request.");
    const prepared = await this.#mutation("commands:prepare", {
      authority,
      commandPublicId: command.publicId,
      localPhase: "prepared_no_effect",
    });
    if (
      !isRecord(prepared)
      || prepared.publicId !== command.publicId
      || (prepared.state !== "prepared" && prepared.state !== "expired")
      || (prepared.replay !== undefined && typeof prepared.replay !== "boolean")
      || (prepared.rebound !== undefined && typeof prepared.rebound !== "boolean")
      || !hasExactKeys(prepared, [
        "publicId",
        ...("rebound" in prepared ? ["rebound"] : []),
        ...("replay" in prepared ? ["replay"] : []),
        "state",
      ])
    ) throw new Error("Cloud command prepare response is invalid.");
    if (prepared.state === "expired") {
      // The server's deadline decision is authoritative and was made before
      // any local provider effect. Clearing the durable prepare record makes
      // the expiry absorbing instead of turning it into an ambiguous effect.
      await this.#removeCommand(command.publicId);
      return false;
    }
    const effectEntry: CloudCommandJournalEntry = {
      ...current,
      authority,
      phase: "effect_started",
    };
    await this.#replaceCommand(effectEntry);
    const started = await this.#mutation("commands:markEffectStarted", {
      authority,
      commandPublicId: command.publicId,
    });
    if (
      !isRecord(started)
      || started.publicId !== command.publicId
      || (started.state !== "effect_started" && started.state !== "expired")
      || (started.replay !== undefined && typeof started.replay !== "boolean")
      || !hasExactKeys(started, [
        "publicId",
        ...(started.replay === undefined ? [] : ["replay"]),
        "state",
      ])
    ) throw new Error("Cloud command effect-start response is invalid.");
    if (started.state === "expired") {
      await this.#removeCommand(command.publicId);
      return false;
    }
    let outcome: CloudCommandExecutionResult;
    try {
      const payload = await decryptRemoteCommand(
        command.payload,
        identity.accountKey,
        {
          entityPublicId: command.publicId,
          keyVersion: command.payload.keyVersion,
          kind: "command",
          userPublicId: identity.userPublicId,
        },
      );
      if (payload.kind !== command.kind) throw new Error("Cloud command kind is inconsistent.");
      await this.#assertDaemonCurrent(signal);
      // A remote decision is honoured only while the device that requested it
      // is still active; a device revoked after enqueue cannot approve.
      const requesterActive = payload.kind === "resolve_interaction"
        ? await this.#requestingDeviceActive(command.requestingDevicePublicId)
        : true;
      outcome = requesterActive
        ? await this.#executor.execute({
            authority: localAuthority,
            idempotencyKey: command.publicId,
            leaseAuthority: authority,
            payload,
            sessionPublicId,
            signal,
          })
        : { code: "REQUESTING_DEVICE_INACTIVE", state: "failed" };
      if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(outcome.code)) {
        throw new Error("Local cloud command executor returned an invalid result.");
      }
    } catch {
      outcome = { code: "LOCAL_EFFECT_INDETERMINATE", state: "ambiguous" };
    }
    const resultDigest = await sha256Hex(JSON.stringify(outcome));
    const terminal: CloudCommandJournalEntry = {
      ...effectEntry,
      phase: "terminal",
      resultCode: outcome.code,
      resultDigest,
      terminalState: outcome.state,
    };
    await this.#replaceCommand(terminal);
    await this.#settle(terminal);
    await this.#removeCommand(command.publicId);
    return outcome.state === "applied";
  }

  async #settleEffectStartedAsAmbiguous(
    identity: ActiveCloudIdentity,
    entry: Extract<CloudCommandJournalEntry, { phase: "effect_started" }>,
  ): Promise<void> {
    const leaseValue = await this.#transport.query("leases:current", {
      sessionPublicId: entry.sessionPublicId,
    });
    if (leaseValue === null) throw new Error("Cloud effect recovery lease is unavailable.");
    let liveLease = parseLease(leaseValue);
    if (liveLease.devicePublicId !== identity.devicePublicId) {
      throw new Error("Cloud effect recovery is owned by another device.");
    }
    const sameDaemon = liveLease.bootGeneration === this.#daemonAuthority.bootGeneration
      && liveLease.bootId === this.#daemonAuthority.bootId;
    if (!sameDaemon && liveLease.leaseUntil > this.#now()) {
      throw new Error("Cloud effect recovery lease belongs to another daemon generation.");
    }
    if (!sameDaemon || liveLease.leaseUntil <= this.#now()) {
      liveLease = await this.#ensureLease(entry.sessionPublicId, identity);
    }
    const outcome = { code: "LOCAL_EFFECT_RECOVERY_REQUIRED", state: "ambiguous" as const };
    const terminal: CloudCommandJournalEntry = {
      ...entry,
      phase: "terminal",
      resultCode: outcome.code,
      resultDigest: await sha256Hex(JSON.stringify(outcome)),
      terminalState: outcome.state,
    };
    await this.#replaceCommand(terminal);
    if (sameAuthority(authorityOf(liveLease), entry.authority)) {
      await this.#mutation("commands:markEffectStarted", {
        authority: entry.authority,
        commandPublicId: entry.commandPublicId,
      });
      await this.#settle(terminal);
    } else {
      await this.#mutation("commands:recoverEffectStarted", {
        commandPublicId: entry.commandPublicId,
        recoveryAuthority: authorityOf(liveLease),
        resultCode: terminal.resultCode,
        resultDigest: terminal.resultDigest,
        staleAuthority: entry.authority,
        state: terminal.terminalState,
      });
    }
    await this.#removeCommand(entry.commandPublicId);
  }

  async #settle(
    entry: Extract<CloudCommandJournalEntry, { phase: "terminal" }>,
  ): Promise<void> {
    await this.#mutation("commands:settle", {
      authority: entry.authority,
      commandPublicId: entry.commandPublicId,
      resultCode: entry.resultCode,
      resultDigest: entry.resultDigest,
      state: entry.terminalState,
    });
  }

  async #settleTerminal(
    identity: ActiveCloudIdentity,
    entry: Extract<CloudCommandJournalEntry, { phase: "terminal" }>,
  ): Promise<void> {
    const leaseValue = await this.#transport.query("leases:current", {
      sessionPublicId: entry.sessionPublicId,
    });
    if (leaseValue === null) throw new Error("Cloud terminal recovery lease is unavailable.");
    let liveLease = parseLease(leaseValue);
    if (liveLease.devicePublicId !== identity.devicePublicId) {
      throw new Error("Cloud terminal recovery is owned by another device.");
    }
    const sameDaemon = liveLease.bootGeneration === this.#daemonAuthority.bootGeneration
      && liveLease.bootId === this.#daemonAuthority.bootId;
    if (!sameDaemon && liveLease.leaseUntil > this.#now()) {
      throw new Error("Cloud terminal recovery lease belongs to another daemon generation.");
    }
    if (!sameDaemon || liveLease.leaseUntil <= this.#now()) {
      liveLease = await this.#ensureLease(entry.sessionPublicId, identity);
    }
    if (sameAuthority(authorityOf(liveLease), entry.authority)) {
      await this.#settle(entry);
      return;
    }
    await this.#mutation("commands:recoverEffectStarted", {
      commandPublicId: entry.commandPublicId,
      recoveryAuthority: authorityOf(liveLease),
      resultCode: entry.resultCode,
      resultDigest: entry.resultDigest,
      staleAuthority: entry.authority,
      state: entry.terminalState,
    });
  }

  async #findCommand(
    sessionPublicId: string,
    commandPublicId: string,
  ): Promise<CloudCommand | null> {
    const command = parseExactCloudCommand(await this.#transport.query("commands:get", {
      commandPublicId,
    }));
    if (command !== null && command.sessionPublicId !== sessionPublicId) {
      throw new Error("Cloud command recovery changed its session authority.");
    }
    return command;
  }

  async #pullHeads(
    identity: ActiveCloudIdentity,
    heads: readonly CloudSessionHead[],
    signal: AbortSignal,
  ): Promise<readonly RemoteCloudSession[]> {
    const sessions: RemoteCloudSession[] = [];
    for (const head of heads) {
      abortBeforeEffect(signal);
      const metadata = head.metadata === undefined
        ? null
        : await decryptSessionMetadata(
          head.metadata,
          identity.accountKey,
          {
            entityPublicId: head.publicId,
            keyVersion: head.metadata.keyVersion,
            kind: "session_metadata",
            userPublicId: identity.userPublicId,
          },
        );
      const events: CompactSessionEvent[] = [];
      if (head.compactHeadSequence > 0) {
        abortBeforeEffect(signal);
        const chunksValue = await this.#transport.query("sessions:getLatestChunks", {
          limit: maximumChunksPerRemoteSession,
          sessionPublicId: head.publicId,
          stream: "compact",
        });
        abortBeforeEffect(signal);
        if (!Array.isArray(chunksValue) || chunksValue.length > maximumChunksPerRemoteSession) {
          throw new Error("Cloud session chunk response is invalid.");
        }
        if (chunksValue.length === 0) throw new Error("Cloud session latest-chunk response is empty.");
        let firstChunk: CloudSessionChunk | undefined;
        let previous: CloudSessionChunk | undefined;
        for (const value of chunksValue) {
          const chunk = parseSessionChunk(value);
          firstChunk ??= chunk;
          if (
            previous !== undefined
            && (
              chunk.streamEpoch < previous.streamEpoch
              ||
              chunk.firstSequence !== previous.lastSequence + 1
              || chunk.previousDigest !== previous.digest
            )
          ) throw new Error("Cloud session latest-chunk chain is not contiguous.");
          if (chunk.streamEpoch > head.compactStreamEpoch) {
            throw new Error("Cloud session chunk epoch exceeds its head.");
          }
          events.push(...await decryptCompactEvents(
            chunk.envelope,
            identity.accountKey,
            {
              firstSequence: chunk.firstSequence,
              keyVersion: chunk.envelope.keyVersion,
              lastSequence: chunk.lastSequence,
              ...(chunk.previousDigest === undefined
                ? {}
                : { previousDigest: chunk.previousDigest }),
              sessionPublicId: head.publicId,
              sourceBootId: chunk.authority.bootId,
              sourceDevicePublicId: chunk.sourceDevicePublicId,
              sourceFence: chunk.authority.fence,
              stream: "compact",
              userPublicId: identity.userPublicId,
            },
          ));
          previous = chunk;
        }
        if (
          previous?.lastSequence !== head.compactHeadSequence
          || previous.digest !== head.compactTailDigest
        ) throw new Error("Cloud session latest-chunk tail is inconsistent.");
        if (firstChunk?.firstSequence === 1 && firstChunk.previousDigest !== undefined) {
          throw new Error("Cloud session latest-chunk root is inconsistent.");
        }
      }
      const firstSequence = events[0]?.sequence;
      sessions.push({
        complete: !head.compactHasRecoveryGap
          && (head.compactHeadSequence === 0 || firstSequence === 1),
        events,
        executionDevicePublicId: head.executionDevicePublicId,
        metadata,
        publicId: head.publicId,
        ...(head.compactHasRecoveryGap
          ? {
              recoveryGap: {
                kind: "projection_cache_recovery" as const,
                streamEpoch: head.compactStreamEpoch,
              },
            }
          : {}),
        state: head.state,
        updatedAt: head.updatedAt,
      });
    }
    return sessions;
  }

  async #advanceLocalSessionCursor(
    expected: CloudSessionSyncCursorObservation,
    next: string | null,
  ): Promise<void> {
    let observed = expected;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (observed.state.localAfterPublicId === next) return;
      if (
        observed.state.localAfterPublicId
        !== expected.state.localAfterPublicId
      ) throw new Error("Local cloud session cursor changed concurrently.");
      const committed = await this.#sessionSyncCursor.compareAndSwap(
        observed.generation,
        { ...observed.state, localAfterPublicId: next },
      );
      if (committed !== null) return;
      observed = await this.#sessionSyncCursor.read();
    }
    throw new Error("Local cloud session cursor changed concurrently.");
  }

  async #advanceRemoteSessionCursor(
    expected: CloudSessionSyncCursorObservation,
    next: string | null,
  ): Promise<void> {
    let observed = expected;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (observed.state.remoteContinueCursor === null && next === null) return;
      if (
        observed.state.remoteContinueCursor
        !== expected.state.remoteContinueCursor
        || JSON.stringify(observed.state.remoteCycle)
          !== JSON.stringify(expected.state.remoteCycle)
      ) throw new Error("Remote cloud session cursor changed concurrently.");
      const advanced = advanceCloudSessionRemoteCursor(observed.state, next);
      const committed = await this.#sessionSyncCursor.compareAndSwap(
        observed.generation,
        advanced,
      );
      if (committed !== null) return;
      observed = await this.#sessionSyncCursor.read();
    }
    throw new Error("Remote cloud session cursor changed concurrently.");
  }

  async #mutateJournal(
    transform: (state: CloudDaemonJournalState) => CloudDaemonJournalState,
  ): Promise<Readonly<{ generation: number | null; state: CloudDaemonJournalState }>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.#assertDaemonCurrent();
      const current = await this.#journal.read();
      await this.#assertDaemonCurrent();
      const committed = await this.#journal.compareAndSwap(
        current.generation,
        transform(current.state),
      );
      await this.#assertDaemonCurrent();
      if (committed !== null) return committed;
    }
    throw new Error("Cloud daemon journal changed concurrently.");
  }

  async #addCommand(entry: CloudCommandJournalEntry): Promise<void> {
    await this.#mutateJournal((state) => addCloudCommandJournalEntry(state, entry));
  }

  async #addProjectionRecovery(entry: CloudProjectionRecoveryJournalEntry): Promise<void> {
    await this.#mutateJournal((state) =>
      addCloudProjectionRecovery(state, entry, this.#now()));
  }

  async #replaceProjectionRecovery(
    expected: CloudProjectionRecoveryJournalEntry,
    replacement: CloudProjectionRecoveryJournalEntry | CloudProjectionRecoveryTerminalReceipt,
  ): Promise<void> {
    await this.#mutateJournal((state) =>
      transitionCloudProjectionRecovery(state, expected, replacement, this.#now()));
  }

  async #replaceCommand(entry: CloudCommandJournalEntry): Promise<void> {
    await this.#mutateJournal((state) =>
      transitionCloudCommandJournalEntry(state, entry));
  }

  async #removeCommand(commandPublicId: string): Promise<void> {
    await this.#mutateJournal((state) => ({
      ...state,
      commands: state.commands.filter((entry) => entry.commandPublicId !== commandPublicId),
    }));
  }

  async #removeExactCommand(expected: CloudCommandJournalEntry): Promise<void> {
    await this.#mutateJournal((state) => {
      const current = state.commands.find((entry) =>
        entry.commandPublicId === expected.commandPublicId);
      if (current === undefined) return state;
      if (!sameCommandJournalEntry(current, expected)) {
        throw new Error("Cloud command journal changed concurrently.");
      }
      return {
        ...state,
        commands: state.commands.filter((entry) =>
          entry.commandPublicId !== expected.commandPublicId),
      };
    });
  }

  async #requireRegisteredIdentity(signal: AbortSignal): Promise<RegisteredCloudIdentity> {
    if (this.#identity.requireRegistered !== undefined) {
      return validateRegisteredIdentity(await this.#identity.requireRegistered(signal));
    }
    const activeIdentity = await this.#identity.requireActive(signal);
    return validateRegisteredIdentity({
      activeIdentity,
      authEpoch: 1,
      credentialGeneration: 1,
      devicePublicId: activeIdentity.devicePublicId,
      status: "active",
      userPublicId: activeIdentity.userPublicId,
    });
  }

  async #maintainPresence(
    identity: RegisteredCloudIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    let state = this.#presenceState;
    if (state === null || !samePresenceIdentity(state.identity, identity)) {
      state = {
        acknowledged: null,
        connectionId: validateConnectionUuid(this.#randomConnectionUuid()),
        identity: {
          authEpoch: identity.authEpoch,
          credentialGeneration: identity.credentialGeneration,
          devicePublicId: identity.devicePublicId,
          userPublicId: identity.userPublicId,
        },
        pending: null,
        response: null,
      };
      this.#presenceState = state;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (state.pending === null) {
        const sequence = state.acknowledged === null
          ? 0
          : state.acknowledged.sequence + 1;
        state.pending = await presenceRequest(
          identity,
          state.connectionId,
          sequence === 0 ? "connect" : "heartbeat",
          sequence,
        );
      }
      const request = state.pending;
      await this.#assertDaemonCurrent(signal);
      const value = await this.#transport.mutation(
        request.kind === "connect" ? "presence:connect" : "presence:heartbeat",
        {
          connectionId: request.connectionId,
          credentialGeneration: request.credentialGeneration,
          fingerprint: request.fingerprint,
          sequence: request.sequence,
        },
      );
      const response = parsePresenceResponse(value, request);
      await this.#assertDaemonCurrent(signal);
      state.acknowledged = request;
      state.pending = null;
      state.response = response;
      if (response.online && response.serverTtlMs >= minimumPresenceCycleTtlMs) return;
    }
    throw new Error("Cloud presence did not retain a full cycle of server TTL.");
  }

  async #disconnectPresenceBestEffort(): Promise<void> {
    const state = this.#presenceState;
    const requests = [state?.pending, state?.acknowledged].filter(
      (request, index, values): request is CloudPresenceRequest =>
        request !== null
        && request !== undefined
        && values.findIndex((candidate) =>
          candidate?.sequence === request.sequence
          && candidate.fingerprint === request.fingerprint) === index,
    );
    if (requests.length === 0) return;
    const attempt = Promise.resolve().then(async () => {
      for (const request of requests) {
        try {
          const value = await this.#transport.mutation("presence:disconnect", {
            connectionId: request.connectionId,
            credentialGeneration: request.credentialGeneration,
            fingerprint: request.fingerprint,
            sequence: request.sequence,
          });
          parsePresenceResponse(value, request, false);
          return;
        } catch {
          // The pending request may have failed before commit. In that case,
          // the last acknowledged request is the only exact disconnect proof.
        }
      }
    }).catch(() => undefined);
    let resolveDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve; });
    const timer = setTimeout(resolveDeadline, Math.min(this.#optionalSyncBudgetMs, 1_000));
    await Promise.race([attempt, deadline]);
    clearTimeout(timer);
  }

  async #assertDaemonCurrent(signal?: AbortSignal): Promise<void> {
    if (signal !== undefined) abortBeforeEffect(signal);
    await this.#deploymentAuthority.assertCurrent();
    await this.#daemonAuthorityFence.assertCurrent();
    if (signal !== undefined) abortBeforeEffect(signal);
  }

  async #mutation(name: CloudMutation, args: CloudArgs): Promise<unknown> {
    await this.#assertDaemonCurrent();
    return await this.#transport.mutation(name, args);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#tail.catch(() => undefined).then(operation);
    this.#tail = current;
    try {
      return await current;
    } finally {
      if (this.#tail === current) this.#tail = Promise.resolve();
    }
  }
}

export async function createLocalCloudDaemonBridgeFromEnvironment(
  options: LocalCloudDaemonBridgeEnvironmentOptions,
): Promise<LocalCloudDaemonBridge | null> {
  const selection: CloudDeploymentSelection = options.deploymentUrl === undefined
    ? cloudDeploymentSelectionFromEnvironment(options.environment)
    : {
        deploymentUrl: canonicalCloudDeploymentUrl(options.deploymentUrl),
        explicit: true,
        kind: "enabled",
      };
  if (selection.kind === "disabled") return null;
  const deploymentAuthority = options.deploymentAuthority
    ?? await acquireCloudDeploymentAuthority(options.secretCustody, selection);
  if (deploymentAuthority.deploymentUrl !== selection.deploymentUrl) {
    throw new CloudDeploymentAuthorityError(
      "target_mismatch",
      "Cloud deployment authority does not match the requested deployment.",
    );
  }
  await deploymentAuthority.assertCurrent();
  const deploymentUrl = selection.deploymentUrl;
  const deploymentCustody = new DeploymentScopedCloudSecretCustody(
    options.secretCustody,
    deploymentAuthority,
  );
  const identityCustody = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
  const fencedCustody = deploymentFencedSecretCustody(
    identityCustody,
    deploymentAuthority,
  );
  const accessToken = async (): Promise<string | null> => {
    await deploymentAuthority.assertCurrent();
    const token = (await readCustodyAuth(fencedCustody))?.token ?? null;
    await deploymentAuthority.assertCurrent();
    return token;
  };
  let transport: CloudTransport;
  if (options.transport !== undefined) {
    transport = deploymentFencedCloudTransport(options.transport, deploymentAuthority);
  } else {
    const rawTransport = createConvexCloudTransport({
      accessToken,
      deploymentUrl,
      ...(options.lifetimeSignal === undefined
        ? {}
        : { lifetimeSignal: options.lifetimeSignal }),
    });
    transport = deploymentFencedCloudTransport(rawTransport, deploymentAuthority);
  }
  /*
   * The push-wake socket presents the same custody token as the HTTP
   * transport and reads it through the same deployment fence, so a deployment
   * or identity change refuses the socket exactly as it refuses a request.
   * An injected transport (tests, in-memory harnesses) opens no socket.
   */
  const pushWake = options.pushWake === undefined
    ? options.transport === undefined
      ? createCloudPushWake({
        ...(options.lifetimeSignal === undefined
          ? {}
          : { lifetimeSignal: options.lifetimeSignal }),
        ...(options.now === undefined ? {} : { now: options.now }),
        subscribe: createConvexPushWakeSubscriber({
          accessToken,
          deploymentUrl,
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
      })
      : null
    : options.pushWake;
  const registration = options.registration ?? new LocalCloudControl({
    deploymentAuthority,
    deploymentUrl,
    ...(options.lifetimeSignal === undefined
      ? {}
      : { lifetimeSignal: options.lifetimeSignal }),
    ...(options.now === undefined ? {} : { now: options.now }),
    secretCustody: identityCustody,
    transport,
  });
  const identity = new CustodyCloudDaemonIdentity({
    custody: fencedCustody,
    ...(options.now === undefined ? {} : { now: options.now }),
    registration,
    transport,
  });
  try {
    return new LocalCloudDaemonBridge({
      daemonAuthority: options.daemonAuthority,
      daemonAuthorityFence: options.daemonAuthorityFence,
      deploymentAuthority,
      ...(options.deviceExecutor === undefined
        ? {}
        : { deviceExecutor: options.deviceExecutor }),
      executor: options.executor,
      identity,
      journal: options.journal ?? new CustodyCloudDaemonJournal(fencedCustody),
      ...(options.leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs: options.leaseDurationMs }),
      local: options.local,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(pushWake === null ? {} : { pushWake }),
      ...(options.randomConnectionUuid === undefined
        ? {}
        : { randomConnectionUuid: options.randomConnectionUuid }),
      ...(options.randomUuid === undefined ? {} : { randomUuid: options.randomUuid }),
      sessionSyncCursor: options.sessionSyncCursor
        ?? new CustodyCloudSessionSyncCursor(fencedCustody),
      transport,
    });
  } catch (error: unknown) {
    // An owned socket must never outlive a bridge that failed to construct.
    if (pushWake !== null && options.pushWake === undefined) {
      void pushWake.close().catch(() => undefined);
    }
    throw error;
  }
}
