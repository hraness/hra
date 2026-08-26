import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { parseAccountUsage, parseRateLimits, type RateLimitSnapshot } from "../codex/protocol";
import type { LocalCommand } from "../domain/contracts";
import type { InteractionRecord } from "../domain/interactions";
import { providerUsagePayload } from "../domain/usage-metrics";
import { sessionIdSchema } from "../domain/values";
import type {
  CodexRuntimePort,
  CodexSessionProjection,
  CloudControlPort,
  ProfileAuthority,
} from "../daemon/ports";
import { profilePaths, type StatePaths } from "../storage/paths";
import type {
  InteractionListPosition,
  ProfileRecord,
  SessionRecord,
  StateStore,
} from "../storage/state-store";
import {
  cloudLimits,
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  hasExactKeys,
  isDigest,
  isOpaqueIdentifier,
  isRecord,
  isUuidV7,
  redactAbsolutePaths,
  type AuthorityTuple,
} from "./contracts";
import type { CloudProjectionRecoveryBaselineInteraction } from "./daemon-journal";
import type {
  CloudCommandExecutionResult,
  CloudCommandExecutorPort,
  CloudDaemonBridge,
  CloudDaemonLocalSourcePort,
  CloudLocalCommandAuthority,
  CloudLocalSessionHead,
  CloudLocalSessionPage,
  CloudLocalUsageSnapshot,
} from "./daemon-bridge";
import type {
  CloudRemoteCommandReceipt,
  CloudRemoteCommandStatus,
  CloudRemoteControlPort,
  CloudRemoteSessionHead,
  CloudRemoteSessionProjection,
  CloudRemoteSessionSelector,
} from "./local-control";
import {
  isProjectRelativePath,
  parseCompactSessionEvents,
  type CompactSessionEvent,
  type GitAction,
} from "./projection";
import {
  parseUsageProjection,
  USAGE_CLOUD_PROJECTION_MAX_DAILY_ROWS,
  USAGE_CLOUD_PROJECTION_MAX_LIMITS,
  type UsageLimit,
  type UsageProjection,
  type UsageWindow,
} from "./usage";

const maximumCachedTurnBytes = 1_048_576;
const maximumProjectionReadBytes = cloudLimits.detailChunkBytes;
const projectionCacheFileName = "cloud-projection.sqlite";
const projectionSidecarSuffixes = ["", "-journal", "-shm", "-wal"] as const;
const maximumProjectionRecoveryBaselineInteractions = 200;
const maximumProjectionRecoveryStatusSessions = 20;

type ProviderRemoteLocalCommand = Extract<LocalCommand, Readonly<{
  kind: "session.send" | "session.queue" | "session.steer" | "session.stop" | "session.rename" | "session.preset" | "session.fast";
}>>;

type LocalExecuteRemote = (
  command: ProviderRemoteLocalCommand,
  expected: Readonly<{
    processGeneration: number;
    profileId: ProfileRecord["id"];
    providerThreadId: string;
    sessionId: SessionRecord["id"];
  }>,
  options: Readonly<{ signal: AbortSignal }>,
) => Promise<unknown>;

type CompactSessionEventBody =
  | Readonly<{ kind: "user_message" | "assistant_message"; text: string; turnId: string }>
  | Readonly<{
      blocking: boolean;
      interactionId: string;
      interactionKind: InteractionRecord["kind"];
      kind: "interaction_state";
      revision: number;
      state: InteractionRecord["state"];
      summary: string;
    }>
  | Readonly<{
      fast?: boolean;
      filesTouched: readonly string[];
      gitActions: readonly GitAction[];
      kind: "turn_summary";
      model?: "low" | "high" | "ultra";
      runtimeMs: number;
      turnId: string;
    }>;

type ProjectionSequenceRow = Readonly<{
  interaction_discovery_cursor: string | null;
  interaction_scan_ceiling_sequence: number;
  interaction_scan_sequence: number;
  next_sequence: number;
  stream_epoch: number;
}>;

type ProjectionBaselineRow = Readonly<{
  digest: string;
}>;

type ProjectionStoredTurnRow = Readonly<{
  digest: string;
  event_count: number;
  events_json: string;
  start_sequence: number;
  turn_id: string;
}>;

type VerifiedProjectionTurnRow = ProjectionStoredTurnRow & Readonly<{
  events: readonly CompactSessionEvent[];
}>;

type ProjectionIndexedInteractionRow = ProjectionStoredTurnRow & Readonly<{
  interaction_id: string;
}>;

type ValidatedProjectionLedger = Readonly<{
  committedHead: number;
  interactionDiscoveryCursor: InteractionListPosition | null;
  interactionScanCeilingSequence: number;
  interactionScanSequence: number;
  localHead: number;
}>;

type ProjectionLedgerValidationMemo = Readonly<{
  firstSequence: number | null;
  localHead: number;
  streamEpoch: number;
}>;

type ProjectionCheckpointRow = Readonly<{
  head_sequence: number;
  pending_expected_head: number | null;
  pending_expected_tail: string | null;
  pending_head: number | null;
  pending_tail: string | null;
  stream_epoch: number;
  tail_digest: string | null;
}>;

type ProjectionFileIdentity = Readonly<{
  device: number;
  inode: number;
}>;

type CompactUploadCheckpoint = Readonly<{
  cacheId: string;
  digest: string;
  expectedHeadSequence: number;
  expectedStreamEpoch: number;
  expectedTailDigest?: string;
  headSequence: number;
  sessionPublicId: string;
}>;

function validProjectionRemoteHead(
  headSequence: number,
  tailDigest: string | undefined,
  streamEpoch: number,
): boolean {
  return Number.isSafeInteger(headSequence)
    && headSequence >= 0
    && Number.isSafeInteger(streamEpoch)
    && streamEpoch >= 0
    && (headSequence === 0 ? tailDigest === undefined : isDigest(tailDigest))
    && (streamEpoch === 0 || headSequence > 0);
}

function validCompactUploadCheckpoint(input: CompactUploadCheckpoint): boolean {
  return isOpaqueIdentifier(input.cacheId)
    && isOpaqueIdentifier(input.sessionPublicId)
    && validProjectionRemoteHead(
      input.expectedHeadSequence,
      input.expectedTailDigest,
      input.expectedStreamEpoch,
    )
    && Number.isSafeInteger(input.headSequence)
    && input.headSequence > input.expectedHeadSequence
    && isDigest(input.digest);
}

function encodeInteractionListPosition(value: InteractionListPosition): string {
  return JSON.stringify({ publicId: value.publicId, requestedAt: value.requestedAt });
}

function parseInteractionListPosition(
  value: string | null,
): InteractionListPosition | null {
  if (value === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new ProjectionStreamRecoveryError();
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, ["publicId", "requestedAt"])
    || typeof decoded.publicId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(decoded.publicId)
    || decoded.publicId !== decoded.publicId.toLowerCase()
    || !Number.isSafeInteger(decoded.requestedAt)
    || (decoded.requestedAt as number) < 0
  ) throw new ProjectionStreamRecoveryError();
  return {
    publicId: decoded.publicId,
    requestedAt: decoded.requestedAt as number,
  };
}

function sameInteractionListPosition(
  left: InteractionListPosition | null,
  right: InteractionListPosition | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.requestedAt === right.requestedAt
      && left.publicId === right.publicId;
}

export type CompactProjectionBaseline = Readonly<{
  bodyDigest: string;
  turnId: string;
}>;

export type CompactProjectionLocalAuthority = Readonly<{
  profileGeneration: number;
  profileId: string;
  providerUpdatedAt: number | null;
  providerThreadId: string;
  sessionRevision: number;
}>;

export type CompactProjectionRecoveryPlan = Readonly<{
  baselineCompletedTurns: readonly CompactProjectionBaseline[];
  baselineInteractions: readonly CloudProjectionRecoveryBaselineInteraction[];
  localAuthority: CompactProjectionLocalAuthority;
  sessionPublicId: string;
}>;

export type CompactProjectionRecoveryInstallation = CompactProjectionRecoveryPlan & Readonly<{
  boundaryHeadSequence: number;
  boundaryTailDigest: string;
  compactStreamEpoch: number;
  idempotencyKey: string;
  replacementCacheId: string;
}>;

class ProjectionStreamRecoveryError extends Error {
  constructor() {
    super("Cloud transcript upload is paused because the durable local projection ledger does not match the exact remote head and tail. Restoring this stream requires an explicit, potentially history-discarding reseed.");
    this.name = "ProjectionStreamRecoveryError";
  }
}

function assertSafeProjectionFile(path: string): ProjectionFileIdentity {
  const pathMetadata = lstatSync(path);
  if (pathMetadata.isSymbolicLink()) {
    throw new Error("The cloud projection cache cannot be a symbolic link.");
  }
  if (!pathMetadata.isFile()) {
    throw new Error("The cloud projection cache has unsafe filesystem authority.");
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const metadata = fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (
      metadata.dev !== pathMetadata.dev
      || metadata.ino !== pathMetadata.ino
      || !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== currentUid
      || (metadata.mode & 0o077) !== 0
    ) throw new Error("The cloud projection cache has unsafe filesystem authority.");
    return { device: metadata.dev, inode: metadata.ino };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function sameProjectionFileIdentity(
  left: ProjectionFileIdentity,
  right: ProjectionFileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertProjectionFileIdentity(
  path: string,
  expected: ProjectionFileIdentity,
): ProjectionFileIdentity {
  const current = assertSafeProjectionFile(path);
  if (!sameProjectionFileIdentity(current, expected)) {
    throw new Error("Cloud projection recovery cache pathname changed.");
  }
  return current;
}

function readProjectionBytes(
  descriptor: number,
  byteLength: number,
  position: number,
): Buffer {
  const value = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const read = readSync(
      descriptor,
      value,
      offset,
      byteLength - offset,
      position + offset,
    );
    if (read === 0) throw new Error("The cloud projection cache is truncated.");
    offset += read;
  }
  return value;
}

function projectionPageSize(header: Buffer): number {
  const encoded = header.readUInt16BE(16);
  const pageSize = encoded === 1 ? 65_536 : encoded;
  if (
    pageSize < 512
    || pageSize > 65_536
    || (pageSize & (pageSize - 1)) !== 0
  ) throw new Error("The cloud projection cache header is invalid.");
  return pageSize;
}

function observeProjectionUserVersion(path: string): number {
  const identity = assertSafeProjectionFile(path);
  let descriptor: number | null = null;
  let pageSize = 0;
  let observedVersion = 0;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (metadata.size !== 0) {
      if (metadata.size < 100) throw new Error("The cloud projection cache header is invalid.");
      const header = readProjectionBytes(descriptor, 100, 0);
      if (!header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
        throw new Error("The cloud projection cache header is invalid.");
      }
      pageSize = projectionPageSize(header);
      observedVersion = header.readUInt32BE(60);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  assertProjectionFileIdentity(path, identity);

  const walPath = `${path}-wal`;
  if (!existsSync(walPath)) return observedVersion;
  const walIdentity = assertSafeProjectionFile(walPath);
  descriptor = null;
  try {
    descriptor = openSync(walPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (metadata.size !== 0) {
      if (metadata.size < 32 || pageSize === 0) {
        throw new Error("The cloud projection cache WAL is invalid.");
      }
      const header = readProjectionBytes(descriptor, 32, 0);
      const magic = header.readUInt32BE(0);
      if (
        (magic !== 0x377f0682 && magic !== 0x377f0683)
        || header.readUInt32BE(8) !== pageSize
      ) throw new Error("The cloud projection cache WAL is invalid.");
      const frameBytes = 24 + pageSize;
      const frameCount = Math.floor((metadata.size - 32) / frameBytes);
      if (frameCount > 8_192) {
        throw new Error("The cloud projection cache WAL exceeds the observation bound.");
      }
      for (let index = 0; index < frameCount; index += 1) {
        const frameOffset = 32 + index * frameBytes;
        const frameHeader = readProjectionBytes(descriptor, 4, frameOffset);
        if (frameHeader.readUInt32BE(0) !== 1) continue;
        const version = readProjectionBytes(descriptor, 4, frameOffset + 24 + 60)
          .readUInt32BE(0);
        if (version > observedVersion) observedVersion = version;
      }
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  assertProjectionFileIdentity(path, identity);
  assertProjectionFileIdentity(walPath, walIdentity);
  return observedVersion;
}

function syncProjectionDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (!metadata.isDirectory() || metadata.uid !== currentUid) {
      throw new Error("The cloud projection cache directory has unsafe filesystem authority.");
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function recoveryCacheId(idempotencyKey: string): string {
  return `cache_${sha256(`projection-recovery:${idempotencyKey}`).slice(0, 48)}`;
}

function recoveryStagingPath(
  root: string,
  cacheFileName: string,
  idempotencyKey: string,
): string {
  return join(root, `${cacheFileName}.recovery-${idempotencyKey}`);
}

function recoveryQuarantinePath(
  root: string,
  cacheFileName: string,
  idempotencyKey: string,
): string {
  return join(root, `${cacheFileName}.quarantine-${idempotencyKey}`);
}

function authorityFor(paths: StatePaths, profileId: Parameters<typeof profilePaths>[1], generation: number): ProfileAuthority {
  const owned = profilePaths(paths, profileId);
  return {
    id: profileId,
    generation,
    codexHome: owned.codexHome,
    desktopUserData: owned.desktopUserData,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function rethrowWhenAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function boundedProjectionRecoveryError(error: unknown): Error {
  const message = boundedText(
    error instanceof Error ? error.message : "Cloud projection recovery failed.",
    512,
  );
  return new Error(message.length === 0
    ? "Cloud projection recovery failed at a bounded local boundary."
    : message);
}

function redactSecretShapes(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu, "[cloud projection secret omitted]")
    .replace(/\b(?:sk|re)_[A-Za-z0-9_-]{8,}/gu, "[cloud projection secret omitted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{8,}/gu, "[cloud projection secret omitted]");
}

function boundedText(value: string, maximumCharacters: number): string {
  const bounded = value.length <= maximumCharacters
    ? value
    : `${value.slice(0, Math.max(0, maximumCharacters - 26))}\n[cloud projection truncated]`;
  const sanitized = redactAbsolutePaths(redactSecretShapes(bounded));
  return containsAbsolutePath(sanitized)
    ? "[cloud projection omitted text containing a local absolute path]"
    : containsUnsafeTerminalScalar(sanitized, true)
      ? Array.from(sanitized).map((scalar) => scalar === "\n" || !containsUnsafeTerminalScalar(scalar)
          ? scalar
          : `\\u{${scalar.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}}`).join("")
      : sanitized;
}

function boundedUtf8Text(value: string, maximumBytes: number): string {
  if (utf8Bytes(value) <= maximumBytes) return value;
  const marker = "\n[cloud projection truncated]";
  const markerBytes = utf8Bytes(marker);
  const characters: string[] = [];
  for (const scalar of value) characters.push(scalar);
  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (utf8Bytes(characters.slice(0, middle).join("")) + markerBytes <= maximumBytes) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return `${characters.slice(0, lower).join("")}${marker}`;
}

function boundedNote(value: string): string | null {
  if (value.length === 0) return null;
  return boundedUtf8Text(boundedText(value, 8_000), 10_000);
}

function boundedName(value: string): string {
  const name = boundedText(value, 160).trim();
  return name.length === 0 ? "Untitled session" : name;
}

function compactInteractionSummary(kind: InteractionRecord["kind"]): string {
  switch (kind) {
    case "command_approval": return "Codex requests command approval";
    case "file_change_approval": return "Codex requests file-change approval";
    case "permission_approval": return "Codex requests additional permissions";
    case "user_input": return "Codex needs user input";
    case "mcp_elicitation": return "An MCP server requests protected form input";
  }
}

function recoveryInteractionBody(
  interaction: CloudProjectionRecoveryBaselineInteraction,
): CompactSessionEventBody {
  return {
    blocking: interaction.blocking,
    interactionId: interaction.interactionId,
    interactionKind: interaction.interactionKind,
    kind: "interaction_state",
    revision: interaction.revision,
    state: interaction.state,
    summary: interaction.summary,
  };
}

function recoveryInteractionTurnId(
  interaction: CloudProjectionRecoveryBaselineInteraction,
): string {
  return `hraix_${sha256(`${interaction.interactionId}:${String(interaction.revision)}`)}`;
}

function parseRecoveryBaselineInteractions(
  value: unknown,
): readonly CloudProjectionRecoveryBaselineInteraction[] {
  if (
    !Array.isArray(value)
    || value.length > maximumProjectionRecoveryBaselineInteractions
  ) throw new Error("Invalid cloud projection recovery interaction baseline.");
  const parsed = value.map((candidate) => {
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, [
        "blocking",
        "interactionId",
        "interactionKind",
        "revision",
        "state",
        "summary",
      ])
    ) throw new Error("Invalid cloud projection recovery interaction baseline.");
    const [event] = parseCompactSessionEvents([{
      ...candidate,
      kind: "interaction_state",
      sequence: 1,
    }]) ?? [];
    if (event?.kind !== "interaction_state") {
      throw new Error("Invalid cloud projection recovery interaction baseline.");
    }
    return {
      blocking: event.blocking,
      interactionId: event.interactionId,
      interactionKind: event.interactionKind,
      revision: event.revision,
      state: event.state,
      summary: event.summary,
    };
  });
  if (new Set(parsed.map((interaction) => interaction.interactionId)).size !== parsed.length) {
    throw new Error("Invalid cloud projection recovery interaction baseline.");
  }
  return parsed;
}

function parseRecoveryObservedInteractionIds(value: unknown): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > maximumProjectionRecoveryBaselineInteractions
  ) throw new Error("Cloud projection recovery input is invalid.");
  const candidates: readonly unknown[] = value;
  const parsed = candidates.map((candidate) => {
    if (typeof candidate !== "string") {
      throw new Error("Cloud projection recovery input is invalid.");
    }
    return candidate;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new Error("Cloud projection recovery input is invalid.");
  }
  return parsed;
}

function terminalSessionState(session: SessionRecord): "active" | "idle" | "terminal" | null {
  if (session.state === "active") return "active";
  if (session.state === "idle") return "idle";
  if (session.state === "terminal") return "terminal";
  return null;
}

function parseStoredEvents(value: string): readonly CompactSessionEvent[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("The cloud projection cache contains invalid JSON.");
  }
  const parsed = parseCompactSessionEvents(decoded);
  if (parsed === null) throw new Error("The cloud projection cache contains invalid events.");
  return parsed;
}

function compactSessionEventBody(event: CompactSessionEvent): CompactSessionEventBody {
  if (event.kind === "user_message" || event.kind === "assistant_message") {
    return {
      kind: event.kind,
      text: event.text,
      turnId: event.turnId,
    };
  }
  if (event.kind === "interaction_state") {
    return {
      blocking: event.blocking,
      interactionId: event.interactionId,
      interactionKind: event.interactionKind,
      kind: event.kind,
      revision: event.revision,
      state: event.state,
      summary: event.summary,
    };
  }
  return {
    ...(event.fast === undefined ? {} : { fast: event.fast }),
    filesTouched: event.filesTouched,
    gitActions: event.gitActions,
    kind: event.kind,
    ...(event.model === undefined ? {} : { model: event.model }),
    runtimeMs: event.runtimeMs,
    turnId: event.turnId,
  };
}

function parseVerifiedStoredEvents(row: ProjectionStoredTurnRow): VerifiedProjectionTurnRow {
  const endSequence = row.start_sequence + row.event_count - 1;
  if (
    !isOpaqueIdentifier(row.turn_id)
    || !Number.isSafeInteger(row.start_sequence)
    || row.start_sequence < 1
    || !Number.isSafeInteger(row.event_count)
    || row.event_count < 1
    || !Number.isSafeInteger(endSequence)
    || !isDigest(row.digest)
    || typeof row.events_json !== "string"
    || utf8Bytes(row.events_json) > maximumCachedTurnBytes
  ) throw new ProjectionStreamRecoveryError();
  let events: readonly CompactSessionEvent[];
  try {
    events = parseStoredEvents(row.events_json);
  } catch {
    throw new ProjectionStreamRecoveryError();
  }
  const interaction = events.length === 1 && events[0]?.kind === "interaction_state"
    ? events[0]
    : null;
  const rowAuthorityMatches = interaction === null
    ? events.every((event) => event.kind !== "interaction_state" && event.turnId === row.turn_id)
    : row.turn_id === `hraix_${sha256(`${interaction.interactionId}:${String(interaction.revision)}`)}`;
  if (
    events.length !== row.event_count
    || events.some((event, index) => event.sequence !== row.start_sequence + index)
    || !rowAuthorityMatches
    || sha256(JSON.stringify(events.map(compactSessionEventBody))) !== row.digest
  ) throw new ProjectionStreamRecoveryError();
  return { ...row, events };
}

function verifiedInteractionEvent(
  row: VerifiedProjectionTurnRow,
): Extract<CompactSessionEvent, { kind: "interaction_state" }> | null {
  const event = row.events.length === 1 ? row.events[0] : undefined;
  return event?.kind === "interaction_state" ? event : null;
}

function rebuildProjectionInteractionIndex(database: Database): void {
  const latest = new Map<string, Readonly<{
    interactionId: string;
    revision: number;
    sessionId: string;
    startSequence: number;
  }>>();
  const rows = database.query(
    `SELECT turn_id,start_sequence,event_count,digest,events_json,session_id
     FROM projection_turns ORDER BY session_id,start_sequence`,
  ).all() as Array<ProjectionStoredTurnRow & { session_id: string }>;
  for (const storedRow of rows) {
    if (!isOpaqueIdentifier(storedRow.session_id)) {
      throw new ProjectionStreamRecoveryError();
    }
    const row = parseVerifiedStoredEvents(storedRow);
    const interaction = verifiedInteractionEvent(row);
    if (interaction !== null) {
      const key = `${storedRow.session_id}:${interaction.interactionId}`;
      const previous = latest.get(key);
      if (previous !== undefined && previous.revision >= interaction.revision) {
        throw new ProjectionStreamRecoveryError();
      }
      latest.set(key, {
        interactionId: interaction.interactionId,
        revision: interaction.revision,
        sessionId: storedRow.session_id,
        startSequence: row.start_sequence,
      });
    }
  }
  const insert = database.query(
    `INSERT INTO projection_interaction_index(
       session_id,interaction_id,start_sequence
     ) VALUES (?,?,?)`,
  );
  for (const value of latest.values()) {
    insert.run(value.sessionId, value.interactionId, value.startSequence);
  }
}

class CloudProjectionCache {
  readonly #database: Database;
  readonly #fileIdentity: ProjectionFileIdentity;
  readonly #validatedLedgers = new Map<string, ProjectionLedgerValidationMemo>();
  #observedDataVersion: number | null = null;

  constructor(path: string) {
    const existed = existsSync(path);
    if (existed) {
      assertSafeProjectionFile(path);
    } else {
      const descriptor = openSync(
        path,
        fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_RDWR
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      closeSync(descriptor);
      assertSafeProjectionFile(path);
    }
    const expectedIdentity = assertSafeProjectionFile(path);
    const observedVersion = observeProjectionUserVersion(path);
    assertProjectionFileIdentity(path, expectedIdentity);
    if (observedVersion > 5) {
      throw new Error("The cloud projection cache was created by a newer HRA version.");
    }
    const database = new Database(path, { create: true, strict: true });
    try {
      assertProjectionFileIdentity(path, expectedIdentity);
      const version = database.query("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== observedVersion || version.user_version > 5) {
        throw new Error("The cloud projection cache version changed during open.");
      }
      chmodSync(path, 0o600);
      assertSafeProjectionFile(path);
      database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      let needsInteractionIndexBackfill = false;
      if (version.user_version === 0) {
        database.exec(`
          CREATE TABLE projection_sessions (
            session_id TEXT PRIMARY KEY,
            next_sequence INTEGER NOT NULL CHECK(next_sequence > 0),
            stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0),
            interaction_scan_sequence INTEGER NOT NULL DEFAULT 0
              CHECK(interaction_scan_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)}),
            interaction_scan_ceiling_sequence INTEGER NOT NULL DEFAULT 0
              CHECK(interaction_scan_ceiling_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)}),
            interaction_discovery_cursor TEXT
              CHECK(interaction_discovery_cursor IS NULL OR length(CAST(interaction_discovery_cursor AS BLOB)) BETWEEN 50 AND 128)
          ) STRICT;
          CREATE TABLE projection_turns (
            session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL,
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            event_count INTEGER NOT NULL CHECK(event_count > 0),
            digest TEXT NOT NULL CHECK(length(digest) = 64),
            events_json TEXT NOT NULL CHECK(length(CAST(events_json AS BLOB)) <= ${String(maximumCachedTurnBytes)}),
            PRIMARY KEY(session_id, turn_id),
            UNIQUE(session_id, start_sequence)
          ) STRICT;
          CREATE TABLE projection_baselines (
            session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL,
            digest TEXT NOT NULL CHECK(length(digest) = 64),
            PRIMARY KEY(session_id, turn_id)
          ) STRICT;
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
          CREATE TABLE projection_ledger (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            cache_id TEXT NOT NULL CHECK(length(cache_id) BETWEEN 16 AND 128)
          ) STRICT;
          CREATE TABLE projection_remote_checkpoints (
            session_id TEXT PRIMARY KEY,
            head_sequence INTEGER NOT NULL CHECK(head_sequence >= 0),
            stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0),
            tail_digest TEXT CHECK(tail_digest IS NULL OR length(tail_digest) = 64),
            pending_expected_head INTEGER CHECK(pending_expected_head IS NULL OR pending_expected_head >= 0),
            pending_expected_tail TEXT CHECK(pending_expected_tail IS NULL OR length(pending_expected_tail) = 64),
            pending_head INTEGER CHECK(pending_head IS NULL OR pending_head > 0),
            pending_tail TEXT CHECK(pending_tail IS NULL OR length(pending_tail) = 64)
          ) STRICT;
          PRAGMA user_version=5;
        `);
      } else if (version.user_version === 1) {
        database.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE projection_sessions ADD COLUMN stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0);
          ALTER TABLE projection_sessions ADD COLUMN interaction_scan_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(interaction_scan_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)});
          ALTER TABLE projection_sessions ADD COLUMN interaction_scan_ceiling_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(interaction_scan_ceiling_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)});
          ALTER TABLE projection_sessions ADD COLUMN interaction_discovery_cursor TEXT
            CHECK(interaction_discovery_cursor IS NULL OR length(CAST(interaction_discovery_cursor AS BLOB)) BETWEEN 50 AND 128);
          ALTER TABLE projection_remote_checkpoints ADD COLUMN stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0);
          CREATE TABLE projection_baselines (
            session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL,
            digest TEXT NOT NULL CHECK(length(digest) = 64),
            PRIMARY KEY(session_id, turn_id)
          ) STRICT;
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
        `);
        needsInteractionIndexBackfill = true;
      } else if (version.user_version === 2) {
        database.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE projection_sessions ADD COLUMN interaction_scan_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(interaction_scan_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)});
          ALTER TABLE projection_sessions ADD COLUMN interaction_scan_ceiling_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(interaction_scan_ceiling_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)});
          ALTER TABLE projection_sessions ADD COLUMN interaction_discovery_cursor TEXT
            CHECK(interaction_discovery_cursor IS NULL OR length(CAST(interaction_discovery_cursor AS BLOB)) BETWEEN 50 AND 128);
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
        `);
        needsInteractionIndexBackfill = true;
      } else if (version.user_version === 3) {
        database.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE projection_sessions ADD COLUMN interaction_discovery_cursor TEXT
            CHECK(interaction_discovery_cursor IS NULL OR length(CAST(interaction_discovery_cursor AS BLOB)) BETWEEN 50 AND 128);
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
        `);
        needsInteractionIndexBackfill = true;
      } else if (version.user_version === 4) {
        database.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
        `);
        needsInteractionIndexBackfill = true;
      }
      if (needsInteractionIndexBackfill) {
        rebuildProjectionInteractionIndex(database);
        database.exec("PRAGMA user_version=5; COMMIT;");
      }
      database.query("INSERT OR IGNORE INTO projection_ledger(singleton,cache_id) VALUES (1,?)")
        .run(randomUUID());
    } catch (error: unknown) {
      database.close(false);
      throw error;
    }
    this.#database = database;
    this.#fileIdentity = assertSafeProjectionFile(path);
  }

  close(): void {
    this.#database.close(false);
  }

  cacheId(): string {
    const row = this.#database.query(
      "SELECT cache_id FROM projection_ledger WHERE singleton=1",
    ).get() as { cache_id: string } | null;
    if (row === null || !isOpaqueIdentifier(row.cache_id)) {
      throw new Error("The cloud projection cache ledger is corrupt.");
    }
    return row.cache_id;
  }

  fileIdentity(): ProjectionFileIdentity {
    return this.#fileIdentity;
  }

  hasRecoveryInstallation(input: CompactProjectionRecoveryInstallation): boolean {
    if (this.cacheId() !== input.replacementCacheId) return false;
    const baselineInteractions = parseRecoveryBaselineInteractions(input.baselineInteractions);
    const session = this.#database.query(
      `SELECT next_sequence,stream_epoch,interaction_scan_sequence,
              interaction_scan_ceiling_sequence,interaction_discovery_cursor
       FROM projection_sessions WHERE session_id=?`,
    ).get(input.sessionPublicId) as ProjectionSequenceRow | null;
    const checkpoint = this.#remoteCheckpoint(input.sessionPublicId);
    if (
      session?.next_sequence !== input.boundaryHeadSequence + 1 + baselineInteractions.length
      || session.stream_epoch !== input.compactStreamEpoch
      || session.interaction_scan_sequence !== 0
      || session.interaction_scan_ceiling_sequence !== 0
      || session.interaction_discovery_cursor !== null
      || checkpoint?.head_sequence !== input.boundaryHeadSequence
      || checkpoint.stream_epoch !== input.compactStreamEpoch
      || checkpoint.tail_digest !== input.boundaryTailDigest
      || checkpoint.pending_expected_head !== null
      || checkpoint.pending_expected_tail !== null
      || checkpoint.pending_head !== null
      || checkpoint.pending_tail !== null
    ) return false;
    const rows = this.#database.query(
      "SELECT turn_id,digest FROM projection_baselines WHERE session_id=? ORDER BY turn_id",
    ).all(input.sessionPublicId) as Array<{ digest: string; turn_id: string }>;
    const expected = [...input.baselineCompletedTurns]
      .sort((left, right) => left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0);
    if (!(rows.length === expected.length && rows.every((row, index) => {
      const value = expected[index];
      return value !== undefined && row.turn_id === value.turnId && row.digest === value.bodyDigest;
    }))) return false;
    const interactionRows = this.#database.query(
      "SELECT turn_id,start_sequence,event_count,digest,events_json FROM projection_turns WHERE session_id=? ORDER BY start_sequence",
    ).all(input.sessionPublicId) as ProjectionStoredTurnRow[];
    const indexedInteractions = this.#database.query(
      `SELECT interaction_id,start_sequence FROM projection_interaction_index
       WHERE session_id=? ORDER BY start_sequence`,
    ).all(input.sessionPublicId) as Array<{
      interaction_id: string;
      start_sequence: number;
    }>;
    return interactionRows.length === baselineInteractions.length
      && indexedInteractions.length === baselineInteractions.length
      && indexedInteractions.every((row, index) => {
        const interaction = baselineInteractions[index];
        return interaction !== undefined
          && row.interaction_id === interaction.interactionId
          && row.start_sequence === input.boundaryHeadSequence + 1 + index;
      })
      && interactionRows.every((row, index) => {
        const interaction = baselineInteractions[index];
        if (interaction === undefined) return false;
        const body = recoveryInteractionBody(interaction);
        const sequence = input.boundaryHeadSequence + 1 + index;
        const events = [{ ...body, sequence }];
        const verified = parseVerifiedStoredEvents(row);
        return row.turn_id === recoveryInteractionTurnId(interaction)
          && row.start_sequence === sequence
          && row.event_count === 1
          && row.digest === sha256(JSON.stringify([body]))
          && row.events_json === JSON.stringify(events)
          && verified.events[0]?.kind === "interaction_state";
      });
  }

  isEmptyRecoverySource(): boolean {
    const counts = this.#database.query(`
      SELECT
        (SELECT count(*) FROM projection_sessions) AS sessions,
        (SELECT count(*) FROM projection_turns) AS turns,
        (SELECT count(*) FROM projection_interaction_index) AS interactions,
        (SELECT count(*) FROM projection_baselines) AS baselines,
        (SELECT count(*) FROM projection_remote_checkpoints) AS checkpoints
    `).get() as {
      baselines: number;
      checkpoints: number;
      interactions: number;
      sessions: number;
      turns: number;
    };
    return counts.sessions === 0
      && counts.turns === 0
      && counts.interactions === 0
      && counts.baselines === 0
      && counts.checkpoints === 0;
  }

  initializeRecovery(input: CompactProjectionRecoveryInstallation): void {
    const baselineInteractions = parseRecoveryBaselineInteractions(input.baselineInteractions);
    if (
      !isOpaqueIdentifier(input.sessionPublicId)
      || !Number.isSafeInteger(input.boundaryHeadSequence)
      || input.boundaryHeadSequence < 1
      || !isDigest(input.boundaryTailDigest)
      || !Number.isSafeInteger(input.compactStreamEpoch)
      || input.compactStreamEpoch < 1
      || !isOpaqueIdentifier(input.replacementCacheId)
      || input.baselineCompletedTurns.length > 128
      || new Set(input.baselineCompletedTurns.map((turn) => turn.turnId)).size
        !== input.baselineCompletedTurns.length
      || input.baselineCompletedTurns.some((turn) =>
        !isOpaqueIdentifier(turn.turnId) || !isDigest(turn.bodyDigest))
      || !Number.isSafeInteger(
        input.boundaryHeadSequence + 1 + baselineInteractions.length,
      )
    ) throw new Error("Invalid cloud projection recovery installation.");
    if (this.hasRecoveryInstallation(input)) return;
    const install = this.#database.transaction(() => {
      this.#database.query("UPDATE projection_ledger SET cache_id=? WHERE singleton=1")
        .run(input.replacementCacheId);
      this.#database.query("DELETE FROM projection_remote_checkpoints WHERE session_id=?")
        .run(input.sessionPublicId);
      this.#database.query("DELETE FROM projection_sessions WHERE session_id=?")
        .run(input.sessionPublicId);
      this.#database.query(
        "INSERT INTO projection_sessions(session_id,next_sequence,stream_epoch) VALUES (?,?,?)",
      ).run(
        input.sessionPublicId,
        input.boundaryHeadSequence + 1 + baselineInteractions.length,
        input.compactStreamEpoch,
      );
      for (const baseline of input.baselineCompletedTurns) {
        this.#database.query(
          "INSERT INTO projection_baselines(session_id,turn_id,digest) VALUES (?,?,?)",
        ).run(input.sessionPublicId, baseline.turnId, baseline.bodyDigest);
      }
      for (const [index, interaction] of baselineInteractions.entries()) {
        const body = recoveryInteractionBody(interaction);
        const sequence = input.boundaryHeadSequence + 1 + index;
        this.#database.query(
          "INSERT INTO projection_turns(session_id,turn_id,start_sequence,event_count,digest,events_json) VALUES (?,?,?,?,?,?)",
        ).run(
          input.sessionPublicId,
          recoveryInteractionTurnId(interaction),
          sequence,
          1,
          sha256(JSON.stringify([body])),
          JSON.stringify([{ ...body, sequence }]),
        );
        this.#database.query(
          `INSERT INTO projection_interaction_index(
             session_id,interaction_id,start_sequence
           ) VALUES (?,?,?)`,
        ).run(input.sessionPublicId, interaction.interactionId, sequence);
      }
      this.#database.query(
        "INSERT INTO projection_remote_checkpoints(session_id,head_sequence,stream_epoch,tail_digest) VALUES (?,?,?,?)",
      ).run(
        input.sessionPublicId,
        input.boundaryHeadSequence,
        input.compactStreamEpoch,
        input.boundaryTailDigest,
      );
    });
    install.immediate();
    if (!this.hasRecoveryInstallation(input)) {
      throw new Error("Cloud projection recovery cache installation did not commit exactly.");
    }
  }

  ingestTurn(
    sessionPublicId: string,
    turnId: string,
    bodies: readonly CompactSessionEventBody[],
  ): void {
    if (
      !isOpaqueIdentifier(sessionPublicId)
      || !isOpaqueIdentifier(turnId)
      || bodies.length < 1
      || bodies.length > 256
    ) {
      throw new Error("Invalid local cloud projection turn.");
    }
    const digest = sha256(JSON.stringify(bodies));
    const baseline = this.#database
      .query("SELECT digest FROM projection_baselines WHERE session_id=? AND turn_id=?")
      .get(sessionPublicId, turnId) as ProjectionBaselineRow | null;
    if (baseline !== null) {
      if (!isDigest(baseline.digest)) throw new ProjectionStreamRecoveryError();
      if (baseline.digest !== digest) {
        throw new Error("A recovery-baselined turn changed after cloud projection.");
      }
      return;
    }
    const existing = this.#database
      .query(
        `SELECT turn_id,start_sequence,event_count,digest,events_json
         FROM projection_turns WHERE session_id=? AND turn_id=?`,
      )
      .get(sessionPublicId, turnId) as ProjectionStoredTurnRow | null;
    if (existing !== null) {
      const verified = parseVerifiedStoredEvents(existing);
      if (verified.digest !== digest) throw new Error("A completed turn changed after cloud projection.");
      return;
    }

    const insert = this.#database.transaction(() => {
      this.#database.query("INSERT OR IGNORE INTO projection_sessions(session_id,next_sequence) VALUES (?,1)")
        .run(sessionPublicId);
      this.#validateLocalLedger(sessionPublicId);
      const sequence = this.#database
        .query(
          `SELECT next_sequence,stream_epoch,interaction_scan_sequence,
                  interaction_scan_ceiling_sequence,interaction_discovery_cursor
           FROM projection_sessions WHERE session_id=?`,
        )
        .get(sessionPublicId) as ProjectionSequenceRow | null;
      if (sequence === null) throw new ProjectionStreamRecoveryError();
      const nextSequence = sequence.next_sequence;
      const followingSequence = nextSequence + bodies.length;
      if (
        !Number.isSafeInteger(nextSequence)
        || nextSequence < 1
        || !Number.isSafeInteger(followingSequence)
      ) throw new ProjectionStreamRecoveryError();
      const events = bodies.map((body, index) => ({ ...body, sequence: sequence.next_sequence + index }));
      const parsed = parseCompactSessionEvents(events);
      if (parsed === null) throw new Error("Invalid bounded local session projection.");
      const json = JSON.stringify(parsed);
      if (utf8Bytes(json) > maximumCachedTurnBytes) throw new Error("A projected turn exceeds the local cache bound.");
      this.#database.query(
        "INSERT INTO projection_turns(session_id,turn_id,start_sequence,event_count,digest,events_json) VALUES (?,?,?,?,?,?)",
      ).run(sessionPublicId, turnId, sequence.next_sequence, parsed.length, digest, json);
      const interaction = parsed.length === 1 && parsed[0]?.kind === "interaction_state"
        ? parsed[0]
        : null;
      if (interaction !== null) {
        const indexed = this.#database.query(
          `SELECT i.interaction_id,t.turn_id,t.start_sequence,t.event_count,
                  t.digest,t.events_json
           FROM projection_interaction_index i
           JOIN projection_turns t
             ON t.session_id=i.session_id AND t.start_sequence=i.start_sequence
           WHERE i.session_id=? AND i.interaction_id=?`,
        ).get(sessionPublicId, interaction.interactionId) as ProjectionIndexedInteractionRow | null;
        if (indexed !== null) {
          const current = verifiedInteractionEvent(parseVerifiedStoredEvents(indexed));
          if (
            current === null
            || current.interactionId !== indexed.interaction_id
            || current.revision >= interaction.revision
          ) throw new ProjectionStreamRecoveryError();
          const removed = this.#database.query(
            `DELETE FROM projection_interaction_index
             WHERE session_id=? AND interaction_id=? AND start_sequence=?`,
          ).run(sessionPublicId, interaction.interactionId, indexed.start_sequence);
          if (removed.changes !== 1) throw new ProjectionStreamRecoveryError();
        }
        this.#database.query(
          `INSERT INTO projection_interaction_index(
             session_id,interaction_id,start_sequence
           ) VALUES (?,?,?)`,
        ).run(sessionPublicId, interaction.interactionId, sequence.next_sequence);
      }
      const changed = this.#database.query(
        "UPDATE projection_sessions SET next_sequence=? WHERE session_id=? AND next_sequence=?",
      ).run(followingSequence, sessionPublicId, sequence.next_sequence);
      if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
      // This connection's own commits do not advance PRAGMA data_version.
      // Extend the trusted prefix while the insertion is still protected by
      // the same immediate transaction.
      this.#validateLocalLedger(sessionPublicId);
    });
    insert.immediate();
  }

  interactionDiscoveryCursor(
    sessionPublicId: string,
  ): InteractionListPosition | null {
    if (!isOpaqueIdentifier(sessionPublicId)) {
      throw new Error("Invalid local cloud projection session.");
    }
    const inspect = this.#database.transaction(() =>
      this.#validateLocalLedger(sessionPublicId).interactionDiscoveryCursor);
    return inspect.immediate();
  }

  advanceInteractionDiscoveryCursor(
    sessionPublicId: string,
    expected: InteractionListPosition | null,
    next: InteractionListPosition | null,
  ): void {
    if (!isOpaqueIdentifier(sessionPublicId)) {
      throw new Error("Invalid local cloud projection session.");
    }
    const expectedJson = expected === null
      ? null
      : encodeInteractionListPosition(expected);
    const nextJson = next === null ? null : encodeInteractionListPosition(next);
    // Round-trip caller-owned scheduling state before it reaches SQLite.
    parseInteractionListPosition(expectedJson);
    parseInteractionListPosition(nextJson);
    const advance = this.#database.transaction(() => {
      const ledger = this.#validateLocalLedger(sessionPublicId);
      if (!sameInteractionListPosition(ledger.interactionDiscoveryCursor, expected)) {
        throw new ProjectionStreamRecoveryError();
      }
      const current = this.#database.query(
        "SELECT interaction_discovery_cursor FROM projection_sessions WHERE session_id=?",
      ).get(sessionPublicId) as { interaction_discovery_cursor: string | null } | null;
      if (current === null) {
        if (expected === null && next === null) return;
        throw new ProjectionStreamRecoveryError();
      }
      const changed = this.#database.query(
        `UPDATE projection_sessions SET interaction_discovery_cursor=?
         WHERE session_id=?
           AND ((interaction_discovery_cursor IS NULL AND ? IS NULL)
             OR interaction_discovery_cursor=?)`,
      ).run(nextJson, sessionPublicId, current.interaction_discovery_cursor, current.interaction_discovery_cursor);
      if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
      this.#validateLocalLedger(sessionPublicId);
    });
    advance.immediate();
  }

  observedInteractionIds(sessionPublicId: string): readonly string[] {
    if (!isOpaqueIdentifier(sessionPublicId)) {
      throw new Error("Invalid local cloud projection session.");
    }
    const scan = this.#database.transaction((): readonly string[] => {
      const ledger = this.#validateLocalLedger(sessionPublicId);
      let cursor = ledger.interactionScanSequence;
      let ceiling = ledger.interactionScanCeilingSequence;
      if (cursor === 0 && ceiling === 0) ceiling = ledger.localHead;
      const fairPage = (afterSequence: number, throughSequence: number) =>
        this.#database.query(
          `SELECT i.interaction_id,t.turn_id,t.start_sequence,t.event_count,
                  t.digest,t.events_json
           FROM projection_interaction_index i
           JOIN projection_turns t
             ON t.session_id=i.session_id AND t.start_sequence=i.start_sequence
           WHERE i.session_id=? AND i.start_sequence>? AND i.start_sequence<=?
           ORDER BY i.start_sequence LIMIT 200`,
        ).all(
          sessionPublicId,
          afterSequence,
          throughSequence,
        ) as ProjectionIndexedInteractionRow[];
      let page = fairPage(cursor, ceiling);
      if (page.length === 0 && (cursor !== 0 || ceiling !== ledger.localHead)) {
        cursor = 0;
        ceiling = ledger.localHead;
        page = fairPage(0, ceiling);
      }
      const nextCursor = page.at(-1)?.start_sequence ?? 0;
      const nextCeiling = page.length === 0 ? 0 : ceiling;
      if (ledger.localHead > 0) {
        const changed = this.#database.query(
          `UPDATE projection_sessions
           SET interaction_scan_sequence=?,interaction_scan_ceiling_sequence=?
           WHERE session_id=? AND interaction_scan_sequence=?
             AND interaction_scan_ceiling_sequence=?`,
        ).run(
          nextCursor,
          nextCeiling,
          sessionPublicId,
          ledger.interactionScanSequence,
          ledger.interactionScanCeilingSequence,
        );
        if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
      }
      const newest = this.#database.query(
        `SELECT i.interaction_id,t.turn_id,t.start_sequence,t.event_count,
                t.digest,t.events_json
         FROM projection_interaction_index i
         JOIN projection_turns t
           ON t.session_id=i.session_id AND t.start_sequence=i.start_sequence
         WHERE i.session_id=?
         ORDER BY i.start_sequence DESC LIMIT 200`,
      ).all(sessionPublicId) as ProjectionIndexedInteractionRow[];
      const interactionIds = new Set<string>();
      for (const indexed of [...page, ...newest]) {
        const interaction = verifiedInteractionEvent(parseVerifiedStoredEvents(indexed));
        if (
          interaction === null
          || interaction.interactionId !== indexed.interaction_id
          || indexed.start_sequence < 1
        ) throw new ProjectionStreamRecoveryError();
        interactionIds.add(interaction.interactionId);
      }
      return [...interactionIds];
    });
    return scan.immediate();
  }

  ingestInteraction(sessionPublicId: string, interaction: InteractionRecord): void {
    if (interaction.sessionId !== sessionPublicId) {
      throw new Error("The cloud projection interaction belongs to another session.");
    }
    const recordId = `hraix_${sha256(`${interaction.publicId}:${String(interaction.revision)}`)}`;
    this.ingestTurn(sessionPublicId, recordId, [{
      blocking: interaction.blocking,
      interactionId: interaction.publicId,
      interactionKind: interaction.kind,
      kind: "interaction_state",
      revision: interaction.revision,
      state: interaction.state,
      summary: compactInteractionSummary(interaction.kind),
    }]);
  }

  hasUncommittedEvents(sessionPublicId: string): boolean {
    if (!isOpaqueIdentifier(sessionPublicId)) {
      throw new Error("Invalid local cloud projection session.");
    }
    const inspect = this.#database.transaction(() => {
      const { committedHead, localHead } = this.#validateLocalLedger(sessionPublicId);
      return localHead > committedHead;
    });
    return inspect.immediate();
  }

  #remoteCheckpoint(sessionPublicId: string): ProjectionCheckpointRow | null {
    return this.#database.query(
      "SELECT head_sequence,stream_epoch,tail_digest,pending_expected_head,pending_expected_tail,pending_head,pending_tail FROM projection_remote_checkpoints WHERE session_id=?",
    ).get(sessionPublicId) as ProjectionCheckpointRow | null;
  }

  #validateLocalLedger(sessionPublicId: string): ValidatedProjectionLedger {
    const dataVersion = (this.#database.query("PRAGMA data_version").get() as {
      data_version: number;
    } | null)?.data_version;
    if (!Number.isSafeInteger(dataVersion) || (dataVersion as number) < 0) {
      throw new ProjectionStreamRecoveryError();
    }
    if (
      this.#observedDataVersion !== null
      && this.#observedDataVersion !== dataVersion
    ) this.#validatedLedgers.clear();
    this.#observedDataVersion = dataVersion as number;

    const session = this.#database.query(
      `SELECT next_sequence,stream_epoch,interaction_scan_sequence,
              interaction_scan_ceiling_sequence,interaction_discovery_cursor
       FROM projection_sessions WHERE session_id=?`,
    ).get(sessionPublicId) as ProjectionSequenceRow | null;
    const checkpoint = this.#remoteCheckpoint(sessionPublicId);
    const pendingValues = checkpoint === null
      ? []
      : [
          checkpoint.pending_expected_head,
          checkpoint.pending_expected_tail,
          checkpoint.pending_head,
          checkpoint.pending_tail,
        ];
    const hasNoPending = pendingValues.every((value) => value === null);
    const hasCompletePending = checkpoint !== null
      && checkpoint.pending_expected_head !== null
      && checkpoint.pending_head !== null
      && checkpoint.pending_tail !== null
      && Number.isSafeInteger(checkpoint.pending_expected_head)
      && checkpoint.pending_expected_head >= 0
      && Number.isSafeInteger(checkpoint.pending_head)
      && checkpoint.pending_head > 0
      && (checkpoint.pending_expected_head === 0
        ? checkpoint.pending_expected_tail === null
        : checkpoint.pending_expected_tail !== null
          && isDigest(checkpoint.pending_expected_tail));
    const checkpointTailValid = checkpoint === null
      || (
        Number.isSafeInteger(checkpoint.head_sequence)
        && checkpoint.head_sequence >= 0
        && Number.isSafeInteger(checkpoint.stream_epoch)
        && checkpoint.stream_epoch >= 0
        && (checkpoint.head_sequence === 0
          ? checkpoint.tail_digest === null
          : isDigest(checkpoint.tail_digest))
        && (checkpoint.stream_epoch === 0 || checkpoint.head_sequence > 0)
      );
    if (
      checkpoint !== null
      && (
        !checkpointTailValid
        || (!hasNoPending && !hasCompletePending)
        || (
          hasCompletePending
          && (
            checkpoint.pending_expected_head !== checkpoint.head_sequence
            || checkpoint.pending_expected_tail !== checkpoint.tail_digest
            || checkpoint.pending_head <= checkpoint.head_sequence
            || !isDigest(checkpoint.pending_tail)
          )
        )
      )
    ) throw new ProjectionStreamRecoveryError();
    if (session === null) {
      this.#validatedLedgers.delete(sessionPublicId);
      if (
        checkpoint === null
        || (
          checkpoint.head_sequence === 0
          && checkpoint.stream_epoch === 0
          && checkpoint.tail_digest === null
          && hasNoPending
        )
      ) return {
        committedHead: 0,
        interactionDiscoveryCursor: null,
        interactionScanCeilingSequence: 0,
        interactionScanSequence: 0,
        localHead: 0,
      };
      throw new ProjectionStreamRecoveryError();
    }
    if (
      !Number.isSafeInteger(session.next_sequence)
      || session.next_sequence < 1
      || !Number.isSafeInteger(session.stream_epoch)
      || session.stream_epoch < 0
      || !Number.isSafeInteger(session.interaction_scan_sequence)
      || session.interaction_scan_sequence < 0
      || !Number.isSafeInteger(session.interaction_scan_ceiling_sequence)
      || session.interaction_scan_ceiling_sequence < 0
    ) throw new ProjectionStreamRecoveryError();
    const interactionDiscoveryCursor = parseInteractionListPosition(
      session.interaction_discovery_cursor,
    );
    const localHead = session.next_sequence - 1;
    const scanIsInactive = session.interaction_scan_sequence === 0
      && session.interaction_scan_ceiling_sequence === 0;
    const scanIsActive = session.interaction_scan_sequence > 0
      && session.interaction_scan_ceiling_sequence > 0
      && session.interaction_scan_sequence <= session.interaction_scan_ceiling_sequence
      && session.interaction_scan_ceiling_sequence <= localHead;
    if (
      !Number.isSafeInteger(localHead)
      || (!scanIsInactive && !scanIsActive)
      || session.interaction_scan_sequence > localHead
      || session.interaction_scan_ceiling_sequence > localHead
      || (session.stream_epoch > 0 && (
        checkpoint === null
        || checkpoint.head_sequence < 1
        || !isDigest(checkpoint.tail_digest)
      ))
      || (
      checkpoint === null
        ? session.stream_epoch !== 0
        : checkpoint.stream_epoch !== session.stream_epoch
          || checkpoint.head_sequence > localHead
          || (checkpoint.pending_head !== null && checkpoint.pending_head > localHead)
      )
    ) throw new ProjectionStreamRecoveryError();

    const prior = this.#validatedLedgers.get(sessionPublicId);
    if (
      prior !== undefined
      && (
        prior.streamEpoch !== session.stream_epoch
        || prior.localHead > localHead
      )
    ) throw new ProjectionStreamRecoveryError();
    const storedRows = prior === undefined
      ? this.#database.query(
          `SELECT turn_id,start_sequence,event_count,digest,events_json
           FROM projection_turns WHERE session_id=? ORDER BY start_sequence`,
        ).all(sessionPublicId) as ProjectionStoredTurnRow[]
      : this.#database.query(
          `SELECT turn_id,start_sequence,event_count,digest,events_json
           FROM projection_turns
           WHERE session_id=? AND start_sequence>?
           ORDER BY start_sequence`,
        ).all(sessionPublicId, prior.localHead) as ProjectionStoredTurnRow[];
    const expectedInteractionIndex = prior === undefined
      ? new Map<string, Readonly<{ revision: number; startSequence: number }>>()
      : null;
    const appendedInteractionIndex: Array<Readonly<{
      interactionId: string;
      startSequence: number;
    }>> = [];
    let firstSequence = prior?.firstSequence ?? null;
    let validatedHead = prior?.localHead ?? 0;
    for (const storedRow of storedRows) {
      const row = parseVerifiedStoredEvents(storedRow);
      if (firstSequence === null) {
        firstSequence = row.start_sequence;
        if (prior === undefined) validatedHead = row.start_sequence - 1;
      }
      if (row.start_sequence !== validatedHead + 1) {
        throw new ProjectionStreamRecoveryError();
      }
      validatedHead = row.start_sequence + row.event_count - 1;
      const interaction = verifiedInteractionEvent(row);
      if (interaction !== null) {
        if (expectedInteractionIndex !== null) {
          const previous = expectedInteractionIndex.get(interaction.interactionId);
          if (previous !== undefined && previous.revision >= interaction.revision) {
            throw new ProjectionStreamRecoveryError();
          }
          expectedInteractionIndex.set(interaction.interactionId, {
            revision: interaction.revision,
            startSequence: row.start_sequence,
          });
        } else {
          appendedInteractionIndex.push({
            interactionId: interaction.interactionId,
            startSequence: row.start_sequence,
          });
        }
      }
    }
    const committedHead = checkpoint?.head_sequence ?? 0;
    if (firstSequence === null && prior === undefined && localHead === committedHead) {
      validatedHead = localHead;
    }
    let scanCursorMatchesInteraction = session.interaction_scan_sequence === 0;
    if (!scanCursorMatchesInteraction) {
      const cursorRow = this.#database.query(
        `SELECT turn_id,start_sequence,event_count,digest,events_json
         FROM projection_turns WHERE session_id=? AND start_sequence=?`,
      ).get(
        sessionPublicId,
        session.interaction_scan_sequence,
      ) as ProjectionStoredTurnRow | null;
      if (cursorRow !== null) {
        const verifiedCursor = parseVerifiedStoredEvents(cursorRow);
        scanCursorMatchesInteraction = verifiedCursor.events.length === 1
          && verifiedCursor.events[0]?.kind === "interaction_state";
      }
    }
    if (
      validatedHead !== localHead
      || !scanCursorMatchesInteraction
      || (firstSequence === null && (localHead !== committedHead || !scanIsInactive))
      || (session.stream_epoch === 0 && firstSequence !== null && firstSequence !== 1)
      || (
        session.stream_epoch > 0
        && firstSequence !== null
        && (
          checkpoint === null
          || firstSequence < 2
          || firstSequence > checkpoint.head_sequence + 1
        )
      )
    ) throw new ProjectionStreamRecoveryError();
    if (expectedInteractionIndex !== null) {
      const indexed = this.#database.query(
        `SELECT interaction_id,start_sequence
         FROM projection_interaction_index
         WHERE session_id=? ORDER BY interaction_id`,
      ).all(sessionPublicId) as Array<{
        interaction_id: string;
        start_sequence: number;
      }>;
      if (
        indexed.length !== expectedInteractionIndex.size
        || indexed.some((row) =>
          expectedInteractionIndex.get(row.interaction_id)?.startSequence !== row.start_sequence)
      ) throw new ProjectionStreamRecoveryError();
    } else {
      for (const expected of appendedInteractionIndex) {
        const indexed = this.#database.query(
          `SELECT start_sequence FROM projection_interaction_index
           WHERE session_id=? AND interaction_id=?`,
        ).get(sessionPublicId, expected.interactionId) as { start_sequence: number } | null;
        if (indexed?.start_sequence !== expected.startSequence) {
          throw new ProjectionStreamRecoveryError();
        }
      }
    }
    this.#validatedLedgers.set(sessionPublicId, {
      firstSequence,
      localHead,
      streamEpoch: session.stream_epoch,
    });
    return {
      committedHead,
      interactionDiscoveryCursor,
      interactionScanCeilingSequence: session.interaction_scan_ceiling_sequence,
      interactionScanSequence: session.interaction_scan_sequence,
      localHead,
    };
  }

  #assertRemoteHead(
    sessionPublicId: string,
    headSequence: number,
    tailDigest: string | undefined,
    streamEpoch: number,
  ): void {
    if (!validProjectionRemoteHead(headSequence, tailDigest, streamEpoch)) {
      throw new ProjectionStreamRecoveryError();
    }
    const current = this.#remoteCheckpoint(sessionPublicId);
    if (current === null) {
      if (headSequence !== 0 || tailDigest !== undefined || streamEpoch !== 0) {
        throw new ProjectionStreamRecoveryError();
      }
      this.#database.query(
        "INSERT INTO projection_remote_checkpoints(session_id,head_sequence,stream_epoch,tail_digest) VALUES (?,0,0,NULL)",
      ).run(sessionPublicId);
      return;
    }
    if (
      current.head_sequence === headSequence
      && current.stream_epoch === streamEpoch
      && (current.tail_digest ?? undefined) === tailDigest
    ) return;
    if (
      current.pending_head === headSequence
      && current.stream_epoch === streamEpoch
      && (current.pending_tail ?? undefined) === tailDigest
    ) {
      const changed = this.#database.query(`
        UPDATE projection_remote_checkpoints
        SET head_sequence=?,tail_digest=?,pending_expected_head=NULL,
            pending_expected_tail=NULL,pending_head=NULL,pending_tail=NULL
        WHERE session_id=? AND stream_epoch=? AND pending_head=? AND pending_tail=?
      `).run(
        headSequence,
        tailDigest ?? null,
        sessionPublicId,
        streamEpoch,
        headSequence,
        tailDigest ?? null,
      );
      if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
      return;
    }
    throw new ProjectionStreamRecoveryError();
  }

  recordUploadIntent(input: CompactUploadCheckpoint): void {
    if (input.cacheId !== this.cacheId()) throw new ProjectionStreamRecoveryError();
    if (!validCompactUploadCheckpoint(input)) {
      throw new Error("Invalid cloud projection upload checkpoint.");
    }
    const record = this.#database.transaction(() => {
      const { localHead } = this.#validateLocalLedger(input.sessionPublicId);
      this.#assertRemoteHead(
        input.sessionPublicId,
        input.expectedHeadSequence,
        input.expectedTailDigest,
        input.expectedStreamEpoch,
      );
      if (input.headSequence > localHead) {
        throw new Error("Invalid cloud projection upload checkpoint.");
      }
      const changed = this.#database.query(`
        UPDATE projection_remote_checkpoints
        SET pending_expected_head=?,pending_expected_tail=?,pending_head=?,pending_tail=?
        WHERE session_id=? AND head_sequence=? AND stream_epoch=?
          AND ((tail_digest IS NULL AND ? IS NULL) OR tail_digest=?)
      `).run(
        input.expectedHeadSequence,
        input.expectedTailDigest ?? null,
        input.headSequence,
        input.digest,
        input.sessionPublicId,
        input.expectedHeadSequence,
        input.expectedStreamEpoch,
        input.expectedTailDigest ?? null,
        input.expectedTailDigest ?? null,
      );
      if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
    });
    record.immediate();
  }

  acknowledgeUpload(input: CompactUploadCheckpoint): void {
    if (input.cacheId !== this.cacheId()) throw new ProjectionStreamRecoveryError();
    if (!validCompactUploadCheckpoint(input)) {
      throw new Error("Invalid cloud projection upload checkpoint.");
    }
    const acknowledge = this.#database.transaction(() => {
      const { localHead } = this.#validateLocalLedger(input.sessionPublicId);
      if (input.headSequence > localHead) {
        throw new Error("Invalid cloud projection upload checkpoint.");
      }
      const changed = this.#database.query(`
        UPDATE projection_remote_checkpoints
        SET head_sequence=?,tail_digest=?,pending_expected_head=NULL,
            pending_expected_tail=NULL,pending_head=NULL,pending_tail=NULL
        WHERE session_id=? AND head_sequence=? AND stream_epoch=?
          AND ((tail_digest IS NULL AND ? IS NULL) OR tail_digest=?)
          AND pending_expected_head=?
          AND ((pending_expected_tail IS NULL AND ? IS NULL) OR pending_expected_tail=?)
          AND pending_head=? AND pending_tail=?
      `).run(
        input.headSequence,
        input.digest,
        input.sessionPublicId,
        input.expectedHeadSequence,
        input.expectedStreamEpoch,
        input.expectedTailDigest ?? null,
        input.expectedTailDigest ?? null,
        input.expectedHeadSequence,
        input.expectedTailDigest ?? null,
        input.expectedTailDigest ?? null,
        input.headSequence,
        input.digest,
      );
      if (changed.changes !== 1) {
        const current = this.#remoteCheckpoint(input.sessionPublicId);
        if (
          current?.head_sequence === input.headSequence
          && current.stream_epoch === input.expectedStreamEpoch
          && current.tail_digest === input.digest
        ) return;
        throw new ProjectionStreamRecoveryError();
      }
    });
    acknowledge.immediate();
  }

  read(
    sessionPublicId: string,
    afterSequence: number,
    remoteTailDigest: string | undefined,
    remoteStreamEpoch: number,
    limit: number,
  ): Readonly<{
    complete: boolean;
    events: readonly CompactSessionEvent[];
  }> {
    const read = this.#database.transaction(() => {
      const ledger = this.#validateLocalLedger(sessionPublicId);
      this.#assertRemoteHead(sessionPublicId, afterSequence, remoteTailDigest, remoteStreamEpoch);
      const events: CompactSessionEvent[] = [];
      let reachedByteLimit = false;
      const storedRows = this.#database.query(
        `SELECT turn_id,start_sequence,event_count,digest,events_json
         FROM projection_turns
         WHERE session_id=? AND start_sequence+event_count-1>?
         ORDER BY start_sequence LIMIT ?`,
      ).all(sessionPublicId, afterSequence, limit) as ProjectionStoredTurnRow[];
      for (const storedRow of storedRows) {
        const row = parseVerifiedStoredEvents(storedRow);
        for (const event of row.events) {
          if (event.sequence <= afterSequence || events.length >= limit) continue;
          const candidate = [...events, event];
          if (utf8Bytes(JSON.stringify(candidate)) > maximumProjectionReadBytes) {
            if (events.length === 0) {
              throw new Error("A cached cloud projection event exceeds the transport byte bound.");
            }
            reachedByteLimit = true;
            break;
          }
          events.push(event);
        }
        if (reachedByteLimit || events.length >= limit) break;
      }
      const lastReturned = events.at(-1)?.sequence ?? afterSequence;
      return { complete: lastReturned >= ledger.localHead, events };
    });
    return read.immediate();
  }
}

function gitActions(actions: readonly string[]): readonly GitAction[] {
  const projected: GitAction[] = [];
  for (const action of actions) {
    const normalized = action.trim();
    let kind: GitAction["kind"] | undefined;
    if (/^git\s+status(?:\s|$)/u.test(normalized)) kind = "status";
    else if (/^git\s+diff(?:\s|$)/u.test(normalized)) kind = "diff";
    else if (/^git\s+branch(?:\s|$)/u.test(normalized)) kind = "branch";
    else if (/^git\s+commit(?:\s|$)/u.test(normalized)) kind = "commit";
    if (kind !== undefined) projected.push({ kind, label: boundedText(normalized, 120) });
    if (projected.length >= 32) break;
  }
  return projected;
}

function usageWindow(value: RateLimitSnapshot["primary"]): UsageWindow | null {
  if (
    value === null
    || value.resetsAt === null
    || value.windowDurationMins === null
    || !Number.isSafeInteger(value.windowDurationMins)
    || value.windowDurationMins <= 0
  ) return null;
  return {
    resetsAt: value.resetsAt < 100_000_000_000 ? value.resetsAt * 1_000 : value.resetsAt,
    usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
    windowDurationMinutes: value.windowDurationMins,
  };
}

function limitId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 96);
  return sanitized.length === 0 ? "primary" : sanitized;
}

function usageLimit(snapshot: RateLimitSnapshot, fallbackId: string, individual: boolean): UsageLimit {
  const primary = usageWindow(snapshot.primary);
  const secondary = usageWindow(snapshot.secondary);
  const id = limitId(snapshot.limitId ?? fallbackId);
  const name = boundedText(snapshot.limitName ?? snapshot.planType ?? id, 96).trim();
  return {
    id,
    individual,
    name: name.length === 0 ? id : name,
    primary,
    reached: snapshot.rateLimitReachedType !== null,
    secondary,
    unlimited: primary === null && secondary === null,
  };
}

export function projectStoredUsage(payload: unknown): UsageProjection {
  payload = providerUsagePayload(payload);
  if (!isRecord(payload) || !isRecord(payload.rateLimits)) return { state: "failed" };
  try {
    const usage = parseAccountUsage(payload.usage);
    const rateLimits = parseRateLimits({
      rateLimits: payload.rateLimits.primary,
      rateLimitsByLimitId: payload.rateLimits.byLimitId,
    });
    const limits: UsageLimit[] = [usageLimit(rateLimits.primary, "primary", false)];
    for (const [key, snapshot] of Object.entries(rateLimits.byLimitId ?? {})) {
      if (limits.length >= USAGE_CLOUD_PROJECTION_MAX_LIMITS) break;
      const projected = usageLimit(snapshot, key, true);
      if (!limits.some((current) => current.id === projected.id)) limits.push(projected);
    }
    const projection: UsageProjection = {
      state: "ready",
      data: {
        currentStreakDays: usage.summary.currentStreakDays ?? 0,
        daily: [...(usage.dailyUsageBuckets ?? [])]
          .slice(-USAGE_CLOUD_PROJECTION_MAX_DAILY_ROWS),
        lifetimeTokens: usage.summary.lifetimeTokens ?? 0,
        limits,
        longestRunningTurnSeconds: usage.summary.longestRunningTurnSec ?? 0,
        longestStreakDays: usage.summary.longestStreakDays ?? 0,
        peakDailyTokens: usage.summary.peakDailyTokens ?? 0,
      },
    };
    return parseUsageProjection(projection) ?? { state: "failed" };
  } catch {
    return { state: "failed" };
  }
}

function completedProjectionTurns(
  store: StateStore,
  session: SessionRecord,
  projection: CodexSessionProjection,
  requireIdle = false,
): readonly Readonly<{
  baseline: CompactProjectionBaseline;
  bodies: readonly CompactSessionEventBody[];
}>[] {
  if (
    requireIdle
    && projection.turnSummaries?.some((summary) => summary.status === "inProgress") === true
  ) {
    throw new Error("Cloud projection recovery requires an idle provider session.");
  }
  const messagesByTurn = new Map<string, CompactSessionEventBody[]>();
  const unsettledProfileTurnIds = new Set<string>();
  for (const message of projection.messages ?? []) {
    if (message.turnId === undefined || !isOpaqueIdentifier(message.turnId)) continue;
    if (
      message.role === "user"
      && message.clientId !== undefined
      && (message.clientId.startsWith("attempt_") || message.clientId.startsWith("queue_"))
      && store.runtimeProfileSourceRequiresSettlement(session.id, message.clientId)
    ) unsettledProfileTurnIds.add(message.turnId);
    const messages = messagesByTurn.get(message.turnId) ?? [];
    messages.push({
      kind: message.role === "user" ? "user_message" : "assistant_message",
      text: boundedText(message.text, 64_000),
      turnId: message.turnId,
    });
    messagesByTurn.set(message.turnId, messages);
  }
  const incompleteTurnIds = new Set(projection.omission?.incompleteTurnIds ?? []);
  const unreadItemTurnIds = new Set(projection.omission?.unreadItemTurnIds ?? []);
  const turns: Array<Readonly<{
    baseline: CompactProjectionBaseline;
    bodies: readonly CompactSessionEventBody[];
  }>> = [];
  const seen = new Set<string>();
  for (const summary of projection.turnSummaries ?? []) {
    if (
      summary.status === "inProgress"
      || (requireIdle && summary.status !== "completed")
      || !isOpaqueIdentifier(summary.id)
    ) continue;
    if (
      incompleteTurnIds.has(summary.id)
      || (requireIdle && unreadItemTurnIds.has(summary.id))
      || unsettledProfileTurnIds.has(summary.id)
    ) continue;
    if (seen.has(summary.id)) throw new Error("The Codex runtime repeated a completed turn identity.");
    seen.add(summary.id);
    const runtimeProfile = store.runtimeProfileForTurn(session.id, summary.id);
    const filesTouched = [...new Set(summary.files.filter(isProjectRelativePath))].slice(0, 128);
    const bodies = [...(messagesByTurn.get(summary.id) ?? [])];
    bodies.push({
      ...(runtimeProfile === null ? {} : { fast: runtimeProfile.fast }),
      filesTouched,
      gitActions: gitActions(summary.actions),
      kind: "turn_summary",
      ...(runtimeProfile === null ? {} : { model: runtimeProfile.preset }),
      runtimeMs: Math.max(
        0,
        Math.min(7 * 24 * 60 * 60 * 1_000, Math.trunc(summary.runtimeMs ?? 0)),
      ),
      turnId: summary.id,
    });
    const parsed = parseCompactSessionEvents(
      bodies.map((body, index) => ({ ...body, sequence: index + 1 })),
    );
    if (parsed === null) throw new Error("Invalid bounded local session projection.");
    turns.push({
      baseline: { bodyDigest: sha256(JSON.stringify(bodies)), turnId: summary.id },
      bodies,
    });
  }
  if (turns.length > 128) throw new Error("Cloud projection recovery baseline is too large.");
  return turns;
}

function currentProjectionInteractions(
  store: StateStore,
  cache: CloudProjectionCache,
  session: SessionRecord,
): Readonly<{
  discoveryExpected: InteractionListPosition | null;
  discoveryNext: InteractionListPosition | null;
  interactions: readonly InteractionRecord[];
}> {
  const current = new Map<string, InteractionRecord>();
  const discoveryExpected = cache.interactionDiscoveryCursor(session.id);
  const newest = store.listInteractionPage({
    limit: 200,
    sessionId: session.id,
  });
  const discovery = discoveryExpected === null
    ? newest
    : store.listInteractionPage({
        after: discoveryExpected,
        limit: 200,
        sessionId: session.id,
      });
  for (const interaction of newest.interactions) {
    current.set(interaction.publicId, interaction);
  }
  for (const interaction of discovery.interactions) {
    current.set(interaction.publicId, interaction);
  }
  for (const interaction of observedProjectionInteractions(store, cache, session)) {
    current.set(interaction.publicId, interaction);
  }
  return {
    discoveryExpected,
    discoveryNext: discovery.nextPosition,
    interactions: orderedProjectionInteractions(current.values()),
  };
}

function observedProjectionInteractions(
  store: StateStore,
  cache: CloudProjectionCache,
  session: SessionRecord,
): readonly InteractionRecord[] {
  const observed: InteractionRecord[] = [];
  for (const interactionId of cache.observedInteractionIds(session.id)) {
    const interaction = store.requireInteraction(interactionId);
    if (interaction.sessionId !== session.id) {
      throw new Error("The projected interaction changed session authority.");
    }
    observed.push(interaction);
  }
  return orderedProjectionInteractions(observed);
}

function orderedProjectionInteractions(
  interactions: Iterable<InteractionRecord>,
): readonly InteractionRecord[] {
  return [...interactions].sort((left, right) =>
    left.updatedAt - right.updatedAt
      || left.requestedAt - right.requestedAt
      || left.publicId.localeCompare(right.publicId));
}

export type StateBackedCloudDaemonAdapterOptions = Readonly<{
  cloudIdentityNamespace?: string | null;
  codex: CodexRuntimePort;
  executeRemote: LocalExecuteRemote;
  now?: () => number;
  paths: StatePaths;
  store: StateStore;
}>;

export type CloudProjectionCacheStatus = Readonly<
  | { state: "ready" }
  | {
      affectedSessions: readonly string[];
      affectedSessionsTruncated: boolean;
      code: "STREAM_RECOVERY_REQUIRED";
      diagnostic: string;
      sessions: number;
      state: "degraded";
    }
  | {
      code: "CACHE_CORRUPT_OR_UNREADABLE" | "CACHE_NEWER_VERSION" | "CACHE_RECOVERY_IN_PROGRESS" | "CACHE_SYMLINK" | "CACHE_UNSAFE_AUTHORITY";
      diagnostic: string;
      state: "unavailable";
    }
>;

function projectionCacheFailure(error: unknown): Exclude<CloudProjectionCacheStatus, { state: "ready" }> {
  const message = error instanceof Error ? error.message : "";
  if (message === "The cloud projection cache cannot be a symbolic link.") {
    return { code: "CACHE_SYMLINK", diagnostic: message, state: "unavailable" };
  }
  if (message === "The cloud projection cache was created by a newer HRA version.") {
    return { code: "CACHE_NEWER_VERSION", diagnostic: message, state: "unavailable" };
  }
  if (message === "The cloud projection cache has unsafe filesystem authority.") {
    return {
      code: "CACHE_UNSAFE_AUTHORITY",
      diagnostic: "The cloud projection cache has unsafe filesystem authority. Local daemon features remain available.",
      state: "unavailable",
    };
  }
  return {
    code: "CACHE_CORRUPT_OR_UNREADABLE",
    diagnostic: "The cloud projection cache is corrupt or unavailable. Local daemon features remain available.",
    state: "unavailable",
  };
}

export class StateBackedCloudDaemonAdapter implements CloudDaemonLocalSourcePort, CloudCommandExecutorPort {
  #cache: CloudProjectionCache | null;
  readonly #cachePath: string;
  readonly #cacheFileName: string;
  #cacheStatus: CloudProjectionCacheStatus;
  readonly #codex: CodexRuntimePort;
  readonly #executeRemote: LocalExecuteRemote;
  readonly #paths: StatePaths;
  readonly #projectionErrors = new Map<string, Error>();
  readonly #projectionRecoveryErrors = new Set<string>();
  readonly #store: StateStore;

  constructor(options: StateBackedCloudDaemonAdapterOptions) {
    if (
      options.cloudIdentityNamespace !== undefined
      && options.cloudIdentityNamespace !== null
      && !/^[0-9a-f]{24}$/u.test(options.cloudIdentityNamespace)
    ) throw new Error("Cloud projection cache identity namespace is invalid.");
    this.#cacheFileName = options.cloudIdentityNamespace === undefined
      ? projectionCacheFileName
      : options.cloudIdentityNamespace === null
        ? "cloud-projection-unbound.sqlite"
        : `cloud-projection-${options.cloudIdentityNamespace}.sqlite`;
    this.#cachePath = join(options.paths.root, this.#cacheFileName);
    try {
      const recoveryStagingExists = !existsSync(this.#cachePath)
        && readdirSync(options.paths.root).some((name) =>
          name.startsWith(`${this.#cacheFileName}.recovery-`));
      if (recoveryStagingExists) {
        this.#cache = null;
        this.#cacheStatus = {
          code: "CACHE_RECOVERY_IN_PROGRESS",
          diagnostic: "Cloud transcript recovery is awaiting exact local cache activation. Local daemon features remain available.",
          state: "unavailable",
        };
      } else {
        this.#cache = new CloudProjectionCache(this.#cachePath);
        this.#cacheStatus = { state: "ready" };
      }
    } catch (error: unknown) {
      this.#cache = null;
      this.#cacheStatus = projectionCacheFailure(error);
    }
    this.#codex = options.codex;
    this.#executeRemote = options.executeRemote;
    this.#paths = options.paths;
    this.#store = options.store;
  }

  close(): void {
    this.#cache?.close();
  }

  projectionCacheStatus(): CloudProjectionCacheStatus {
    if (this.#cache === null) return this.#cacheStatus;
    if (this.#projectionRecoveryErrors.size > 0) {
      const affectedSessions = [...this.#projectionRecoveryErrors]
        .filter((sessionPublicId) => sessionIdSchema.safeParse(sessionPublicId).success)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, maximumProjectionRecoveryStatusSessions);
      return {
        affectedSessions,
        affectedSessionsTruncated: affectedSessions.length < this.#projectionRecoveryErrors.size,
        code: "STREAM_RECOVERY_REQUIRED",
        diagnostic: "Cloud transcript upload is paused for a mismatched stream. Local sessions, usage sync, remote reads, and remote commands remain available. Repair requires an explicit reseed that may discard cloud transcript history.",
        sessions: this.#projectionRecoveryErrors.size,
        state: "degraded",
      };
    }
    return this.#cacheStatus;
  }

  async planCompactProjectionRecovery(input: Readonly<{
    idempotencyKey: string;
    observedInteractionIds?: readonly string[];
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    baselineCompletedTurns: readonly CompactProjectionBaseline[];
    baselineInteractions: readonly CloudProjectionRecoveryBaselineInteraction[];
    localAuthority: CompactProjectionLocalAuthority;
    replacementCacheId: string;
    sessionPublicId: string;
    sourceCacheId: string | null;
  }>> {
    throwIfAborted(input.signal);
    const observedInteractionIds = parseRecoveryObservedInteractionIds(
      input.observedInteractionIds ?? [],
    );
    if (
      !isUuidV7(input.idempotencyKey)
      || !isOpaqueIdentifier(input.sessionPublicId)
    ) {
      throw new Error("Cloud projection recovery input is invalid.");
    }
    if (
      this.#cacheStatus.state === "unavailable"
      && (
        this.#cacheStatus.code === "CACHE_SYMLINK"
        || this.#cacheStatus.code === "CACHE_NEWER_VERSION"
        || this.#cacheStatus.code === "CACHE_UNSAFE_AUTHORITY"
      )
    ) throw new Error("Cloud projection recovery refuses unsafe cache authority.");
    const { profile, session } = this.#requireRecoverySession(input.sessionPublicId);
    if (
      this.#store.listUnsettledMutations({ sessionId: session.id }).length > 0
      || this.#store.listUnsettledQueueEffects(session.id).length > 0
      || this.#store.listQueue(session.id).some((entry) =>
        entry.state === "pending"
        || entry.state === "dispatching"
        || entry.state === "ambiguous")
    ) throw new Error("Cloud projection recovery requires settled local session effects.");
    const projection = await this.#codex.readSession({
      authority: authorityFor(this.#paths, profile.id, profile.processGeneration),
      providerThreadId: session.providerThreadId,
      detail: false,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
    const current = this.#requireRecoverySession(input.sessionPublicId, {
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: projection.providerUpdatedAt ?? null,
      sessionRevision: session.revision,
    });
    if (
      projection.providerThreadId !== session.providerThreadId
      || projection.status !== "idle"
      || projection.activeTurnId !== undefined
      || current.session.revision !== session.revision
    ) throw new Error("Cloud projection recovery provider authority changed during baseline read.");
    const turns = completedProjectionTurns(this.#store, current.session, projection, true);
    const baselineInteractions = [...observedInteractionIds]
      .sort((left, right) => left.localeCompare(right))
      .map((interactionId): CloudProjectionRecoveryBaselineInteraction => {
        const interaction = this.#store.requireInteraction(interactionId);
        if (interaction.sessionId !== current.session.id) {
          throw new Error("Cloud projection recovery interaction authority changed.");
        }
        return {
          blocking: interaction.blocking,
          interactionId: interaction.publicId,
          interactionKind: interaction.kind,
          revision: interaction.revision,
          state: interaction.state,
          summary: compactInteractionSummary(interaction.kind),
        };
      });
    return {
      baselineCompletedTurns: turns.map((turn) => turn.baseline),
      baselineInteractions: parseRecoveryBaselineInteractions(baselineInteractions),
      localAuthority: {
        profileGeneration: profile.processGeneration,
        profileId: profile.id,
        providerThreadId: session.providerThreadId,
        providerUpdatedAt: projection.providerUpdatedAt ?? null,
        sessionRevision: session.revision,
      },
      replacementCacheId: recoveryCacheId(input.idempotencyKey),
      sessionPublicId: session.id,
      sourceCacheId: this.#cache?.cacheId() ?? null,
    };
  }

  stageCompactProjectionRecovery(
    input: CompactProjectionRecoveryInstallation & Readonly<{
      signal: AbortSignal;
      sourceCacheId: string | null;
    }>,
  ): Promise<void> {
    throwIfAborted(input.signal);
    try {
      this.#requireRecoverySession(input.sessionPublicId, input.localAuthority);
      if (input.replacementCacheId !== recoveryCacheId(input.idempotencyKey)) {
        throw new Error("Cloud projection recovery cache identity changed.");
      }
      const stagingPath = recoveryStagingPath(
        this.#paths.root,
        this.#cacheFileName,
        input.idempotencyKey,
      );
      let expectedSourceIdentity: ProjectionFileIdentity | null = null;
      if (this.#cache !== null) {
        expectedSourceIdentity = this.#cache.fileIdentity();
        assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
        if (this.#cache.cacheId() !== input.sourceCacheId) {
          throw new Error("Cloud projection recovery source cache changed.");
        }
        for (const suffix of projectionSidecarSuffixes.slice(1)) {
          if (existsSync(`${this.#cachePath}${suffix}`)) {
            throw new Error("Cloud projection cache has an unsettled sidecar.");
          }
        }
      }
      if (existsSync(stagingPath)) {
        assertSafeProjectionFile(stagingPath);
        for (const suffix of projectionSidecarSuffixes.slice(1)) {
          const sidecarPath = `${stagingPath}${suffix}`;
          if (existsSync(sidecarPath)) assertSafeProjectionFile(sidecarPath);
        }
        const priorStaging = new CloudProjectionCache(stagingPath);
        let isExactOrRecoverablePartial = false;
        try {
          isExactOrRecoverablePartial = priorStaging.hasRecoveryInstallation(input)
            || (input.sourceCacheId === null
              ? priorStaging.isEmptyRecoverySource()
              : priorStaging.cacheId() === input.sourceCacheId);
        } finally {
          priorStaging.close();
        }
        if (!isExactOrRecoverablePartial) {
          throw new Error("Cloud projection recovery staging cache changed.");
        }
        for (const suffix of projectionSidecarSuffixes.slice(1)) {
          if (existsSync(`${stagingPath}${suffix}`)) {
            throw new Error("Cloud projection recovery staging cache has an unsettled sidecar.");
          }
        }
        assertSafeProjectionFile(stagingPath);
        unlinkSync(stagingPath);
        syncProjectionDirectory(this.#paths.root);
      }
      if (this.#cache !== null && expectedSourceIdentity !== null) {
        assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
        copyFileSync(this.#cachePath, stagingPath, fsConstants.COPYFILE_EXCL);
        chmodSync(stagingPath, 0o600);
        try {
          assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
        } catch (error: unknown) {
          assertSafeProjectionFile(stagingPath);
          unlinkSync(stagingPath);
          syncProjectionDirectory(this.#paths.root);
          throw error;
        }
      } else {
        const staging = new CloudProjectionCache(stagingPath);
        staging.close();
      }
      assertSafeProjectionFile(stagingPath);
      const staging = new CloudProjectionCache(stagingPath);
      try {
        staging.initializeRecovery(input);
      } finally {
        staging.close();
      }
      syncProjectionDirectory(this.#paths.root);
      throwIfAborted(input.signal);
      return Promise.resolve();
    } catch (error: unknown) {
      if (input.signal.aborted) throw input.signal.reason;
      return Promise.reject(boundedProjectionRecoveryError(error));
    }
  }

  activateCompactProjectionRecovery(
    input: CompactProjectionRecoveryInstallation & Readonly<{
      signal: AbortSignal;
      sourceCacheId: string | null;
    }>,
  ): Promise<void> {
    throwIfAborted(input.signal);
    try {
      this.#requireRecoverySession(input.sessionPublicId, input.localAuthority);
      if (input.replacementCacheId !== recoveryCacheId(input.idempotencyKey)) {
        throw new Error("Cloud projection recovery cache identity changed.");
      }
      if (this.#cache !== null) {
        assertProjectionFileIdentity(this.#cachePath, this.#cache.fileIdentity());
      }
      if (this.#cache?.hasRecoveryInstallation(input) === true) {
        const currentCache = this.#cache;
        const expectedIdentity = currentCache.fileIdentity();
        assertProjectionFileIdentity(this.#cachePath, expectedIdentity);
        const reopened = new CloudProjectionCache(this.#cachePath);
        if (
          !sameProjectionFileIdentity(reopened.fileIdentity(), expectedIdentity)
          || !reopened.hasRecoveryInstallation(input)
        ) {
          reopened.close();
          throw new Error("Cloud projection recovery destination changed.");
        }
        assertProjectionFileIdentity(this.#cachePath, expectedIdentity);
        currentCache.close();
        this.#cache = reopened;
        syncProjectionDirectory(this.#paths.root);
        this.#projectionRecoveryErrors.delete(input.sessionPublicId);
        this.#projectionErrors.delete(input.sessionPublicId);
        this.#cacheStatus = { state: "ready" };
        return Promise.resolve();
      }
      if (this.#cache === null && existsSync(this.#cachePath)) {
        let installed: CloudProjectionCache | null = null;
        try {
          installed = new CloudProjectionCache(this.#cachePath);
        } catch (error: unknown) {
          const currentFailure = projectionCacheFailure(error);
          if (
            input.sourceCacheId !== null
            || this.#cacheStatus.state !== "unavailable"
            || this.#cacheStatus.code !== "CACHE_CORRUPT_OR_UNREADABLE"
            || currentFailure.code !== "CACHE_CORRUPT_OR_UNREADABLE"
          ) throw error;
          // The exact recovery was prepared from an unreadable original cache.
          // That same path is preserved until the verified staging ledger is
          // atomically installed below.
        }
        if (installed !== null) {
          if (installed.hasRecoveryInstallation(input)) {
            syncProjectionDirectory(this.#paths.root);
            this.#cache = installed;
            this.#projectionRecoveryErrors.delete(input.sessionPublicId);
            this.#projectionErrors.delete(input.sessionPublicId);
            this.#cacheStatus = { state: "ready" };
            return Promise.resolve();
          }
          installed.close();
          throw new Error("Cloud projection recovery destination changed.");
        }
      }
      const stagingPath = recoveryStagingPath(
        this.#paths.root,
        this.#cacheFileName,
        input.idempotencyKey,
      );
      if (!existsSync(stagingPath)) {
        throw new Error("Cloud projection recovery staging cache is unavailable.");
      }
      assertSafeProjectionFile(stagingPath);
      const staging = new CloudProjectionCache(stagingPath);
      try {
        if (!staging.hasRecoveryInstallation(input)) {
          throw new Error("Cloud projection recovery staging cache changed.");
        }
      } finally {
        staging.close();
      }
      let expectedSourceIdentity: ProjectionFileIdentity | null = null;
      if (this.#cache !== null) {
        if (this.#cache.cacheId() !== input.sourceCacheId) {
          throw new Error("Cloud projection recovery source cache changed.");
        }
        expectedSourceIdentity = this.#cache.fileIdentity();
        assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
        const currentSource = new CloudProjectionCache(this.#cachePath);
        try {
          if (
            !sameProjectionFileIdentity(currentSource.fileIdentity(), expectedSourceIdentity)
            || currentSource.cacheId() !== input.sourceCacheId
          ) throw new Error("Cloud projection recovery source cache changed.");
        } finally {
          currentSource.close();
        }
        assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
      }
      this.#cacheStatus = {
        code: "CACHE_RECOVERY_IN_PROGRESS",
        diagnostic: "Cloud transcript recovery is awaiting exact local cache activation. Local daemon features remain available.",
        state: "unavailable",
      };
      this.#cache?.close();
      this.#cache = null;
      const quarantinePath = recoveryQuarantinePath(
        this.#paths.root,
        this.#cacheFileName,
        input.idempotencyKey,
      );
      for (const suffix of projectionSidecarSuffixes) {
        const source = `${this.#cachePath}${suffix}`;
        const target = `${quarantinePath}${suffix}`;
        const sourceExists = existsSync(source);
        const targetExists = existsSync(target);
        if (sourceExists && targetExists) {
          throw new Error("Cloud projection recovery quarantine conflicts.");
        }
        if (sourceExists) {
          const sourceIdentity = assertSafeProjectionFile(source);
          if (
            suffix === ""
            && expectedSourceIdentity !== null
            && !sameProjectionFileIdentity(sourceIdentity, expectedSourceIdentity)
          ) throw new Error("Cloud projection recovery source cache changed.");
          renameSync(source, target);
          const quarantinedIdentity = assertSafeProjectionFile(target);
          if (
            suffix === ""
            && expectedSourceIdentity !== null
            && !sameProjectionFileIdentity(quarantinedIdentity, expectedSourceIdentity)
          ) throw new Error("Cloud projection recovery source cache changed during activation.");
        } else if (targetExists) {
          const quarantinedIdentity = assertSafeProjectionFile(target);
          if (
            suffix === ""
            && expectedSourceIdentity !== null
            && !sameProjectionFileIdentity(quarantinedIdentity, expectedSourceIdentity)
          ) throw new Error("Cloud projection recovery quarantine changed.");
        }
      }
      syncProjectionDirectory(this.#paths.root);
      if (existsSync(this.#cachePath)) {
        throw new Error("Cloud projection recovery destination changed.");
      }
      renameSync(stagingPath, this.#cachePath);
      chmodSync(this.#cachePath, 0o600);
      syncProjectionDirectory(this.#paths.root);
      const installed = new CloudProjectionCache(this.#cachePath);
      if (!installed.hasRecoveryInstallation(input)) {
        installed.close();
        throw new Error("Cloud projection recovery activation changed.");
      }
      this.#cache = installed;
      this.#cacheStatus = { state: "ready" };
      this.#projectionRecoveryErrors.delete(input.sessionPublicId);
      this.#projectionErrors.delete(input.sessionPublicId);
      throwIfAborted(input.signal);
      return Promise.resolve();
    } catch (error: unknown) {
      if (input.signal.aborted) throw input.signal.reason;
      return Promise.reject(boundedProjectionRecoveryError(error));
    }
  }

  discardCompactProjectionRecovery(input: Readonly<{
    idempotencyKey: string;
    sessionPublicId: string;
  }>): Promise<void> {
    if (!isUuidV7(input.idempotencyKey) || !isOpaqueIdentifier(input.sessionPublicId)) {
      return Promise.reject(new Error("Cloud projection recovery discard authority is invalid."));
    }
    try {
      const stagingPath = recoveryStagingPath(
        this.#paths.root,
        this.#cacheFileName,
        input.idempotencyKey,
      );
      let changed = false;
      for (const suffix of [...projectionSidecarSuffixes].reverse()) {
        const path = `${stagingPath}${suffix}`;
        if (!existsSync(path)) continue;
        assertSafeProjectionFile(path);
        unlinkSync(path);
        changed = true;
      }
      if (changed) syncProjectionDirectory(this.#paths.root);
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(boundedProjectionRecoveryError(error));
    }
  }

  isSessionTerminal(sessionPublicId: string): boolean {
    if (!isOpaqueIdentifier(sessionPublicId)) return false;
    try {
      return this.#store.requireSession(sessionPublicId).state === "terminal";
    } catch {
      return false;
    }
  }

  #requireRecoverySession(
    sessionPublicId: string,
    expected?: CompactProjectionLocalAuthority,
  ): Readonly<{ profile: ProfileRecord; session: SessionRecord & { providerThreadId: string } }> {
    const session = this.#store.requireSession(sessionPublicId);
    const profile = this.#store.requireProfileById(session.profileId);
    if (
      session.id !== sessionPublicId
      || session.providerThreadId === undefined
      || session.state !== "idle"
      || profile.state !== "signed_in"
      || profile.processGeneration < 1
      || (expected !== undefined && (
        profile.id !== expected.profileId
        || profile.processGeneration !== expected.profileGeneration
        || session.providerThreadId !== expected.providerThreadId
        || session.providerUpdatedAt !== (expected.providerUpdatedAt ?? undefined)
        || session.revision !== expected.sessionRevision
      ))
    ) throw new Error("Cloud projection recovery local authority changed.");
    return { profile, session: session as SessionRecord & { providerThreadId: string } };
  }

  async listSessions(input: Readonly<{
    afterPublicId?: string | null;
    limit: number;
    signal: AbortSignal;
  }>): Promise<CloudLocalSessionPage> {
    if (input.signal.aborted) throw input.signal.reason;
    const cache = this.#cache;
    const page = this.#store.listCloudSessionPage({
      afterId: input.afterPublicId ?? null,
      limit: input.limit,
    });
    const heads: CloudLocalSessionHead[] = [];
    for (const session of page.sessions) {
      const state = terminalSessionState(session);
      if (state === null || session.providerThreadId === undefined) continue;
      const profile = this.#store.requireProfileById(session.profileId);
      if (profile.state === "removed") continue;
      const canReadProvider = profile.state === "signed_in" && profile.processGeneration >= 1;
      if (profile.state === "signed_in" && !canReadProvider) continue;
      let includeHead = canReadProvider;
      if (cache !== null) {
        if (!canReadProvider) {
          try {
            for (const interaction of observedProjectionInteractions(this.#store, cache, session)) {
              if (interaction.terminalAt !== null) cache.ingestInteraction(session.id, interaction);
            }
            this.#projectionErrors.delete(session.id);
            includeHead = cache.hasUncommittedEvents(session.id);
          } catch (error: unknown) {
            if (error instanceof ProjectionStreamRecoveryError) {
              this.#projectionRecoveryErrors.add(session.id);
            }
            this.#projectionErrors.set(
              session.id,
              error instanceof Error ? error : new Error("Local cloud session projection failed."),
            );
          }
        } else {
          let projectionError: Error | undefined;
          try {
            const projection = await this.#codex.readSession({
              authority: authorityFor(this.#paths, profile.id, profile.processGeneration),
              providerThreadId: session.providerThreadId,
              detail: false,
              signal: input.signal,
            });
            throwIfAborted(input.signal);
            if (projection.providerThreadId !== session.providerThreadId) {
              throw new Error("The Codex runtime returned a session under different authority.");
            }
            for (const turn of completedProjectionTurns(this.#store, session, projection)) {
              cache.ingestTurn(session.id, turn.baseline.turnId, turn.bodies);
            }
          } catch (error: unknown) {
            rethrowWhenAborted(input.signal, error);
            projectionError = error instanceof Error
              ? error
              : new Error("Local cloud session projection failed.");
          }
          try {
            const current = projectionError === undefined
              ? currentProjectionInteractions(this.#store, cache, session)
              : null;
            const interactions = current?.interactions
              ?? observedProjectionInteractions(this.#store, cache, session)
                .filter((interaction) => interaction.terminalAt !== null);
            for (const interaction of interactions) {
              cache.ingestInteraction(session.id, interaction);
            }
            if (current !== null) {
              cache.advanceInteractionDiscoveryCursor(
                session.id,
                current.discoveryExpected,
                current.discoveryNext,
              );
            }
          } catch (error: unknown) {
            projectionError ??= error instanceof Error
              ? error
              : new Error("Local cloud session projection failed.");
          }
          if (projectionError === undefined) {
            this.#projectionErrors.delete(session.id);
          } else {
            if (projectionError instanceof ProjectionStreamRecoveryError) {
              this.#projectionRecoveryErrors.add(session.id);
            }
            this.#projectionErrors.set(session.id, projectionError);
          }
        }
      }
      if (!includeHead) continue;
      heads.push({
        createdAt: session.createdAt,
        metadata: { name: boundedName(session.title), note: boundedNote(session.note) },
        publicId: session.id,
        state,
        updatedAt: session.updatedAt,
      });
    }
    return {
      continueAfterPublicId: page.continueAfterId,
      isDone: page.isDone,
      sessions: heads,
    };
  }

  readCompactEvents(input: Readonly<{
    afterSequence: number;
    limit: number;
    remoteStreamEpoch?: number;
    remoteTailDigest?: string;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    cacheId: string;
    complete: boolean;
    events: readonly CompactSessionEvent[];
  }>> {
    if (input.signal.aborted) return Promise.reject(input.signal.reason);
    const projectionError = this.#projectionErrors.get(input.sessionPublicId);
    if (projectionError !== undefined) {
      if (projectionError instanceof ProjectionStreamRecoveryError) {
        this.#projectionRecoveryErrors.add(input.sessionPublicId);
      }
      return Promise.reject(projectionError);
    }
    if (this.#cache === null) {
      return Promise.reject(new Error(this.#cacheStatus.state === "unavailable"
        ? this.#cacheStatus.diagnostic
        : "The cloud projection cache is unavailable."));
    }
    try {
      const value = this.#cache.read(
        input.sessionPublicId,
        input.afterSequence,
        input.remoteTailDigest,
        input.remoteStreamEpoch ?? 0,
        input.limit,
      );
      return Promise.resolve({ cacheId: this.#cache.cacheId(), ...value });
    } catch (error: unknown) {
      if (error instanceof ProjectionStreamRecoveryError) {
        this.#projectionRecoveryErrors.add(input.sessionPublicId);
      }
      return Promise.reject(error);
    }
  }

  recordCompactUploadIntent(input: CompactUploadCheckpoint): Promise<void> {
    if (this.#cache === null) return Promise.reject(new Error("The cloud projection cache is unavailable."));
    try {
      this.#cache.recordUploadIntent(input);
      return Promise.resolve();
    } catch (error: unknown) {
      if (error instanceof ProjectionStreamRecoveryError) {
        this.#projectionRecoveryErrors.add(input.sessionPublicId);
      }
      return Promise.reject(error);
    }
  }

  acknowledgeCompactUpload(input: CompactUploadCheckpoint): Promise<void> {
    if (this.#cache === null) return Promise.reject(new Error("The cloud projection cache is unavailable."));
    try {
      this.#cache.acknowledgeUpload(input);
      return Promise.resolve();
    } catch (error: unknown) {
      if (error instanceof ProjectionStreamRecoveryError) {
        this.#projectionRecoveryErrors.add(input.sessionPublicId);
      }
      return Promise.reject(error);
    }
  }

  async listUsage(input: Readonly<{ limit: number; signal: AbortSignal }>): Promise<readonly CloudLocalUsageSnapshot[]> {
    if (input.signal.aborted) throw input.signal.reason;
    const snapshots: CloudLocalUsageSnapshot[] = [];
    const profiles = this.#store.listProfiles().filter((profile) =>
      profile.state === "signed_in"
      && profile.processGeneration > 0
      && profile.providerEmail !== undefined,
    );
    for (const profile of profiles.slice(0, input.limit)) {
      const latest = this.#store.latestUsage(profile.id);
      if (latest === null || profile.providerEmail === undefined) continue;
      snapshots.push({
        localReference: profile.id,
        matchReference: profile.providerEmail,
        metadata: {
          label: boundedText(profile.label, 160),
          email: boundedText(profile.providerEmail, 320),
          plan: profile.providerPlan === undefined ? null : boundedText(profile.providerPlan, 160),
        },
        observedAt: latest.observedAt,
        projection: projectStoredUsage(latest.payload),
        sourceGeneration: profile.processGeneration,
        sourceRevision: latest.sourceRevision,
      });
    }
    return snapshots;
  }

  async listUsageHistory(input: Readonly<{
    afterSourceRevision: number;
    limit: number;
    localReference: string;
    signal: AbortSignal;
    sourceGeneration: number;
  }>): Promise<readonly CloudLocalUsageSnapshot[]> {
    if (input.signal.aborted) throw input.signal.reason;
    const profile = this.#store.requireProfileById(input.localReference);
    if (
      profile.state !== "signed_in"
      || profile.processGeneration !== input.sourceGeneration
      || profile.providerEmail === undefined
    ) return [];
    const providerEmail = profile.providerEmail;
    const metadata = {
      label: boundedText(profile.label, 160),
      email: boundedText(providerEmail, 320),
      plan: profile.providerPlan === undefined ? null : boundedText(profile.providerPlan, 160),
    } as const;
    return this.#store.usageAfterRevision({
      afterSourceRevision: input.afterSourceRevision,
      limit: input.limit,
      profileId: profile.id,
    }).map((snapshot) => ({
      localReference: profile.id,
      matchReference: providerEmail,
      metadata,
      observedAt: snapshot.observedAt,
      projection: projectStoredUsage(snapshot.payload),
      sourceGeneration: profile.processGeneration,
      sourceRevision: snapshot.sourceRevision,
    }));
  }

  resolveCommandAuthority(input: Readonly<{
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudLocalCommandAuthority | null> {
    if (input.signal.aborted) return Promise.reject(input.signal.reason);
    try {
      const session = this.#store.requireSession(input.sessionPublicId);
      const profile = this.#store.requireProfileById(session.profileId);
      if (
        session.id !== input.sessionPublicId
        || session.providerThreadId === undefined
        || session.state === "starting"
        || session.state === "recovery_required"
        || profile.state !== "signed_in"
        || profile.processGeneration < 1
      ) return Promise.resolve(null);
      return Promise.resolve({
        localSessionId: session.id,
        profileGeneration: profile.processGeneration,
        profileId: profile.id,
        providerThreadId: session.providerThreadId,
      });
    } catch {
      return Promise.resolve(null);
    }
  }

  async execute(input: Readonly<{
    authority: CloudLocalCommandAuthority;
    idempotencyKey: string;
    leaseAuthority: AuthorityTuple;
    payload: Parameters<CloudCommandExecutorPort["execute"]>[0]["payload"];
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudCommandExecutionResult> {
    if (input.signal.aborted) throw input.signal.reason;
    try {
      const session = this.#store.requireSession(input.sessionPublicId);
      const profile = this.#store.requireProfileById(session.profileId);
      if (
        session.id !== input.sessionPublicId
        || session.id !== input.authority.localSessionId
        || profile.id !== input.authority.profileId
        || profile.processGeneration !== input.authority.profileGeneration
        || session.providerThreadId === undefined
        || session.providerThreadId !== input.authority.providerThreadId
        || session.state === "starting"
        || session.state === "recovery_required"
        || profile.state !== "signed_in"
      ) return { code: "LOCAL_AUTHORITY_CHANGED", state: "failed" };

      let command: ProviderRemoteLocalCommand;
      switch (input.payload.kind) {
          case "send":
            command = { kind: "session.send", session: session.id, message: input.payload.message, idempotencyKey: input.idempotencyKey };
            break;
          case "queue":
            command = { kind: "session.queue", session: session.id, message: input.payload.message, idempotencyKey: input.idempotencyKey };
            break;
          case "steer":
            command = { kind: "session.steer", session: session.id, message: input.payload.message, idempotencyKey: input.idempotencyKey };
            break;
          case "stop":
            command = { kind: "session.stop", session: session.id, idempotencyKey: input.idempotencyKey };
            break;
          case "set_model":
            command = { kind: "session.preset", session: session.id, preset: input.payload.preset, idempotencyKey: input.idempotencyKey };
            break;
          case "set_fast":
            command = { kind: "session.fast", session: session.id, enabled: input.payload.enabled, idempotencyKey: input.idempotencyKey };
            break;
      }
      await this.#executeRemote(command, {
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        providerThreadId: session.providerThreadId,
        sessionId: session.id,
      }, { signal: input.signal });
      return { code: "APPLIED", state: "applied" };
    } catch (error: unknown) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
      if (code === "RECOVERY_REQUIRED" || code === "INTERNAL" || code === "UNKNOWN") {
        return { code: `LOCAL_${code}`.slice(0, 64), state: "ambiguous" };
      }
      return { code: `LOCAL_${code.replace(/[^A-Z0-9_]/gu, "_")}`.slice(0, 64), state: "failed" };
    }
  }
}

export class BridgedCloudControl implements CloudControlPort, CloudRemoteControlPort {
  readonly #bridge: CloudDaemonBridge;
  readonly #control: CloudControlPort & CloudRemoteControlPort;
  readonly #projectionStatus: (() => CloudProjectionCacheStatus) | undefined;

  constructor(
    control: CloudControlPort & CloudRemoteControlPort,
    bridge: CloudDaemonBridge,
    projectionDiagnostics?: Readonly<{ projectionCacheStatus(): CloudProjectionCacheStatus }>,
  ) {
    this.#control = control;
    this.#bridge = bridge;
    this.#projectionStatus = projectionDiagnostics === undefined
      ? undefined
      : () => projectionDiagnostics.projectionCacheStatus();
  }

  async status(signal: AbortSignal): Promise<unknown> {
    const status = await this.#control.status(signal);
    const projectionCache = this.#projectionStatus?.();
    const projectionRecovery = await this.#bridge.projectionRecoveryStatus?.();
    if (projectionCache === undefined && projectionRecovery === undefined) return status;
    return isRecord(status)
      ? {
          ...status,
          ...(projectionCache === undefined ? {} : { projectionCache }),
          ...(projectionRecovery === undefined ? {} : { projectionRecovery }),
        }
      : {
          control: status,
          ...(projectionCache === undefined ? {} : { projectionCache }),
          ...(projectionRecovery === undefined ? {} : { projectionRecovery }),
        };
  }
  async auth(input: { email: string; code?: string; invite?: string; signal: AbortSignal }): Promise<unknown> {
    if (input.code !== undefined) {
      if (this.#bridge.close === undefined) {
        throw new Error("Cloud identity changes require a quiescent daemon bridge.");
      }
      await this.#bridge.close();
    }
    const value = await this.#control.auth(input);
    return input.code !== undefined && isRecord(value) && value.signedIn === true
      ? { ...value, daemonRestartRequired: true }
      : value;
  }
  logout(signal: AbortSignal): Promise<void> { return this.#control.logout(signal); }
  async deleteAccount(input: { acknowledgeErasure: boolean; signal: AbortSignal }): Promise<unknown> {
    if (this.#bridge.close === undefined) {
      throw new Error("Cloud account erasure requires a quiescent daemon bridge.");
    }
    await this.#bridge.close();
    const value = await this.#control.deleteAccount(input);
    return isRecord(value)
      ? { ...value, daemonRestartRequired: true }
      : { daemonRestartRequired: true };
  }
  listDevices(signal: AbortSignal): Promise<unknown> { return this.#control.listDevices(signal); }
  pairDevice(signal: AbortSignal): Promise<unknown> { return this.#control.pairDevice(signal); }
  acknowledgeNoAccountKeyHolders(signal: AbortSignal): Promise<unknown> {
    return this.#control.acknowledgeNoAccountKeyHolders(signal);
  }
  approveDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown> {
    return this.#control.approveDevice(device, idempotencyKey, signal);
  }
  revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown> {
    return this.#control.revokeDevice(device, idempotencyKey, signal);
  }
  listRemoteSessionHeads(input: Readonly<{ limit: number; signal: AbortSignal }>): Promise<Readonly<{
    sessions: readonly CloudRemoteSessionHead[];
    truncated: boolean;
  }>> { return this.#control.listRemoteSessionHeads(input); }
  resolveRemoteSession(input: Parameters<CloudRemoteControlPort["resolveRemoteSession"]>[0]): Promise<CloudRemoteSessionSelector> {
    return this.#control.resolveRemoteSession(input);
  }
  pullRemoteSession(input: Readonly<{
    selector: CloudRemoteSessionSelector;
    signal: AbortSignal;
  }>): Promise<CloudRemoteSessionProjection> { return this.#control.pullRemoteSession(input); }
  getRemoteCommandStatus(input: Parameters<CloudRemoteControlPort["getRemoteCommandStatus"]>[0]): Promise<CloudRemoteCommandStatus> {
    return this.#control.getRemoteCommandStatus(input);
  }
  enqueueRemoteCommand(input: Parameters<CloudRemoteControlPort["enqueueRemoteCommand"]>[0]): Promise<CloudRemoteCommandReceipt> {
    return this.#control.enqueueRemoteCommand(input);
  }
  isCompactProjectionRecoveryUnsettled(
    sessionPublicId: Parameters<CloudControlPort[
      "isCompactProjectionRecoveryUnsettled"
    ]>[0],
  ): Promise<boolean> {
    if (this.#bridge.isCompactProjectionRecoveryUnsettled === undefined) {
      return Promise.resolve(true);
    }
    return this.#bridge.isCompactProjectionRecoveryUnsettled(sessionPublicId);
  }
  isCompactProjectionRecoveryUnsettledForProfile(
    profileId: Parameters<CloudControlPort[
      "isCompactProjectionRecoveryUnsettledForProfile"
    ]>[0],
  ): Promise<boolean> {
    if (this.#bridge.isCompactProjectionRecoveryUnsettledForProfile === undefined) {
      return Promise.resolve(true);
    }
    return this.#bridge.isCompactProjectionRecoveryUnsettledForProfile(profileId);
  }
  supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: Parameters<CloudControlPort[
      "supersedeCompactProjectionRecoveryForProviderDeletion"
    ]>[0],
  ): Promise<{ superseded: boolean }> {
    if (this.#bridge.supersedeCompactProjectionRecoveryForProviderDeletion === undefined) {
      return Promise.reject(new Error("Cloud projection recovery supersession is unavailable."));
    }
    return this.#bridge
      .supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId);
  }
  supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    if (this.#bridge.supersedeTerminalCompactProjectionRecoveries === undefined) {
      return Promise.reject(new Error("Cloud projection recovery supersession is unavailable."));
    }
    return this.#bridge.supersedeTerminalCompactProjectionRecoveries();
  }
  readCompactProjectionRecoveryReceipt(
    input: Parameters<NonNullable<CloudControlPort["readCompactProjectionRecoveryReceipt"]>>[0],
  ): ReturnType<NonNullable<CloudControlPort["readCompactProjectionRecoveryReceipt"]>> {
    if (this.#bridge.readCompactProjectionRecoveryReceipt === undefined) {
      return Promise.resolve({ status: "absent" });
    }
    return this.#bridge.readCompactProjectionRecoveryReceipt(input);
  }
  recoverCompactProjection(
    input: Parameters<CloudControlPort["recoverCompactProjection"]>[0],
  ): Promise<unknown> {
    if (this.#bridge.recoverCompactProjection === undefined) {
      return Promise.reject(new Error("Cloud projection recovery is unavailable."));
    }
    return this.#bridge.recoverCompactProjection(input);
  }

  async sync(signal: AbortSignal): Promise<unknown> {
    const daemon = await this.#bridge.cycle(signal);
    const value = await this.#control.sync(signal);
    if (
      !isRecord(value)
      || !Number.isSafeInteger(value.accountCount)
      || (value.accountCount as number) < 0
      || !Number.isSafeInteger(value.sessionCount)
      || (value.sessionCount as number) < 0
      || value.synced !== true
      || typeof value.syncedAt !== "number"
      || !Number.isFinite(value.syncedAt)
      || typeof value.truncated !== "boolean"
      || !Number.isSafeInteger(value.usageSnapshotCount)
      || (value.usageSnapshotCount as number) < 0
    ) throw new Error("Cloud sync summary is invalid.");
    const control = {
      accountCount: value.accountCount,
      sessionCount: value.sessionCount,
      synced: true,
      syncedAt: value.syncedAt,
      truncated: value.truncated,
      usageSnapshotCount: value.usageSnapshotCount,
    };
    return {
      control,
      daemon: {
        commandsApplied: daemon.commandsApplied,
        commandsUnsettled: daemon.commandsUnsettled,
        errors: daemon.errors.slice(0, 32),
        online: daemon.online,
        remoteSessionCount: daemon.remoteSessions.length,
        sessionsUploaded: daemon.sessionsUploaded,
        usageUploaded: daemon.usageUploaded,
      },
    };
  }
}
