import {
  MAX_SYNC_DIRECTORY_PAGE_SIZE,
  MAX_SYNC_DEVICES,
  MAX_SYNC_LIFETIME_ROOT_KEY_EPOCHS,
  MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS,
  canonicalSessionSyncJson,
  commitSyncVaultRootKey,
  decodeSyncUint64,
  digestSyncMembershipStatement,
  digestSyncVaultRootKeyLink,
  digestSyncVaultRootWrapManifest,
  importSyncDeviceKeyPairs,
  deriveSyncRecoveryAuthority,
  generateSyncDeviceKeyCustody,
  openSyncRecoveryKit,
  positiveSyncUint64Schema,
  syncDevicePublicKeysSchema,
  syncDeviceIdSchema,
  syncMembershipHeadSchema,
  syncRecoveryAuthoritySchema,
  syncRecoveryKitSchema,
  syncSha256DigestSchema,
  syncVaultCoordinateSchema,
  unwrapSyncParentVaultRootKey,
  unwrapSyncVaultRootKey,
  verifySyncDevicePublicKeys,
  verifySyncMembershipSignature,
  wrappedSyncVaultRootKeyLinkSchema,
  wrappedSyncVaultRootKeySchema,
  verifySyncDeviceKeyCustody,
  type PositiveSyncUint64,
  type SyncDeviceKeyPairs,
  type SyncDevicePublicKeys,
  type SyncMembershipHead,
  type SyncRecoveryAuthority,
  type SyncRecoveryKit,
  type SyncSha256Digest,
  type SyncVaultCoordinate,
  type WrappedSyncVaultRootKey,
  type WrappedSyncVaultRootKeyLink,
} from "@hraness/agent-tasks-protocol";
import type { SecretStore } from "@hraness/hra-human-client";
import { z } from "@hra-internal/schema";

import { bunHumanKeychain } from "./keychain-custody";
import {
  digestSessionSyncJournalValue,
  sessionSyncOperationIdSchema,
} from "../state/session-sync-operation-journal";

export const HRA_SESSION_SYNC_KEYCHAIN_SERVICE =
  "kitchen.hraness.session-sync.v1";
export const HRA_SESSION_SYNC_KEYCHAIN_NAME = "device-vault";
export const HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME = "recovery-authority";

const privateKeyMaterialSchema = z.object({
  version: z.literal(1),
  signingPkcs8: z.string().min(128).max(512).regex(/^[A-Za-z0-9_-]+$/u),
  agreementPkcs8: z.string().min(128).max(512).regex(/^[A-Za-z0-9_-]+$/u),
}).strict();

const rootKeySchema = z.string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => isExactRootKey(value), {
    message: "invalid sync vault root key",
  });

const vaultRootKeyRecordSchema = z.object({
  keyEpoch: positiveSyncUint64Schema,
  rootKey: rootKeySchema,
}).strict();

const vaultRootKeyringRecordSchema = z.object({
  vault: syncVaultCoordinateSchema,
  membershipEpoch: positiveSyncUint64Schema,
  currentRootKeyEpoch: positiveSyncUint64Schema,
  rootKeys: z.array(vaultRootKeyRecordSchema)
    .min(1)
    .max(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
}).strict().superRefine((keyring, context) => {
  const epochs = keyring.rootKeys.map(({ keyEpoch }) => keyEpoch);
  const rootMaterials = keyring.rootKeys.map(({ rootKey }) => rootKey);
  if (new Set(epochs).size !== epochs.length) {
    context.addIssue({
      code: "custom",
      message: "sync vault root key epochs must be unique",
      path: ["rootKeys"],
    });
  }
  if (new Set(rootMaterials).size !== rootMaterials.length) {
    context.addIssue({
      code: "custom",
      message: "sync vault root key material must be fresh across epochs",
      path: ["rootKeys"],
    });
  }
  if (!epochs.includes(keyring.currentRootKeyEpoch)) {
    context.addIssue({
      code: "custom",
      message: "sync vault root keyring must include its current epoch",
      path: ["currentRootKeyEpoch"],
    });
  }
  const sorted = [...epochs].sort(compareEpochs);
  if (epochs.some((epoch, index) => epoch !== sorted[index])) {
    context.addIssue({
      code: "custom",
      message: "sync vault root key epochs must be ordered",
      path: ["rootKeys"],
    });
  }
  if (keyring.currentRootKeyEpoch !== sorted.at(-1)) {
    context.addIssue({
      code: "custom",
      message: "sync vault current root key must be the newest retained epoch",
      path: ["currentRootKeyEpoch"],
    });
  }
});

const vaultRootKeyringMetadataSchema = z.object({
  vault: syncVaultCoordinateSchema,
  membershipEpoch: positiveSyncUint64Schema,
  currentRootKeyEpoch: positiveSyncUint64Schema,
  keyEpochs: z.array(positiveSyncUint64Schema)
    .min(1)
    .max(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS),
}).strict().superRefine((keyring, context) => {
  const ordered = [...keyring.keyEpochs].sort(compareEpochs);
  if (
    new Set(keyring.keyEpochs).size !== keyring.keyEpochs.length
    || keyring.keyEpochs.some((epoch, index) => epoch !== ordered[index])
    || keyring.currentRootKeyEpoch !== ordered.at(-1)
  ) {
    context.addIssue({
      code: "custom",
      message: "sync vault root keyring metadata is invalid",
      path: ["keyEpochs"],
    });
  }
});

const legacySessionSyncKeychainRecordSchema = z.object({
  version: z.literal(1),
  publicKeys: syncDevicePublicKeysSchema,
  privateKeys: privateKeyMaterialSchema,
  vaultRootKeyring: vaultRootKeyringRecordSchema.nullable(),
}).strict();

const sessionSyncVaultPendingTransitionSchema = z.object({
  operationId: sessionSyncOperationIdSchema,
  requestDigest: syncSha256DigestSchema,
  parentMembershipDigest: syncSha256DigestSchema,
  childMembershipDigest: syncSha256DigestSchema,
  expectedVaultRootKeyringDigest: syncSha256DigestSchema,
  nextVaultRootKeyringDigest: syncSha256DigestSchema,
  nextVaultRootKeyring: vaultRootKeyringRecordSchema,
}).strict();

const sessionSyncVaultTerminalTransitionSchema = z.object({
  operationId: sessionSyncOperationIdSchema,
  requestDigest: syncSha256DigestSchema,
  parentMembershipDigest: syncSha256DigestSchema,
  childMembershipDigest: syncSha256DigestSchema,
  expectedVaultRootKeyringDigest: syncSha256DigestSchema,
  nextVaultRootKeyringDigest: syncSha256DigestSchema,
  disposition: z.enum(["promoted", "rolledBack"]),
  acceptedMembershipDigest: syncSha256DigestSchema.nullable(),
  definitiveRejectionDigest: syncSha256DigestSchema.nullable(),
}).strict().superRefine((transition, context) => {
  if (
    (transition.disposition === "promoted")
      !== (transition.acceptedMembershipDigest !== null)
    || (transition.disposition === "rolledBack")
      !== (transition.definitiveRejectionDigest !== null)
    || (
      transition.acceptedMembershipDigest !== null
      && transition.acceptedMembershipDigest !== transition.childMembershipDigest
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "sync vault terminal transition evidence is incoherent",
      path: ["disposition"],
    });
  }
});

const sessionSyncKeychainRecordSchema = z.object({
  version: z.literal(2),
  publicKeys: syncDevicePublicKeysSchema,
  privateKeys: privateKeyMaterialSchema,
  activeVaultRootKeyring: vaultRootKeyringRecordSchema.nullable(),
  pendingTransition: sessionSyncVaultPendingTransitionSchema.nullable(),
  lastTransition: sessionSyncVaultTerminalTransitionSchema.nullable(),
}).strict();

const legacySessionSyncRecoveryKeychainRecordSchema = z.object({
  version: z.literal(1),
  recoveryKit: syncRecoveryKitSchema,
}).strict();

const sessionSyncRecoveryPendingTransitionSchema = z.object({
  operationId: sessionSyncOperationIdSchema,
  expectedAuthorityDigest: syncSha256DigestSchema,
  nextAuthorityDigest: syncSha256DigestSchema,
  nextRecoveryKit: syncRecoveryKitSchema,
  requestDigest: syncSha256DigestSchema,
  parentMembershipDigest: syncSha256DigestSchema,
  childMembershipDigest: syncSha256DigestSchema,
  expiresAt: positiveSyncUint64Schema,
}).strict();

const sessionSyncRecoveryTerminalTransitionSchema = z.object({
  operationId: sessionSyncOperationIdSchema,
  requestDigest: syncSha256DigestSchema,
  expectedAuthorityDigest: syncSha256DigestSchema,
  nextAuthorityDigest: syncSha256DigestSchema,
  parentMembershipDigest: syncSha256DigestSchema,
  childMembershipDigest: syncSha256DigestSchema,
  disposition: z.enum(["promoted", "rolledBack"]),
  acceptedMembershipDigest: syncSha256DigestSchema.nullable(),
  acceptedAuthorityDigest: syncSha256DigestSchema.nullable(),
  definitiveRejectionDigest: syncSha256DigestSchema.nullable(),
}).strict().superRefine((transition, context) => {
  if (
    (transition.disposition === "promoted")
      !== (
        transition.acceptedMembershipDigest !== null
        && transition.acceptedAuthorityDigest !== null
      )
    || (transition.disposition === "rolledBack")
      !== (transition.definitiveRejectionDigest !== null)
    || (
      transition.acceptedAuthorityDigest !== null
      && transition.acceptedAuthorityDigest !== transition.nextAuthorityDigest
    )
    || (
      transition.acceptedMembershipDigest !== null
      && transition.acceptedMembershipDigest !== transition.childMembershipDigest
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "sync recovery terminal transition evidence is incoherent",
      path: ["disposition"],
    });
  }
});

const sessionSyncRecoveryKeychainRecordSchema = z.object({
  version: z.literal(2),
  activeRecoveryKit: syncRecoveryKitSchema,
  pendingTransition: sessionSyncRecoveryPendingTransitionSchema.nullable(),
  lastTransition: sessionSyncRecoveryTerminalTransitionSchema.nullable(),
}).strict();

type SessionSyncRecoveryKeychainRecord = z.infer<
  typeof sessionSyncRecoveryKeychainRecordSchema
>;

type SessionSyncKeychainRecord = z.infer<
  typeof sessionSyncKeychainRecordSchema
>;

export interface SessionSyncVaultRootKey {
  readonly keyEpoch: PositiveSyncUint64;
  readonly bytes: Uint8Array;
}

export interface SessionSyncVaultRootKeyring {
  readonly vault: SyncVaultCoordinate;
  readonly membershipEpoch: PositiveSyncUint64;
  readonly currentRootKeyEpoch: PositiveSyncUint64;
  readonly rootKeys: readonly SessionSyncVaultRootKey[];
}

export interface SessionSyncVaultRootKeyringMetadata {
  readonly vault: SyncVaultCoordinate;
  readonly membershipEpoch: PositiveSyncUint64;
  readonly currentRootKeyEpoch: PositiveSyncUint64;
  readonly keyEpochs: readonly PositiveSyncUint64[];
}

export interface SessionSyncRuntimeCustody extends SyncDeviceKeyPairs {
  readonly vaultRootKeyring: SessionSyncVaultRootKeyring | null;
}

export interface SessionSyncCustodyMetadata {
  readonly publicKeys: SyncDevicePublicKeys;
  readonly vaultRootKeyring: SessionSyncVaultRootKeyringMetadata | null;
}

export interface SessionSyncVaultPendingTransitionMetadata {
  readonly operationId: string;
  readonly requestDigest: SyncSha256Digest;
  readonly parentMembershipDigest: SyncSha256Digest;
  readonly childMembershipDigest: SyncSha256Digest;
  readonly expectedVaultRootKeyringDigest: SyncSha256Digest;
  readonly nextVaultRootKeyringDigest: SyncSha256Digest;
  readonly nextVaultRootKeyring: SessionSyncVaultRootKeyringMetadata;
}

export interface SessionSyncVaultPendingTransitionRuntime {
  readonly activeVaultRootKeyring: SessionSyncVaultRootKeyring;
  readonly nextVaultRootKeyring: SessionSyncVaultRootKeyring;
  readonly metadata: SessionSyncVaultPendingTransitionMetadata;
}

export interface SessionSyncRecoveryCustodyMetadata {
  readonly authority: SyncRecoveryAuthority;
  readonly keyEpochs: readonly PositiveSyncUint64[];
}

export interface SessionSyncRecoveryPendingTransitionMetadata {
  readonly operationId: string;
  readonly expectedAuthorityDigest: SyncSha256Digest;
  readonly nextAuthorityDigest: SyncSha256Digest;
  readonly requestDigest: SyncSha256Digest;
  readonly parentMembershipDigest: SyncSha256Digest;
  readonly childMembershipDigest: SyncSha256Digest;
  readonly expiresAt: PositiveSyncUint64;
}

export interface SessionSyncRecoveryPendingTransitionRuntime {
  readonly activeRecoveryKit: SyncRecoveryKit;
  readonly nextRecoveryKit: SyncRecoveryKit;
  readonly metadata: SessionSyncRecoveryPendingTransitionMetadata;
}

export type SessionSyncCustodyReconciliation =
  | Readonly<{ disposition: "pending" }>
  | Readonly<{ disposition: "promoted" }>
  | Readonly<{ disposition: "rolled_back" }>;

const sharedSecretStoreMutationTails = new WeakMap<object, Promise<void>>();

async function serializeSecretStoreMutation<Value>(
  secrets: SecretStore,
  operation: () => Promise<Value>,
): Promise<Value> {
  const key = secrets as object;
  const predecessor = sharedSecretStoreMutationTails.get(key)
    ?? Promise.resolve();
  let release: (() => void) | undefined;
  const successor = new Promise<void>((resolve) => {
    release = resolve;
  });
  sharedSecretStoreMutationTails.set(key, successor);
  await predecessor;
  try {
    return await operation();
  } finally {
    release?.();
    if (sharedSecretStoreMutationTails.get(key) === successor) {
      sharedSecretStoreMutationTails.delete(key);
    }
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("invalid session sync custody encoding");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new TypeError("invalid session sync custody encoding");
  }
  const bytes = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
  if (encodeBase64Url(bytes) !== value) {
    throw new TypeError("invalid session sync custody encoding");
  }
  return bytes;
}

function isExactRootKey(value: string): boolean {
  try {
    return decodeBase64Url(value).byteLength === 32;
  } catch {
    return false;
  }
}

function compareEpochs(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function parseRecord(value: string): SessionSyncKeychainRecord {
  let source: unknown;
  try {
    source = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Session sync key custody is invalid.");
  }
  const parsed = sessionSyncKeychainRecordSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const legacy = legacySessionSyncKeychainRecordSchema.safeParse(source);
  if (legacy.success) {
    return {
      version: 2,
      publicKeys: legacy.data.publicKeys,
      privateKeys: legacy.data.privateKeys,
      activeVaultRootKeyring: legacy.data.vaultRootKeyring,
      pendingTransition: null,
      lastTransition: null,
    };
  }
  throw new Error("Session sync key custody is invalid.");
}

function parseRecoveryRecord(value: string): SessionSyncRecoveryKeychainRecord {
  let source: unknown;
  try {
    source = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Session sync recovery custody is invalid.");
  }
  const parsed = sessionSyncRecoveryKeychainRecordSchema.safeParse(source);
  if (parsed.success) {
    try {
      assertFreshRecoveryRoots(parsed.data.activeRecoveryKit);
      if (parsed.data.pendingTransition !== null) {
        assertFreshRecoveryRoots(
          parsed.data.pendingTransition.nextRecoveryKit,
        );
        assertRecoveryRootsRetained(
          parsed.data.activeRecoveryKit,
          parsed.data.pendingTransition.nextRecoveryKit,
        );
      }
      return parsed.data;
    } catch {
      throw new Error("Session sync recovery custody is invalid.");
    }
  }
  const legacy = legacySessionSyncRecoveryKeychainRecordSchema.safeParse(source);
  if (legacy.success) {
    try {
      assertFreshRecoveryRoots(legacy.data.recoveryKit);
      return {
        version: 2,
        activeRecoveryKit: legacy.data.recoveryKit,
        pendingTransition: null,
        lastTransition: null,
      };
    } catch {
      throw new Error("Session sync recovery custody is invalid.");
    }
  }
  throw new Error("Session sync recovery custody is invalid.");
}

function assertFreshRecoveryRoots(recoveryKit: SyncRecoveryKit): void {
  const rootMaterials = recoveryKit.vaultRootKeys.map(({ rootKey }) => rootKey);
  if (new Set(rootMaterials).size !== rootMaterials.length) {
    throw new Error("Session sync recovery custody reuses root key material.");
  }
}

function assertRecoveryRootsRetained(
  current: SyncRecoveryKit,
  next: SyncRecoveryKit,
): void {
  const nextByEpoch = new Map(
    next.vaultRootKeys.map(({ keyEpoch, rootKey }) => [keyEpoch, rootKey]),
  );
  if (current.vaultRootKeys.some(({ keyEpoch, rootKey }) =>
    nextByEpoch.get(keyEpoch) !== rootKey
  )) {
    throw new Error(
      "Session sync recovery transition cannot discard authenticated root history.",
    );
  }
}

async function verifyRecoveryKitMetadata(
  recoveryKitValue: SyncRecoveryKit,
): Promise<SessionSyncRecoveryCustodyMetadata> {
  const recoveryKit = syncRecoveryKitSchema.parse(recoveryKitValue);
  assertFreshRecoveryRoots(recoveryKit);
  try {
    const authority = syncRecoveryAuthoritySchema.parse(
      await deriveSyncRecoveryAuthority(recoveryKit),
    );
    const opened = await openSyncRecoveryKit(recoveryKit, authority);
    try {
      return {
        authority,
        keyEpochs: recoveryKit.vaultRootKeys.map(({ keyEpoch }) => keyEpoch),
      };
    } finally {
      for (const { rootKey } of opened.vaultRootKeys) rootKey.fill(0);
    }
  } catch {
    throw new Error("Session sync recovery custody is invalid.");
  }
}

async function digestRecoveryAuthority(
  authority: SyncRecoveryAuthority,
): Promise<SyncSha256Digest> {
  const bytes = new TextEncoder().encode(canonicalSessionSyncJson(
    syncRecoveryAuthoritySchema.parse(authority),
  ));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return syncSha256DigestSchema.parse(`sha256_${hex}`);
}

function metadataFromRecord(
  record: SessionSyncKeychainRecord,
): SessionSyncCustodyMetadata {
  return {
    publicKeys: record.publicKeys,
    vaultRootKeyring: record.activeVaultRootKeyring === null
      ? null
      : {
          vault: record.activeVaultRootKeyring.vault,
          membershipEpoch: record.activeVaultRootKeyring.membershipEpoch,
          currentRootKeyEpoch:
            record.activeVaultRootKeyring.currentRootKeyEpoch,
          keyEpochs: record.activeVaultRootKeyring.rootKeys.map(
            ({ keyEpoch }) => keyEpoch,
          ),
        },
  };
}

function runtimeKeyringFromRecord(
  record: z.infer<typeof vaultRootKeyringRecordSchema>,
): SessionSyncVaultRootKeyring {
  return {
    vault: record.vault,
    membershipEpoch: record.membershipEpoch,
    currentRootKeyEpoch: record.currentRootKeyEpoch,
    rootKeys: record.rootKeys.map(({ keyEpoch, rootKey }) => ({
      keyEpoch,
      bytes: copyBytes(decodeBase64Url(rootKey)),
    })),
  };
}

function metadataFromKeyringRecord(
  record: z.infer<typeof vaultRootKeyringRecordSchema>,
): SessionSyncVaultRootKeyringMetadata {
  return {
    vault: record.vault,
    membershipEpoch: record.membershipEpoch,
    currentRootKeyEpoch: record.currentRootKeyEpoch,
    keyEpochs: record.rootKeys.map(({ keyEpoch }) => keyEpoch),
  };
}

async function digestVaultRootKeyring(
  record: z.infer<typeof vaultRootKeyringRecordSchema> | null,
): Promise<SyncSha256Digest> {
  const bytes = new TextEncoder().encode(canonicalSessionSyncJson(record));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return syncSha256DigestSchema.parse(
    `sha256_${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}

function samePublicKeys(
  left: SyncDevicePublicKeys,
  right: SyncDevicePublicKeys,
): boolean {
  return canonicalSessionSyncJson(left) === canonicalSessionSyncJson(right);
}

function sameVault(
  left: SyncVaultCoordinate,
  right: SyncVaultCoordinate,
): boolean {
  return canonicalSessionSyncJson(left) === canonicalSessionSyncJson(right);
}

function sameVaultRootMetadata(
  left: SessionSyncVaultRootKeyringMetadata | null,
  right: SessionSyncVaultRootKeyringMetadata | null,
): boolean {
  return canonicalSessionSyncJson(left) === canonicalSessionSyncJson(right);
}

function parseVaultRootMetadata(
  value: SessionSyncVaultRootKeyringMetadata | null,
): SessionSyncVaultRootKeyringMetadata | null {
  return value === null ? null : vaultRootKeyringMetadataSchema.parse(value);
}

interface VaultRootKeyringInput {
  readonly vault: SyncVaultCoordinate;
  readonly membershipEpoch: PositiveSyncUint64;
  readonly currentRootKeyEpoch: PositiveSyncUint64;
  readonly rootKeys: readonly Readonly<{
    readonly keyEpoch: PositiveSyncUint64;
    readonly rootKey: Uint8Array;
  }>[];
}

function encodedVaultRootKeyring(
  input: VaultRootKeyringInput,
): z.infer<typeof vaultRootKeyringRecordSchema> {
  const rootKeys = [...input.rootKeys].map(({ keyEpoch, rootKey }) => {
    if (rootKey.byteLength !== 32) {
      throw new TypeError("Session sync vault root must contain 32 bytes.");
    }
    return {
      keyEpoch: positiveSyncUint64Schema.parse(keyEpoch),
      rootKey: encodeBase64Url(copyBytes(rootKey)),
    };
  }).sort((left, right) => compareEpochs(left.keyEpoch, right.keyEpoch));
  if (rootKeys.length > MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS) {
    throw new TypeError("Session sync vault root keyring is too large.");
  }
  return vaultRootKeyringRecordSchema.parse({
    vault: syncVaultCoordinateSchema.parse(input.vault),
    membershipEpoch: positiveSyncUint64Schema.parse(input.membershipEpoch),
    currentRootKeyEpoch: positiveSyncUint64Schema.parse(
      input.currentRootKeyEpoch,
    ),
    rootKeys,
  });
}

function vaultFromMembershipHead(head: SyncMembershipHead): SyncVaultCoordinate {
  return syncVaultCoordinateSchema.parse({
    tenantId: head.statement.tenantId,
    organizationId: head.statement.organizationId,
    ownerUserId: head.statement.ownerUserId,
    vaultId: head.statement.vaultId,
    vaultGeneration: head.statement.vaultGeneration,
  });
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function validateSessionSyncMembershipHead(input: {
  readonly head: SyncMembershipHead;
  readonly previousHead: SyncMembershipHead | null;
  readonly expectedVault: SyncVaultCoordinate;
}): Promise<SyncMembershipHead> {
  const head = syncMembershipHeadSchema.parse(input.head);
  const previous = input.previousHead === null
    ? null
    : syncMembershipHeadSchema.parse(input.previousHead);
  const expectedVault = syncVaultCoordinateSchema.parse(input.expectedVault);
  if (!sameVault(vaultFromMembershipHead(head), expectedVault)) {
    throw new Error("Session sync membership belongs to another vault.");
  }
  if (head.statementDigest !== await digestSyncMembershipStatement(head.statement)) {
    throw new Error("Session sync membership statement digest does not match.");
  }
  const memberKeysValid = await Promise.all(
    head.statement.members.map(async ({ keys }) => await verifySyncDevicePublicKeys(keys)),
  );
  if (memberKeysValid.some((valid) => !valid)) {
    throw new Error("Session sync membership contains invalid device keys.");
  }

  let signingMembers: Map<string, SyncDevicePublicKeys>;
  let requiredSignatures: number;
  if (previous === null) {
    const active = head.statement.members.filter(({ status }) => status === "active");
    if (
      head.statement.membershipEpoch !== "1"
      || head.statement.rootKeyEpoch !== "1"
      || head.statement.previousMembershipDigest !== null
      || head.statement.members.length !== 1
      || active.length !== 1
    ) {
      throw new Error("Session sync genesis membership is invalid.");
    }
    signingMembers = new Map(active.map((member) => [member.deviceId, member.keys]));
    requiredSignatures = 1;
  } else {
    const priorRootEpoch = decodeSyncUint64(
      previous.statement.rootKeyEpoch,
    );
    const nextRootEpoch = decodeSyncUint64(head.statement.rootKeyEpoch);
    if (
      !sameVault(vaultFromMembershipHead(previous), expectedVault)
      || previous.statementDigest
        !== await digestSyncMembershipStatement(previous.statement)
      || decodeSyncUint64(head.statement.membershipEpoch)
        !== decodeSyncUint64(previous.statement.membershipEpoch) + 1n
      || head.statement.previousMembershipDigest !== previous.statementDigest
      || nextRootEpoch < priorRootEpoch
      || nextRootEpoch > priorRootEpoch + 1n
      || decodeSyncUint64(head.statement.recoveryGeneration)
        < decodeSyncUint64(previous.statement.recoveryGeneration)
      || decodeSyncUint64(head.statement.recoveryGeneration)
        > decodeSyncUint64(previous.statement.recoveryGeneration) + 1n
    ) {
      throw new Error("Session sync membership does not extend the accepted head.");
    }
    if (
      (nextRootEpoch === priorRootEpoch) !== (
        head.statement.rootKeyLinkDigest === null
        && head.statement.rootKeyCommitment
          === previous.statement.rootKeyCommitment
      )
      || (nextRootEpoch === priorRootEpoch + 1n) !== (
        head.statement.rootKeyLinkDigest !== null
        && head.statement.rootKeyCommitment
          !== previous.statement.rootKeyCommitment
      )
    ) {
      throw new Error("Session sync membership root transition is invalid.");
    }
    const priorActive = previous.statement.members.filter(
      ({ status }) => status === "active",
    );
    signingMembers = new Map(
      priorActive.map((member) => [member.deviceId, member.keys]),
    );
    requiredSignatures = Math.floor(priorActive.length / 2) + 1;
  }
  if (head.signatures.length < requiredSignatures) {
    throw new Error("Session sync membership does not have quorum.");
  }
  for (const signature of head.signatures) {
    const keys = signingMembers.get(signature.deviceId);
    if (
      keys === undefined
      || !await verifySyncMembershipSignature(head.statement, signature, keys)
    ) {
      throw new Error("Session sync membership signature is invalid.");
    }
  }
  return head;
}

export async function validateAndUnwrapSessionSyncMembershipRoots(input: {
  readonly head: SyncMembershipHead;
  readonly previousHead: SyncMembershipHead | null;
  readonly expectedVault: SyncVaultCoordinate;
  readonly expectedDeviceId: string;
  readonly expectedPublicKeys: SyncDevicePublicKeys;
  readonly agreementPrivateKey: CryptoKey;
  readonly wrappedRoots: readonly WrappedSyncVaultRootKey[];
  readonly rootWrapManifest: readonly WrappedSyncVaultRootKey[];
}): Promise<SessionSyncVaultRootKeyring> {
  const head = await validateSessionSyncMembershipHead(input);
  const expectedPublicKeys = syncDevicePublicKeysSchema.parse(
    input.expectedPublicKeys,
  );
  const expectedDeviceId = syncDeviceIdSchema.parse(input.expectedDeviceId);
  const member = head.statement.members.find(
    ({ deviceId }) => deviceId === expectedDeviceId,
  );
  if (
    member?.status !== "active"
    || !samePublicKeys(member.keys, expectedPublicKeys)
  ) {
    throw new Error("Session sync membership does not authorize this device.");
  }
  const manifest = z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_DEVICES * MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS)
    .parse(input.rootWrapManifest);
  const wrappedRoots = z.array(wrappedSyncVaultRootKeySchema)
    .min(1)
    .max(MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS)
    .parse(input.wrappedRoots);
  if (
    head.statement.rootWrapManifestDigest
      !== await digestSyncVaultRootWrapManifest(manifest)
  ) {
    throw new Error("Session sync root-wrap manifest digest does not match.");
  }
  const activeMembers = head.statement.members
    .filter(({ status }) => status === "active")
    .toSorted((left, right) => compareIdentifiers(left.deviceId, right.deviceId));
  const rootEpochs = [...new Set(manifest.map(({ context }) => context.rootKeyEpoch))]
    .sort(compareEpochs);
  if (
    rootEpochs.length === 0
    || rootEpochs.length > MAX_SYNC_RETAINED_ROOT_KEY_EPOCHS
    || rootEpochs.at(-1) !== head.statement.rootKeyEpoch
    || manifest.length !== activeMembers.length * rootEpochs.length
  ) {
    throw new Error("Session sync root-wrap manifest is incomplete.");
  }
  const expectedManifestOrder: string[] = [];
  const manifestByPair = new Map<string, WrappedSyncVaultRootKey>();
  for (const memberEntry of activeMembers) {
    for (const rootEpoch of rootEpochs) {
      expectedManifestOrder.push(`${memberEntry.deviceId}\0${rootEpoch}`);
    }
  }
  for (let index = 0; index < manifest.length; index += 1) {
    const wrap = manifest[index]!;
    const pair = `${wrap.context.recipientDeviceId}\0${wrap.context.rootKeyEpoch}`;
    const recipient = activeMembers.find(
      ({ deviceId }) => deviceId === wrap.context.recipientDeviceId,
    );
    if (
      pair !== expectedManifestOrder[index]
      || manifestByPair.has(pair)
      || recipient === undefined
      || wrap.context.recipientAgreementKeyId !== recipient.keys.agreement.keyId
      || wrap.context.membershipEpoch !== head.statement.membershipEpoch
      || !sameVault({
        tenantId: wrap.context.tenantId,
        organizationId: wrap.context.organizationId,
        ownerUserId: wrap.context.ownerUserId,
        vaultId: wrap.context.vaultId,
        vaultGeneration: wrap.context.vaultGeneration,
      }, input.expectedVault)
    ) {
      throw new Error("Session sync root-wrap manifest coordinates are invalid.");
    }
    manifestByPair.set(pair, wrap);
  }
  const roots: SessionSyncVaultRootKey[] = [];
  const commitments = new Set<string>();
  try {
    for (let index = 0; index < wrappedRoots.length; index += 1) {
      const wrap = wrappedRoots[index]!;
      const expectedEpoch = rootEpochs[index];
      const manifestWrap = manifestByPair.get(
        `${expectedDeviceId}\0${String(expectedEpoch)}`,
      );
      if (
        expectedEpoch === undefined
        || wrap.context.rootKeyEpoch !== expectedEpoch
        || wrap.context.recipientDeviceId !== expectedDeviceId
        || wrap.context.recipientAgreementKeyId
          !== expectedPublicKeys.agreement.keyId
        || manifestWrap === undefined
        || canonicalSessionSyncJson(wrap) !== canonicalSessionSyncJson(manifestWrap)
      ) {
        throw new Error("Session sync device root wraps are incomplete or reordered.");
      }
      const rootKey = await unwrapSyncVaultRootKey(
        wrap,
        wrap.context,
        input.agreementPrivateKey,
      );
      const commitment = await commitSyncVaultRootKey(rootKey);
      if (commitments.has(commitment)) {
        rootKey.fill(0);
        throw new Error("Session sync root rotation reused key material.");
      }
      commitments.add(commitment);
      roots.push({ keyEpoch: expectedEpoch, bytes: rootKey });
    }
    const currentRoot = roots.at(-1);
    if (
      wrappedRoots.length !== rootEpochs.length
      || commitments.size !== rootEpochs.length
      || currentRoot === undefined
      || await commitSyncVaultRootKey(currentRoot.bytes)
        !== head.statement.rootKeyCommitment
    ) {
      throw new Error("Session sync current root commitment does not match.");
    }
    return {
      vault: syncVaultCoordinateSchema.parse(input.expectedVault),
      membershipEpoch: head.statement.membershipEpoch,
      currentRootKeyEpoch: head.statement.rootKeyEpoch,
      rootKeys: roots,
    };
  } catch (error) {
    for (const rootKey of roots) rootKey.bytes.fill(0);
    throw error;
  }
}

export interface SessionSyncRootKeyLinkPageExchange {
  readonly request: Readonly<{
    beforeChildRootKeyEpoch?: PositiveSyncUint64;
    pageSize: number;
  }>;
  readonly response: Readonly<{
    links: readonly WrappedSyncVaultRootKeyLink[];
    hasMore: boolean;
    nextBeforeChildRootKeyEpoch?: PositiveSyncUint64;
  }>;
}

export interface SessionSyncRootKeyChainEvidence {
  readonly genesisRootKeyCommitment: SyncSha256Digest;
  readonly verifiedLinkCount: number;
}

export async function verifySessionSyncRootKeyChainToGenesis(input: {
  readonly expectedVault: SyncVaultCoordinate;
  readonly currentMembershipEpoch: PositiveSyncUint64;
  readonly currentRootKeyEpoch: PositiveSyncUint64;
  readonly currentRootKeyCommitment: SyncSha256Digest;
  readonly currentRootKeyLinkDigest: SyncSha256Digest | null;
  readonly currentRootKey: Uint8Array;
  readonly pages: readonly SessionSyncRootKeyLinkPageExchange[];
}): Promise<SessionSyncRootKeyChainEvidence> {
  const expectedVault = syncVaultCoordinateSchema.parse(input.expectedVault);
  let childEpoch = positiveSyncUint64Schema.parse(input.currentRootKeyEpoch);
  let childCommitment = syncSha256DigestSchema.parse(
    input.currentRootKeyCommitment,
  );
  const currentRootKeyLinkDigest = input.currentRootKeyLinkDigest === null
    ? null
    : syncSha256DigestSchema.parse(input.currentRootKeyLinkDigest);
  let childRoot = copyBytes(input.currentRootKey);
  if (
    childRoot.byteLength !== 32
    || await commitSyncVaultRootKey(childRoot) !== childCommitment
  ) {
    childRoot.fill(0);
    throw new Error("Session sync current root key does not match its commitment.");
  }
  let expectedCursor: PositiveSyncUint64 | undefined;
  let previousMembershipEpoch = positiveSyncUint64Schema.parse(
    input.currentMembershipEpoch,
  );
  let verifiedLinkCount = 0;
  try {
    if (childEpoch === "1") {
      if (currentRootKeyLinkDigest !== null || input.pages.length !== 0) {
        throw new Error("Session sync genesis root cannot have backward links.");
      }
      return {
        genesisRootKeyCommitment: childCommitment,
        verifiedLinkCount,
      };
    }
    if (currentRootKeyLinkDigest === null) {
      throw new Error("Session sync current root is missing its accepted backward-link digest.");
    }
    for (let pageIndex = 0; pageIndex < input.pages.length; pageIndex += 1) {
      const exchange = input.pages[pageIndex]!;
      const pageSize = z.number().int().min(1)
        .max(MAX_SYNC_DIRECTORY_PAGE_SIZE)
        .parse(exchange.request.pageSize);
      const requestedCursor = exchange.request.beforeChildRootKeyEpoch === undefined
        ? undefined
        : positiveSyncUint64Schema.parse(
            exchange.request.beforeChildRootKeyEpoch,
          );
      if (requestedCursor !== expectedCursor) {
        throw new Error("Session sync root-link page cursor is not contiguous.");
      }
      const links = z.array(wrappedSyncVaultRootKeyLinkSchema)
        .max(pageSize)
        .parse(exchange.response.links);
      const nextCursor = exchange.response.nextBeforeChildRootKeyEpoch === undefined
        ? undefined
        : positiveSyncUint64Schema.parse(
            exchange.response.nextBeforeChildRootKeyEpoch,
          );
      if (
        exchange.response.hasMore !== (nextCursor !== undefined)
        || (exchange.response.hasMore && links.length === 0)
        || (exchange.response.hasMore
          && nextCursor !== links.at(-1)?.context.childRootKeyEpoch)
      ) {
        throw new Error("Session sync root-link page continuation is invalid.");
      }
      for (const link of links) {
        if (
          link.context.childRootKeyEpoch !== childEpoch
          || (verifiedLinkCount === 0
            && link.linkDigest !== currentRootKeyLinkDigest)
          || decodeSyncUint64(link.context.parentRootKeyEpoch) + 1n
            !== decodeSyncUint64(link.context.childRootKeyEpoch)
          || (verifiedLinkCount === 0
            ? decodeSyncUint64(link.context.membershipEpoch)
              > decodeSyncUint64(previousMembershipEpoch)
            : decodeSyncUint64(link.context.membershipEpoch)
              >= decodeSyncUint64(previousMembershipEpoch))
          || link.context.childRootKeyCommitment !== childCommitment
          || !sameVault({
            tenantId: link.context.tenantId,
            organizationId: link.context.organizationId,
            ownerUserId: link.context.ownerUserId,
            vaultId: link.context.vaultId,
            vaultGeneration: link.context.vaultGeneration,
          }, expectedVault)
          || link.linkDigest !== await digestSyncVaultRootKeyLink(link)
        ) {
          throw new Error("Session sync root-key link authority is invalid.");
        }
        const parentRoot = await unwrapSyncParentVaultRootKey(
          link,
          link.context,
          childRoot,
        );
        childRoot.fill(0);
        childRoot = parentRoot;
        childEpoch = link.context.parentRootKeyEpoch;
        childCommitment = link.context.parentRootKeyCommitment;
        previousMembershipEpoch = link.context.membershipEpoch;
        verifiedLinkCount += 1;
        if (verifiedLinkCount >= MAX_SYNC_LIFETIME_ROOT_KEY_EPOCHS) {
          throw new Error("Session sync root-key link history exceeds its lifetime bound.");
        }
      }
      if (exchange.response.hasMore) {
        if (childEpoch === "1") {
          throw new Error("Session sync root-link continuation extends past genesis.");
        }
        expectedCursor = nextCursor;
        continue;
      }
      if (childEpoch !== "1" || pageIndex !== input.pages.length - 1) {
        throw new Error("Session sync root-key link history does not terminate at genesis.");
      }
      return {
        genesisRootKeyCommitment: childCommitment,
        verifiedLinkCount,
      };
    }
    throw new Error("Session sync root-key link history is incomplete.");
  } finally {
    childRoot.fill(0);
  }
}

export async function deriveSessionSyncHistoricalRootKey(input: {
  readonly expectedVault: SyncVaultCoordinate;
  readonly currentMembershipEpoch: PositiveSyncUint64;
  readonly currentRootKeyEpoch: PositiveSyncUint64;
  readonly currentRootKeyCommitment: SyncSha256Digest;
  readonly currentRootKeyLinkDigest: SyncSha256Digest | null;
  readonly currentRootKey: Uint8Array;
  readonly targetRootKeyEpoch: PositiveSyncUint64;
  readonly pages: readonly SessionSyncRootKeyLinkPageExchange[];
}): Promise<Uint8Array> {
  const target = positiveSyncUint64Schema.parse(input.targetRootKeyEpoch);
  if (BigInt(target) > BigInt(input.currentRootKeyEpoch)) {
    throw new Error("Session sync historical root target is newer than the current root.");
  }
  await verifySessionSyncRootKeyChainToGenesis(input);
  let childEpoch = positiveSyncUint64Schema.parse(input.currentRootKeyEpoch);
  let childRoot = copyBytes(input.currentRootKey);
  try {
    if (childEpoch === target) return copyBytes(childRoot);
    for (const exchange of input.pages) {
      const links = z.array(wrappedSyncVaultRootKeyLinkSchema)
        .max(MAX_SYNC_DIRECTORY_PAGE_SIZE)
        .parse(exchange.response.links);
      for (const link of links) {
        if (
          link.context.childRootKeyEpoch !== childEpoch
          || link.linkDigest !== await digestSyncVaultRootKeyLink(link)
          || await commitSyncVaultRootKey(childRoot)
            !== link.context.childRootKeyCommitment
        ) {
          throw new Error("Session sync historical root link changed after verification.");
        }
        const parentRoot = await unwrapSyncParentVaultRootKey(
          link,
          link.context,
          childRoot,
        );
        childRoot.fill(0);
        childRoot = parentRoot;
        childEpoch = link.context.parentRootKeyEpoch;
        if (childEpoch === target) return copyBytes(childRoot);
        if (BigInt(childEpoch) < BigInt(target)) {
          throw new Error("Session sync historical root chain skipped the target epoch.");
        }
      }
    }
    throw new Error("Session sync historical root chain did not contain the target epoch.");
  } finally {
    childRoot.fill(0);
  }
}

/**
 * Fixed, installation-scoped custody for session-sync private material. The
 * returned runtime private keys are always nonextractable. SQLite receives
 * only `SessionSyncCustodyMetadata` and never sees this record's PKCS8 or root
 * bytes.
 */
export class SessionSyncKeyCustody {
  readonly #secrets: SecretStore;

  constructor(options: { readonly secrets?: SecretStore } = {}) {
    this.#secrets = options.secrets ?? bunHumanKeychain;
  }

  async #readRecord(): Promise<SessionSyncKeychainRecord | null> {
    let value: string | null;
    try {
      value = await this.#secrets.get({
        service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
        name: HRA_SESSION_SYNC_KEYCHAIN_NAME,
      });
    } catch {
      throw new Error("Session sync key custody is unavailable.");
    }
    return value === null ? null : parseRecord(value);
  }

  async #writeRecord(recordValue: SessionSyncKeychainRecord): Promise<void> {
    const record = sessionSyncKeychainRecordSchema.parse(recordValue);
    const serialized = JSON.stringify(record);
    try {
      await this.#secrets.set({
        service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
        name: HRA_SESSION_SYNC_KEYCHAIN_NAME,
        value: serialized,
      });
      const readback = await this.#secrets.get({
        service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
        name: HRA_SESSION_SYNC_KEYCHAIN_NAME,
      });
      if (readback === null || canonicalSessionSyncJson(parseRecord(readback))
        !== canonicalSessionSyncJson(record)) {
        throw new Error("readback mismatch");
      }
    } catch {
      throw new Error("Session sync key custody is unavailable.");
    }
  }

  async #serialized<Value>(operation: () => Promise<Value>): Promise<Value> {
    return await serializeSecretStoreMutation(this.#secrets, operation);
  }

  async ensureDevice(): Promise<SessionSyncCustodyMetadata> {
    return await this.#serialized(async () => {
      const current = await this.#readRecord();
      if (current !== null) {
        if (!await verifySyncDeviceKeyCustody(
          current.privateKeys,
          current.publicKeys,
        )) {
          throw new Error("Session sync key custody is invalid.");
        }
        return metadataFromRecord(current);
      }

      const generated = await generateSyncDeviceKeyCustody();
      const record = sessionSyncKeychainRecordSchema.parse({
        version: 2,
        publicKeys: generated.publicKeys,
        privateKeys: generated.privateKeyMaterial,
        activeVaultRootKeyring: null,
        pendingTransition: null,
        lastTransition: null,
      });
      await this.#writeRecord(record);
      return metadataFromRecord(record);
    });
  }

  async loadRuntime(
    expectedPublicKeys?: SyncDevicePublicKeys,
  ): Promise<SessionSyncRuntimeCustody> {
    const record = await this.#readRecord();
    if (record === null) {
      throw new Error("Session sync key custody is missing.");
    }
    if (
      expectedPublicKeys !== undefined &&
      !samePublicKeys(
        record.publicKeys,
        syncDevicePublicKeysSchema.parse(expectedPublicKeys),
      )
    ) {
      throw new Error("Session sync key custody does not match this device.");
    }
    let keyPairs: SyncDeviceKeyPairs;
    try {
      keyPairs = await importSyncDeviceKeyPairs(
        record.privateKeys,
        record.publicKeys,
      );
    } catch {
      throw new Error("Session sync key custody is invalid.");
    }
    return {
      ...keyPairs,
      vaultRootKeyring: record.activeVaultRootKeyring === null
        ? null
        : runtimeKeyringFromRecord(record.activeVaultRootKeyring),
    };
  }

  async installVaultRootKeyring(input: {
    readonly expectedPublicKeys: SyncDevicePublicKeys;
    readonly expectedVaultRootKeyring:
      | SessionSyncVaultRootKeyringMetadata
      | null;
    readonly vault: SyncVaultCoordinate;
    readonly membershipEpoch: PositiveSyncUint64;
    readonly currentRootKeyEpoch: PositiveSyncUint64;
    readonly rootKeys: readonly Readonly<{
      readonly keyEpoch: PositiveSyncUint64;
      readonly rootKey: Uint8Array;
    }>[];
  }): Promise<SessionSyncCustodyMetadata> {
    return await this.#serialized(async () => {
      const record = await this.#readRecord();
      if (record === null) {
        throw new Error("Session sync key custody is missing.");
      }
      const expectedPublicKeys = syncDevicePublicKeysSchema.parse(
        input.expectedPublicKeys,
      );
      if (!samePublicKeys(record.publicKeys, expectedPublicKeys)) {
        throw new Error("Session sync key custody does not match this device.");
      }
      const currentMetadata = metadataFromRecord(record).vaultRootKeyring;
      const expectedMetadata = parseVaultRootMetadata(
        input.expectedVaultRootKeyring,
      );
      if (!sameVaultRootMetadata(
        currentMetadata,
        expectedMetadata,
      )) {
        throw new Error("Session sync vault root changed concurrently.");
      }
      const nextKeyring = encodedVaultRootKeyring(input);
      const vault = nextKeyring.vault;
      if (
        record.activeVaultRootKeyring !== null &&
        !sameVault(record.activeVaultRootKeyring.vault, vault)
      ) {
        throw new Error("Session sync vault replacement requires explicit removal.");
      }
      const membershipEpoch = nextKeyring.membershipEpoch;
      const currentRootKeyEpoch = nextKeyring.currentRootKeyEpoch;
      if (
        currentMetadata !== null
        && (
          BigInt(membershipEpoch) < BigInt(currentMetadata.membershipEpoch)
          || BigInt(currentRootKeyEpoch)
            < BigInt(currentMetadata.currentRootKeyEpoch)
        )
      ) {
        throw new Error("Session sync vault root keyring cannot roll back.");
      }
      const next = sessionSyncKeychainRecordSchema.parse({
        ...record,
        activeVaultRootKeyring: nextKeyring,
      });
      const nextMetadata = metadataFromRecord(next).vaultRootKeyring;
      if (
        currentMetadata !== null
        && sameVaultRootMetadata(currentMetadata, nextMetadata)
      ) {
        if (
          canonicalSessionSyncJson(record.activeVaultRootKeyring)
          !== canonicalSessionSyncJson(next.activeVaultRootKeyring)
        ) {
          throw new Error(
            "Session sync vault root keyring conflicts with installed keys.",
          );
        }
        return metadataFromRecord(record);
      }
      if (currentMetadata !== null) {
        throw new Error(
          "Session sync vault root transition must be prepared before server acceptance.",
        );
      }
      await this.#writeRecord(next);
      return metadataFromRecord(next);
    });
  }

  async pendingVaultRootTransitionMetadata(): Promise<
    SessionSyncVaultPendingTransitionMetadata | null
  > {
    const pending = (await this.#readRecord())?.pendingTransition ?? null;
    return pending === null ? null : {
      operationId: pending.operationId,
      requestDigest: pending.requestDigest,
      parentMembershipDigest: pending.parentMembershipDigest,
      childMembershipDigest: pending.childMembershipDigest,
      expectedVaultRootKeyringDigest: pending.expectedVaultRootKeyringDigest,
      nextVaultRootKeyringDigest: pending.nextVaultRootKeyringDigest,
      nextVaultRootKeyring: metadataFromKeyringRecord(
        pending.nextVaultRootKeyring,
      ),
    };
  }

  async prepareVaultRootTransition(input: {
    readonly operationId: string;
    readonly request: unknown;
    readonly requestDigest: SyncSha256Digest;
    readonly parentMembershipDigest: SyncSha256Digest;
    readonly childMembershipDigest: SyncSha256Digest;
    readonly expectedPublicKeys: SyncDevicePublicKeys;
    readonly expectedVaultRootKeyring: SessionSyncVaultRootKeyringMetadata;
    readonly next: VaultRootKeyringInput;
    readonly authenticatedRootHistory?: Readonly<{
      readonly head: SyncMembershipHead;
      readonly pages: readonly SessionSyncRootKeyLinkPageExchange[];
    }>;
  }): Promise<SessionSyncVaultPendingTransitionMetadata> {
    return await this.#serialized(async () => {
      const record = await this.#readRecord();
      if (record?.activeVaultRootKeyring === null || record === null) {
        throw new Error("Session sync vault root custody is missing.");
      }
      if (!samePublicKeys(
        record.publicKeys,
        syncDevicePublicKeysSchema.parse(input.expectedPublicKeys),
      )) {
        throw new Error("Session sync key custody does not match this device.");
      }
      const expectedMetadata = parseVaultRootMetadata(
        input.expectedVaultRootKeyring,
      );
      const currentMetadata = metadataFromKeyringRecord(
        record.activeVaultRootKeyring,
      );
      if (!sameVaultRootMetadata(currentMetadata, expectedMetadata)) {
        throw new Error("Session sync vault root changed concurrently.");
      }
      const next = encodedVaultRootKeyring(input.next);
      if (!sameVault(record.activeVaultRootKeyring.vault, next.vault)) {
        throw new Error("Session sync vault replacement requires explicit removal.");
      }
      if (
        BigInt(next.membershipEpoch)
          !== BigInt(currentMetadata.membershipEpoch) + 1n
        || BigInt(next.currentRootKeyEpoch)
          < BigInt(currentMetadata.currentRootKeyEpoch)
        || BigInt(next.currentRootKeyEpoch)
          > BigInt(currentMetadata.currentRootKeyEpoch) + 1n
      ) {
        throw new Error(
          "Session sync vault root transition must advance exactly one accepted membership step.",
        );
      }
      const nextRootsByEpoch = new Map(
        next.rootKeys.map(({ keyEpoch, rootKey }) => [keyEpoch, rootKey]),
      );
      const discardedRoots = record.activeVaultRootKeyring.rootKeys.filter(
        ({ keyEpoch }) => !nextRootsByEpoch.has(keyEpoch),
      );
      const conflictingRetainedRoot = record.activeVaultRootKeyring.rootKeys
        .some(({ keyEpoch, rootKey }) => {
          const retained = nextRootsByEpoch.get(keyEpoch);
          return retained !== undefined && retained !== rootKey;
        });
      if (conflictingRetainedRoot) {
        throw new Error(
          "Session sync vault root transition conflicts with authenticated root history.",
        );
      }
      const parentMembershipDigest = syncSha256DigestSchema.parse(
        input.parentMembershipDigest,
      );
      const childMembershipDigest = syncSha256DigestSchema.parse(
        input.childMembershipDigest,
      );
      if (parentMembershipDigest === childMembershipDigest) {
        throw new TypeError("Session sync membership transition digest must advance.");
      }
      if (discardedRoots.length > 0) {
        const evidence = input.authenticatedRootHistory;
        if (evidence === undefined) {
          throw new Error(
            "Session sync vault root transition cannot discard history without authenticated compaction evidence.",
          );
        }
        const head = syncMembershipHeadSchema.parse(evidence.head);
        const statementDigest = await digestSyncMembershipStatement(
          head.statement,
        );
        const nextCurrentRoot = next.rootKeys.find(
          ({ keyEpoch }) => keyEpoch === next.currentRootKeyEpoch,
        );
        if (
          nextCurrentRoot === undefined
          || head.statementDigest !== statementDigest
          || head.statementDigest !== childMembershipDigest
          || !sameVault(vaultFromMembershipHead(head), next.vault)
          || head.statement.membershipEpoch !== next.membershipEpoch
          || head.statement.rootKeyEpoch !== next.currentRootKeyEpoch
        ) {
          throw new Error(
            "Session sync vault root compaction evidence does not match the accepted next membership.",
          );
        }
        await verifySessionSyncRootKeyChainToGenesis({
          expectedVault: next.vault,
          currentMembershipEpoch: head.statement.membershipEpoch,
          currentRootKeyEpoch: head.statement.rootKeyEpoch,
          currentRootKeyCommitment: head.statement.rootKeyCommitment,
          currentRootKeyLinkDigest: head.statement.rootKeyLinkDigest,
          currentRootKey: decodeBase64Url(nextCurrentRoot.rootKey),
          pages: evidence.pages,
        });
      }
      const requestDigest = digestSessionSyncJournalValue(input.request);
      if (requestDigest !== syncSha256DigestSchema.parse(input.requestDigest)) {
        throw new TypeError(
          "Session sync vault transition request digest does not match its canonical request.",
        );
      }
      const pending = sessionSyncVaultPendingTransitionSchema.parse({
        operationId: sessionSyncOperationIdSchema.parse(input.operationId),
        requestDigest,
        parentMembershipDigest,
        childMembershipDigest,
        expectedVaultRootKeyringDigest: await digestVaultRootKeyring(
          record.activeVaultRootKeyring,
        ),
        nextVaultRootKeyringDigest: await digestVaultRootKeyring(next),
        nextVaultRootKeyring: next,
      });
      if (record.pendingTransition !== null) {
        if (
          canonicalSessionSyncJson(record.pendingTransition)
            !== canonicalSessionSyncJson(pending)
        ) {
          throw new Error("Session sync vault root transition is already pending.");
        }
        const replay = await this.pendingVaultRootTransitionMetadata();
        if (replay === null) {
          throw new Error("Session sync vault root transition is missing.");
        }
        return replay;
      }
      if (record.lastTransition?.operationId === pending.operationId) {
        throw new Error("Session sync vault root transition operation is terminal.");
      }
      await this.#writeRecord({ ...record, pendingTransition: pending });
      return {
        operationId: pending.operationId,
        requestDigest: pending.requestDigest,
        parentMembershipDigest: pending.parentMembershipDigest,
        childMembershipDigest: pending.childMembershipDigest,
        expectedVaultRootKeyringDigest:
          pending.expectedVaultRootKeyringDigest,
        nextVaultRootKeyringDigest: pending.nextVaultRootKeyringDigest,
        nextVaultRootKeyring: metadataFromKeyringRecord(next),
      };
    });
  }

  async loadPendingVaultRootTransition(input: {
    readonly operationId: string;
    readonly requestDigest: SyncSha256Digest;
  }): Promise<SessionSyncVaultPendingTransitionRuntime> {
    const record = await this.#readRecord();
    const pending = record?.pendingTransition ?? null;
    const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
    const requestDigest = syncSha256DigestSchema.parse(input.requestDigest);
    if (
      record?.activeVaultRootKeyring === null
      || record === null
      || pending === null
      || pending.operationId !== operationId
      || pending.requestDigest !== requestDigest
    ) {
      throw new Error("Session sync vault root transition is missing.");
    }
    return {
      activeVaultRootKeyring: runtimeKeyringFromRecord(
        record.activeVaultRootKeyring,
      ),
      nextVaultRootKeyring: runtimeKeyringFromRecord(
        pending.nextVaultRootKeyring,
      ),
      metadata: {
        operationId: pending.operationId,
        requestDigest: pending.requestDigest,
        parentMembershipDigest: pending.parentMembershipDigest,
        childMembershipDigest: pending.childMembershipDigest,
        expectedVaultRootKeyringDigest:
          pending.expectedVaultRootKeyringDigest,
        nextVaultRootKeyringDigest: pending.nextVaultRootKeyringDigest,
        nextVaultRootKeyring: metadataFromKeyringRecord(
          pending.nextVaultRootKeyring,
        ),
      },
    };
  }

  async promoteVaultRootTransition(input: {
    readonly operationId: string;
    readonly requestDigest: SyncSha256Digest;
    readonly acceptedMembershipDigest: SyncSha256Digest;
  }): Promise<SessionSyncCustodyMetadata> {
    return await this.#serialized(async () => {
      const record = await this.#readRecord();
      if (record === null) throw new Error("Session sync key custody is missing.");
      const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
      const requestDigest = syncSha256DigestSchema.parse(input.requestDigest);
      const acceptedDigest = syncSha256DigestSchema.parse(
        input.acceptedMembershipDigest,
      );
      const pending = record.pendingTransition;
      if (pending === null) {
        if (
          record.lastTransition?.operationId === operationId
          && record.lastTransition.requestDigest === requestDigest
          && record.lastTransition.childMembershipDigest === acceptedDigest
          && record.lastTransition.acceptedMembershipDigest === acceptedDigest
          && record.lastTransition.disposition === "promoted"
        ) return metadataFromRecord(record);
        throw new Error("Session sync vault root transition is missing.");
      }
      if (
        pending.operationId !== operationId
        || pending.requestDigest !== requestDigest
        || pending.childMembershipDigest !== acceptedDigest
        || await digestVaultRootKeyring(record.activeVaultRootKeyring)
          !== pending.expectedVaultRootKeyringDigest
      ) {
        throw new Error("Session sync vault root transition changed concurrently.");
      }
      await this.#writeRecord({
        ...record,
        activeVaultRootKeyring: pending.nextVaultRootKeyring,
        pendingTransition: null,
        lastTransition: {
          operationId,
          requestDigest,
          parentMembershipDigest: pending.parentMembershipDigest,
          childMembershipDigest: pending.childMembershipDigest,
          expectedVaultRootKeyringDigest:
            pending.expectedVaultRootKeyringDigest,
          nextVaultRootKeyringDigest: pending.nextVaultRootKeyringDigest,
          disposition: "promoted",
          acceptedMembershipDigest: acceptedDigest,
          definitiveRejectionDigest: null,
        },
      });
      return metadataFromRecord({
        ...record,
        activeVaultRootKeyring: pending.nextVaultRootKeyring,
      });
    });
  }

  async rollbackVaultRootTransition(input: {
    readonly operationId: string;
    readonly requestDigest: SyncSha256Digest;
    readonly observedMembershipDigest: SyncSha256Digest;
    readonly definitiveRejectionDigest: SyncSha256Digest;
  }): Promise<SessionSyncCustodyMetadata> {
    return await this.#serialized(async () => {
      const record = await this.#readRecord();
      if (record === null) throw new Error("Session sync key custody is missing.");
      const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
      const requestDigest = syncSha256DigestSchema.parse(input.requestDigest);
      const observedMembershipDigest = syncSha256DigestSchema.parse(
        input.observedMembershipDigest,
      );
      const definitiveRejectionDigest = syncSha256DigestSchema.parse(
        input.definitiveRejectionDigest,
      );
      const pending = record.pendingTransition;
      if (pending === null) {
        if (
          record.lastTransition?.operationId === operationId
          && record.lastTransition.requestDigest === requestDigest
          && record.lastTransition.parentMembershipDigest
            === observedMembershipDigest
          && record.lastTransition.definitiveRejectionDigest
            === definitiveRejectionDigest
          && record.lastTransition.disposition === "rolledBack"
        ) return metadataFromRecord(record);
        throw new Error("Session sync vault root transition is missing.");
      }
      if (
        pending.operationId !== operationId
        || pending.requestDigest !== requestDigest
        || pending.parentMembershipDigest !== observedMembershipDigest
        || await digestVaultRootKeyring(record.activeVaultRootKeyring)
          !== pending.expectedVaultRootKeyringDigest
      ) {
        throw new Error("Session sync vault root transition changed concurrently.");
      }
      await this.#writeRecord({
        ...record,
        pendingTransition: null,
        lastTransition: {
          operationId,
          requestDigest,
          parentMembershipDigest: pending.parentMembershipDigest,
          childMembershipDigest: pending.childMembershipDigest,
          expectedVaultRootKeyringDigest:
            pending.expectedVaultRootKeyringDigest,
          nextVaultRootKeyringDigest: pending.nextVaultRootKeyringDigest,
          disposition: "rolledBack",
          acceptedMembershipDigest: null,
          definitiveRejectionDigest,
        },
      });
      return metadataFromRecord(record);
    });
  }

  async reconcileVaultRootTransition(input: {
    readonly operationId: string;
    readonly requestDigest: SyncSha256Digest;
    readonly observedMembershipDigest: SyncSha256Digest;
    readonly definitiveRejectionDigest?: SyncSha256Digest;
  }): Promise<SessionSyncCustodyReconciliation> {
    const pending = await this.pendingVaultRootTransitionMetadata();
    const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
    const requestDigest = syncSha256DigestSchema.parse(input.requestDigest);
    const observedMembershipDigest = syncSha256DigestSchema.parse(
      input.observedMembershipDigest,
    );
    if (
      pending === null
      || pending.operationId !== operationId
      || pending.requestDigest !== requestDigest
    ) {
      throw new Error("Session sync vault root transition is missing.");
    }
    if (observedMembershipDigest === pending.childMembershipDigest) {
      await this.promoteVaultRootTransition({
        operationId,
        requestDigest,
        acceptedMembershipDigest: observedMembershipDigest,
      });
      return { disposition: "promoted" };
    }
    if (observedMembershipDigest !== pending.parentMembershipDigest) {
      throw new Error("Session sync vault root transition diverged from its authority chain.");
    }
    if (input.definitiveRejectionDigest === undefined) {
      return { disposition: "pending" };
    }
    await this.rollbackVaultRootTransition({
      operationId,
      requestDigest,
      observedMembershipDigest,
      definitiveRejectionDigest: input.definitiveRejectionDigest,
    });
    return { disposition: "rolled_back" };
  }

  async clearVaultRootKeyring(input: {
    readonly expectedVaultRootKeyring: SessionSyncVaultRootKeyringMetadata;
  }): Promise<boolean> {
    return await this.#serialized(async () => {
      const record = await this.#readRecord();
      if (record?.activeVaultRootKeyring === null || record === null) return false;
      if (!sameVaultRootMetadata(
        metadataFromRecord(record).vaultRootKeyring,
        parseVaultRootMetadata(input.expectedVaultRootKeyring),
      )) {
        return false;
      }
      if (record.pendingTransition !== null) {
        throw new Error("Session sync vault root transition is pending.");
      }
      await this.#writeRecord({ ...record, activeVaultRootKeyring: null });
      return true;
    });
  }

  async clearAll(): Promise<void> {
    await this.#serialized(async () => {
      try {
        await this.#secrets.delete({
          service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
          name: HRA_SESSION_SYNC_KEYCHAIN_NAME,
        });
        await this.#secrets.delete({
          service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
          name: HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
        });
      } catch {
        throw new Error("Session sync key custody is unavailable.");
      }
    });
  }
}

/**
 * Recovery authority custody is a distinct Keychain item. Callers receive the
 * sensitive kit only from `loadForExplicitReveal`; metadata and ordinary sync
 * paths never contain its PKCS8 or vault roots.
 */
export class SessionSyncRecoveryKeyCustody {
  readonly #secrets: SecretStore;

  constructor(options: { readonly secrets?: SecretStore } = {}) {
    this.#secrets = options.secrets ?? bunHumanKeychain;
  }

  async #serialized<Value>(operation: () => Promise<Value>): Promise<Value> {
    return await serializeSecretStoreMutation(this.#secrets, operation);
  }

  async #read(): Promise<SessionSyncRecoveryKeychainRecord | null> {
    let value: string | null;
    try {
      value = await this.#secrets.get({
        service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
        name: HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
      });
    } catch {
      throw new Error("Session sync recovery custody is unavailable.");
    }
    if (value === null) return null;
    const record = parseRecoveryRecord(value);
    await verifyRecoveryKitMetadata(record.activeRecoveryKit);
    if (record.pendingTransition !== null) {
      await verifyRecoveryKitMetadata(record.pendingTransition.nextRecoveryKit);
    }
    return record;
  }

  async #write(recordValue: SessionSyncRecoveryKeychainRecord): Promise<void> {
    const record = sessionSyncRecoveryKeychainRecordSchema.parse(recordValue);
    const serialized = JSON.stringify(record);
    try {
      await this.#secrets.set({
        service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
        name: HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
        value: serialized,
      });
      const readback = await this.#secrets.get({
        service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
        name: HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
      });
      if (
        readback === null
        || canonicalSessionSyncJson(parseRecoveryRecord(readback))
          !== canonicalSessionSyncJson(record)
      ) throw new Error("readback mismatch");
    } catch {
      throw new Error("Session sync recovery custody is unavailable.");
    }
  }

  async #metadata(recoveryKit: SyncRecoveryKit): Promise<SessionSyncRecoveryCustodyMetadata> {
    return await verifyRecoveryKitMetadata(recoveryKit);
  }

  async installInitial(
    recoveryKitValue: SyncRecoveryKit,
  ): Promise<SessionSyncRecoveryCustodyMetadata> {
    const recoveryKit = syncRecoveryKitSchema.parse(recoveryKitValue);
    return await this.#serialized(async () => {
      const current = await this.#read();
      if (current !== null) {
        if (
          canonicalSessionSyncJson(current.activeRecoveryKit)
            !== canonicalSessionSyncJson(recoveryKit)
        ) {
          throw new Error("Session sync recovery authority is already installed.");
        }
        return await this.#metadata(current.activeRecoveryKit);
      }
      const metadata = await this.#metadata(recoveryKit);
      await this.#write({
        version: 2,
        activeRecoveryKit: recoveryKit,
        pendingTransition: null,
        lastTransition: null,
      });
      return metadata;
    });
  }

  async metadata(): Promise<SessionSyncRecoveryCustodyMetadata | null> {
    const current = await this.#read();
    return current === null ? null : await this.#metadata(current.activeRecoveryKit);
  }

  async pendingTransitionMetadata(): Promise<
    SessionSyncRecoveryPendingTransitionMetadata | null
  > {
    const pending = (await this.#read())?.pendingTransition ?? null;
    return pending === null ? null : {
      operationId: pending.operationId,
      expectedAuthorityDigest: pending.expectedAuthorityDigest,
      nextAuthorityDigest: pending.nextAuthorityDigest,
      requestDigest: pending.requestDigest,
      parentMembershipDigest: pending.parentMembershipDigest,
      childMembershipDigest: pending.childMembershipDigest,
      expiresAt: pending.expiresAt,
    };
  }

  async loadForExplicitReveal(
    expectedAuthorityValue: SyncRecoveryAuthority,
  ): Promise<SyncRecoveryKit> {
    const current = await this.#read();
    if (current === null) {
      throw new Error("Session sync recovery custody is missing.");
    }
    const expectedAuthority = syncRecoveryAuthoritySchema.parse(
      expectedAuthorityValue,
    );
    const metadata = await this.#metadata(current.activeRecoveryKit);
    if (
      canonicalSessionSyncJson(metadata.authority)
      !== canonicalSessionSyncJson(expectedAuthority)
    ) {
      throw new Error("Session sync recovery custody does not match this vault.");
    }
    return structuredClone(current.activeRecoveryKit);
  }

  async prepareRecoveryTransition(input: {
    readonly operationId: string;
    readonly request: unknown;
    readonly expectedAuthority: SyncRecoveryAuthority;
    readonly nextRecoveryKit: SyncRecoveryKit;
    readonly requestDigest: SyncSha256Digest;
    readonly parentMembershipDigest: SyncSha256Digest;
    readonly childMembershipDigest: SyncSha256Digest;
    readonly expiresAt: PositiveSyncUint64;
  }): Promise<SessionSyncRecoveryPendingTransitionMetadata> {
    return await this.#serialized(async () => {
      const current = await this.#read();
      if (current === null) {
        throw new Error("Session sync recovery custody is missing.");
      }
      const currentMetadata = await this.#metadata(current.activeRecoveryKit);
      const expectedAuthority = syncRecoveryAuthoritySchema.parse(
        input.expectedAuthority,
      );
      if (
        canonicalSessionSyncJson(currentMetadata.authority)
        !== canonicalSessionSyncJson(expectedAuthority)
      ) {
        throw new Error("Session sync recovery authority changed concurrently.");
      }
      const next = syncRecoveryKitSchema.parse(input.nextRecoveryKit);
      assertFreshRecoveryRoots(next);
      assertRecoveryRootsRetained(current.activeRecoveryKit, next);
      const nextMetadata = await this.#metadata(next);
      if (
        canonicalSessionSyncJson(currentMetadata.authority.vault)
          !== canonicalSessionSyncJson(nextMetadata.authority.vault)
        || BigInt(nextMetadata.authority.recoveryGeneration)
          !== BigInt(currentMetadata.authority.recoveryGeneration) + 1n
      ) {
        throw new Error("Session sync recovery authority transition is invalid.");
      }
      const requestDigest = digestSessionSyncJournalValue(input.request);
      if (requestDigest !== syncSha256DigestSchema.parse(input.requestDigest)) {
        throw new TypeError(
          "Session sync recovery transition request digest does not match its canonical request.",
        );
      }
      const parentMembershipDigest = syncSha256DigestSchema.parse(
        input.parentMembershipDigest,
      );
      const childMembershipDigest = syncSha256DigestSchema.parse(
        input.childMembershipDigest,
      );
      if (parentMembershipDigest === childMembershipDigest) {
        throw new TypeError("Session sync recovery membership digest must advance.");
      }
      const pending = sessionSyncRecoveryPendingTransitionSchema.parse({
        operationId: sessionSyncOperationIdSchema.parse(input.operationId),
        expectedAuthorityDigest: await digestRecoveryAuthority(expectedAuthority),
        nextAuthorityDigest: await digestRecoveryAuthority(nextMetadata.authority),
        nextRecoveryKit: next,
        requestDigest,
        parentMembershipDigest,
        childMembershipDigest,
        expiresAt: positiveSyncUint64Schema.parse(input.expiresAt),
      });
      if (current.pendingTransition !== null) {
        if (
          canonicalSessionSyncJson(current.pendingTransition)
            !== canonicalSessionSyncJson(pending)
        ) {
          throw new Error("Session sync recovery transition is already pending.");
        }
        return {
          operationId: pending.operationId,
          expectedAuthorityDigest: pending.expectedAuthorityDigest,
          nextAuthorityDigest: pending.nextAuthorityDigest,
          requestDigest: pending.requestDigest,
          parentMembershipDigest: pending.parentMembershipDigest,
          childMembershipDigest: pending.childMembershipDigest,
          expiresAt: pending.expiresAt,
        };
      }
      if (current.lastTransition?.operationId === pending.operationId) {
        throw new Error("Session sync recovery transition operation is terminal.");
      }
      await this.#write({ ...current, pendingTransition: pending });
      return {
        operationId: pending.operationId,
        expectedAuthorityDigest: pending.expectedAuthorityDigest,
        nextAuthorityDigest: pending.nextAuthorityDigest,
        requestDigest: pending.requestDigest,
        parentMembershipDigest: pending.parentMembershipDigest,
        childMembershipDigest: pending.childMembershipDigest,
        expiresAt: pending.expiresAt,
      };
    });
  }

  async loadPendingTransition(input: {
    readonly operationId: string;
    readonly requestDigest: SyncSha256Digest;
  }): Promise<SessionSyncRecoveryPendingTransitionRuntime> {
    const current = await this.#read();
    const pending = current?.pendingTransition ?? null;
    if (
      current === null
      || pending === null
      || pending.operationId !== sessionSyncOperationIdSchema.parse(input.operationId)
      || pending.requestDigest !== syncSha256DigestSchema.parse(input.requestDigest)
    ) {
      throw new Error("Session sync recovery transition is missing.");
    }
    return {
      activeRecoveryKit: structuredClone(current.activeRecoveryKit),
      nextRecoveryKit: structuredClone(pending.nextRecoveryKit),
      metadata: {
        operationId: pending.operationId,
        expectedAuthorityDigest: pending.expectedAuthorityDigest,
        nextAuthorityDigest: pending.nextAuthorityDigest,
        requestDigest: pending.requestDigest,
        parentMembershipDigest: pending.parentMembershipDigest,
        childMembershipDigest: pending.childMembershipDigest,
        expiresAt: pending.expiresAt,
      },
    };
  }

  async promoteRecoveryTransition(input: {
    readonly operationId: string;
    readonly requestDigest: SyncSha256Digest;
    readonly acceptedMembershipDigest: SyncSha256Digest;
    readonly acceptedAuthorityDigest: SyncSha256Digest;
  }): Promise<SessionSyncRecoveryCustodyMetadata> {
    return await this.#serialized(async () => {
      const current = await this.#read();
      if (current === null) {
        throw new Error("Session sync recovery custody is missing.");
      }
      const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
      const requestDigest = syncSha256DigestSchema.parse(input.requestDigest);
      const acceptedMembershipDigest = syncSha256DigestSchema.parse(
        input.acceptedMembershipDigest,
      );
      const acceptedAuthorityDigest = syncSha256DigestSchema.parse(
        input.acceptedAuthorityDigest,
      );
      const pending = current.pendingTransition;
      if (pending === null) {
        if (
          current.lastTransition?.operationId === operationId
          && current.lastTransition.requestDigest === requestDigest
          && current.lastTransition.acceptedMembershipDigest
            === acceptedMembershipDigest
          && current.lastTransition.acceptedAuthorityDigest
            === acceptedAuthorityDigest
          && current.lastTransition.disposition === "promoted"
        ) return await this.#metadata(current.activeRecoveryKit);
        throw new Error("Session sync recovery transition is missing.");
      }
      const activeAuthorityDigest = await digestRecoveryAuthority(
        (await this.#metadata(current.activeRecoveryKit)).authority,
      );
      if (
        pending.operationId !== operationId
        || pending.requestDigest !== requestDigest
        || pending.childMembershipDigest !== acceptedMembershipDigest
        || pending.nextAuthorityDigest !== acceptedAuthorityDigest
        || pending.expectedAuthorityDigest !== activeAuthorityDigest
      ) {
        throw new Error("Session sync recovery transition changed concurrently.");
      }
      const terminal = sessionSyncRecoveryTerminalTransitionSchema.parse({
        operationId,
        requestDigest,
        expectedAuthorityDigest: pending.expectedAuthorityDigest,
        nextAuthorityDigest: pending.nextAuthorityDigest,
        parentMembershipDigest: pending.parentMembershipDigest,
        childMembershipDigest: pending.childMembershipDigest,
        disposition: "promoted",
        acceptedMembershipDigest,
        acceptedAuthorityDigest,
        definitiveRejectionDigest: null,
      });
      await this.#write({
        ...current,
        activeRecoveryKit: pending.nextRecoveryKit,
        pendingTransition: null,
        lastTransition: terminal,
      });
      return await this.#metadata(pending.nextRecoveryKit);
    });
  }

  async rollbackRecoveryTransition(input: {
    readonly operationId: string;
    readonly requestDigest: SyncSha256Digest;
    readonly observedMembershipDigest: SyncSha256Digest;
    readonly observedAuthorityDigest: SyncSha256Digest;
    readonly definitiveRejectionDigest: SyncSha256Digest;
  }): Promise<SessionSyncRecoveryCustodyMetadata> {
    return await this.#serialized(async () => {
      const current = await this.#read();
      if (current === null) {
        throw new Error("Session sync recovery custody is missing.");
      }
      const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
      const requestDigest = syncSha256DigestSchema.parse(input.requestDigest);
      const observedMembershipDigest = syncSha256DigestSchema.parse(
        input.observedMembershipDigest,
      );
      const observedAuthorityDigest = syncSha256DigestSchema.parse(
        input.observedAuthorityDigest,
      );
      const definitiveRejectionDigest = syncSha256DigestSchema.parse(
        input.definitiveRejectionDigest,
      );
      const pending = current.pendingTransition;
      if (pending === null) {
        if (
          current.lastTransition?.operationId === operationId
          && current.lastTransition.requestDigest === requestDigest
          && current.lastTransition.parentMembershipDigest
            === observedMembershipDigest
          && current.lastTransition.expectedAuthorityDigest
            === observedAuthorityDigest
          && current.lastTransition.definitiveRejectionDigest
            === definitiveRejectionDigest
          && current.lastTransition.disposition === "rolledBack"
        ) return await this.#metadata(current.activeRecoveryKit);
        throw new Error("Session sync recovery transition is missing.");
      }
      const activeAuthorityDigest = await digestRecoveryAuthority(
        (await this.#metadata(current.activeRecoveryKit)).authority,
      );
      if (
        pending.operationId !== operationId
        || pending.requestDigest !== requestDigest
        || pending.parentMembershipDigest !== observedMembershipDigest
        || pending.expectedAuthorityDigest !== observedAuthorityDigest
        || pending.expectedAuthorityDigest !== activeAuthorityDigest
      ) {
        throw new Error("Session sync recovery transition changed concurrently.");
      }
      await this.#write({
        ...current,
        pendingTransition: null,
        lastTransition: {
          operationId,
          requestDigest,
          expectedAuthorityDigest: pending.expectedAuthorityDigest,
          nextAuthorityDigest: pending.nextAuthorityDigest,
          parentMembershipDigest: pending.parentMembershipDigest,
          childMembershipDigest: pending.childMembershipDigest,
          disposition: "rolledBack",
          acceptedMembershipDigest: null,
          acceptedAuthorityDigest: null,
          definitiveRejectionDigest,
        },
      });
      return await this.#metadata(current.activeRecoveryKit);
    });
  }

  async reconcileRecoveryTransition(input: {
    readonly operationId: string;
    readonly requestDigest: SyncSha256Digest;
    readonly observedMembershipDigest: SyncSha256Digest;
    readonly observedAuthorityDigest: SyncSha256Digest;
    readonly definitiveRejectionDigest?: SyncSha256Digest;
  }): Promise<SessionSyncCustodyReconciliation> {
    const pending = await this.pendingTransitionMetadata();
    const operationId = sessionSyncOperationIdSchema.parse(input.operationId);
    const requestDigest = syncSha256DigestSchema.parse(input.requestDigest);
    const observedMembershipDigest = syncSha256DigestSchema.parse(
      input.observedMembershipDigest,
    );
    const observedAuthorityDigest = syncSha256DigestSchema.parse(
      input.observedAuthorityDigest,
    );
    if (
      pending === null
      || pending.operationId !== operationId
      || pending.requestDigest !== requestDigest
    ) {
      throw new Error("Session sync recovery transition is missing.");
    }
    if (
      observedMembershipDigest === pending.childMembershipDigest
      && observedAuthorityDigest === pending.nextAuthorityDigest
    ) {
      await this.promoteRecoveryTransition({
        operationId,
        requestDigest,
        acceptedMembershipDigest: observedMembershipDigest,
        acceptedAuthorityDigest: observedAuthorityDigest,
      });
      return { disposition: "promoted" };
    }
    if (
      observedMembershipDigest !== pending.parentMembershipDigest
      || observedAuthorityDigest !== pending.expectedAuthorityDigest
    ) {
      throw new Error("Session sync recovery transition diverged from its authority chain.");
    }
    if (input.definitiveRejectionDigest === undefined) {
      return { disposition: "pending" };
    }
    await this.rollbackRecoveryTransition({
      operationId,
      requestDigest,
      observedMembershipDigest,
      observedAuthorityDigest,
      definitiveRejectionDigest: input.definitiveRejectionDigest,
    });
    return { disposition: "rolled_back" };
  }

  async clear(): Promise<void> {
    await this.#serialized(async () => {
      try {
        await this.#secrets.delete({
          service: HRA_SESSION_SYNC_KEYCHAIN_SERVICE,
          name: HRA_SESSION_SYNC_RECOVERY_KEYCHAIN_NAME,
        });
      } catch {
        throw new Error("Session sync recovery custody is unavailable.");
      }
    });
  }
}
