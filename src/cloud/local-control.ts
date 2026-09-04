import { createHash } from "node:crypto";

import type { CloudControlPort } from "../daemon/ports";
import { AccountKeyLossPreconditionError } from "../domain/cloud-outcomes";
import { createCloudUuidV7 } from "../domain/uuid-v7";
import { parseAuthCredentials } from "./authCredentials";
import { parseAuthSignInResult } from "./authSession";
import {
  createConvexCloudTransport,
  type CloudTransport,
} from "./client";
import {
  acquireCloudDeploymentAuthority,
  canonicalCloudDeploymentUrl,
  cloudDeploymentSelectionFromEnvironment,
  CloudDeploymentAuthorityError,
  DeploymentScopedCloudSecretCustody,
  IdentityScopedCloudSecretCustody,
  isIdentityScopedCloudCustody,
  type CloudDeploymentAuthority,
  type CloudSecretCustodyPort,
} from "./identity-custody";
import {
  cloudLimits,
  containsAbsolutePath,
  hasExactKeys,
  isBase64Url,
  isDeviceKeyFingerprint,
  isCommandKind,
  isDigest,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  parseAuthorityTuple,
  parseCloudDeviceList,
  parseEncryptedEnvelope,
  parseWrappedKeyEnvelope,
  type AccountKeyStatus,
  type CloudDeviceClass,
  type CloudDeviceList,
  type CloudDeviceListEntry,
  type CommandState,
  type EncryptedEnvelope,
  type WrappedKeyEnvelope,
} from "./contracts";
import {
  decodeBase64Url,
  decryptBytes,
  deviceKeyFingerprint,
  encodeBase64Url,
  encryptBytes,
  exportDevicePrivateKey,
  exportDevicePublicKey,
  gcmMessageBudgetCheckpointInterval,
  gcmMessageBudgetKey,
  gcmMessageBudgetPerKey,
  generateDeviceSigningKeyPair,
  generateDeviceWrappingKeyPair,
  hmacSha256Hex,
  importP256PrivateKey,
  KeyRotationRequiredError,
  processGcmMessageBudget,
  type GcmMessageBudget,
  type GcmMessageBudgetKey,
  parseDevicePrivateKeyJson,
  parseDevicePublicKeyJson,
  randomKeyBytes,
  signDeviceBind,
  unwrapAccountDataKey,
  wrapAccountDataKey,
} from "./crypto";
import {
  encryptRemoteCommand,
  decryptSessionMetadata,
  decryptUsageProjection,
  parseRemoteCommandPayload,
  type RemoteCommandPayload,
  type SessionMetadataPayload,
} from "./payloads";
import {
  decryptCompactEvents,
  type CompactSessionEvent,
} from "./projection";

// These symbols moved out of this file. The re-exports keep existing callers
// stable until B5 splits the cloud control module.
export {
  AccountKeyLossPreconditionError,
  type AccountKeyLossPreconditionFailure,
} from "../domain/cloud-outcomes";
export { createCloudUuidV7 } from "../domain/uuid-v7";
export type { CloudSecretCustodyPort } from "./identity-custody";

const authSlot = "cloud-auth";
const authIdentitySlot = "cloud-auth-identity";
const authLogoutSlot = "cloud-auth-logout";
const accountDeletionSlot = "cloud-account-deletion";
const deviceSlot = "cloud-device";
const accountKeySlot = "cloud-account-key";
const gcmMessageBudgetSlot = "cloud-gcm-message-budget";
const stateSlot = "cloud-state";
const registrationSlot = "cloud-device-registration";
const mutationSlot = "cloud-device-mutation";
const commandOutboxSlot = "cloud-command-outbox";
const replacementSlot = "cloud-device-replacement";
const retiredDevicesSlot = "cloud-retired-devices";
const keyVersion = 1;
const refreshAfterMs = 10 * 60 * 1_000;
const authSessionTotalDurationMs = 7 * 24 * 60 * 60 * 1_000;
const maximumSyncedSessions = 25;
const maximumChunksPerSession = 8;
const maximumRemoteCommandLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const maximumDeviceMutationReceiptAgeMs = maximumRemoteCommandLifetimeMs;
const maximumDeviceMutationReceiptCount = 128;
const maximumDeviceMutationCustodyBytes = 64 * 1_024;

class AccountDeletionStatusUnavailableError extends Error {
  constructor() {
    super("Cloud account-erasure status is temporarily unavailable.");
    this.name = "AccountDeletionStatusUnavailableError";
  }
}

type DeviceStatus = "pending" | "active" | "revoked";

export interface CloudDeviceRegistrationPort {
  ensureDeviceRegistered(signal: AbortSignal): Promise<unknown>;
}

type IdentitySelectingCloudSecretCustodyPort = CloudSecretCustodyPort & Readonly<{
  activateIdentity(userPublicId: string): Promise<Readonly<{
    restartRequired: boolean;
    userPublicId: string;
  }>>;
}>;

function canSelectCloudIdentity(
  custody: CloudSecretCustodyPort,
): custody is IdentitySelectingCloudSecretCustodyPort {
  return "activateIdentity" in custody
    && typeof custody.activateIdentity === "function";
}

export function deploymentFencedSecretCustody(
  custody: CloudSecretCustodyPort,
  authority: CloudDeploymentAuthority,
): CloudSecretCustodyPort {
  const fenced: CloudSecretCustodyPort = {
    clearIfGeneration: async (slot, expectedGeneration) => {
      await authority.assertCurrent();
      const cleared = await custody.clearIfGeneration(slot, expectedGeneration);
      await authority.assertCurrent();
      return cleared;
    },
    compareAndSwap: async (slot, expectedGeneration, value) => {
      await authority.assertCurrent();
      const committed = await custody.compareAndSwap(slot, expectedGeneration, value);
      await authority.assertCurrent();
      return committed;
    },
    read: async (slot) => {
      await authority.assertCurrent();
      const observed = await custody.read(slot);
      await authority.assertCurrent();
      return observed;
    },
  };
  if (!canSelectCloudIdentity(custody)) return fenced;
  return Object.assign(fenced, {
    activateIdentity: async (userPublicId: string) => {
      await authority.assertCurrent();
      const selected = await custody.activateIdentity(userPublicId);
      await authority.assertCurrent();
      return selected;
    },
  });
}

export function deploymentFencedCloudTransport(
  transport: CloudTransport,
  authority: CloudDeploymentAuthority,
): CloudTransport {
  return {
    action: async (name, args) => {
      await authority.assertCurrent();
      const result = await transport.action(name, args);
      await authority.assertCurrent();
      return result;
    },
    mutation: async (name, args) => {
      await authority.assertCurrent();
      const result = await transport.mutation(name, args);
      await authority.assertCurrent();
      return result;
    },
    query: async (name, args) => {
      await authority.assertCurrent();
      const result = await transport.query(name, args);
      await authority.assertCurrent();
      return result;
    },
  };
}

export type LocalCloudControlOptions = Readonly<{
  deploymentAuthority: CloudDeploymentAuthority;
  deploymentUrl: string;
  deviceLabel?: string;
  // Tests inject a fresh budget to model a restarted process; production
  // uses the process-wide budget that `encryptBytes` counts against.
  gcmMessageBudget?: GcmMessageBudget;
  lifetimeSignal?: AbortSignal;
  now?: () => number;
  secretCustody: CloudSecretCustodyPort;
  transport?: CloudTransport;
}>;

export type LocalCloudControlEnvironmentOptions = Readonly<{
  deploymentAuthority?: CloudDeploymentAuthority;
  deviceLabel?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  lifetimeSignal?: AbortSignal;
  now?: () => number;
  secretCustody: CloudSecretCustodyPort;
  transport?: CloudTransport;
}>;

export type CloudRemoteSessionSelector = Readonly<{
  executionDevicePublicId: string;
  publicId: string;
}>;

export type CloudRemoteSessionHead = Readonly<{
  compactHasRecoveryGap: boolean;
  compactHeadSequence: number;
  compactStreamEpoch: number;
  createdAt: number;
  executionDevicePublicId: string;
  metadata: SessionMetadataPayload | null;
  publicId: string;
  state: "active" | "idle" | "terminal" | "orphaned";
  updatedAt: number;
}>;

export type CloudRemoteSessionProjection = CloudRemoteSessionHead & Readonly<{
  complete: boolean;
  events: readonly CompactSessionEvent[];
  recoveryGap?: Readonly<{
    kind: "projection_cache_recovery";
    streamEpoch: number;
  }>;
}>;

export type CloudRemoteCommandReceipt = Readonly<{
  commandPublicId: string;
  idempotencyKey: string;
  kind: RemoteCommandPayload["kind"];
  replay: boolean;
  sessionPublicId: string;
  state: CommandState;
  targetDevicePublicId: string;
}>;

export type CloudRemoteCommandStatus = Readonly<{
  commandPublicId: string;
  kind: RemoteCommandPayload["kind"];
  resultCode?: string;
  sessionPublicId: string;
  state: CommandState;
  targetDevicePublicId: string;
}>;

export interface CloudRemoteControlPort {
  listRemoteSessionHeads(input: Readonly<{
    limit: number;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    sessions: readonly CloudRemoteSessionHead[];
    truncated: boolean;
  }>>;
  resolveRemoteSession(input: Readonly<{
    selector: string;
    signal: AbortSignal;
  }>): Promise<CloudRemoteSessionSelector>;
  pullRemoteSession(input: Readonly<{
    selector: CloudRemoteSessionSelector;
    signal: AbortSignal;
  }>): Promise<CloudRemoteSessionProjection>;
  getRemoteCommandStatus(input: Readonly<{
    commandPublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudRemoteCommandStatus>;
  enqueueRemoteCommand(input: Readonly<{
    commandPublicId: string;
    idempotencyKey: string;
    payload: RemoteCommandPayload;
    selector: CloudRemoteSessionSelector;
    signal: AbortSignal;
  }>): Promise<CloudRemoteCommandReceipt>;
}

type AuthSecret = Readonly<{
  email: string;
  obtainedAt: number;
  refreshToken: string;
  token: string;
  version: 1;
}>;

type AuthLogoutClaim = Readonly<{
  auth: AuthSecret | null;
  phase: "logout_claim";
  requestedAt: number;
  version: 2;
}>;

type AuthSignedOut = Readonly<{
  phase: "signed_out";
  requestedAt: number;
  retiredAuthDigest: string | null;
  retiredAuthGeneration: number | null;
  version: 3;
}>;

type AuthCustody =
  | Readonly<{ auth: AuthSecret; kind: "authenticated" }>
  | Readonly<{ claim: AuthLogoutClaim; kind: "logout_claim" }>
  | Readonly<{ kind: "signed_out"; signedOut: AuthSignedOut }>;

type AuthIdentityBinding = Readonly<{
  authDigest: string;
  authEpoch: number;
  authGeneration: number;
  userPublicId: string;
  version: 1;
}>;

type PendingAuthLogout =
  | Readonly<{
      authDigest: string;
      authGeneration: number;
      phase: "prepared";
      requestedAt: number;
      version: 1;
    }>
  | Readonly<{
      authDigest: string;
      authGeneration: number;
      phase: "confirmed" | "prepared";
      requestedAt: number;
      version: 2;
    }>;

const accountDeletionCategories = [
  "commands_and_leases",
  "chunks_and_epochs",
  "session_heads",
  "usage_and_bindings",
  "codex_accounts",
  "device_custody",
  "devices",
  "receipts_and_events",
  "auth_tokens_and_verifiers",
  "auth_sessions",
  "auth_challenges",
  "auth_accounts",
  "user_and_subject",
  "complete",
] as const;

type AccountDeletionCategory = typeof accountDeletionCategories[number];

type AccountDeletionStatus = Readonly<{
  category: AccountDeletionCategory;
  createdAt: number;
  jobId: string;
  state: "pending" | "draining" | "complete";
  updatedAt: number;
}>;

type PendingAccountDeletion = Readonly<{
  jobId: string;
  requestedAt: number;
  status: AccountDeletionStatus | null;
  statusCapability: string;
  userPublicId: string;
  version: 1;
}>;

type DeviceSecret = Readonly<{
  publicId: string;
  registered: boolean;
  signingPrivateKey: string;
  signingPublicKey: string;
  userPublicId: string;
  version: 1;
  wrappingPrivateKey: string;
  wrappingPublicKey: string;
}>;

type RetiredDeviceEvidence = Readonly<{
  publicId: string;
  revision: number;
  revokedObservedAt: number;
  signingPublicKey: string;
  userPublicId: string;
  wrappingPublicKey: string;
}>;

type DeviceReplacement =
  | Readonly<{
      evidence: RetiredDeviceEvidence;
      phase: "prepared";
      version: 1;
    }>
  | Readonly<{
      evidence: RetiredDeviceEvidence;
      nextDevice: DeviceSecret;
      phase: "rotating";
      version: 1;
    }>;

type RetiredDeviceHistory = Readonly<{
  devices: readonly RetiredDeviceEvidence[];
  version: 1;
}>;

type AccountKeySecret = Readonly<{
  key: string;
  keyVersion: number;
  provisional: boolean;
  userPublicId: string;
  version: 1;
}>;

// Persisted AES-GCM message high-water marks, one per account key, so the
// per-key budget survives daemon restarts. Marks only rise and lead the true
// count by up to two checkpoint intervals. The slot is keyed by key
// fingerprint, not identity, so it is not identity-scoped custody.
type GcmMessageBudgetCustody = Readonly<{
  keys: readonly Readonly<{
    fingerprint: string;
    keyVersion: number;
    messages: number;
  }>[];
  version: 1;
}>;

const maximumGcmMessageBudgetKeys = 16;

type AccountKeyRecoveryAuthority = Readonly<{
  authEpoch: number;
  devicePublicId: string;
  keyVersion: number;
  userPublicId: string;
}>;

type AccountKeyPairingObservation = AccountKeyRecoveryAuthority & Readonly<{
  observedAt: number;
  status: "pairing_required";
}>;

type AccountKeyUnrecoverableObservation = AccountKeyRecoveryAuthority & Readonly<{
  acknowledgedAt: number;
  evidence: "operator_confirmed_no_key_holders";
  observedAt: number;
  status: "unrecoverable";
}>;

type AccountKeySupersededObservation = AccountKeyRecoveryAuthority & Readonly<{
  prior:
    | Readonly<{
        observedAt: number;
        status: "pairing_required";
      }>
    | Readonly<{
        acknowledgedAt: number;
        evidence: "operator_confirmed_no_key_holders";
        observedAt: number;
        status: "unrecoverable";
      }>;
  reason: "account_key_obtained";
  status: "superseded";
  supersededAt: number;
}>;

type AccountKeyRecoveryObservation =
  | AccountKeyPairingObservation
  | AccountKeyUnrecoverableObservation
  | AccountKeySupersededObservation;

type LocalCloudState = Readonly<{
  accountKeyRecovery: AccountKeyRecoveryObservation | null;
  lastSync: null | Readonly<{
    accountCount: number;
    at: number;
    sessionCount: number;
    usageSnapshotCount: number;
  }>;
  version: 2;
}>;

type PendingDeviceMutation =
  | Readonly<{
      expectedRevision: number;
      idempotencyKey: string;
      keyEnvelope: WrappedKeyEnvelope;
      kind: "approve";
      requestDigest: string;
      targetPublicId: string;
      version: 1;
    }>
  | Readonly<{
      expectedRevision: number;
      idempotencyKey: string;
      kind: "revoke";
      requestDigest: string;
      targetPublicId: string;
      version: 1;
    }>;

type DeviceMutationResult = Readonly<{
  publicId: string;
  revision: number;
  status: "active" | "revoked";
}>;

type DeviceMutationReceipt = Readonly<{
  completedAt: number;
  idempotencyKey: string;
  kind: PendingDeviceMutation["kind"];
  requestDigest: string;
  result: DeviceMutationResult;
  targetPublicId: string;
}>;

type DeviceMutationCustody = Readonly<{
  pending: PendingDeviceMutation | null;
  receipts: readonly DeviceMutationReceipt[];
  userPublicId: string;
  version: 2;
}>;

type ParsedDeviceMutationCustody =
  | DeviceMutationCustody
  | Readonly<{
      pending: PendingDeviceMutation;
      receipts: readonly [];
      userPublicId: null;
      version: 1;
    }>;

type PendingDeviceRegistration = Readonly<{
  bootstrapKeyEnvelope?: WrappedKeyEnvelope;
  encryptedLabel: EncryptedEnvelope;
  idempotencyKey: string;
  keyVersion: number;
  publicId: string;
  requestDigest: string;
  signingPublicKey: string;
  userPublicId: string;
  version: 1;
  wrappingPublicKey: string;
}>;

type PendingRemoteCommand = Readonly<{
  commandPublicId: string;
  deadline: number;
  envelope: EncryptedEnvelope;
  idempotencyKey: string;
  kind: RemoteCommandPayload["kind"];
  payloadDigest: string;
  requestDigest: string;
  requestedAt: number | null;
  sessionPublicId: string;
  targetDevicePublicId: string;
  version: 1 | 2;
}>;

type SecretObservation<T> = Readonly<{
  generation: number;
  serialized: string;
  value: T;
}>;


type AccountContext = Readonly<{
  authEpoch: number;
  device: null | Readonly<{
    credentialGeneration: number;
    keyVersion: number;
    publicId: string;
    revision: number;
    status: DeviceStatus;
  }>;
  hasActiveDevices: boolean;
  userPublicId: string;
}>;

type AccountOperationAuthority = Readonly<{
  account: AccountContext;
  auth: SecretObservation<Extract<AuthCustody, Readonly<{ kind: "authenticated" }>>>;
  authIdentity: SecretObservation<AuthIdentityBinding>;
}>;

type DeviceRecord = Readonly<{
  activatedAt?: number;
  deviceClass: CloudDeviceClass;
  encryptedLabel: EncryptedEnvelope;
  keyVersion: number;
  lastSeenAt: number | null;
  online: boolean;
  publicId: string;
  revision: number;
  signingPublicKey: string;
  status: DeviceStatus;
  userPublicId: string;
  wrappingPublicKey: string;
}>;

type DevicePage = Readonly<{
  continueCursor: string;
  isDone: boolean;
  page: readonly DeviceRecord[];
  userPublicId: string;
}>;

type SessionHead = Readonly<{
  compactHasRecoveryGap: boolean;
  compactHeadSequence: number;
  compactStreamEpoch: number;
  compactTailDigest?: string;
  createdAt: number;
  detailHeadSequence: number;
  detailTailDigest?: string;
  executionDevicePublicId: string;
  metadata?: EncryptedEnvelope;
  metadataRevision: number;
  projectionRevision: number;
  publicId: string;
  state: "active" | "idle" | "terminal" | "orphaned";
  updatedAt: number;
}>;

type SessionChunk = Readonly<{
  authority: Readonly<{ bootGeneration: number; bootId: string; fence: number }>;
  createdAt: number;
  digest: string;
  envelope: EncryptedEnvelope;
  firstSequence: number;
  lastSequence: number;
  previousDigest?: string;
  sourceDevicePublicId: string;
  stream: "compact";
  streamEpoch: number;
}>;

type SessionHeadPage = Readonly<{
  continueCursor: string;
  isDone: boolean;
  page: readonly SessionHead[];
}>;

type CloudAccount = Readonly<{
  publicId: string;
  updatedAt: number;
}>;

type UsageSnapshot = Readonly<{
  envelope: EncryptedEnvelope;
  observedAt: number;
}>;

function isBoundedToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 32
    && value.length <= 16_384
    && !/\s/u.test(value);
}

function parseAuthSecretValue(decoded: unknown): AuthSecret {
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, ["email", "obtainedAt", "refreshToken", "token", "version"])
    || decoded.version !== 1
    || parseAuthCredentials({ email: decoded.email }).kind === "rejected"
    || !isFiniteTimestamp(decoded.obtainedAt)
    || !isBoundedToken(decoded.refreshToken)
    || !isBoundedToken(decoded.token)
  ) throw new Error("Cloud auth custody is corrupt.");
  return {
    email: decoded.email as string,
    obtainedAt: decoded.obtainedAt,
    refreshToken: decoded.refreshToken,
    token: decoded.token,
    version: decoded.version,
  };
}

function parseAuthCustody(value: string): AuthCustody {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud auth custody is corrupt.");
  }
  if (
    isRecord(decoded)
    && decoded.version === 2
    && hasExactKeys(decoded, ["auth", "phase", "requestedAt", "version"])
    && decoded.phase === "logout_claim"
    && isFiniteTimestamp(decoded.requestedAt)
  ) {
    return {
      claim: {
        auth: decoded.auth === null ? null : parseAuthSecretValue(decoded.auth),
        phase: "logout_claim",
        requestedAt: decoded.requestedAt,
        version: 2,
      },
      kind: "logout_claim",
    };
  }
  if (
    isRecord(decoded)
    && decoded.version === 3
    && hasExactKeys(decoded, [
      "phase",
      "requestedAt",
      "retiredAuthDigest",
      "retiredAuthGeneration",
      "version",
    ])
    && decoded.phase === "signed_out"
    && isFiniteTimestamp(decoded.requestedAt)
    && (
      (decoded.retiredAuthDigest === null && decoded.retiredAuthGeneration === null)
      || (
        isDigest(decoded.retiredAuthDigest)
        && isSafeNonNegativeInteger(decoded.retiredAuthGeneration)
      )
    )
  ) {
    return {
      kind: "signed_out",
      signedOut: {
        phase: "signed_out",
        requestedAt: decoded.requestedAt,
        retiredAuthDigest: decoded.retiredAuthDigest,
        retiredAuthGeneration: decoded.retiredAuthGeneration,
        version: 3,
      },
    };
  }
  return { auth: parseAuthSecretValue(decoded), kind: "authenticated" };
}

function parseAuthIdentityBinding(value: string): AuthIdentityBinding {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud auth-identity binding is corrupt.");
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, [
      "authDigest",
      "authEpoch",
      "authGeneration",
      "userPublicId",
      "version",
    ])
    || decoded.version !== 1
    || !isDigest(decoded.authDigest)
    || !isSafePositiveInteger(decoded.authEpoch)
    || !isSafeNonNegativeInteger(decoded.authGeneration)
    || !isOpaqueIdentifier(decoded.userPublicId)
  ) throw new Error("Cloud auth-identity binding is corrupt.");
  return {
    authDigest: decoded.authDigest,
    authEpoch: decoded.authEpoch,
    authGeneration: decoded.authGeneration,
    userPublicId: decoded.userPublicId,
    version: 1,
  };
}

function parsePendingAuthLogout(value: string): PendingAuthLogout {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud sign-out intent is corrupt.");
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, [
      "authDigest",
      "authGeneration",
      ...(decoded.version === 2 ? ["phase"] : []),
      "requestedAt",
      "version",
    ])
    || (decoded.version !== 1 && decoded.version !== 2)
    || !isDigest(decoded.authDigest)
    || !isSafeNonNegativeInteger(decoded.authGeneration)
    || (decoded.version === 2 && decoded.phase !== "prepared" && decoded.phase !== "confirmed")
    || !isFiniteTimestamp(decoded.requestedAt)
  ) throw new Error("Cloud sign-out intent is corrupt.");
  if (decoded.version === 1) {
    return {
      authDigest: decoded.authDigest,
      authGeneration: decoded.authGeneration,
      phase: "prepared",
      requestedAt: decoded.requestedAt,
      version: 1,
    };
  }
  if (decoded.phase !== "prepared" && decoded.phase !== "confirmed") {
    throw new Error("Cloud sign-out intent is corrupt.");
  }
  return {
    authDigest: decoded.authDigest,
    authGeneration: decoded.authGeneration,
    phase: decoded.phase,
    requestedAt: decoded.requestedAt,
    version: 2,
  };
}

function parseAccountDeletionStatus(
  value: unknown,
  expectedJobId: string,
): AccountDeletionStatus {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["category", "createdAt", "jobId", "state", "updatedAt"])
    || value.jobId !== expectedJobId
    || !isUuidV7(value.jobId)
    || !isFiniteTimestamp(value.createdAt)
    || !isFiniteTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt
    || (value.state !== "pending" && value.state !== "draining" && value.state !== "complete")
  ) throw new Error("Cloud account-erasure status is invalid.");
  const category = accountDeletionCategories.find((candidate) => candidate === value.category);
  if (category === undefined || (value.state === "complete") !== (category === "complete")) {
    throw new Error("Cloud account-erasure status is invalid.");
  }
  return {
    category,
    createdAt: value.createdAt,
    jobId: value.jobId,
    state: value.state,
    updatedAt: value.updatedAt,
  };
}

function parseAccountDeletionRequestResponse(
  value: unknown,
  pending: PendingAccountDeletion,
): AccountDeletionStatus {
  if (!isRecord(value) || typeof value.replay !== "boolean") {
    throw new Error("Cloud account-erasure response is invalid.");
  }
  const expectedKeys = value.replay
    ? ["category", "createdAt", "jobId", "replay", "state", "updatedAt"]
    : ["category", "createdAt", "jobId", "replay", "state", "statusCapability", "updatedAt"];
  if (
    !hasExactKeys(value, expectedKeys)
    || (!value.replay && value.statusCapability !== pending.statusCapability)
  ) throw new Error("Cloud account-erasure response is invalid.");
  return parseAccountDeletionStatus({
    category: value.category,
    createdAt: value.createdAt,
    jobId: value.jobId,
    state: value.state,
    updatedAt: value.updatedAt,
  }, pending.jobId);
}

function parsePendingAccountDeletion(value: string): PendingAccountDeletion {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud account-erasure recovery custody is corrupt.");
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, [
      "jobId",
      "requestedAt",
      "status",
      "statusCapability",
      "userPublicId",
      "version",
    ])
    || decoded.version !== 1
    || !isUuidV7(decoded.jobId)
    || !isFiniteTimestamp(decoded.requestedAt)
    || !isBase64Url(decoded.statusCapability, 43, 96)
    || !isOpaqueIdentifier(decoded.userPublicId)
  ) throw new Error("Cloud account-erasure recovery custody is corrupt.");
  return {
    jobId: decoded.jobId,
    requestedAt: decoded.requestedAt,
    status: decoded.status === null
      ? null
      : parseAccountDeletionStatus(decoded.status, decoded.jobId),
    statusCapability: decoded.statusCapability,
    userPublicId: decoded.userPublicId,
    version: 1,
  };
}

function parseDeviceSecret(value: string): DeviceSecret {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud device custody is corrupt.");
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, [
      "publicId",
      "registered",
      "signingPrivateKey",
      "signingPublicKey",
      "userPublicId",
      "version",
      "wrappingPrivateKey",
      "wrappingPublicKey",
    ])
    || decoded.version !== 1
    || !isOpaqueIdentifier(decoded.publicId)
    || typeof decoded.registered !== "boolean"
    || !isOpaqueIdentifier(decoded.userPublicId)
    || parseDevicePrivateKeyJson(decoded.signingPrivateKey) === null
    || typeof decoded.signingPublicKey !== "string"
    || parseDevicePublicKeyJson(decoded.signingPublicKey) === null
    || parseDevicePrivateKeyJson(decoded.wrappingPrivateKey) === null
    || typeof decoded.wrappingPublicKey !== "string"
    || parseDevicePublicKeyJson(decoded.wrappingPublicKey) === null
  ) throw new Error("Cloud device custody is corrupt.");
  return decoded as DeviceSecret;
}

function sameDeviceSecret(left: DeviceSecret, right: DeviceSecret): boolean {
  return left.publicId === right.publicId
    && left.registered === right.registered
    && left.signingPrivateKey === right.signingPrivateKey
    && left.signingPublicKey === right.signingPublicKey
    && left.userPublicId === right.userPublicId
    && left.wrappingPrivateKey === right.wrappingPrivateKey
    && left.wrappingPublicKey === right.wrappingPublicKey;
}

function parseRetiredDeviceEvidence(value: unknown): RetiredDeviceEvidence {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "publicId",
      "revision",
      "revokedObservedAt",
      "signingPublicKey",
      "userPublicId",
      "wrappingPublicKey",
    ])
    || !isOpaqueIdentifier(value.publicId)
    || !isSafePositiveInteger(value.revision)
    || !isFiniteTimestamp(value.revokedObservedAt)
    || typeof value.signingPublicKey !== "string"
    || parseDevicePublicKeyJson(value.signingPublicKey) === null
    || !isOpaqueIdentifier(value.userPublicId)
    || typeof value.wrappingPublicKey !== "string"
    || parseDevicePublicKeyJson(value.wrappingPublicKey) === null
  ) throw new Error("Cloud retired-device evidence is corrupt.");
  return value as RetiredDeviceEvidence;
}

function sameRetiredDeviceEvidence(
  left: RetiredDeviceEvidence,
  right: RetiredDeviceEvidence,
): boolean {
  return left.publicId === right.publicId
    && left.revision === right.revision
    && left.revokedObservedAt === right.revokedObservedAt
    && left.signingPublicKey === right.signingPublicKey
    && left.userPublicId === right.userPublicId
    && left.wrappingPublicKey === right.wrappingPublicKey;
}

function parseDeviceReplacement(value: string): DeviceReplacement {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud device-replacement evidence is corrupt.");
  }
  if (
    !isRecord(decoded)
    || (decoded.phase !== "prepared" && decoded.phase !== "rotating")
    || decoded.version !== 1
  ) throw new Error("Cloud device-replacement evidence is corrupt.");
  const expected = decoded.phase === "prepared"
    ? ["evidence", "phase", "version"]
    : ["evidence", "nextDevice", "phase", "version"];
  if (!hasExactKeys(decoded, expected)) {
    throw new Error("Cloud device-replacement evidence is corrupt.");
  }
  const evidence = parseRetiredDeviceEvidence(decoded.evidence);
  if (decoded.phase === "prepared") return { evidence, phase: decoded.phase, version: 1 };
  let nextDevice: DeviceSecret;
  try {
    nextDevice = parseDeviceSecret(JSON.stringify(decoded.nextDevice));
  } catch {
    throw new Error("Cloud device-replacement evidence is corrupt.");
  }
  if (nextDevice.registered || nextDevice.userPublicId !== evidence.userPublicId) {
    throw new Error("Cloud device-replacement evidence is corrupt.");
  }
  return { evidence, nextDevice, phase: decoded.phase, version: 1 };
}

function parseRetiredDeviceHistory(value: string): RetiredDeviceHistory {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud retired-device history is corrupt.");
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, ["devices", "version"])
    || decoded.version !== 1
    || !Array.isArray(decoded.devices)
    || decoded.devices.length > 100
  ) throw new Error("Cloud retired-device history is corrupt.");
  const devices = decoded.devices.map(parseRetiredDeviceEvidence);
  if (new Set(devices.map((device) => device.publicId)).size !== devices.length) {
    throw new Error("Cloud retired-device history is corrupt.");
  }
  return { devices, version: 1 };
}

function parseAccountKeySecret(value: string): AccountKeySecret {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud account-key custody is corrupt.");
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, [
      "key",
      "keyVersion",
      "provisional",
      "userPublicId",
      "version",
    ])
    || decoded.version !== 1
    || typeof decoded.key !== "string"
    || !isSafePositiveInteger(decoded.keyVersion)
    || typeof decoded.provisional !== "boolean"
    || !isOpaqueIdentifier(decoded.userPublicId)
  ) throw new Error("Cloud account-key custody is corrupt.");
  let key: Uint8Array;
  try {
    key = decodeBase64Url(decoded.key);
  } catch {
    throw new Error("Cloud account-key custody is corrupt.");
  }
  if (key.byteLength !== 32) throw new Error("Cloud account-key custody is corrupt.");
  return decoded as AccountKeySecret;
}

function parseAccountKeyRecoveryObservation(
  value: unknown,
): AccountKeyRecoveryObservation | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || !isSafeNonNegativeInteger(value.authEpoch)
    || !isOpaqueIdentifier(value.devicePublicId)
    || !isSafePositiveInteger(value.keyVersion)
    || !isOpaqueIdentifier(value.userPublicId)
    || typeof value.status !== "string"
  ) throw new Error("Cloud account-key recovery evidence is corrupt.");
  const authority = {
    authEpoch: value.authEpoch,
    devicePublicId: value.devicePublicId,
    keyVersion: value.keyVersion,
    userPublicId: value.userPublicId,
  };
  if (value.status === "pairing_required") {
    if (
      !hasExactKeys(value, [
        "authEpoch",
        "devicePublicId",
        "keyVersion",
        "observedAt",
        "status",
        "userPublicId",
      ])
      || !isFiniteTimestamp(value.observedAt)
    ) throw new Error("Cloud account-key recovery evidence is corrupt.");
    return { ...authority, observedAt: value.observedAt, status: value.status };
  }
  if (value.status === "unrecoverable") {
    if (
      !hasExactKeys(value, [
        "acknowledgedAt",
        "authEpoch",
        "devicePublicId",
        "evidence",
        "keyVersion",
        "observedAt",
        "status",
        "userPublicId",
      ])
      || !isFiniteTimestamp(value.acknowledgedAt)
      || value.evidence !== "operator_confirmed_no_key_holders"
      || !isFiniteTimestamp(value.observedAt)
    ) throw new Error("Cloud account-key recovery evidence is corrupt.");
    return {
      ...authority,
      acknowledgedAt: value.acknowledgedAt,
      evidence: value.evidence,
      observedAt: value.observedAt,
      status: value.status,
    };
  }
  if (value.status === "superseded") {
    if (
      !hasExactKeys(value, [
        "authEpoch",
        "devicePublicId",
        "keyVersion",
        "prior",
        "reason",
        "status",
        "supersededAt",
        "userPublicId",
      ])
      || value.reason !== "account_key_obtained"
      || !isFiniteTimestamp(value.supersededAt)
      || !isRecord(value.prior)
      || typeof value.prior.status !== "string"
    ) throw new Error("Cloud account-key recovery evidence is corrupt.");
    if (
      value.prior.status === "pairing_required"
      && hasExactKeys(value.prior, ["observedAt", "status"])
      && isFiniteTimestamp(value.prior.observedAt)
    ) {
      return {
        ...authority,
        prior: { observedAt: value.prior.observedAt, status: value.prior.status },
        reason: value.reason,
        status: value.status,
        supersededAt: value.supersededAt,
      };
    }
    if (
      value.prior.status === "unrecoverable"
      && hasExactKeys(value.prior, ["acknowledgedAt", "evidence", "observedAt", "status"])
      && isFiniteTimestamp(value.prior.acknowledgedAt)
      && value.prior.evidence === "operator_confirmed_no_key_holders"
      && isFiniteTimestamp(value.prior.observedAt)
    ) {
      return {
        ...authority,
        prior: {
          acknowledgedAt: value.prior.acknowledgedAt,
          evidence: value.prior.evidence,
          observedAt: value.prior.observedAt,
          status: value.prior.status,
        },
        reason: value.reason,
        status: value.status,
        supersededAt: value.supersededAt,
      };
    }
  }
  throw new Error("Cloud account-key recovery evidence is corrupt.");
}

function parseGcmMessageBudgetCustody(value: string): GcmMessageBudgetCustody {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud GCM message budget custody is corrupt.");
  }
  if (
    !isRecord(decoded)
    || decoded.version !== 1
    || !hasExactKeys(decoded, ["keys", "version"])
    || !Array.isArray(decoded.keys)
    || decoded.keys.length > maximumGcmMessageBudgetKeys
  ) throw new Error("Cloud GCM message budget custody is corrupt.");
  const keys: Array<GcmMessageBudgetCustody["keys"][number]> = [];
  const seen = new Set<string>();
  for (const entry of decoded.keys) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["fingerprint", "keyVersion", "messages"])
      || typeof entry.fingerprint !== "string"
      || !/^[0-9a-f]{32}$/u.test(entry.fingerprint)
      || !isSafePositiveInteger(entry.keyVersion)
      || !isSafeNonNegativeInteger(entry.messages)
      || entry.messages > gcmMessageBudgetPerKey
      || seen.has(`${entry.keyVersion}:${entry.fingerprint}`)
    ) throw new Error("Cloud GCM message budget custody is corrupt.");
    seen.add(`${entry.keyVersion}:${entry.fingerprint}`);
    keys.push({
      fingerprint: entry.fingerprint,
      keyVersion: entry.keyVersion,
      messages: entry.messages,
    });
  }
  return { keys, version: 1 };
}

function parseLocalState(value: string): LocalCloudState {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud local state is corrupt.");
  }
  if (
    !isRecord(decoded)
    || (
      decoded.version === 1
        ? !hasExactKeys(decoded, ["lastSync", "version"])
        : decoded.version !== 2
          || !hasExactKeys(decoded, ["accountKeyRecovery", "lastSync", "version"])
    )
  ) throw new Error("Cloud local state is corrupt.");
  let lastSync: LocalCloudState["lastSync"];
  if (decoded.lastSync === null) {
    lastSync = null;
  } else {
    if (
      !isRecord(decoded.lastSync)
      || !hasExactKeys(decoded.lastSync, [
        "accountCount",
        "at",
        "sessionCount",
        "usageSnapshotCount",
      ])
      || !isSafeNonNegativeInteger(decoded.lastSync.accountCount)
      || !isFiniteTimestamp(decoded.lastSync.at)
      || !isSafeNonNegativeInteger(decoded.lastSync.sessionCount)
      || !isSafeNonNegativeInteger(decoded.lastSync.usageSnapshotCount)
    ) throw new Error("Cloud local state is corrupt.");
    lastSync = {
      accountCount: decoded.lastSync.accountCount,
      at: decoded.lastSync.at,
      sessionCount: decoded.lastSync.sessionCount,
      usageSnapshotCount: decoded.lastSync.usageSnapshotCount,
    };
  }
  return {
    accountKeyRecovery: decoded.version === 1
      ? null
      : parseAccountKeyRecoveryObservation(decoded.accountKeyRecovery),
    lastSync,
    version: 2,
  };
}

function parsePendingDeviceMutation(value: string): PendingDeviceMutation {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Pending cloud device mutation is corrupt.");
  }
  if (
    !isRecord(decoded)
    || (decoded.kind !== "approve" && decoded.kind !== "revoke")
    || decoded.version !== 1
    || !isSafePositiveInteger(decoded.expectedRevision)
    || !isUuidV7(decoded.idempotencyKey)
    || !isDigest(decoded.requestDigest)
    || !isOpaqueIdentifier(decoded.targetPublicId)
  ) throw new Error("Pending cloud device mutation is corrupt.");
  if (decoded.kind === "approve") {
    const envelope = parseWrappedKeyEnvelope(decoded.keyEnvelope);
    if (
      !hasExactKeys(decoded, [
        "expectedRevision",
        "idempotencyKey",
        "keyEnvelope",
        "kind",
        "requestDigest",
        "targetPublicId",
        "version",
      ])
      || envelope === null
    ) throw new Error("Pending cloud device mutation is corrupt.");
    return {
      expectedRevision: decoded.expectedRevision,
      idempotencyKey: decoded.idempotencyKey,
      keyEnvelope: envelope,
      kind: decoded.kind,
      requestDigest: decoded.requestDigest,
      targetPublicId: decoded.targetPublicId,
      version: decoded.version,
    };
  }
  if (!hasExactKeys(decoded, [
    "expectedRevision",
    "idempotencyKey",
    "kind",
    "requestDigest",
    "targetPublicId",
    "version",
  ])) throw new Error("Pending cloud device mutation is corrupt.");
  return {
    expectedRevision: decoded.expectedRevision,
    idempotencyKey: decoded.idempotencyKey,
    kind: decoded.kind,
    requestDigest: decoded.requestDigest,
    targetPublicId: decoded.targetPublicId,
    version: decoded.version,
  };
}

function parseDeviceMutationReceipt(value: unknown): DeviceMutationReceipt {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "completedAt",
      "idempotencyKey",
      "kind",
      "requestDigest",
      "result",
      "targetPublicId",
    ])
    || !isFiniteTimestamp(value.completedAt)
    || !isUuidV7(value.idempotencyKey)
    || (value.kind !== "approve" && value.kind !== "revoke")
    || !isDigest(value.requestDigest)
    || !isOpaqueIdentifier(value.targetPublicId)
    || !isRecord(value.result)
    || !hasExactKeys(value.result, ["publicId", "revision", "status"])
    || value.result.publicId !== value.targetPublicId
    || !isSafePositiveInteger(value.result.revision)
    || (value.kind === "approve" && value.result.status !== "active")
    || (value.kind === "revoke" && value.result.status !== "revoked")
  ) throw new Error("Cloud device-mutation custody is corrupt.");
  return {
    completedAt: value.completedAt,
    idempotencyKey: value.idempotencyKey,
    kind: value.kind,
    requestDigest: value.requestDigest,
    result: {
      publicId: value.result.publicId,
      revision: value.result.revision,
      status: value.kind === "approve" ? "active" : "revoked",
    },
    targetPublicId: value.targetPublicId,
  };
}

function parseDeviceMutationCustody(value: string): ParsedDeviceMutationCustody {
  if (new TextEncoder().encode(value).byteLength > maximumDeviceMutationCustodyBytes) {
    throw new Error("Cloud device-mutation custody is corrupt.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Cloud device-mutation custody is corrupt.");
  }
  if (isRecord(decoded) && decoded.version === 1) {
    return {
      pending: parsePendingDeviceMutation(value),
      receipts: [],
      userPublicId: null,
      version: 1,
    };
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, ["pending", "receipts", "userPublicId", "version"])
    || decoded.version !== 2
    || !isOpaqueIdentifier(decoded.userPublicId)
    || !Array.isArray(decoded.receipts)
    || decoded.receipts.length > maximumDeviceMutationReceiptCount
  ) throw new Error("Cloud device-mutation custody is corrupt.");
  const pending = decoded.pending === null
    ? null
    : parsePendingDeviceMutation(JSON.stringify(decoded.pending));
  const receipts = decoded.receipts.map(parseDeviceMutationReceipt);
  const receiptKeys = new Set(receipts.map((receipt) => receipt.idempotencyKey));
  if (
    receiptKeys.size !== receipts.length
    || (pending !== null && receiptKeys.has(pending.idempotencyKey))
  ) throw new Error("Cloud device-mutation custody is corrupt.");
  return {
    pending,
    receipts,
    userPublicId: decoded.userPublicId,
    version: 2,
  };
}

function boundedDeviceMutationCustody(
  value: DeviceMutationCustody,
  now: number,
): Readonly<{ serialized: string; value: DeviceMutationCustody }> {
  let receipts = value.receipts.filter((receipt) =>
    receipt.completedAt > now - maximumDeviceMutationReceiptAgeMs);
  if (receipts.length > maximumDeviceMutationReceiptCount) {
    receipts = receipts.slice(-maximumDeviceMutationReceiptCount);
  }
  let bounded: DeviceMutationCustody = { ...value, receipts };
  let serialized = JSON.stringify(bounded);
  while (
    receipts.length > 0
    && new TextEncoder().encode(serialized).byteLength > maximumDeviceMutationCustodyBytes
  ) {
    receipts = receipts.slice(1);
    bounded = { ...bounded, receipts };
    serialized = JSON.stringify(bounded);
  }
  if (new TextEncoder().encode(serialized).byteLength > maximumDeviceMutationCustodyBytes) {
    throw new Error("Cloud device-mutation custody exceeds its durable size bound.");
  }
  return { serialized, value: bounded };
}

function parsePendingDeviceRegistration(value: string): PendingDeviceRegistration {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Pending cloud device registration is corrupt.");
  }
  if (!isRecord(decoded)) throw new Error("Pending cloud device registration is corrupt.");
  const expected = [
    ...(decoded.bootstrapKeyEnvelope === undefined ? [] : ["bootstrapKeyEnvelope"]),
    "encryptedLabel",
    "idempotencyKey",
    "keyVersion",
    "publicId",
    "requestDigest",
    "signingPublicKey",
    "userPublicId",
    "version",
    "wrappingPublicKey",
  ];
  const bootstrapKeyEnvelope = decoded.bootstrapKeyEnvelope === undefined
    ? undefined
    : parseWrappedKeyEnvelope(decoded.bootstrapKeyEnvelope);
  const encryptedLabel = parseEncryptedEnvelope(
    decoded.encryptedLabel,
    cloudLimits.deviceLabelCiphertextCharacters,
  );
  if (
    !hasExactKeys(decoded, expected)
    || decoded.version !== 1
    || (decoded.bootstrapKeyEnvelope !== undefined && bootstrapKeyEnvelope === null)
    || encryptedLabel === null
    || !isUuidV7(decoded.idempotencyKey)
    || !isSafePositiveInteger(decoded.keyVersion)
    || !isOpaqueIdentifier(decoded.publicId)
    || !isDigest(decoded.requestDigest)
    || typeof decoded.signingPublicKey !== "string"
    || parseDevicePublicKeyJson(decoded.signingPublicKey) === null
    || !isOpaqueIdentifier(decoded.userPublicId)
    || typeof decoded.wrappingPublicKey !== "string"
    || parseDevicePublicKeyJson(decoded.wrappingPublicKey) === null
  ) throw new Error("Pending cloud device registration is corrupt.");
  return {
    ...(bootstrapKeyEnvelope === undefined || bootstrapKeyEnvelope === null
      ? {}
      : { bootstrapKeyEnvelope }),
    encryptedLabel,
    idempotencyKey: decoded.idempotencyKey,
    keyVersion: decoded.keyVersion,
    publicId: decoded.publicId,
    requestDigest: decoded.requestDigest,
    signingPublicKey: decoded.signingPublicKey,
    userPublicId: decoded.userPublicId,
    version: 1,
    wrappingPublicKey: decoded.wrappingPublicKey,
  };
}

function deviceRegistrationRequest(pending: PendingDeviceRegistration) {
  return {
    ...(pending.bootstrapKeyEnvelope === undefined
      ? {}
      : { bootstrapKeyEnvelope: pending.bootstrapKeyEnvelope }),
    encryptedLabel: pending.encryptedLabel,
    idempotencyKey: pending.idempotencyKey,
    keyVersion: pending.keyVersion,
    publicId: pending.publicId,
    signingPublicKey: pending.signingPublicKey,
    wrappingPublicKey: pending.wrappingPublicKey,
  };
}

function parsePendingRemoteCommand(value: string): PendingRemoteCommand {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Pending cloud remote command is corrupt.");
  }
  if (!isRecord(decoded) || !hasExactKeys(decoded, [
    "commandPublicId",
    "deadline",
    "envelope",
    "idempotencyKey",
    "kind",
    "payloadDigest",
    "requestDigest",
    ...(decoded.version === 2 ? ["requestedAt"] : []),
    "sessionPublicId",
    "targetDevicePublicId",
    "version",
  ])) throw new Error("Pending cloud remote command is corrupt.");
  const envelope = parseEncryptedEnvelope(decoded.envelope);
  if (
    (decoded.version !== 1 && decoded.version !== 2)
    || !isUuidV7(decoded.commandPublicId)
    || !isFiniteTimestamp(decoded.deadline)
    || envelope === null
    || !isUuidV7(decoded.idempotencyKey)
    || !isCommandKind(decoded.kind)
    || !isDigest(decoded.payloadDigest)
    || !isDigest(decoded.requestDigest)
    || (decoded.version === 2
      && (!isFiniteTimestamp(decoded.requestedAt) || decoded.requestedAt > decoded.deadline))
    || !isOpaqueIdentifier(decoded.sessionPublicId)
    || !isOpaqueIdentifier(decoded.targetDevicePublicId)
  ) throw new Error("Pending cloud remote command is corrupt.");
  return {
    commandPublicId: decoded.commandPublicId,
    deadline: decoded.deadline,
    envelope,
    idempotencyKey: decoded.idempotencyKey,
    kind: decoded.kind,
    payloadDigest: decoded.payloadDigest,
    requestDigest: decoded.requestDigest,
    requestedAt: decoded.version === 2 ? decoded.requestedAt as number : null,
    sessionPublicId: decoded.sessionPublicId,
    targetDevicePublicId: decoded.targetDevicePublicId,
    version: decoded.version,
  };
}

function sameRemoteCommandIntent(
  pending: PendingRemoteCommand,
  desired: Readonly<{
    commandPublicId: string;
    idempotencyKey: string;
    kind: RemoteCommandPayload["kind"];
    payloadDigest: string;
    sessionPublicId: string;
    targetDevicePublicId: string;
  }>,
): boolean {
  return pending.commandPublicId === desired.commandPublicId
    && pending.idempotencyKey === desired.idempotencyKey
    && pending.kind === desired.kind
    && pending.payloadDigest === desired.payloadDigest
    && pending.sessionPublicId === desired.sessionPublicId
    && pending.targetDevicePublicId === desired.targetDevicePublicId;
}

function parseAccountContext(value: unknown): AccountContext {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "authEpoch",
      "device",
      "hasActiveDevices",
      "userPublicId",
    ])
    || !isSafePositiveInteger(value.authEpoch)
    || typeof value.hasActiveDevices !== "boolean"
    || !isOpaqueIdentifier(value.userPublicId)
  ) throw new Error("Cloud account response is invalid.");
  if (value.device === null) {
    return {
      authEpoch: value.authEpoch,
      device: null,
      hasActiveDevices: value.hasActiveDevices,
      userPublicId: value.userPublicId,
    };
  }
  if (
    !isRecord(value.device)
    || !hasExactKeys(
      value.device,
      Object.hasOwn(value.device, "credentialGeneration")
        ? ["credentialGeneration", "keyVersion", "publicId", "revision", "status"]
        : ["keyVersion", "publicId", "revision", "status"],
    )
    || (Object.hasOwn(value.device, "credentialGeneration")
      && !isSafePositiveInteger(value.device.credentialGeneration))
    || !isSafePositiveInteger(value.device.keyVersion)
    || !isOpaqueIdentifier(value.device.publicId)
    || !isSafePositiveInteger(value.device.revision)
    || (value.device.status !== "pending"
      && value.device.status !== "active"
      && value.device.status !== "revoked")
  ) throw new Error("Cloud account response is invalid.");
  return {
    authEpoch: value.authEpoch,
    device: {
      credentialGeneration: Object.hasOwn(value.device, "credentialGeneration")
        && typeof value.device.credentialGeneration === "number"
          ? value.device.credentialGeneration
          : 1,
      keyVersion: value.device.keyVersion,
      publicId: value.device.publicId,
      revision: value.device.revision,
      status: value.device.status,
    },
    hasActiveDevices: value.hasActiveDevices,
    userPublicId: value.userPublicId,
  };
}

function sameAccountContext(left: AccountContext, right: AccountContext): boolean {
  return left.authEpoch === right.authEpoch
    && left.hasActiveDevices === right.hasActiveDevices
    && left.userPublicId === right.userPublicId
    && (left.device === null) === (right.device === null)
    && (left.device === null || right.device === null || (
      left.device.credentialGeneration === right.device.credentialGeneration
      && left.device.keyVersion === right.device.keyVersion
      && left.device.publicId === right.device.publicId
      && left.device.revision === right.device.revision
      && left.device.status === right.device.status
    ));
}

function publicAccountDevice(device: AccountContext["device"]): null | Readonly<{
  keyVersion: number;
  publicId: string;
  revision: number;
  status: DeviceStatus;
}> {
  if (device === null) return null;
  return {
    keyVersion: device.keyVersion,
    publicId: device.publicId,
    revision: device.revision,
    status: device.status,
  };
}

// The summary carries the device class for the browser app. A daemon acts on
// its own registration and mutations, so it validates the field and keeps the
// durable local mutation receipt in its existing three-field shape.
function parseDeviceSummary(value: unknown): Readonly<{
  publicId: string;
  revision: number;
  status: DeviceStatus;
}> {
  const required = ["publicId", "revision", "status"];
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      value.deviceClass === undefined ? required : [...required, "deviceClass"],
    )
    || (value.deviceClass !== undefined
      && value.deviceClass !== "daemon"
      && value.deviceClass !== "browser")
    || !isOpaqueIdentifier(value.publicId)
    || !isSafePositiveInteger(value.revision)
    || (value.status !== "pending" && value.status !== "active" && value.status !== "revoked")
  ) throw new Error("Cloud device response is invalid.");
  return { publicId: value.publicId, revision: value.revision, status: value.status };
}

function parseDeviceRecord(value: unknown): DeviceRecord {
  if (!isRecord(value)) throw new Error("Cloud device response is invalid.");
  const required = [
    "deviceClass",
    "encryptedLabel",
    "keyVersion",
    "lastSeenAt",
    "online",
    "publicId",
    "revision",
    "signingPublicKey",
    "status",
    "userPublicId",
    "wrappingPublicKey",
  ];
  const keys = value.activatedAt === undefined ? required : [...required, "activatedAt"];
  const encryptedLabel = parseEncryptedEnvelope(value.encryptedLabel, 2_048);
  if (
    !hasExactKeys(value, keys)
    || encryptedLabel === null
    || (value.deviceClass !== "daemon" && value.deviceClass !== "browser")
    || !isSafePositiveInteger(value.keyVersion)
    || (value.lastSeenAt !== null && !isFiniteTimestamp(value.lastSeenAt))
    || typeof value.online !== "boolean"
    || (value.online && value.lastSeenAt === null)
    || !isOpaqueIdentifier(value.publicId)
    || !isSafePositiveInteger(value.revision)
    || (value.status !== "pending" && value.status !== "active" && value.status !== "revoked")
    || (value.status === "revoked" && value.online)
    || !isOpaqueIdentifier(value.userPublicId)
    || typeof value.signingPublicKey !== "string"
    || parseDevicePublicKeyJson(value.signingPublicKey) === null
    || typeof value.wrappingPublicKey !== "string"
    || parseDevicePublicKeyJson(value.wrappingPublicKey) === null
    || (value.activatedAt !== undefined && !isFiniteTimestamp(value.activatedAt))
  ) throw new Error("Cloud device response is invalid.");
  return {
    ...(typeof value.activatedAt === "number" ? { activatedAt: value.activatedAt } : {}),
    deviceClass: value.deviceClass,
    encryptedLabel,
    keyVersion: value.keyVersion,
    lastSeenAt: value.lastSeenAt,
    online: value.online,
    publicId: value.publicId,
    revision: value.revision,
    signingPublicKey: value.signingPublicKey,
    status: value.status,
    userPublicId: value.userPublicId,
    wrappingPublicKey: value.wrappingPublicKey,
  };
}

function parseDeviceRecords(value: unknown): readonly DeviceRecord[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Cloud device response is invalid.");
  }
  const records = value.map(parseDeviceRecord);
  if (new Set(records.map((record) => record.publicId)).size !== records.length) {
    throw new Error("Cloud device response is invalid.");
  }
  return records;
}

function parseDevicePage(value: unknown): DevicePage {
  if (!isRecord(value)) throw new Error("Cloud device page is invalid.");
  const optional = ["pageStatus", "splitCursor"].filter((key) => Object.hasOwn(value, key));
  if (!hasExactKeys(value, [
    "continueCursor",
    "isDone",
    "page",
    "userPublicId",
    ...optional,
  ])) {
    throw new Error("Cloud device page is invalid.");
  }
  if (
    typeof value.continueCursor !== "string"
    || value.continueCursor.length > 16_384
    || typeof value.isDone !== "boolean"
    || !isOpaqueIdentifier(value.userPublicId)
    || (value.pageStatus !== undefined
      && value.pageStatus !== null
      && value.pageStatus !== "SplitRecommended"
      && value.pageStatus !== "SplitRequired")
    || (value.splitCursor !== undefined
      && value.splitCursor !== null
      && (typeof value.splitCursor !== "string" || value.splitCursor.length > 16_384))
  ) throw new Error("Cloud device page is invalid.");
  return {
    continueCursor: value.continueCursor,
    isDone: value.isDone,
    page: parseDeviceRecords(value.page),
    userPublicId: value.userPublicId,
  };
}

function parseSessionHead(value: unknown): SessionHead {
  if (!isRecord(value)) throw new Error("Cloud session response is invalid.");
  const optional = [
    "compactHasRecoveryGap",
    "compactStreamEpoch",
    "compactTailDigest",
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
  const expected = [
    ...required,
    ...optional.filter((key) => Object.hasOwn(value, key)),
  ];
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
    || !isFiniteTimestamp(value.createdAt)
    || !isSafeNonNegativeInteger(value.detailHeadSequence)
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
    || (value.detailTailDigest !== undefined && !isDigest(value.detailTailDigest))
    || (value.metadata !== undefined && metadata === null)
  ) throw new Error("Cloud session response is invalid.");
  return {
    compactHasRecoveryGap: value.compactHasRecoveryGap ?? false,
    compactHeadSequence: value.compactHeadSequence,
    compactStreamEpoch: value.compactStreamEpoch ?? 0,
    ...(typeof value.compactTailDigest === "string"
      ? { compactTailDigest: value.compactTailDigest }
      : {}),
    createdAt: value.createdAt,
    detailHeadSequence: value.detailHeadSequence,
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

function parseSessionHeads(value: unknown): readonly SessionHead[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Cloud session response is invalid.");
  }
  const heads = value.map(parseSessionHead);
  if (new Set(heads.map((head) => head.publicId)).size !== heads.length) {
    throw new Error("Cloud session response is invalid.");
  }
  return heads;
}

function parseSessionHeadPage(value: unknown): SessionHeadPage {
  if (!isRecord(value)) throw new Error("Cloud session page is invalid.");
  const optional = ["pageStatus", "splitCursor"].filter((key) => Object.hasOwn(value, key));
  if (!hasExactKeys(value, ["continueCursor", "isDone", "page", ...optional])) {
    throw new Error("Cloud session page is invalid.");
  }
  if (
    typeof value.continueCursor !== "string"
    || value.continueCursor.length > 16_384
    || typeof value.isDone !== "boolean"
    || (value.pageStatus !== undefined
      && value.pageStatus !== null
      && value.pageStatus !== "SplitRecommended"
      && value.pageStatus !== "SplitRequired")
    || (value.splitCursor !== undefined
      && value.splitCursor !== null
      && (typeof value.splitCursor !== "string" || value.splitCursor.length > 16_384))
  ) throw new Error("Cloud session page is invalid.");
  return {
    continueCursor: value.continueCursor,
    isDone: value.isDone,
    page: parseSessionHeads(value.page),
  };
}

function validateRemoteSessionSelector(value: CloudRemoteSessionSelector): CloudRemoteSessionSelector {
  if (
    !isOpaqueIdentifier(value.publicId)
    || !isOpaqueIdentifier(value.executionDevicePublicId)
  ) throw new Error("Cloud remote session selector is invalid.");
  return value;
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

function parseRemoteCommandKind(value: unknown): RemoteCommandPayload["kind"] | null {
  return isCommandKind(value) ? value : null;
}

function parseRemoteCommandReceipt(value: unknown): Readonly<{
  publicId: string;
  replay: boolean;
  sessionPublicId: string;
  state: CommandState;
  targetDevicePublicId: string;
}> {
  if (!isRecord(value) || !hasExactKeys(value, [
    "publicId",
    "replay",
    "sessionPublicId",
    "state",
    "targetDevicePublicId",
  ])) throw new Error("Cloud remote command receipt is invalid.");
  const state = parseCommandState(value.state);
  if (
    !isUuidV7(value.publicId)
    || typeof value.replay !== "boolean"
    || !isOpaqueIdentifier(value.sessionPublicId)
    || state === null
    || !isOpaqueIdentifier(value.targetDevicePublicId)
  ) throw new Error("Cloud remote command receipt is invalid.");
  return {
    publicId: value.publicId,
    replay: value.replay,
    sessionPublicId: value.sessionPublicId,
    state,
    targetDevicePublicId: value.targetDevicePublicId,
  };
}

function parseExactRemoteCommandReceipt(value: unknown): null | Readonly<{
  kind: RemoteCommandPayload["kind"];
  publicId: string;
  requestDigest: string;
  resultCode?: string;
  sessionPublicId: string;
  state: CommandState;
  targetDevicePublicId: string;
}> {
  if (value === null) return null;
  if (
    !isRecord(value)
    || parseRemoteCommandKind(value.kind) === null
    || !isUuidV7(value.publicId)
    || !isDigest(value.requestDigest)
    || !isOpaqueIdentifier(value.sessionPublicId)
    || parseCommandState(value.state) === null
    || !isOpaqueIdentifier(value.targetDevicePublicId)
    || (value.resultCode !== undefined
      && (typeof value.resultCode !== "string"
        || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.resultCode)))
  ) throw new Error("Cloud exact-command response is invalid.");
  return {
    kind: value.kind as RemoteCommandPayload["kind"],
    publicId: value.publicId,
    requestDigest: value.requestDigest,
    ...(value.resultCode === undefined ? {} : { resultCode: value.resultCode }),
    sessionPublicId: value.sessionPublicId,
    state: value.state as CommandState,
    targetDevicePublicId: value.targetDevicePublicId,
  };
}

function parseRemoteCommandAcknowledgement(
  value: unknown,
  commandPublicId: string,
): void {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["acknowledgedAt", "publicId", "replay"])
    || !isFiniteTimestamp(value.acknowledgedAt)
    || value.publicId !== commandPublicId
    || typeof value.replay !== "boolean"
  ) throw new Error("Cloud command acknowledgement is invalid.");
}

function parseSessionChunk(value: unknown): SessionChunk {
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
    || !isFiniteTimestamp(value.createdAt)
    || !isDigest(value.digest)
    || envelope === null
    || !isSafePositiveInteger(value.firstSequence)
    || !isSafePositiveInteger(value.lastSequence)
    || value.lastSequence < value.firstSequence
    || (value.previousDigest !== undefined && !isDigest(value.previousDigest))
    || !isOpaqueIdentifier(value.sourceDevicePublicId)
    || value.stream !== "compact"
    || (value.streamEpoch !== undefined && !isSafeNonNegativeInteger(value.streamEpoch))
  ) throw new Error("Cloud session chunk is invalid.");
  return {
    authority,
    createdAt: value.createdAt,
    digest: value.digest,
    envelope,
    firstSequence: value.firstSequence,
    lastSequence: value.lastSequence,
    ...(typeof value.previousDigest === "string" ? { previousDigest: value.previousDigest } : {}),
    sourceDevicePublicId: value.sourceDevicePublicId,
    stream: value.stream,
    streamEpoch: value.streamEpoch ?? 0,
  };
}

function parseSessionChunks(value: unknown): readonly SessionChunk[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Cloud session chunk response is invalid.");
  }
  return value.map(parseSessionChunk);
}

function parseCloudAccount(value: unknown): CloudAccount {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["encryptedMetadata", "publicId", "updatedAt"])
    || parseEncryptedEnvelope(value.encryptedMetadata, 16_384) === null
    || !isOpaqueIdentifier(value.publicId)
    || !isFiniteTimestamp(value.updatedAt)
  ) throw new Error("Cloud usage account response is invalid.");
  return { publicId: value.publicId, updatedAt: value.updatedAt };
}

function parseCloudAccounts(value: unknown): readonly CloudAccount[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Cloud usage account response is invalid.");
  }
  const accounts = value.map(parseCloudAccount);
  if (new Set(accounts.map((account) => account.publicId)).size !== accounts.length) {
    throw new Error("Cloud usage account response is invalid.");
  }
  return accounts;
}

function parseLatestUsageSnapshot(value: unknown): UsageSnapshot | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error("Cloud usage snapshot response is invalid.");
  }
  const snapshot: unknown = value[0] as unknown;
  if (snapshot === undefined) return null;
  if (
    !isRecord(snapshot)
    || !hasExactKeys(snapshot, [
      "digest",
      "envelope",
      "observedAt",
      "receivedAt",
      "sourceRevision",
    ])
    || !isDigest(snapshot.digest)
    || parseEncryptedEnvelope(snapshot.envelope) === null
    || !isFiniteTimestamp(snapshot.observedAt)
    || !isFiniteTimestamp(snapshot.receivedAt)
    || !isSafePositiveInteger(snapshot.sourceRevision)
  ) throw new Error("Cloud usage snapshot response is invalid.");
  return {
    envelope: parseEncryptedEnvelope(snapshot.envelope) as EncryptedEnvelope,
    observedAt: snapshot.observedAt,
  };
}

function serializeSecret(
  value: AuthSecret
    | AuthIdentityBinding
    | AuthLogoutClaim
    | AuthSignedOut
    | PendingAuthLogout
    | PendingAccountDeletion
    | DeviceSecret
    | DeviceReplacement
    | RetiredDeviceHistory
    | AccountKeySecret
    | GcmMessageBudgetCustody
    | LocalCloudState
    | DeviceMutationCustody
    | PendingDeviceMutation
    | PendingDeviceRegistration
    | PendingRemoteCommand,
): string {
  return JSON.stringify(value);
}

function validateDeviceLabel(value: string): string {
  const label = value.trim();
  if (
    label.length < 1
    || label.length > 160
    || new TextEncoder().encode(label).byteLength > 640
    || containsAbsolutePath(label)
  ) {
    throw new Error("Cloud device label is invalid.");
  }
  return label;
}

function shortDeviceId(publicId: string): string {
  if (!isOpaqueIdentifier(publicId)) throw new Error("Cloud device identity is invalid.");
  return publicId.slice(-8);
}

function automaticDeviceLabel(publicId: string): string {
  return `HRA device ${shortDeviceId(publicId)}`;
}

function fallbackDeviceLabel(
  device: Pick<DeviceRecord, "publicId" | "status">,
  current: boolean,
): string {
  const qualifier = current
    ? "This device"
    : device.status === "pending"
      ? "Pending device"
      : device.status === "revoked"
        ? "Revoked device"
        : "Device";
  return `${qualifier} ${shortDeviceId(device.publicId)}`;
}

function randomOpaqueId(prefix: "bind" | "device"): string {
  return `${prefix}_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)))}`;
}

function uuidV7Timestamp(value: string): number | null {
  if (!isUuidV7(value)) return null;
  const timestamp = Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function outboxIdempotencyExpired(idempotencyKey: string, now: number): boolean {
  const timestamp = uuidV7Timestamp(idempotencyKey);
  return timestamp === null || timestamp <= now - maximumRemoteCommandLifetimeMs;
}

function deviceLabelAad(
  userPublicId: string,
  devicePublicId: string,
  deviceLabelKeyVersion: number,
): Uint8Array {
  if (
    !isOpaqueIdentifier(userPublicId)
    || !isOpaqueIdentifier(devicePublicId)
    || !isSafePositiveInteger(deviceLabelKeyVersion)
  ) {
    throw new Error("Invalid cloud device-label authority.");
  }
  return new TextEncoder().encode([
    "hra-control-plane-device-label:v1",
    userPublicId,
    devicePublicId,
    String(deviceLabelKeyVersion),
  ].join("\n"));
}

function abortBeforeEffect(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted.");
}

export function deploymentUrlFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const selection = cloudDeploymentSelectionFromEnvironment(environment);
  return selection.kind === "disabled" ? null : selection.deploymentUrl;
}

export class LocalCloudControl implements CloudControlPort {
  readonly #deploymentAuthority: CloudDeploymentAuthority;
  readonly #deviceLabel: string | null;
  readonly #gcmMessageBudget: GcmMessageBudget;
  readonly #identityCustody: IdentityScopedCloudSecretCustody | null;
  readonly #now: () => number;
  readonly #secrets: CloudSecretCustodyPort;
  readonly #transport: CloudTransport;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: LocalCloudControlOptions) {
    const deploymentUrl = canonicalCloudDeploymentUrl(options.deploymentUrl);
    if (deploymentUrl !== options.deploymentAuthority.deploymentUrl) {
      throw new CloudDeploymentAuthorityError(
        "target_mismatch",
        "Cloud deployment authority does not match the requested deployment.",
      );
    }
    this.#deploymentAuthority = options.deploymentAuthority;
    this.#deviceLabel = options.deviceLabel === undefined
      ? null
      : validateDeviceLabel(options.deviceLabel);
    this.#identityCustody = isIdentityScopedCloudCustody(options.secretCustody)
      ? options.secretCustody
      : null;
    this.#gcmMessageBudget = options.gcmMessageBudget ?? processGcmMessageBudget;
    this.#now = options.now ?? Date.now;
    this.#secrets = deploymentFencedSecretCustody(
      options.secretCustody,
      this.#deploymentAuthority,
    );
    const transport = options.transport ?? createConvexCloudTransport({
      accessToken: async () => {
        await this.#deploymentAuthority.assertCurrent();
        const token = (await this.#readTransportAuth())?.token ?? null;
        await this.#deploymentAuthority.assertCurrent();
        return token;
      },
      deploymentUrl,
      ...(options.lifetimeSignal === undefined
        ? {}
        : { lifetimeSignal: options.lifetimeSignal }),
    });
    this.#transport = deploymentFencedCloudTransport(transport, this.#deploymentAuthority);
  }

  async auth(input: { email: string; code?: string; invite?: string; signal: AbortSignal }): Promise<unknown> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(input.signal);
      await this.#retireExpiredAuthLogout();
      if (await this.#readPendingAuthLogout() !== null) {
        throw new Error("A durable cloud sign-out intent requires retry before another auth session can start.");
      }
      const authBefore = await this.#readAuthCustodyObservation();
      if (authBefore?.value.kind === "logout_claim") {
        throw new Error("A durable cloud sign-out claim requires retry before another auth session can start.");
      }
      const parsed = parseAuthCredentials({
        ...(input.code === undefined ? {} : { code: input.code }),
        email: input.email,
        ...(input.invite === undefined ? {} : { invite: input.invite }),
      });
      if (parsed.kind === "rejected") {
        throw new Error("Cloud auth credentials are invalid.");
      }
      const result = parseAuthSignInResult(await this.#transport.action("auth:signIn", {
        params: parsed.kind === "request_code"
          ? {
            email: parsed.email,
            ...(parsed.invite === undefined ? {} : { invite: parsed.invite }),
          }
          : { code: parsed.code, email: parsed.email },
        provider: "hra-control-plane-otp-v1",
      }));
      if (result === null) throw new Error("Cloud auth response is invalid.");
      if (result.kind === "code_requested_or_rejected") {
        return { codeRequestedOrRejected: true, signedIn: false };
      }
      if (await this.#readPendingAuthLogout() !== null) {
        throw new Error("Cloud sign-out recovery started during authentication.");
      }
      const currentAuth = await this.#readAuthCustodyObservation();
      if (
        (authBefore === null) !== (currentAuth === null)
        || (authBefore !== null && currentAuth !== null && (
          authBefore.generation !== currentAuth.generation
          || authBefore.serialized !== currentAuth.serialized
        ))
      ) throw new Error("Cloud auth changed during authentication.");
      const serializedAuth = serializeSecret({
        email: parsed.email,
        obtainedAt: this.#now(),
        refreshToken: result.refreshToken,
        token: result.token,
        version: 1,
      });
      const committed = await this.#secrets.compareAndSwap(
        authSlot,
        authBefore?.generation ?? null,
        serializedAuth,
      );
      if (committed === null) throw new Error("Cloud auth changed during authentication.");
      const afterAuth = await this.#secrets.read(authSlot);
      if (
        await this.#readPendingAuthLogout() !== null
        || afterAuth?.generation !== committed.generation
        || afterAuth.value !== serializedAuth
      ) throw new Error("Cloud sign-out recovery started during authentication.");
      const account = await this.#readAccount(false);
      if (canSelectCloudIdentity(this.#secrets)) {
        const selection = await this.#secrets.activateIdentity(account.userPublicId);
        if (selection.restartRequired) {
          return {
            accountKey: null,
            automaticRegistrationPending: true,
            daemonRestartRequired: true,
            device: null,
            email: parsed.email,
            pairingRequired: false,
            signedIn: true,
          };
        }
      }
      const accountKey = await this.#accountKeyStatus(account);
      return {
        accountKey,
        automaticRegistrationPending: account.device === null,
        device: publicAccountDevice(account.device),
        email: parsed.email,
        pairingRequired: accountKey?.status === "pairing_required"
          || accountKey?.status === "unrecoverable",
        signedIn: true,
      };
    }, true);
  }

  async status(signal: AbortSignal): Promise<unknown> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(signal);
      const deletionBefore = await this.#readPendingAccountDeletion();
      if (deletionBefore !== null) {
        let deletion = deletionBefore;
        let statusFresh = deletion.value.status?.state === "complete";
        if (!statusFresh) {
          try {
            deletion = await this.#refreshAccountDeletionStatus(deletion);
            statusFresh = true;
          } catch (error: unknown) {
            if (!(error instanceof AccountDeletionStatusUnavailableError)) throw error;
            // Capability status is deliberately best-effort here. The durable
            // local fact remains useful while the unauthenticated endpoint is
            // temporarily unreachable, without exposing its authority.
          }
        }
        return {
          configured: true,
          deletion: this.#publicAccountDeletion(deletion.value, statusFresh),
          signedIn: false,
        };
      }
      const authBefore = await this.#readAuthCustodyObservation();
      if (authBefore?.value.kind !== "authenticated") {
        if (this.#identityCustody !== null) {
          await this.#identityCustody.assertCurrentIdentity(
            this.#identityCustody.activeUserPublicId,
          );
        }
        const [state, localDevice] = await Promise.all([
          this.#readState(),
          this.#readDevice(),
        ]);
        const authAfter = await this.#readAuthCustodyObservation();
        if (
          (authBefore === null) !== (authAfter === null)
          || (authBefore !== null && authAfter !== null && (
            authBefore.generation !== authAfter.generation
            || authBefore.serialized !== authAfter.serialized
          ))
        ) throw new Error("Cloud account operation authority changed.");
        if (this.#identityCustody !== null) {
          await this.#identityCustody.assertCurrentIdentity(
            this.#identityCustody.activeUserPublicId,
          );
        }
        return {
          configured: true,
          device: localDevice === null ? null : { publicId: localDevice.publicId },
          lastSync: state.lastSync,
          signedIn: false,
        };
      }
      const authority = await this.#openAccountOperationAuthority(true);
      await this.#assertLocalAccountOperationAuthority(authority);
      const state = await this.#readState();
      await this.#assertLocalAccountOperationAuthority(authority);
      const accountKey = await this.#accountKeyStatus(authority.account, authority);
      await this.#assertServerAccountOperationAuthority(authority);
      return {
        accountKey,
        automaticRegistrationPending: authority.account.device === null,
        authEpoch: authority.account.authEpoch,
        configured: true,
        device: publicAccountDevice(authority.account.device),
        email: authority.auth.value.auth.email,
        lastSync: state.lastSync,
        pairingRequired: accountKey?.status === "pairing_required"
          || accountKey?.status === "unrecoverable",
        signedIn: true,
      };
    }, true);
  }

  async deleteAccount(input: {
    acknowledgeErasure: boolean;
    signal: AbortSignal;
  }): Promise<unknown> {
    return await this.#exclusive(async () => {
      if (!input.acknowledgeErasure) {
        throw new Error("Cloud account erasure requires explicit acknowledgement.");
      }
      abortBeforeEffect(input.signal);
      let pending = await this.#readPendingAccountDeletion();
      let created = false;
      if (pending === null) {
        const account = await this.#readAccount(true);
        const prepared: PendingAccountDeletion = {
          jobId: createCloudUuidV7(this.#now()),
          requestedAt: this.#now(),
          status: null,
          statusCapability: encodeBase64Url(randomKeyBytes()),
          userPublicId: account.userPublicId,
          version: 1,
        };
        const serialized = serializeSecret(prepared);
        const committed = await this.#secrets.compareAndSwap(
          accountDeletionSlot,
          null,
          serialized,
        );
        if (committed === null) {
          pending = await this.#readPendingAccountDeletion();
          if (pending === null) {
            throw new Error("Cloud account-erasure recovery custody changed concurrently.");
          }
          if (pending.value.userPublicId !== account.userPublicId) {
            throw new Error("Cloud account-erasure recovery belongs to another identity.");
          }
        } else {
          pending = {
            generation: committed.generation,
            serialized,
            value: prepared,
          };
          created = true;
        }
      }

      if (pending.value.status?.state === "complete") {
        return { deletion: this.#publicAccountDeletion(pending.value, true) };
      }
      if (pending.value.status !== null) {
        try {
          pending = await this.#refreshAccountDeletionStatus(pending);
          return { deletion: this.#publicAccountDeletion(pending.value, true) };
        } catch (error: unknown) {
          if (!(error instanceof AccountDeletionStatusUnavailableError)) throw error;
          return { deletion: this.#publicAccountDeletion(pending.value, false) };
        }
      }
      if (!created) {
        try {
          pending = await this.#refreshAccountDeletionStatus(pending);
          return { deletion: this.#publicAccountDeletion(pending.value, true) };
        } catch (error: unknown) {
          if (!(error instanceof AccountDeletionStatusUnavailableError)) throw error;
          // No status may mean the prepared write-ahead fact never reached the
          // server. Replaying its exact job and capability is safe.
        }
      }

      let response: unknown;
      try {
        response = await this.#transport.mutation("accountDeletion:request", {
          jobId: pending.value.jobId,
          statusCapability: pending.value.statusCapability,
        });
      } catch (requestError: unknown) {
        try {
          pending = await this.#refreshAccountDeletionStatus(pending);
          return { deletion: this.#publicAccountDeletion(pending.value, true) };
        } catch (statusError: unknown) {
          if (statusError instanceof AccountDeletionStatusUnavailableError) throw requestError;
          throw statusError;
        }
      }
      const status = parseAccountDeletionRequestResponse(response, pending.value);
      pending = await this.#commitAccountDeletionStatus(pending, status);
      return { deletion: this.#publicAccountDeletion(pending.value, true) };
    }, true);
  }

  async logout(signal: AbortSignal): Promise<void> {
    await this.#exclusive(async () => {
      abortBeforeEffect(signal);
      await this.#retireExpiredAuthLogout();
      let pending = await this.#readPendingAuthLogout();
      const originalAuth = await this.#readAuthCustodyObservation();
      if (originalAuth === null) {
        if (pending?.value.phase === "confirmed") {
          await this.#replaceAuthWithSignedOut(null, pending.value.requestedAt, {
            digest: pending.value.authDigest,
            generation: pending.value.authGeneration,
          });
          await this.#clearExactSecret(authLogoutSlot, pending);
          return;
        }
        if (pending === null) {
          await this.#replaceAuthWithSignedOut(null, this.#now());
          return;
        }
        throw new Error("Cloud sign-out recovery lost its exact auth session custody.");
      }
      if (originalAuth.value.kind === "signed_out") {
        if (pending !== null) {
          if (
            pending.value.phase !== "confirmed"
            || !this.#signedOutMatchesPending(originalAuth.value.signedOut, pending.value)
          ) throw new Error("Cloud sign-out intent belongs to a different auth session.");
          await this.#clearExactSecret(authLogoutSlot, pending);
          return;
        }
        await this.#replaceAuthWithSignedOut(originalAuth, this.#now());
        return;
      }

      if (originalAuth.value.kind === "authenticated" && pending !== null) {
        const originalDigest = createHash("sha256").update(originalAuth.serialized).digest("hex");
        if (
          pending.value.authGeneration !== originalAuth.generation
          || pending.value.authDigest !== originalDigest
        ) throw new Error("Cloud sign-out intent belongs to a different auth session.");
      }
      const requestedAt = pending?.value.requestedAt
        ?? (originalAuth.value.kind === "logout_claim"
          ? originalAuth.value.claim.requestedAt
          : this.#now());
      let claim: SecretObservation<Extract<AuthCustody, Readonly<{ kind: "logout_claim" }>>>;
      if (originalAuth.value.kind === "logout_claim") {
        claim = {
          generation: originalAuth.generation,
          serialized: originalAuth.serialized,
          value: originalAuth.value,
        };
      } else {
        const committed = await this.#replaceExactSecret(
          authSlot,
          originalAuth,
          serializeSecret({
            auth: originalAuth.value.auth,
            phase: "logout_claim",
            requestedAt,
            version: 2,
          } satisfies AuthLogoutClaim),
        );
        claim = await this.#readExactAuthLogoutClaim(committed);
      }
      const claimDigest = createHash("sha256").update(claim.serialized).digest("hex");
      if (
        pending === null
        || pending.value.authGeneration !== claim.generation
        || pending.value.authDigest !== claimDigest
      ) {
        const next: PendingAuthLogout = {
          authDigest: claimDigest,
          authGeneration: claim.generation,
          phase: pending?.value.phase ?? "prepared",
          requestedAt,
          version: 2,
        };
        const serialized = serializeSecret(next);
        if (pending === null) {
          const committed = await this.#secrets.compareAndSwap(authLogoutSlot, null, serialized);
          if (committed === null) throw new Error("Cloud sign-out intent changed concurrently.");
          pending = { generation: committed.generation, serialized, value: next };
        } else {
          const committed = await this.#replaceExactSecret(authLogoutSlot, pending, serialized);
          pending = { ...committed, value: next };
        }
      }
      if (
        pending.value.authGeneration !== claim.generation
        || pending.value.authDigest !== claimDigest
      ) throw new Error("Cloud sign-out intent belongs to a different auth session.");

      if (pending.value.phase === "prepared" && claim.value.claim.auth !== null) {
        await this.#transport.action("auth:signOut", {});
      }
      if (pending.value.phase === "prepared") {
        const confirmed: PendingAuthLogout = {
          authDigest: claimDigest,
          authGeneration: claim.generation,
          phase: "confirmed",
          requestedAt,
          version: 2,
        };
        const committed = await this.#replaceExactSecret(
          authLogoutSlot,
          pending,
          serializeSecret(confirmed),
        );
        pending = { ...committed, value: confirmed };
      }
      await this.#replaceAuthWithSignedOut(claim, requestedAt);
      await this.#clearExactSecret(authLogoutSlot, pending);
    });
  }

  async ensureDeviceRegistered(signal: AbortSignal): Promise<unknown> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(signal);
      let account = await this.#readAccount(true);
      let deviceSecret = await this.#readDevice();
      if (deviceSecret !== null && deviceSecret.userPublicId !== account.userPublicId) {
        throw new Error("This local state belongs to a different HRA identity. Re-authenticate that identity to preserve and recover its exact cloud custody.");
      }
      const pendingRegistration = await this.#readPendingRegistration();
      const replacement = await this.#readDeviceReplacement();

      if (account.device !== null) {
        if (
          deviceSecret === null
          || deviceSecret.userPublicId !== account.userPublicId
          || deviceSecret.publicId !== account.device.publicId
        ) throw new Error("The registered cloud device key is unavailable; recovery is required.");
        if (account.device.status === "revoked") {
          return {
            device: publicAccountDevice(account.device),
            registered: false,
            recoveryRequired: true,
          };
        }
        if (replacement !== null) {
          throw new Error("Cloud device-replacement evidence conflicts with registered authority.");
        }
        if (!deviceSecret.registered) {
          deviceSecret = { ...deviceSecret, registered: true };
          await this.#writeSecret(deviceSlot, serializeSecret(deviceSecret));
        }
        if (pendingRegistration !== null) {
          await this.#validatePendingRegistration(
            pendingRegistration.value,
            account,
            deviceSecret,
          );
          // A first-device bootstrap owns the account key it wrapped during
          // registration. Recovering that exact lost response may therefore
          // promote the same key automatically. A later approved device still
          // requires `hra device pair` to retrieve its envelope.
          if (
            account.device.status === "active"
            && pendingRegistration.value.bootstrapKeyEnvelope !== undefined
          ) {
            await this.#hydrateAccountKey(account, deviceSecret);
          }
          await this.#clearExactSecret(registrationSlot, pendingRegistration);
        }
        return {
          device: publicAccountDevice(account.device),
          registered: true,
        };
      }

      if (replacement !== null) {
        return {
          device: null,
          registered: false,
          recoveryRequired: true,
        };
      }
      if (pendingRegistration !== null) {
        if (deviceSecret === null) {
          throw new Error("Pending cloud device registration has no local device key.");
        }
        await this.#validatePendingRegistration(pendingRegistration.value, account, deviceSecret);
        return await this.#sendPendingRegistration(
          pendingRegistration,
          account,
          deviceSecret,
          true,
        );
      }
      if (deviceSecret !== null && deviceSecret.registered) {
        account = await this.#bindRegisteredDevice(account, deviceSecret);
        return {
          device: publicAccountDevice(account.device),
          rebound: true,
          registered: true,
        };
      }
      if (deviceSecret !== null) {
        throw new Error("Cloud device registration evidence is incomplete; recovery is required.");
      }
      deviceSecret = await this.#createDeviceSecret(account.userPublicId);
      return await this.#prepareAndSendDeviceRegistration(
        account,
        deviceSecret,
        null,
      );
    });
  }

  async pairDevice(signal: AbortSignal): Promise<unknown> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(signal);
      let account = await this.#readAccount(true);
      let deviceSecret = await this.#readDevice();
      if (deviceSecret !== null && deviceSecret.userPublicId !== account.userPublicId) {
        throw new Error("This local state belongs to a different HRA identity. Re-authenticate that identity to preserve and recover its exact cloud custody.");
      }
      const pendingRegistration = await this.#readPendingRegistration();
      let replacement = await this.#readDeviceReplacement();
      if (account.device !== null) {
        if (
          deviceSecret === null
          || deviceSecret.userPublicId !== account.userPublicId
          || deviceSecret.publicId !== account.device.publicId
        ) throw new Error("The paired cloud device key is unavailable; recovery is required.");
        if (account.device.status === "revoked") {
          if (pendingRegistration !== null) {
            throw new Error("Revoked cloud device registration evidence requires recovery.");
          }
          await this.#prepareDeviceReplacement(
            replacement,
            account,
            deviceSecret,
          );
          return {
            device: publicAccountDevice(account.device),
            paired: false,
            reauthenticationRequired: true,
            replacementPrepared: true,
          };
        }
        if (replacement !== null) {
          throw new Error("Cloud device-replacement evidence conflicts with active authority.");
        }
        if (!deviceSecret.registered) {
          deviceSecret = { ...deviceSecret, registered: true };
          await this.#writeSecret(deviceSlot, serializeSecret(deviceSecret));
        }
        if (pendingRegistration !== null) {
          await this.#validatePendingRegistration(
            pendingRegistration.value,
            account,
            deviceSecret,
          );
          await this.#clearExactSecret(registrationSlot, pendingRegistration);
        }
        if (account.device.status === "active") {
          await this.#hydrateAccountKey(account, deviceSecret);
        }
        return {
          device: publicAccountDevice(account.device),
          paired: account.device.status === "active",
        };
      }

      if (replacement !== null) {
        const resumed = await this.#resumeDeviceReplacement(
          replacement,
          account,
          deviceSecret,
        );
        deviceSecret = resumed.device;
        replacement = resumed.replacement;
      }

      if (pendingRegistration !== null) {
        if (deviceSecret === null) {
          throw new Error("Pending cloud device registration has no local device key.");
        }
        await this.#validatePendingRegistration(pendingRegistration.value, account, deviceSecret);
        if (replacement !== null) {
          await this.#clearExactSecret(replacementSlot, replacement);
          replacement = null;
        }
        return await this.#sendPendingRegistration(
          pendingRegistration,
          account,
          deviceSecret,
          true,
        );
      }

      if (
        deviceSecret !== null
        && deviceSecret.userPublicId === account.userPublicId
        && deviceSecret.registered
      ) {
        account = await this.#bindRegisteredDevice(account, deviceSecret);
        if (account.device?.status !== "active") {
          throw new Error("Cloud device bind did not establish active authority.");
        }
        await this.#hydrateAccountKey(account, deviceSecret);
        return {
          device: publicAccountDevice(account.device),
          paired: true,
          rebound: true,
        };
      }

      if (deviceSecret !== null && !deviceSecret.registered && replacement === null) {
        throw new Error("Cloud device registration evidence is incomplete; recovery is required.");
      }

      deviceSecret ??= await this.#createDeviceSecret(account.userPublicId);
      return await this.#prepareAndSendDeviceRegistration(
        account,
        deviceSecret,
        replacement,
      );
    });
  }

  async acknowledgeNoAccountKeyHolders(signal: AbortSignal): Promise<unknown> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(signal);
      const [auth, authIdentity, device, state] = await Promise.all([
        this.#readAuthCustodyObservation(),
        this.#readAuthIdentityBinding(),
        this.#readDevice(),
        this.#readState(),
      ]);
      if (auth?.value.kind !== "authenticated") {
        throw new AccountKeyLossPreconditionError("signed_out");
      }
      if (device === null || !device.registered) {
        throw new AccountKeyLossPreconditionError("device_unregistered");
      }
      const authDigest = createHash("sha256").update(auth.serialized).digest("hex");
      if (
        authIdentity === null
        || authIdentity.authDigest !== authDigest
        || authIdentity.authGeneration !== auth.generation
        || authIdentity.userPublicId !== device.userPublicId
      ) {
        throw new AccountKeyLossPreconditionError("auth_identity_unbound");
      }
      const recovery = state.accountKeyRecovery;
      if (recovery === null) {
        throw new AccountKeyLossPreconditionError("observation_missing");
      }
      if (
        recovery.status === "superseded"
        || recovery.authEpoch !== authIdentity.authEpoch
        || recovery.userPublicId !== authIdentity.userPublicId
        || recovery.userPublicId !== device.userPublicId
        || recovery.devicePublicId !== device.publicId
      ) {
        throw new AccountKeyLossPreconditionError("authority_changed");
      }
      const key = await this.#readAccountKey();
      if (this.#usableAccountKey(key, recovery)) {
        await this.#supersedeAccountKeyRecovery(key);
        throw new AccountKeyLossPreconditionError("already_ready");
      }
      if (recovery.status === "unrecoverable") {
        return {
          acknowledgedNoKeyHolders: true,
          accountKey: {
            evidence: recovery.evidence,
            status: recovery.status,
          } satisfies AccountKeyStatus,
          localOnly: true,
          replay: true,
        };
      }
      const next = await this.#updateState((current) => {
        const observed = current.accountKeyRecovery;
        if (
          observed === null
          || observed.status === "superseded"
          || observed.userPublicId !== recovery.userPublicId
          || observed.devicePublicId !== recovery.devicePublicId
          || observed.keyVersion !== recovery.keyVersion
          || observed.authEpoch !== recovery.authEpoch
        ) {
          throw new AccountKeyLossPreconditionError("authority_changed");
        }
        if (observed.status === "unrecoverable") return current;
        return {
          ...current,
          accountKeyRecovery: {
            ...observed,
            acknowledgedAt: this.#now(),
            evidence: "operator_confirmed_no_key_holders",
            status: "unrecoverable",
          },
        };
      });
      const afterKey = await this.#readAccountKey();
      if (this.#usableAccountKey(afterKey, recovery)) {
        await this.#supersedeAccountKeyRecovery(afterKey);
        return {
          acknowledgedNoKeyHolders: false,
          accountKey: {
            keyVersion: afterKey.keyVersion,
            status: "ready",
          } satisfies AccountKeyStatus,
          localOnly: true,
          replay: false,
          superseded: true,
        };
      }
      const committed = next.accountKeyRecovery;
      if (committed?.status !== "unrecoverable") {
        throw new AccountKeyLossPreconditionError("authority_changed");
      }
      const [afterAuth, afterAuthIdentity] = await Promise.all([
        this.#readAuthCustodyObservation(),
        this.#readAuthIdentityBinding(),
      ]);
      if (
        afterAuth?.value.kind !== "authenticated"
        || afterAuth.generation !== auth.generation
        || afterAuth.serialized !== auth.serialized
        || afterAuthIdentity === null
        || afterAuthIdentity.authDigest !== authIdentity.authDigest
        || afterAuthIdentity.authEpoch !== authIdentity.authEpoch
        || afterAuthIdentity.authGeneration !== authIdentity.authGeneration
        || afterAuthIdentity.userPublicId !== authIdentity.userPublicId
      ) throw new AccountKeyLossPreconditionError("authority_changed");
      return {
        acknowledgedNoKeyHolders: true,
        accountKey: {
          evidence: committed.evidence,
          status: committed.status,
        } satisfies AccountKeyStatus,
        localOnly: true,
        replay: false,
      };
    });
  }

  async #prepareAndSendDeviceRegistration(
    account: AccountContext,
    deviceSecret: DeviceSecret,
    replacement: SecretObservation<DeviceReplacement> | null,
  ): Promise<unknown> {
      const provisionalKey = randomKeyBytes();
      await this.#writeAccountKey({
        key: encodeBase64Url(provisionalKey),
        keyVersion,
        provisional: account.hasActiveDevices,
        userPublicId: account.userPublicId,
        version: 1,
      });
      const encryptedLabel = await encryptBytes(
        new TextEncoder().encode(
          this.#deviceLabel ?? automaticDeviceLabel(deviceSecret.publicId),
        ),
        provisionalKey,
        keyVersion,
        deviceLabelAad(account.userPublicId, deviceSecret.publicId, keyVersion),
      );
      const bootstrapKeyEnvelope = account.hasActiveDevices
        ? undefined
        : await wrapAccountDataKey(provisionalKey, deviceSecret.wrappingPublicKey, {
          accountKeyVersion: keyVersion,
          devicePublicId: deviceSecret.publicId,
          userPublicId: account.userPublicId,
        });
      const registrationIntent = {
        ...(bootstrapKeyEnvelope === undefined ? {} : { bootstrapKeyEnvelope }),
        encryptedLabel,
        idempotencyKey: createCloudUuidV7(this.#now()),
        keyVersion,
        publicId: deviceSecret.publicId,
        signingPublicKey: deviceSecret.signingPublicKey,
        wrappingPublicKey: deviceSecret.wrappingPublicKey,
      };
      const prepared: PendingDeviceRegistration = {
        ...registrationIntent,
        requestDigest: await hmacSha256Hex(
          provisionalKey,
          "device-register",
          JSON.stringify(registrationIntent),
        ),
        userPublicId: account.userPublicId,
        version: 1,
      };
      // The outbox is durable before the mutation. A lost response, process
      // restart, or auth-session rotation therefore reuses the exact device
      // keys, account key, ciphertext, public ID, UUIDv7, and request digest.
      const registration = await this.#writeSecret(
        registrationSlot,
        serializeSecret(prepared),
      );
      if (replacement !== null) {
        await this.#clearExactSecret(replacementSlot, replacement);
      }
      return await this.#sendPendingRegistration(
        { ...registration, value: prepared },
        account,
        deviceSecret,
        false,
      );
  }

  async listDevices(signal: AbortSignal): Promise<unknown> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(signal);
      const { account, authority } = await this.#requireActiveDeviceOperationAuthority();
      const devices = await this.#listDeviceRecords(account.userPublicId, authority);
      await this.#assertLocalAccountOperationAuthority(authority);
      const accountKey = await this.#requireAccountKey(account.userPublicId);
      await this.#assertServerAccountOperationAuthority(authority);
      const currentRecord = devices.find((device) =>
        device.publicId === account.device.publicId);
      if (
        currentRecord === undefined
        || currentRecord.keyVersion !== account.device.keyVersion
        || currentRecord.revision !== account.device.revision
        || currentRecord.status !== "active"
        || accountKey.keyVersion !== account.device.keyVersion
      ) throw new Error("Cloud device listing changed authority.");
      await this.#assertServerAccountOperationAuthority(authority);
      const publicDevices: CloudDeviceListEntry[] = [];
      for (const device of devices) {
        const current = device.publicId === account.device.publicId;
        const decryptedLabel = await this.#decryptDeviceLabel(
          account.userPublicId,
          device,
          accountKey,
        );
        publicDevices.push({
          ...(device.activatedAt === undefined ? {} : { activatedAt: device.activatedAt }),
          current,
          deviceClass: device.deviceClass,
          fingerprint: await deviceKeyFingerprint(
            device.signingPublicKey,
            device.wrappingPublicKey,
          ),
          keyVersion: device.keyVersion,
          label: decryptedLabel ?? fallbackDeviceLabel(device, current),
          labelSource: decryptedLabel === null ? "fallback" : "encrypted",
          lastSeenAt: device.lastSeenAt,
          online: device.status === "revoked" ? false : device.online,
          publicId: device.publicId,
          revision: device.revision,
          status: device.status,
        });
      }
      await this.#assertServerAccountOperationAuthority(authority);
      const result = {
        currentDevicePublicId: account.device.publicId,
        devices: publicDevices,
      } satisfies CloudDeviceList;
      const parsed = parseCloudDeviceList(result);
      if (parsed === null) throw new Error("Cloud device listing changed authority.");
      await this.#assertLocalAccountOperationAuthority(authority);
      return parsed;
    });
  }

  async #decryptDeviceLabel(
    userPublicId: string,
    device: DeviceRecord,
    accountKey: Readonly<{ bytes: Uint8Array; keyVersion: number }>,
  ): Promise<string | null> {
    if (
      device.keyVersion !== accountKey.keyVersion
      || device.encryptedLabel.keyVersion !== accountKey.keyVersion
    ) return null;
    try {
      const plaintext = await decryptBytes(
        device.encryptedLabel,
        accountKey.bytes,
        deviceLabelAad(
          userPublicId,
          device.publicId,
          device.encryptedLabel.keyVersion,
        ),
      );
      if (plaintext.byteLength > 640) return null;
      return validateDeviceLabel(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    } catch {
      return null;
    }
  }

  // Approval always binds to the fingerprint the operator was shown, so an
  // enrolling browser tab cannot substitute another key pair behind the
  // opaque public ID.
  async approveDevice(
    selector: string,
    idempotencyKey: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!isUuidV7(idempotencyKey)) {
      throw new Error("Cloud device mutation idempotency key is invalid.");
    }
    if (!isDeviceKeyFingerprint(fingerprint)) {
      throw new Error("Cloud device fingerprint is invalid.");
    }
    return await this.#mutateDevice("approve", selector, idempotencyKey, signal, fingerprint);
  }

  async revokeDevice(
    selector: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!isUuidV7(idempotencyKey)) {
      throw new Error("Cloud device mutation idempotency key is invalid.");
    }
    return await this.#mutateDevice("revoke", selector, idempotencyKey, signal, null);
  }

  async #mutateDevice(
    kind: PendingDeviceMutation["kind"],
    selector: string,
    idempotencyKey: string,
    signal: AbortSignal,
    expectedFingerprint: string | null,
  ): Promise<unknown> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(signal);
      const account = await this.#requireActiveDevice();
      const target = await this.#resolveDevice(selector, account.userPublicId);
      if (target.publicId === account.device.publicId) {
        throw new Error(kind === "approve"
          ? "The current cloud device is already active."
          : "The current cloud device cannot revoke itself.");
      }
      if (expectedFingerprint !== null) {
        const observed = await deviceKeyFingerprint(
          target.signingPublicKey,
          target.wrappingPublicKey,
        );
        if (observed !== expectedFingerprint) throw new Error("DEVICE_FINGERPRINT_MISMATCH");
      }

      const custody = await this.#readDeviceMutationCustody(account.userPublicId);
      const receipt = custody?.value.receipts.find((candidate) =>
        candidate.idempotencyKey === idempotencyKey);
      if (receipt !== undefined) {
        if (receipt.kind !== kind || receipt.targetPublicId !== target.publicId) {
          throw new Error("Cloud device mutation idempotency key was reused for a different request.");
        }
        return { device: receipt.result, replay: true };
      }

      if (custody?.value.pending !== null && custody?.value.pending !== undefined) {
        const pending = custody.value.pending;
        if (pending.idempotencyKey !== idempotencyKey) {
          throw new Error("A different cloud device mutation requires reconciliation.");
        }
        if (pending.kind !== kind || pending.targetPublicId !== target.publicId) {
          throw new Error("Cloud device mutation idempotency key was reused for a different request.");
        }
        const recovered = kind === "approve"
          ? target.status === "active" && target.revision === pending.expectedRevision + 1
          : target.status === "revoked" && target.revision === pending.expectedRevision + 1;
        if (recovered) {
          const result: DeviceMutationResult = {
            publicId: target.publicId,
            revision: target.revision,
            status: kind === "approve" ? "active" : "revoked",
          };
          await this.#settlePendingDeviceMutation(account.userPublicId, custody, result);
          return { device: result, replay: true };
        }
        if (kind === "approve" && target.status === "revoked") {
          await this.#abandonPendingDeviceMutation(account.userPublicId, custody);
          throw new Error("Pending cloud device approval was abandoned because the device is revoked.");
        }
        if (
          (kind === "approve" && target.status !== "pending")
          || (kind === "revoke" && target.status === "revoked")
          || target.revision !== pending.expectedRevision
        ) {
          throw new Error(kind === "approve"
            ? "The pending cloud device approval requires recovery."
            : "The pending cloud device revocation requires recovery.");
        }
        if (outboxIdempotencyExpired(idempotencyKey, this.#now())) {
          await this.#abandonPendingDeviceMutation(account.userPublicId, custody);
          throw new Error("Cloud device mutation idempotency key is expired; retry with a new key.");
        }
        const device = await this.#sendPendingDeviceMutation(pending);
        await this.#settlePendingDeviceMutation(account.userPublicId, custody, device);
        return { device, replay: true };
      }

      if (outboxIdempotencyExpired(idempotencyKey, this.#now())) {
        throw new Error("Cloud device mutation idempotency key is expired; retry with a new key.");
      }
      if (kind === "approve" && target.status !== "pending") {
        throw new Error("The selected cloud device is not pending.");
      }
      if (kind === "revoke" && target.status === "revoked") {
        throw new Error("The selected cloud device is already revoked.");
      }
      const key = await this.#requireAccountKey(account.userPublicId);
      const keyEnvelope = kind === "approve"
        ? await wrapAccountDataKey(key.bytes, target.wrappingPublicKey, {
            accountKeyVersion: key.keyVersion,
            devicePublicId: target.publicId,
            userPublicId: account.userPublicId,
          })
        : null;
      const request = {
        expectedRevision: target.revision,
        idempotencyKey,
        ...(keyEnvelope === null ? {} : { keyEnvelope }),
        targetPublicId: target.publicId,
      };
      const prepared: PendingDeviceMutation = kind === "approve"
        ? {
            ...request,
            keyEnvelope: keyEnvelope as WrappedKeyEnvelope,
            kind,
            requestDigest: await hmacSha256Hex(
              key.bytes,
              "device-approve",
              JSON.stringify(request),
            ),
            version: 1,
          }
        : {
            expectedRevision: request.expectedRevision,
            idempotencyKey: request.idempotencyKey,
            kind,
            requestDigest: await hmacSha256Hex(
              key.bytes,
              "device-revoke",
              JSON.stringify(request),
            ),
            targetPublicId: request.targetPublicId,
            version: 1,
      };
      const claimed = await this.#claimPendingMutation(account.userPublicId, prepared);
      if (!claimed.created) {
        const concurrentReceipt = claimed.custody.value.receipts.find((receipt) =>
          receipt.idempotencyKey === idempotencyKey);
        if (concurrentReceipt !== undefined) {
          if (
            concurrentReceipt.kind !== kind
            || concurrentReceipt.targetPublicId !== target.publicId
          ) {
            throw new Error("Cloud device mutation idempotency key was reused for a different request.");
          }
          return { device: concurrentReceipt.result, replay: true };
        }
        const concurrent = claimed.custody.value.pending;
        if (
          concurrent?.idempotencyKey === idempotencyKey
          && (concurrent.kind !== kind || concurrent.targetPublicId !== target.publicId)
        ) {
          throw new Error("Cloud device mutation idempotency key was reused for a different request.");
        }
        throw new Error("A concurrent cloud device mutation requires reconciliation.");
      }
      const device = await this.#sendPendingDeviceMutation(prepared);
      await this.#settlePendingDeviceMutation(account.userPublicId, claimed.custody, device);
      return { device };
    });
  }

  async #sendPendingDeviceMutation(
    pending: PendingDeviceMutation,
  ): Promise<DeviceMutationResult> {
    const device = parseDeviceSummary(await this.#transport.mutation(
      pending.kind === "approve" ? "devices:approve" : "devices:revoke",
      {
        expectedRevision: pending.expectedRevision,
        idempotencyKey: pending.idempotencyKey,
        ...(pending.kind === "approve" ? { keyEnvelope: pending.keyEnvelope } : {}),
        requestDigest: pending.requestDigest,
        targetPublicId: pending.targetPublicId,
      },
    ));
    const expectedStatus = pending.kind === "approve" ? "active" : "revoked";
    if (
      device.publicId !== pending.targetPublicId
      || device.revision !== pending.expectedRevision + 1
      || device.status !== expectedStatus
    ) throw new Error(pending.kind === "approve"
      ? "Cloud device approval response is inconsistent."
      : "Cloud device revocation response is inconsistent.");
    return {
      publicId: device.publicId,
      revision: device.revision,
      status: expectedStatus,
    };
  }

  async listRemoteSessionHeads(input: Readonly<{
    limit: number;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    sessions: readonly CloudRemoteSessionHead[];
    truncated: boolean;
  }>> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(input.signal);
      if (!isSafePositiveInteger(input.limit) || input.limit > 100) {
        throw new Error("Cloud remote session limit is invalid.");
      }
      const account = await this.#requireActiveDevice();
      const key = await this.#requireAccountKey(account.userPublicId);
      const heads = parseSessionHeads(await this.#transport.query("sessions:listHeads", {
        limit: input.limit,
      }));
      const sessions: CloudRemoteSessionHead[] = [];
      for (const head of heads) {
        const metadata = head.metadata === undefined
          ? null
          : await decryptSessionMetadata(head.metadata, key.bytes, {
              entityPublicId: head.publicId,
              keyVersion: head.metadata.keyVersion,
              kind: "session_metadata",
              userPublicId: account.userPublicId,
            });
        sessions.push({
          compactHasRecoveryGap: head.compactHasRecoveryGap,
          compactHeadSequence: head.compactHeadSequence,
          compactStreamEpoch: head.compactStreamEpoch,
          createdAt: head.createdAt,
          executionDevicePublicId: head.executionDevicePublicId,
          metadata,
          publicId: head.publicId,
          state: head.state,
          updatedAt: head.updatedAt,
        });
      }
      return { sessions, truncated: heads.length === input.limit };
    });
  }

  async resolveRemoteSession(input: Readonly<{
    selector: string;
    signal: AbortSignal;
  }>): Promise<CloudRemoteSessionSelector> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(input.signal);
      const selector = input.selector.trim();
      if (selector.length < 1 || selector.length > 320 || /[\r\n\t]/u.test(selector)) {
        throw new Error("Cloud remote session selector is invalid.");
      }
      const account = await this.#requireActiveDevice();
      if (isOpaqueIdentifier(selector)) {
        const exactValue = await this.#transport.query("sessions:getHead", {
          publicId: selector,
        });
        if (exactValue !== null) {
          const exact = parseSessionHead(exactValue);
          return {
            executionDevicePublicId: exact.executionDevicePublicId,
            publicId: exact.publicId,
          };
        }
      }

      const key = await this.#requireAccountKey(account.userPublicId);
      const heads: CloudRemoteSessionHead[] = [];
      const publicIds = new Set<string>();
      let cursor: string | null = null;
      let isDone = false;
      for (let pageNumber = 0; pageNumber < 50 && !isDone; pageNumber += 1) {
        const page = parseSessionHeadPage(await this.#transport.query(
          "sessions:listHeadsPage",
          { paginationOpts: { cursor, numItems: 100 } },
        ));
        for (const head of page.page) {
          if (publicIds.has(head.publicId)) {
            throw new Error("Cloud session pagination repeated an identity.");
          }
          publicIds.add(head.publicId);
          const metadata = head.metadata === undefined
            ? null
            : await decryptSessionMetadata(head.metadata, key.bytes, {
                entityPublicId: head.publicId,
                keyVersion: head.metadata.keyVersion,
                kind: "session_metadata",
                userPublicId: account.userPublicId,
              });
          heads.push({
            compactHasRecoveryGap: head.compactHasRecoveryGap,
            compactHeadSequence: head.compactHeadSequence,
            compactStreamEpoch: head.compactStreamEpoch,
            createdAt: head.createdAt,
            executionDevicePublicId: head.executionDevicePublicId,
            metadata,
            publicId: head.publicId,
            state: head.state,
            updatedAt: head.updatedAt,
          });
        }
        cursor = page.continueCursor;
        isDone = page.isDone;
      }
      if (!isDone) {
        throw new Error("Cloud session selector search exceeded 5000 sessions; use the exact public ID.");
      }
      const prefixes = heads.filter((head) => head.publicId.startsWith(selector));
      const matches = prefixes.length > 0
        ? prefixes
        : heads.filter((head) =>
            head.metadata?.name?.toLocaleLowerCase("en-US")
            === selector.toLocaleLowerCase("en-US"));
      if (matches.length === 0) throw new Error("Cloud remote session was not found.");
      if (matches.length > 1) throw new Error("Cloud remote session selector is ambiguous.");
      const match = matches[0];
      if (match === undefined) throw new Error("Cloud remote session was not found.");
      return {
        executionDevicePublicId: match.executionDevicePublicId,
        publicId: match.publicId,
      };
    });
  }

  async pullRemoteSession(input: Readonly<{
    selector: CloudRemoteSessionSelector;
    signal: AbortSignal;
  }>): Promise<CloudRemoteSessionProjection> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(input.signal);
      const selector = validateRemoteSessionSelector(input.selector);
      const account = await this.#requireActiveDevice();
      const key = await this.#requireAccountKey(account.userPublicId);
      const value = await this.#transport.query("sessions:getHead", {
        publicId: selector.publicId,
      });
      if (value === null) throw new Error("Cloud remote session was not found.");
      const head = parseSessionHead(value);
      if (head.executionDevicePublicId !== selector.executionDevicePublicId) {
        throw new Error("Cloud remote session execution authority changed.");
      }
      const metadata = head.metadata === undefined
        ? null
        : await decryptSessionMetadata(head.metadata, key.bytes, {
            entityPublicId: head.publicId,
            keyVersion: head.metadata.keyVersion,
            kind: "session_metadata",
            userPublicId: account.userPublicId,
          });
      const compact = await this.#readCompactSession(head, account.userPublicId, key.bytes);
      return {
        compactHasRecoveryGap: head.compactHasRecoveryGap,
        compactHeadSequence: head.compactHeadSequence,
        compactStreamEpoch: head.compactStreamEpoch,
        complete: compact.complete,
        createdAt: head.createdAt,
        events: compact.events,
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
      };
    });
  }

  async getRemoteCommandStatus(input: Readonly<{
    commandPublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudRemoteCommandStatus> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(input.signal);
      if (!isUuidV7(input.commandPublicId)) {
        throw new Error("Cloud remote command identity is invalid.");
      }
      await this.#requireActiveDevice();
      const exact = parseExactRemoteCommandReceipt(await this.#transport.query(
        "commands:get",
        { commandPublicId: input.commandPublicId },
      ));
      if (exact === null) throw new Error("Cloud remote command was not found.");
      return {
        commandPublicId: exact.publicId,
        kind: exact.kind,
        ...(exact.resultCode === undefined ? {} : { resultCode: exact.resultCode }),
        sessionPublicId: exact.sessionPublicId,
        state: exact.state,
        targetDevicePublicId: exact.targetDevicePublicId,
      };
    });
  }

  async enqueueRemoteCommand(input: Readonly<{
    commandPublicId: string;
    deadline: number;
    idempotencyKey: string;
    payload: RemoteCommandPayload;
    selector: CloudRemoteSessionSelector;
    signal: AbortSignal;
  }>): Promise<CloudRemoteCommandReceipt> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(input.signal);
      const selector = validateRemoteSessionSelector(input.selector);
      const payload = parseRemoteCommandPayload(input.payload);
      const now = this.#now();
      if (
        payload === null
        || !isUuidV7(input.commandPublicId)
        || !isUuidV7(input.idempotencyKey)
        || !Number.isFinite(input.deadline)
        || input.deadline > now + maximumRemoteCommandLifetimeMs
      ) throw new Error("Cloud remote command request is invalid.");
      const account = await this.#requireActiveDevice();
      const key = await this.#requireAccountKey(account.userPublicId);
      const payloadDigest = await hmacSha256Hex(
        key.bytes,
        "remote-command-payload",
        JSON.stringify(payload),
      );
      const pending = await this.#readPendingRemoteCommand();
      if (pending !== null) {
        const sameIntent = sameRemoteCommandIntent(pending.value, {
          commandPublicId: input.commandPublicId,
          idempotencyKey: input.idempotencyKey,
          kind: payload.kind,
          payloadDigest,
          sessionPublicId: selector.publicId,
          targetDevicePublicId: selector.executionDevicePublicId,
        });
        const receipt = await this.#dispatchPendingRemoteCommand(pending, input.signal);
        if (sameIntent) return receipt;
        throw new Error(`Recovered cloud command ${receipt.commandPublicId}; retry the new command.`);
      }
      if (input.deadline <= now) throw new Error("Cloud remote command deadline has expired.");
      const headValue = await this.#transport.query("sessions:getHead", {
        publicId: selector.publicId,
      });
      if (headValue === null) throw new Error("Cloud remote session was not found.");
      const head = parseSessionHead(headValue);
      if (
        head.executionDevicePublicId !== selector.executionDevicePublicId
        || head.state === "orphaned"
        || head.state === "terminal"
      ) throw new Error("Cloud remote session execution authority changed.");
      const envelope = await encryptRemoteCommand(payload, key.bytes, {
        entityPublicId: input.commandPublicId,
        keyVersion: key.keyVersion,
        kind: "command",
        userPublicId: account.userPublicId,
      });
      const request = {
        deadline: input.deadline,
        expectedTargetDevicePublicId: selector.executionDevicePublicId,
        kind: payload.kind,
        payload: envelope,
        publicId: input.commandPublicId,
        sessionPublicId: selector.publicId,
      } as const;
      const requestDigest = await hmacSha256Hex(
        key.bytes,
        "command-enqueue",
        JSON.stringify(request),
      );
      const prepared: PendingRemoteCommand = {
        commandPublicId: input.commandPublicId,
        deadline: input.deadline,
        envelope,
        idempotencyKey: input.idempotencyKey,
        kind: payload.kind,
        payloadDigest,
        requestDigest,
        requestedAt: now,
        sessionPublicId: selector.publicId,
        targetDevicePublicId: selector.executionDevicePublicId,
        version: 2,
      };
      const claimed = await this.#claimPendingRemoteCommand(prepared);
      if (!claimed.created) {
        const sameIntent = sameRemoteCommandIntent(claimed.pending.value, {
          commandPublicId: input.commandPublicId,
          idempotencyKey: input.idempotencyKey,
          kind: payload.kind,
          payloadDigest,
          sessionPublicId: selector.publicId,
          targetDevicePublicId: selector.executionDevicePublicId,
        });
        const receipt = await this.#dispatchPendingRemoteCommand(claimed.pending, input.signal);
        if (sameIntent) return receipt;
        throw new Error(`Recovered cloud command ${receipt.commandPublicId}; retry the new command.`);
      }
      return await this.#dispatchPendingRemoteCommand(claimed.pending, input.signal);
    });
  }

  recoverCompactProjection(): Promise<never> {
    return Promise.reject(new Error(
      "Cloud projection recovery requires the fenced local daemon bridge.",
    ));
  }

  isCompactProjectionRecoveryUnsettled(): Promise<boolean> {
    return Promise.resolve(false);
  }

  isCompactProjectionRecoveryUnsettledForProfile(): Promise<boolean> {
    return Promise.resolve(false);
  }

  supersedeCompactProjectionRecoveryForProviderDeletion(): Promise<{ superseded: boolean }> {
    return Promise.resolve({ superseded: false });
  }

  supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    return Promise.resolve({ superseded: 0 });
  }

  async sync(signal: AbortSignal): Promise<unknown> {
    return await this.#exclusive(async () => {
      abortBeforeEffect(signal);
      const account = await this.#requireActiveDevice();
      const key = await this.#requireAccountKey(account.userPublicId);
      const [headsValue, accountsValue] = await Promise.all([
        this.#transport.query("sessions:listHeads", { limit: maximumSyncedSessions }),
        this.#transport.query("usage:listAccounts", { limit: 100 }),
      ]);
      const heads = parseSessionHeads(headsValue);
      const accounts = parseCloudAccounts(accountsValue);
      let hasIncompleteSession = false;
      for (const head of heads) {
        if (head.metadata !== undefined) {
          await decryptSessionMetadata(head.metadata, key.bytes, {
              entityPublicId: head.publicId,
              keyVersion: head.metadata.keyVersion,
              kind: "session_metadata",
              userPublicId: account.userPublicId,
            });
        }
        const compact = await this.#readCompactSession(
          head,
          account.userPublicId,
          key.bytes,
        );
        if (!compact.complete) hasIncompleteSession = true;
      }

      let usageSnapshotCount = 0;
      for (const cloudAccount of accounts) {
        const snapshot = parseLatestUsageSnapshot(await this.#transport.query(
          "usage:listSnapshots",
          { accountPublicId: cloudAccount.publicId, limit: 1 },
        ));
        if (snapshot !== null) usageSnapshotCount += 1;
        if (snapshot !== null) {
          await decryptUsageProjection(snapshot.envelope, key.bytes, {
              entityPublicId: cloudAccount.publicId,
              keyVersion: snapshot.envelope.keyVersion,
              kind: "usage",
              userPublicId: account.userPublicId,
            });
        }
      }
      const syncedAt = this.#now();
      await this.#updateState((current) => ({
        ...current,
        lastSync: {
          accountCount: accounts.length,
          at: syncedAt,
          sessionCount: heads.length,
          usageSnapshotCount,
        },
      }));
      return {
        accountCount: accounts.length,
        sessionCount: heads.length,
        synced: true,
        syncedAt,
        truncated: heads.length === maximumSyncedSessions || accounts.length === 100
          || hasIncompleteSession,
        usageSnapshotCount,
      };
    });
  }

  async #dispatchPendingRemoteCommand(
    observation: SecretObservation<PendingRemoteCommand>,
    signal: AbortSignal,
  ): Promise<CloudRemoteCommandReceipt> {
    abortBeforeEffect(signal);
    const pending = observation.value;
    const now = this.#now();
    if (
      now >= pending.deadline
      || outboxIdempotencyExpired(pending.idempotencyKey, now)
    ) {
      const recovered = parseExactRemoteCommandReceipt(await this.#transport.query(
        "commands:get",
        { commandPublicId: pending.commandPublicId },
      ));
      if (recovered === null) {
        await this.#clearExactSecret(commandOutboxSlot, observation);
        throw new Error("Expired cloud command outbox was absent remotely and has been abandoned without dispatch.");
      }
      if (
        recovered.publicId !== pending.commandPublicId
        || recovered.requestDigest !== pending.requestDigest
        || recovered.sessionPublicId !== pending.sessionPublicId
        || recovered.targetDevicePublicId !== pending.targetDevicePublicId
      ) throw new Error("Recovered cloud command changed authority.");
      await this.#acknowledgeRemoteCommand(pending);
      await this.#clearExactSecret(commandOutboxSlot, observation);
      return {
        commandPublicId: recovered.publicId,
        idempotencyKey: pending.idempotencyKey,
        kind: pending.kind,
        replay: true,
        sessionPublicId: recovered.sessionPublicId,
        state: recovered.state,
        targetDevicePublicId: recovered.targetDevicePublicId,
      };
    }
    const receipt = parseRemoteCommandReceipt(await this.#transport.mutation(
      "commands:enqueue",
      {
        deadline: pending.deadline,
        expectedTargetDevicePublicId: pending.targetDevicePublicId,
        idempotencyKey: pending.idempotencyKey,
        kind: pending.kind,
        payload: pending.envelope,
        publicId: pending.commandPublicId,
        requestDigest: pending.requestDigest,
        sessionPublicId: pending.sessionPublicId,
      },
    ));
    if (
      receipt.publicId !== pending.commandPublicId
      || receipt.sessionPublicId !== pending.sessionPublicId
      || receipt.targetDevicePublicId !== pending.targetDevicePublicId
    ) throw new Error("Cloud remote command receipt changed authority.");
    await this.#acknowledgeRemoteCommand(pending);
    await this.#clearExactSecret(commandOutboxSlot, observation);
    return {
      commandPublicId: receipt.publicId,
      idempotencyKey: pending.idempotencyKey,
      kind: pending.kind,
      replay: receipt.replay,
      sessionPublicId: receipt.sessionPublicId,
      state: receipt.state,
      targetDevicePublicId: receipt.targetDevicePublicId,
    };
  }

  async #acknowledgeRemoteCommand(pending: PendingRemoteCommand): Promise<void> {
    const acknowledgement = await this.#transport.mutation(
      "commands:acknowledgeReceipt",
      {
        commandPublicId: pending.commandPublicId,
        idempotencyKey: pending.idempotencyKey,
        requestDigest: pending.requestDigest,
      },
    );
    parseRemoteCommandAcknowledgement(acknowledgement, pending.commandPublicId);
  }

  async #readCompactSession(
    head: SessionHead,
    userPublicId: string,
    accountKey: Uint8Array,
  ): Promise<Readonly<{ complete: boolean; events: readonly CompactSessionEvent[] }>> {
    if (head.compactHeadSequence === 0) return { complete: true, events: [] };
    const chunks = parseSessionChunks(await this.#transport.query("sessions:getLatestChunks", {
        limit: maximumChunksPerSession,
        sessionPublicId: head.publicId,
        stream: "compact",
      }));
    if (chunks.length < 1 || chunks.length > maximumChunksPerSession) {
      throw new Error("Cloud session latest-chunk response is invalid.");
    }
    const events: CompactSessionEvent[] = [];
    let previous: SessionChunk | undefined;
    for (const chunk of chunks) {
      if (
        chunk.streamEpoch > head.compactStreamEpoch
        || (previous !== undefined && (
          chunk.streamEpoch < previous.streamEpoch
          ||
          chunk.firstSequence !== previous.lastSequence + 1
          || chunk.previousDigest !== previous.digest
        ))
      ) throw new Error("Cloud session latest-chunk chain is not contiguous.");
      events.push(...await decryptCompactEvents(chunk.envelope, accountKey, {
          firstSequence: chunk.firstSequence,
          keyVersion: chunk.envelope.keyVersion,
          lastSequence: chunk.lastSequence,
          ...(chunk.previousDigest === undefined ? {} : { previousDigest: chunk.previousDigest }),
          sessionPublicId: head.publicId,
          sourceBootId: chunk.authority.bootId,
          sourceDevicePublicId: chunk.sourceDevicePublicId,
          sourceFence: chunk.authority.fence,
          stream: "compact",
          userPublicId,
        }));
      previous = chunk;
    }
    const first = chunks[0];
    const last = chunks.at(-1);
    if (
      first === undefined
      || last === undefined
      || last.lastSequence !== head.compactHeadSequence
      || last.digest !== head.compactTailDigest
    ) throw new Error("Cloud session latest-chunk tail is inconsistent.");
    return {
      complete: !head.compactHasRecoveryGap
        && first.firstSequence === 1
        && first.previousDigest === undefined,
      events,
    };
  }

  async #openAccountOperationAuthority(refresh: boolean): Promise<AccountOperationAuthority> {
    if (refresh) await this.#ensureFreshAuth();
    else if (await this.#readAuth() === null) throw new Error("Cloud auth is unavailable.");
    let auth = await this.#requireAuthenticatedAuthObservation();
    let account: AccountContext;
    try {
      await this.#assertExactAuthenticatedAuth(auth);
      account = parseAccountContext(await this.#transport.query("account:current", {}));
    } catch (error: unknown) {
      if (!refresh) throw error;
      await this.#ensureFreshAuth(true);
      auth = await this.#requireAuthenticatedAuthObservation();
      await this.#assertExactAuthenticatedAuth(auth);
      account = parseAccountContext(await this.#transport.query("account:current", {}));
    }
    await this.#assertExactAuthenticatedAuth(auth);
    if (this.#identityCustody !== null) {
      await this.#identityCustody.assertCurrentIdentity(account.userPublicId);
    }
    await this.#bindAuthIdentity(auth, account);
    const authIdentity = await this.#readAuthIdentityBindingObservation();
    if (authIdentity === null) {
      throw new Error("Cloud account operation authority is unavailable.");
    }
    const authority = { account, auth, authIdentity } satisfies AccountOperationAuthority;
    await this.#assertLocalAccountOperationAuthority(authority);
    return authority;
  }

  async #assertLocalAccountOperationAuthority(
    authority: AccountOperationAuthority,
  ): Promise<void> {
    await this.#deploymentAuthority.assertCurrent();
    await this.#assertExactAuthenticatedAuth(authority.auth);
    if (this.#identityCustody !== null) {
      await this.#identityCustody.assertCurrentIdentity(authority.account.userPublicId);
    }
    const currentBinding = await this.#secrets.read(authIdentitySlot);
    const expectedDigest = createHash("sha256")
      .update(authority.auth.serialized)
      .digest("hex");
    if (
      currentBinding === null
      || currentBinding.generation !== authority.authIdentity.generation
      || currentBinding.value !== authority.authIdentity.serialized
      || authority.authIdentity.value.authDigest !== expectedDigest
      || authority.authIdentity.value.authEpoch !== authority.account.authEpoch
      || authority.authIdentity.value.authGeneration !== authority.auth.generation
      || authority.authIdentity.value.userPublicId !== authority.account.userPublicId
    ) throw new Error("Cloud account operation authority changed.");
    await this.#assertExactAuthenticatedAuth(authority.auth);
    if (this.#identityCustody !== null) {
      await this.#identityCustody.assertCurrentIdentity(authority.account.userPublicId);
    }
    await this.#deploymentAuthority.assertCurrent();
  }

  async #assertServerAccountOperationAuthority(
    authority: AccountOperationAuthority,
  ): Promise<void> {
    await this.#assertLocalAccountOperationAuthority(authority);
    const current = parseAccountContext(
      await this.#transport.query("account:current", {}),
    );
    await this.#assertLocalAccountOperationAuthority(authority);
    if (!sameAccountContext(current, authority.account)) {
      throw new Error("Cloud account operation authority changed.");
    }
  }

  async #readAccount(refresh: boolean): Promise<AccountContext> {
    if (refresh) await this.#ensureFreshAuth();
    else if (await this.#readAuth() === null) throw new Error("Cloud auth is unavailable.");
    let auth = await this.#requireAuthenticatedAuthObservation();
    let account: AccountContext;
    try {
      account = parseAccountContext(await this.#transport.query("account:current", {}));
    } catch (error: unknown) {
      if (!refresh) throw error;
      await this.#ensureFreshAuth(true);
      auth = await this.#requireAuthenticatedAuthObservation();
      account = parseAccountContext(await this.#transport.query("account:current", {}));
    }
    await this.#assertExactAuthenticatedAuth(auth);
    await this.#bindAuthIdentity(auth, account);
    return account;
  }

  #accountKeyRecoveryAuthority(
    account: AccountContext & { device: NonNullable<AccountContext["device"]> },
  ): AccountKeyRecoveryAuthority {
    return {
      authEpoch: account.authEpoch,
      devicePublicId: account.device.publicId,
      keyVersion: account.device.keyVersion,
      userPublicId: account.userPublicId,
    };
  }

  #sameAccountKeyRecoveryAuthority(
    observation: AccountKeyRecoveryObservation,
    authority: AccountKeyRecoveryAuthority,
  ): boolean {
    return observation.authEpoch === authority.authEpoch
      && observation.devicePublicId === authority.devicePublicId
      && observation.keyVersion === authority.keyVersion
      && observation.userPublicId === authority.userPublicId;
  }

  #usableAccountKey(
    key: AccountKeySecret | null,
    authority: Pick<AccountKeyRecoveryAuthority, "keyVersion" | "userPublicId">,
  ): key is AccountKeySecret {
    return key !== null
      && key.userPublicId === authority.userPublicId
      && key.keyVersion === authority.keyVersion
      && !key.provisional;
  }

  async #accountKeyStatus(
    account: AccountContext,
    operationAuthority?: AccountOperationAuthority,
  ): Promise<AccountKeyStatus | null> {
    const assertAuthority = async (): Promise<void> => {
      if (operationAuthority === undefined) return;
      if (!sameAccountContext(account, operationAuthority.account)) {
        throw new Error("Cloud account operation authority changed.");
      }
      await this.#assertLocalAccountOperationAuthority(operationAuthority);
    };
    await assertAuthority();
    if (account.device?.status !== "active") return null;
    const authority = this.#accountKeyRecoveryAuthority({ ...account, device: account.device });
    await assertAuthority();
    const key = await this.#readAccountKey();
    await assertAuthority();
    if (this.#usableAccountKey(key, authority)) {
      await assertAuthority();
      await this.#supersedeAccountKeyRecovery(key);
      await assertAuthority();
      return { keyVersion: key.keyVersion, status: "ready" };
    }
    await assertAuthority();
    const state = await this.#readState();
    await assertAuthority();
    const observed = state.accountKeyRecovery;
    if (
      observed !== null
      && this.#sameAccountKeyRecoveryAuthority(observed, authority)
      && observed.status === "unrecoverable"
    ) {
      await assertAuthority();
      return {
        evidence: "operator_confirmed_no_key_holders",
        status: "unrecoverable",
      };
    }
    await assertAuthority();
    await this.#updateState((current) => {
      const recovery = current.accountKeyRecovery;
      if (
        recovery !== null
        && this.#sameAccountKeyRecoveryAuthority(recovery, authority)
        && (recovery.status === "pairing_required" || recovery.status === "unrecoverable")
      ) return current;
      return {
        ...current,
        accountKeyRecovery: {
          ...authority,
          observedAt: this.#now(),
          status: "pairing_required",
        },
      };
    });
    await assertAuthority();
    return {
      ifNoHolder: "unrecoverable",
      recovery: "existing_key_holder_required",
      status: "pairing_required",
    };
  }

  async #supersedeAccountKeyRecovery(key: AccountKeySecret): Promise<void> {
    if (key.provisional) return;
    await this.#updateState((current) => {
      const recovery = current.accountKeyRecovery;
      if (
        recovery === null
        || recovery.status === "superseded"
        || recovery.userPublicId !== key.userPublicId
        || recovery.keyVersion !== key.keyVersion
      ) return current;
      const prior = recovery.status === "unrecoverable"
        ? {
            acknowledgedAt: recovery.acknowledgedAt,
            evidence: recovery.evidence,
            observedAt: recovery.observedAt,
            status: recovery.status,
          } as const
        : { observedAt: recovery.observedAt, status: recovery.status } as const;
      return {
        ...current,
        accountKeyRecovery: {
          authEpoch: recovery.authEpoch,
          devicePublicId: recovery.devicePublicId,
          keyVersion: recovery.keyVersion,
          prior,
          reason: "account_key_obtained",
          status: "superseded",
          supersededAt: this.#now(),
          userPublicId: recovery.userPublicId,
        },
      };
    });
  }

  async #requireActiveDevice(): Promise<AccountContext & {
    device: NonNullable<AccountContext["device"]>;
  }> {
    const account = await this.#readAccount(true);
    if (account.device === null) throw new Error("Pair this device before using cloud sync.");
    if (account.device.status !== "active") {
      throw new Error("This cloud device is awaiting approval.");
    }
    const localDevice = await this.#readDevice();
    if (
      localDevice === null
      || localDevice.userPublicId !== account.userPublicId
      || localDevice.publicId !== account.device.publicId
    ) throw new Error("The active cloud device key is unavailable; recovery is required.");
    await this.#hydrateAccountKey(account, localDevice);
    return { ...account, device: account.device };
  }

  async #requireActiveDeviceOperationAuthority(): Promise<Readonly<{
    account: AccountContext & { device: NonNullable<AccountContext["device"]> };
    authority: AccountOperationAuthority;
  }>> {
    const authority = await this.#openAccountOperationAuthority(true);
    const account = authority.account;
    if (account.device === null) throw new Error("Pair this device before using cloud sync.");
    if (account.device.status !== "active") {
      throw new Error("This cloud device is awaiting approval.");
    }
    await this.#assertLocalAccountOperationAuthority(authority);
    const localDevice = await this.#readDevice();
    await this.#assertLocalAccountOperationAuthority(authority);
    if (
      localDevice === null
      || !localDevice.registered
      || localDevice.userPublicId !== account.userPublicId
      || localDevice.publicId !== account.device.publicId
    ) throw new Error("The active cloud device key is unavailable; recovery is required.");
    await this.#hydrateAccountKey(account, localDevice, authority);
    await this.#assertServerAccountOperationAuthority(authority);
    return {
      account: { ...account, device: account.device },
      authority,
    };
  }

  async #listDeviceRecords(
    expectedUserPublicId: string,
    operationAuthority?: AccountOperationAuthority,
  ): Promise<readonly DeviceRecord[]> {
    const devices: DeviceRecord[] = [];
    const publicIds = new Set<string>();
    let cursor: string | null = null;
    let isDone = false;
    for (let pageNumber = 0; pageNumber < 50 && !isDone; pageNumber += 1) {
      if (operationAuthority !== undefined) {
        await this.#assertServerAccountOperationAuthority(operationAuthority);
      }
      const response = await this.#transport.query("devices:listPage", {
        paginationOpts: { cursor, numItems: 100 },
      });
      if (operationAuthority !== undefined) {
        await this.#assertLocalAccountOperationAuthority(operationAuthority);
      }
      const result = parseDevicePage(response);
      if (
        result.userPublicId !== expectedUserPublicId
        || result.page.some((device) => device.userPublicId !== expectedUserPublicId)
      ) throw new Error("Cloud device page changed account authority.");
      if (operationAuthority !== undefined) {
        await this.#assertServerAccountOperationAuthority(operationAuthority);
      }
      for (const device of result.page) {
        if (publicIds.has(device.publicId)) {
          throw new Error("Cloud device pagination repeated an identity.");
        }
        publicIds.add(device.publicId);
        devices.push(device);
      }
      cursor = result.continueCursor;
      isDone = result.isDone;
    }
    if (!isDone) {
      throw new Error("Cloud device listing exceeded 5000 devices; use an exact public ID.");
    }
    return devices;
  }

  async #resolveDevice(selector: string, expectedUserPublicId: string): Promise<DeviceRecord> {
    const normalized = selector.trim();
    if (normalized.length < 1 || normalized.length > 200) {
      throw new Error("Cloud device selector is invalid.");
    }
    if (isOpaqueIdentifier(normalized)) {
      const exact = await this.#transport.query("devices:get", { publicId: normalized });
      if (exact !== null) {
        const parsed = parseDeviceRecord(exact);
        if (parsed.userPublicId !== expectedUserPublicId) {
          throw new Error("Cloud device response changed account authority.");
        }
        return parsed;
      }
    }
    const devices = await this.#listDeviceRecords(expectedUserPublicId);
    const prefix = devices.filter((device) => device.publicId.startsWith(normalized));
    if (prefix.length === 1 && prefix[0] !== undefined) return prefix[0];
    if (prefix.length === 0) throw new Error("Cloud device was not found.");
    throw new Error("Cloud device selector is ambiguous.");
  }

  async #bindRegisteredDevice(
    account: AccountContext,
    device: DeviceSecret,
  ): Promise<AccountContext> {
    if (
      account.device !== null
      || !device.registered
      || device.userPublicId !== account.userPublicId
    ) throw new Error("Cloud device bind authority is invalid.");
    const challengeId = randomOpaqueId("bind");
    const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const challenge = await this.#transport.mutation("devices:beginBind", {
      challengeId,
      devicePublicId: device.publicId,
      nonce,
    });
    if (
      !isRecord(challenge)
      || !hasExactKeys(challenge, ["challengeId", "devicePublicId", "nonce"])
      || challenge.challengeId !== challengeId
      || challenge.devicePublicId !== device.publicId
      || challenge.nonce !== nonce
    ) throw new Error("Cloud device bind response is invalid.");
    const signingKey = await importP256PrivateKey(device.signingPrivateKey, "signing");
    const rebound = parseDeviceSummary(await this.#transport.action("devices:finishBind", {
      challengeId,
      signature: await signDeviceBind(signingKey, {
        challengeId,
        devicePublicId: device.publicId,
        nonce,
      }),
    }));
    const refreshed = await this.#readAccount(false);
    if (
      refreshed.device?.publicId !== rebound.publicId
      || refreshed.device.status === "revoked"
    ) throw new Error("Cloud device bind did not establish registered authority.");
    return refreshed;
  }

  async #hydrateAccountKey(
    account: AccountContext,
    device: DeviceSecret,
    operationAuthority?: AccountOperationAuthority,
  ): Promise<void> {
    const assertAuthority = async (server: boolean): Promise<void> => {
      if (operationAuthority === undefined) return;
      if (!sameAccountContext(account, operationAuthority.account)) {
        throw new Error("Cloud account operation authority changed.");
      }
      if (server) await this.#assertServerAccountOperationAuthority(operationAuthority);
      else await this.#assertLocalAccountOperationAuthority(operationAuthority);
    };
    await assertAuthority(false);
    const current = await this.#readAccountKey();
    await assertAuthority(false);
    if (
      current !== null
      && current.userPublicId === account.userPublicId
      && current.keyVersion === account.device?.keyVersion
      && !current.provisional
    ) return;
    await assertAuthority(true);
    const value = await this.#transport.query("devices:listKeyEnvelopes", {});
    await assertAuthority(false);
    if (!Array.isArray(value) || value.length > 16) {
      throw new Error("Cloud account-key response is invalid.");
    }
    const envelopes: Array<Readonly<{ createdAt: number; envelope: WrappedKeyEnvelope }>> = [];
    for (const entry of value) {
      if (
        !isRecord(entry)
        || !hasExactKeys(entry, ["createdAt", "envelope"])
        || !isFiniteTimestamp(entry.createdAt)
      ) throw new Error("Cloud account-key response is invalid.");
      const envelope = parseWrappedKeyEnvelope(entry.envelope);
      if (envelope === null) throw new Error("Cloud account-key response is invalid.");
      envelopes.push({ createdAt: entry.createdAt, envelope });
    }
    const expectedVersion = account.device?.keyVersion;
    const selected = envelopes
      .filter((entry) => entry.envelope.keyVersion === expectedVersion)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (selected === undefined || expectedVersion === undefined) {
      throw new Error("No account-key envelope exists for this cloud device.");
    }
    const privateKey = await importP256PrivateKey(device.wrappingPrivateKey, "wrapping");
    const bytes = await unwrapAccountDataKey(selected.envelope, privateKey, {
      accountKeyVersion: expectedVersion,
      devicePublicId: device.publicId,
      userPublicId: account.userPublicId,
    });
    await assertAuthority(true);
    await this.#writeAccountKey({
      key: encodeBase64Url(bytes),
      keyVersion: expectedVersion,
      provisional: false,
      userPublicId: account.userPublicId,
      version: 1,
    });
    await assertAuthority(true);
  }

  async #generateDeviceSecret(userPublicId: string): Promise<DeviceSecret> {
    const [signing, wrapping] = await Promise.all([
      generateDeviceSigningKeyPair(true),
      generateDeviceWrappingKeyPair(true),
    ]);
    const device: DeviceSecret = {
      publicId: randomOpaqueId("device"),
      registered: false,
      signingPrivateKey: await exportDevicePrivateKey(signing.privateKey),
      signingPublicKey: await exportDevicePublicKey(signing.publicKey),
      userPublicId,
      version: 1,
      wrappingPrivateKey: await exportDevicePrivateKey(wrapping.privateKey),
      wrappingPublicKey: await exportDevicePublicKey(wrapping.publicKey),
    };
    return device;
  }

  async #createDeviceSecret(userPublicId: string): Promise<DeviceSecret> {
    const device = await this.#generateDeviceSecret(userPublicId);
    await this.#writeSecret(deviceSlot, serializeSecret(device));
    return device;
  }

  async #prepareDeviceReplacement(
    current: SecretObservation<DeviceReplacement> | null,
    account: AccountContext,
    device: DeviceSecret,
  ): Promise<SecretObservation<DeviceReplacement>> {
    if (account.device?.status !== "revoked") {
      throw new Error("Only a revoked cloud device can prepare replacement.");
    }
    if (current !== null) {
      if (
        current.value.evidence.publicId !== device.publicId
        || current.value.evidence.userPublicId !== account.userPublicId
        || current.value.evidence.signingPublicKey !== device.signingPublicKey
        || current.value.evidence.wrappingPublicKey !== device.wrappingPublicKey
        || current.value.evidence.revision !== account.device.revision
      ) throw new Error("Cloud device-replacement evidence changed authority.");
      return current;
    }
    const prepared: DeviceReplacement = {
      evidence: {
        publicId: device.publicId,
        revision: account.device.revision,
        revokedObservedAt: this.#now(),
        signingPublicKey: device.signingPublicKey,
        userPublicId: account.userPublicId,
        wrappingPublicKey: device.wrappingPublicKey,
      },
      phase: "prepared",
      version: 1,
    };
    const serialized = serializeSecret(prepared);
    const committed = await this.#secrets.compareAndSwap(replacementSlot, null, serialized);
    if (committed === null) {
      const concurrent = await this.#readDeviceReplacement();
      if (concurrent === null) {
        throw new Error("Cloud device-replacement evidence changed concurrently.");
      }
      return await this.#prepareDeviceReplacement(concurrent, account, device);
    }
    return {
      generation: committed.generation,
      serialized,
      value: prepared,
    };
  }

  async #archiveRetiredDevice(evidence: RetiredDeviceEvidence): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#secrets.read(retiredDevicesSlot);
      const history = current === null
        ? { devices: [], version: 1 } as const
        : parseRetiredDeviceHistory(current.value);
      const existing = history.devices.find((device) => device.publicId === evidence.publicId);
      if (existing !== undefined) {
        if (!sameRetiredDeviceEvidence(existing, evidence)) {
          throw new Error("Cloud retired-device history changed authority.");
        }
        return;
      }
      if (history.devices.length >= 100) {
        throw new Error("Cloud retired-device history is full.");
      }
      const serialized = serializeSecret({
        devices: [...history.devices, evidence],
        version: 1,
      });
      const committed = await this.#secrets.compareAndSwap(
        retiredDevicesSlot,
        current?.generation ?? null,
        serialized,
      );
      if (committed !== null) return;
    }
    throw new Error("Cloud retired-device history changed concurrently.");
  }

  async #resumeDeviceReplacement(
    original: SecretObservation<DeviceReplacement>,
    account: AccountContext,
    localDevice: DeviceSecret | null,
  ): Promise<Readonly<{
    device: DeviceSecret;
    replacement: SecretObservation<DeviceReplacement>;
  }>> {
    if (
      account.device !== null
      || original.value.evidence.userPublicId !== account.userPublicId
    ) throw new Error("Cloud device-replacement evidence changed authority.");
    let replacement = original;
    let nextDevice: DeviceSecret;
    if (replacement.value.phase === "prepared") {
      if (
        localDevice === null
        || localDevice.publicId !== replacement.value.evidence.publicId
        || localDevice.userPublicId !== account.userPublicId
        || localDevice.signingPublicKey !== replacement.value.evidence.signingPublicKey
        || localDevice.wrappingPublicKey !== replacement.value.evidence.wrappingPublicKey
        || !localDevice.registered
      ) throw new Error("Cloud revoked-device evidence is unavailable.");
      nextDevice = await this.#generateDeviceSecret(account.userPublicId);
      const rotating: DeviceReplacement = {
        evidence: replacement.value.evidence,
        nextDevice,
        phase: "rotating",
        version: 1,
      };
      const committed = await this.#replaceExactSecret(
        replacementSlot,
        replacement,
        serializeSecret(rotating),
      );
      replacement = { ...committed, value: rotating };
    } else {
      nextDevice = replacement.value.nextDevice;
    }
    await this.#archiveRetiredDevice(replacement.value.evidence);
    const deviceObservation = await this.#readDeviceObservation();
    if (deviceObservation === null) {
      throw new Error("Cloud revoked-device evidence is unavailable.");
    }
    if (!sameDeviceSecret(deviceObservation.value, nextDevice)) {
      if (
        deviceObservation.value.publicId !== replacement.value.evidence.publicId
        || deviceObservation.value.userPublicId !== account.userPublicId
        || deviceObservation.value.signingPublicKey
          !== replacement.value.evidence.signingPublicKey
        || deviceObservation.value.wrappingPublicKey
          !== replacement.value.evidence.wrappingPublicKey
        || !deviceObservation.value.registered
      ) throw new Error("Cloud revoked-device evidence changed authority.");
      await this.#replaceExactSecret(
        deviceSlot,
        deviceObservation,
        serializeSecret(nextDevice),
      );
    }
    return { device: nextDevice, replacement };
  }

  async #ensureFreshAuth(force = false): Promise<AuthSecret> {
    await this.#retireExpiredAuthLogout();
    if (await this.#readPendingAuthLogout() !== null) {
      throw new Error("Cloud sign-out recovery is pending; retry logout before using this auth session.");
    }
    const authObservation = await this.#readAuthCustodyObservation();
    if (authObservation === null || authObservation.value.kind !== "authenticated") {
      throw new Error("Cloud auth is unavailable or sign-out recovery is pending.");
    }
    const auth = authObservation.value.auth;
    if (!force && this.#now() - auth.obtainedAt < refreshAfterMs) return auth;
    const refreshed = parseAuthSignInResult(await this.#transport.action("auth:signIn", {
      refreshToken: auth.refreshToken,
    }));
    if (refreshed?.kind !== "authenticated") {
      throw new Error("Cloud auth refresh response is invalid.");
    }
    const next: AuthSecret = {
      email: auth.email,
      obtainedAt: this.#now(),
      refreshToken: refreshed.refreshToken,
      token: refreshed.token,
      version: 1,
    };
    if (await this.#readPendingAuthLogout() !== null) {
      throw new Error("Cloud sign-out recovery started during auth refresh.");
    }
    const current = await this.#secrets.read(authSlot);
    if (
      current?.generation !== authObservation.generation
      || current.value !== authObservation.serialized
    ) throw new Error("Cloud auth changed during refresh.");
    const serialized = serializeSecret(next);
    const committed = await this.#secrets.compareAndSwap(
      authSlot,
      authObservation.generation,
      serialized,
    );
    if (committed === null) throw new Error("Cloud auth changed during refresh.");
    const after = await this.#secrets.read(authSlot);
    if (
      await this.#readPendingAuthLogout() !== null
      || after?.generation !== committed.generation
      || after.value !== serialized
    ) throw new Error("Cloud sign-out recovery started during auth refresh.");
    return next;
  }

  async #readAuth(): Promise<AuthSecret | null> {
    const observation = await this.#readAuthCustodyObservation();
    return observation?.value.kind === "authenticated" ? observation.value.auth : null;
  }

  async #readAuthIdentityBinding(): Promise<AuthIdentityBinding | null> {
    return (await this.#readAuthIdentityBindingObservation())?.value ?? null;
  }

  async #readAuthIdentityBindingObservation(): Promise<SecretObservation<AuthIdentityBinding> | null> {
    const observation = await this.#secrets.read(authIdentitySlot);
    return observation === null ? null : {
      generation: observation.generation,
      serialized: observation.value,
      value: parseAuthIdentityBinding(observation.value),
    };
  }

  async #requireAuthenticatedAuthObservation(): Promise<SecretObservation<
    Extract<AuthCustody, Readonly<{ kind: "authenticated" }>>
  >> {
    const observation = await this.#readAuthCustodyObservation();
    if (observation?.value.kind !== "authenticated") {
      throw new Error("Cloud auth is unavailable.");
    }
    return {
      generation: observation.generation,
      serialized: observation.serialized,
      value: observation.value,
    };
  }

  async #assertExactAuthenticatedAuth(
    expected: Readonly<{ generation: number; serialized: string }>,
  ): Promise<void> {
    const current = await this.#readAuthCustodyObservation();
    if (
      current?.value.kind !== "authenticated"
      || current.generation !== expected.generation
      || current.serialized !== expected.serialized
    ) throw new Error("Cloud auth changed during account identity binding.");
  }

  async #bindAuthIdentity(
    auth: Readonly<{ generation: number; serialized: string }>,
    account: AccountContext,
  ): Promise<void> {
    const binding: AuthIdentityBinding = {
      authDigest: createHash("sha256").update(auth.serialized).digest("hex"),
      authEpoch: account.authEpoch,
      authGeneration: auth.generation,
      userPublicId: account.userPublicId,
      version: 1,
    };
    const serialized = serializeSecret(binding);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.#assertExactAuthenticatedAuth(auth);
      const current = await this.#secrets.read(authIdentitySlot);
      if (current?.value === serialized) return;
      const committed = await this.#secrets.compareAndSwap(
        authIdentitySlot,
        current?.generation ?? null,
        serialized,
      );
      if (committed !== null) {
        await this.#assertExactAuthenticatedAuth(auth);
        return;
      }
    }
    throw new Error("Cloud auth-identity binding changed concurrently.");
  }

  async #readTransportAuth(): Promise<AuthSecret | null> {
    const observation = await this.#readAuthCustodyObservation();
    if (observation === null || observation.value.kind === "signed_out") return null;
    return observation.value.kind === "authenticated"
      ? observation.value.auth
      : observation.value.claim.auth;
  }

  async #readAuthCustodyObservation(): Promise<SecretObservation<AuthCustody> | null> {
    const observation = await this.#secrets.read(authSlot);
    return observation === null ? null : {
      generation: observation.generation,
      serialized: observation.value,
      value: parseAuthCustody(observation.value),
    };
  }

  async #readExactAuthLogoutClaim(
    observation: Readonly<{ generation: number; serialized: string }>,
  ): Promise<SecretObservation<Extract<AuthCustody, Readonly<{ kind: "logout_claim" }>>>> {
    const current = await this.#readAuthCustodyObservation();
    const value = current?.value;
    if (
      current === null
      || current.generation !== observation.generation
      || current.serialized !== observation.serialized
      || value?.kind !== "logout_claim"
    ) throw new Error("Cloud sign-out auth claim changed concurrently.");
    return {
      generation: current.generation,
      serialized: current.serialized,
      value,
    };
  }

  async #replaceAuthWithSignedOut(
    current: SecretObservation<AuthCustody> | null,
    requestedAt: number,
    retired: Readonly<{ digest: string; generation: number }> | null = null,
  ): Promise<SecretObservation<Extract<AuthCustody, Readonly<{ kind: "signed_out" }>>>> {
    const signedOut: AuthSignedOut = {
      phase: "signed_out",
      requestedAt,
      retiredAuthDigest: retired?.digest
        ?? (current === null
          ? null
          : createHash("sha256").update(current.serialized).digest("hex")),
      retiredAuthGeneration: retired?.generation ?? current?.generation ?? null,
      version: 3,
    };
    const serialized = serializeSecret(signedOut);
    const committed = current === null
      ? await this.#secrets.compareAndSwap(authSlot, null, serialized)
      : await this.#replaceExactSecret(authSlot, current, serialized);
    if (committed === null) throw new Error("Cloud auth changed concurrently.");
    return {
      generation: committed.generation,
      serialized,
      value: { kind: "signed_out", signedOut },
    };
  }

  #signedOutMatchesPending(
    signedOut: AuthSignedOut,
    pending: PendingAuthLogout,
  ): boolean {
    return signedOut.retiredAuthGeneration === pending.authGeneration
      && signedOut.retiredAuthDigest === pending.authDigest
      && signedOut.requestedAt === pending.requestedAt;
  }

  async #readPendingAuthLogout(): Promise<SecretObservation<PendingAuthLogout> | null> {
    const observation = await this.#secrets.read(authLogoutSlot);
    return observation === null ? null : {
      generation: observation.generation,
      serialized: observation.value,
      value: parsePendingAuthLogout(observation.value),
    };
  }

  async #readPendingAccountDeletion(): Promise<SecretObservation<PendingAccountDeletion> | null> {
    const observation = await this.#secrets.read(accountDeletionSlot);
    return observation === null ? null : {
      generation: observation.generation,
      serialized: observation.value,
      value: parsePendingAccountDeletion(observation.value),
    };
  }

  async #refreshAccountDeletionStatus(
    pending: SecretObservation<PendingAccountDeletion>,
  ): Promise<SecretObservation<PendingAccountDeletion>> {
    let response: unknown;
    try {
      response = await this.#transport.query("accountDeletion:status", {
        jobId: pending.value.jobId,
        statusCapability: pending.value.statusCapability,
      });
    } catch {
      throw new AccountDeletionStatusUnavailableError();
    }
    const status = parseAccountDeletionStatus(response, pending.value.jobId);
    return await this.#commitAccountDeletionStatus(pending, status);
  }

  async #commitAccountDeletionStatus(
    pending: SecretObservation<PendingAccountDeletion>,
    status: AccountDeletionStatus,
  ): Promise<SecretObservation<PendingAccountDeletion>> {
    const previous = pending.value.status;
    if (previous !== null) {
      const previousCategory = accountDeletionCategories.indexOf(previous.category);
      const nextCategory = accountDeletionCategories.indexOf(status.category);
      const completedTransition = previous.state !== "complete" && status.state === "complete";
      if (
        (!completedTransition && status.createdAt !== previous.createdAt)
        || (completedTransition && status.createdAt < previous.createdAt)
        || status.updatedAt < previous.updatedAt
        || nextCategory < previousCategory
        || (previous.state === "complete" && status.state !== "complete")
      ) throw new Error("Cloud account-erasure status regressed.");
      if (
        status.updatedAt === previous.updatedAt
        && status.category === previous.category
        && status.state === previous.state
      ) return pending;
    }
    const next: PendingAccountDeletion = { ...pending.value, status };
    const committed = await this.#replaceExactSecret(
      accountDeletionSlot,
      pending,
      serializeSecret(next),
    );
    return { ...committed, value: next };
  }

  #publicAccountDeletion(
    pending: PendingAccountDeletion,
    statusFresh: boolean,
  ): Readonly<Record<string, unknown>> {
    const status = pending.status;
    return {
      ...(status === null
        ? {}
        : {
            category: status.category,
            createdAt: status.createdAt,
          }),
      effectsDisabled: status !== null,
      requestedAt: pending.requestedAt,
      state: status?.state ?? "pending",
      statusFresh,
      updatedAt: status?.updatedAt ?? pending.requestedAt,
    };
  }

  async #retireExpiredAuthLogout(): Promise<boolean> {
    const pending = await this.#readPendingAuthLogout();
    const auth = await this.#readAuthCustodyObservation();
    if (pending !== null && auth?.value.kind === "signed_out") {
      if (
        pending.value.phase !== "confirmed"
        || !this.#signedOutMatchesPending(auth.value.signedOut, pending.value)
      ) throw new Error("Expired cloud sign-out recovery found changed auth custody.");
      await this.#clearExactSecret(authLogoutSlot, pending);
      return true;
    }
    const requestedAt = pending?.value.requestedAt
      ?? (auth?.value.kind === "logout_claim" ? auth.value.claim.requestedAt : null);
    if (requestedAt === null || this.#now() < requestedAt + authSessionTotalDurationMs) {
      return false;
    }
    if (pending !== null && auth !== null) {
      if (
        auth.generation !== pending.value.authGeneration
        || createHash("sha256").update(auth.serialized).digest("hex") !== pending.value.authDigest
      ) throw new Error("Expired cloud sign-out recovery found changed auth custody.");
      await this.#replaceAuthWithSignedOut(auth, requestedAt);
    } else if (pending !== null) {
      await this.#replaceAuthWithSignedOut(null, requestedAt, {
        digest: pending.value.authDigest,
        generation: pending.value.authGeneration,
      });
    } else if (auth?.value.kind === "logout_claim") {
      await this.#replaceAuthWithSignedOut(auth, requestedAt);
    } else if (auth !== null) {
      throw new Error("Expired cloud sign-out recovery found changed auth custody.");
    }
    if (pending !== null) await this.#clearExactSecret(authLogoutSlot, pending);
    return true;
  }

  async #readDevice(): Promise<DeviceSecret | null> {
    const observation = await this.#secrets.read(deviceSlot);
    return observation === null ? null : parseDeviceSecret(observation.value);
  }

  async #readDeviceObservation(): Promise<SecretObservation<DeviceSecret> | null> {
    const observation = await this.#secrets.read(deviceSlot);
    return observation === null ? null : {
      generation: observation.generation,
      serialized: observation.value,
      value: parseDeviceSecret(observation.value),
    };
  }

  async #readDeviceReplacement(): Promise<SecretObservation<DeviceReplacement> | null> {
    const observation = await this.#secrets.read(replacementSlot);
    return observation === null ? null : {
      generation: observation.generation,
      serialized: observation.value,
      value: parseDeviceReplacement(observation.value),
    };
  }

  async #readAccountKey(): Promise<AccountKeySecret | null> {
    const observation = await this.#secrets.read(accountKeySlot);
    return observation === null ? null : parseAccountKeySecret(observation.value);
  }

  async #readState(): Promise<LocalCloudState> {
    const observation = await this.#secrets.read(stateSlot);
    return observation === null
      ? { accountKeyRecovery: null, lastSync: null, version: 2 }
      : parseLocalState(observation.value);
  }

  async #updateState(
    update: (current: LocalCloudState) => LocalCloudState,
  ): Promise<LocalCloudState> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#secrets.read(stateSlot);
      const parsed = current === null
        ? { accountKeyRecovery: null, lastSync: null, version: 2 } as const
        : parseLocalState(current.value);
      const next = update(parsed);
      const serialized = serializeSecret(next);
      if (current?.value === serialized) return next;
      const committed = await this.#secrets.compareAndSwap(
        stateSlot,
        current?.generation ?? null,
        serialized,
      );
      if (committed !== null) return next;
    }
    throw new Error("Cloud local state changed concurrently.");
  }

  async #readDeviceMutationCustody(
    userPublicId: string,
  ): Promise<SecretObservation<DeviceMutationCustody> | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const observation = await this.#secrets.read(mutationSlot);
      if (observation === null) return null;
      const parsed = parseDeviceMutationCustody(observation.value);
      if (parsed.userPublicId !== null && parsed.userPublicId !== userPublicId) {
        throw new Error("Cloud device-mutation custody belongs to a different identity.");
      }
      const bounded = boundedDeviceMutationCustody({
        pending: parsed.pending,
        receipts: parsed.receipts,
        userPublicId,
        version: 2,
      }, this.#now());
      if (parsed.version === 2 && bounded.serialized === observation.value) {
        return {
          generation: observation.generation,
          serialized: observation.value,
          value: bounded.value,
        };
      }
      const committed = await this.#secrets.compareAndSwap(
        mutationSlot,
        observation.generation,
        bounded.serialized,
      );
      if (committed !== null) {
        return {
          generation: committed.generation,
          serialized: bounded.serialized,
          value: bounded.value,
        };
      }
    }
    throw new Error("Cloud device-mutation custody changed concurrently.");
  }

  async #claimPendingMutation(
    userPublicId: string,
    pending: PendingDeviceMutation,
  ): Promise<Readonly<{
    created: boolean;
    custody: SecretObservation<DeviceMutationCustody>;
  }>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#readDeviceMutationCustody(userPublicId);
      if (current?.value.pending !== null && current?.value.pending !== undefined) {
        return { created: false, custody: current };
      }
      if (current?.value.receipts.some((receipt) =>
        receipt.idempotencyKey === pending.idempotencyKey) === true) {
        return { created: false, custody: current };
      }
      const bounded = boundedDeviceMutationCustody({
        pending,
        receipts: current?.value.receipts ?? [],
        userPublicId,
        version: 2,
      }, this.#now());
      const committed = await this.#secrets.compareAndSwap(
        mutationSlot,
        current?.generation ?? null,
        bounded.serialized,
      );
      if (committed !== null) {
        return {
          created: true,
          custody: {
            generation: committed.generation,
            serialized: bounded.serialized,
            value: bounded.value,
          },
        };
      }
    }
    throw new Error("Cloud device mutation outbox changed concurrently.");
  }

  async #abandonPendingDeviceMutation(
    userPublicId: string,
    custody: SecretObservation<DeviceMutationCustody>,
  ): Promise<void> {
    if (custody.value.userPublicId !== userPublicId || custody.value.pending === null) {
      throw new Error("Cloud device-mutation custody changed authority.");
    }
    const bounded = boundedDeviceMutationCustody({
      ...custody.value,
      pending: null,
    }, this.#now());
    await this.#replaceExactSecret(mutationSlot, custody, bounded.serialized);
  }

  async #settlePendingDeviceMutation(
    userPublicId: string,
    original: SecretObservation<DeviceMutationCustody>,
    result: DeviceMutationResult,
  ): Promise<void> {
    const expected = original.value.pending;
    if (expected === null || original.value.userPublicId !== userPublicId) {
      throw new Error("Cloud device-mutation custody changed authority.");
    }
    if (
      result.publicId !== expected.targetPublicId
      || result.status !== (expected.kind === "approve" ? "active" : "revoked")
      || result.revision !== expected.expectedRevision + 1
    ) throw new Error("Cloud device-mutation settlement result is inconsistent.");
    const receipt: DeviceMutationReceipt = {
      completedAt: this.#now(),
      idempotencyKey: expected.idempotencyKey,
      kind: expected.kind,
      requestDigest: expected.requestDigest,
      result,
      targetPublicId: expected.targetPublicId,
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = attempt === 0
        ? original
        : await this.#readDeviceMutationCustody(userPublicId);
      if (current === null || current.value.userPublicId !== userPublicId) {
        throw new Error("Cloud device-mutation custody changed authority.");
      }
      const existing = current.value.receipts.find((candidate) =>
        candidate.idempotencyKey === receipt.idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.kind !== receipt.kind
          || existing.requestDigest !== receipt.requestDigest
          || existing.targetPublicId !== receipt.targetPublicId
          || JSON.stringify(existing.result) !== JSON.stringify(receipt.result)
        ) {
          throw new Error("Cloud device mutation idempotency key was reused for a different request.");
        }
        return;
      }
      if (
        current.value.pending === null
        || JSON.stringify(current.value.pending) !== JSON.stringify(expected)
      ) throw new Error("Cloud device-mutation custody changed authority.");
      const bounded = boundedDeviceMutationCustody({
        pending: null,
        receipts: [...current.value.receipts, receipt],
        userPublicId,
        version: 2,
      }, this.#now());
      const committed = await this.#secrets.compareAndSwap(
        mutationSlot,
        current.generation,
        bounded.serialized,
      );
      if (committed !== null) return;
    }
    throw new Error("Cloud device-mutation custody changed concurrently.");
  }

  async #readPendingRegistration(): Promise<SecretObservation<PendingDeviceRegistration> | null> {
    const observation = await this.#secrets.read(registrationSlot);
    return observation === null ? null : {
      generation: observation.generation,
      serialized: observation.value,
      value: parsePendingDeviceRegistration(observation.value),
    };
  }

  async #validatePendingRegistration(
    pending: PendingDeviceRegistration,
    account: AccountContext,
    device: DeviceSecret,
  ): Promise<void> {
    const key = await this.#readAccountKey();
    if (
      pending.userPublicId !== account.userPublicId
      || device.userPublicId !== account.userPublicId
      || device.publicId !== pending.publicId
      || device.signingPublicKey !== pending.signingPublicKey
      || device.wrappingPublicKey !== pending.wrappingPublicKey
      || key === null
      || key.userPublicId !== account.userPublicId
      || key.keyVersion !== pending.keyVersion
    ) throw new Error("Pending cloud device registration authority changed.");
    const requestDigest = await hmacSha256Hex(
      decodeBase64Url(key.key),
      "device-register",
      JSON.stringify(deviceRegistrationRequest(pending)),
    );
    if (requestDigest !== pending.requestDigest) {
      throw new Error("Pending cloud device registration evidence changed.");
    }
  }

  async #sendPendingRegistration(
    observation: SecretObservation<PendingDeviceRegistration>,
    account: AccountContext,
    deviceSecret: DeviceSecret,
    replay: boolean,
  ): Promise<unknown> {
    const pending = observation.value;
    const registrationName = outboxIdempotencyExpired(pending.idempotencyKey, this.#now())
      ? "devices:recoverRegistration" as const
      : "devices:register" as const;
    const request = {
      ...deviceRegistrationRequest(pending),
      requestDigest: pending.requestDigest,
    };
    let registrationValue: unknown;
    try {
      registrationValue = await this.#transport.mutation(registrationName, request);
    } catch (registrationError: unknown) {
      if (registrationName !== "devices:register") throw registrationError;
      let recovered: unknown;
      try {
        recovered = await this.#transport.mutation("devices:recoverRegistration", request);
      } catch {
        throw registrationError;
      }
      if (recovered !== null) {
        registrationValue = recovered;
      } else {
        const refreshed = await this.#readAccount(false);
        if (
          pending.bootstrapKeyEnvelope !== undefined
          && refreshed.device === null
          && refreshed.hasActiveDevices
        ) {
          return await this.#rerollPendingRegistration(
            observation,
            refreshed,
            deviceSecret,
            true,
          );
        }
        throw registrationError;
      }
    }
    if (registrationValue === null) {
      const refreshed = await this.#readAccount(false);
      return await this.#rerollPendingRegistration(
        observation,
        refreshed,
        deviceSecret,
        pending.bootstrapKeyEnvelope !== undefined
          && refreshed.device === null
          && refreshed.hasActiveDevices,
      );
    }
    const registered = parseDeviceSummary(registrationValue);
    if (registered.publicId !== deviceSecret.publicId) {
      throw new Error("Cloud registered a different device authority.");
    }
    const rebound = await this.#readAccount(false);
    if (rebound.device?.publicId !== pending.publicId) {
      throw new Error("Cloud device registration did not bind the current auth session.");
    }
    await this.#writeSecret(deviceSlot, serializeSecret({
      ...deviceSecret,
      registered: true,
    }));
    if (rebound.device.status === "active") {
      if (pending.bootstrapKeyEnvelope === undefined) {
        // A later device's provisional key authenticates only its registration
        // outbox. Once approved, replace it with the account key delivered by
        // an already active device; never promote the provisional bytes.
        await this.#hydrateAccountKey(rebound, { ...deviceSecret, registered: true });
      } else {
        const provisional = await this.#readAccountKey();
        if (provisional === null || provisional.userPublicId !== account.userPublicId) {
          throw new Error("Cloud account-key registration evidence is unavailable.");
        }
        await this.#writeAccountKey({ ...provisional, provisional: false });
      }
    }
    await this.#clearExactSecret(registrationSlot, observation);
    return {
      device: publicAccountDevice(rebound.device),
      paired: rebound.device.status === "active",
      ...(replay ? { replay: true } : {}),
    };
  }

  async #rerollPendingRegistration(
    observation: SecretObservation<PendingDeviceRegistration>,
    account: AccountContext,
    deviceSecret: DeviceSecret,
    downgradeBootstrap: boolean,
  ): Promise<unknown> {
    const pending = observation.value;
    const freshIntent = {
      ...(!downgradeBootstrap && pending.bootstrapKeyEnvelope !== undefined
        ? { bootstrapKeyEnvelope: pending.bootstrapKeyEnvelope }
        : {}),
      encryptedLabel: pending.encryptedLabel,
      idempotencyKey: createCloudUuidV7(this.#now()),
      keyVersion: pending.keyVersion,
      publicId: pending.publicId,
      signingPublicKey: pending.signingPublicKey,
      wrappingPublicKey: pending.wrappingPublicKey,
    };
    const key = await this.#readAccountKey();
    if (key === null || key.userPublicId !== account.userPublicId) {
      throw new Error("Cloud account-key registration evidence is unavailable.");
    }
    const fresh: PendingDeviceRegistration = {
      ...freshIntent,
      requestDigest: await hmacSha256Hex(
        decodeBase64Url(key.key),
        "device-register",
        JSON.stringify(freshIntent),
      ),
      userPublicId: pending.userPublicId,
      version: 1,
    };
    const replacement = await this.#replaceExactSecret(
      registrationSlot,
      observation,
      serializeSecret(fresh),
    );
    return await this.#sendPendingRegistration(
      { ...replacement, value: fresh },
      account,
      deviceSecret,
      true,
    );
  }

  async #readPendingRemoteCommand(): Promise<SecretObservation<PendingRemoteCommand> | null> {
    const observation = await this.#secrets.read(commandOutboxSlot);
    return observation === null ? null : {
      generation: observation.generation,
      serialized: observation.value,
      value: parsePendingRemoteCommand(observation.value),
    };
  }

  async #claimPendingRemoteCommand(pending: PendingRemoteCommand): Promise<Readonly<{
    created: boolean;
    pending: SecretObservation<PendingRemoteCommand>;
  }>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#secrets.read(commandOutboxSlot);
      if (current !== null) {
        return {
          created: false,
          pending: {
            generation: current.generation,
            serialized: current.value,
            value: parsePendingRemoteCommand(current.value),
          },
        };
      }
      const serialized = serializeSecret(pending);
      const committed = await this.#secrets.compareAndSwap(
        commandOutboxSlot,
        null,
        serialized,
      );
      if (committed !== null) {
        return {
          created: true,
          pending: {
            generation: committed.generation,
            serialized,
            value: pending,
          },
        };
      }
    }
    throw new Error("Cloud remote command outbox changed concurrently.");
  }

  async #requireAccountKey(userPublicId: string): Promise<Readonly<{
    bytes: Uint8Array;
    keyVersion: number;
  }>> {
    const key = await this.#readAccountKey();
    if (key === null || key.userPublicId !== userPublicId || key.provisional) {
      throw new Error("The cloud account key is unavailable.");
    }
    const bytes = decodeBase64Url(key.key);
    await this.#admitGcmMessageBudget(bytes, key.keyVersion);
    return { bytes, keyVersion: key.keyVersion };
  }

  // Every encryption under this key passes through `encryptBytes`, which
  // counts it in the process-wide budget. This admission restores the
  // persisted high-water mark for the key, refuses the key once its budget
  // is spent, and advances the persisted mark once per checkpoint interval
  // so a restart can never undercount.
  async #admitGcmMessageBudget(bytes: Uint8Array, keyVersion: number): Promise<void> {
    const budgetKey: GcmMessageBudgetKey = await gcmMessageBudgetKey(bytes, keyVersion);
    const observation = await this.#secrets.read(gcmMessageBudgetSlot);
    const custody = observation === null
      ? { keys: [], version: 1 } as const
      : parseGcmMessageBudgetCustody(observation.value);
    const persisted = custody.keys.find((entry) =>
      entry.keyVersion === budgetKey.keyVersion && entry.fingerprint === budgetKey.fingerprint);
    const messages = this.#gcmMessageBudget.restore(budgetKey, persisted?.messages ?? 0);
    if (messages >= gcmMessageBudgetPerKey) throw new KeyRotationRequiredError(keyVersion);
    const covered = Math.min(messages + gcmMessageBudgetCheckpointInterval, gcmMessageBudgetPerKey);
    if ((persisted?.messages ?? 0) >= covered) return;
    if (persisted === undefined && custody.keys.length >= maximumGcmMessageBudgetKeys) {
      throw new Error("Cloud GCM message budget custody is full.");
    }
    const mark = Math.min(messages + 2 * gcmMessageBudgetCheckpointInterval, gcmMessageBudgetPerKey);
    const next: GcmMessageBudgetCustody = {
      keys: [
        ...custody.keys.filter((entry) => entry !== persisted),
        { fingerprint: budgetKey.fingerprint, keyVersion: budgetKey.keyVersion, messages: mark },
      ],
      version: 1,
    };
    const committed = await this.#secrets.compareAndSwap(
      gcmMessageBudgetSlot,
      observation?.generation ?? null,
      serializeSecret(next),
    );
    if (committed === null) throw new Error("Cloud secret state changed concurrently.");
  }

  async #writeAccountKey(value: AccountKeySecret): Promise<void> {
    await this.#writeSecret(accountKeySlot, serializeSecret(value));
    await this.#supersedeAccountKeyRecovery(value);
  }

  async #writeSecret(slot: string, value: string): Promise<Readonly<{
    generation: number;
    serialized: string;
  }>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#secrets.read(slot);
      const committed = await this.#secrets.compareAndSwap(
        slot,
        current?.generation ?? null,
        value,
      );
      if (committed !== null) {
        return { generation: committed.generation, serialized: value };
      }
    }
    throw new Error("Cloud secret state changed concurrently.");
  }

  async #clearExactSecret(
    slot: string,
    observation: Readonly<{ generation: number; serialized: string }>,
  ): Promise<void> {
    const current = await this.#secrets.read(slot);
    if (current === null) return;
    if (
      current.generation !== observation.generation
      || current.value !== observation.serialized
    ) throw new Error("Cloud secret state changed concurrently.");
    if (!await this.#secrets.clearIfGeneration(slot, observation.generation)) {
      throw new Error("Cloud secret state changed concurrently.");
    }
  }

  async #replaceExactSecret(
    slot: string,
    observation: Readonly<{ generation: number; serialized: string }>,
    replacement: string,
  ): Promise<Readonly<{ generation: number; serialized: string }>> {
    const current = await this.#secrets.read(slot);
    if (
      current === null
      || current.generation !== observation.generation
      || current.value !== observation.serialized
    ) throw new Error("Cloud secret state changed concurrently.");
    const committed = await this.#secrets.compareAndSwap(
      slot,
      observation.generation,
      replacement,
    );
    if (committed === null) throw new Error("Cloud secret state changed concurrently.");
    return { generation: committed.generation, serialized: replacement };
  }

  async #exclusive<T>(
    operation: () => Promise<T>,
    allowDuringAccountDeletion = false,
  ): Promise<T> {
    const guarded = async (): Promise<T> => {
      await this.#deploymentAuthority.assertCurrent();
      if (!allowDuringAccountDeletion && await this.#readPendingAccountDeletion() !== null) {
        throw new Error("Cloud effects are unavailable while hosted account erasure is in progress.");
      }
      return await operation();
    };
    const current = this.#tail.catch(() => undefined).then(guarded);
    this.#tail = current;
    try {
      return await current;
    } finally {
      if (this.#tail === current) this.#tail = Promise.resolve();
    }
  }
}

export function createLocalCloudControl(options: LocalCloudControlOptions): CloudControlPort {
  return new LocalCloudControl(options);
}

export async function createLocalCloudControlFromEnvironment(
  options: LocalCloudControlEnvironmentOptions,
): Promise<LocalCloudControl | null> {
  const selection = cloudDeploymentSelectionFromEnvironment(options.environment);
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
  const deploymentCustody = new DeploymentScopedCloudSecretCustody(
    options.secretCustody,
    deploymentAuthority,
  );
  const identityCustody = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
  return new LocalCloudControl({
    deploymentAuthority,
    deploymentUrl: selection.deploymentUrl,
    ...(options.deviceLabel === undefined ? {} : { deviceLabel: options.deviceLabel }),
    ...(options.lifetimeSignal === undefined
      ? {}
      : { lifetimeSignal: options.lifetimeSignal }),
    ...(options.now === undefined ? {} : { now: options.now }),
    secretCustody: identityCustody,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });
}
