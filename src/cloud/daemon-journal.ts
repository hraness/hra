import { createHash } from "node:crypto";

import {
  hasExactKeys,
  isCommandKind,
  isDeviceCommandKind,
  isDigest,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  parseAuthorityTuple,
  parseEncryptedEnvelope,
  type AuthorityTuple,
  type CommandKind,
  type DeviceCommandKind,
  type EncryptedEnvelope,
} from "./contracts";
import type { CloudSecretCustodyPort } from "./local-control";
import {
  compactInteractionDetailOf,
  isCompactInteractionBaselineShape,
  parseCompactSessionEvent,
  type CompactInteractionEvent,
} from "./projection";

const journalSlot = "cloud-daemon-journal";
// Session scan cursors are reconstructable read/projection progress. Keeping
// them in a separate bounded CAS slot prevents an opaque provider cursor from
// consuming the effect-recovery journal's reserved terminal capacity.
const sessionSyncCursorSlot = "cloud-session-sync-cursor";
const maximumJournalCommands = 100;
// Device commands are foreground requests from a browser, one or two at a
// time. A small ceiling keeps their worst-case terminal reservation from
// crowding the session-command journal it shares a slot with.
const maximumJournalDeviceCommands = 16;
const maximumJournalProjectionRecoveries = 25;
const maximumProjectionRecoveryBaselineTurns = 128;
const maximumProjectionRecoveryBaselineInteractions = 200;
const maximumSerializedJournalBytes = 65_536;
const maximumSerializedSessionSyncCursorBytes = 20_480;
const maximumRemoteSessionCursorCharacters = 16_384;
const utf8Encoder = new TextEncoder();
const remoteSessionCursorDigestPattern = /^[0-9a-f]{64}$/u;

export const cloudProjectionRecoveryWindowMs = 7 * 24 * 60 * 60 * 1_000;
export const providerDeletionProjectionRecoveryCode = "PROVIDER_THREAD_DELETED";
export const invalidIdempotencyProjectionRecoveryCode =
  "IDEMPOTENCY_AUTHORITY_INVALID_BEFORE_EFFECT";

function assertSerializedJournalBound(serialized: string): void {
  if (utf8Encoder.encode(serialized).byteLength > maximumSerializedJournalBytes) {
    throw new Error("Cloud daemon journal is corrupt.");
  }
}

function serializedJournalFits(serialized: string): boolean {
  return utf8Encoder.encode(serialized).byteLength <= maximumSerializedJournalBytes;
}

export type CloudCommandJournalEntry = Readonly<{
  authority: AuthorityTuple;
  commandPublicId: string;
  kind: CommandKind;
  localAuthorityDigest: string;
  payloadDigest: string;
  sessionPublicId: string;
}> & (
  | Readonly<{ phase: "prepared" }>
  | Readonly<{ phase: "effect_started" }>
  | Readonly<{
      phase: "terminal";
      resultCode: string;
      resultDigest: string;
      terminalState: "applied" | "failed" | "ambiguous";
    }>
);

/**
 * The device-command mirror of `CloudCommandJournalEntry`. It has no session
 * and no local session authority, so it binds the requesting device instead:
 * the durable record of "this browser asked this machine to do this, under this
 * boot authority, and the effect may already have begun".
 */
export type CloudDeviceCommandJournalEntry = Readonly<{
  authority: AuthorityTuple;
  commandPublicId: string;
  kind: DeviceCommandKind;
  payloadDigest: string;
  requestingDevicePublicId: string;
}> & (
  | Readonly<{ phase: "prepared" }>
  | Readonly<{ phase: "effect_started" }>
  | Readonly<{
      phase: "terminal";
      resultCode: string;
      resultDigest: string;
      terminalState: "applied" | "failed" | "ambiguous";
    }>
);

export type CloudUsageAccountCursor = Readonly<{
  accountPublicId: string;
  sourceGeneration: number;
  sourceRevision: number;
}>;

export type PendingCloudUsageAccount = Readonly<{
  accountPublicId: string;
  encryptedLocalReference: EncryptedEnvelope;
  encryptedMetadata: EncryptedEnvelope;
  idempotencyKey: string;
  matchKey: string;
  requestDigest: string;
  sourceGeneration: number;
  sourceRevision: number;
}>;

export type CloudProjectionRecoveryLocalAuthority = Readonly<{
  profileGeneration: number;
  profileId: string;
  providerUpdatedAt: number | null;
  providerThreadId: string;
  sessionRevision: number;
}>;

export type CloudProjectionRecoveryBaselineTurn = Readonly<{
  bodyDigest: string;
  turnId: string;
}>;

export type CloudProjectionRecoveryBaselineInteraction = Readonly<
  Omit<CompactInteractionEvent, "kind" | "sequence">
>;

export type CloudProjectionRecoveryAppliedResponse = Readonly<{
  boundaryHeadSequence: number;
  boundaryTailDigest: string;
  compactHasRecoveryGap: true;
  compactStreamEpoch: number;
  epochPublicId: string;
  projectionRevision: number;
  sessionPublicId: string;
}>;

export type CloudProjectionRecoveryIdentity =
  | Readonly<{
      sourceDevicePublicId: string;
      userPublicId: string;
    }>
  | Readonly<{
      sourceDevicePublicId: null;
      userPublicId: null;
    }>;

type CloudProjectionRecoveryBaseFields = Readonly<{
  authority: AuthorityTuple;
  baselineCompletedTurns: readonly CloudProjectionRecoveryBaselineTurn[];
  baselineInteractions?: readonly CloudProjectionRecoveryBaselineInteraction[];
  epochPublicId: string;
  expectedCompactStreamEpoch: number;
  expectedHeadSequence: number;
  expectedTailDigest: string;
  idempotencyKey: string;
  lineageCommitment: string;
  localAuthority: CloudProjectionRecoveryLocalAuthority;
  requestDigest: string;
  replacementCacheId: string;
  requestedAt: number;
  sessionPublicId: string;
  sourceCacheId: string | null;
}>;

type CloudProjectionRecoveryBase = CloudProjectionRecoveryBaseFields
  & CloudProjectionRecoveryIdentity;

type LegacyCloudProjectionRecoveryBase = Omit<
  CloudProjectionRecoveryBaseFields,
  "baselineInteractions"
>;

export type CloudProjectionRecoveryJournalEntry = CloudProjectionRecoveryBase & (
  | Readonly<{ phase: "prepared" | "effect_started" }>
  | Readonly<{
      cacheActivated: false;
      phase: "applied";
      response: CloudProjectionRecoveryAppliedResponse;
    }>
);

export type LegacyCloudProjectionRecoveryJournalEntry =
  LegacyCloudProjectionRecoveryBase & (
    | Readonly<{ phase: "prepared" | "effect_started" }>
    | Readonly<{
        cacheActivated: boolean;
        phase: "applied";
        response: CloudProjectionRecoveryAppliedResponse;
      }>
    | Readonly<{
        phase: "rejected";
        rejectionCode: string;
      }>
  );

export type CloudProjectionRecoveryTerminalReceipt =
  CloudProjectionRecoveryIdentity & Readonly<{
    idempotencyKey: string;
    requestedAt: number;
    sessionPublicId: string;
  }> & (
    | Readonly<{
        boundaryHeadSequence: number;
        compactHasRecoveryGap: true;
        compactStreamEpoch: number;
        phase: "applied";
        projectionRevision: number;
      }>
    | Readonly<{
        phase: "rejected";
        rejectionCode: string;
      }>
  );

export type CloudProjectionRecoveryReceiptResult =
  | Readonly<{
      boundaryHeadSequence: number;
      compactHasRecoveryGap: true;
      compactStreamEpoch: number;
      idempotencyKey: string;
      phase: "applied";
      projectionRevision: number;
      sessionPublicId: string;
    }>
  | Readonly<{
      idempotencyKey: string;
      phase: "rejected";
      rejectionCode: string;
      sessionPublicId: string;
    }>;

export type IdentityBoundCloudProjectionRecovery = (
  CloudProjectionRecoveryJournalEntry | CloudProjectionRecoveryTerminalReceipt
) & Readonly<{
  sourceDevicePublicId: string;
  userPublicId: string;
}>;

export type CloudDaemonJournalState = Readonly<{
  commands: readonly CloudCommandJournalEntry[];
  deviceCommands: readonly CloudDeviceCommandJournalEntry[];
  pendingUsageAccount: PendingCloudUsageAccount | null;
  projectionRecoveries: readonly CloudProjectionRecoveryJournalEntry[];
  projectionRecoveryReceipts: readonly CloudProjectionRecoveryTerminalReceipt[];
  usageAccounts: readonly CloudUsageAccountCursor[];
  version: 4;
}>;

export type LegacyCloudDaemonJournalV3State = Readonly<{
  commands: readonly CloudCommandJournalEntry[];
  pendingUsageAccount: PendingCloudUsageAccount | null;
  projectionRecoveries: readonly CloudProjectionRecoveryJournalEntry[];
  projectionRecoveryReceipts: readonly CloudProjectionRecoveryTerminalReceipt[];
  usageAccounts: readonly CloudUsageAccountCursor[];
  version: 3;
}>;

export type LegacyCloudDaemonJournalV1State = Readonly<{
  commands: readonly CloudCommandJournalEntry[];
  pendingUsageAccount: PendingCloudUsageAccount | null;
  usageAccounts: readonly CloudUsageAccountCursor[];
  version: 1;
}>;

export type LegacyCloudDaemonJournalV2State = Readonly<{
  commands: readonly CloudCommandJournalEntry[];
  pendingUsageAccount: PendingCloudUsageAccount | null;
  projectionRecoveries: readonly LegacyCloudProjectionRecoveryJournalEntry[];
  usageAccounts: readonly CloudUsageAccountCursor[];
  version: 2;
}>;

export type LegacyCloudDaemonJournalState = LegacyCloudDaemonJournalV1State;

export type CloudDaemonJournalInputState =
  | CloudDaemonJournalState
  | LegacyCloudDaemonJournalV1State
  | LegacyCloudDaemonJournalV2State
  | LegacyCloudDaemonJournalV3State;

export type CloudDaemonJournalObservation = Readonly<{
  generation: number | null;
  state: CloudDaemonJournalState;
}>;

export interface CloudDaemonJournalPort {
  read(): Promise<CloudDaemonJournalObservation>;
  compareAndSwap(
    expectedGeneration: number | null,
    state: CloudDaemonJournalInputState,
  ): Promise<CloudDaemonJournalObservation | null>;
}

export type CloudSessionRemoteCursorCycle = Readonly<{
  checkpointDigest: string;
  pageCount: number;
  power: number;
  span: number;
}>;

type LegacyCloudSessionSyncCursorState = Readonly<{
  localAfterPublicId: string | null;
  remoteContinueCursor: string | null;
  version: 1;
}>;

export type CloudSessionSyncCursorState = Readonly<{
  localAfterPublicId: string | null;
  remoteContinueCursor: string | null;
  remoteCycle: CloudSessionRemoteCursorCycle | null;
  version: 2;
}>;

export type CloudSessionSyncCursorObservation = Readonly<{
  generation: number | null;
  state: CloudSessionSyncCursorState;
}>;

export interface CloudSessionSyncCursorPort {
  read(): Promise<CloudSessionSyncCursorObservation>;
  compareAndSwap(
    expectedGeneration: number | null,
    state: CloudSessionSyncCursorState,
  ): Promise<CloudSessionSyncCursorObservation | null>;
}

export function emptyCloudSessionSyncCursor(): CloudSessionSyncCursorState {
  return {
    localAfterPublicId: null,
    remoteContinueCursor: null,
    remoteCycle: null,
    version: 2,
  };
}

const remoteSessionCursorDigest = (cursor: string): string =>
  createHash("sha256").update("hra-cloud-session-cursor\0").update(cursor).digest("hex");

const remoteSessionCursorBrentPower = (pageCount: number): number => {
  let power = 1;
  while (power <= Math.floor(pageCount / 2)) power *= 2;
  return power;
};

const validRemoteSessionCursor = (value: unknown): value is string =>
  typeof value === "string"
  && value.length >= 1
  && value.length <= maximumRemoteSessionCursorCharacters;

const initialRemoteSessionCursorCycle = (
  cursor: string,
): CloudSessionRemoteCursorCycle => ({
  checkpointDigest: remoteSessionCursorDigest(cursor),
  pageCount: 1,
  power: 1,
  span: 0,
});

const parseRemoteSessionCursorCycle = (
  value: unknown,
  cursor: string | null,
): CloudSessionRemoteCursorCycle | null => {
  if (cursor === null) {
    if (value !== null) throw new Error("Cloud session sync cursor is corrupt.");
    return null;
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["checkpointDigest", "pageCount", "power", "span"])
    || typeof value.checkpointDigest !== "string"
    || !remoteSessionCursorDigestPattern.test(value.checkpointDigest)
    || !isSafePositiveInteger(value.pageCount)
    || !isSafePositiveInteger(value.power)
    || !isSafeNonNegativeInteger(value.span)
  ) throw new Error("Cloud session sync cursor is corrupt.");
  const expectedPower = remoteSessionCursorBrentPower(value.pageCount);
  const currentDigest = remoteSessionCursorDigest(cursor);
  if (
    value.power !== expectedPower
    || value.span !== value.pageCount - expectedPower
    || (value.span === 0
      ? value.checkpointDigest !== currentDigest
      : value.checkpointDigest === currentDigest)
  ) throw new Error("Cloud session sync cursor is corrupt.");
  return {
    checkpointDigest: value.checkpointDigest,
    pageCount: value.pageCount,
    power: value.power,
    span: value.span,
  };
};

export function parseCloudSessionSyncCursor(
  value: unknown,
): CloudSessionSyncCursorState {
  if (
    isRecord(value)
    && hasExactKeys(value, [
      "localAfterPublicId",
      "remoteContinueCursor",
      "version",
    ])
    && value.version === 1
  ) {
    const legacy = value as LegacyCloudSessionSyncCursorState;
    if (
      (legacy.localAfterPublicId !== null
        && !isOpaqueIdentifier(legacy.localAfterPublicId))
      || (legacy.remoteContinueCursor !== null
        && !validRemoteSessionCursor(legacy.remoteContinueCursor))
    ) throw new Error("Cloud session sync cursor is corrupt.");
    return parseCloudSessionSyncCursor({
      localAfterPublicId: legacy.localAfterPublicId,
      remoteContinueCursor: legacy.remoteContinueCursor,
      remoteCycle: legacy.remoteContinueCursor === null
        ? null
        : initialRemoteSessionCursorCycle(legacy.remoteContinueCursor),
      version: 2,
    });
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "localAfterPublicId",
      "remoteContinueCursor",
      "remoteCycle",
      "version",
    ])
    || value.version !== 2
    || (value.localAfterPublicId !== null
      && !isOpaqueIdentifier(value.localAfterPublicId))
    || (value.remoteContinueCursor !== null
      && !validRemoteSessionCursor(value.remoteContinueCursor))
  ) throw new Error("Cloud session sync cursor is corrupt.");
  const remoteContinueCursor = value.remoteContinueCursor;
  const remoteCycle = parseRemoteSessionCursorCycle(
    value.remoteCycle,
    remoteContinueCursor,
  );
  const parsed: CloudSessionSyncCursorState = {
    localAfterPublicId: value.localAfterPublicId,
    remoteContinueCursor,
    remoteCycle,
    version: 2,
  };
  if (utf8Encoder.encode(JSON.stringify(parsed)).byteLength > maximumSerializedSessionSyncCursorBytes) {
    throw new Error("Cloud session sync cursor is corrupt.");
  }
  return parsed;
}

export function advanceCloudSessionRemoteCursor(
  state: CloudSessionSyncCursorState,
  next: string | null,
): CloudSessionSyncCursorState {
  const current = parseCloudSessionSyncCursor(state);
  if (next === null) {
    return parseCloudSessionSyncCursor({
      ...current,
      remoteContinueCursor: null,
      remoteCycle: null,
    });
  }
  if (!validRemoteSessionCursor(next)) {
    throw new Error("Cloud session page returned an invalid continuation cursor.");
  }
  if (current.remoteContinueCursor === null) {
    return parseCloudSessionSyncCursor({
      ...current,
      remoteContinueCursor: next,
      remoteCycle: initialRemoteSessionCursorCycle(next),
    });
  }
  const prior = current.remoteCycle;
  if (prior === null) throw new Error("Cloud session sync cursor is corrupt.");
  const digest = remoteSessionCursorDigest(next);
  if (
    next === current.remoteContinueCursor
    || digest === prior.checkpointDigest
  ) throw new Error("Cloud session pagination entered a deterministic cursor cycle.");
  if (prior.pageCount >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Cloud session pagination exhausted its safe page count.");
  }
  const pageCount = prior.pageCount + 1;
  let power = prior.power;
  let span = prior.span + 1;
  let checkpointDigest = prior.checkpointDigest;
  if (span === power) {
    checkpointDigest = digest;
    power *= 2;
    span = 0;
  }
  return parseCloudSessionSyncCursor({
    ...current,
    remoteContinueCursor: next,
    remoteCycle: { checkpointDigest, pageCount, power, span },
  });
}

export function emptyCloudDaemonJournal(): CloudDaemonJournalState {
  return {
    commands: [],
    deviceCommands: [],
    pendingUsageAccount: null,
    projectionRecoveries: [],
    projectionRecoveryReceipts: [],
    usageAccounts: [],
    version: 4,
  };
}

function maximumTerminalDeviceCommandEntry(
  entry: CloudDeviceCommandJournalEntry,
): CloudDeviceCommandJournalEntry {
  return parseDeviceCommand({
    ...entry,
    authority: {
      bootGeneration: Number.MAX_SAFE_INTEGER,
      bootId: "b".repeat(96),
      fence: Number.MAX_SAFE_INTEGER,
    },
    phase: "terminal",
    resultCode: "R".repeat(64),
    resultDigest: "f".repeat(64),
    terminalState: "ambiguous",
  });
}

function sameDeviceCommandBase(
  left: CloudDeviceCommandJournalEntry,
  right: CloudDeviceCommandJournalEntry,
): boolean {
  return left.commandPublicId === right.commandPublicId
    && left.kind === right.kind
    && left.payloadDigest === right.payloadDigest
    && left.requestingDevicePublicId === right.requestingDevicePublicId;
}

export function addCloudDeviceCommandJournalEntry(
  state: CloudDaemonJournalState,
  entry: CloudDeviceCommandJournalEntry,
): CloudDaemonJournalState {
  const canonical = parseCloudDaemonJournal(state);
  const canonicalEntry = parseDeviceCommand(entry);
  const current = canonical.deviceCommands.find((candidate) =>
    candidate.commandPublicId === canonicalEntry.commandPublicId);
  if (current !== undefined) {
    if (JSON.stringify(current) !== JSON.stringify(canonicalEntry)) {
      throw new Error("Cloud device command journal conflict.");
    }
    return canonical;
  }
  if (canonical.deviceCommands.length >= maximumJournalDeviceCommands) {
    throw new Error("Cloud device command journal is full.");
  }
  const next = parseCloudDaemonJournal({
    ...canonical,
    deviceCommands: [...canonical.deviceCommands, canonicalEntry],
  });
  assertCloudDaemonJournalFutureCapacity(next);
  return next;
}

export function transitionCloudDeviceCommandJournalEntry(
  state: CloudDaemonJournalState,
  replacement: CloudDeviceCommandJournalEntry,
): CloudDaemonJournalState {
  const canonical = parseCloudDaemonJournal(state);
  const canonicalReplacement = parseDeviceCommand(replacement);
  const index = canonical.deviceCommands.findIndex((candidate) =>
    candidate.commandPublicId === canonicalReplacement.commandPublicId);
  const current = canonical.deviceCommands[index];
  if (index < 0 || current === undefined) {
    throw new Error("Cloud device command journal entry is missing.");
  }
  if (JSON.stringify(current) === JSON.stringify(canonicalReplacement)) return canonical;
  if (
    !sameDeviceCommandBase(current, canonicalReplacement)
    || !(
      (current.phase === "prepared"
        && (canonicalReplacement.phase === "effect_started"
          || canonicalReplacement.phase === "terminal"))
      || (current.phase === "effect_started" && canonicalReplacement.phase === "terminal")
    )
    || (canonicalReplacement.phase === "effect_started"
      && JSON.stringify(current.authority) !== JSON.stringify(canonicalReplacement.authority))
  ) throw new Error("Cloud device command journal transition is invalid.");
  const deviceCommands = [...canonical.deviceCommands];
  deviceCommands[index] = canonicalReplacement;
  const next = parseCloudDaemonJournal({ ...canonical, deviceCommands });
  if (canonicalReplacement.phase !== "terminal") {
    assertCloudDaemonJournalFutureCapacity(next);
  }
  return next;
}

export function removeCloudDeviceCommandJournalEntry(
  state: CloudDaemonJournalState,
  commandPublicId: string,
): CloudDaemonJournalState {
  const canonical = parseCloudDaemonJournal(state);
  return parseCloudDaemonJournal({
    ...canonical,
    deviceCommands: canonical.deviceCommands.filter((entry) =>
      entry.commandPublicId !== commandPublicId),
  });
}

function maximumTerminalCommandEntry(
  entry: CloudCommandJournalEntry,
): CloudCommandJournalEntry {
  return parseCommand({
    ...entry,
    authority: {
      bootGeneration: Number.MAX_SAFE_INTEGER,
      bootId: "b".repeat(96),
      fence: Number.MAX_SAFE_INTEGER,
    },
    phase: "terminal",
    resultCode: "R".repeat(64),
    resultDigest: "f".repeat(64),
    terminalState: "ambiguous",
  });
}

function sameCommandBase(
  left: CloudCommandJournalEntry,
  right: CloudCommandJournalEntry,
): boolean {
  return left.commandPublicId === right.commandPublicId
    && left.kind === right.kind
    && left.localAuthorityDigest === right.localAuthorityDigest
    && left.payloadDigest === right.payloadDigest
    && left.sessionPublicId === right.sessionPublicId;
}

function assertCommandTerminalCapacity(
  state: CloudDaemonJournalState,
  entry: CloudCommandJournalEntry,
  replaceIndex?: number,
): void {
  const commands = [...state.commands];
  const terminal = maximumTerminalCommandEntry(entry);
  if (replaceIndex === undefined) commands.push(terminal);
  else commands[replaceIndex] = terminal;
  assertCloudDaemonJournalFutureCapacity({ ...state, commands });
}

export function assertCloudDaemonJournalFutureCapacity(
  state: CloudDaemonJournalState,
): CloudDaemonJournalState {
  const canonical = parseCloudDaemonJournal(state);
  const reserved = parseCloudDaemonJournal({
    ...canonical,
    commands: canonical.commands.map((entry) => entry.phase === "terminal"
      ? entry
      : maximumTerminalCommandEntry(entry)),
    deviceCommands: canonical.deviceCommands.map((entry) => entry.phase === "terminal"
      ? entry
      : maximumTerminalDeviceCommandEntry(entry)),
    projectionRecoveries: canonical.projectionRecoveries.map((entry) =>
      entry.phase === "applied"
        ? entry
        : projectionRecoveryAppliedCapacityEntry(entry)),
  });
  const pending = reserved.pendingUsageAccount;
  if (pending !== null) {
    parseCloudDaemonJournal({
      ...reserved,
      pendingUsageAccount: null,
      usageAccounts: [
        ...reserved.usageAccounts.filter((entry) =>
          entry.accountPublicId !== pending.accountPublicId),
        {
          accountPublicId: pending.accountPublicId,
          sourceGeneration: pending.sourceGeneration,
          sourceRevision: pending.sourceRevision,
        },
      ],
    });
  }
  return canonical;
}

export function addCloudCommandJournalEntry(
  state: CloudDaemonJournalState,
  entry: CloudCommandJournalEntry,
): CloudDaemonJournalState {
  const canonical = parseCloudDaemonJournal(state);
  const canonicalEntry = parseCommand(entry);
  const current = canonical.commands.find((candidate) =>
    candidate.commandPublicId === canonicalEntry.commandPublicId);
  if (current !== undefined) {
    if (JSON.stringify(current) !== JSON.stringify(canonicalEntry)) {
      throw new Error("Cloud command journal conflict.");
    }
    return canonical;
  }
  if (canonical.commands.length >= maximumJournalCommands) {
    throw new Error("Cloud command journal is full.");
  }
  assertCommandTerminalCapacity(canonical, canonicalEntry);
  const next = parseCloudDaemonJournal({
    ...canonical,
    commands: [...canonical.commands, canonicalEntry],
  });
  assertCloudDaemonJournalFutureCapacity(next);
  return next;
}

export function transitionCloudCommandJournalEntry(
  state: CloudDaemonJournalState,
  replacement: CloudCommandJournalEntry,
): CloudDaemonJournalState {
  const canonical = parseCloudDaemonJournal(state);
  const canonicalReplacement = parseCommand(replacement);
  const index = canonical.commands.findIndex((candidate) =>
    candidate.commandPublicId === canonicalReplacement.commandPublicId);
  const current = canonical.commands[index];
  if (index < 0 || current === undefined) {
    throw new Error("Cloud command journal entry is missing.");
  }
  if (JSON.stringify(current) === JSON.stringify(canonicalReplacement)) return canonical;
  if (
    !sameCommandBase(current, canonicalReplacement)
    || !(
      (current.phase === "prepared"
        && (canonicalReplacement.phase === "effect_started"
          || canonicalReplacement.phase === "terminal"))
      || (current.phase === "effect_started" && canonicalReplacement.phase === "terminal")
    )
    || (canonicalReplacement.phase === "effect_started"
      && JSON.stringify(current.authority) !== JSON.stringify(canonicalReplacement.authority))
  ) throw new Error("Cloud command journal transition is invalid.");
  if (canonicalReplacement.phase === "effect_started") {
    assertCommandTerminalCapacity(canonical, canonicalReplacement, index);
  }
  const commands = [...canonical.commands];
  commands[index] = canonicalReplacement;
  const next = parseCloudDaemonJournal({ ...canonical, commands });
  // A terminal transition records the outcome of an effect that may already
  // have happened. Legacy journals predate the global reserve invariant, so
  // cleanup must be allowed to make incremental progress as long as the exact
  // terminal state itself fits. New effect_started admission remains reserved
  // above, and new entries remain globally reserved in addCloudCommandJournalEntry.
  if (canonicalReplacement.phase !== "terminal") {
    assertCloudDaemonJournalFutureCapacity(next);
  }
  return next;
}

export function terminalizeUnreservedPreparedCloudCommands(
  state: CloudDaemonJournalState,
  outcome: Readonly<{
    resultCode: string;
    resultDigest: string;
  }>,
): CloudDaemonJournalState {
  const canonical = parseCloudDaemonJournal(state);
  if (
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(outcome.resultCode)
    || !isDigest(outcome.resultDigest)
  ) throw new Error("Cloud daemon journal is corrupt.");
  try {
    assertCloudDaemonJournalFutureCapacity(canonical);
    return canonical;
  } catch (error: unknown) {
    if (
      !(error instanceof Error)
      || error.message !== "Cloud daemon journal is corrupt."
    ) throw error;
  }

  const commands = canonical.commands.map((entry): CloudCommandJournalEntry =>
    entry.phase === "prepared"
      ? {
          ...entry,
          phase: "terminal",
          resultCode: outcome.resultCode,
          resultDigest: outcome.resultDigest,
          terminalState: "failed",
        }
      : entry);
  if (commands.every((entry, index) => entry === canonical.commands[index])) {
    return canonical;
  }

  // A migrated pre-reserve journal may be valid on disk while lacking room
  // for the worst-case terminal form of every prepared command. Convert the
  // entire unsafe cohort in one CAS. This retains every command's exact base
  // evidence and prevents a partial drain from making its successors appear
  // newly safe to execute.
  return parseCloudDaemonJournal({ ...canonical, commands });
}

export function completePendingCloudUsageAccount(
  state: CloudDaemonJournalState,
  expected: PendingCloudUsageAccount,
  sourceGeneration: number = expected.sourceGeneration,
  sourceRevision: number = expected.sourceRevision,
): CloudDaemonJournalState {
  const canonical = parseCloudDaemonJournal(state);
  const canonicalExpected = parsePendingUsageAccount(expected);
  if (
    canonicalExpected === null
    || canonical.pendingUsageAccount === null
    || JSON.stringify(canonical.pendingUsageAccount) !== JSON.stringify(canonicalExpected)
  ) throw new Error("Cloud usage account outbox changed concurrently.");
  if (
    !isSafePositiveInteger(sourceGeneration)
    || sourceGeneration < canonicalExpected.sourceGeneration
    || !isSafeNonNegativeInteger(sourceRevision)
    || sourceRevision < canonicalExpected.sourceRevision
  ) throw new Error("Cloud usage account cursor regressed.");

  const completed = {
    accountPublicId: canonicalExpected.accountPublicId,
    sourceGeneration,
    sourceRevision,
  };
  let usageAccounts = canonical.usageAccounts.filter((entry) =>
    entry.accountPublicId !== completed.accountPublicId);
  if (usageAccounts.length >= 100) {
    // Usage cursors are reconstructable from the exact server account binding.
    // Retire one deterministic cursor so a valid pre-reserve v1 outbox can be
    // acknowledged without deleting command/recovery evidence or replaying its
    // already-committed remote upsert.
    const retired = [...usageAccounts].sort((left, right) =>
      left.accountPublicId < right.accountPublicId
        ? -1
        : left.accountPublicId > right.accountPublicId ? 1 : 0)[0];
    if (retired === undefined) throw new Error("Cloud usage account cursor capacity is invalid.");
    usageAccounts = usageAccounts.filter((entry) =>
      entry.accountPublicId !== retired.accountPublicId);
  }
  return parseCloudDaemonJournal({
    ...canonical,
    pendingUsageAccount: null,
    usageAccounts: [...usageAccounts, completed],
  });
}

export function hasUnsettledCompactProjectionRecovery(
  state: CloudDaemonJournalState,
  sessionPublicId: string,
): boolean {
  if (!isOpaqueIdentifier(sessionPublicId)) {
    throw new Error("Cloud projection recovery session authority is invalid.");
  }
  return state.projectionRecoveries.some((entry) =>
    entry.sessionPublicId === sessionPublicId);
}

export function hasUnsettledCompactProjectionRecoveryForProfile(
  state: CloudDaemonJournalState,
  profileId: string,
): boolean {
  if (!isOpaqueIdentifier(profileId)) {
    throw new Error("Cloud projection recovery profile authority is invalid.");
  }
  return state.projectionRecoveries.some((entry) =>
    entry.localAuthority.profileId === profileId);
}

function assertProjectionRecoveryReceiptReadNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Cloud projection recovery receipt read was aborted.");
  }
}

export function supersedeCloudProjectionRecoveryForProviderDeletion(
  state: CloudDaemonJournalState,
  sessionPublicId: string,
  now: number,
): CloudDaemonJournalState {
  if (!isOpaqueIdentifier(sessionPublicId)) {
    throw new Error("Cloud projection recovery session authority is invalid.");
  }
  assertProjectionRecoveryNow(now);
  const canonical = pruneExpiredCloudProjectionRecoveryReceipts(state, now);
  const current = canonical.projectionRecoveries.find((entry) =>
    entry.sessionPublicId === sessionPublicId);
  if (current === undefined) return canonical;
  const receipt = parseCloudProjectionRecoveryTerminalReceipt({
    idempotencyKey: current.idempotencyKey,
    phase: "rejected",
    rejectionCode: providerDeletionProjectionRecoveryCode,
    requestedAt: Math.max(current.requestedAt, now),
    sessionPublicId: current.sessionPublicId,
    sourceDevicePublicId: current.sourceDevicePublicId,
    userPublicId: current.userPublicId,
  });
  return parseCloudDaemonJournal({
    ...canonical,
    projectionRecoveries: canonical.projectionRecoveries.filter((entry) =>
      entry.idempotencyKey !== current.idempotencyKey),
    projectionRecoveryReceipts: [...canonical.projectionRecoveryReceipts, receipt],
  });
}

/**
 * Read-only admission authority that remains available when cloud transport is not.
 * It never owns, clears, or advances recovery evidence.
 */
export class CloudDaemonJournalRecoveryBlocker {
  readonly #journal: CloudDaemonJournalPort;
  readonly #isSessionTerminal: ((sessionPublicId: string) => boolean | Promise<boolean>) | undefined;

  constructor(
    journal: CloudDaemonJournalPort,
    options: Readonly<{
      isSessionTerminal?: (sessionPublicId: string) => boolean | Promise<boolean>;
    }> = {},
  ) {
    this.#journal = journal;
    this.#isSessionTerminal = options.isSessionTerminal;
  }

  async isCompactProjectionRecoveryUnsettled(sessionPublicId: string): Promise<boolean> {
    const observed = await this.#journal.read();
    return hasUnsettledCompactProjectionRecovery(observed.state, sessionPublicId);
  }

  async isCompactProjectionRecoveryUnsettledForProfile(profileId: string): Promise<boolean> {
    const observed = await this.#journal.read();
    return hasUnsettledCompactProjectionRecoveryForProfile(observed.state, profileId);
  }

  async readCompactProjectionRecoveryReceipt(input: Readonly<{
    idempotencyKey: string;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<
    | Readonly<{ status: "absent" | "conflict" }>
    | Readonly<{ status: "found"; result: CloudProjectionRecoveryReceiptResult }>
  > {
    assertProjectionRecoveryReceiptReadNotAborted(input.signal);
    if (!isUuidV7(input.idempotencyKey) || !isOpaqueIdentifier(input.sessionPublicId)) {
      throw new Error("Cloud projection recovery receipt selector is invalid.");
    }
    const observed = await this.#journal.read();
    assertProjectionRecoveryReceiptReadNotAborted(input.signal);
    const receipt = observed.state.projectionRecoveryReceipts.find((entry) =>
      entry.idempotencyKey === input.idempotencyKey);
    if (receipt === undefined) return { status: "absent" };
    if (receipt.sessionPublicId !== input.sessionPublicId) return { status: "conflict" };
    return {
      result: cloudProjectionRecoveryReceiptResult(receipt),
      status: "found",
    };
  }

  async supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: string,
  ): Promise<{ superseded: boolean }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const observed = await this.#journal.read();
      const superseded = observed.state.projectionRecoveries.some((entry) =>
        entry.sessionPublicId === sessionPublicId);
      const next = supersedeCloudProjectionRecoveryForProviderDeletion(
        observed.state,
        sessionPublicId,
        Date.now(),
      );
      if (!superseded) return { superseded: false };
      const committed = await this.#journal.compareAndSwap(observed.generation, next);
      if (committed !== null) return { superseded: true };
    }
    throw new Error("Cloud projection recovery journal changed concurrently.");
  }

  async supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    if (this.#isSessionTerminal === undefined) return { superseded: 0 };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const observed = await this.#journal.read();
      const terminal: string[] = [];
      for (const entry of observed.state.projectionRecoveries) {
        if (await this.#isSessionTerminal(entry.sessionPublicId)) {
          terminal.push(entry.sessionPublicId);
        }
      }
      if (terminal.length === 0) return { superseded: 0 };
      const next = terminal.reduce(
        (state, sessionPublicId) => supersedeCloudProjectionRecoveryForProviderDeletion(
          state,
          sessionPublicId,
          Date.now(),
        ),
        observed.state,
      );
      const committed = await this.#journal.compareAndSwap(observed.generation, next);
      if (committed !== null) return { superseded: terminal.length };
    }
    throw new Error("Cloud projection recovery journal changed concurrently.");
  }
}

function parseCommandKind(value: unknown): CommandKind | null {
  return isCommandKind(value) ? value : null;
}

function parseDeviceCommand(value: unknown): CloudDeviceCommandJournalEntry {
  if (!isRecord(value)) throw new Error("Cloud daemon journal is corrupt.");
  const terminal = value.phase === "terminal";
  const expected = terminal
    ? [
        "authority",
        "commandPublicId",
        "kind",
        "payloadDigest",
        "phase",
        "requestingDevicePublicId",
        "resultCode",
        "resultDigest",
        "terminalState",
      ]
    : [
        "authority",
        "commandPublicId",
        "kind",
        "payloadDigest",
        "phase",
        "requestingDevicePublicId",
      ];
  const authority = parseAuthorityTuple(value.authority);
  if (
    !hasExactKeys(value, expected)
    || authority === null
    || !isUuidV7(value.commandPublicId)
    || !isDeviceCommandKind(value.kind)
    || !isDigest(value.payloadDigest)
    || (value.phase !== "prepared"
      && value.phase !== "effect_started"
      && value.phase !== "terminal")
    || !isOpaqueIdentifier(value.requestingDevicePublicId)
  ) throw new Error("Cloud daemon journal is corrupt.");
  const base = {
    authority,
    commandPublicId: value.commandPublicId,
    kind: value.kind,
    payloadDigest: value.payloadDigest,
    requestingDevicePublicId: value.requestingDevicePublicId,
  };
  if (value.phase !== "terminal") return { ...base, phase: value.phase };
  if (
    typeof value.resultCode !== "string"
    || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.resultCode)
    || !isDigest(value.resultDigest)
    || (value.terminalState !== "applied"
      && value.terminalState !== "failed"
      && value.terminalState !== "ambiguous")
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    ...base,
    phase: value.phase,
    resultCode: value.resultCode,
    resultDigest: value.resultDigest,
    terminalState: value.terminalState,
  };
}

function parseCommand(value: unknown): CloudCommandJournalEntry {
  if (!isRecord(value)) throw new Error("Cloud daemon journal is corrupt.");
  const terminal = value.phase === "terminal";
  const expected = terminal
    ? [
        "authority",
        "commandPublicId",
        "kind",
        "localAuthorityDigest",
        "payloadDigest",
        "phase",
        "resultCode",
        "resultDigest",
        "sessionPublicId",
        "terminalState",
      ]
    : [
        "authority",
        "commandPublicId",
        "kind",
        "localAuthorityDigest",
        "payloadDigest",
        "phase",
        "sessionPublicId",
      ];
  const authority = parseAuthorityTuple(value.authority);
  const kind = parseCommandKind(value.kind);
  if (
    !hasExactKeys(value, expected)
    || authority === null
    || !isUuidV7(value.commandPublicId)
    || kind === null
    || !isDigest(value.localAuthorityDigest)
    || !isDigest(value.payloadDigest)
    || (value.phase !== "prepared"
      && value.phase !== "effect_started"
      && value.phase !== "terminal")
    || !isOpaqueIdentifier(value.sessionPublicId)
  ) throw new Error("Cloud daemon journal is corrupt.");
  const base = {
    authority,
    commandPublicId: value.commandPublicId,
    kind,
    localAuthorityDigest: value.localAuthorityDigest,
    payloadDigest: value.payloadDigest,
    sessionPublicId: value.sessionPublicId,
  };
  if (value.phase !== "terminal") return { ...base, phase: value.phase };
  if (
    typeof value.resultCode !== "string"
    || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.resultCode)
    || !isDigest(value.resultDigest)
    || (value.terminalState !== "applied"
      && value.terminalState !== "failed"
      && value.terminalState !== "ambiguous")
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    ...base,
    phase: value.phase,
    resultCode: value.resultCode,
    resultDigest: value.resultDigest,
    terminalState: value.terminalState,
  };
}

function parseUsageCursor(value: unknown): CloudUsageAccountCursor {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["accountPublicId", "sourceGeneration", "sourceRevision"])
    || !isOpaqueIdentifier(value.accountPublicId)
    || !isSafePositiveInteger(value.sourceGeneration)
    || !isSafeNonNegativeInteger(value.sourceRevision)
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    accountPublicId: value.accountPublicId,
    sourceGeneration: value.sourceGeneration,
    sourceRevision: value.sourceRevision,
  };
}

function parsePendingUsageAccount(value: unknown): PendingCloudUsageAccount | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, [
    "accountPublicId",
    "encryptedLocalReference",
    "encryptedMetadata",
    "idempotencyKey",
    "matchKey",
    "requestDigest",
    "sourceGeneration",
    "sourceRevision",
  ])) throw new Error("Cloud daemon journal is corrupt.");
  const encryptedLocalReference = parseEncryptedEnvelope(value.encryptedLocalReference, 16_384);
  const encryptedMetadata = parseEncryptedEnvelope(value.encryptedMetadata, 16_384);
  if (
    !isOpaqueIdentifier(value.accountPublicId)
    || encryptedLocalReference === null
    || encryptedMetadata === null
    || !isUuidV7(value.idempotencyKey)
    || !isDigest(value.matchKey)
    || !isDigest(value.requestDigest)
    || !isSafePositiveInteger(value.sourceGeneration)
    || !isSafeNonNegativeInteger(value.sourceRevision)
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    accountPublicId: value.accountPublicId,
    encryptedLocalReference,
    encryptedMetadata,
    idempotencyKey: value.idempotencyKey,
    matchKey: value.matchKey,
    requestDigest: value.requestDigest,
    sourceGeneration: value.sourceGeneration,
    sourceRevision: value.sourceRevision,
  };
}

function parseProjectionRecoveryLocalAuthority(
  value: unknown,
): CloudProjectionRecoveryLocalAuthority {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "profileGeneration",
      "profileId",
      "providerThreadId",
      "providerUpdatedAt",
      "sessionRevision",
    ])
    || !isSafePositiveInteger(value.profileGeneration)
    || !isOpaqueIdentifier(value.profileId)
    || (value.providerUpdatedAt !== null && !isSafeNonNegativeInteger(value.providerUpdatedAt))
    || typeof value.providerThreadId !== "string"
    || value.providerThreadId.length < 1
    || value.providerThreadId.length > 320
    || /[\0\r\n]/u.test(value.providerThreadId)
    || !isSafePositiveInteger(value.sessionRevision)
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    profileGeneration: value.profileGeneration,
    profileId: value.profileId,
    providerUpdatedAt: value.providerUpdatedAt,
    providerThreadId: value.providerThreadId,
    sessionRevision: value.sessionRevision,
  };
}

function parseProjectionRecoveryBaselineTurn(
  value: unknown,
): CloudProjectionRecoveryBaselineTurn {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["bodyDigest", "turnId"])
    || !isDigest(value.bodyDigest)
    || !isOpaqueIdentifier(value.turnId)
  ) throw new Error("Cloud daemon journal is corrupt.");
  return { bodyDigest: value.bodyDigest, turnId: value.turnId };
}

function parseProjectionRecoveryBaselineInteraction(
  value: unknown,
): CloudProjectionRecoveryBaselineInteraction {
  if (!isCompactInteractionBaselineShape(value)) {
    throw new Error("Cloud daemon journal is corrupt.");
  }
  const parsed = parseCompactSessionEvent({
    ...value,
    kind: "interaction_state",
    sequence: 1,
  });
  if (parsed?.kind !== "interaction_state") {
    throw new Error("Cloud daemon journal is corrupt.");
  }
  return {
    ...compactInteractionDetailOf(parsed),
    blocking: parsed.blocking,
    interactionId: parsed.interactionId,
    interactionKind: parsed.interactionKind,
    revision: parsed.revision,
    state: parsed.state,
    summary: parsed.summary,
  };
}

function parseProjectionRecoveryAppliedResponse(
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
  ) throw new Error("Cloud daemon journal is corrupt.");
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

const legacyProjectionRecoveryBaseKeys = [
  "authority",
  "baselineCompletedTurns",
  "epochPublicId",
  "expectedCompactStreamEpoch",
  "expectedHeadSequence",
  "expectedTailDigest",
  "idempotencyKey",
  "lineageCommitment",
  "localAuthority",
  "phase",
  "requestDigest",
  "replacementCacheId",
  "requestedAt",
  "sessionPublicId",
  "sourceCacheId",
] as const;

const projectionRecoveryBaseKeys = [
  ...legacyProjectionRecoveryBaseKeys,
  "baselineInteractions",
  "sourceDevicePublicId",
  "userPublicId",
] as const;

const projectionRecoveryBaseKeysWithoutInteractions = [
  ...legacyProjectionRecoveryBaseKeys,
  "sourceDevicePublicId",
  "userPublicId",
] as const;

function parseProjectionRecoveryIdentity(
  value: Readonly<Record<string, unknown>>,
): CloudProjectionRecoveryIdentity {
  if (value.sourceDevicePublicId === null && value.userPublicId === null) {
    return { sourceDevicePublicId: null, userPublicId: null };
  }
  if (
    !isOpaqueIdentifier(value.sourceDevicePublicId)
    || !isOpaqueIdentifier(value.userPublicId)
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    sourceDevicePublicId: value.sourceDevicePublicId,
    userPublicId: value.userPublicId,
  };
}

function parseProjectionRecoveryBaseFields(
  value: Readonly<Record<string, unknown>>,
): CloudProjectionRecoveryBaseFields {
  if (
    !Array.isArray(value.baselineCompletedTurns)
    || value.baselineCompletedTurns.length > maximumProjectionRecoveryBaselineTurns
    || (value.baselineInteractions !== undefined
      && (!Array.isArray(value.baselineInteractions)
        || value.baselineInteractions.length > maximumProjectionRecoveryBaselineInteractions))
  ) throw new Error("Cloud daemon journal is corrupt.");
  const authority = parseAuthorityTuple(value.authority);
  const baselineCompletedTurns = value.baselineCompletedTurns.map(
    parseProjectionRecoveryBaselineTurn,
  );
  const baselineInteractions = value.baselineInteractions === undefined
    ? []
    : value.baselineInteractions.map(parseProjectionRecoveryBaselineInteraction);
  const localAuthority = parseProjectionRecoveryLocalAuthority(value.localAuthority);
  if (
    authority === null
    || !isUuidV7(value.epochPublicId)
    || !isSafeNonNegativeInteger(value.expectedCompactStreamEpoch)
    || !isSafePositiveInteger(value.expectedCompactStreamEpoch + 1)
    || !isSafePositiveInteger(value.expectedHeadSequence)
    || !isDigest(value.expectedTailDigest)
    || !isUuidV7(value.idempotencyKey)
    || !isDigest(value.lineageCommitment)
    || !isDigest(value.requestDigest)
    || !isOpaqueIdentifier(value.replacementCacheId)
    || !isSafeNonNegativeInteger(value.requestedAt)
    || !isOpaqueIdentifier(value.sessionPublicId)
    || (value.sourceCacheId !== null && !isOpaqueIdentifier(value.sourceCacheId))
    || new Set(baselineCompletedTurns.map((turn) => turn.turnId)).size
      !== baselineCompletedTurns.length
    || new Set(baselineInteractions.map((interaction) => interaction.interactionId)).size
      !== baselineInteractions.length
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    authority,
    baselineCompletedTurns,
    ...(value.baselineInteractions === undefined ? {} : { baselineInteractions }),
    epochPublicId: value.epochPublicId,
    expectedCompactStreamEpoch: value.expectedCompactStreamEpoch,
    expectedHeadSequence: value.expectedHeadSequence,
    expectedTailDigest: value.expectedTailDigest,
    idempotencyKey: value.idempotencyKey,
    lineageCommitment: value.lineageCommitment,
    localAuthority,
    requestDigest: value.requestDigest,
    replacementCacheId: value.replacementCacheId,
    requestedAt: value.requestedAt,
    sessionPublicId: value.sessionPublicId,
    sourceCacheId: value.sourceCacheId,
  };
}

export function parseCloudProjectionRecoveryEntry(
  value: unknown,
): CloudProjectionRecoveryJournalEntry {
  if (!isRecord(value)) throw new Error("Cloud daemon journal is corrupt.");
  const expectedKeys = value.phase === "applied"
    ? [...projectionRecoveryBaseKeys, "cacheActivated", "response"]
    : projectionRecoveryBaseKeys;
  const legacyExpectedKeys = value.phase === "applied"
    ? [...projectionRecoveryBaseKeysWithoutInteractions, "cacheActivated", "response"]
    : projectionRecoveryBaseKeysWithoutInteractions;
  if (
    (!hasExactKeys(value, expectedKeys) && !hasExactKeys(value, legacyExpectedKeys))
    || (value.phase !== "prepared"
      && value.phase !== "effect_started"
      && value.phase !== "applied")
  ) throw new Error("Cloud daemon journal is corrupt.");
  const base: CloudProjectionRecoveryBase = {
    ...parseProjectionRecoveryBaseFields(value),
    ...parseProjectionRecoveryIdentity(value),
  };
  if (value.phase === "prepared" || value.phase === "effect_started") {
    return { ...base, phase: value.phase };
  }
  const response = parseProjectionRecoveryAppliedResponse(value.response);
  if (
    value.cacheActivated !== false
    ||
    response.boundaryHeadSequence !== base.expectedHeadSequence
    || response.boundaryTailDigest !== base.expectedTailDigest
    || response.compactStreamEpoch !== base.expectedCompactStreamEpoch + 1
    || response.epochPublicId !== base.epochPublicId
    || response.sessionPublicId !== base.sessionPublicId
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    ...base,
    cacheActivated: value.cacheActivated,
    phase: value.phase,
    response,
  };
}

function parseLegacyCloudProjectionRecoveryEntry(
  value: unknown,
): LegacyCloudProjectionRecoveryJournalEntry {
  if (!isRecord(value)) throw new Error("Cloud daemon journal is corrupt.");
  const expectedKeys = value.phase === "applied"
    ? [...legacyProjectionRecoveryBaseKeys, "cacheActivated", "response"]
    : value.phase === "rejected"
      ? [...legacyProjectionRecoveryBaseKeys, "rejectionCode"]
      : legacyProjectionRecoveryBaseKeys;
  if (
    !hasExactKeys(value, expectedKeys)
    || (value.phase !== "prepared"
      && value.phase !== "effect_started"
      && value.phase !== "applied"
      && value.phase !== "rejected")
  ) throw new Error("Cloud daemon journal is corrupt.");
  const base = parseProjectionRecoveryBaseFields(value);
  if (value.phase === "prepared" || value.phase === "effect_started") {
    return { ...base, phase: value.phase };
  }
  if (value.phase === "rejected") {
    if (
      typeof value.rejectionCode !== "string"
      || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.rejectionCode)
    ) throw new Error("Cloud daemon journal is corrupt.");
    return { ...base, phase: value.phase, rejectionCode: value.rejectionCode };
  }
  const response = parseProjectionRecoveryAppliedResponse(value.response);
  if (
    typeof value.cacheActivated !== "boolean"
    || response.boundaryHeadSequence !== base.expectedHeadSequence
    || response.boundaryTailDigest !== base.expectedTailDigest
    || response.compactStreamEpoch !== base.expectedCompactStreamEpoch + 1
    || response.epochPublicId !== base.epochPublicId
    || response.sessionPublicId !== base.sessionPublicId
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    ...base,
    cacheActivated: value.cacheActivated,
    phase: value.phase,
    response,
  };
}

export function parseCloudProjectionRecoveryTerminalReceipt(
  value: unknown,
): CloudProjectionRecoveryTerminalReceipt {
  if (!isRecord(value)) throw new Error("Cloud daemon journal is corrupt.");
  const expectedKeys = value.phase === "applied"
    ? [
        "boundaryHeadSequence",
        "compactHasRecoveryGap",
        "compactStreamEpoch",
        "idempotencyKey",
        "phase",
        "projectionRevision",
        "requestedAt",
        "sessionPublicId",
        "sourceDevicePublicId",
        "userPublicId",
      ]
    : [
        "idempotencyKey",
        "phase",
        "rejectionCode",
        "requestedAt",
        "sessionPublicId",
        "sourceDevicePublicId",
        "userPublicId",
      ];
  if (
    !hasExactKeys(value, expectedKeys)
    || (value.phase !== "applied" && value.phase !== "rejected")
    || !isUuidV7(value.idempotencyKey)
    || !isSafeNonNegativeInteger(value.requestedAt)
    || !isOpaqueIdentifier(value.sessionPublicId)
  ) throw new Error("Cloud daemon journal is corrupt.");
  const base = {
    ...parseProjectionRecoveryIdentity(value),
    idempotencyKey: value.idempotencyKey,
    requestedAt: value.requestedAt,
    sessionPublicId: value.sessionPublicId,
  };
  if (value.phase === "rejected") {
    if (
      typeof value.rejectionCode !== "string"
      || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.rejectionCode)
    ) throw new Error("Cloud daemon journal is corrupt.");
    return { ...base, phase: value.phase, rejectionCode: value.rejectionCode };
  }
  if (
    !isSafePositiveInteger(value.boundaryHeadSequence)
    || value.compactHasRecoveryGap !== true
    || !isSafePositiveInteger(value.compactStreamEpoch)
    || !isSafePositiveInteger(value.projectionRevision)
  ) throw new Error("Cloud daemon journal is corrupt.");
  return {
    ...base,
    boundaryHeadSequence: value.boundaryHeadSequence,
    compactHasRecoveryGap: true,
    compactStreamEpoch: value.compactStreamEpoch,
    phase: value.phase,
    projectionRevision: value.projectionRevision,
  };
}

function sameAuthority(left: AuthorityTuple, right: AuthorityTuple): boolean {
  return left.bootGeneration === right.bootGeneration
    && left.bootId === right.bootId
    && left.fence === right.fence;
}

export function isIdentityBoundCloudProjectionRecovery(
  value: CloudProjectionRecoveryJournalEntry | CloudProjectionRecoveryTerminalReceipt,
): value is IdentityBoundCloudProjectionRecovery {
  return value.sourceDevicePublicId !== null;
}

export function matchesCloudProjectionRecoveryIdentity(
  value: CloudProjectionRecoveryJournalEntry | CloudProjectionRecoveryTerminalReceipt,
  userPublicId: string,
  sourceDevicePublicId: string,
): boolean {
  if (!isOpaqueIdentifier(userPublicId) || !isOpaqueIdentifier(sourceDevicePublicId)) {
    throw new Error("Cloud projection recovery identity authority is invalid.");
  }
  return isIdentityBoundCloudProjectionRecovery(value)
    && value.userPublicId === userPublicId
    && value.sourceDevicePublicId === sourceDevicePublicId;
}

export function cloudProjectionRecoveryReceiptResult(
  receipt: CloudProjectionRecoveryTerminalReceipt,
): CloudProjectionRecoveryReceiptResult {
  if (receipt.phase === "rejected") {
    return {
      idempotencyKey: receipt.idempotencyKey,
      phase: receipt.phase,
      rejectionCode: receipt.rejectionCode,
      sessionPublicId: receipt.sessionPublicId,
    };
  }
  return {
    boundaryHeadSequence: receipt.boundaryHeadSequence,
    compactHasRecoveryGap: true,
    compactStreamEpoch: receipt.compactStreamEpoch,
    idempotencyKey: receipt.idempotencyKey,
    phase: receipt.phase,
    projectionRevision: receipt.projectionRevision,
    sessionPublicId: receipt.sessionPublicId,
  };
}

function sameCloudProjectionRecoveryBase(
  left: CloudProjectionRecoveryJournalEntry,
  right: CloudProjectionRecoveryJournalEntry,
): boolean {
  return sameAuthority(left.authority, right.authority)
    && left.epochPublicId === right.epochPublicId
    && left.expectedCompactStreamEpoch === right.expectedCompactStreamEpoch
    && left.expectedHeadSequence === right.expectedHeadSequence
    && left.expectedTailDigest === right.expectedTailDigest
    && left.idempotencyKey === right.idempotencyKey
    && left.lineageCommitment === right.lineageCommitment
    && left.localAuthority.profileGeneration === right.localAuthority.profileGeneration
    && left.localAuthority.profileId === right.localAuthority.profileId
    && left.localAuthority.providerUpdatedAt === right.localAuthority.providerUpdatedAt
    && left.localAuthority.providerThreadId === right.localAuthority.providerThreadId
    && left.localAuthority.sessionRevision === right.localAuthority.sessionRevision
    && left.requestDigest === right.requestDigest
    && left.replacementCacheId === right.replacementCacheId
    && left.requestedAt === right.requestedAt
    && left.sessionPublicId === right.sessionPublicId
    && left.sourceDevicePublicId === right.sourceDevicePublicId
    && left.sourceCacheId === right.sourceCacheId
    && left.userPublicId === right.userPublicId
    && left.baselineCompletedTurns.length === right.baselineCompletedTurns.length
    && !left.baselineCompletedTurns.some((turn, index) => {
      const candidate = right.baselineCompletedTurns[index];
      return candidate === undefined
        || candidate.bodyDigest !== turn.bodyDigest
        || candidate.turnId !== turn.turnId;
    })
    && (left.baselineInteractions ?? []).length === (right.baselineInteractions ?? []).length
    && !(left.baselineInteractions ?? []).some((interaction, index) => {
      const candidate = (right.baselineInteractions ?? [])[index];
      return candidate === undefined
        || candidate.blocking !== interaction.blocking
        || candidate.interactionId !== interaction.interactionId
        || candidate.interactionKind !== interaction.interactionKind
        || candidate.revision !== interaction.revision
        || candidate.state !== interaction.state
        || candidate.summary !== interaction.summary;
    });
}

function samePreparedProjectionRecoveryRebindAuthority(
  left: CloudProjectionRecoveryJournalEntry,
  right: CloudProjectionRecoveryJournalEntry,
): boolean {
  if (left.phase !== "prepared" || right.phase !== "prepared") return false;
  if (
    sameAuthority(left.authority, right.authority)
    || left.lineageCommitment === right.lineageCommitment
    || left.requestDigest === right.requestDigest
  ) return false;
  return sameCloudProjectionRecoveryBase(left, {
    ...right,
    authority: left.authority,
    lineageCommitment: left.lineageCommitment,
    requestDigest: left.requestDigest,
  });
}

export function sameCloudProjectionRecoveryEntry(
  left: CloudProjectionRecoveryJournalEntry,
  right: CloudProjectionRecoveryJournalEntry,
): boolean {
  if (left.phase !== right.phase || !sameCloudProjectionRecoveryBase(left, right)) return false;
  if (left.phase === "applied") {
    return right.phase === "applied"
      && left.response.boundaryHeadSequence === right.response.boundaryHeadSequence
      && left.response.boundaryTailDigest === right.response.boundaryTailDigest
      && left.response.compactStreamEpoch === right.response.compactStreamEpoch
      && left.response.epochPublicId === right.response.epochPublicId
      && left.response.projectionRevision === right.response.projectionRevision
      && left.response.sessionPublicId === right.response.sessionPublicId;
  }
  return true;
}

export function sameCloudProjectionRecoveryTerminalReceipt(
  left: CloudProjectionRecoveryTerminalReceipt,
  right: CloudProjectionRecoveryTerminalReceipt,
): boolean {
  if (
    left.phase !== right.phase
    || left.idempotencyKey !== right.idempotencyKey
    || left.requestedAt !== right.requestedAt
    || left.sessionPublicId !== right.sessionPublicId
    || left.sourceDevicePublicId !== right.sourceDevicePublicId
    || left.userPublicId !== right.userPublicId
  ) return false;
  if (left.phase === "rejected") {
    return right.phase === "rejected" && left.rejectionCode === right.rejectionCode;
  }
  return right.phase === "applied"
    && left.boundaryHeadSequence === right.boundaryHeadSequence
    && left.compactStreamEpoch === right.compactStreamEpoch
    && left.projectionRevision === right.projectionRevision;
}

function migrateLegacyProjectionRecovery(
  entry: LegacyCloudProjectionRecoveryJournalEntry,
): CloudProjectionRecoveryJournalEntry | CloudProjectionRecoveryTerminalReceipt {
  const identity = { sourceDevicePublicId: null, userPublicId: null } as const;
  if (entry.phase === "rejected") {
    return {
      ...identity,
      idempotencyKey: entry.idempotencyKey,
      phase: entry.phase,
      rejectionCode: entry.rejectionCode,
      requestedAt: entry.requestedAt,
      sessionPublicId: entry.sessionPublicId,
    };
  }
  if (entry.phase === "applied" && entry.cacheActivated) {
    return {
      ...identity,
      boundaryHeadSequence: entry.response.boundaryHeadSequence,
      compactHasRecoveryGap: true,
      compactStreamEpoch: entry.response.compactStreamEpoch,
      idempotencyKey: entry.idempotencyKey,
      phase: entry.phase,
      projectionRevision: entry.response.projectionRevision,
      requestedAt: entry.requestedAt,
      sessionPublicId: entry.sessionPublicId,
    };
  }
  if (entry.phase === "applied") {
    return {
      ...entry,
      ...identity,
      cacheActivated: false,
    };
  }
  return { ...entry, ...identity };
}

function journalExactKeys(version: 1 | 2 | 3 | 4): readonly string[] {
  if (version === 1) return ["commands", "pendingUsageAccount", "usageAccounts", "version"];
  if (version === 2) {
    return [
      "commands",
      "pendingUsageAccount",
      "projectionRecoveries",
      "usageAccounts",
      "version",
    ];
  }
  const three = [
    "commands",
    "pendingUsageAccount",
    "projectionRecoveries",
    "projectionRecoveryReceipts",
    "usageAccounts",
    "version",
  ];
  return version === 3 ? three : ["deviceCommands", ...three];
}

function parseCloudDaemonJournalStructure(value: unknown): CloudDaemonJournalState {
  if (
    !isRecord(value)
    || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4)
    || !hasExactKeys(value, journalExactKeys(value.version))
    || !Array.isArray(value.commands)
    || value.commands.length > maximumJournalCommands
    || !Array.isArray(value.usageAccounts)
    || value.usageAccounts.length > 100
  ) throw new Error("Cloud daemon journal is corrupt.");
  const commands = value.commands.map(parseCommand);
  let deviceCommands: readonly CloudDeviceCommandJournalEntry[] = [];
  if (value.version === 4) {
    if (
      !Array.isArray(value.deviceCommands)
      || value.deviceCommands.length > maximumJournalDeviceCommands
    ) throw new Error("Cloud daemon journal is corrupt.");
    deviceCommands = value.deviceCommands.map(parseDeviceCommand);
  }
  let projectionRecoveries: readonly CloudProjectionRecoveryJournalEntry[] = [];
  let projectionRecoveryReceipts: readonly CloudProjectionRecoveryTerminalReceipt[] = [];
  if (value.version === 3 || value.version === 4) {
    if (
      !Array.isArray(value.projectionRecoveries)
      || value.projectionRecoveries.length > maximumJournalProjectionRecoveries
      || !Array.isArray(value.projectionRecoveryReceipts)
    ) throw new Error("Cloud daemon journal is corrupt.");
    projectionRecoveries = value.projectionRecoveries.map(
      parseCloudProjectionRecoveryEntry,
    );
    projectionRecoveryReceipts = value.projectionRecoveryReceipts.map(
      parseCloudProjectionRecoveryTerminalReceipt,
    );
  } else if (value.version === 2) {
    if (
      !Array.isArray(value.projectionRecoveries)
      || value.projectionRecoveries.length > maximumJournalProjectionRecoveries
    ) throw new Error("Cloud daemon journal is corrupt.");
    const migrated = value.projectionRecoveries
      .map(parseLegacyCloudProjectionRecoveryEntry)
      .map(migrateLegacyProjectionRecovery);
    projectionRecoveries = migrated.filter(
      (entry): entry is CloudProjectionRecoveryJournalEntry =>
        entry.phase === "prepared"
        || entry.phase === "effect_started"
        || (entry.phase === "applied" && "cacheActivated" in entry),
    );
    projectionRecoveryReceipts = migrated.filter(
      (entry): entry is CloudProjectionRecoveryTerminalReceipt =>
        entry.phase === "rejected"
        || (entry.phase === "applied" && !("cacheActivated" in entry)),
    );
  }
  const usageAccounts = value.usageAccounts.map(parseUsageCursor);
  const recoveryIdempotencyKeys = [
    ...projectionRecoveries.map((entry) => entry.idempotencyKey),
    ...projectionRecoveryReceipts.map((entry) => entry.idempotencyKey),
  ];
  if (
    new Set(commands.map((entry) => entry.commandPublicId)).size !== commands.length
    || new Set(deviceCommands.map((entry) => entry.commandPublicId)).size
      !== deviceCommands.length
    || new Set(projectionRecoveries.map((entry) => entry.epochPublicId)).size
      !== projectionRecoveries.length
    || new Set(recoveryIdempotencyKeys).size !== recoveryIdempotencyKeys.length
    || new Set(projectionRecoveries.map((entry) => entry.sessionPublicId)).size
      !== projectionRecoveries.length
    || new Set(usageAccounts.map((entry) => entry.accountPublicId)).size !== usageAccounts.length
  ) throw new Error("Cloud daemon journal is corrupt.");
  const parsed: CloudDaemonJournalState = {
    commands,
    deviceCommands,
    pendingUsageAccount: parsePendingUsageAccount(value.pendingUsageAccount),
    projectionRecoveries,
    projectionRecoveryReceipts,
    usageAccounts,
    version: 4,
  };
  return parsed;
}

function legacyProjectionRecoveryForStorage(
  entry: CloudProjectionRecoveryJournalEntry,
): LegacyCloudProjectionRecoveryJournalEntry | null {
  if (entry.userPublicId !== null || (entry.baselineInteractions ?? []).length > 0) return null;
  return Object.fromEntries(Object.entries(entry).filter(([key]) =>
    key !== "baselineInteractions"
    && key !== "sourceDevicePublicId"
    && key !== "userPublicId")) as
    LegacyCloudProjectionRecoveryJournalEntry;
}

function serializeCloudDaemonJournalForCustody(state: CloudDaemonJournalState): string {
  const canonical = JSON.stringify(state);
  if (serializedJournalFits(canonical)) return canonical;

  // Every shrinking fallback drops the device-command array, so it can only be
  // taken while that array is empty. A journal holding device-command evidence
  // is never silently downgraded to a version that cannot carry it.
  if (state.deviceCommands.length > 0) throw new Error("Cloud daemon journal is corrupt.");

  const legacyV3: LegacyCloudDaemonJournalV3State = {
    commands: state.commands,
    pendingUsageAccount: state.pendingUsageAccount,
    projectionRecoveries: state.projectionRecoveries,
    projectionRecoveryReceipts: state.projectionRecoveryReceipts,
    usageAccounts: state.usageAccounts,
    version: 3,
  };
  const serializedV3 = JSON.stringify(legacyV3);
  if (serializedJournalFits(serializedV3)) return serializedV3;

  if (
    state.projectionRecoveries.length === 0
    && state.projectionRecoveryReceipts.length === 0
  ) {
    const legacyV1: LegacyCloudDaemonJournalV1State = {
      commands: state.commands,
      pendingUsageAccount: state.pendingUsageAccount,
      usageAccounts: state.usageAccounts,
      version: 1,
    };
    const serialized = JSON.stringify(legacyV1);
    if (serializedJournalFits(serialized)) return serialized;
  }

  if (state.projectionRecoveryReceipts.length === 0) {
    const legacyRecoveries = state.projectionRecoveries.map(
      legacyProjectionRecoveryForStorage,
    );
    if (legacyRecoveries.every(
      (entry): entry is LegacyCloudProjectionRecoveryJournalEntry => entry !== null,
    )) {
      const legacyV2: LegacyCloudDaemonJournalV2State = {
        commands: state.commands,
        pendingUsageAccount: state.pendingUsageAccount,
        projectionRecoveries: legacyRecoveries,
        usageAccounts: state.usageAccounts,
        version: 2,
      };
      const serialized = JSON.stringify(legacyV2);
      if (serializedJournalFits(serialized)) return serialized;
    }
  }

  throw new Error("Cloud daemon journal is corrupt.");
}

export function parseCloudDaemonJournal(value: unknown): CloudDaemonJournalState {
  const parsed = parseCloudDaemonJournalStructure(value);
  serializeCloudDaemonJournalForCustody(parsed);
  return parsed;
}

function uuidV7Timestamp(value: string): number | null {
  if (!isUuidV7(value)) return null;
  const timestamp = Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function assertProjectionRecoveryNow(now: number): void {
  if (!isSafeNonNegativeInteger(now)) {
    throw new Error("Cloud projection recovery journal time is invalid.");
  }
}

function projectionRecoveryAuthorityIsExpired(
  requestedAt: number,
  idempotencyKey: string,
  now: number,
): boolean {
  const idempotencyTimestamp = uuidV7Timestamp(idempotencyKey);
  const cutoff = now - cloudProjectionRecoveryWindowMs;
  return idempotencyTimestamp !== null
    && requestedAt < cutoff
    && idempotencyTimestamp < cutoff;
}

export function pruneExpiredCloudProjectionRecoveryReceipts(
  state: CloudDaemonJournalState,
  now: number,
): CloudDaemonJournalState {
  assertProjectionRecoveryNow(now);
  const canonical = parseCloudDaemonJournal(state);
  const projectionRecoveryReceipts = canonical.projectionRecoveryReceipts.filter((receipt) =>
    !projectionRecoveryAuthorityIsExpired(
      receipt.requestedAt,
      receipt.idempotencyKey,
      now,
    ));
  if (projectionRecoveryReceipts.length === canonical.projectionRecoveryReceipts.length) {
    return canonical;
  }
  return parseCloudDaemonJournal({
    ...canonical,
    projectionRecoveryReceipts,
  });
}

export function createCloudProjectionRecoveryTerminalReceipt(
  entry: CloudProjectionRecoveryJournalEntry,
  outcome: Readonly<{ phase: "applied" }>
    | Readonly<{ phase: "rejected"; rejectionCode: string }>,
): CloudProjectionRecoveryTerminalReceipt {
  if (!isIdentityBoundCloudProjectionRecovery(entry)) {
    throw new Error("Cloud projection recovery identity is unbound.");
  }
  const base = {
    idempotencyKey: entry.idempotencyKey,
    requestedAt: entry.requestedAt,
    sessionPublicId: entry.sessionPublicId,
    sourceDevicePublicId: entry.sourceDevicePublicId,
    userPublicId: entry.userPublicId,
  };
  if (outcome.phase === "rejected") {
    if (
      entry.phase !== "effect_started"
      && !(
        entry.phase === "prepared"
        && outcome.rejectionCode === invalidIdempotencyProjectionRecoveryCode
      )
    ) {
      throw new Error("Cloud projection recovery terminal transition is invalid.");
    }
    return parseCloudProjectionRecoveryTerminalReceipt({
      ...base,
      phase: outcome.phase,
      rejectionCode: outcome.rejectionCode,
    });
  }
  if (entry.phase !== "applied") {
    throw new Error("Cloud projection recovery terminal transition is invalid.");
  }
  return parseCloudProjectionRecoveryTerminalReceipt({
    ...base,
    boundaryHeadSequence: entry.response.boundaryHeadSequence,
    compactHasRecoveryGap: true,
    compactStreamEpoch: entry.response.compactStreamEpoch,
    phase: outcome.phase,
    projectionRevision: entry.response.projectionRevision,
  });
}

function projectionRecoveryAppliedCapacityEntry(
  entry: CloudProjectionRecoveryJournalEntry,
): CloudProjectionRecoveryJournalEntry {
  return parseCloudProjectionRecoveryEntry({
    ...entry,
    cacheActivated: false,
    phase: "applied",
    response: {
      boundaryHeadSequence: entry.expectedHeadSequence,
      boundaryTailDigest: entry.expectedTailDigest,
      compactHasRecoveryGap: true,
      compactStreamEpoch: entry.expectedCompactStreamEpoch + 1,
      epochPublicId: entry.epochPublicId,
      projectionRevision: Number.MAX_SAFE_INTEGER,
      sessionPublicId: entry.sessionPublicId,
    },
  });
}

function assertProjectionRecoveryAppliedCapacity(
  state: CloudDaemonJournalState,
  entry: CloudProjectionRecoveryJournalEntry,
): void {
  assertCloudDaemonJournalFutureCapacity({
    ...state,
    projectionRecoveries: [
      ...state.projectionRecoveries,
      projectionRecoveryAppliedCapacityEntry(entry),
    ],
  });
}

export function addCloudProjectionRecovery(
  state: CloudDaemonJournalState,
  entry: CloudProjectionRecoveryJournalEntry,
  now: number,
): CloudDaemonJournalState {
  assertProjectionRecoveryNow(now);
  const canonicalEntry = parseCloudProjectionRecoveryEntry(entry);
  if (!isIdentityBoundCloudProjectionRecovery(canonicalEntry)) {
    throw new Error("Cloud projection recovery identity is unbound.");
  }
  const idempotencyTimestamp = uuidV7Timestamp(canonicalEntry.idempotencyKey);
  const cutoff = now - cloudProjectionRecoveryWindowMs;
  if (
    idempotencyTimestamp === null
    || canonicalEntry.requestedAt < cutoff
    || idempotencyTimestamp < cutoff
  ) throw new Error("Cloud projection recovery idempotency authority is expired.");
  const canonical = pruneExpiredCloudProjectionRecoveryReceipts(state, now);
  const current = canonical.projectionRecoveries.find((candidate) =>
    candidate.idempotencyKey === canonicalEntry.idempotencyKey);
  if (current !== undefined) {
    if (!sameCloudProjectionRecoveryEntry(current, canonicalEntry)) {
      throw new Error("Cloud projection recovery journal conflict.");
    }
    return canonical;
  }
  if (canonical.projectionRecoveryReceipts.some((receipt) =>
    receipt.idempotencyKey === canonicalEntry.idempotencyKey)) {
    throw new Error("Cloud projection recovery journal conflict.");
  }
  if (canonical.projectionRecoveries.length >= maximumJournalProjectionRecoveries) {
    throw new Error("Cloud projection recovery journal is full.");
  }
  if (canonical.projectionRecoveries.some((candidate) =>
    candidate.sessionPublicId === canonicalEntry.sessionPublicId)) {
    throw new Error("Another cloud projection recovery is unsettled for this session.");
  }
  // Admission reserves the largest valid response representation before the
  // remote epoch mutation can begin. A prepared/effect_started journal must
  // therefore always have enough durable custody capacity to record the
  // applied response after an indeterminate transport outcome.
  assertProjectionRecoveryAppliedCapacity(canonical, canonicalEntry);
  const next = parseCloudDaemonJournal({
    ...canonical,
    projectionRecoveries: [...canonical.projectionRecoveries, canonicalEntry],
  });
  assertCloudDaemonJournalFutureCapacity(next);
  return next;
}

function parseProjectionRecoveryTransition(
  value: CloudProjectionRecoveryJournalEntry | CloudProjectionRecoveryTerminalReceipt,
): CloudProjectionRecoveryJournalEntry | CloudProjectionRecoveryTerminalReceipt {
  return value.phase === "rejected"
    || (value.phase === "applied" && !("cacheActivated" in value))
    ? parseCloudProjectionRecoveryTerminalReceipt(value)
    : parseCloudProjectionRecoveryEntry(value);
}

function sameProjectionRecoveryTransitionAuthority(
  entry: CloudProjectionRecoveryJournalEntry,
  receipt: CloudProjectionRecoveryTerminalReceipt,
): boolean {
  return entry.idempotencyKey === receipt.idempotencyKey
    && entry.requestedAt === receipt.requestedAt
    && entry.sessionPublicId === receipt.sessionPublicId
    && entry.sourceDevicePublicId === receipt.sourceDevicePublicId
    && entry.userPublicId === receipt.userPublicId;
}

export function transitionCloudProjectionRecovery(
  state: CloudDaemonJournalState,
  expected: CloudProjectionRecoveryJournalEntry,
  replacement: CloudProjectionRecoveryJournalEntry | CloudProjectionRecoveryTerminalReceipt,
  now: number,
): CloudDaemonJournalState {
  assertProjectionRecoveryNow(now);
  const canonicalExpected = parseCloudProjectionRecoveryEntry(expected);
  const canonicalReplacement = parseProjectionRecoveryTransition(replacement);
  if (
    !isIdentityBoundCloudProjectionRecovery(canonicalExpected)
    || !isIdentityBoundCloudProjectionRecovery(canonicalReplacement)
  ) throw new Error("Cloud projection recovery identity is unbound.");
  const canonical = pruneExpiredCloudProjectionRecoveryReceipts(state, now);
  const index = canonical.projectionRecoveries.findIndex((entry) =>
    entry.idempotencyKey === canonicalExpected.idempotencyKey);
  const current = canonical.projectionRecoveries[index];
  if (
    index < 0
    || current === undefined
    || !sameCloudProjectionRecoveryEntry(current, canonicalExpected)
  ) throw new Error("Cloud projection recovery journal changed concurrently.");

  const projectionRecoveries = [...canonical.projectionRecoveries];
  let projectionRecoveryReceipts = canonical.projectionRecoveryReceipts;
  const expectedIdempotencyTimestamp = uuidV7Timestamp(canonicalExpected.idempotencyKey);
  const expectedIdempotencyExpired = expectedIdempotencyTimestamp !== null
    && expectedIdempotencyTimestamp < now - cloudProjectionRecoveryWindowMs;
  if ("localAuthority" in canonicalReplacement) {
    const advancesPhase = sameCloudProjectionRecoveryBase(
      canonicalExpected,
      canonicalReplacement,
    ) && (
        (canonicalExpected.phase === "prepared"
          && canonicalReplacement.phase === "effect_started")
        || (canonicalExpected.phase === "effect_started"
          && canonicalReplacement.phase === "applied")
      );
    const rebindsPreparedAuthority = samePreparedProjectionRecoveryRebindAuthority(
      canonicalExpected,
      canonicalReplacement,
    ) && !expectedIdempotencyExpired;
    if (!advancesPhase && !rebindsPreparedAuthority) {
      throw new Error("Cloud projection recovery terminal transition is invalid.");
    }
    projectionRecoveries[index] = canonicalReplacement;
  } else {
    if (
      !sameProjectionRecoveryTransitionAuthority(canonicalExpected, canonicalReplacement)
      || !(
        (canonicalExpected.phase === "effect_started"
          && canonicalReplacement.phase === "rejected")
        || (canonicalExpected.phase === "prepared"
          && canonicalReplacement.phase === "rejected"
          && canonicalReplacement.rejectionCode
            === invalidIdempotencyProjectionRecoveryCode
          && expectedIdempotencyExpired)
        || (canonicalExpected.phase === "applied"
          && canonicalReplacement.phase === "applied"
          && canonicalExpected.response.boundaryHeadSequence
            === canonicalReplacement.boundaryHeadSequence
          && canonicalExpected.response.compactStreamEpoch
            === canonicalReplacement.compactStreamEpoch
          && canonicalExpected.response.projectionRevision
            === canonicalReplacement.projectionRevision)
      )
    ) throw new Error("Cloud projection recovery terminal transition is invalid.");
    projectionRecoveries.splice(index, 1);
    const retainedReceipt = parseCloudProjectionRecoveryTerminalReceipt({
      ...canonicalReplacement,
      // A recovery can remain active beyond the original UUID window while
      // an exact immutable server lineage is reconciled. Start the compact
      // local replay-retention window when terminal evidence is durably
      // recorded so a crash after this CAS cannot erase the only local result.
      requestedAt: Math.max(canonicalReplacement.requestedAt, now),
    });
    projectionRecoveryReceipts = [
      ...projectionRecoveryReceipts,
      retainedReceipt,
    ];
  }
  const next = parseCloudDaemonJournal({
    ...canonical,
    projectionRecoveries,
    projectionRecoveryReceipts,
  });
  if ("localAuthority" in canonicalReplacement) {
    assertCloudDaemonJournalFutureCapacity(next);
  }
  return next;
}

export class CustodyCloudDaemonJournal implements CloudDaemonJournalPort {
  readonly #custody: CloudSecretCustodyPort;

  constructor(custody: CloudSecretCustodyPort) {
    this.#custody = custody;
  }

  async read(): Promise<CloudDaemonJournalObservation> {
    const observation = await this.#custody.read(journalSlot);
    if (observation === null) {
      return { generation: null, state: emptyCloudDaemonJournal() };
    }
    assertSerializedJournalBound(observation.value);
    let decoded: unknown;
    try {
      decoded = JSON.parse(observation.value) as unknown;
    } catch {
      throw new Error("Cloud daemon journal is corrupt.");
    }
    return {
      generation: observation.generation,
      state: parseCloudDaemonJournal(decoded),
    };
  }

  async compareAndSwap(
    expectedGeneration: number | null,
    state: CloudDaemonJournalInputState,
  ): Promise<CloudDaemonJournalObservation | null> {
    const parsed = parseCloudDaemonJournal(state);
    const serialized = serializeCloudDaemonJournalForCustody(parsed);
    const committed = await this.#custody.compareAndSwap(
      journalSlot,
      expectedGeneration,
      serialized,
    );
    return committed === null
      ? null
      : { generation: committed.generation, state: parsed };
  }
}

export class MemoryCloudDaemonJournal implements CloudDaemonJournalPort {
  #generation: number | null = null;
  #state: CloudDaemonJournalState = emptyCloudDaemonJournal();

  async read(): Promise<CloudDaemonJournalObservation> {
    return { generation: this.#generation, state: structuredClone(this.#state) };
  }

  async compareAndSwap(
    expectedGeneration: number | null,
    state: CloudDaemonJournalInputState,
  ): Promise<CloudDaemonJournalObservation | null> {
    if (expectedGeneration !== this.#generation) return null;
    this.#state = structuredClone(parseCloudDaemonJournal(state));
    this.#generation = this.#generation === null ? 0 : this.#generation + 1;
    return { generation: this.#generation, state: structuredClone(this.#state) };
  }
}

export class CustodyCloudSessionSyncCursor implements CloudSessionSyncCursorPort {
  readonly #custody: CloudSecretCustodyPort;

  constructor(custody: CloudSecretCustodyPort) {
    this.#custody = custody;
  }

  async read(): Promise<CloudSessionSyncCursorObservation> {
    const observation = await this.#custody.read(sessionSyncCursorSlot);
    if (observation === null) {
      return { generation: null, state: emptyCloudSessionSyncCursor() };
    }
    if (
      utf8Encoder.encode(observation.value).byteLength
      > maximumSerializedSessionSyncCursorBytes
    ) throw new Error("Cloud session sync cursor is corrupt.");
    let decoded: unknown;
    try {
      decoded = JSON.parse(observation.value) as unknown;
    } catch {
      throw new Error("Cloud session sync cursor is corrupt.");
    }
    return {
      generation: observation.generation,
      state: parseCloudSessionSyncCursor(decoded),
    };
  }

  async compareAndSwap(
    expectedGeneration: number | null,
    state: CloudSessionSyncCursorState,
  ): Promise<CloudSessionSyncCursorObservation | null> {
    const parsed = parseCloudSessionSyncCursor(state);
    const serialized = JSON.stringify(parsed);
    const committed = await this.#custody.compareAndSwap(
      sessionSyncCursorSlot,
      expectedGeneration,
      serialized,
    );
    return committed === null
      ? null
      : { generation: committed.generation, state: parsed };
  }
}

export class MemoryCloudSessionSyncCursor implements CloudSessionSyncCursorPort {
  #generation: number | null = null;
  #state = emptyCloudSessionSyncCursor();

  async read(): Promise<CloudSessionSyncCursorObservation> {
    return { generation: this.#generation, state: structuredClone(this.#state) };
  }

  async compareAndSwap(
    expectedGeneration: number | null,
    state: CloudSessionSyncCursorState,
  ): Promise<CloudSessionSyncCursorObservation | null> {
    if (expectedGeneration !== this.#generation) return null;
    this.#state = structuredClone(parseCloudSessionSyncCursor(state));
    this.#generation = this.#generation === null ? 0 : this.#generation + 1;
    return { generation: this.#generation, state: structuredClone(this.#state) };
  }
}
