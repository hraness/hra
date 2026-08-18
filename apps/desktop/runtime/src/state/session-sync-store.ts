import type { Database } from "bun:sqlite";
import {
  MAX_SYNC_DIRECTORY_SESSIONS,
  MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE,
  MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS,
  acceptedSessionHeadSchema,
  allocateSessionSyncNonce,
  canonicalSessionSyncJson,
  createSessionSyncNonceState,
  decodeSyncUint64,
  encodeSyncUint64,
  nextSyncUint64,
  positiveSyncUint64Schema,
  sealedSessionSummarySchema,
  sessionDirectoryChangePageSchema,
  sessionDirectoryChangeSchema,
  sessionDirectoryCursorSchema,
  sessionDirectoryEntrySchema,
  sessionDirectorySnapshotPageSchema,
  sessionPublicIdSchema,
  sessionSyncEventKindSchema,
  sessionSyncBackendErrorCodeSchema,
  sessionSyncNonceStateSchema,
  syncBootIdSchema,
  syncDeviceIdSchema,
  syncDevicePublicKeysSchema,
  syncMembershipHeadSchema,
  syncSha256DigestSchema,
  syncUint64Schema,
  syncVaultCoordinateSchema,
  wrappedSyncVaultRootKeySchema,
  type AcceptedSessionHead,
  type PositiveSyncUint64,
  type SealedSessionSummary,
  type SessionDirectoryChange,
  type SessionDirectoryChangePage,
  type SessionDirectoryCursor,
  type SessionDirectoryEntry,
  type SessionDirectorySnapshotPage,
  type SessionPublicId,
  type SessionSyncEventKind,
  type SessionSyncBackendErrorCode,
  type SessionSyncNonceAllocation,
  type SessionSyncNonceState,
  type SyncBootId,
  type SyncDeviceId,
  type SyncDevicePublicKeys,
  type SyncMembershipHead,
  type SyncSha256Digest,
  type SyncVaultCoordinate,
  type WrappedSyncVaultRootKey,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

import {
  sealedLocalSessionSyncIntentSchema,
  type LocalSessionSyncIntent,
  type SealedLocalSessionSyncIntent,
} from "../cloud/session-sync-local-crypto";
import {
  SESSION_SYNC_HARDENING_SCHEMA_SQL,
  SESSION_SYNC_HUMAN_SCOPE_SCHEMA_SQL,
  SESSION_SYNC_OPERATION_SCHEMA_SQL,
  SESSION_SYNC_SCHEMA_SQL,
} from "./session-sync-schema";

const MAX_OUTBOX_INTENTS = 4_096;
const MAX_JITTER_RETRY_DELAY_MS = 60_000;
export const MAX_SESSION_SYNC_RETRY_DELAY_MS = 300_000;
const BASE_RETRY_DELAY_MS = 500;
const textEncoder = new TextEncoder();

const storedBooleanSchema = z.union([z.literal(0), z.literal(1)]);
const safeIntegerSchema = z.number().int().nonnegative().safe();
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const sessionSyncHumanAuthoritySchema = z.object({
  userId: z.string().min(1).max(256).refine((value) => !value.includes("\0")),
  organizationId: z.string().min(1).max(256).refine((value) => !value.includes("\0")),
}).strict();

const settingsRowSchema = z.object({
  revision: safeIntegerSchema,
  enabled: storedBooleanSchema,
  device_name: z.string().min(1).max(80),
  updated_at: safeIntegerSchema,
}).strict();

const deviceRowSchema = z.object({
  revision: safeIntegerSchema,
  enrollment_state: z.enum([
    "unregistered",
    "pending",
    "active",
    "revoked",
    "conflict",
    "update_required",
  ]),
  device_id: syncDeviceIdSchema.nullable(),
  public_keys_json: z.string().min(2).max(4_096),
  pending_enrollment_json: z.string().min(2).max(16_384).nullable(),
  credential_generation: safeIntegerSchema,
  updated_at: safeIntegerSchema,
}).strict();

const vaultRowSchema = z.object({
  revision: safeIntegerSchema,
  state: z.enum(["active", "conflict", "retired"]),
  tenant_id: z.string(),
  organization_id: z.string(),
  owner_user_id: z.string(),
  vault_id: z.string(),
  vault_generation: z.string(),
  membership_epoch: z.string(),
  membership_digest: z.string(),
  membership_head_json: z.string().min(2).max(131_072),
  wrapped_root_json: z.string().min(2).max(131_072),
  root_key_epoch: z.string(),
  human_user_id: z.string().min(1).max(256).nullable(),
  human_organization_id: z.string().min(1).max(256).nullable(),
  updated_at: safeIntegerSchema,
}).strict().superRefine((row, context) => {
  if ((row.human_user_id === null) !== (row.human_organization_id === null)) {
    context.addIssue({
      code: "custom",
      message: "session sync human authority is incomplete",
      path: ["human_user_id"],
    });
  }
});

const bootRowSchema = z.object({
  boot_id: syncBootIdSchema,
  boot_generation: positiveSyncUint64Schema.nullable(),
  heartbeat_sequence: positiveSyncUint64Schema,
  acknowledged: storedBooleanSchema,
  updated_at: safeIntegerSchema,
}).strict();

const clockCalibrationRowSchema = z.object({
  revision: safeIntegerSchema,
  server_observed_at: safeIntegerSchema,
  client_observed_at: safeIntegerSchema,
  uncertainty_ms: z.number().int().min(0).max(60_000).safe(),
  updated_at: safeIntegerSchema,
}).strict();

const storedWrappedRootKeyringSchema = z.object({
  current: wrappedSyncVaultRootKeySchema,
  retained: z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
}).strict();

const localPaneRowSchema = z.object({
  pane_id: z.string().min(1).max(96),
  session_id: sessionPublicIdSchema,
  source_revision: positiveSafeIntegerSchema,
  event_kind: sessionSyncEventKindSchema,
  barrier: storedBooleanSchema,
  title: z.string(),
  repository_name: z.string(),
  state: z.enum(["ready", "starting", "streaming", "continuing", "attention"]),
  archived_at: z.string().nullable(),
}).strict();

const paneBindingRowSchema = z.object({
  pane_id: z.string().min(1).max(96),
  session_id: sessionPublicIdSchema,
  tenant_id: z.string(),
  organization_id: z.string(),
  owner_user_id: z.string(),
  vault_id: z.string(),
  vault_generation: z.string(),
  origin_device_id: syncDeviceIdSchema,
  included: storedBooleanSchema,
  binding_state: z.enum(["pending", "accepted"]),
  creation_grant_digest: syncSha256DigestSchema.nullable(),
  reserved_at: safeIntegerSchema.nullable(),
  created_at: safeIntegerSchema,
}).strict();

const retiredPaneBindingRowSchema = z.object({
  retired_session_id: sessionPublicIdSchema,
  pane_id: z.string().min(1).max(96),
  creation_grant_digest: syncSha256DigestSchema.nullable(),
  retirement_reason: z.enum(["grant_expired", "retired"]),
  retired_at: safeIntegerSchema,
}).strict();

const outboxRowSchema = z.object({
  intent_id: positiveSafeIntegerSchema,
  session_id: sessionPublicIdSchema,
  source_revision: positiveSafeIntegerSchema,
  event_kind: sessionSyncEventKindSchema,
  barrier: storedBooleanSchema,
  sealed_intent_json: z.string().min(2).max(8_192),
  ciphertext_digest: syncSha256DigestSchema,
  ciphertext_bytes: z.number().int().min(17).max(4_096),
  created_at: safeIntegerSchema,
}).strict();

const headRowSchema = z.object({
  session_id: sessionPublicIdSchema,
  directory_ordinal: positiveSyncUint64Schema.nullable(),
  mirror_epoch: positiveSyncUint64Schema,
  writer_generation: syncUint64Schema,
  boot_id: syncBootIdSchema,
  boot_generation: positiveSyncUint64Schema,
  membership_epoch: positiveSyncUint64Schema,
  key_epoch: positiveSyncUint64Schema,
  acknowledged_sequence: syncUint64Schema,
  acknowledged_digest: syncSha256DigestSchema.nullable(),
  acknowledged_source_revision: safeIntegerSchema,
  sync_state: z.enum([
    "idle",
    "publishing",
    "conflict",
    "rekey_required",
    "revoked",
  ]),
  nonce_state_json: z.string().min(2).max(1_024),
  updated_at: safeIntegerSchema,
}).strict();

const attemptRowSchema = z.object({
  session_id: sessionPublicIdSchema,
  intent_id: positiveSafeIntegerSchema,
  sync_sequence: positiveSyncUint64Schema,
  ciphertext_digest: syncSha256DigestSchema,
  envelope_json: z.string().min(2).max(16_384),
  attempted_at: safeIntegerSchema,
}).strict();

const cursorRowSchema = z.object({
  revision: safeIntegerSchema,
  mode: z.enum(["idle", "snapshot", "changes"]),
  snapshot_id: z.string().nullable(),
  snapshot_version: syncUint64Schema.nullable(),
  snapshot_cursor_json: z.string().max(1_024).nullable(),
  change_version: syncUint64Schema,
  updated_at: safeIntegerSchema,
}).strict();

const remoteRowSchema = z.object({
  session_id: sessionPublicIdSchema,
  record_kind: z.enum(["head", "tombstone", "retired"]),
  origin_device_id: syncDeviceIdSchema.nullable(),
  directory_ordinal: positiveSyncUint64Schema,
  directory_version: positiveSyncUint64Schema,
  mirror_epoch: syncUint64Schema,
  source_revision: syncUint64Schema,
  record_json: z.string().min(2).max(32_768),
  ciphertext_digest: syncSha256DigestSchema.nullable(),
  installed_at: safeIntegerSchema,
}).strict();
const positionedRemoteRowSchema = remoteRowSchema.extend({
  grid_position: z.number().int().min(0).max(
    MAX_SYNC_DIRECTORY_SESSIONS - 1,
  ),
}).strict();

const retryRowSchema = z.object({
  worker: z.enum(["enrollment", "publisher", "observer", "heartbeat"]),
  attempt: z.number().int().min(0).max(31),
  not_before: safeIntegerSchema,
  error_code: z.string().max(64).nullable(),
  generation: safeIntegerSchema,
  updated_at: safeIntegerSchema,
}).strict();

const countRowSchema = z.object({
  count: safeIntegerSchema,
}).strict();

const positionRowSchema = z.object({
  grid_position: z.number().int().min(0).max(
    MAX_SYNC_DIRECTORY_SESSIONS - 1,
  ),
}).strict();

export interface SessionSyncSettings {
  readonly revision: number;
  readonly enabled: boolean;
  readonly deviceName: string;
  readonly updatedAt: number;
}

export type SessionSyncEnrollmentState = z.infer<
  typeof deviceRowSchema
>["enrollment_state"];

export interface SessionSyncDeviceState {
  readonly revision: number;
  readonly enrollmentState: SessionSyncEnrollmentState;
  readonly deviceId: SyncDeviceId | null;
  readonly publicKeys: SyncDevicePublicKeys;
  readonly pendingEnrollment: unknown;
  readonly credentialGeneration: number;
  readonly updatedAt: number;
}

export interface SessionSyncVaultState {
  readonly revision: number;
  readonly state: "active" | "conflict" | "retired";
  readonly vault: SyncVaultCoordinate;
  readonly membershipEpoch: PositiveSyncUint64;
  readonly membershipDigest: SyncSha256Digest;
  readonly membershipHead: SyncMembershipHead;
  readonly wrappedRoot: WrappedSyncVaultRootKey;
  readonly wrappedRoots: readonly WrappedSyncVaultRootKey[];
  readonly rootKeyEpoch: PositiveSyncUint64;
  readonly humanAuthority: SessionSyncHumanAuthority | null;
  readonly updatedAt: number;
}

export interface SessionSyncHumanAuthority {
  readonly userId: string;
  readonly organizationId: string;
}

export interface SessionSyncBootState {
  readonly bootId: SyncBootId;
  readonly bootGeneration: PositiveSyncUint64 | null;
  readonly heartbeatSequence: PositiveSyncUint64;
  readonly acknowledged: boolean;
  readonly updatedAt: number;
}

export interface SessionSyncClockCalibration {
  readonly revision: number;
  readonly serverObservedAt: number;
  readonly clientObservedAt: number;
  readonly uncertaintyMs: number;
  readonly updatedAt: number;
}

export interface DirtyLocalSessionSyncIntent extends LocalSessionSyncIntent {
  readonly paneId: string;
  readonly barrier: boolean;
}

export interface SessionSyncPaneBinding {
  readonly paneId: string;
  readonly sessionId: SessionPublicId;
  readonly vault: SyncVaultCoordinate;
  readonly originDeviceId: SyncDeviceId;
  readonly included: boolean;
  readonly state: "pending" | "accepted";
  readonly creationGrantDigest: SyncSha256Digest | null;
  readonly reservedAt: number | null;
  readonly createdAt: number;
}

export interface SessionSyncLocalGridSlot {
  readonly paneId: string;
  readonly gridPosition: number;
}

export type SessionSyncLocalPaneBindingAdmission =
  | Readonly<{
      status: "inactive";
      addedSessionIds: readonly [];
    }>
  | Readonly<{
      status: "admitted";
      bindingCount: number;
      addedSessionIds: readonly SessionPublicId[];
    }>
  | Readonly<{
      status: "capacity_reached";
      bindingCount: number;
      addedSessionIds: readonly SessionPublicId[];
      skippedPaneCount: number;
    }>;

export interface RetiredSessionSyncPaneBinding {
  readonly retiredSessionId: SessionPublicId;
  readonly paneId: string;
  readonly creationGrantDigest: SyncSha256Digest | null;
  readonly reason: "grant_expired" | "retired";
  readonly retiredAt: number;
}

export interface StoredSessionSyncIntent {
  readonly intentId: number;
  readonly sessionId: SessionPublicId;
  readonly sourceRevision: number;
  readonly eventKind: SessionSyncEventKind;
  readonly barrier: boolean;
  readonly sealed: SealedLocalSessionSyncIntent;
  readonly createdAt: number;
}

export interface SessionSyncLocalHead {
  readonly sessionId: SessionPublicId;
  readonly directoryOrdinal: PositiveSyncUint64 | null;
  readonly mirrorEpoch: PositiveSyncUint64;
  readonly writerGeneration: ReturnType<typeof syncUint64Schema.parse>;
  readonly bootId: SyncBootId;
  readonly bootGeneration: PositiveSyncUint64;
  readonly membershipEpoch: PositiveSyncUint64;
  readonly keyEpoch: PositiveSyncUint64;
  readonly acknowledgedSequence: ReturnType<typeof syncUint64Schema.parse>;
  readonly acknowledgedDigest: SyncSha256Digest | null;
  readonly acknowledgedSourceRevision: number;
  readonly syncState:
    | "idle"
    | "publishing"
    | "conflict"
    | "rekey_required"
    | "revoked";
  readonly nonceState: SessionSyncNonceState;
  readonly updatedAt: number;
}

export interface PreparedSessionSyncAttempt {
  readonly intent: StoredSessionSyncIntent;
  readonly head: SessionSyncLocalHead;
  readonly nonce: SessionSyncNonceAllocation;
  readonly nextNonceState: SessionSyncNonceState;
}

export interface StoredSessionSyncAttempt {
  readonly sessionId: SessionPublicId;
  readonly intentId: number;
  readonly syncSequence: PositiveSyncUint64;
  readonly ciphertextDigest: SyncSha256Digest;
  readonly envelope: SealedSessionSummary;
  readonly attemptedAt: number;
}

export type SessionSyncPublicationWork =
  | Readonly<{
      readonly kind: "replay";
      readonly attempt: StoredSessionSyncAttempt;
    }>
  | Readonly<{
      readonly kind: "prepare";
      readonly prepared: PreparedSessionSyncAttempt;
    }>;

export interface EncryptedRemoteSessionRecord {
  readonly sessionId: SessionPublicId;
  readonly gridPosition: number;
  readonly recordKind: "head" | "tombstone" | "retired";
  readonly originDeviceId: SyncDeviceId | null;
  readonly directoryOrdinal: PositiveSyncUint64;
  readonly directoryVersion: PositiveSyncUint64;
  readonly mirrorEpoch: ReturnType<typeof syncUint64Schema.parse>;
  readonly sourceRevision: ReturnType<typeof syncUint64Schema.parse>;
  readonly record: Exclude<SessionDirectoryEntry, { readonly kind: "head" }>
    | Exclude<SessionDirectoryChange, { readonly kind: "mirror_reset" }>;
  readonly ciphertextDigest: SyncSha256Digest | null;
  readonly installedAt: number;
}

export interface SessionSyncRetryState {
  readonly worker: "enrollment" | "publisher" | "observer" | "heartbeat";
  readonly attempt: number;
  readonly notBefore: number;
  readonly errorCode: SessionSyncRetryErrorCode | null;
  readonly generation: number;
  readonly updatedAt: number;
}

export const localSessionSyncRetryErrorCodes = [
  "LOCAL_AUTH_UNAVAILABLE",
  "LOCAL_CANCELLED",
  "LOCAL_CORRUPT_STATE",
  "LOCAL_KEYCHAIN_UNAVAILABLE",
  "LOCAL_NETWORK_UNAVAILABLE",
  "LOCAL_UNKNOWN",
] as const;
export const sessionSyncRetryErrorCodeSchema = z.union([
  sessionSyncBackendErrorCodeSchema,
  z.enum(localSessionSyncRetryErrorCodes),
]);
export type SessionSyncRetryErrorCode = SessionSyncBackendErrorCode
  | typeof localSessionSyncRetryErrorCodes[number];

/** Foreign exception text must never cross the durable diagnostics boundary. */
export function normalizeSessionSyncRetryErrorCode(
  value: unknown,
): SessionSyncRetryErrorCode {
  const parsed = sessionSyncRetryErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : "LOCAL_UNKNOWN";
}

export class SessionSyncStoreError extends Error {
  readonly code:
    | "conflict"
    | "corrupt_state"
    | "limit"
    | "not_found"
    | "stale";

  constructor(code: SessionSyncStoreError["code"], message: string) {
    super(message);
    this.name = "SessionSyncStoreError";
    this.code = code;
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SessionSyncStoreError(
      "corrupt_state",
      `${label} is not valid JSON.`,
    );
  }
}

function nowValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Session sync time must be a nonnegative integer.");
  }
  return value;
}

function canonicalDeviceName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 80 || name.includes("\0")) {
    throw new TypeError("Session sync device name is invalid.");
  }
  return name;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalSessionSyncJson(left) === canonicalSessionSyncJson(right);
}

function randomOpaqueId<Value>(
  prefix: string,
  schema: { readonly parse: (value: unknown) => Value },
  randomBytes?: (target: Uint8Array) => void,
): Value {
  const bytes = new Uint8Array(16);
  if (randomBytes === undefined) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    randomBytes(bytes);
  }
  const suffix = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return schema.parse(`${prefix}_${suffix}`);
}

export function createSessionSyncDeviceId(
  randomBytes?: (target: Uint8Array) => void,
): SyncDeviceId {
  return randomOpaqueId("syncdevice", syncDeviceIdSchema, randomBytes);
}

export function createSessionSyncPublicId(
  randomBytes?: (target: Uint8Array) => void,
): SessionPublicId {
  return randomOpaqueId("syncsession", sessionPublicIdSchema, randomBytes);
}

export function createSessionSyncBootId(
  randomBytes?: (target: Uint8Array) => void,
): SyncBootId {
  return randomOpaqueId("syncboot", syncBootIdSchema, randomBytes);
}

export function fullJitterSessionSyncDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 31) {
    throw new TypeError("Session sync retry attempt is invalid.");
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new TypeError("Session sync retry randomness is invalid.");
  }
  const ceiling = Math.min(
    MAX_JITTER_RETRY_DELAY_MS,
    BASE_RETRY_DELAY_MS * 2 ** Math.min(attempt, 16),
  );
  return Math.floor(sample * (ceiling + 1));
}

function sanitizeDisplayText(
  value: string,
  maximumBytes: number,
  fallback: string,
): string {
  let sanitized = "";
  for (const character of value.trim()) {
    const codePoint = character.codePointAt(0);
    sanitized += codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
      ? " "
      : character;
  }
  sanitized = sanitized.trim().replace(/\s+/gu, " ");
  if (sanitized.length === 0) sanitized = fallback;
  let result = "";
  for (const character of sanitized) {
    const next = result + character;
    if (textEncoder.encode(next).byteLength > maximumBytes) break;
    result = next;
  }
  return result.length === 0 ? fallback : result;
}

/**
 * Renderer-facing session summaries may contain prose copied from local task
 * titles. Remove every common absolute-path spelling before the summary ever
 * reaches the encrypted outbox. Delimiter handling is intentionally
 * conservative: over-redacting a quoted/bracketed phrase is safer than
 * retaining the tail of a local path containing spaces.
 */
export function redactSessionSyncAbsolutePaths(value: string): string {
  return value
    .replace(
      /(["'`])(?:file:(?:[/\\]{1,3}|[A-Za-z]:[/\\])|~[/\\]|[A-Za-z]:[/\\]|\/|\\\\)[^"'`\r\n]*\1/giu,
      "$1[local path]$1",
    )
    .replace(
      /([[({])(?:file:(?:[/\\]{1,3}|[A-Za-z]:[/\\])|~[/\\]|[A-Za-z]:[/\\]|\/|\\\\)[^\]})\r\n]*([\]})])/giu,
      "$1[local path]$2",
    )
    .replace(
      /(?:file:(?:[/\\]{1,3}|[A-Za-z]:[/\\])|~[/\\]|[A-Za-z]:[/\\]|\/|\\\\)[^\s"'`()[\]{}<>]*/giu,
      "[local path]",
    );
}

function sanitizeRepositoryDisplayName(value: string): string {
  const segments = value.split(/[/\\]/u).filter((segment) => segment.length > 0);
  return sanitizeDisplayText(segments.at(-1) ?? value, 160, "Repository");
}

function uint64FromSafe(value: number): PositiveSyncUint64 {
  return positiveSyncUint64Schema.parse(encodeSyncUint64(BigInt(value)));
}

function settingsFromRow(row: z.infer<typeof settingsRowSchema>): SessionSyncSettings {
  return {
    revision: row.revision,
    enabled: row.enabled === 1,
    deviceName: row.device_name,
    updatedAt: row.updated_at,
  };
}

function deviceFromRow(row: z.infer<typeof deviceRowSchema>): SessionSyncDeviceState {
  return {
    revision: row.revision,
    enrollmentState: row.enrollment_state,
    deviceId: row.device_id,
    publicKeys: syncDevicePublicKeysSchema.parse(
      parseJson(row.public_keys_json, "Session sync device keys"),
    ),
    pendingEnrollment: row.pending_enrollment_json === null
      ? null
      : parseJson(row.pending_enrollment_json, "Session sync enrollment"),
    credentialGeneration: row.credential_generation,
    updatedAt: row.updated_at,
  };
}

function paneBindingFromRow(
  row: z.infer<typeof paneBindingRowSchema>,
): SessionSyncPaneBinding {
  return {
    paneId: row.pane_id,
    sessionId: row.session_id,
    vault: syncVaultCoordinateSchema.parse({
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      ownerUserId: row.owner_user_id,
      vaultId: row.vault_id,
      vaultGeneration: row.vault_generation,
    }),
    originDeviceId: row.origin_device_id,
    included: row.included === 1,
    state: row.binding_state,
    creationGrantDigest: row.creation_grant_digest,
    reservedAt: row.reserved_at,
    createdAt: row.created_at,
  };
}

function vaultFromRow(row: z.infer<typeof vaultRowSchema>): SessionSyncVaultState {
  const vault = syncVaultCoordinateSchema.parse({
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    ownerUserId: row.owner_user_id,
    vaultId: row.vault_id,
    vaultGeneration: row.vault_generation,
  });
  const storedValue = parseJson(
    row.wrapped_root_json,
    "Session sync wrapped roots",
  );
  const keyringResult = storedWrappedRootKeyringSchema.safeParse(storedValue);
  const legacyRoot = keyringResult.success
    ? null
    : wrappedSyncVaultRootKeySchema.parse(storedValue);
  const wrappedRoot = keyringResult.success
    ? keyringResult.data.current
    : legacyRoot as WrappedSyncVaultRootKey;
  const wrappedRoots = keyringResult.success
    ? keyringResult.data.retained
    : [wrappedRoot];
  const membershipEpoch = positiveSyncUint64Schema.parse(
    row.membership_epoch,
  );
  const membershipDigest = syncSha256DigestSchema.parse(
    row.membership_digest,
  );
  const membershipHead = syncMembershipHeadSchema.parse(
    parseJson(row.membership_head_json, "Session sync membership"),
  );
  const rootKeyEpoch = positiveSyncUint64Schema.parse(row.root_key_epoch);
  const recipient = membershipHead.statement.members.find(({ deviceId }) =>
    deviceId === wrappedRoot.context.recipientDeviceId
  );
  const rootEpochs = wrappedRoots.map(({ context }) => context.rootKeyEpoch);
  const orderedRootEpochs = [...rootEpochs].sort((left, right) =>
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
  );
  if (
    !sameValue({
      tenantId: membershipHead.statement.tenantId,
      organizationId: membershipHead.statement.organizationId,
      ownerUserId: membershipHead.statement.ownerUserId,
      vaultId: membershipHead.statement.vaultId,
      vaultGeneration: membershipHead.statement.vaultGeneration,
    }, vault)
    || membershipHead.statement.membershipEpoch !== membershipEpoch
    || membershipHead.statementDigest !== membershipDigest
    || wrappedRoot.context.membershipEpoch !== membershipEpoch
    || wrappedRoot.context.rootKeyEpoch !== rootKeyEpoch
    || recipient?.status !== "active"
    || recipient.keys.agreement.keyId !==
      wrappedRoot.context.recipientAgreementKeyId
    || rootEpochs.length < 1
    || new Set(rootEpochs).size !== rootEpochs.length
    || rootEpochs.some((epoch, index) => epoch !== orderedRootEpochs[index])
    || rootKeyEpoch !== orderedRootEpochs.at(-1)
    || !wrappedRoots.some((root) => sameValue(root, wrappedRoot))
    || wrappedRoots.some((root) => !sameValue(root.context, {
      version: 1,
      ...vault,
      membershipEpoch,
      rootKeyEpoch: root.context.rootKeyEpoch,
      recipientDeviceId: wrappedRoot.context.recipientDeviceId,
      recipientAgreementKeyId: wrappedRoot.context.recipientAgreementKeyId,
    }))
  ) {
    throw new SessionSyncStoreError(
      "corrupt_state",
      "Session sync vault authority is internally inconsistent.",
    );
  }
  return {
    revision: row.revision,
    state: row.state,
    vault,
    membershipEpoch,
    membershipDigest,
    membershipHead,
    wrappedRoot,
    wrappedRoots,
    rootKeyEpoch,
    humanAuthority: row.human_user_id === null
      ? null
      : sessionSyncHumanAuthoritySchema.parse({
          userId: row.human_user_id,
          organizationId: row.human_organization_id,
        }),
    updatedAt: row.updated_at,
  };
}

function headFromRow(row: z.infer<typeof headRowSchema>): SessionSyncLocalHead {
  return {
    sessionId: row.session_id,
    directoryOrdinal: row.directory_ordinal,
    mirrorEpoch: row.mirror_epoch,
    writerGeneration: row.writer_generation,
    bootId: row.boot_id,
    bootGeneration: row.boot_generation,
    membershipEpoch: row.membership_epoch,
    keyEpoch: row.key_epoch,
    acknowledgedSequence: row.acknowledged_sequence,
    acknowledgedDigest: row.acknowledged_digest,
    acknowledgedSourceRevision: row.acknowledged_source_revision,
    syncState: row.sync_state,
    nonceState: sessionSyncNonceStateSchema.parse(
      parseJson(row.nonce_state_json, "Session sync nonce state"),
    ),
    updatedAt: row.updated_at,
  };
}

function outboxFromRow(row: z.infer<typeof outboxRowSchema>): StoredSessionSyncIntent {
  const sealed = sealedLocalSessionSyncIntentSchema.parse(
    parseJson(row.sealed_intent_json, "Session sync outbox intent"),
  );
  if (
    sealed.sessionId !== row.session_id
    || Number(decodeSyncUint64(sealed.sourceRevision)) !== row.source_revision
    || sealed.eventKind !== row.event_kind
    || sealed.ciphertextDigest !== row.ciphertext_digest
    || sealed.ciphertextBytes !== row.ciphertext_bytes
  ) {
    throw new SessionSyncStoreError(
      "corrupt_state",
      "Session sync outbox row does not match its ciphertext.",
    );
  }
  return {
    intentId: row.intent_id,
    sessionId: row.session_id,
    sourceRevision: row.source_revision,
    eventKind: row.event_kind,
    barrier: row.barrier === 1,
    sealed,
    createdAt: row.created_at,
  };
}

function attemptFromRow(row: z.infer<typeof attemptRowSchema>): StoredSessionSyncAttempt {
  const envelope = sealedSessionSummarySchema.parse(
    parseJson(row.envelope_json, "Attempted session sync envelope"),
  );
  if (
    envelope.header.sessionId !== row.session_id
    || envelope.header.syncSequence !== row.sync_sequence
    || envelope.ciphertextDigest !== row.ciphertext_digest
  ) {
    throw new SessionSyncStoreError(
      "corrupt_state",
      "Attempted session sync envelope does not match its row.",
    );
  }
  return {
    sessionId: row.session_id,
    intentId: row.intent_id,
    syncSequence: row.sync_sequence,
    ciphertextDigest: row.ciphertext_digest,
    envelope,
    attemptedAt: row.attempted_at,
  };
}

function recordCoordinates(
  record: SessionDirectoryEntry | SessionDirectoryChange,
): Readonly<{
  sessionId: SessionPublicId;
  originDeviceId: SyncDeviceId | null;
  directoryOrdinal: PositiveSyncUint64;
  directoryVersion: PositiveSyncUint64;
  mirrorEpoch: ReturnType<typeof syncUint64Schema.parse>;
  sourceRevision: ReturnType<typeof syncUint64Schema.parse>;
  recordKind: "head" | "tombstone" | "retired";
  ciphertextDigest: SyncSha256Digest | null;
}> | null {
  switch (record.kind) {
    case "mirror_reset": return null;
    case "offline": {
      const accepted = record.accepted;
      return {
        sessionId: accepted.envelope.header.sessionId,
        originDeviceId: accepted.envelope.header.originDeviceId,
        directoryOrdinal: accepted.envelope.header.directoryOrdinal,
        directoryVersion: record.reset.directoryVersion,
        mirrorEpoch: record.reset.mirrorEpoch,
        sourceRevision: accepted.envelope.header.sourceRevision,
        recordKind: "head",
        ciphertextDigest: accepted.envelope.ciphertextDigest,
      };
    }
    case "head":
    case "upsert": {
      const accepted = record.accepted;
      return {
        sessionId: accepted.envelope.header.sessionId,
        originDeviceId: accepted.envelope.header.originDeviceId,
        directoryOrdinal: accepted.envelope.header.directoryOrdinal,
        directoryVersion: accepted.directoryVersion,
        mirrorEpoch: accepted.envelope.header.mirrorEpoch,
        sourceRevision: accepted.envelope.header.sourceRevision,
        recordKind: "head",
        ciphertextDigest: accepted.envelope.ciphertextDigest,
      };
    }
    case "tombstone":
      return {
        sessionId: record.tombstone.sessionId,
        originDeviceId: record.tombstone.originDeviceId,
        directoryOrdinal: record.tombstone.directoryOrdinal,
        directoryVersion: record.tombstone.directoryVersion,
        mirrorEpoch: record.tombstone.mirrorEpoch,
        sourceRevision: record.tombstone.sourceRevision,
        recordKind: "tombstone",
        ciphertextDigest: null,
      };
    case "retired":
      return {
        sessionId: record.fence.sessionId,
        originDeviceId: null,
        directoryOrdinal: record.fence.directoryOrdinal,
        directoryVersion: record.fence.retirementDirectoryVersion,
        mirrorEpoch: syncUint64Schema.parse("0"),
        sourceRevision: syncUint64Schema.parse("0"),
        recordKind: "retired",
        ciphertextDigest: null,
      };
  }
}

type PersistedRemoteRecord = EncryptedRemoteSessionRecord["record"];

function persistedRemoteRecordFromRow(
  row: z.infer<typeof remoteRowSchema>,
): PersistedRemoteRecord {
  const source = parseJson(row.record_json, "Remote session sync record");
  const parsed = z.union([
    sessionDirectoryChangeSchema,
    sessionDirectoryEntrySchema,
  ]).parse(source);
  if (parsed.kind === "head" || parsed.kind === "mirror_reset") {
    throw new SessionSyncStoreError(
      "corrupt_state",
      "Remote session sync record is not in its canonical stored form.",
    );
  }
  if (
    (row.record_kind === "head"
      && parsed.kind !== "upsert"
      && parsed.kind !== "offline")
    || (row.record_kind === "tombstone" && parsed.kind !== "tombstone")
    || (row.record_kind === "retired" && parsed.kind !== "retired")
  ) {
    throw new SessionSyncStoreError(
      "corrupt_state",
      "Remote session sync record kind does not match its row.",
    );
  }
  return parsed;
}

function persistedRecordDominance(record: PersistedRemoteRecord): number {
  switch (record.kind) {
    case "upsert": return 0;
    case "offline": return 1;
    case "tombstone": return 2;
    case "retired": return 3;
  }
}

/** Install the exact production schema in a narrow in-memory store test. */
export function installSessionSyncSchema(database: Database): void {
  database.exec(SESSION_SYNC_SCHEMA_SQL);
  database.exec(SESSION_SYNC_OPERATION_SCHEMA_SQL);
  database.exec(SESSION_SYNC_HARDENING_SCHEMA_SQL);
  database.exec(SESSION_SYNC_HUMAN_SCOPE_SCHEMA_SQL);
}

export class SessionSyncStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  settings(): SessionSyncSettings {
    const value: unknown = this.#database.query(`
      SELECT revision, enabled, device_name, updated_at
      FROM session_sync_settings WHERE singleton = 1
    `).get();
    return settingsFromRow(settingsRowSchema.parse(value));
  }

  setEnabled(input: {
    readonly expectedRevision: number;
    readonly enabled: boolean;
    readonly deviceName?: string;
    readonly now: number;
  }): SessionSyncSettings {
    const now = nowValue(input.now);
    const deviceName = input.deviceName === undefined
      ? this.settings().deviceName
      : canonicalDeviceName(input.deviceName);
    const changed = this.#database.query(`
      UPDATE session_sync_settings
      SET revision = revision + 1, enabled = ?1,
        device_name = ?2, updated_at = ?3
      WHERE singleton = 1 AND revision = ?4
    `).run(input.enabled ? 1 : 0, deviceName, now, input.expectedRevision);
    if (changed.changes !== 1) {
      throw new SessionSyncStoreError(
        "stale",
        "Session sync settings changed concurrently.",
      );
    }
    return this.settings();
  }

  device(): SessionSyncDeviceState | null {
    const value: unknown = this.#database.query(`
      SELECT revision, enrollment_state, device_id, public_keys_json,
        pending_enrollment_json, credential_generation, updated_at
      FROM session_sync_device_state WHERE singleton = 1
    `).get();
    return value === null ? null : deviceFromRow(deviceRowSchema.parse(value));
  }

  recordDeviceKeys(input: {
    readonly publicKeys: SyncDevicePublicKeys;
    readonly credentialGeneration: number;
    readonly now: number;
  }): SessionSyncDeviceState {
    const publicKeys = syncDevicePublicKeysSchema.parse(input.publicKeys);
    const credentialGeneration = safeIntegerSchema.parse(
      input.credentialGeneration,
    );
    const now = nowValue(input.now);
    const serialized = canonicalSessionSyncJson(publicKeys);
    this.#database.transaction(() => {
      const current = this.device();
      if (current === null) {
        this.#database.query(`
          INSERT INTO session_sync_device_state(
            singleton, revision, enrollment_state, device_id,
            public_keys_json, pending_enrollment_json,
            credential_generation, updated_at
          ) VALUES (1, 0, 'unregistered', NULL, ?1, NULL, ?2, ?3)
        `).run(serialized, credentialGeneration, now);
        return;
      }
      if (!sameValue(current.publicKeys, publicKeys)) {
        throw new SessionSyncStoreError(
          "conflict",
          "Session sync device keys changed unexpectedly.",
        );
      }
      if (current.credentialGeneration !== credentialGeneration) {
        this.#clearRemoteProjection(now);
        this.#database.query(`
          UPDATE session_sync_device_state
          SET revision = revision + 1, credential_generation = ?1,
            updated_at = ?2
          WHERE singleton = 1
        `).run(credentialGeneration, now);
      }
    })();
    return this.device() as SessionSyncDeviceState;
  }

  recordEnrollmentState(input: {
    readonly expectedRevision: number;
    readonly state: Exclude<SessionSyncEnrollmentState, "unregistered">;
    readonly deviceId: SyncDeviceId;
    readonly pendingEnrollment?: unknown;
    readonly now: number;
  }): SessionSyncDeviceState {
    const deviceId = syncDeviceIdSchema.parse(input.deviceId);
    const now = nowValue(input.now);
    const pending = input.state === "pending"
      ? canonicalSessionSyncJson(input.pendingEnrollment)
      : null;
    if (input.state === "pending" && input.pendingEnrollment === undefined) {
      throw new TypeError("Pending enrollment metadata is required.");
    }
    const changed = this.#database.query(`
      UPDATE session_sync_device_state
      SET revision = revision + 1, enrollment_state = ?1,
        device_id = ?2, pending_enrollment_json = ?3, updated_at = ?4
      WHERE singleton = 1 AND revision = ?5
    `).run(input.state, deviceId, pending, now, input.expectedRevision);
    if (changed.changes !== 1) {
      throw new SessionSyncStoreError(
        "stale",
        "Session sync enrollment changed concurrently.",
      );
    }
    return this.device() as SessionSyncDeviceState;
  }

  vault(): SessionSyncVaultState | null {
    const value: unknown = this.#database.query(`
      SELECT revision, state, tenant_id, organization_id, owner_user_id,
        vault_id, vault_generation, membership_epoch, membership_digest,
        membership_head_json, wrapped_root_json, root_key_epoch,
        human_user_id, human_organization_id, updated_at
      FROM session_sync_vault_state WHERE singleton = 1
    `).get();
    return value === null ? null : vaultFromRow(vaultRowSchema.parse(value));
  }

  replaceVault(input: {
    readonly expectedRevision: number | null;
    readonly state?: SessionSyncVaultState["state"];
    readonly head: SyncMembershipHead;
    readonly wrappedRoot: WrappedSyncVaultRootKey;
    readonly wrappedRoots?: readonly WrappedSyncVaultRootKey[];
    readonly humanAuthority: SessionSyncHumanAuthority;
    readonly now: number;
  }): SessionSyncVaultState {
    const head = syncMembershipHeadSchema.parse(input.head);
    const wrappedRoot = wrappedSyncVaultRootKeySchema.parse(input.wrappedRoot);
    const wrappedRoots = (input.wrappedRoots ?? [wrappedRoot]).map((root) =>
      wrappedSyncVaultRootKeySchema.parse(root)
    );
    const now = nowValue(input.now);
    const humanAuthority = sessionSyncHumanAuthoritySchema.parse(
      input.humanAuthority,
    );
    const statement = head.statement;
    const vault = syncVaultCoordinateSchema.parse({
      tenantId: statement.tenantId,
      organizationId: statement.organizationId,
      ownerUserId: statement.ownerUserId,
      vaultId: statement.vaultId,
      vaultGeneration: statement.vaultGeneration,
    });
    const expectedRecipient = statement.members.find(({ deviceId }) =>
      deviceId === wrappedRoot.context.recipientDeviceId
    );
    const epochs = wrappedRoots.map(({ context }) => context.rootKeyEpoch);
    const orderedEpochs = [...epochs].sort((left, right) =>
      BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
    );
    if (
      expectedRecipient?.status !== "active"
      || expectedRecipient.keys.agreement.keyId !==
        wrappedRoot.context.recipientAgreementKeyId
      || wrappedRoots.length < 1
      || wrappedRoots.length > MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS
      || new Set(epochs).size !== epochs.length
      || epochs.some((epoch, index) => epoch !== orderedEpochs[index])
      || wrappedRoot.context.rootKeyEpoch !== orderedEpochs.at(-1)
      || !wrappedRoots.some((root) => sameValue(root, wrappedRoot))
      || wrappedRoots.some((root) => !sameValue(root.context, {
        version: 1,
        ...vault,
        membershipEpoch: statement.membershipEpoch,
        rootKeyEpoch: root.context.rootKeyEpoch,
        recipientDeviceId: wrappedRoot.context.recipientDeviceId,
        recipientAgreementKeyId:
          wrappedRoot.context.recipientAgreementKeyId,
      }))
    ) {
      throw new SessionSyncStoreError(
        "conflict",
        "Session sync wrapped root has mismatched authority.",
      );
    }
    this.#database.transaction(() => {
      const current = this.vault();
      if (current?.revision !== input.expectedRevision) {
        if (!(current === null && input.expectedRevision === null)) {
          throw new SessionSyncStoreError(
            "stale",
            "Session sync membership changed concurrently.",
          );
        }
      }
      if (current !== null) {
        if (!sameValue(current.humanAuthority, humanAuthority)) {
          throw new SessionSyncStoreError(
            "conflict",
            "Session sync vault authority belongs to another human scope.",
          );
        }
        const scopeChanged = !sameValue(current.vault, vault);
        if (scopeChanged) {
          this.#clearAllVaultData(now);
        } else {
          const epochComparison = decodeSyncUint64(statement.membershipEpoch)
            - decodeSyncUint64(current.membershipEpoch);
          if (epochComparison < 0n) {
            throw new SessionSyncStoreError(
              "stale",
              "Session sync membership cannot move backwards.",
            );
          }
          if (
            epochComparison === 0n
            && current.membershipDigest !== head.statementDigest
          ) {
            this.#database.query(`
              UPDATE session_sync_vault_state
              SET state = 'conflict', revision = revision + 1, updated_at = ?1
              WHERE singleton = 1
            `).run(now);
            return;
          }
        }
      }
      const nextRevision = (current?.revision ?? -1) + 1;
      this.#database.query(`
        INSERT INTO session_sync_vault_state(
          singleton, revision, state, tenant_id, organization_id,
          owner_user_id, vault_id, vault_generation, membership_epoch,
          membership_digest, membership_head_json, wrapped_root_json,
          root_key_epoch, human_user_id, human_organization_id, updated_at
        ) VALUES (
          1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
          ?13, ?14, ?15
        )
        ON CONFLICT(singleton) DO UPDATE SET
          revision = excluded.revision,
          state = excluded.state,
          tenant_id = excluded.tenant_id,
          organization_id = excluded.organization_id,
          owner_user_id = excluded.owner_user_id,
          vault_id = excluded.vault_id,
          vault_generation = excluded.vault_generation,
          membership_epoch = excluded.membership_epoch,
          membership_digest = excluded.membership_digest,
          membership_head_json = excluded.membership_head_json,
          wrapped_root_json = excluded.wrapped_root_json,
          root_key_epoch = excluded.root_key_epoch,
          human_user_id = excluded.human_user_id,
          human_organization_id = excluded.human_organization_id,
          updated_at = excluded.updated_at
      `).run(
        nextRevision,
        input.state ?? "active",
        vault.tenantId,
        vault.organizationId,
        vault.ownerUserId,
        vault.vaultId,
        vault.vaultGeneration,
        statement.membershipEpoch,
        head.statementDigest,
        canonicalSessionSyncJson(head),
        canonicalSessionSyncJson({
          current: wrappedRoot,
          retained: wrappedRoots,
        }),
        wrappedRoot.context.rootKeyEpoch,
        humanAuthority.userId,
        humanAuthority.organizationId,
        now,
      );
      if (
        current !== null
        && sameValue(current.vault, vault)
        && current.membershipEpoch !== statement.membershipEpoch
      ) {
        this.#clearRemoteProjection(now);
      }
    })();
    const installed = this.vault();
    if (installed === null) {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "Session sync membership was not installed.",
      );
    }
    return installed;
  }

  recordMembershipSignature(input: {
    readonly membershipEpoch: PositiveSyncUint64;
    readonly statementDigest: SyncSha256Digest;
    readonly now: number;
  }): "recorded" | "replayed" {
    const membershipEpoch = positiveSyncUint64Schema.parse(
      input.membershipEpoch,
    );
    const statementDigest = syncSha256DigestSchema.parse(
      input.statementDigest,
    );
    const now = nowValue(input.now);
    const result = this.#database.query(`
      INSERT INTO session_sync_signed_membership_epochs(
        membership_epoch, statement_digest, signed_at
      ) VALUES (?1, ?2, ?3)
      ON CONFLICT(membership_epoch) DO NOTHING
    `).run(membershipEpoch, statementDigest, now);
    if (result.changes === 1) return "recorded";
    const value: unknown = this.#database.query(`
      SELECT statement_digest FROM session_sync_signed_membership_epochs
      WHERE membership_epoch = ?1
    `).get(membershipEpoch);
    const row = z.object({ statement_digest: syncSha256DigestSchema })
      .strict().parse(value);
    if (row.statement_digest !== statementDigest) {
      throw new SessionSyncStoreError(
        "conflict",
        "This device already signed another membership child.",
      );
    }
    return "replayed";
  }

  beginBoot(input: {
    readonly bootId: SyncBootId;
    readonly now: number;
  }): SessionSyncBootState {
    const bootId = syncBootIdSchema.parse(input.bootId);
    const now = nowValue(input.now);
    this.#database.transaction(() => {
      const current = this.boot();
      if (current !== null && !current.acknowledged) return;
      this.#database.query(`
        INSERT INTO session_sync_boot_state(
          singleton, boot_id, boot_generation, heartbeat_sequence,
          acknowledged, updated_at
        ) VALUES (1, ?1, NULL, '1', 0, ?2)
        ON CONFLICT(singleton) DO UPDATE SET
          boot_id = excluded.boot_id,
          boot_generation = excluded.boot_generation,
          heartbeat_sequence = excluded.heartbeat_sequence,
          acknowledged = 0,
          updated_at = excluded.updated_at
      `).run(bootId, now);
    })();
    return this.boot() as SessionSyncBootState;
  }

  boot(): SessionSyncBootState | null {
    const value: unknown = this.#database.query(`
      SELECT boot_id, boot_generation, heartbeat_sequence,
        acknowledged, updated_at
      FROM session_sync_boot_state WHERE singleton = 1
    `).get();
    if (value === null) return null;
    const row = bootRowSchema.parse(value);
    return {
      bootId: row.boot_id,
      bootGeneration: row.boot_generation,
      heartbeatSequence: row.heartbeat_sequence,
      acknowledged: row.acknowledged === 1,
      updatedAt: row.updated_at,
    };
  }

  acknowledgeBoot(input: {
    readonly bootId: SyncBootId;
    readonly bootGeneration: PositiveSyncUint64;
    readonly heartbeatSequence: PositiveSyncUint64;
    readonly now: number;
  }): boolean {
    const changed = this.#database.query(`
      UPDATE session_sync_boot_state
      SET boot_generation = ?3, acknowledged = 1, updated_at = ?1
      WHERE singleton = 1 AND boot_id = ?2
        AND (boot_generation IS NULL OR boot_generation = ?3)
        AND heartbeat_sequence = ?4
    `).run(
      nowValue(input.now),
      syncBootIdSchema.parse(input.bootId),
      positiveSyncUint64Schema.parse(input.bootGeneration),
      positiveSyncUint64Schema.parse(input.heartbeatSequence),
    );
    return changed.changes === 1;
  }

  nextHeartbeat(input: {
    readonly bootId: SyncBootId;
    readonly bootGeneration: PositiveSyncUint64;
    readonly now: number;
  }): SessionSyncBootState {
    const bootId = syncBootIdSchema.parse(input.bootId);
    const bootGeneration = positiveSyncUint64Schema.parse(
      input.bootGeneration,
    );
    const current = this.boot();
    if (
      current === null
      || current.bootId !== bootId
      || current.bootGeneration === null
      || current.bootGeneration !== bootGeneration
      || !current.acknowledged
    ) {
      throw new SessionSyncStoreError("stale", "Session sync boot is stale.");
    }
    const nextSequence = nextSyncUint64(current.heartbeatSequence);
    if (nextSequence === null) {
      throw new SessionSyncStoreError(
        "limit",
        "Session sync heartbeat sequence is exhausted.",
      );
    }
    this.#database.query(`
      UPDATE session_sync_boot_state
      SET heartbeat_sequence = ?1, acknowledged = 0, updated_at = ?2
      WHERE singleton = 1 AND boot_id = ?3 AND boot_generation = ?4
        AND heartbeat_sequence = ?5 AND acknowledged = 1
    `).run(
      nextSequence,
      nowValue(input.now),
      bootId,
      bootGeneration,
      current.heartbeatSequence,
    );
    return this.boot() as SessionSyncBootState;
  }

  clockCalibration(): SessionSyncClockCalibration | null {
    const value: unknown = this.#database.query(`
      SELECT revision, server_observed_at, client_observed_at,
        uncertainty_ms, updated_at
      FROM session_sync_clock_calibration WHERE singleton = 1
    `).get();
    if (value === null) return null;
    const row = clockCalibrationRowSchema.parse(value);
    return {
      revision: row.revision,
      serverObservedAt: row.server_observed_at,
      clientObservedAt: row.client_observed_at,
      uncertaintyMs: row.uncertainty_ms,
      updatedAt: row.updated_at,
    };
  }

  recordClockCalibration(input: {
    readonly expectedRevision: number | null;
    readonly serverObservedAt: number;
    readonly clientObservedAt: number;
    readonly uncertaintyMs: number;
    readonly now: number;
  }): SessionSyncClockCalibration {
    const serverObservedAt = safeIntegerSchema.parse(input.serverObservedAt);
    const clientObservedAt = safeIntegerSchema.parse(input.clientObservedAt);
    const uncertaintyMs = z.number().int().min(0).max(60_000).safe().parse(
      input.uncertaintyMs,
    );
    const now = nowValue(input.now);
    this.#database.transaction(() => {
      const current = this.clockCalibration();
      if (current?.revision !== input.expectedRevision) {
        if (!(current === null && input.expectedRevision === null)) {
          throw new SessionSyncStoreError(
            "stale",
            "Session sync clock calibration changed concurrently.",
          );
        }
      }
      if (
        current !== null
        && serverObservedAt + uncertaintyMs
          < current.serverObservedAt - current.uncertaintyMs
      ) {
        throw new SessionSyncStoreError(
          "stale",
          "Session sync clock calibration cannot move backwards.",
        );
      }
      const revision = (current?.revision ?? -1) + 1;
      this.#database.query(`
        INSERT INTO session_sync_clock_calibration(
          singleton, revision, server_observed_at, client_observed_at,
          uncertainty_ms, updated_at
        ) VALUES (1, ?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(singleton) DO UPDATE SET
          revision = excluded.revision,
          server_observed_at = excluded.server_observed_at,
          client_observed_at = excluded.client_observed_at,
          uncertainty_ms = excluded.uncertainty_ms,
          updated_at = excluded.updated_at
      `).run(
        revision,
        serverObservedAt,
        clientObservedAt,
        uncertaintyMs,
        now,
      );
    })();
    return this.clockCalibration() as SessionSyncClockCalibration;
  }

  bindEligibleLocalPanes(input: {
    readonly vault: SyncVaultCoordinate;
    readonly deviceId: SyncDeviceId;
    readonly now: number;
    readonly nextSessionId?: () => SessionPublicId;
  }): SessionSyncLocalPaneBindingAdmission {
    const vault = syncVaultCoordinateSchema.parse(input.vault);
    const deviceId = syncDeviceIdSchema.parse(input.deviceId);
    const now = nowValue(input.now);
    const nextSessionId = input.nextSessionId ?? createSessionSyncPublicId;
    return this.#database.transaction((): SessionSyncLocalPaneBindingAdmission => {
      const settings = this.settings();
      const device = this.device();
      const storedVault = this.vault();
      if (
        !settings.enabled
        || device?.enrollmentState !== "active"
        || device.deviceId !== deviceId
        || storedVault?.state !== "active"
        || !sameValue(storedVault.vault, vault)
      ) return { status: "inactive", addedSessionIds: [] };
      const retainedValues: unknown[] = this.#database.query(`
        SELECT pane_id, tenant_id, organization_id, owner_user_id,
          vault_id, vault_generation, origin_device_id
        FROM session_sync_pane_bindings
        ORDER BY created_at, pane_id
        LIMIT ${String(MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE + 1)}
      `).all();
      if (retainedValues.length > MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE) {
        throw new SessionSyncStoreError(
          "corrupt_state",
          "Retained local session bindings exceed their declared limit.",
        );
      }
      const retained = z.array(z.object({
        pane_id: z.string().min(1).max(96),
        tenant_id: z.string(),
        organization_id: z.string(),
        owner_user_id: z.string(),
        vault_id: z.string(),
        vault_generation: z.string(),
        origin_device_id: syncDeviceIdSchema,
      }).strict()).parse(retainedValues);
      for (const binding of retained) {
        if (!sameValue({
          tenantId: binding.tenant_id,
          organizationId: binding.organization_id,
          ownerUserId: binding.owner_user_id,
          vaultId: binding.vault_id,
          vaultGeneration: binding.vault_generation,
        }, vault) || binding.origin_device_id !== deviceId) {
          throw new SessionSyncStoreError(
            "conflict",
            "A retained local pane is bound to another sync vault.",
          );
        }
      }
      const candidateCountValue: unknown = this.#database.query(`
        SELECT COUNT(*) AS count
        FROM chat_panes AS pane
        LEFT JOIN session_sync_pane_bindings AS binding
          ON binding.pane_id = pane.pane_id
        WHERE pane.archived_at IS NULL AND binding.pane_id IS NULL
      `).get();
      const candidateCount = countRowSchema.parse(candidateCountValue).count;
      const remainingCapacity = MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE - retained.length;
      const candidateValues: unknown[] = this.#database.query(`
        SELECT pane.pane_id, pane.revision
        FROM chat_panes AS pane
        LEFT JOIN session_sync_pane_bindings AS binding
          ON binding.pane_id = pane.pane_id
        WHERE pane.archived_at IS NULL AND binding.pane_id IS NULL
        ORDER BY pane.created_at, pane.pane_id
        LIMIT ?1
      `).all(remainingCapacity);
      const candidates = z.array(z.object({
        pane_id: z.string().min(1).max(96),
        revision: positiveSafeIntegerSchema,
      }).strict()).parse(candidateValues);
      const added: SessionPublicId[] = [];
      for (const row of candidates) {
        const sessionId = sessionPublicIdSchema.parse(nextSessionId());
        const position = this.#nextGridPosition();
        this.#database.query(`
          INSERT INTO session_sync_grid_positions(
            session_id, grid_position, origin, discovered_at
          ) VALUES (?1, ?2, 'local', ?3)
        `).run(sessionId, position, now);
        this.#database.query(`
          INSERT INTO session_sync_pane_bindings(
            pane_id, session_id, tenant_id, organization_id, owner_user_id,
            vault_id, vault_generation, origin_device_id, included, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
        `).run(
          row.pane_id,
          sessionId,
          vault.tenantId,
          vault.organizationId,
          vault.ownerUserId,
          vault.vaultId,
          vault.vaultGeneration,
          deviceId,
          now,
        );
        this.#database.query(`
          INSERT INTO session_sync_dirty_panes(
            pane_id, source_revision, event_kind, barrier, marked_at
          ) VALUES (?1, ?2, 'created', 1, ?3)
        `).run(row.pane_id, row.revision, now);
        added.push(sessionId);
      }
      const bindingCount = retained.length + added.length;
      const skippedPaneCount = candidateCount - added.length;
      return skippedPaneCount > 0
        ? {
            status: "capacity_reached",
            bindingCount,
            addedSessionIds: added,
            skippedPaneCount,
          }
        : { status: "admitted", bindingCount, addedSessionIds: added };
    })();
  }

  paneBinding(paneId: string): SessionSyncPaneBinding | null {
    const value: unknown = this.#database.query(`
      SELECT pane_id, session_id, tenant_id, organization_id,
        owner_user_id, vault_id, vault_generation, origin_device_id,
        included, binding_state, creation_grant_digest, reserved_at,
        created_at
      FROM session_sync_pane_bindings WHERE pane_id = ?1
    `).get(paneId);
    return value === null ? null : paneBindingFromRow(
      paneBindingRowSchema.parse(value),
    );
  }

  paneBindingForSession(
    sessionIdValue: SessionPublicId,
  ): SessionSyncPaneBinding | null {
    const sessionId = sessionPublicIdSchema.parse(sessionIdValue);
    const value: unknown = this.#database.query(`
      SELECT pane_id, session_id, tenant_id, organization_id,
        owner_user_id, vault_id, vault_generation, origin_device_id,
        included, binding_state, creation_grant_digest, reserved_at,
        created_at
      FROM session_sync_pane_bindings
      WHERE session_id = ?1
    `).get(sessionId);
    return value === null ? null : paneBindingFromRow(
      paneBindingRowSchema.parse(value),
    );
  }

  localGridSlots(): readonly SessionSyncLocalGridSlot[] {
    const values: unknown[] = this.#database.query(`
      SELECT binding.pane_id, position.grid_position
      FROM session_sync_pane_bindings AS binding
      JOIN session_sync_grid_positions AS position
        ON position.session_id = binding.session_id
      WHERE binding.included = 1 AND position.origin = 'local'
      ORDER BY position.grid_position, binding.pane_id
      LIMIT ${String(MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE + 1)}
    `).all();
    if (values.length > MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE) {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "Local session grid exceeds its declared limit.",
      );
    }
    return values.map((value) => {
      const row = z.object({
        pane_id: z.string().min(1).max(96),
        grid_position: z.number().int().min(0).max(
          MAX_SYNC_DIRECTORY_SESSIONS - 1,
        ),
      }).strict().parse(value);
      return { paneId: row.pane_id, gridPosition: row.grid_position };
    });
  }

  retiredPaneBinding(
    sessionIdValue: SessionPublicId,
  ): RetiredSessionSyncPaneBinding | null {
    const sessionId = sessionPublicIdSchema.parse(sessionIdValue);
    const value: unknown = this.#database.query(`
      SELECT retired_session_id, pane_id, creation_grant_digest,
        retirement_reason, retired_at
      FROM session_sync_retired_pane_bindings
      WHERE retired_session_id = ?1
    `).get(sessionId);
    if (value === null) return null;
    const row = retiredPaneBindingRowSchema.parse(value);
    return {
      retiredSessionId: row.retired_session_id,
      paneId: row.pane_id,
      creationGrantDigest: row.creation_grant_digest,
      reason: row.retirement_reason,
      retiredAt: row.retired_at,
    };
  }

  recordSessionReservation(input: {
    readonly paneId: string;
    readonly expectedSessionId: SessionPublicId;
    readonly creationGrantDigest: SyncSha256Digest;
    readonly now: number;
  }): SessionSyncPaneBinding {
    const sessionId = sessionPublicIdSchema.parse(input.expectedSessionId);
    const digest = syncSha256DigestSchema.parse(input.creationGrantDigest);
    const now = nowValue(input.now);
    const current = this.paneBinding(input.paneId);
    if (current === null || current.sessionId !== sessionId) {
      throw new SessionSyncStoreError(
        "stale",
        "Session sync pane reservation is stale.",
      );
    }
    if (current.state !== "pending") {
      throw new SessionSyncStoreError(
        "conflict",
        "An accepted session identity cannot be reserved again.",
      );
    }
    if (current.creationGrantDigest !== null) {
      if (current.creationGrantDigest !== digest) {
        throw new SessionSyncStoreError(
          "conflict",
          "Session sync reservation grant changed unexpectedly.",
        );
      }
      return current;
    }
    const changed = this.#database.query(`
      UPDATE session_sync_pane_bindings
      SET creation_grant_digest = ?1, reserved_at = ?2
      WHERE pane_id = ?3 AND session_id = ?4
        AND binding_state = 'pending' AND creation_grant_digest IS NULL
    `).run(digest, now, input.paneId, sessionId);
    if (changed.changes !== 1) {
      throw new SessionSyncStoreError(
        "stale",
        "Session sync pane reservation changed concurrently.",
      );
    }
    return this.paneBinding(input.paneId) as SessionSyncPaneBinding;
  }

  markSessionBindingAccepted(input: {
    readonly sessionId: SessionPublicId;
    readonly creationGrantDigest: SyncSha256Digest;
  }): boolean {
    const changed = this.#database.query(`
      UPDATE session_sync_pane_bindings
      SET binding_state = 'accepted'
      WHERE session_id = ?1 AND binding_state = 'pending'
        AND creation_grant_digest = ?2
    `).run(
      sessionPublicIdSchema.parse(input.sessionId),
      syncSha256DigestSchema.parse(input.creationGrantDigest),
    );
    if (changed.changes === 1) return true;
    const value: unknown = this.#database.query(`
      SELECT binding_state, creation_grant_digest
      FROM session_sync_pane_bindings WHERE session_id = ?1
    `).get(input.sessionId);
    if (value === null) return false;
    const row = z.object({
      binding_state: z.enum(["pending", "accepted"]),
      creation_grant_digest: syncSha256DigestSchema.nullable(),
    }).strict().parse(value);
    return row.binding_state === "accepted"
      && row.creation_grant_digest === input.creationGrantDigest;
  }

  /**
   * The sole exception to binding immutability. Only a never-accepted relay
   * identity with the exact precommitted grant may be retired. The local pane,
   * Codex session, repository, and workspace rows are never updated.
   */
  rebindExpiredPendingSession(input: {
    readonly paneId: string;
    readonly expectedSessionId: SessionPublicId;
    readonly expectedCreationGrantDigest: SyncSha256Digest;
    readonly nextSessionId: SessionPublicId;
    readonly nextCreationGrantDigest: SyncSha256Digest;
    readonly reason: "grant_expired" | "retired";
    readonly now: number;
  }): SessionSyncPaneBinding {
    const expectedSessionId = sessionPublicIdSchema.parse(
      input.expectedSessionId,
    );
    const expectedDigest = syncSha256DigestSchema.parse(
      input.expectedCreationGrantDigest,
    );
    const nextSessionId = sessionPublicIdSchema.parse(input.nextSessionId);
    const nextDigest = syncSha256DigestSchema.parse(
      input.nextCreationGrantDigest,
    );
    if (expectedSessionId === nextSessionId || expectedDigest === nextDigest) {
      throw new TypeError("Replacement session sync identity must be fresh.");
    }
    const now = nowValue(input.now);
    return this.#database.transaction(() => {
      const retired = this.retiredPaneBinding(expectedSessionId);
      const replay = this.paneBinding(input.paneId);
      if (retired !== null) {
        if (
          retired.paneId !== input.paneId
          || retired.creationGrantDigest !== expectedDigest
          || retired.reason !== input.reason
          || replay?.sessionId !== nextSessionId
          || replay.creationGrantDigest !== nextDigest
          || replay.state !== "pending"
        ) {
          throw new SessionSyncStoreError(
            "conflict",
            "Session sync identity retirement conflicts with durable evidence.",
          );
        }
        return replay;
      }
      const current = replay;
      if (
        current === null
        || current.sessionId !== expectedSessionId
        || current.creationGrantDigest !== expectedDigest
      ) {
        throw new SessionSyncStoreError(
          "stale",
          "Session sync pending identity changed concurrently.",
        );
      }
      if (current.state !== "pending") {
        throw new SessionSyncStoreError(
          "conflict",
          "An accepted session identity cannot be rebound.",
        );
      }
      const positionValue: unknown = this.#database.query(`
        SELECT grid_position FROM session_sync_grid_positions
        WHERE session_id = ?1 AND origin = 'local'
      `).get(expectedSessionId);
      if (positionValue === null) {
        throw new SessionSyncStoreError(
          "corrupt_state",
          "Session sync local grid identity is missing.",
        );
      }
      const position = positionRowSchema.parse(positionValue).grid_position;
      this.#database.query(`
        INSERT INTO session_sync_retired_pane_bindings(
          retired_session_id, pane_id, tenant_id, organization_id,
          owner_user_id, vault_id, vault_generation, origin_device_id,
          creation_grant_digest, retirement_reason, retired_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      `).run(
        expectedSessionId,
        current.paneId,
        current.vault.tenantId,
        current.vault.organizationId,
        current.vault.ownerUserId,
        current.vault.vaultId,
        current.vault.vaultGeneration,
        current.originDeviceId,
        expectedDigest,
        input.reason,
        now,
      );
      this.#database.query(`
        DELETE FROM session_sync_attempted_envelopes WHERE session_id = ?1
      `).run(expectedSessionId);
      this.#database.query(`
        DELETE FROM session_sync_outbox_intents WHERE session_id = ?1
      `).run(expectedSessionId);
      this.#database.query(`
        DELETE FROM session_sync_session_heads WHERE session_id = ?1
      `).run(expectedSessionId);
      this.#database.query(`
        DELETE FROM session_sync_local_nonce_state WHERE session_id = ?1
      `).run(expectedSessionId);
      this.#database.query(`
        DELETE FROM session_sync_dirty_panes WHERE pane_id = ?1
      `).run(input.paneId);
      this.#database.query(`
        DELETE FROM session_sync_pane_bindings WHERE pane_id = ?1
      `).run(input.paneId);
      this.#database.query(`
        DELETE FROM session_sync_grid_positions WHERE session_id = ?1
      `).run(expectedSessionId);
      this.#database.query(`
        INSERT INTO session_sync_grid_positions(
          session_id, grid_position, origin, discovered_at
        ) VALUES (?1, ?2, 'local', ?3)
      `).run(nextSessionId, position, now);
      this.#database.query(`
        INSERT INTO session_sync_pane_bindings(
          pane_id, session_id, tenant_id, organization_id, owner_user_id,
          vault_id, vault_generation, origin_device_id, included, created_at,
          binding_state, creation_grant_digest, reserved_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          'pending', ?11, ?10)
      `).run(
        current.paneId,
        nextSessionId,
        current.vault.tenantId,
        current.vault.organizationId,
        current.vault.ownerUserId,
        current.vault.vaultId,
        current.vault.vaultGeneration,
        current.originDeviceId,
        current.included ? 1 : 0,
        now,
        nextDigest,
      );
      const paneValue: unknown = this.#database.query(`
        SELECT revision FROM chat_panes WHERE pane_id = ?1
      `).get(input.paneId);
      const pane = z.object({ revision: positiveSafeIntegerSchema })
        .strict().parse(paneValue);
      this.#database.query(`
        INSERT INTO session_sync_dirty_panes(
          pane_id, source_revision, event_kind, barrier, marked_at
        ) VALUES (?1, ?2, 'projection_changed', 1, ?3)
      `).run(input.paneId, pane.revision, now);
      return this.paneBinding(input.paneId) as SessionSyncPaneBinding;
    })();
  }

  listDirtyLocalIntents(): readonly DirtyLocalSessionSyncIntent[] {
    const values: unknown[] = this.#database.query(`
      SELECT dirty.pane_id, binding.session_id, dirty.source_revision,
        dirty.event_kind, dirty.barrier, pane.title, pane.repository_name,
        pane.state, pane.archived_at
      FROM session_sync_dirty_panes AS dirty
      JOIN session_sync_pane_bindings AS binding
        ON binding.pane_id = dirty.pane_id
      JOIN chat_panes AS pane ON pane.pane_id = dirty.pane_id
      JOIN session_sync_settings AS settings ON settings.singleton = 1
      WHERE binding.included = 1 AND settings.enabled = 1
      ORDER BY dirty.marked_at, dirty.pane_id
      LIMIT ${String(MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE + 1)}
    `).all();
    if (values.length > MAX_SYNC_LOCAL_SESSIONS_PER_DEVICE) {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "Dirty local session intents exceed their declared limit.",
      );
    }
    return values.map((value) => {
      const row = localPaneRowSchema.parse(value);
      const state = row.archived_at !== null
        ? "offline" as const
        : row.state === "attention"
          ? "attention" as const
          : row.state === "ready"
            ? "ready" as const
            : "working" as const;
      return {
        version: 1,
        paneId: row.pane_id,
        sessionId: row.session_id,
        sourceRevision: uint64FromSafe(row.source_revision),
        eventKind: row.event_kind,
        title: sanitizeDisplayText(
          redactSessionSyncAbsolutePaths(row.title),
          256,
          "Untitled",
        ),
        repositoryDisplayName: sanitizeRepositoryDisplayName(
          row.repository_name,
        ),
        state,
        deleted: row.event_kind === "deleted",
        barrier: row.barrier === 1,
      } satisfies DirtyLocalSessionSyncIntent;
    });
  }

  allocateLocalIntentNonce(input: {
    readonly sessionId: SessionPublicId;
    readonly keyEpoch: PositiveSyncUint64;
  }): SessionSyncNonceAllocation {
    const sessionId = sessionPublicIdSchema.parse(input.sessionId);
    const keyEpoch = positiveSyncUint64Schema.parse(input.keyEpoch);
    return this.#database.transaction(() => {
      const value: unknown = this.#database.query(`
        SELECT key_epoch, nonce_state_json
        FROM session_sync_local_nonce_state WHERE session_id = ?1
      `).get(sessionId);
      const current = value === null
        ? createSessionSyncNonceState(keyEpoch)
        : (() => {
            const row = z.object({
              key_epoch: positiveSyncUint64Schema,
              nonce_state_json: z.string().min(2).max(1_024),
            }).strict().parse(value);
            return row.key_epoch === keyEpoch
              ? sessionSyncNonceStateSchema.parse(parseJson(
                  row.nonce_state_json,
                  "Local session sync nonce state",
                ))
              : createSessionSyncNonceState(keyEpoch);
          })();
      const allocated = allocateSessionSyncNonce(current);
      if (allocated.nextState === null) {
        throw new SessionSyncStoreError(
          "limit",
          "Local session sync nonce space is exhausted.",
        );
      }
      this.#database.query(`
        INSERT INTO session_sync_local_nonce_state(
          session_id, key_epoch, nonce_state_json
        ) VALUES (?1, ?2, ?3)
        ON CONFLICT(session_id) DO UPDATE SET
          key_epoch = excluded.key_epoch,
          nonce_state_json = excluded.nonce_state_json
      `).run(
        sessionId,
        keyEpoch,
        canonicalSessionSyncJson(allocated.nextState),
      );
      return allocated.allocation;
    })();
  }

  storeSealedLocalIntent(input: {
    readonly paneId: string;
    readonly expectedSourceRevision: number;
    readonly barrier: boolean;
    readonly sealed: SealedLocalSessionSyncIntent;
    readonly now: number;
  }): boolean {
    const sealed = sealedLocalSessionSyncIntentSchema.parse(input.sealed);
    const sourceRevision = positiveSafeIntegerSchema.parse(
      input.expectedSourceRevision,
    );
    if (decodeSyncUint64(sealed.sourceRevision) !== BigInt(sourceRevision)) {
      throw new TypeError("Sealed session sync intent revision does not match.");
    }
    const now = nowValue(input.now);
    return this.#database.transaction(() => {
      const dirtyValue: unknown = this.#database.query(`
        SELECT dirty.source_revision, dirty.event_kind, binding.session_id
        FROM session_sync_dirty_panes AS dirty
        JOIN session_sync_pane_bindings AS binding
          ON binding.pane_id = dirty.pane_id
        WHERE dirty.pane_id = ?1
      `).get(input.paneId);
      if (dirtyValue === null) return false;
      const dirty = z.object({
        source_revision: positiveSafeIntegerSchema,
        event_kind: sessionSyncEventKindSchema,
        session_id: sessionPublicIdSchema,
      }).strict().parse(dirtyValue);
      if (
        dirty.source_revision !== sourceRevision
        || dirty.session_id !== sealed.sessionId
        || dirty.event_kind !== sealed.eventKind
      ) return false;
      if (input.barrier) {
        this.#database.query(`
          DELETE FROM session_sync_outbox_intents
          WHERE session_id = ?1 AND barrier = 0
            AND source_revision <= ?2
        `).run(sealed.sessionId, sourceRevision);
        const duplicate: unknown = this.#database.query(`
          SELECT intent_id FROM session_sync_outbox_intents
          WHERE session_id = ?1 AND barrier = 1
            AND source_revision = ?2 AND event_kind = ?3
        `).get(sealed.sessionId, sourceRevision, sealed.eventKind);
        if (duplicate === null) {
          this.#assertOutboxCapacity();
          this.#database.query(`
            INSERT INTO session_sync_outbox_intents(
              session_id, source_revision, event_kind, barrier,
              sealed_intent_json, ciphertext_digest, ciphertext_bytes,
              created_at
            ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7)
          `).run(
            sealed.sessionId,
            sourceRevision,
            sealed.eventKind,
            canonicalSessionSyncJson(sealed),
            sealed.ciphertextDigest,
            sealed.ciphertextBytes,
            now,
          );
        }
      } else {
        const barrierValue: unknown = this.#database.query(`
          SELECT MAX(source_revision) AS source_revision
          FROM session_sync_outbox_intents
          WHERE session_id = ?1 AND barrier = 1
        `).get(sealed.sessionId);
        const barrier = z.object({
          source_revision: safeIntegerSchema.nullable(),
        }).strict().parse(barrierValue);
        if (
          barrier.source_revision === null
          || barrier.source_revision < sourceRevision
        ) {
          this.#assertOutboxCapacity(sealed.sessionId);
          this.#database.query(`
            INSERT INTO session_sync_outbox_intents(
              session_id, source_revision, event_kind, barrier,
              sealed_intent_json, ciphertext_digest, ciphertext_bytes,
              created_at
            ) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7)
            ON CONFLICT(session_id) WHERE barrier = 0 DO UPDATE SET
              source_revision = excluded.source_revision,
              event_kind = excluded.event_kind,
              sealed_intent_json = excluded.sealed_intent_json,
              ciphertext_digest = excluded.ciphertext_digest,
              ciphertext_bytes = excluded.ciphertext_bytes,
              created_at = excluded.created_at
            WHERE excluded.source_revision >= source_revision
          `).run(
            sealed.sessionId,
            sourceRevision,
            sealed.eventKind,
            canonicalSessionSyncJson(sealed),
            sealed.ciphertextDigest,
            sealed.ciphertextBytes,
            now,
          );
        }
      }
      this.#database.query(`
        DELETE FROM session_sync_dirty_panes
        WHERE pane_id = ?1 AND source_revision = ?2
      `).run(input.paneId, sourceRevision);
      return true;
    })();
  }

  outbox(limit = 100): readonly StoredSessionSyncIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Session sync outbox limit is invalid.");
    }
    const values: unknown[] = this.#database.query(`
      SELECT intent_id, session_id, source_revision, event_kind, barrier,
        sealed_intent_json, ciphertext_digest, ciphertext_bytes, created_at
      FROM session_sync_outbox_intents
      ORDER BY intent_id
      LIMIT ?1
    `).all(limit);
    return values.map((value) => outboxFromRow(outboxRowSchema.parse(value)));
  }

  upsertLocalHead(input: {
    readonly sessionId: SessionPublicId;
    readonly directoryOrdinal: PositiveSyncUint64 | null;
    readonly mirrorEpoch: PositiveSyncUint64;
    readonly writerGeneration: ReturnType<typeof syncUint64Schema.parse>;
    readonly bootId: SyncBootId;
    readonly bootGeneration: PositiveSyncUint64;
    readonly membershipEpoch: PositiveSyncUint64;
    readonly keyEpoch: PositiveSyncUint64;
    readonly acknowledgedSequence: ReturnType<typeof syncUint64Schema.parse>;
    readonly acknowledgedDigest: SyncSha256Digest | null;
    readonly acknowledgedSourceRevision: number;
    readonly now: number;
  }): SessionSyncLocalHead {
    const sessionId = sessionPublicIdSchema.parse(input.sessionId);
    const keyEpoch = positiveSyncUint64Schema.parse(input.keyEpoch);
    const acknowledgedSequence = syncUint64Schema.parse(
      input.acknowledgedSequence,
    );
    const nonceSequence = nextSyncUint64(acknowledgedSequence);
    if (nonceSequence === null) {
      throw new SessionSyncStoreError(
        "limit",
        "Session sync sequence is exhausted.",
      );
    }
    const nonceState = createSessionSyncNonceState(keyEpoch, nonceSequence);
    this.#database.query(`
      INSERT INTO session_sync_session_heads(
        session_id, directory_ordinal, mirror_epoch, writer_generation,
        boot_id, boot_generation, membership_epoch, key_epoch,
        acknowledged_sequence, acknowledged_digest,
        acknowledged_source_revision, sync_state, nonce_state_json,
        updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
        'idle', ?12, ?13)
      ON CONFLICT(session_id) DO UPDATE SET
        directory_ordinal = excluded.directory_ordinal,
        mirror_epoch = excluded.mirror_epoch,
        writer_generation = excluded.writer_generation,
        boot_id = excluded.boot_id,
        boot_generation = excluded.boot_generation,
        membership_epoch = excluded.membership_epoch,
        key_epoch = excluded.key_epoch,
        acknowledged_sequence = excluded.acknowledged_sequence,
        acknowledged_digest = excluded.acknowledged_digest,
        acknowledged_source_revision = excluded.acknowledged_source_revision,
        sync_state = 'idle',
        nonce_state_json = excluded.nonce_state_json,
        updated_at = excluded.updated_at
      WHERE session_sync_session_heads.sync_state != 'publishing'
    `).run(
      sessionId,
      input.directoryOrdinal === null
        ? null
        : positiveSyncUint64Schema.parse(input.directoryOrdinal),
      positiveSyncUint64Schema.parse(input.mirrorEpoch),
      syncUint64Schema.parse(input.writerGeneration),
      syncBootIdSchema.parse(input.bootId),
      positiveSyncUint64Schema.parse(input.bootGeneration),
      positiveSyncUint64Schema.parse(input.membershipEpoch),
      keyEpoch,
      acknowledgedSequence,
      input.acknowledgedDigest === null
        ? null
        : syncSha256DigestSchema.parse(input.acknowledgedDigest),
      safeIntegerSchema.parse(input.acknowledgedSourceRevision),
      canonicalSessionSyncJson(nonceState),
      nowValue(input.now),
    );
    const head = this.localHead(sessionId);
    if (head === null) {
      throw new SessionSyncStoreError(
        "not_found",
        "Session sync head could not be installed.",
      );
    }
    return head;
  }

  localHead(sessionIdValue: SessionPublicId): SessionSyncLocalHead | null {
    const sessionId = sessionPublicIdSchema.parse(sessionIdValue);
    const value: unknown = this.#database.query(`
      SELECT session_id, directory_ordinal, mirror_epoch, writer_generation,
        boot_id, boot_generation, membership_epoch, key_epoch,
        acknowledged_sequence, acknowledged_digest,
        acknowledged_source_revision, sync_state, nonce_state_json,
        updated_at
      FROM session_sync_session_heads WHERE session_id = ?1
    `).get(sessionId);
    return value === null ? null : headFromRow(headRowSchema.parse(value));
  }

  prepareAttempt(
    sessionIdValue: SessionPublicId,
  ): PreparedSessionSyncAttempt | null {
    const sessionId = sessionPublicIdSchema.parse(sessionIdValue);
    if (this.attempt(sessionId) !== null) return null;
    const head = this.localHead(sessionId);
    if (
      head === null
      || head.directoryOrdinal === null
      || head.writerGeneration === "0"
      || head.syncState === "conflict"
      || head.syncState === "rekey_required"
      || head.syncState === "revoked"
    ) return null;
    const value: unknown = this.#database.query(`
      SELECT intent_id, session_id, source_revision, event_kind, barrier,
        sealed_intent_json, ciphertext_digest, ciphertext_bytes, created_at
      FROM session_sync_outbox_intents
      WHERE session_id = ?1
      ORDER BY intent_id LIMIT 1
    `).get(sessionId);
    if (value === null) return null;
    const intent = outboxFromRow(outboxRowSchema.parse(value));
    const expectedSequence = nextSyncUint64(head.acknowledgedSequence);
    if (expectedSequence === null) return null;
    const allocated = allocateSessionSyncNonce(
      head.nonceState,
      positiveSyncUint64Schema.parse(expectedSequence),
    );
    if (allocated.nextState === null) return null;
    return {
      intent,
      head,
      nonce: allocated.allocation,
      nextNonceState: allocated.nextState,
    };
  }

  publicationWork(
    sessionIdValue: SessionPublicId,
  ): SessionSyncPublicationWork | null {
    const sessionId = sessionPublicIdSchema.parse(sessionIdValue);
    const attempt = this.attempt(sessionId);
    if (attempt !== null) return { kind: "replay", attempt };
    const prepared = this.prepareAttempt(sessionId);
    return prepared === null ? null : { kind: "prepare", prepared };
  }

  recordAttempt(input: {
    readonly expected: PreparedSessionSyncAttempt;
    readonly envelope: SealedSessionSummary;
    readonly now: number;
  }): StoredSessionSyncAttempt {
    const envelope = sealedSessionSummarySchema.parse(input.envelope);
    const expected = input.expected;
    if (
      envelope.header.sessionId !== expected.intent.sessionId
      || envelope.header.syncSequence !== expected.nonce.sequence
      || envelope.nonce !== expected.nonce.nonce
      || envelope.header.sourceRevision !==
        uint64FromSafe(expected.intent.sourceRevision)
    ) {
      throw new TypeError("Attempted session sync envelope is mismatched.");
    }
    const now = nowValue(input.now);
    this.#database.transaction(() => {
      const currentHead = this.localHead(expected.head.sessionId);
      if (
        currentHead === null
        || !sameValue(currentHead, expected.head)
        || this.attempt(expected.head.sessionId) !== null
      ) {
        throw new SessionSyncStoreError(
          "stale",
          "Session sync publication state changed before attempt.",
        );
      }
      const changed = this.#database.query(`
        UPDATE session_sync_session_heads
        SET nonce_state_json = ?1, sync_state = 'publishing', updated_at = ?2
        WHERE session_id = ?3 AND nonce_state_json = ?4
          AND acknowledged_sequence = ?5 AND sync_state = ?6
      `).run(
        canonicalSessionSyncJson(expected.nextNonceState),
        now,
        expected.head.sessionId,
        canonicalSessionSyncJson(expected.head.nonceState),
        expected.head.acknowledgedSequence,
        expected.head.syncState,
      );
      if (changed.changes !== 1) {
        throw new SessionSyncStoreError(
          "stale",
          "Session sync nonce state changed before attempt.",
        );
      }
      this.#database.query(`
        INSERT INTO session_sync_attempted_envelopes(
          session_id, intent_id, sync_sequence, ciphertext_digest,
          envelope_json, attempted_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `).run(
        expected.head.sessionId,
        expected.intent.intentId,
        envelope.header.syncSequence,
        envelope.ciphertextDigest,
        canonicalSessionSyncJson(envelope),
        now,
      );
    })();
    return this.attempt(expected.head.sessionId) as StoredSessionSyncAttempt;
  }

  attempt(sessionIdValue: SessionPublicId): StoredSessionSyncAttempt | null {
    const sessionId = sessionPublicIdSchema.parse(sessionIdValue);
    const value: unknown = this.#database.query(`
      SELECT session_id, intent_id, sync_sequence, ciphertext_digest,
        envelope_json, attempted_at
      FROM session_sync_attempted_envelopes WHERE session_id = ?1
    `).get(sessionId);
    return value === null
      ? null
      : attemptFromRow(attemptRowSchema.parse(value));
  }

  settleAccepted(input: {
    readonly accepted: AcceptedSessionHead;
    readonly now: number;
  }): boolean {
    const accepted = acceptedSessionHeadSchema.parse(input.accepted);
    const sessionId = accepted.envelope.header.sessionId;
    const attempt = this.attempt(sessionId);
    if (attempt === null) return false;
    if (!sameValue(attempt.envelope, accepted.envelope)) {
      this.markHeadConflict(sessionId, input.now);
      return false;
    }
    this.#database.transaction(() => {
      this.#database.query(`
        DELETE FROM session_sync_attempted_envelopes
        WHERE session_id = ?1 AND ciphertext_digest = ?2
      `).run(sessionId, accepted.envelope.ciphertextDigest);
      this.#database.query(`
        DELETE FROM session_sync_outbox_intents WHERE intent_id = ?1
      `).run(attempt.intentId);
      const changed = this.#database.query(`
        UPDATE session_sync_session_heads
        SET acknowledged_sequence = ?1, acknowledged_digest = ?2,
          acknowledged_source_revision = ?3, sync_state = 'idle',
          updated_at = ?4
        WHERE session_id = ?5 AND sync_state = 'publishing'
      `).run(
        accepted.envelope.header.syncSequence,
        accepted.envelope.ciphertextDigest,
        Number(decodeSyncUint64(accepted.envelope.header.sourceRevision)),
        nowValue(input.now),
        sessionId,
      );
      if (changed.changes !== 1) {
        throw new SessionSyncStoreError(
          "stale",
          "Session sync head changed before acknowledgement.",
        );
      }
      const creationGrantDigest = accepted.envelope.header.creationGrantDigest;
      if (
        creationGrantDigest !== undefined
        && !this.markSessionBindingAccepted({
          sessionId,
          creationGrantDigest,
        })
      ) {
        throw new SessionSyncStoreError(
          "conflict",
          "Accepted session grant does not match its pending binding.",
        );
      }
    })();
    return true;
  }

  markHeadConflict(
    sessionIdValue: SessionPublicId,
    now: number,
  ): void {
    const sessionId = sessionPublicIdSchema.parse(sessionIdValue);
    this.#database.query(`
      UPDATE session_sync_session_heads
      SET sync_state = 'conflict', updated_at = ?1
      WHERE session_id = ?2
    `).run(nowValue(now), sessionId);
  }

  fenceBootForRestart(now: number): void {
    this.#database.query("DELETE FROM session_sync_boot_state").run();
    this.#database.query(`
      UPDATE session_sync_session_heads
      SET sync_state = 'conflict', updated_at = ?1
      WHERE sync_state = 'publishing'
    `).run(nowValue(now));
  }

  fenceObserverForRestart(now: number): void {
    const time = nowValue(now);
    this.#database.transaction(() => {
      this.#database.query("DELETE FROM session_sync_snapshot_entries").run();
      this.#database.query(`
        UPDATE session_sync_directory_cursor
        SET revision = revision + 1, mode = 'idle', snapshot_id = NULL,
          snapshot_version = NULL, snapshot_cursor_json = NULL,
          updated_at = ?1
        WHERE singleton = 1
      `).run(time);
    })();
  }

  beginSnapshot(input: {
    readonly vault: SyncVaultCoordinate;
    readonly snapshotId: string;
    readonly snapshotVersion: ReturnType<typeof syncUint64Schema.parse>;
    readonly now: number;
  }): number {
    const snapshotId = z.string()
      .regex(/^syncsnapshot_[A-Za-z0-9_-]{32}$/u)
      .parse(input.snapshotId);
    const snapshotVersion = syncUint64Schema.parse(input.snapshotVersion);
    const vault = syncVaultCoordinateSchema.parse(input.vault);
    return this.#database.transaction(() => {
      const current = this.directoryCursor();
      const currentVault = this.vault();
      if (
        currentVault?.state !== "active"
        || !sameValue(currentVault.vault, vault)
        || decodeSyncUint64(snapshotVersion)
          < decodeSyncUint64(current.changeVersion)
      ) {
        throw new SessionSyncStoreError(
          "stale",
          "Session sync snapshot belongs to a stale scope.",
        );
      }
      this.#database.query("DELETE FROM session_sync_snapshot_entries").run();
      this.#database.query(`
        UPDATE session_sync_directory_cursor
        SET revision = revision + 1, mode = 'snapshot', snapshot_id = ?1,
          snapshot_version = ?2, snapshot_cursor_json = NULL,
          updated_at = ?3
        WHERE singleton = 1 AND revision = ?4
      `).run(snapshotId, snapshotVersion, nowValue(input.now), current.revision);
      return current.revision + 1;
    })();
  }

  installSnapshotPage(input: {
    readonly snapshotId: string;
    readonly expectedCursorRevision: number;
    readonly page: SessionDirectorySnapshotPage;
    readonly localDeviceId: SyncDeviceId;
    readonly now: number;
  }): Readonly<{ complete: boolean; cursorRevision: number }> {
    const page = sessionDirectorySnapshotPageSchema.parse(input.page);
    const localDeviceId = syncDeviceIdSchema.parse(input.localDeviceId);
    const now = nowValue(input.now);
    return this.#database.transaction(() => {
      const cursor = this.directoryCursor();
      const currentVault = this.vault();
      if (
        cursor.revision !== input.expectedCursorRevision
        || cursor.mode !== "snapshot"
        || cursor.snapshotId !== input.snapshotId
        || cursor.snapshotVersion !== page.snapshotVersion
        || !sameValue(cursor.snapshotCursor, page.after)
        || currentVault?.state !== "active"
        || !sameValue(currentVault.vault, page.vault)
      ) {
        throw new SessionSyncStoreError(
          "stale",
          "Session sync snapshot page is stale.",
        );
      }
      for (const entry of page.entries) {
        this.#stageSnapshotRecord(entry);
      }
      const nextCursorJson = page.nextCursor === undefined
        ? null
        : canonicalSessionSyncJson(page.nextCursor);
      if (page.complete) {
        this.#commitStagedSnapshot(localDeviceId, now);
      }
      const nextRevision = cursor.revision + 1;
      this.#database.query(`
        UPDATE session_sync_directory_cursor
        SET revision = ?1, mode = ?2, snapshot_id = ?3,
          snapshot_version = ?4, snapshot_cursor_json = ?5,
          change_version = ?6, updated_at = ?7
        WHERE singleton = 1 AND revision = ?8
      `).run(
        nextRevision,
        page.complete ? "changes" : "snapshot",
        page.complete ? null : input.snapshotId,
        page.complete ? null : page.snapshotVersion,
        page.complete ? null : nextCursorJson,
        page.complete ? page.snapshotVersion : cursor.changeVersion,
        now,
        cursor.revision,
      );
      if (page.complete) {
        this.#database.query("DELETE FROM session_sync_snapshot_entries").run();
      }
      return { complete: page.complete, cursorRevision: nextRevision };
    })();
  }

  applyChangePage(input: {
    readonly expectedCursorRevision: number;
    readonly page: SessionDirectoryChangePage;
    readonly localDeviceId: SyncDeviceId;
    readonly now: number;
  }): number {
    const page = sessionDirectoryChangePageSchema.parse(input.page);
    const localDeviceId = syncDeviceIdSchema.parse(input.localDeviceId);
    const now = nowValue(input.now);
    return this.#database.transaction(() => {
      const cursor = this.directoryCursor();
      const currentVault = this.vault();
      if (
        cursor.revision !== input.expectedCursorRevision
        || cursor.mode !== "changes"
        || cursor.changeVersion !== page.afterVersion
        || currentVault?.state !== "active"
        || !sameValue(currentVault.vault, page.vault)
      ) {
        throw new SessionSyncStoreError(
          "stale",
          "Session sync change page is stale.",
        );
      }
      for (const change of page.changes) {
        if (change.kind === "mirror_reset") {
          this.#applyMirrorReset(change, localDeviceId, now);
          continue;
        }
        this.#upsertRemoteRecord(change, localDeviceId, now);
      }
      const nextRevision = cursor.revision + 1;
      this.#database.query(`
        UPDATE session_sync_directory_cursor
        SET revision = ?1, change_version = ?2, updated_at = ?3
        WHERE singleton = 1 AND revision = ?4
      `).run(nextRevision, page.nextVersion, now, cursor.revision);
      return nextRevision;
    })();
  }

  directoryCursor(): Readonly<{
    revision: number;
    mode: "idle" | "snapshot" | "changes";
    snapshotId: string | null;
    snapshotVersion: ReturnType<typeof syncUint64Schema.parse> | null;
    snapshotCursor: SessionDirectoryCursor | undefined;
    changeVersion: ReturnType<typeof syncUint64Schema.parse>;
    updatedAt: number;
  }> {
    const value: unknown = this.#database.query(`
      SELECT revision, mode, snapshot_id, snapshot_version,
        snapshot_cursor_json, change_version, updated_at
      FROM session_sync_directory_cursor WHERE singleton = 1
    `).get();
    const row = cursorRowSchema.parse(value);
    return {
      revision: row.revision,
      mode: row.mode,
      snapshotId: row.snapshot_id,
      snapshotVersion: row.snapshot_version,
      snapshotCursor: row.snapshot_cursor_json === null
        ? undefined
        : sessionDirectoryCursorSchema.parse(parseJson(
            row.snapshot_cursor_json,
            "Session sync snapshot cursor",
          )),
      changeVersion: row.change_version,
      updatedAt: row.updated_at,
    };
  }

  remoteRecords(
    localDeviceIdValue: SyncDeviceId,
  ): readonly EncryptedRemoteSessionRecord[] {
    const localDeviceId = syncDeviceIdSchema.parse(localDeviceIdValue);
    const values: unknown[] = this.#database.query(`
      SELECT remote.session_id, remote.record_kind,
        remote.origin_device_id, remote.directory_ordinal,
        remote.directory_version, remote.mirror_epoch,
        remote.source_revision, remote.record_json,
        remote.ciphertext_digest, remote.installed_at,
        positions.grid_position
      FROM session_sync_remote_entries AS remote
      JOIN session_sync_grid_positions AS positions
        ON positions.session_id = remote.session_id
      LEFT JOIN session_sync_pane_bindings AS local
        ON local.session_id = remote.session_id
      WHERE local.session_id IS NULL
        AND (remote.origin_device_id IS NULL OR remote.origin_device_id != ?1)
      ORDER BY positions.grid_position, remote.session_id
      LIMIT ${String(MAX_SYNC_DIRECTORY_SESSIONS + 1)}
    `).all(localDeviceId);
    if (values.length > MAX_SYNC_DIRECTORY_SESSIONS) {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "Remote session directory exceeds its declared limit.",
      );
    }
    return values.map((value) => {
      const row = positionedRemoteRowSchema.parse(value);
      const record = persistedRemoteRecordFromRow(row);
      return {
        sessionId: row.session_id,
        gridPosition: row.grid_position,
        recordKind: row.record_kind,
        originDeviceId: row.origin_device_id,
        directoryOrdinal: row.directory_ordinal,
        directoryVersion: row.directory_version,
        mirrorEpoch: row.mirror_epoch,
        sourceRevision: row.source_revision,
        record,
        ciphertextDigest: row.ciphertext_digest,
        installedAt: row.installed_at,
      };
    });
  }

  retry(
    worker: SessionSyncRetryState["worker"],
  ): SessionSyncRetryState | null {
    const value: unknown = this.#database.query(`
      SELECT worker, attempt, not_before, error_code, generation, updated_at
      FROM session_sync_retry_state WHERE worker = ?1
    `).get(worker);
    if (value === null) return null;
    const row = retryRowSchema.parse(value);
    return {
      worker: row.worker,
      attempt: row.attempt,
      notBefore: row.not_before,
      errorCode: row.error_code === null
        ? null
        : sessionSyncRetryErrorCodeSchema.parse(row.error_code),
      generation: row.generation,
      updatedAt: row.updated_at,
    };
  }

  scheduleRetry(input: {
    readonly worker: SessionSyncRetryState["worker"];
    readonly expectedGeneration: number | null;
    readonly errorCode: unknown;
    readonly now: number;
    readonly serverRetryAfterMs?: number;
    readonly random?: () => number;
  }): SessionSyncRetryState {
    const current = this.retry(input.worker);
    if (current?.generation !== input.expectedGeneration) {
      if (!(current === null && input.expectedGeneration === null)) {
        throw new SessionSyncStoreError(
          "stale",
          "Session sync retry generation changed concurrently.",
        );
      }
    }
    const attempt = Math.min((current?.attempt ?? -1) + 1, 31);
    const now = nowValue(input.now);
    const serverRetryAfterMs = input.serverRetryAfterMs ?? 0;
    if (!Number.isSafeInteger(serverRetryAfterMs) || serverRetryAfterMs < 0) {
      throw new TypeError("Session sync Retry-After delay is invalid.");
    }
    const delay = Math.max(
      fullJitterSessionSyncDelay(attempt, input.random),
      Math.min(serverRetryAfterMs, MAX_SESSION_SYNC_RETRY_DELAY_MS),
    );
    const notBefore = nowValue(now + delay);
    const generation = (current?.generation ?? -1) + 1;
    const errorCode = normalizeSessionSyncRetryErrorCode(input.errorCode);
    this.#database.query(`
      INSERT INTO session_sync_retry_state(
        worker, attempt, not_before, error_code, generation, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(worker) DO UPDATE SET
        attempt = excluded.attempt,
        not_before = excluded.not_before,
        error_code = excluded.error_code,
        generation = excluded.generation,
        updated_at = excluded.updated_at
    `).run(
      input.worker,
      attempt,
      notBefore,
      errorCode,
      generation,
      now,
    );
    return this.retry(input.worker) as SessionSyncRetryState;
  }

  clearRetry(input: {
    readonly worker: SessionSyncRetryState["worker"];
    readonly expectedGeneration: number;
  }): boolean {
    return this.#database.query(`
      DELETE FROM session_sync_retry_state
      WHERE worker = ?1 AND generation = ?2
    `).run(input.worker, input.expectedGeneration).changes === 1;
  }

  clearRemoteForScopeChange(now: number): void {
    this.#database.transaction(() => this.#clearRemoteProjection(nowValue(now)))();
  }

  #assertOutboxCapacity(replaceableSessionId?: SessionPublicId): void {
    const value: unknown = this.#database.query(`
      SELECT COUNT(*) AS count FROM session_sync_outbox_intents
    `).get();
    const count = countRowSchema.parse(value).count;
    if (count < MAX_OUTBOX_INTENTS) return;
    if (replaceableSessionId !== undefined) {
      const existing: unknown = this.#database.query(`
        SELECT 1 AS count FROM session_sync_outbox_intents
        WHERE session_id = ?1 AND barrier = 0 LIMIT 1
      `).get(sessionPublicIdSchema.parse(replaceableSessionId));
      if (existing !== null) return;
    }
    throw new SessionSyncStoreError(
      "limit",
      "Encrypted session sync outbox reached its limit.",
    );
  }

  #nextGridPosition(): number {
    const values: unknown[] = this.#database.query(`
      SELECT grid_position FROM session_sync_grid_positions
      ORDER BY grid_position
      LIMIT ${String(MAX_SYNC_DIRECTORY_SESSIONS + 1)}
    `).all();
    if (values.length > MAX_SYNC_DIRECTORY_SESSIONS) {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "Session sync grid exceeds its declared limit.",
      );
    }
    const positions = values.map((value) =>
      positionRowSchema.parse(value).grid_position
    );
    let candidate = 0;
    for (const position of positions) {
      if (position === candidate) candidate += 1;
      else if (position > candidate) break;
    }
    if (candidate >= MAX_SYNC_DIRECTORY_SESSIONS) {
      throw new SessionSyncStoreError(
        "limit",
        "Session sync grid reached its limit.",
      );
    }
    return candidate;
  }

  #clearRemoteProjection(now: number): void {
    this.#database.query("DELETE FROM session_sync_snapshot_entries").run();
    this.#database.query("DELETE FROM session_sync_remote_entries").run();
    this.#database.query(`
      DELETE FROM session_sync_grid_positions
      WHERE origin = 'remote'
    `).run();
    this.#database.query(`
      UPDATE session_sync_directory_cursor
      SET revision = revision + 1, mode = 'idle', snapshot_id = NULL,
        snapshot_version = NULL, snapshot_cursor_json = NULL,
        change_version = '0', updated_at = ?1
      WHERE singleton = 1
    `).run(now);
  }

  #clearAllVaultData(now: number): void {
    this.#database.query("DELETE FROM session_sync_attempted_envelopes").run();
    this.#database.query("DELETE FROM session_sync_outbox_intents").run();
    this.#database.query("DELETE FROM session_sync_dirty_panes").run();
    this.#database.query("DELETE FROM session_sync_session_heads").run();
    this.#database.query("DELETE FROM session_sync_local_nonce_state").run();
    this.#database.query("DELETE FROM session_sync_pane_bindings").run();
    this.#database.query("DELETE FROM session_sync_retired_pane_bindings").run();
    this.#database.query("DELETE FROM session_sync_operation_journal").run();
    this.#database.query("DELETE FROM session_sync_snapshot_entries").run();
    this.#database.query("DELETE FROM session_sync_remote_entries").run();
    this.#database.query("DELETE FROM session_sync_grid_positions").run();
    this.#database.query("DELETE FROM session_sync_signed_membership_epochs").run();
    this.#database.query("DELETE FROM session_sync_boot_state").run();
    this.#database.query("DELETE FROM session_sync_retry_state").run();
    this.#database.query(`
      UPDATE session_sync_directory_cursor
      SET revision = revision + 1, mode = 'idle', snapshot_id = NULL,
        snapshot_version = NULL, snapshot_cursor_json = NULL,
        change_version = '0', updated_at = ?1
      WHERE singleton = 1
    `).run(now);
    this.#database.query("DELETE FROM session_sync_vault_state").run();
    // Clock calibration is scoped to the configured API origin, not a vault.
  }

  #stageSnapshotRecord(entry: SessionDirectoryEntry): void {
    const coordinates = recordCoordinates(entry);
    if (coordinates === null) return;
    const normalized = entry.kind === "head"
      ? { kind: "upsert" as const, accepted: entry.accepted }
      : entry;
    const existing: unknown = this.#database.query(`
      SELECT record_json FROM session_sync_snapshot_entries
      WHERE session_id = ?1 LIMIT 1
    `).get(coordinates.sessionId);
    if (existing !== null) {
      throw new SessionSyncStoreError(
        "conflict",
        "A pinned session sync snapshot contains a duplicate session identity.",
      );
    }
    const countValue: unknown = this.#database.query(`
      SELECT COUNT(*) AS count FROM session_sync_snapshot_entries
    `).get();
    if (countRowSchema.parse(countValue).count >= MAX_SYNC_DIRECTORY_SESSIONS) {
      throw new SessionSyncStoreError(
        "limit",
        "Session sync snapshot exceeds the directory limit.",
      );
    }
    this.#database.query(`
      INSERT INTO session_sync_snapshot_entries(
        session_id, record_kind, origin_device_id, directory_ordinal,
        directory_version, mirror_epoch, source_revision, record_json,
        ciphertext_digest
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).run(
      coordinates.sessionId,
      coordinates.recordKind,
      coordinates.originDeviceId,
      coordinates.directoryOrdinal,
      coordinates.directoryVersion,
      coordinates.mirrorEpoch,
      coordinates.sourceRevision,
      canonicalSessionSyncJson(normalized),
      coordinates.ciphertextDigest,
    );
  }

  #commitStagedSnapshot(localDeviceId: SyncDeviceId, now: number): void {
    this.#database.query("DELETE FROM session_sync_remote_entries").run();
    const values: unknown[] = this.#database.query(`
      SELECT session_id, record_kind, origin_device_id, directory_ordinal,
        directory_version, mirror_epoch, source_revision, record_json,
        ciphertext_digest, 0 AS installed_at
      FROM session_sync_snapshot_entries
      ORDER BY length(directory_ordinal), directory_ordinal, session_id
      LIMIT ${String(MAX_SYNC_DIRECTORY_SESSIONS + 1)}
    `).all();
    if (values.length > MAX_SYNC_DIRECTORY_SESSIONS) {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "Pinned session snapshot exceeds its declared limit.",
      );
    }
    for (const value of values) {
      const row = remoteRowSchema.parse(value);
      const record = persistedRemoteRecordFromRow(row);
      this.#upsertRemoteRecord(record, localDeviceId, now);
    }
    this.#database.query(`
      DELETE FROM session_sync_grid_positions
      WHERE origin = 'remote'
        AND NOT EXISTS (
          SELECT 1 FROM session_sync_remote_entries AS remote
          WHERE remote.session_id = session_sync_grid_positions.session_id
        )
    `).run();
  }

  #upsertRemoteRecord(
    record: SessionDirectoryEntry | SessionDirectoryChange,
    localDeviceId: SyncDeviceId,
    now: number,
  ): void {
    const coordinates = recordCoordinates(record);
    if (coordinates === null) return;
    const local: unknown = this.#database.query(`
      SELECT 1 AS count FROM session_sync_pane_bindings
      WHERE session_id = ?1 LIMIT 1
    `).get(coordinates.sessionId);
    if (
      local !== null
      || coordinates.originDeviceId === localDeviceId
    ) {
      this.#database.query(`
        DELETE FROM session_sync_remote_entries WHERE session_id = ?1
      `).run(coordinates.sessionId);
      return;
    }
    const position: unknown = this.#database.query(`
      SELECT grid_position FROM session_sync_grid_positions
      WHERE session_id = ?1
    `).get(coordinates.sessionId);
    if (position === null) {
      this.#database.query(`
        INSERT INTO session_sync_grid_positions(
          session_id, grid_position, origin, discovered_at
        ) VALUES (?1, ?2, 'remote', ?3)
      `).run(coordinates.sessionId, this.#nextGridPosition(), now);
    }
    const normalized = "kind" in record && record.kind === "head"
      ? { kind: "upsert" as const, accepted: record.accepted }
      : record;
    if (normalized.kind === "mirror_reset") {
      throw new SessionSyncStoreError(
        "corrupt_state",
        "A mirror reset must be joined to its retained accepted head.",
      );
    }
    const recordJson = canonicalSessionSyncJson(normalized);
    const existingValue: unknown = this.#database.query(`
      SELECT session_id, record_kind, origin_device_id, directory_ordinal,
        directory_version, mirror_epoch, source_revision, record_json,
        ciphertext_digest, installed_at
      FROM session_sync_remote_entries WHERE session_id = ?1
    `).get(coordinates.sessionId);
    if (existingValue !== null) {
      const existing = remoteRowSchema.parse(existingValue);
      const versionComparison = decodeSyncUint64(coordinates.directoryVersion)
        - decodeSyncUint64(existing.directory_version);
      if (versionComparison < 0n) return;
      if (versionComparison === 0n) {
        if (
          existing.record_kind === coordinates.recordKind
          && existing.origin_device_id === coordinates.originDeviceId
          && existing.directory_ordinal === coordinates.directoryOrdinal
          && existing.mirror_epoch === coordinates.mirrorEpoch
          && existing.source_revision === coordinates.sourceRevision
          && existing.record_json === recordJson
          && existing.ciphertext_digest === coordinates.ciphertextDigest
        ) return;
        throw new SessionSyncStoreError(
          "conflict",
          "Equal-version session sync records must be exact replays.",
        );
      }
      const existingRecord = persistedRemoteRecordFromRow(existing);
      if (
        coordinates.directoryOrdinal !== existing.directory_ordinal
        || persistedRecordDominance(normalized)
          < persistedRecordDominance(existingRecord)
        || (normalized.kind !== "retired"
          && decodeSyncUint64(coordinates.mirrorEpoch)
            < decodeSyncUint64(existing.mirror_epoch))
        || (normalized.kind !== "retired"
          && decodeSyncUint64(coordinates.sourceRevision)
            < decodeSyncUint64(existing.source_revision))
      ) {
        throw new SessionSyncStoreError(
          "conflict",
          "A newer session sync record violates its retained authority fence.",
        );
      }
      if (
        existingRecord.kind === "offline"
        && normalized.kind === "offline"
        && !sameValue(existingRecord, normalized)
      ) {
        throw new SessionSyncStoreError(
          "conflict",
          "An offline session sync fence is immutable.",
        );
      }
    }
    this.#database.query(`
      INSERT INTO session_sync_remote_entries(
        session_id, record_kind, origin_device_id, directory_ordinal,
        directory_version, mirror_epoch, source_revision, record_json,
        ciphertext_digest, installed_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(session_id) DO UPDATE SET
        record_kind = excluded.record_kind,
        origin_device_id = excluded.origin_device_id,
        directory_ordinal = excluded.directory_ordinal,
        directory_version = excluded.directory_version,
        mirror_epoch = excluded.mirror_epoch,
        source_revision = excluded.source_revision,
        record_json = excluded.record_json,
        ciphertext_digest = excluded.ciphertext_digest,
        installed_at = excluded.installed_at
    `).run(
      coordinates.sessionId,
      coordinates.recordKind,
      coordinates.originDeviceId,
      coordinates.directoryOrdinal,
      coordinates.directoryVersion,
      coordinates.mirrorEpoch,
      coordinates.sourceRevision,
      recordJson,
      coordinates.ciphertextDigest,
      now,
    );
  }

  #applyMirrorReset(
    reset: Extract<SessionDirectoryChange, { readonly kind: "mirror_reset" }>,
    localDeviceId: SyncDeviceId,
    now: number,
  ): void {
    const value: unknown = this.#database.query(`
      SELECT session_id, record_kind, origin_device_id, directory_ordinal,
        directory_version, mirror_epoch, source_revision, record_json,
        ciphertext_digest, installed_at
      FROM session_sync_remote_entries WHERE session_id = ?1
    `).get(reset.sessionId);
    if (value === null) {
      throw new SessionSyncStoreError(
        "stale",
        "A session mirror reset requires a fresh pinned snapshot.",
      );
    }
    const row = remoteRowSchema.parse(value);
    const retained = persistedRemoteRecordFromRow(row);
    const accepted = retained.kind === "upsert" || retained.kind === "offline"
      ? retained.accepted
      : null;
    if (accepted === null) {
      throw new SessionSyncStoreError(
        "conflict",
        "A session mirror reset cannot replace a terminal authority fence.",
      );
    }
    const offline = sessionDirectoryEntrySchema.parse({
      kind: "offline",
      accepted,
      reset,
    });
    this.#upsertRemoteRecord(offline, localDeviceId, now);
  }
}
