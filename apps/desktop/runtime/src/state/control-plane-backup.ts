import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "@hra-internal/schema";
import {
  CHAT_ATTACHMENT_VAULT_DIRECTORY_NAME,
  chatAttachmentVaultRoot,
} from "../attachments/root";
import {
  CHAT_ATTACHMENT_MAX_GLOBAL_READY_BYTES,
  CHAT_ATTACHMENT_MAX_PANE_READY_BYTES,
} from "../attachments/contracts";
import {
  assertBoundedControlPlaneIntegrity,
  ControlPlaneIntegrityError,
} from "./control-plane-integrity";
import {
  assertCompatibleReleaseFence,
  assertCompatibleControlPlaneDatabase,
  parseAppReleaseIdentity,
  type AppReleaseCompatibilityState,
  type AppReleaseIdentity,
} from "./release-compatibility";
import {
  operationReceiptKeyByteLength,
} from "./operation-receipt-key";
import {
  assertPortableScheduledChatTransferReady,
  inspectPortableProviderContext,
  portableProviderContextProjectionAttestationSchema,
  projectPortableProviderContext,
  PortableProviderContextProjectionError,
  type PortableProviderContextProjectionAttestation,
} from "./control-plane-portable-projection";
import {
  controlPlaneRestoreJournalSchema as restoreJournalSchema,
  controlPlaneRestorePaths,
  bindControlPlaneRestoreStageCustody,
  erasePartialControlPlaneAttachmentVaultStage,
  inspectControlPlaneAttachmentVault,
  inspectControlPlaneRestoreSqliteSidecars,
  maximumControlPlaneAttachmentVaultFileCount,
  maximumControlPlaneRestoreDatabaseByteLength,
  maximumControlPlaneRestoreJournalByteLength as maximumJournalByteLength,
  streamControlPlaneAttachmentVault,
  type ControlPlaneRestoreJournal,
  type ControlPlaneRestoreAttachmentVaultInventory,
  type ControlPlaneRestoreStageCustody,
  type ControlPlaneRestorePaths,
} from "./control-plane-restore-state";

const archiveMagic = Buffer.from("HKCPB002", "ascii");
const payloadMagic = Buffer.from("HKCPDB02", "ascii");
const archiveTagByteLength = 16;
const archiveLengthPrefixByteLength = 4;
const payloadLengthPrefixByteLength = 8;
const vaultManifestLengthPrefixByteLength = 4;
const encryptionKeyByteLength = 32;
const saltByteLength = 16;
const ivByteLength = 12;
const maximumManifestByteLength = 32 * 1_024;
const maximumVaultManifestByteLength = 8 * 1_024 * 1_024;
export const maximumControlPlaneBackupDatabaseByteLength =
  maximumControlPlaneRestoreDatabaseByteLength;
export const maximumControlPlaneBackupPayloadByteLength =
  maximumControlPlaneBackupDatabaseByteLength
  + CHAT_ATTACHMENT_MAX_GLOBAL_READY_BYTES
  + maximumVaultManifestByteLength
  + payloadMagic.byteLength
  + payloadLengthPrefixByteLength
  + vaultManifestLengthPrefixByteLength
  + operationReceiptKeyByteLength;
export const maximumControlPlaneBackupStreamingChunkByteLength = 1_024 * 1_024;
export const maximumControlPlaneBackupOwnedDatabaseImages = 4;
const controlPlaneBackupFixedPlaintextByteLength = operationReceiptKeyByteLength
  + payloadMagic.byteLength
  + payloadLengthPrefixByteLength
  + vaultManifestLengthPrefixByteLength;
const maximumArchiveByteLength = maximumControlPlaneBackupPayloadByteLength
  + maximumManifestByteLength
  + archiveMagic.byteLength
  + archiveLengthPrefixByteLength
  + archiveTagByteLength;
const maximumDatabaseByteLength = maximumControlPlaneBackupDatabaseByteLength;
const maximumPassphraseByteLength = 4_096;
const minimumPassphraseByteLength = 16;
const scryptCost = 131_072;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const scryptMaximumMemory = 256 * 1_024 * 1_024;
const closeOnExecFlag = Number(Reflect.get(constants, "O_CLOEXEC") ?? 0);
const protectedReadFlags = constants.O_RDONLY
  | constants.O_NOFOLLOW
  | constants.O_NONBLOCK
  | closeOnExecFlag;
const protectedDirectoryReadFlags = protectedReadFlags | constants.O_DIRECTORY;
/**
 * Conservative upper bound for this synchronous implementation: the live
 * SQLite image, serialized source, deserialized projection database, projected
 * serialization, manifest, paired stream buffers, framing/key bytes, and
 * scrypt workspace.
 */
export const maximumControlPlaneBackupPeakResidentByteEstimate =
  maximumControlPlaneBackupOwnedDatabaseImages
  * maximumControlPlaneBackupDatabaseByteLength
  + maximumVaultManifestByteLength
  + 2 * maximumControlPlaneBackupStreamingChunkByteLength
  + controlPlaneBackupFixedPlaintextByteLength
  + scryptMaximumMemory;

const hexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const attachmentIdSchema = z.string().min(18).max(96).regex(
  /^attachment_[A-Za-z0-9_-]+$/u,
);
const attachmentVaultBlobSchema = z.object({
  attachmentId: attachmentIdSchema,
  relativePath: z.string().min(20).max(256).regex(
    /^attachment_[A-Za-z0-9_-]+\/(?:source\.upload|blob\.[a-z0-9]{1,16}|normalized\/(?:canonical|preview)\.png)$/u,
  ),
  bytes: z.number().int().nonnegative().max(64 * 1_024 * 1_024),
  sha256: hexDigestSchema,
}).strict().superRefine((blob, context) => {
  if (!blob.relativePath.startsWith(`${blob.attachmentId}/`)) {
    context.addIssue({
      code: "custom",
      message: "attachment vault path does not match its attachment",
      path: ["relativePath"],
    });
  }
});
const attachmentVaultPayloadManifestSchema = z.object({
  version: z.literal(1),
  generationSha256: hexDigestSchema,
    totalBytes: z.number().int().nonnegative()
    .max(CHAT_ATTACHMENT_MAX_GLOBAL_READY_BYTES),
  blobs: z.array(attachmentVaultBlobSchema)
    .max(maximumControlPlaneAttachmentVaultFileCount),
}).strict();
type AttachmentVaultPayloadManifest = z.infer<
  typeof attachmentVaultPayloadManifestSchema
>;
const attachmentInventoryRowSchema = z.object({
  attachment_id: attachmentIdSchema,
  pane_id: z.string().min(1).max(128),
  state: z.enum([
    "creating",
    "receiving",
    "normalizing",
    "publishing",
    "ready",
    "corrupt",
    "deleting",
  ]),
  kind: z.enum(["image", "file"]),
  internal_suffix: z.string().min(1).max(16).regex(/^[a-z0-9]+$/u),
  received_input_bytes: z.number().int().nonnegative(),
  source_retained: z.union([z.literal(0), z.literal(1)]),
  canonical_bytes: z.number().int().positive().nullable(),
  canonical_sha256: hexDigestSchema.nullable(),
  preview_bytes: z.number().int().positive().nullable(),
  preview_sha256: hexDigestSchema.nullable(),
  provider_bytes: z.number().int().positive().nullable(),
  provider_sha256: hexDigestSchema.nullable(),
}).strict();
const base64Schema = z.string().min(4).max(128).regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
);
const releaseIdentitySchema = z.object({
  version: z.string(),
  build: z.number(),
}).strict();
const checkpointProofSchema = z.object({
  busy: z.literal(0),
  log: z.number().int().min(-1),
  checkpointed: z.number().int().min(-1),
  sourceQuickCheck: z.literal("ok"),
  snapshotQuickCheck: z.literal("ok"),
}).strict();
const backupManifestSchema = z.object({
  formatVersion: z.literal(2),
  kind: z.literal("hraness-kitchen-control-plane-backup"),
  createdAt: z.number().int().nonnegative(),
  sourceRelease: releaseIdentitySchema,
  sourceMigrationVersion: z.number().int().positive(),
  sourceHashes: z.object({
    sourceDatabaseSha256: hexDigestSchema,
    projectedDatabaseSha256: hexDigestSchema,
    schemaSha256: hexDigestSchema,
    migrationHistorySha256: hexDigestSchema,
    receiptBindingHmacSha256: hexDigestSchema,
    attachmentVaultGenerationSha256: hexDigestSchema,
  }).strict(),
  portableProviderContext:
    portableProviderContextProjectionAttestationSchema,
  checkpointProof: checkpointProofSchema,
  attachmentVault: z.object({
    blobCount: z.number().int().nonnegative()
      .max(maximumControlPlaneAttachmentVaultFileCount),
    totalBytes: z.number().int().nonnegative()
      .max(CHAT_ATTACHMENT_MAX_GLOBAL_READY_BYTES),
    providerHomesIncluded: z.literal(false),
    rolloutStateIncluded: z.literal(false),
    restoredAttachmentProviderContext: z.literal("fresh_send_required"),
  }).strict(),
  payloadByteLength: z.number().int().positive()
    .max(maximumControlPlaneBackupPayloadByteLength),
  kdf: z.object({
    name: z.literal("scrypt"),
    salt: base64Schema,
    cost: z.literal(scryptCost),
    blockSize: z.literal(scryptBlockSize),
    parallelization: z.literal(scryptParallelization),
    keyByteLength: z.literal(encryptionKeyByteLength),
  }).strict(),
  cipher: z.object({
    name: z.literal("aes-256-gcm"),
    iv: base64Schema,
    tagByteLength: z.literal(archiveTagByteLength),
  }).strict(),
}).strict();
const checkpointSchema = z.object({
  busy: z.number().int().nonnegative(),
  checkpointed: z.number().int().min(-1),
  log: z.number().int().min(-1),
}).passthrough();
const pageCountSchema = z.object({
  page_count: z.number().int().nonnegative(),
}).passthrough();
const pageSizeSchema = z.object({
  page_size: z.number().int().positive(),
}).passthrough();
const nonnegativeCountSchema = z.object({
  count: z.number().int().nonnegative(),
}).strict();
const schemaObjectRowsSchema = z.array(z.object({
  type: z.string(),
  name: z.string(),
  table_name: z.string(),
  sql: z.string(),
}).strict());
const migrationRowsSchema = z.array(z.object({
  version: z.number().int().positive(),
  name: z.string(),
  checksum: hexDigestSchema,
}).strict());

export interface ControlPlaneBackupManifest {
  readonly formatVersion: 2;
  readonly kind: "hraness-kitchen-control-plane-backup";
  readonly createdAt: number;
  readonly sourceRelease: AppReleaseIdentity;
  readonly sourceMigrationVersion: number;
  readonly sourceHashes: Readonly<{
    sourceDatabaseSha256: string;
    projectedDatabaseSha256: string;
    schemaSha256: string;
    migrationHistorySha256: string;
    receiptBindingHmacSha256: string;
    attachmentVaultGenerationSha256: string;
  }>;
  readonly portableProviderContext:
    PortableProviderContextProjectionAttestation;
  readonly checkpointProof: Readonly<{
    busy: 0;
    log: number;
    checkpointed: number;
    sourceQuickCheck: "ok";
    snapshotQuickCheck: "ok";
  }>;
  readonly attachmentVault: Readonly<{
    blobCount: number;
    totalBytes: number;
    providerHomesIncluded: false;
    rolloutStateIncluded: false;
    restoredAttachmentProviderContext: "fresh_send_required";
  }>;
  readonly payloadByteLength: number;
  readonly kdf: Readonly<{
    name: "scrypt";
    salt: string;
    cost: typeof scryptCost;
    blockSize: typeof scryptBlockSize;
    parallelization: typeof scryptParallelization;
    keyByteLength: typeof encryptionKeyByteLength;
  }>;
  readonly cipher: Readonly<{
    name: "aes-256-gcm";
    iv: string;
    tagByteLength: typeof archiveTagByteLength;
  }>;
}

export type ControlPlaneRestoreFaultPoint =
  | "after_materialized_before_prepared"
  | "after_prepared"
  | "after_database_rollback_staged"
  | "after_database_replaced"
  | "after_key_rollback_staged"
  | "after_key_replaced"
  | "after_vault_rollback_staged"
  | "after_vault_replaced"
  | "after_validation"
  | "after_first_vault_rollback_blob_removed"
  | "after_vault_rollback_removed"
  | "after_database_rollback_removed"
  | "after_key_rollback_removed";

export type ControlPlaneBackupPublicationFaultPoint =
  | "after_staged_hash_before_publish"
  | "after_publish_before_parent_recheck"
  | "after_publish_verified_before_parent_fsync"
  | "after_publish_parent_fsync";

export interface CreateControlPlaneBackupInput {
  readonly database: Database;
  readonly destinationPath: string;
  readonly operationReceiptKey: Uint8Array;
  readonly passphrase: string;
  readonly releaseIdentity: AppReleaseIdentity;
  /** Fixed sibling `attachment-vault-v2` root owned by this database. */
  readonly attachmentVaultRoot: string;
  readonly now?: () => number;
  /** Deterministic crash/race hook; production callers leave this unset. */
  readonly onPublicationCheckpoint?: (
    point: ControlPlaneBackupPublicationFaultPoint,
  ) => void;
  /** Reports the exact simultaneous logical DB-image owners in focused tests. */
  readonly onMemoryOwnershipCheckpoint?: (ownedDatabaseImages: number) => void;
}

export interface RestoreControlPlaneBackupInput {
  readonly archivePath: string;
  readonly databasePath: string;
  readonly passphrase: string;
  readonly releaseIdentity: AppReleaseIdentity;
  /** Must equal the fixed sibling `attachment-vault-v2` root when supplied. */
  readonly attachmentVaultRoot?: string;
  /** Restore is authorized only for these exact archive bytes. */
  readonly confirmedArchiveSha256: string;
  /**
   * This hook exists for deterministic process-crash tests. A thrown hook error
   * normally rolls the restore back. Set leaveInterruptedOnFault only in a
   * process that will terminate immediately after the injected exception.
   */
  readonly onCheckpoint?: (point: ControlPlaneRestoreFaultPoint) => void;
  readonly leaveInterruptedOnFault?: boolean;
}

export interface ControlPlaneBackupResult {
  readonly archiveByteLength: number;
  readonly archiveSha256: string;
  readonly manifest: ControlPlaneBackupManifest;
  readonly peakResidentByteEstimate: number;
  readonly maximumBufferedPlaintextBytes: number;
}

export interface ControlPlaneRestoreResult {
  readonly archiveSha256: string;
  readonly manifest: ControlPlaneBackupManifest;
  readonly restoredMigrationVersion: number;
}

export interface PrepareControlPlaneRestoreStageInput {
  readonly archivePath: string;
  readonly databasePath: string;
  readonly passphrase: string;
  readonly releaseIdentity: AppReleaseIdentity;
  readonly confirmedArchiveSha256: string;
  /** Deterministic retained-root race hook; production callers leave unset. */
  readonly onStageCheckpoint?: (
    point:
      | "after_target_preflight"
      | "after_archive_authentication"
      | "after_receipt_key_staged"
      | "after_database_staged"
      | "after_attachment_blob_staged"
      | "after_stage_file_created_before_validation"
      | "after_stage_directory_created_before_bind",
  ) => void;
}

export interface PreparedControlPlaneRestoreStage {
  readonly archiveSha256: string;
  readonly manifest: ControlPlaneBackupManifest;
  readonly restoredMigrationVersion: number;
  readonly databaseSha256: string;
  readonly receiptKeySha256: string;
  readonly attachmentVaultGenerationSha256: string;
  readonly attachmentVaultInventory: ControlPlaneRestoreAttachmentVaultInventory;
  readonly stageCustodyNonce: string;
  readonly restoreRootDevice: number;
  readonly restoreRootInode: number;
  /** Releases the authenticated archive/root authority before materialization. */
  cleanup(): void;
  /**
   * Requires the exact durable `materializing` journal, then reauthenticates
   * the retained archive into its fixed private stage.
   */
  transferToJournal(): MaterializedControlPlaneRestoreStage;
}

export interface MaterializedControlPlaneRestoreStage {
  readonly archiveSha256: string;
  readonly databaseSha256: string;
  readonly receiptKeySha256: string;
  readonly attachmentVaultGenerationSha256: string;
  readonly restoreRootDevice: number;
  readonly restoreRootInode: number;
  /** Retryably removes the exact fixed stage while the journal owns custody. */
  cleanup(): void;
  /** Scrubs retained inodes after path recovery rolls the materialization back. */
  eraseAfterRolledBackRecovery(): void;
  /**
   * Revalidates the fixed stage after the caller durably advances the journal
   * to `prepared`, retaining exact-inode custody for the swap executor.
   */
  acceptPreparedJournal(): JournaledControlPlaneRestoreStage;
}

export interface JournaledControlPlaneRestoreStage {
  readonly archiveSha256: string;
  readonly databaseSha256: string;
  readonly receiptKeySha256: string;
  readonly attachmentVaultGenerationSha256: string;
  readonly restoreRootDevice: number;
  readonly restoreRootInode: number;
  /** Zeroes exact retained inodes and retryably removes fixed failed stages. */
  eraseAfterFailedRecovery(): void;
  /** Releases retained descriptors only after durable `validated` commit. */
  releaseCommitted(): void;
  /** Scrubs exact retained replacement inodes after rollback has converged. */
  eraseAfterRolledBackRecovery(): void;
  /** Proves and releases exact committed live inodes after recovery converges. */
  releaseAfterCompletedRecovery(): void;
}

export interface VerifyControlPlaneBackupInput {
  readonly archivePath: string;
  readonly passphrase: string;
  readonly releaseIdentity: AppReleaseIdentity;
}

export interface ControlPlaneBackupVerificationResult {
  readonly archiveSha256: string;
  readonly manifest: ControlPlaneBackupManifest;
  readonly verifiedMigrationVersion: number;
  readonly peakResidentByteEstimate: number;
  readonly maximumBufferedPlaintextBytes: number;
}

export function estimateControlPlaneBackupMemoryBudget(input: Readonly<{
  databaseByteLength: number;
  vaultManifestByteLength: number;
  vaultBlobByteLength: number;
}>): Readonly<{
  payloadByteLength: number;
  peakResidentByteEstimate: number;
  maximumBufferedPlaintextBytes: number;
}> {
  for (const value of [
    input.databaseByteLength,
    input.vaultManifestByteLength,
    input.vaultBlobByteLength,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ControlPlaneBackupError(
        "invalid_input",
        "Backup memory accounting is invalid",
      );
    }
  }
  if (
    input.databaseByteLength < 1
    || input.databaseByteLength > maximumDatabaseByteLength
    || input.vaultManifestByteLength < 1
    || input.vaultManifestByteLength > maximumVaultManifestByteLength
  ) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "Backup database or attachment manifest exceeds its memory bound",
    );
  }
  const payloadByteLength = payloadMagic.byteLength
    + payloadLengthPrefixByteLength
    + vaultManifestLengthPrefixByteLength
    + operationReceiptKeyByteLength
    + input.databaseByteLength
    + input.vaultManifestByteLength
    + input.vaultBlobByteLength;
  if (
    !Number.isSafeInteger(payloadByteLength)
    || payloadByteLength > maximumControlPlaneBackupPayloadByteLength
  ) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The combined database and attachment backup exceeds its memory bound",
    );
  }
  return {
    payloadByteLength,
    peakResidentByteEstimate:
      maximumControlPlaneBackupOwnedDatabaseImages * input.databaseByteLength
      + input.vaultManifestByteLength
      + 2 * Math.min(
        maximumControlPlaneBackupStreamingChunkByteLength,
        payloadByteLength,
      )
      + controlPlaneBackupFixedPlaintextByteLength
      + scryptMaximumMemory,
    maximumBufferedPlaintextBytes:
      input.databaseByteLength
      + input.vaultManifestByteLength
      + operationReceiptKeyByteLength
      + payloadMagic.byteLength
      + payloadLengthPrefixByteLength
      + vaultManifestLengthPrefixByteLength
      + Math.min(
        maximumControlPlaneBackupStreamingChunkByteLength,
        payloadByteLength,
      ),
  };
}

export type InterruptedControlPlaneRestoreRecovery =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "rolled_back";
      phase: Exclude<ControlPlaneRestoreJournal["phase"], "validated">;
    }>
  | Readonly<{ kind: "completed"; phase: "validated" }>;

export class ControlPlaneBackupError extends Error {
  readonly code:
    | "authentication_failed"
    | "confirmation_failed"
    | "incompatible_backup"
    | "invalid_archive"
    | "invalid_input"
    | "restore_interrupted"
    | "unsafe_path";

  constructor(code: ControlPlaneBackupError["code"], message: string) {
    super(message);
    this.name = "ControlPlaneBackupError";
    this.code = code;
  }
}

export function createEncryptedControlPlaneBackup(
  input: CreateControlPlaneBackupInput,
): ControlPlaneBackupResult {
  const releaseIdentity = parseAppReleaseIdentity(input.releaseIdentity);
  const passphrase = parsePassphrase(input.passphrase);
  const receiptKey = parseOperationReceiptKey(input.operationReceiptKey);
  let databaseBytes: Uint8Array | null = null;
  let attachmentPayload: AttachmentVaultPayload | null = null;
  let portableProviderContext:
    PortableProviderContextProjectionAttestation | null = null;
  let destinationPublication: BoundPublicationDirectory | null = null;
  let controlPlaneRootPublication: BoundPublicationDirectory | null = null;
  try {
  const attachmentVaultRoot = requireFixedAttachmentVaultRoot(
    input.attachmentVaultRoot,
  );
  const controlPlaneRoot = dirname(attachmentVaultRoot);
  assertBackupArchiveOutsideControlPlaneRoot(
    input.destinationPath,
    controlPlaneRoot,
  );
  destinationPublication = bindPublicationDirectory(dirname(input.destinationPath));
  controlPlaneRootPublication = bindPublicationDirectory(controlPlaneRoot);
  if (
    destinationPublication.identity.dev === controlPlaneRootPublication.identity.dev
    && destinationPublication.identity.ino === controlPlaneRootPublication.identity.ino
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Backup destination must not share the live control-plane root",
    );
  }
  recoverPublishedCreateOnlyBackup(input.destinationPath);
  validateBackupDestination(input.destinationPath);
  const now = input.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ControlPlaneBackupError("invalid_input", "Backup time is invalid");
  }

  const compatibility = assertCompatibleControlPlaneDatabase(
    input.database,
    releaseIdentity,
  );
  if (compatibility.migrationVersion <= 0) {
    throw new ControlPlaneBackupError(
      "incompatible_backup",
      "An unmigrated control-plane database cannot be backed up",
    );
  }
  const checkpoint = checkpointAndCheck(input.database);
  assertDatabaseSerializationBound(input.database);
  const sourceDatabaseBytes = normalizeSerializedSnapshot(input.database.serialize());
  const sourceDatabaseSha256 = sha256(sourceDatabaseBytes);
  if (
    sourceDatabaseBytes.byteLength === 0
    || sourceDatabaseBytes.byteLength > maximumDatabaseByteLength
  ) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The control-plane database exceeds the portable backup bound",
    );
  }

  try {
    const sourceSnapshotProof = inspectSnapshot(sourceDatabaseBytes, releaseIdentity);
    try {
      if (sourceSnapshotProof.migrationVersion !== compatibility.migrationVersion) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "The serialized control-plane migration changed during backup",
        );
      }
      assertControlPlanePortableScheduleTransferReady(
        sourceSnapshotProof.database,
      );
      attachmentPayload = captureAttachmentVaultPayload(
        sourceSnapshotProof.database,
        attachmentVaultRoot,
        sourceDatabaseBytes.byteLength,
      );
    } finally {
      sourceSnapshotProof.database.close();
    }

    const secondCheckpoint = checkpointAndCheck(input.database);
    const secondDatabaseBytes = normalizeSerializedSnapshot(input.database.serialize());
    try {
      if (
        secondCheckpoint.log !== checkpoint.log
        || secondCheckpoint.checkpointed !== checkpoint.checkpointed
        || !safeHexEqual(sha256(secondDatabaseBytes), sha256(sourceDatabaseBytes))
      ) {
        throw new ControlPlaneBackupError(
          "invalid_input",
          "The control-plane database changed while its attachment vault was captured",
        );
      }
    } finally {
      secondDatabaseBytes.fill(0);
    }
    assertAttachmentVaultPayloadStable(
      sourceDatabaseBytes,
      releaseIdentity,
      attachmentVaultRoot,
      attachmentPayload,
    );
    const portable = copyPortableDatabaseSnapshot(
      sourceDatabaseBytes,
      releaseIdentity,
      receiptKey,
      sourceDatabaseSha256,
      attachmentPayload.manifest.generationSha256,
      new Date(now),
      input.onMemoryOwnershipCheckpoint,
    );
    databaseBytes = portable.databaseBytes;
    portableProviderContext = portable.attestation;
  } finally {
    sourceDatabaseBytes.fill(0);
  }

  if (
    databaseBytes === null
    || attachmentPayload === null
    || portableProviderContext === null
  ) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup capture is incomplete");
  }
  const snapshotProof = inspectSnapshot(databaseBytes, releaseIdentity);
  if (snapshotProof.migrationVersion !== compatibility.migrationVersion) {
    snapshotProof.database.close();
    databaseBytes.fill(0);
    attachmentPayload.fill();
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "The backup projection changed the control-plane migration",
    );
  }
  const projectedDatabaseSha256 = sha256(databaseBytes);
  const schemaSha256 = hashSchema(snapshotProof.database);
  const migrationHistorySha256 = hashMigrationHistory(snapshotProof.database);
  snapshotProof.database.close();

  const bindingPreimage = sourceBindingPreimage({
    sourceDatabaseSha256,
    projectedDatabaseSha256,
    schemaSha256,
    migrationHistorySha256,
    attachmentVaultGenerationSha256:
      attachmentPayload.manifest.generationSha256,
    migrationVersion: compatibility.migrationVersion,
    sourceRelease: releaseIdentity,
    portableProviderContext,
  });
  const receiptBindingHmacSha256 = hmacSha256(receiptKey, bindingPreimage);
  const salt = Uint8Array.from(randomBytes(saltByteLength));
  const iv = Uint8Array.from(randomBytes(ivByteLength));
  const vaultManifestByteLength = Buffer.byteLength(
    JSON.stringify(attachmentPayload.manifest),
    "utf8",
  );
  const memoryBudget = estimateControlPlaneBackupMemoryBudget({
    databaseByteLength: databaseBytes.byteLength,
    vaultManifestByteLength,
    vaultBlobByteLength: attachmentPayload.manifest.totalBytes,
  });
  const manifest: ControlPlaneBackupManifest = {
    formatVersion: 2,
    kind: "hraness-kitchen-control-plane-backup",
    createdAt: now,
    sourceRelease: releaseIdentity,
    sourceMigrationVersion: compatibility.migrationVersion,
    sourceHashes: {
      sourceDatabaseSha256,
      projectedDatabaseSha256,
      schemaSha256,
      migrationHistorySha256,
      receiptBindingHmacSha256,
      attachmentVaultGenerationSha256:
        attachmentPayload.manifest.generationSha256,
    },
    portableProviderContext,
    checkpointProof: {
      busy: 0,
      log: checkpoint.log,
      checkpointed: checkpoint.checkpointed,
      sourceQuickCheck: "ok",
      snapshotQuickCheck: "ok",
    },
    attachmentVault: {
      blobCount: attachmentPayload.manifest.blobs.length,
      totalBytes: attachmentPayload.manifest.totalBytes,
      providerHomesIncluded: false,
      rolloutStateIncluded: false,
      restoredAttachmentProviderContext: "fresh_send_required",
    },
    payloadByteLength: memoryBudget.payloadByteLength,
    kdf: {
      name: "scrypt",
      salt: Buffer.from(salt).toString("base64"),
      cost: scryptCost,
      blockSize: scryptBlockSize,
      parallelization: scryptParallelization,
      keyByteLength: encryptionKeyByteLength,
    },
    cipher: {
      name: "aes-256-gcm",
      iv: Buffer.from(iv).toString("base64"),
      tagByteLength: archiveTagByteLength,
    },
  };

  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.byteLength > maximumManifestByteLength) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup manifest is too large");
  }
  const archive = writeEncryptedBackupAtomically({
    path: input.destinationPath,
    manifestBytes,
    passphrase,
    salt,
    iv,
    operationReceiptKey: receiptKey,
    databaseBytes,
    attachmentVaultRoot,
    attachmentVaultManifest: attachmentPayload.manifest,
    publication: destinationPublication,
    assertControlPlaneRootStable: () => {
      controlPlaneRootPublication?.assertStable();
    },
    ...(input.onPublicationCheckpoint === undefined
      ? {}
      : { onPublicationCheckpoint: input.onPublicationCheckpoint }),
  });
  return {
    archiveByteLength: archive.byteLength,
    archiveSha256: archive.sha256,
    manifest,
    peakResidentByteEstimate: memoryBudget.peakResidentByteEstimate,
    maximumBufferedPlaintextBytes: memoryBudget.maximumBufferedPlaintextBytes,
  };
  } finally {
    databaseBytes?.fill(0);
    attachmentPayload?.fill();
    receiptKey.fill(0);
    try {
      destinationPublication?.close();
    } finally {
      controlPlaneRootPublication?.close();
    }
  }
}

export function inspectEncryptedControlPlaneBackup(
  archivePath: string,
): ControlPlaneBackupManifest {
  recoverPublishedCreateOnlyBackup(archivePath);
  const archive = openEncryptedBackupArchive(archivePath);
  try {
    return archive.manifest;
  } finally {
    archive.close();
  }
}

/**
 * Authenticates every archive byte, validates the receipt-key binding and
 * SQLite integrity proofs, and proves the snapshot can be read by this app.
 * It never creates restore artifacts or mutates local state.
 */
export function verifyEncryptedControlPlaneBackup(
  input: VerifyControlPlaneBackupInput,
): ControlPlaneBackupVerificationResult {
  const releaseIdentity = parseAppReleaseIdentity(input.releaseIdentity);
  const passphrase = parsePassphrase(input.passphrase);
  recoverPublishedCreateOnlyBackup(input.archivePath);
  const archive = openEncryptedBackupArchive(input.archivePath);
  let payload: VerifiedPayloadMemory | null = null;
  try {
    const archiveSha256 = hashOpenEncryptedBackupArchive(archive);
    payload = decodeOpenArchiveToVerifiedMemory(archive, passphrase);
    verifyDecryptedPayload(
      archive.manifest,
      payload.databaseBytes,
      payload.operationReceiptKey,
      payload.attachmentVaultManifest,
    );
    const snapshotProof = inspectSnapshot(payload.databaseBytes, releaseIdentity);
    let verifiedMigrationVersion: number;
    try {
      assertAttachmentInventoryMatchesDatabase(
        snapshotProof.database,
        payload.attachmentVaultManifest.blobs,
      );
      verifiedMigrationVersion = snapshotProof.migrationVersion;
    } finally {
      snapshotProof.database.close();
    }
    const memoryBudget = estimateControlPlaneBackupMemoryBudget({
      databaseByteLength: payload.databaseBytes.byteLength,
      vaultManifestByteLength: payload.attachmentVaultManifestByteLength,
      vaultBlobByteLength: payload.attachmentVaultManifest.totalBytes,
    });
    return {
      archiveSha256,
      manifest: archive.manifest,
      verifiedMigrationVersion,
      peakResidentByteEstimate: memoryBudget.peakResidentByteEstimate,
      maximumBufferedPlaintextBytes: memoryBudget.maximumBufferedPlaintextBytes,
    };
  } finally {
    payload?.fill();
    archive.close();
  }
}

/**
 * Authenticates and semantically validates the complete bound archive without
 * persistence. The returned authority may materialize the fixed private stage
 * only after it proves that the matching `materializing` journal is durable.
 * No live database, receipt key, vault, journal, or rollback path is mutated.
 */
export function prepareAuthenticatedControlPlaneRestoreStage(
  input: PrepareControlPlaneRestoreStageInput,
): PreparedControlPlaneRestoreStage {
  const releaseIdentity = parseAppReleaseIdentity(input.releaseIdentity);
  const passphrase = parsePassphrase(input.passphrase);
  const paths = restorePaths(input.databasePath);
  assertBackupArchiveOutsideControlPlaneRoot(input.archivePath, paths.parent);
  if (!hexDigestSchema.safeParse(input.confirmedArchiveSha256).success) {
    throw new ControlPlaneBackupError(
      "confirmation_failed",
      "Restore staging requires the exact verified archive digest",
    );
  }
  let restoreRootOwner: BoundPublicationDirectory | null =
    bindPublicationDirectory(paths.parent);
  let archive: OpenEncryptedBackupArchive | null = null;
  let returned = false;
  try {
    if ((restoreRootOwner.identity.mode & 0o777) !== 0o700) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Restore root must already have user-only permissions",
      );
    }
    restoreRootOwner.assertStable();
    assertCompatibleReleaseFence(input.databasePath, releaseIdentity);
    restoreRootOwner.assertStable();
    inspectRestoreTargetsForStage(paths);
    input.onStageCheckpoint?.("after_target_preflight");
    restoreRootOwner.assertStable();
    const openedArchive = openEncryptedBackupArchive(input.archivePath);
    archive = openedArchive;
    const archiveSha256 = hashOpenEncryptedBackupArchive(openedArchive);
    if (!safeHexEqual(archiveSha256, input.confirmedArchiveSha256)) {
      throw new ControlPlaneBackupError(
        "confirmation_failed",
        "The backup archive does not match the confirmed digest",
      );
    }
    let payload: VerifiedPayloadMemory | null = null;
    let restoredMigrationVersion: number;
    let databaseSha256: string;
    let receiptKeySha256: string;
    let attachmentVaultGenerationSha256: string;
    let attachmentVaultInventory: ControlPlaneRestoreAttachmentVaultInventory;
    try {
      payload = decodeOpenArchiveToVerifiedMemory(openedArchive, passphrase);
      verifyDecryptedPayload(
        openedArchive.manifest,
        payload.databaseBytes,
        payload.operationReceiptKey,
        payload.attachmentVaultManifest,
      );
      const snapshotProof = inspectSnapshot(
        payload.databaseBytes,
        releaseIdentity,
      );
      try {
        assertAttachmentInventoryMatchesDatabase(
          snapshotProof.database,
          payload.attachmentVaultManifest.blobs,
        );
        restoredMigrationVersion = snapshotProof.migrationVersion;
      } finally {
        snapshotProof.database.close();
      }
      databaseSha256 = sha256(payload.databaseBytes);
      receiptKeySha256 = sha256(payload.operationReceiptKey);
      attachmentVaultGenerationSha256 =
        payload.attachmentVaultManifest.generationSha256;
      attachmentVaultInventory = payload.attachmentVaultManifest;
    } finally {
      payload?.fill();
    }
    input.onStageCheckpoint?.("after_archive_authentication");
    restoreRootOwner.assertStable();
    assertOpenArchiveStable(
      openedArchive.parent,
      openedArchive.name,
      openedArchive.descriptor,
      openedArchive.identity,
    );
    const stagePaths: StreamedPayloadStagePaths = {
      parent: paths.parent,
      database: paths.databaseStage,
      receiptKey: paths.keyStage,
      attachmentVault: paths.attachmentVaultStage,
    };
    const retainedRestoreRoot = restoreRootOwner;
    restoreRootOwner = null;
    archive = null;
    let state: "authenticated" | "materialized" | "journaled" | "settled" =
      "authenticated";
    let materialized: MaterializedControlPlaneRestoreStage | null = null;
    const stageCustodyNonce = randomBytes(32).toString("hex");
    const expectedJournal = {
      archiveSha256,
      databaseSha256,
      receiptKeySha256,
      attachmentVaultGenerationSha256,
      attachmentVaultInventory,
      stageCustodyNonce,
      restoreRootDevice: retainedRestoreRoot.identity.dev,
      restoreRootInode: retainedRestoreRoot.identity.ino,
    } as const;
    const closeAuthenticatedAuthority = (): void => {
      let firstFailure: unknown = null;
      try {
        openedArchive.close();
      } catch (error: unknown) {
        firstFailure = error;
      }
      try {
        retainedRestoreRoot.close();
      } catch (error: unknown) {
        if (firstFailure === null) firstFailure = error;
      }
      if (firstFailure !== null) {
        throwControlPlaneFailure(
          firstFailure,
          "Authenticated restore authority could not be closed safely",
        );
      }
    };
    const result: PreparedControlPlaneRestoreStage = {
      archiveSha256,
      manifest: openedArchive.manifest,
      restoredMigrationVersion,
      databaseSha256,
      receiptKeySha256,
      attachmentVaultGenerationSha256,
      attachmentVaultInventory,
      stageCustodyNonce,
      restoreRootDevice: retainedRestoreRoot.identity.dev,
      restoreRootInode: retainedRestoreRoot.identity.ino,
      cleanup() {
        if (state === "settled") return;
        if (state === "materialized") {
          materialized!.cleanup();
          return;
        }
        if (state === "journaled") return;
        closeAuthenticatedAuthority();
        state = "settled";
      },
      transferToJournal() {
        if (state === "settled") {
          throw new ControlPlaneBackupError(
            "restore_interrupted",
            "Authenticated restore-stage authority is already settled",
          );
        }
        if (state === "materialized" || state === "journaled") {
          return materialized!;
        }
        retainedRestoreRoot.assertStable();
        assertOpenArchiveStable(
          openedArchive.parent,
          openedArchive.name,
          openedArchive.descriptor,
          openedArchive.identity,
        );
        assertBoundRestoreJournal(
          readBoundRestoreJournal(paths, retainedRestoreRoot),
          "materializing",
          expectedJournal,
        );
        let stage: StreamedPayloadStage | null = null;
        let archiveCloseFailure: unknown = null;
        try {
          stage = decryptOpenArchiveToStage(
            openedArchive,
            passphrase,
            stagePaths,
            retainedRestoreRoot,
            stageCustodyNonce,
            input.onStageCheckpoint,
          );
          const materializedMigrationVersion = validateStreamedPayloadStage(
            openedArchive.manifest,
            stage,
            releaseIdentity,
          );
          if (
            materializedMigrationVersion !== restoredMigrationVersion
            || !safeHexEqual(stage.databaseSha256, databaseSha256)
            || !safeHexEqual(sha256(stage.receiptKey), receiptKeySha256)
            || !safeHexEqual(
              stage.attachmentVaultManifest.generationSha256,
              attachmentVaultGenerationSha256,
            )
          ) {
            throw new ControlPlaneBackupError(
              "invalid_archive",
              "Materialized restore stage differs from authenticated preparation",
            );
          }
          stage.readRestoreJournal("materializing", expectedJournal);
          const retainedStage = stage;
          let materializedSettled = false;
          let preparedAccepted = false;
          const journaled: JournaledControlPlaneRestoreStage = {
            ...expectedJournal,
            eraseAfterFailedRecovery() {
              if (materializedSettled) return;
              retainedStage.assertRecoverableRestoreJournal(expectedJournal);
              retainedStage.cleanup();
              materializedSettled = true;
              state = "settled";
            },
            releaseCommitted() {
              if (materializedSettled) return;
              if (!preparedAccepted) {
                throw new ControlPlaneBackupError(
                  "restore_interrupted",
                  "Restore stage has not accepted a durable prepared journal",
                );
              }
              retainedStage.readRestoreJournal("validated", expectedJournal);
              retainedStage.assertPublishedRestoreTargets();
              retainedStage.release();
              materializedSettled = true;
              state = "settled";
            },
            eraseAfterRolledBackRecovery() {
              if (materializedSettled) return;
              retainedStage.assertRestoreTargetsDoNotRetainPublishedStage();
              retainedStage.abandon();
              materializedSettled = true;
              state = "settled";
            },
            releaseAfterCompletedRecovery() {
              if (materializedSettled) return;
              if (!preparedAccepted) {
                throw new ControlPlaneBackupError(
                  "restore_interrupted",
                  "Restore stage has not accepted a durable prepared journal",
                );
              }
              retainedStage.assertPublishedRestoreTargets();
              retainedStage.release();
              materializedSettled = true;
              state = "settled";
            },
          };
          materialized = {
            ...expectedJournal,
            cleanup() {
              if (materializedSettled) return;
              if (preparedAccepted) {
                throw new ControlPlaneBackupError(
                  "restore_interrupted",
                  "Restore-stage cleanup custody has transferred to the journaled executor",
                );
              }
              retainedStage.cleanup();
              materializedSettled = true;
              state = "settled";
            },
            eraseAfterRolledBackRecovery() {
              if (materializedSettled) return;
              if (preparedAccepted) {
                throw new ControlPlaneBackupError(
                  "restore_interrupted",
                  "Restore-stage rollback custody has transferred to the journaled executor",
                );
              }
              retainedStage.assertRestoreTargetsDoNotRetainPublishedStage();
              retainedStage.abandon();
              materializedSettled = true;
              state = "settled";
            },
            acceptPreparedJournal() {
              if (materializedSettled) {
                throw new ControlPlaneBackupError(
                  "restore_interrupted",
                  "Materialized restore-stage authority is already settled",
                );
              }
              retainedStage.readRestoreJournal("prepared", expectedJournal);
              validateStreamedPayloadStage(
                openedArchive.manifest,
                retainedStage,
                releaseIdentity,
              );
              preparedAccepted = true;
              state = "journaled";
              return journaled;
            },
          };
          state = "materialized";
        } catch (error: unknown) {
          if (stage !== null) {
            const cleanupFailure = cleanupFailedStreamingStage(stage);
            if (cleanupFailure !== null) {
              throw new ControlPlaneBackupError(
                "restore_interrupted",
                `Authenticated restore materialization failed and journal recovery is required: ${errorMessage(cleanupFailure)}`,
              );
            }
          }
          state = "settled";
          throwControlPlaneFailure(
            error,
            "Authenticated restore materialization failed",
          );
        } finally {
          try {
            openedArchive.close();
          } catch (error: unknown) {
            archiveCloseFailure = error;
          }
          if (archiveCloseFailure !== null && state !== "materialized") {
            throwControlPlaneFailure(
              archiveCloseFailure,
              "Authenticated restore archive could not be closed safely",
            );
          }
        }
        if (archiveCloseFailure !== null) {
          const cleanupFailure = cleanupFailedStreamingStage(stage);
          state = "settled";
          if (cleanupFailure !== null) {
            throw new ControlPlaneBackupError(
              "restore_interrupted",
              `Authenticated restore archive close failed and journal recovery is required: ${errorMessage(cleanupFailure)}`,
            );
          }
          throwControlPlaneFailure(
            archiveCloseFailure,
            "Authenticated restore archive could not be closed safely",
          );
        }
        return materialized;
      },
    };
    returned = true;
    return result;
  } finally {
    if (!returned) {
      try {
        archive?.close();
      } finally {
        restoreRootOwner?.close();
      }
    }
  }
}

/**
 * Destructive restore executor. Production callers must hold the canonical
 * control-plane lifetime lock for the complete call; descriptor validation
 * then fences every cooperating HRA writer in the private state root.
 */
/** Production callers must hold the control-plane OS lifetime lock throughout. */
export function restoreEncryptedControlPlaneBackup(
  input: RestoreControlPlaneBackupInput,
): ControlPlaneRestoreResult {
  const releaseIdentity = parseAppReleaseIdentity(input.releaseIdentity);
  const paths = restorePaths(input.databasePath);
  assertBackupArchiveOutsideControlPlaneRoot(input.archivePath, paths.parent);
  if (
    input.attachmentVaultRoot !== undefined
    && requireFixedAttachmentVaultRoot(input.attachmentVaultRoot)
      !== paths.attachmentVault
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Restore attachment-vault root does not belong to this database",
    );
  }
  assertPrivateRestoreRoot(paths.parent);
  assertCompatibleReleaseFence(input.databasePath, releaseIdentity);
  recoverInterruptedControlPlaneRestore(input.databasePath);
  const prepared = prepareAuthenticatedControlPlaneRestoreStage({
    archivePath: input.archivePath,
    databasePath: input.databasePath,
    passphrase: input.passphrase,
    releaseIdentity,
    confirmedArchiveSha256: input.confirmedArchiveSha256,
  });
  let journalWritten = false;
  let committed = false;
  let recoveryCompleted = false;
  let materialized: MaterializedControlPlaneRestoreStage | null = null;
  let journaled: JournaledControlPlaneRestoreStage | null = null;
  let restoreRoot: BoundPublicationDirectory | null = null;
  try {
    prepareRestoreTargets(paths);
    restoreRoot = bindPublicationDirectory(paths.parent);
    if (
      restoreRoot.identity.dev !== prepared.restoreRootDevice
      || restoreRoot.identity.ino !== prepared.restoreRootInode
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "The restore root changed after archive authentication",
      );
    }
    const original = inspectCoherentRestoreTarget(paths, releaseIdentity);
    let journal: RestoreJournal = {
      version: 2,
      kind: "hraness-kitchen-control-plane-restore",
      phase: "materializing",
      archiveSha256: prepared.archiveSha256,
      databaseSha256: prepared.databaseSha256,
      receiptKeySha256: prepared.receiptKeySha256,
      attachmentVaultGenerationSha256:
        prepared.attachmentVaultGenerationSha256,
      attachmentVaultInventory: prepared.attachmentVaultInventory,
      stageCustodyNonce: prepared.stageCustodyNonce,
      restoreRootDevice: prepared.restoreRootDevice,
      restoreRootInode: prepared.restoreRootInode,
      hadDatabase: original.hadDatabase,
      hadReceiptKey: original.hadReceiptKey,
      hadAttachmentVault: original.hadAttachmentVault,
      originalDatabaseSha256: original.databaseSha256,
      originalReceiptKeySha256: original.receiptKeySha256,
      originalAttachmentVaultGenerationSha256:
        original.attachmentVaultGenerationSha256,
      originalAttachmentVaultInventory: original.attachmentVaultInventory,
    };
    assertJournalOriginalShape(journal);
    writeRestoreJournal(paths, journal, restoreRoot);
    journalWritten = true;
    materialized = prepared.transferToJournal();
    checkpoint(input, "after_materialized_before_prepared");
    journal = { ...journal, phase: "prepared" };
    writeRestoreJournal(paths, journal, restoreRoot);
    journaled = materialized.acceptPreparedJournal();

    removeRestoreSqliteSidecars(paths);
      checkpoint(input, "after_prepared");
      if (journal.hadDatabase) {
        renameRestoreEntryExclusive(
          restoreRoot,
          paths,
          paths.database,
          paths.databaseRollback,
        );
      }
      checkpoint(input, "after_database_rollback_staged");
      renameRestoreEntryExclusive(
        restoreRoot,
        paths,
        paths.databaseStage,
        paths.database,
      );
      journal = { ...journal, phase: "database_replaced" };
      writeRestoreJournal(paths, journal, restoreRoot);
      checkpoint(input, "after_database_replaced");

      if (journal.hadReceiptKey) {
        renameRestoreEntryExclusive(
          restoreRoot,
          paths,
          paths.receiptKey,
          paths.keyRollback,
        );
      }
      checkpoint(input, "after_key_rollback_staged");
      renameRestoreEntryExclusive(
        restoreRoot,
        paths,
        paths.keyStage,
        paths.receiptKey,
      );
      journal = { ...journal, phase: "key_replaced" };
      writeRestoreJournal(paths, journal, restoreRoot);
      checkpoint(input, "after_key_replaced");

      if (journal.hadAttachmentVault) {
        renameRestoreEntryExclusive(
          restoreRoot,
          paths,
          paths.attachmentVault,
          paths.attachmentVaultRollback,
        );
      }
      checkpoint(input, "after_vault_rollback_staged");
      renameRestoreEntryExclusive(
        restoreRoot,
        paths,
        paths.attachmentVaultStage,
        paths.attachmentVault,
      );
      journal = { ...journal, phase: "vault_replaced" };
      writeRestoreJournal(paths, journal, restoreRoot);
      checkpoint(input, "after_vault_replaced");

      validatePublishedRestore(
        paths,
        releaseIdentity,
        prepared.manifest,
        journal.receiptKeySha256,
      );
      journal = { ...journal, phase: "validated" };
      writeRestoreJournal(paths, journal, restoreRoot);
      checkpoint(input, "after_validation");
      journaled.releaseCommitted();

      removeVerifiedOptionalAttachmentVault(
        paths.attachmentVaultRollback,
        journal.originalAttachmentVaultInventory,
        "attachment-vault rollback",
        () => checkpoint(input, "after_first_vault_rollback_blob_removed"),
      );
      syncDirectory(paths.parent);
      checkpoint(input, "after_vault_rollback_removed");
      removeVerifiedOptionalFile(
        paths.databaseRollback,
        journal.originalDatabaseSha256,
        maximumDatabaseByteLength,
        "database rollback",
      );
      syncDirectory(paths.parent);
      checkpoint(input, "after_database_rollback_removed");
      removeVerifiedOptionalFile(
        paths.keyRollback,
        journal.originalReceiptKeySha256,
        operationReceiptKeyByteLength,
        "receipt-key rollback",
      );
      syncDirectory(paths.parent);
      checkpoint(input, "after_key_rollback_removed");
      removeIfPresent(paths.journal);
      removeIfPresent(paths.journalCandidate);
      syncDirectory(paths.parent);
      committed = true;

    return {
      archiveSha256: prepared.archiveSha256,
      manifest: prepared.manifest,
      restoredMigrationVersion: prepared.restoredMigrationVersion,
    };
  } catch (error: unknown) {
    if (journalWritten && input.leaveInterruptedOnFault !== true) {
      try {
        const recovery = recoverInterruptedControlPlaneRestore(input.databasePath);
        if (journaled !== null) {
          if (recovery.kind === "rolled_back") {
            journaled.eraseAfterRolledBackRecovery();
          } else if (recovery.kind === "completed") {
            journaled.releaseAfterCompletedRecovery();
          } else {
            throw new ControlPlaneBackupError(
              "restore_interrupted",
              "Restore recovery did not settle retained stage authority",
            );
          }
        } else if (materialized !== null) {
          if (recovery.kind !== "rolled_back") {
            throw new ControlPlaneBackupError(
              "restore_interrupted",
              "Restore recovery completed without journaled stage authority",
            );
          }
          materialized.eraseAfterRolledBackRecovery();
        }
        recoveryCompleted = true;
      } catch (rollbackError: unknown) {
        throw new ControlPlaneBackupError(
          "restore_interrupted",
          `Restore failed and rollback could not complete: ${errorMessage(rollbackError)}`,
        );
      }
    }
    throw error;
  } finally {
    try {
      if (!journalWritten || committed || recoveryCompleted) prepared.cleanup();
    } finally {
      restoreRoot?.close();
    }
  }
}

/**
 * Production callers must hold the control-plane OS lifetime lock throughout;
 * direct test callers are limited to isolated quiescent roots.
 */
export function recoverInterruptedControlPlaneRestore(
  databasePath: string,
): InterruptedControlPlaneRestoreRecovery {
  const paths = restorePaths(databasePath);
  assertPrivateRestoreRoot(paths.parent);
  const journal = readRestoreJournal(paths);
  if (journal === null) {
    if (
      pathExists(paths.databaseRollback)
      || pathExists(paths.keyRollback)
      || pathExists(paths.attachmentVaultRollback)
      || pathExists(paths.databaseStage)
      || pathExists(paths.keyStage)
      || pathExists(paths.attachmentVaultStage)
    ) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "Unjournaled restore plaintext or rollback state requires manual inspection",
      );
    }
    removeIfPresent(paths.journalCandidate);
    syncDirectory(paths.parent);
    return { kind: "none" };
  }

  assertJournalOriginalShape(journal);
  const restoreRootMetadata = lstatSync(paths.parent);
  if (
    restoreRootMetadata.dev !== journal.restoreRootDevice
    || restoreRootMetadata.ino !== journal.restoreRootInode
  ) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      "The restore root does not match its journaled identity",
    );
  }
  if (journal.phase === "materializing") {
    const retainedRoot = bindPublicationDirectory(paths.parent);
    let stageCustody: ControlPlaneRestoreStageCustody | null = null;
    try {
      stageCustody = bindControlPlaneRestoreStageCustody();
      erasePartialControlPlaneAttachmentVaultStage({
        root: paths.attachmentVaultStage,
        expectedParentIdentity: {
          dev: journal.restoreRootDevice,
          ino: journal.restoreRootInode,
        },
        inventory: journal.attachmentVaultInventory,
        stageCustodyNonce: journal.stageCustodyNonce,
      });
      eraseBoundMaterializingStageFile(
        retainedRoot,
        stageCustody,
        journal.stageCustodyNonce,
        basename(paths.databaseStage),
        paths.databaseStage,
        maximumDatabaseByteLength,
        "database",
      );
      eraseBoundMaterializingStageFile(
        retainedRoot,
        stageCustody,
        journal.stageCustodyNonce,
        basename(paths.keyStage),
        paths.keyStage,
        operationReceiptKeyByteLength,
        "receipt-key",
      );
      retainedRoot.unlink(basename(paths.journal));
      retainedRoot.sync();
    } finally {
      try {
        stageCustody?.close();
      } finally {
        retainedRoot.close();
      }
    }
    return { kind: "rolled_back", phase: journal.phase };
  }
  if (journal.phase === "validated") {
    finishCommittedRestoreCleanup(paths, journal);
    return { kind: "completed", phase: journal.phase };
  }

  removeRestoreSqliteSidecars(paths);
  restoreOriginalAttachmentVault(paths, journal);
  restoreOriginalFile({
    hadOriginal: journal.hadDatabase,
    livePath: paths.database,
    rollbackPath: paths.databaseRollback,
    label: "control-plane database",
    originalSha256: journal.originalDatabaseSha256,
    replacementSha256: journal.databaseSha256,
    maximumBytes: maximumDatabaseByteLength,
  });
  restoreOriginalFile({
    hadOriginal: journal.hadReceiptKey,
    livePath: paths.receiptKey,
    rollbackPath: paths.keyRollback,
    label: "operation-receipt key",
    originalSha256: journal.originalReceiptKeySha256,
    replacementSha256: journal.receiptKeySha256,
    maximumBytes: operationReceiptKeyByteLength,
  });
  removeIfPresent(paths.databaseStage);
  removeIfPresent(paths.keyStage);
  removeAttachmentVaultGenerationIfPresent(
    paths.attachmentVaultStage,
    journal.attachmentVaultInventory,
    "attachment-vault stage",
  );
  removeIfPresent(paths.journalCandidate);
  removeIfPresent(paths.journal);
  syncDirectory(paths.parent);
  return { kind: "rolled_back", phase: journal.phase };
}

function restoreOriginalAttachmentVault(
  paths: RestorePaths,
  journal: RestoreJournal,
): void {
  const rollbackPresent = pathExists(paths.attachmentVaultRollback);
  if (rollbackPresent) {
    if (
      journal.originalAttachmentVaultGenerationSha256 === null
      || hashOptionalAttachmentVault(paths.attachmentVaultRollback)
        !== journal.originalAttachmentVaultGenerationSha256
    ) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "The attachment-vault rollback does not match its journal",
      );
    }
    if (pathExists(paths.attachmentVault)) {
      removeAttachmentVaultGenerationIfPresent(
        paths.attachmentVault,
        journal.attachmentVaultInventory,
        "replacement attachment vault",
      );
    }
    renameSync(paths.attachmentVaultRollback, paths.attachmentVault);
    syncDirectory(paths.parent);
  } else if (journal.hadAttachmentVault) {
    const liveGeneration = hashOptionalAttachmentVault(paths.attachmentVault);
    if (liveGeneration !== journal.originalAttachmentVaultGenerationSha256) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "The original attachment vault changed before restore",
      );
    }
  } else if (pathExists(paths.attachmentVault)) {
    removeAttachmentVaultGenerationIfPresent(
      paths.attachmentVault,
      journal.attachmentVaultInventory,
      "replacement attachment vault",
    );
  }
  removeAttachmentVaultGenerationIfPresent(
    paths.attachmentVaultStage,
    journal.attachmentVaultInventory,
    "attachment-vault stage",
  );
}

function eraseBoundMaterializingStageFile(
  parent: BoundPublicationDirectory,
  stageCustody: ControlPlaneRestoreStageCustody,
  stageCustodyNonce: string,
  name: string,
  path: string,
  maximumBytes: number,
  label: string,
): void {
  const descriptor = parent.tryOpenFile(
    name,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
      | closeOnExecFlag,
    0,
  );
  if (descriptor === null) {
    if (readMetadata(path) !== null) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        `The materializing ${label} stage is present but unsafe`,
      );
    }
    return;
  }
  try {
    const before = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== parent.identity.dev
      || before.size < 0
      || before.size > maximumBytes
      || (before.mode & 0o777) !== 0o600
      || (currentUser !== undefined && before.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        `The materializing ${label} stage is unsafe`,
      );
    }
    stageCustody.assert(descriptor, stageCustodyNonce);
    ftruncateSync(descriptor, 0);
    fsyncSync(descriptor);
    const erased = fstatSync(descriptor);
    if (
      erased.dev !== before.dev
      || erased.ino !== before.ino
      || erased.size !== 0
      || erased.nlink !== 1
    ) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        `The materializing ${label} stage could not be erased safely`,
      );
    }
    parent.unlink(name);
    parent.sync();
    if (fstatSync(descriptor).nlink !== 0) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        `The materializing ${label} stage name changed during cleanup`,
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

type RestorePaths = ControlPlaneRestorePaths;
type RestoreJournal = ControlPlaneRestoreJournal;
type RestoreJournalBinding = Readonly<{
  archiveSha256: string;
  databaseSha256: string;
  receiptKeySha256: string;
  attachmentVaultGenerationSha256: string;
  stageCustodyNonce: string;
  restoreRootDevice: number;
  restoreRootInode: number;
}>;

interface AttachmentVaultPayload {
  readonly manifest: AttachmentVaultPayloadManifest;
  fill(): void;
}

export interface ControlPlaneAttachmentBackupReadiness {
  readonly blobCount: number;
  readonly totalBytes: number;
  readonly generationSha256: string;
}

function restorePaths(databasePath: string): RestorePaths {
  try {
    return controlPlaneRestorePaths(databasePath);
  } catch {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Restore requires the canonical absolute control-plane database path",
    );
  }
}

function requireFixedAttachmentVaultRoot(value: string): string {
  if (
    !isAbsolute(value)
    || resolve(value) !== value
    || basename(value) !== CHAT_ATTACHMENT_VAULT_DIRECTORY_NAME
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Attachment backup requires the fixed attachment-vault root",
    );
  }
  const databasePath = join(dirname(value), "control-plane.sqlite");
  if (chatAttachmentVaultRoot(databasePath) !== value) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Attachment backup root does not match the canonical resolver",
    );
  }
  assertNoSymlinkDirectory(dirname(value));
  return value;
}

/**
 * Shared read-only readiness boundary for backup creation and maintenance
 * doctor. It proves the fixed vault generation, SQL inventory, runtime quota,
 * and absence of unresolved attachment recovery custody.
 */
export function inspectControlPlaneAttachmentBackupReadiness(input: Readonly<{
  database: Database;
  attachmentVaultRoot: string;
}>): ControlPlaneAttachmentBackupReadiness {
  const root = requireFixedAttachmentVaultRoot(input.attachmentVaultRoot);
  let proof;
  try {
    proof = inspectControlPlaneAttachmentVault(root);
  } catch (error: unknown) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      `The attachment vault is not backup-ready: ${errorMessage(error)}`,
    );
  }
  assertAttachmentInventoryMatchesDatabase(input.database, proof.blobs);
  return {
    blobCount: proof.blobs.length,
    totalBytes: proof.totalBytes,
    generationSha256: proof.generationSha256,
  };
}

function captureAttachmentVaultPayload(
  database: Database,
  root: string,
  databaseByteLength: number,
): AttachmentVaultPayload {
  try {
    const proof = inspectControlPlaneAttachmentVault(root);
    assertAttachmentInventoryMatchesDatabase(database, proof.blobs);
    const manifest = attachmentVaultPayloadManifestSchema.parse({
      version: 1,
      generationSha256: proof.generationSha256,
      totalBytes: proof.totalBytes,
      blobs: proof.blobs,
    });
    estimateControlPlaneBackupMemoryBudget({
      databaseByteLength,
      vaultManifestByteLength: Buffer.byteLength(JSON.stringify(manifest), "utf8"),
      vaultBlobByteLength: manifest.totalBytes,
    });
    return {
      manifest,
      fill() {},
    };
  } catch (error: unknown) {
    if (error instanceof ControlPlaneBackupError) throw error;
    throw new ControlPlaneBackupError(
      "invalid_input",
      `The attachment vault could not be captured: ${errorMessage(error)}`,
    );
  }
}

function assertAttachmentVaultPayloadStable(
  databaseBytes: Uint8Array,
  releaseIdentity: AppReleaseIdentity,
  root: string,
  payload: AttachmentVaultPayload,
): void {
  const proof = inspectSnapshot(databaseBytes, releaseIdentity);
  try {
    const repeated = inspectControlPlaneAttachmentVault(root);
    if (
      repeated.generationSha256 !== payload.manifest.generationSha256
      || repeated.totalBytes !== payload.manifest.totalBytes
      || JSON.stringify(repeated.blobs) !== JSON.stringify(payload.manifest.blobs)
    ) {
      throw new ControlPlaneBackupError(
        "invalid_input",
        "The attachment vault changed before backup publication",
      );
    }
    assertAttachmentInventoryMatchesDatabase(proof.database, repeated.blobs);
  } finally {
    proof.database.close();
  }
}

function assertAttachmentInventoryMatchesDatabase(
  database: Database,
  blobs: readonly z.infer<typeof attachmentVaultBlobSchema>[],
): void {
  try {
    const quarantine = nonnegativeCountSchema.parse(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_storage_quarantines
    `).get());
    const preparedChunks = nonnegativeCountSchema.parse(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_upload_chunks
      WHERE state = 'prepared'
    `).get());
    if (quarantine.count !== 0 || preparedChunks.count !== 0) {
      throw attachmentInventoryNotQuiescent();
    }
  } catch (error: unknown) {
    if (error instanceof ControlPlaneBackupError) throw error;
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The attachment recovery inventory is invalid",
    );
  }
  let rows: readonly z.infer<typeof attachmentInventoryRowSchema>[];
  try {
    rows = z.array(attachmentInventoryRowSchema).parse(database.query(`
      SELECT attachment_id, pane_id, state, kind, internal_suffix,
        received_input_bytes, source_retained,
        canonical_bytes, canonical_sha256, preview_bytes, preview_sha256,
        provider_bytes, provider_sha256
      FROM chat_attachments
      ORDER BY attachment_id
    `).all());
  } catch {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The attachment database inventory is invalid",
    );
  }
  const blobsByAttachment = new Map<
    string,
    z.infer<typeof attachmentVaultBlobSchema>[]
  >();
  for (const blob of blobs) {
    const current = blobsByAttachment.get(blob.attachmentId) ?? [];
    current.push(blob);
    blobsByAttachment.set(blob.attachmentId, current);
  }
  const rowIds = new Set(rows.map((row) => row.attachment_id));
  if ([...blobsByAttachment.keys()].some((id) => !rowIds.has(id))) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The attachment vault contains an object with no database authority",
    );
  }
  let globalReadyBytes = 0;
  const readyBytesByPane = new Map<string, number>();
  for (const row of rows) {
    const owned = blobsByAttachment.get(row.attachment_id) ?? [];
    const byPath = new Map(owned.map((blob) => [
      blob.relativePath.slice(row.attachment_id.length + 1),
      blob,
    ]));
    if (byPath.size !== owned.length) {
      throw new ControlPlaneBackupError(
        "invalid_input",
        "The attachment vault contains duplicate blob authority",
      );
    }
    if (row.state === "ready" && row.kind === "image") {
      const canonical = byPath.get("normalized/canonical.png");
      const preview = byPath.get("normalized/preview.png");
      if (
        byPath.size !== 2
        || canonical === undefined
        || preview === undefined
        || row.source_retained !== 0
        || row.canonical_bytes !== canonical.bytes
        || row.canonical_sha256 !== canonical.sha256
        || row.provider_bytes !== canonical.bytes
        || row.provider_sha256 !== canonical.sha256
        || row.preview_bytes !== preview.bytes
        || row.preview_sha256 !== preview.sha256
      ) throw attachmentInventoryNotQuiescent();
      assertAndAccumulateReadyAttachmentBytes(
        row.pane_id,
        canonical.bytes + preview.bytes,
        readyBytesByPane,
        globalReadyBytes,
      );
      globalReadyBytes += canonical.bytes + preview.bytes;
      continue;
    }
    if (row.state === "ready" && row.kind === "file") {
      const blob = byPath.get(`blob.${row.internal_suffix}`);
      if (
        byPath.size !== 1
        || blob === undefined
        || row.source_retained !== 0
        || row.provider_bytes !== blob.bytes
        || row.provider_sha256 !== blob.sha256
      ) throw attachmentInventoryNotQuiescent();
      assertAndAccumulateReadyAttachmentBytes(
        row.pane_id,
        blob.bytes,
        readyBytesByPane,
        globalReadyBytes,
      );
      globalReadyBytes += blob.bytes;
      continue;
    }
    throw attachmentInventoryNotQuiescent();
  }
}

function assertAndAccumulateReadyAttachmentBytes(
  paneId: string,
  addedBytes: number,
  readyBytesByPane: Map<string, number>,
  globalBefore: number,
): void {
  const paneBytes = (readyBytesByPane.get(paneId) ?? 0) + addedBytes;
  const globalBytes = globalBefore + addedBytes;
  if (
    !Number.isSafeInteger(paneBytes)
    || !Number.isSafeInteger(globalBytes)
    || paneBytes > CHAT_ATTACHMENT_MAX_PANE_READY_BYTES
    || globalBytes > CHAT_ATTACHMENT_MAX_GLOBAL_READY_BYTES
  ) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The attachment vault exceeds its runtime byte quota",
    );
  }
  readyBytesByPane.set(paneId, paneBytes);
}

function attachmentInventoryNotQuiescent(): ControlPlaneBackupError {
  return new ControlPlaneBackupError(
    "invalid_input",
    "The attachment vault must finish reconciliation before backup",
  );
}

function copyPortableDatabaseSnapshot(
  source: Uint8Array,
  releaseIdentity: AppReleaseIdentity,
  operationReceiptKey: Uint8Array,
  sourceDatabaseSha256: string,
  attachmentVaultGenerationSha256: string,
  now: Date,
  onMemoryOwnershipCheckpoint?: (ownedDatabaseImages: number) => void,
): Readonly<{
  databaseBytes: Uint8Array;
  attestation: PortableProviderContextProjectionAttestation;
}> {
  const proof = inspectSnapshot(source, releaseIdentity);
  proof.database.close();
  let databaseBytes: Uint8Array | null = null;
  try {
    const portable = projectPortableProviderContext({
      sourceDatabaseBytes: source,
      operationReceiptKey,
      sourceDatabaseSha256,
      attachmentVaultGenerationSha256,
      now,
    });
    databaseBytes = normalizeSerializedSnapshot(portable.databaseBytes);
    onMemoryOwnershipCheckpoint?.(maximumControlPlaneBackupOwnedDatabaseImages);
    const ownedDatabaseBytes = databaseBytes;
    databaseBytes = null;
    return {
      databaseBytes: ownedDatabaseBytes,
      attestation: portable.attestation,
    };
  } catch (error: unknown) {
    if (!(error instanceof PortableProviderContextProjectionError)) throw error;
    throw new ControlPlaneBackupError(
      "invalid_input",
      `The control-plane database is not portable: ${error.message}`,
    );
  } finally {
    databaseBytes?.fill(0);
  }
}

function inspectSnapshot(
  databaseBytes: Uint8Array,
  releaseIdentity: AppReleaseIdentity,
): Readonly<{
  database: Database;
  migrationVersion: number;
  releaseState: AppReleaseCompatibilityState | null;
}> {
  let database: Database | null = null;
  try {
    database = Database.deserialize(databaseBytes, { strict: true });
    configureForeignSnapshotDatabase(database);
    assertBackupIntegrity(database, "Serialized control-plane snapshot", "invalid_archive");
    const compatible = assertCompatibleControlPlaneDatabase(database, releaseIdentity);
    return {
      database,
      migrationVersion: compatible.migrationVersion,
      releaseState: compatible.state,
    };
  } catch (error: unknown) {
    database?.close();
    if (error instanceof ControlPlaneBackupError) throw error;
    throw new ControlPlaneBackupError(
      "incompatible_backup",
      `The serialized control-plane snapshot is incompatible: ${errorMessage(error)}`,
    );
  }
}

function configureForeignSnapshotDatabase(database: Database): void {
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA foreign_keys = ON");
  const trustedSchema: unknown = database.query("PRAGMA trusted_schema").get();
  const foreignKeys: unknown = database.query("PRAGMA foreign_keys").get();
  if (
    !isSinglePragmaValue(trustedSchema, "trusted_schema", 0)
    || !isSinglePragmaValue(foreignKeys, "foreign_keys", 1)
  ) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "The foreign backup database safety pragmas could not be enforced",
    );
  }
}

function isSinglePragmaValue(
  value: unknown,
  key: string,
  expected: number,
): boolean {
  return typeof value === "object"
    && value !== null
    && key in value
    && (value as Record<string, unknown>)[key] === expected;
}

function normalizeSerializedSnapshot(value: Uint8Array): Uint8Array {
  const bytes = value;
  const sqliteMagic = Buffer.from("SQLite format 3\u0000", "binary");
  if (
    bytes.byteLength < 100
    || !timingSafeEqual(bytes.subarray(0, sqliteMagic.byteLength), sqliteMagic)
    || (bytes[18] !== 1 && bytes[18] !== 2)
    || (bytes[19] !== 1 && bytes[19] !== 2)
  ) {
    bytes.fill(0);
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Serialized control-plane header is invalid",
    );
  }
  // sqlite3_serialize returns a complete checkpointed image, but preserves the
  // source file's WAL read/write-version bytes. An in-memory or restored
  // standalone image has no WAL sidecar, so normalize only those two header
  // bytes to the rollback-journal representation before validation/encryption.
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}

function checkpointAndCheck(database: Database): Readonly<{
  busy: 0;
  log: number;
  checkpointed: number;
}> {
  const checkpointValue: unknown = database.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  let checkpoint: z.infer<typeof checkpointSchema>;
  try {
    checkpoint = checkpointSchema.parse(checkpointValue);
  } catch {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The source database returned an invalid checkpoint proof",
    );
  }
  const deleteJournal = checkpoint.log === -1 && checkpoint.checkpointed === -1;
  const completeWal = checkpoint.log >= 0
    && checkpoint.checkpointed >= 0
    && checkpoint.log === checkpoint.checkpointed;
  if (checkpoint.busy !== 0 || (!deleteJournal && !completeWal)) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The source database could not be checkpointed completely",
    );
  }
  assertBackupIntegrity(database, "Source control-plane database", "invalid_input");
  return {
    busy: 0,
    log: checkpoint.log,
    checkpointed: checkpoint.checkpointed,
  };
}

function assertDatabaseSerializationBound(database: Database): void {
  let pageCount: z.infer<typeof pageCountSchema>;
  let pageSize: z.infer<typeof pageSizeSchema>;
  try {
    pageCount = pageCountSchema.parse(database.query("PRAGMA page_count").get());
    pageSize = pageSizeSchema.parse(database.query("PRAGMA page_size").get());
  } catch {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The source database returned invalid size metadata",
    );
  }
  const byteLength = pageCount.page_count * pageSize.page_size;
  if (
    !Number.isSafeInteger(byteLength)
    || byteLength <= 0
    || byteLength > maximumDatabaseByteLength
  ) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The control-plane database exceeds the portable backup bound",
    );
  }
}

function assertBackupIntegrity(
  database: Database,
  label: string,
  code: "invalid_archive" | "invalid_input",
): void {
  try {
    assertBoundedControlPlaneIntegrity(database);
  } catch (error: unknown) {
    if (!(error instanceof ControlPlaneIntegrityError)) throw error;
    throw new ControlPlaneBackupError(
      code,
      `${label} failed its bounded integrity check`,
    );
  }
}

function hashSchema(database: Database): string {
  const values: unknown[] = database.query(`
    SELECT type, name, tbl_name AS table_name, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL
    ORDER BY type, name
  `).all();
  let rows: z.infer<typeof schemaObjectRowsSchema>;
  try {
    rows = schemaObjectRowsSchema.parse(values);
  } catch {
    throw new ControlPlaneBackupError("invalid_archive", "SQLite schema rows are invalid");
  }
  return sha256(Buffer.from(JSON.stringify(rows), "utf8"));
}

function hashMigrationHistory(database: Database): string {
  const values: unknown[] = database.query(`
    SELECT version, name, checksum
    FROM schema_migrations
    ORDER BY version
  `).all();
  let rows: z.infer<typeof migrationRowsSchema>;
  try {
    rows = migrationRowsSchema.parse(values);
  } catch {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "SQLite migration history rows are invalid",
    );
  }
  return sha256(Buffer.from(JSON.stringify(rows), "utf8"));
}

function sourceBindingPreimage(input: {
  readonly sourceDatabaseSha256: string;
  readonly projectedDatabaseSha256: string;
  readonly schemaSha256: string;
  readonly migrationHistorySha256: string;
  readonly attachmentVaultGenerationSha256: string;
  readonly migrationVersion: number;
  readonly sourceRelease: AppReleaseIdentity;
  readonly portableProviderContext:
    PortableProviderContextProjectionAttestation;
}): Uint8Array {
  return Buffer.from(JSON.stringify({
    kind: "hraness-kitchen-control-plane-source-binding",
    version: 2,
    sourceDatabaseSha256: input.sourceDatabaseSha256,
    projectedDatabaseSha256: input.projectedDatabaseSha256,
    schemaSha256: input.schemaSha256,
    migrationHistorySha256: input.migrationHistorySha256,
    attachmentVaultGenerationSha256:
      input.attachmentVaultGenerationSha256,
    migrationVersion: input.migrationVersion,
    sourceRelease: input.sourceRelease,
    portableProviderContext: input.portableProviderContext,
  }), "utf8");
}

function parseAttachmentVaultPayloadManifest(
  value: unknown,
): AttachmentVaultPayloadManifest {
  let parsed: AttachmentVaultPayloadManifest;
  try {
    parsed = attachmentVaultPayloadManifestSchema.parse(value);
  } catch {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Attachment backup manifest is invalid",
    );
  }
  const sortedPaths = parsed.blobs.map((blob) => blob.relativePath).sort();
  if (
    new Set(sortedPaths).size !== sortedPaths.length
    || sortedPaths.some((path, index) => path !== parsed.blobs[index]?.relativePath)
    || parsed.blobs.reduce((total, blob) => total + blob.bytes, 0)
      !== parsed.totalBytes
  ) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Attachment backup inventory is not canonical",
    );
  }
  const expectedGeneration = sha256(Buffer.from(JSON.stringify({
    version: 1,
    blobs: parsed.blobs,
    totalBytes: parsed.totalBytes,
  }), "utf8"));
  if (!safeHexEqual(expectedGeneration, parsed.generationSha256)) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Attachment backup generation hash is invalid",
    );
  }
  return parsed;
}

interface StreamedPayloadStagePaths {
  readonly parent: string;
  readonly database: string;
  readonly receiptKey: string;
  readonly attachmentVault: string;
}

interface StreamedPayloadStage {
  readonly databaseSha256: string;
  readonly receiptKey: Uint8Array;
  readonly attachmentVaultManifest: AttachmentVaultPayloadManifest;
  readonly parentIdentity: Readonly<{ dev: number; ino: number }>;
  readDatabaseBytes(): Uint8Array;
  readReceiptKeyBytes(): Uint8Array;
  inspectAttachmentVault(): ReturnType<
    typeof inspectControlPlaneAttachmentVault
  >;
  readRestoreJournal(
    phase: RestoreJournal["phase"],
    expected: RestoreJournalBinding,
  ): void;
  assertRecoverableRestoreJournal(expected: RestoreJournalBinding): void;
  assertPublishedRestoreTargets(): void;
  assertRestoreTargetsDoNotRetainPublishedStage(): void;
  cleanup(): void;
  abandon(): void;
  release(): void;
}

interface StreamingPayloadParser {
  consume(bytes: Uint8Array): void;
  finishAuthenticated(): StreamedPayloadStage;
  cleanup(): void;
  abandon(): void;
}

function cleanupFailedStreamingStage(
  owner: Readonly<{ cleanup(): void; abandon(): void }>,
): Error | null {
  let cleanupFailure: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      owner.cleanup();
      return null;
    } catch (error: unknown) {
      cleanupFailure = controlPlaneFailure(
        error,
        "Streaming restore-stage cleanup failed",
      );
    }
  }
  try {
    owner.abandon();
  } catch (error: unknown) {
    cleanupFailure = controlPlaneFailure(
      error,
      "Streaming restore-stage authority could not be abandoned safely",
    );
  }
  return cleanupFailure;
}

function createStreamingPayloadParser(
  outerManifest: ControlPlaneBackupManifest,
  paths: StreamedPayloadStagePaths,
  parentDirectory: BoundPublicationDirectory,
  stageCustodyNonce: string,
  onStageCheckpoint?: PrepareControlPlaneRestoreStageInput["onStageCheckpoint"],
): StreamingPayloadParser {
  parentDirectory.assertStable();
  for (const path of [paths.database, paths.receiptKey, paths.attachmentVault]) {
    const descriptor = parentDirectory.tryOpenFile(
      basename(path),
      protectedReadFlags,
      0,
    );
    if (descriptor !== null) {
      closeSync(descriptor);
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "Streaming backup stage already exists",
      );
    }
  }
  const databaseName = basename(paths.database);
  const receiptKeyName = basename(paths.receiptKey);
  const vaultName = basename(paths.attachmentVault);
  if (
    dirname(paths.database) !== paths.parent
    || dirname(paths.receiptKey) !== paths.parent
    || dirname(paths.attachmentVault) !== paths.parent
  ) {
    parentDirectory.close();
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Streaming restore stages must be fixed children of the restore root",
    );
  }
  const stageCustody = bindControlPlaneRestoreStageCustody();
  const prefixByteLength = payloadMagic.byteLength
    + payloadLengthPrefixByteLength
    + vaultManifestLengthPrefixByteLength;
  const prefix = Buffer.alloc(prefixByteLength);
  let prefixOffset = 0;
  const keyBytes = Buffer.alloc(operationReceiptKeyByteLength);
  let keyOffset = 0;
  let databaseRemaining = 0;
  let databaseDescriptor: number | null = null;
  const databaseDigest = createHash("sha256");
  let databaseSha256: string | null = null;
  let vaultManifestBytes: Buffer | null = null;
  let vaultManifestOffset = 0;
  let vaultManifest: AttachmentVaultPayloadManifest | null = null;
  let section: "prefix" | "key" | "database" | "vault_manifest" | "blobs" | "done" =
    "prefix";
  let blobIndex = 0;
  let blobDescriptor: number | null = null;
  let blobRemaining = 0;
  let blobDigest: ReturnType<typeof createHash> | null = null;
  let activeBlob: z.infer<typeof attachmentVaultBlobSchema> | null = null;
  let totalConsumed = 0;
  let authenticated = false;
  let cleaned = false;
  let released = false;
  const createdFiles: Array<Readonly<{
    components: readonly string[];
    identity: Stats;
    descriptor: number;
  }>> = [];
  const createdDirectories: Array<Readonly<{
    components: readonly string[];
    identity: Stats;
  }>> = [];
  const removedCreatedFiles = new Set<string>();
  const removedCreatedDirectories = new Set<string>();
  const closedCreatedFileDescriptors = new Set<number>();
  let currentObjectRoot: string | null = null;
  let currentNormalizedRoot: string | null = null;
  let vaultDirectory: BoundPublicationDirectory | null = null;
  let objectsDirectory: BoundPublicationDirectory | null = null;
  let objectDirectory: BoundPublicationDirectory | null = null;
  let normalizedDirectory: BoundPublicationDirectory | null = null;

  const openStageFile = (
    directory: BoundPublicationDirectory,
    name: string,
    components: readonly string[],
  ): number => {
    const descriptor = directory.openFile(
      name,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | constants.O_NOFOLLOW | closeOnExecFlag,
      0o600,
    );
    try {
      onStageCheckpoint?.("after_stage_file_created_before_validation");
      fchmodSync(descriptor, 0o600);
      const identity = fstatSync(descriptor);
      if (
        !identity.isFile()
        || identity.nlink !== 1
        || identity.dev !== directory.identity.dev
        || (identity.mode & 0o777) !== 0o600
      ) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Streaming backup stage file is unsafe",
        );
      }
      stageCustody.seal(descriptor, stageCustodyNonce);
      createdFiles.push({ components, identity, descriptor });
      return descriptor;
    } catch (error: unknown) {
      try {
        ftruncateSync(descriptor, 0);
        fsyncSync(descriptor);
      } catch {
        // Preserve the construction failure; journal recovery owns residue.
      }
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the construction failure.
      }
      throw error;
    }
  };
  const writeStageBytes = (descriptor: number, bytes: Uint8Array): void => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
      );
      if (written <= 0) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Streaming backup stage write was incomplete",
        );
      }
      offset += written;
    }
  };
  const readCreatedFile = (
    name: string,
    identity: Stats,
    maximumBytes: number,
    label: string,
  ): Uint8Array => {
    parentDirectory.assertStable();
    const descriptor = parentDirectory.openFile(name, protectedReadFlags, 0);
    let bytes: Uint8Array | null = null;
    try {
      const before = fstatSync(descriptor);
      const currentUser = process.getuid?.();
      if (
        !before.isFile()
        || before.nlink !== 1
        || before.dev !== identity.dev
        || before.ino !== identity.ino
        || before.size <= 0
        || before.size > maximumBytes
        || (before.mode & 0o777) !== 0o600
        || (currentUser !== undefined && before.uid !== currentUser)
      ) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          `${label} stage identity changed`,
        );
      }
      bytes = Uint8Array.from(readFileSync(descriptor));
      const after = fstatSync(descriptor);
      if (
        after.dev !== before.dev
        || after.ino !== before.ino
        || after.nlink !== before.nlink
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
      ) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          `${label} stage changed while it was read`,
        );
      }
      parentDirectory.assertStable();
      const result = bytes;
      bytes = null;
      return result;
    } finally {
      bytes?.fill(0);
      closeSync(descriptor);
    }
  };
  const closeDatabase = (): void => {
    if (databaseDescriptor === null) return;
    fchmodSync(databaseDescriptor, 0o600);
    fsyncSync(databaseDescriptor);
    databaseDescriptor = null;
    databaseSha256 = databaseDigest.digest("hex");
    onStageCheckpoint?.("after_database_staged");
  };
  const finishBlob = (): void => {
    if (activeBlob === null || blobDigest === null) return;
    if (blobDescriptor === null) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Attachment blob stage lost its descriptor",
      );
    }
    fchmodSync(blobDescriptor, 0o600);
    fsyncSync(blobDescriptor);
    blobDescriptor = null;
    const digest = blobDigest.digest("hex");
    if (!safeHexEqual(digest, activeBlob.sha256)) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Attachment backup blob hash is invalid",
      );
    }
    activeBlob = null;
    blobDigest = null;
    blobIndex += 1;
    onStageCheckpoint?.("after_attachment_blob_staged");
  };
  const createStageDirectory = (
    parent: BoundPublicationDirectory,
    name: string,
    path: string,
    components: readonly string[],
  ): BoundPublicationDirectory => {
    parent.makeDirectory(name, 0o700);
    onStageCheckpoint?.("after_stage_directory_created_before_bind");
    // Never remove a name after losing the created directory identity. The
    // durable materializing journal retains exact recovery custody.
    const directory = bindPublicationDirectoryAt(parent, name, path);
    if ((directory.identity.mode & 0o777) !== 0o700) {
      directory.close();
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Streaming backup stage directory is unsafe",
      );
    }
    stageCustody.seal(directory.descriptor, stageCustodyNonce);
    createdDirectories.push({ components, identity: directory.identity });
    return directory;
  };
  const closeActiveObjectDirectories = (): void => {
    if (normalizedDirectory !== null) {
      normalizedDirectory.sync();
      normalizedDirectory.close();
      normalizedDirectory = null;
    }
    if (objectDirectory !== null) {
      objectDirectory.sync();
      objectDirectory.close();
      objectDirectory = null;
    }
  };
  const startBlob = (): void => {
    if (vaultManifest === null) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Attachment manifest was not parsed before blob staging",
      );
    }
    const blob = vaultManifest.blobs[blobIndex];
    if (blob === undefined) {
      section = "done";
      return;
    }
    if (currentObjectRoot === null || !blob.relativePath.startsWith(
      `${basename(currentObjectRoot)}/`,
    )) {
      closeActiveObjectDirectories();
      if (objectsDirectory === null) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Attachment object stage is not open",
        );
      }
      currentObjectRoot = join(
        paths.attachmentVault,
        "objects",
        blob.attachmentId,
      );
      objectDirectory = createStageDirectory(
        objectsDirectory,
        blob.attachmentId,
        currentObjectRoot,
        [vaultName, "objects", blob.attachmentId],
      );
      currentNormalizedRoot = null;
    }
    const relativeSuffix = blob.relativePath.slice(blob.attachmentId.length + 1);
    let blobPath: string;
    if (relativeSuffix.startsWith("normalized/")) {
      if (currentNormalizedRoot === null) {
        if (objectDirectory === null) {
          throw new ControlPlaneBackupError(
            "invalid_archive",
            "Attachment object stage is not open",
          );
        }
        currentNormalizedRoot = join(currentObjectRoot, "normalized");
        normalizedDirectory = createStageDirectory(
          objectDirectory,
          "normalized",
          currentNormalizedRoot,
          [vaultName, "objects", blob.attachmentId, "normalized"],
        );
      }
      blobPath = basename(relativeSuffix);
    } else {
      blobPath = relativeSuffix;
    }
    activeBlob = blob;
    blobRemaining = blob.bytes;
    blobDigest = createHash("sha256");
    const blobParent = relativeSuffix.startsWith("normalized/")
      ? normalizedDirectory
      : objectDirectory;
    if (blobParent === null) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Attachment blob stage parent is not open",
      );
    }
    blobDescriptor = openStageFile(
      blobParent,
      blobPath,
      [vaultName, "objects", blob.attachmentId, ...relativeSuffix.split("/")],
    );
  };
  const parsePrefix = (): void => {
    if (!timingSafeEqual(prefix.subarray(0, payloadMagic.byteLength), payloadMagic)) {
      throw new ControlPlaneBackupError("invalid_archive", "Backup payload magic is invalid");
    }
    const databaseLength = Number(prefix.readBigUInt64BE(payloadMagic.byteLength));
    const manifestLength = prefix.readUInt32BE(
      payloadMagic.byteLength + payloadLengthPrefixByteLength,
    );
    const fixedLength = prefixByteLength
      + operationReceiptKeyByteLength
      + databaseLength
      + manifestLength;
    if (
      !Number.isSafeInteger(databaseLength)
      || databaseLength <= 0
      || databaseLength > maximumDatabaseByteLength
      || manifestLength <= 0
      || manifestLength > maximumVaultManifestByteLength
      || !Number.isSafeInteger(fixedLength)
      || fixedLength > outerManifest.payloadByteLength
    ) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Backup payload section lengths are invalid",
      );
    }
    databaseRemaining = databaseLength;
    vaultManifestBytes = Buffer.alloc(manifestLength);
    section = "key";
  };
  const parseVaultManifest = (): void => {
    if (vaultManifestBytes === null) {
      throw new ControlPlaneBackupError("invalid_archive", "Attachment manifest is missing");
    }
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(vaultManifestBytes),
      );
      vaultManifest = parseAttachmentVaultPayloadManifest(value);
    } catch (error: unknown) {
      if (error instanceof ControlPlaneBackupError) throw error;
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Attachment backup manifest is invalid",
      );
    }
    const expectedPayloadLength = prefixByteLength
      + operationReceiptKeyByteLength
      + (Number(prefix.readBigUInt64BE(payloadMagic.byteLength)))
      + vaultManifestBytes.byteLength
      + vaultManifest.totalBytes;
    if (
      expectedPayloadLength !== outerManifest.payloadByteLength
      || vaultManifest.blobs.length !== outerManifest.attachmentVault.blobCount
      || vaultManifest.totalBytes !== outerManifest.attachmentVault.totalBytes
      || !safeHexEqual(
        vaultManifest.generationSha256,
        outerManifest.sourceHashes.attachmentVaultGenerationSha256,
      )
    ) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Backup attachment-vault framing proof is invalid",
      );
    }
    vaultDirectory = createStageDirectory(
      parentDirectory,
      vaultName,
      paths.attachmentVault,
      [vaultName],
    );
    objectsDirectory = createStageDirectory(
      vaultDirectory,
      "objects",
      join(paths.attachmentVault, "objects"),
      [vaultName, "objects"],
    );
    section = "blobs";
  };
  const advance = (): void => {
    while (true) {
      if (section === "prefix" && prefixOffset === prefix.byteLength) {
        parsePrefix();
        continue;
      }
      if (section === "key" && keyOffset === keyBytes.byteLength) {
        const keyDescriptor = openStageFile(
          parentDirectory,
          receiptKeyName,
          [receiptKeyName],
        );
        writeStageBytes(keyDescriptor, keyBytes);
        fchmodSync(keyDescriptor, 0o600);
        fsyncSync(keyDescriptor);
        onStageCheckpoint?.("after_receipt_key_staged");
        databaseDescriptor = openStageFile(
          parentDirectory,
          databaseName,
          [databaseName],
        );
        section = "database";
        continue;
      }
      if (section === "database" && databaseRemaining === 0) {
        closeDatabase();
        section = "vault_manifest";
        continue;
      }
      if (
        section === "vault_manifest"
        && vaultManifestBytes !== null
        && vaultManifestOffset === vaultManifestBytes.byteLength
      ) {
        parseVaultManifest();
        continue;
      }
      if (section === "blobs") {
        if (activeBlob !== null && blobRemaining === 0) {
          finishBlob();
          continue;
        }
        if (activeBlob === null) {
          startBlob();
          continue;
        }
      }
      return;
    }
  };

  const consume = (bytes: Uint8Array): void => {
    if (authenticated || cleaned) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Backup payload parser is already terminal",
      );
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      advance();
      if (section === "done") {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Backup payload contains trailing plaintext",
        );
      }
      if (section === "prefix") {
        const length = Math.min(prefix.byteLength - prefixOffset, bytes.byteLength - offset);
        prefix.set(bytes.subarray(offset, offset + length), prefixOffset);
        prefixOffset += length;
        offset += length;
      } else if (section === "key") {
        const length = Math.min(keyBytes.byteLength - keyOffset, bytes.byteLength - offset);
        keyBytes.set(bytes.subarray(offset, offset + length), keyOffset);
        keyOffset += length;
        offset += length;
      } else if (section === "database") {
        if (databaseDescriptor === null) {
          throw new ControlPlaneBackupError("invalid_archive", "Database stage is not open");
        }
        const length = Math.min(databaseRemaining, bytes.byteLength - offset);
        const chunk = bytes.subarray(offset, offset + length);
        writeStageBytes(databaseDescriptor, chunk);
        databaseDigest.update(chunk);
        databaseRemaining -= length;
        offset += length;
      } else if (section === "vault_manifest") {
        if (vaultManifestBytes === null) {
          throw new ControlPlaneBackupError("invalid_archive", "Attachment manifest is missing");
        }
        const length = Math.min(
          vaultManifestBytes.byteLength - vaultManifestOffset,
          bytes.byteLength - offset,
        );
        vaultManifestBytes.set(
          bytes.subarray(offset, offset + length),
          vaultManifestOffset,
        );
        vaultManifestOffset += length;
        offset += length;
      } else if (section === "blobs") {
        if (blobDescriptor === null || blobDigest === null || activeBlob === null) {
          throw new ControlPlaneBackupError("invalid_archive", "Attachment blob stage is not open");
        }
        const length = Math.min(blobRemaining, bytes.byteLength - offset);
        const chunk = bytes.subarray(offset, offset + length);
        writeStageBytes(blobDescriptor, chunk);
        blobDigest.update(chunk);
        blobRemaining -= length;
        offset += length;
      }
    }
    totalConsumed += bytes.byteLength;
    if (totalConsumed > outerManifest.payloadByteLength) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Backup plaintext exceeded its manifest length",
      );
    }
    advance();
  };

  const closeNestedDirectories = (): void => {
    let firstFailure: unknown = null;
    const syncAndClose = (directory: BoundPublicationDirectory | null): void => {
      if (directory === null) return;
      try {
        directory.sync();
      } catch (error: unknown) {
        if (firstFailure === null) firstFailure = error;
      } finally {
        try {
          directory.close();
        } catch (error: unknown) {
          if (firstFailure === null) firstFailure = error;
        }
      }
    };
    syncAndClose(normalizedDirectory);
    normalizedDirectory = null;
    syncAndClose(objectDirectory);
    objectDirectory = null;
    syncAndClose(objectsDirectory);
    objectsDirectory = null;
    syncAndClose(vaultDirectory);
    vaultDirectory = null;
    if (firstFailure !== null) {
      throwControlPlaneFailure(
        firstFailure,
        "Streaming restore-stage directories could not be closed safely",
      );
    }
  };
  const withRelativeParent = <T>(
    components: readonly string[],
    operation: (directory: BoundPublicationDirectory) => T,
  ): T => {
    let directory = parentDirectory;
    const opened: BoundPublicationDirectory[] = [];
    let currentPath = paths.parent;
    try {
      for (const component of components) {
        currentPath = join(currentPath, component);
        const child = bindPublicationDirectoryAt(
          directory,
          component,
          currentPath,
        );
        opened.push(child);
        directory = child;
      }
      return operation(directory);
    } finally {
      for (const child of opened.reverse()) child.close();
    }
  };
  const zeroRetainedCreatedFiles = (): void => {
    let firstFailure: unknown = null;
    for (const record of createdFiles) {
      if (closedCreatedFileDescriptors.has(record.descriptor)) continue;
      try {
        const metadata = fstatSync(record.descriptor);
        if (
          !metadata.isFile()
          || metadata.dev !== record.identity.dev
          || metadata.ino !== record.identity.ino
        ) {
          throw new ControlPlaneBackupError(
            "unsafe_path",
            "Streaming backup stage descriptor identity changed",
          );
        }
        ftruncateSync(record.descriptor, 0);
        fsyncSync(record.descriptor);
      } catch (error: unknown) {
        if (firstFailure === null) firstFailure = error;
      }
    }
    if (firstFailure !== null) {
      throwControlPlaneFailure(
        firstFailure,
        "Streaming restore-stage files could not be scrubbed safely",
      );
    }
  };
  const closeRetainedCreatedFiles = (): void => {
    let firstFailure: unknown = null;
    for (const record of createdFiles) {
      if (closedCreatedFileDescriptors.has(record.descriptor)) continue;
      try {
        closeSync(record.descriptor);
        closedCreatedFileDescriptors.add(record.descriptor);
      } catch (error: unknown) {
        if (firstFailure === null) firstFailure = error;
      }
    }
    if (firstFailure !== null) {
      throwControlPlaneFailure(
        firstFailure,
        "Streaming restore-stage files could not be closed safely",
      );
    }
  };
  const removeCreatedFile = (record: Readonly<{
    components: readonly string[];
    identity: Stats;
    descriptor: number;
  }>): void => {
    const recordKey = record.components.join("\0");
    if (removedCreatedFiles.has(recordKey)) return;
    const parentComponents = record.components.slice(0, -1);
    const name = record.components.at(-1);
    if (name === undefined) return;
    withRelativeParent(parentComponents, (directory) => {
      const descriptor = directory.tryOpenFile(
        name,
        protectedReadFlags,
        0,
      );
      if (descriptor === null) {
        if (fstatSync(record.descriptor).nlink === 0) {
          removedCreatedFiles.add(recordKey);
          return;
        }
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Streaming backup stage file moved before cleanup",
        );
      }
      let metadata: Stats;
      try {
        metadata = fstatSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      if (
        !metadata.isFile()
        || metadata.nlink !== 1
        || metadata.dev !== record.identity.dev
        || metadata.ino !== record.identity.ino
      ) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Streaming backup stage file identity changed during cleanup",
        );
      }
      directory.unlink(name);
      removedCreatedFiles.add(recordKey);
      directory.sync();
    });
  };
  const removeCreatedDirectory = (record: Readonly<{
    components: readonly string[];
    identity: Stats;
  }>): void => {
    const recordKey = record.components.join("\0");
    if (removedCreatedDirectories.has(recordKey)) return;
    const parentComponents = record.components.slice(0, -1);
    const name = record.components.at(-1);
    if (name === undefined) return;
    withRelativeParent(parentComponents, (directory) => {
      const descriptor = directory.tryOpenFile(
        name,
        protectedDirectoryReadFlags,
        0,
      );
      if (descriptor === null) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Streaming backup stage directory disappeared before cleanup",
        );
      }
      let metadata: Stats;
      try {
        metadata = fstatSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      if (
        !metadata.isDirectory()
        || metadata.dev !== record.identity.dev
        || metadata.ino !== record.identity.ino
      ) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Streaming backup stage directory identity changed during cleanup",
        );
      }
      directory.removeDirectory(name);
      removedCreatedDirectories.add(recordKey);
      directory.sync();
    });
  };
  const cleanup = (): void => {
    if (cleaned) return;
    let firstFailure: unknown = null;
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error: unknown) {
        if (firstFailure === null) firstFailure = error;
      }
    };
    databaseDescriptor = null;
    blobDescriptor = null;
    attempt(closeNestedDirectories);
    prefix.fill(0);
    keyBytes.fill(0);
    vaultManifestBytes?.fill(0);
    attempt(zeroRetainedCreatedFiles);
    for (const record of [...createdFiles].reverse()) {
      attempt(() => removeCreatedFile(record));
    }
    for (const record of [...createdDirectories].reverse()) {
      attempt(() => removeCreatedDirectory(record));
    }
    attempt(() => parentDirectory.sync());
    if (firstFailure !== null) {
      throwControlPlaneFailure(
        firstFailure,
        "Streaming restore-stage cleanup did not complete safely",
      );
    }
    closeRetainedCreatedFiles();
    stageCustody.close();
    parentDirectory.close();
    cleaned = true;
    released = true;
  };
  const abandon = (): void => {
    if (released) return;
    let firstFailure: unknown = null;
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error: unknown) {
        if (firstFailure === null) firstFailure = error;
      }
    };
    databaseDescriptor = null;
    blobDescriptor = null;
    attempt(closeNestedDirectories);
    prefix.fill(0);
    keyBytes.fill(0);
    vaultManifestBytes?.fill(0);
    attempt(zeroRetainedCreatedFiles);
    attempt(closeRetainedCreatedFiles);
    attempt(() => stageCustody.close());
    attempt(() => parentDirectory.close());
    released = true;
    cleaned = true;
    if (firstFailure !== null) {
      throwControlPlaneFailure(
        firstFailure,
        "Streaming restore-stage authority could not be released safely",
      );
    }
  };

  return {
    consume,
    finishAuthenticated() {
      advance();
      if (
        totalConsumed !== outerManifest.payloadByteLength
        || section !== "done"
        || databaseSha256 === null
        || vaultManifest === null
      ) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Backup plaintext ended before every framed section",
        );
      }
      closeNestedDirectories();
      parentDirectory.sync();
      authenticated = true;
      let receiptKeyOwner: Uint8Array | null = null;
      try {
        receiptKeyOwner = Uint8Array.from(keyBytes);
        prefix.fill(0);
        keyBytes.fill(0);
        vaultManifestBytes?.fill(0);
        const receiptKey = receiptKeyOwner;
        const release = (): void => {
          if (released) return;
          receiptKey.fill(0);
          try {
            closeRetainedCreatedFiles();
          } finally {
            try {
              stageCustody.close();
            } finally {
              parentDirectory.close();
            }
          }
          released = true;
          cleaned = true;
        };
        const databaseIdentity = createdFiles.find(({ components }) =>
          components.length === 1 && components[0] === databaseName
        )?.identity;
        const receiptKeyIdentity = createdFiles.find(({ components }) =>
          components.length === 1 && components[0] === receiptKeyName
        )?.identity;
        const vaultIdentity = createdDirectories.find(({ components }) =>
          components.length === 1 && components[0] === vaultName
        )?.identity;
        if (
          databaseIdentity === undefined
          || receiptKeyIdentity === undefined
          || vaultIdentity === undefined
        ) {
          throw new ControlPlaneBackupError(
            "invalid_archive",
            "Authenticated restore stage identity is incomplete",
          );
        }
        const authenticatedVaultManifest = vaultManifest;
        const result: StreamedPayloadStage = {
          databaseSha256,
          receiptKey,
          attachmentVaultManifest: authenticatedVaultManifest,
          parentIdentity: {
            dev: parentDirectory.identity.dev,
            ino: parentDirectory.identity.ino,
          },
          readDatabaseBytes() {
            return readCreatedFile(
              databaseName,
              databaseIdentity,
              maximumDatabaseByteLength,
              "database",
            );
          },
          readReceiptKeyBytes() {
            return readCreatedFile(
              receiptKeyName,
              receiptKeyIdentity,
              operationReceiptKeyByteLength,
              "receipt-key",
            );
          },
          inspectAttachmentVault() {
            parentDirectory.assertStable();
            const proof = inspectControlPlaneAttachmentVault(
              paths.attachmentVault,
              { dev: vaultIdentity.dev, ino: vaultIdentity.ino },
            );
            parentDirectory.assertStable();
            return proof;
          },
          readRestoreJournal(phase, expected) {
            assertBoundRestoreJournal(
              readBoundRestoreJournal(
                controlPlaneRestorePaths(join(paths.parent, "control-plane.sqlite")),
                parentDirectory,
              ),
              phase,
              expected,
            );
          },
          assertRecoverableRestoreJournal(expected) {
            const journal = readBoundRestoreJournal(
              controlPlaneRestorePaths(join(paths.parent, "control-plane.sqlite")),
              parentDirectory,
            );
            assertBoundRestoreJournal(journal, journal.phase, expected);
            if (journal.phase === "materializing" || journal.phase === "validated") {
              throw new ControlPlaneBackupError(
                "restore_interrupted",
                "Restore journal does not authorize failed-swap erasure",
              );
            }
          },
          assertPublishedRestoreTargets() {
            const livePaths = controlPlaneRestorePaths(
              join(paths.parent, "control-plane.sqlite"),
            );
            const mapComponents = (
              components: readonly string[],
            ): readonly string[] => {
              const [first, ...rest] = components;
              if (first === databaseName) return [basename(livePaths.database)];
              if (first === receiptKeyName) return [basename(livePaths.receiptKey)];
              if (first === vaultName) {
                return [basename(livePaths.attachmentVault), ...rest];
              }
              throw new ControlPlaneBackupError(
                "restore_interrupted",
                "Retained restore-stage inventory is not publishable",
              );
            };
            parentDirectory.assertStable();
            for (const record of createdDirectories) {
              const mapped = mapComponents(record.components);
              withRelativeParent(mapped, (directory) => {
                if (
                  directory.identity.dev !== record.identity.dev
                  || directory.identity.ino !== record.identity.ino
                ) {
                  throw new ControlPlaneBackupError(
                    "restore_interrupted",
                    "Published attachment directory is not the retained stage inode",
                  );
                }
              });
            }
            for (const record of createdFiles) {
              const mapped = mapComponents(record.components);
              const name = mapped.at(-1);
              if (name === undefined) {
                throw new ControlPlaneBackupError(
                  "restore_interrupted",
                  "Published restore file name is missing",
                );
              }
              withRelativeParent(mapped.slice(0, -1), (directory) => {
                const descriptor = directory.openFile(
                  name,
                  protectedReadFlags,
                  0,
                );
                try {
                  const metadata = fstatSync(descriptor);
                  if (
                    !metadata.isFile()
                    || metadata.nlink !== 1
                    || metadata.dev !== record.identity.dev
                    || metadata.ino !== record.identity.ino
                    || (metadata.mode & 0o777) !== 0o600
                  ) {
                    throw new ControlPlaneBackupError(
                      "restore_interrupted",
                      "Published restore file is not the retained stage inode",
                    );
                  }
                  const originalRoot = record.components[0];
                  const expectedDigest = originalRoot === databaseName
                    ? databaseSha256
                    : originalRoot === receiptKeyName
                    ? sha256(receiptKey)
                    : null;
                  if (expectedDigest !== null) {
                    const expectedSize = originalRoot === receiptKeyName
                      ? operationReceiptKeyByteLength
                      : null;
                    if (
                      metadata.size <= 0
                      || metadata.size > maximumDatabaseByteLength
                      || (expectedSize !== null && metadata.size !== expectedSize)
                    ) {
                      throw new ControlPlaneBackupError(
                        "restore_interrupted",
                        "Published restore file size is invalid",
                      );
                    }
                    const digest = createHash("sha256");
                    const buffer = Buffer.allocUnsafe(
                      maximumControlPlaneBackupStreamingChunkByteLength,
                    );
                    let offset = 0;
                    try {
                      while (offset < metadata.size) {
                        const length = readSync(
                          descriptor,
                          buffer,
                          0,
                          Math.min(buffer.byteLength, metadata.size - offset),
                          offset,
                        );
                        if (length <= 0) {
                          throw new ControlPlaneBackupError(
                            "restore_interrupted",
                            "Published restore file was truncated",
                          );
                        }
                        digest.update(buffer.subarray(0, length));
                        offset += length;
                      }
                    } finally {
                      buffer.fill(0);
                    }
                    const after = fstatSync(descriptor);
                    if (
                      after.dev !== metadata.dev
                      || after.ino !== metadata.ino
                      || after.nlink !== metadata.nlink
                      || after.size !== metadata.size
                      || after.mtimeMs !== metadata.mtimeMs
                      || after.ctimeMs !== metadata.ctimeMs
                      || !safeHexEqual(digest.digest("hex"), expectedDigest)
                    ) {
                      throw new ControlPlaneBackupError(
                        "restore_interrupted",
                        "Published restore file content changed",
                      );
                    }
                  }
                } finally {
                  closeSync(descriptor);
                }
              });
            }
            const liveVaultProof = inspectControlPlaneAttachmentVault(
              livePaths.attachmentVault,
              { dev: vaultIdentity.dev, ino: vaultIdentity.ino },
            );
            if (
              !safeHexEqual(
                liveVaultProof.generationSha256,
                authenticatedVaultManifest.generationSha256,
              )
            ) {
              throw new ControlPlaneBackupError(
                "restore_interrupted",
                "Published attachment vault differs from the retained stage",
              );
            }
            parentDirectory.assertStable();
          },
          assertRestoreTargetsDoNotRetainPublishedStage() {
            const livePaths = controlPlaneRestorePaths(
              join(paths.parent, "control-plane.sqlite"),
            );
            const liveTargets = [
              {
                name: basename(livePaths.database),
                identity: databaseIdentity,
                flags: protectedReadFlags,
              },
              {
                name: basename(livePaths.receiptKey),
                identity: receiptKeyIdentity,
                flags: protectedReadFlags,
              },
              {
                name: basename(livePaths.attachmentVault),
                identity: vaultIdentity,
                flags: protectedDirectoryReadFlags,
              },
            ] as const;
            parentDirectory.assertStable();
            for (const target of liveTargets) {
              const descriptor = parentDirectory.tryOpenFile(
                target.name,
                target.flags,
                0,
              );
              if (descriptor === null) continue;
              try {
                const metadata = fstatSync(descriptor);
                if (
                  metadata.dev === target.identity.dev
                  && metadata.ino === target.identity.ino
                ) {
                  throw new ControlPlaneBackupError(
                    "restore_interrupted",
                    "Rolled-back restore still publishes a retained stage inode",
                  );
                }
              } finally {
                closeSync(descriptor);
              }
            }
            parentDirectory.assertStable();
          },
          cleanup() {
            try {
              cleanup();
            } finally {
              receiptKey.fill(0);
            }
          },
          abandon,
          release,
        };
        receiptKeyOwner = null;
        return result;
      } catch (error: unknown) {
        receiptKeyOwner?.fill(0);
        throw error;
      }
    },
    cleanup,
    abandon,
  };
}

interface VerifiedPayloadMemory {
  readonly operationReceiptKey: Uint8Array;
  readonly databaseBytes: Uint8Array;
  readonly attachmentVaultManifest: AttachmentVaultPayloadManifest;
  readonly attachmentVaultManifestByteLength: number;
  fill(): void;
}

function decodeOpenArchiveToVerifiedMemory(
  archive: OpenEncryptedBackupArchive,
  passphrase: string,
): VerifiedPayloadMemory {
  streamDecryptOpenArchive(archive, passphrase, () => {});
  const prefixLength = payloadMagic.byteLength
    + payloadLengthPrefixByteLength
    + vaultManifestLengthPrefixByteLength;
  const prefix = Buffer.alloc(prefixLength);
  const key = Buffer.alloc(operationReceiptKeyByteLength);
  let prefixOffset = 0;
  let keyOffset = 0;
  let database: Buffer | null = null;
  let databaseOffset = 0;
  let vaultBytes: Buffer | null = null;
  let vaultOffset = 0;
  let vaultManifest: AttachmentVaultPayloadManifest | null = null;
  let blobIndex = 0;
  let blobRemaining = 0;
  let blobDigest: ReturnType<typeof createHash> | null = null;
  let section: "prefix" | "key" | "database" | "manifest" | "blobs" | "done" =
    "prefix";
  let consumed = 0;
  const currentSection = () => section;
  const currentDatabase = () => database;
  const currentVaultBytes = () => vaultBytes;
  const currentVaultManifest = () => vaultManifest;
  let transferredKey: Uint8Array | null = null;
  let transferredDatabase: Uint8Array | null = null;

  const advance = (): void => {
    while (true) {
      if (section === "prefix" && prefixOffset === prefix.byteLength) {
        if (!timingSafeEqual(prefix.subarray(0, payloadMagic.byteLength), payloadMagic)) {
          throw new ControlPlaneBackupError("invalid_archive", "Backup payload magic is invalid");
        }
        const databaseLength = Number(prefix.readBigUInt64BE(payloadMagic.byteLength));
        const manifestLength = prefix.readUInt32BE(
          payloadMagic.byteLength + payloadLengthPrefixByteLength,
        );
        const fixedLength = prefixLength
          + operationReceiptKeyByteLength
          + databaseLength
          + manifestLength;
        if (
          !Number.isSafeInteger(databaseLength)
          || databaseLength <= 0
          || databaseLength > maximumDatabaseByteLength
          || manifestLength <= 0
          || manifestLength > maximumVaultManifestByteLength
          || !Number.isSafeInteger(fixedLength)
          || fixedLength > archive.manifest.payloadByteLength
        ) {
          throw new ControlPlaneBackupError(
            "invalid_archive",
            "Backup payload section lengths are invalid",
          );
        }
        database = Buffer.allocUnsafe(databaseLength);
        vaultBytes = Buffer.alloc(manifestLength);
        section = "key";
        continue;
      }
      if (section === "key" && keyOffset === key.byteLength) {
        section = "database";
        continue;
      }
      if (
        section === "database"
        && database !== null
        && databaseOffset === database.byteLength
      ) {
        section = "manifest";
        continue;
      }
      if (
        section === "manifest"
        && vaultBytes !== null
        && vaultOffset === vaultBytes.byteLength
      ) {
        try {
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(vaultBytes),
          );
          vaultManifest = parseAttachmentVaultPayloadManifest(value);
        } catch (error: unknown) {
          if (error instanceof ControlPlaneBackupError) throw error;
          throw new ControlPlaneBackupError(
            "invalid_archive",
            "Attachment backup manifest is invalid",
          );
        }
        const expectedPayloadLength = prefixLength
          + key.byteLength
          + (database?.byteLength ?? 0)
          + vaultBytes.byteLength
          + vaultManifest.totalBytes;
        if (
          expectedPayloadLength !== archive.manifest.payloadByteLength
          || vaultManifest.blobs.length !== archive.manifest.attachmentVault.blobCount
          || vaultManifest.totalBytes !== archive.manifest.attachmentVault.totalBytes
          || !safeHexEqual(
            vaultManifest.generationSha256,
            archive.manifest.sourceHashes.attachmentVaultGenerationSha256,
          )
        ) {
          throw new ControlPlaneBackupError(
            "invalid_archive",
            "Backup attachment-vault framing proof is invalid",
          );
        }
        section = "blobs";
        continue;
      }
      if (section === "blobs") {
        if (vaultManifest === null) {
          throw new ControlPlaneBackupError("invalid_archive", "Attachment manifest is missing");
        }
        const blob = vaultManifest.blobs[blobIndex];
        if (blob === undefined) {
          section = "done";
          continue;
        }
        if (blobDigest === null) {
          blobDigest = createHash("sha256");
          blobRemaining = blob.bytes;
        }
        if (blobRemaining === 0) {
          const digest = blobDigest.digest("hex");
          blobDigest = null;
          if (!safeHexEqual(digest, blob.sha256)) {
            throw new ControlPlaneBackupError(
              "invalid_archive",
              "Attachment backup blob hash is invalid",
            );
          }
          blobIndex += 1;
          continue;
        }
      }
      return;
    }
  };

  try {
    streamDecryptOpenArchive(archive, passphrase, (bytes) => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        advance();
        if (section === "done") {
          throw new ControlPlaneBackupError(
            "invalid_archive",
            "Backup payload contains trailing plaintext",
          );
        }
        if (section === "prefix") {
          const length = Math.min(prefix.byteLength - prefixOffset, bytes.byteLength - offset);
          prefix.set(bytes.subarray(offset, offset + length), prefixOffset);
          prefixOffset += length;
          offset += length;
        } else if (section === "key") {
          const length = Math.min(key.byteLength - keyOffset, bytes.byteLength - offset);
          key.set(bytes.subarray(offset, offset + length), keyOffset);
          keyOffset += length;
          offset += length;
        } else if (section === "database") {
          if (database === null) {
            throw new ControlPlaneBackupError("invalid_archive", "Backup database is missing");
          }
          const length = Math.min(database.byteLength - databaseOffset, bytes.byteLength - offset);
          database.set(bytes.subarray(offset, offset + length), databaseOffset);
          databaseOffset += length;
          offset += length;
        } else if (section === "manifest") {
          if (vaultBytes === null) {
            throw new ControlPlaneBackupError("invalid_archive", "Attachment manifest is missing");
          }
          const length = Math.min(vaultBytes.byteLength - vaultOffset, bytes.byteLength - offset);
          vaultBytes.set(bytes.subarray(offset, offset + length), vaultOffset);
          vaultOffset += length;
          offset += length;
        } else if (section === "blobs") {
          if (blobDigest === null) advance();
          if (blobDigest === null) continue;
          const length = Math.min(blobRemaining, bytes.byteLength - offset);
          blobDigest.update(bytes.subarray(offset, offset + length));
          blobRemaining -= length;
          offset += length;
        }
      }
      consumed += bytes.byteLength;
      if (consumed > archive.manifest.payloadByteLength) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Backup plaintext exceeded its manifest length",
        );
      }
      advance();
    });
    advance();
    const completedDatabase = currentDatabase();
    const completedVaultManifestByteLength = currentVaultBytes()?.byteLength;
    const completedVaultManifest = currentVaultManifest();
    if (
      consumed !== archive.manifest.payloadByteLength
      || currentSection() !== "done"
      || completedDatabase === null
      || completedVaultManifestByteLength === undefined
      || completedVaultManifest === null
    ) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Backup plaintext ended before every framed section",
      );
    }
    transferredKey = Uint8Array.from(key);
    transferredDatabase = completedDatabase;
    const resultKey = transferredKey;
    const resultDatabase = transferredDatabase;
    const result: VerifiedPayloadMemory = {
      operationReceiptKey: resultKey,
      databaseBytes: resultDatabase,
      attachmentVaultManifest: completedVaultManifest,
      attachmentVaultManifestByteLength: completedVaultManifestByteLength,
      fill() {
        resultKey.fill(0);
        resultDatabase.fill(0);
      },
    };
    key.fill(0);
    prefix.fill(0);
    currentVaultBytes()?.fill(0);
    database = null;
    transferredKey = null;
    transferredDatabase = null;
    return result;
  } catch (error: unknown) {
    transferredKey?.fill(0);
    transferredDatabase?.fill(0);
    currentDatabase()?.fill(0);
    key.fill(0);
    prefix.fill(0);
    currentVaultBytes()?.fill(0);
    throw error;
  }
}

function decryptOpenArchiveToStage(
  archive: OpenEncryptedBackupArchive,
  passphrase: string,
  paths: StreamedPayloadStagePaths,
  parentDirectory: BoundPublicationDirectory,
  stageCustodyNonce: string,
  onStageCheckpoint?: PrepareControlPlaneRestoreStageInput["onStageCheckpoint"],
): StreamedPayloadStage {
  try {
    assertOpenArchiveStable(
      archive.parent,
      archive.name,
      archive.descriptor,
      archive.identity,
    );
    parentDirectory.assertStable();
  } catch (error: unknown) {
    parentDirectory.close();
    throw error;
  }
  let parser: StreamingPayloadParser;
  try {
    parser = createStreamingPayloadParser(
      archive.manifest,
      paths,
      parentDirectory,
      stageCustodyNonce,
      onStageCheckpoint,
    );
  } catch (error: unknown) {
    parentDirectory.close();
    throw error;
  }
  try {
    streamDecryptOpenArchive(
      archive,
      passphrase,
      (plaintext) => parser.consume(plaintext),
    );
    return parser.finishAuthenticated();
  } catch (error: unknown) {
    const cleanupFailure = cleanupFailedStreamingStage(parser);
    if (cleanupFailure !== null) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        `Backup staging failed and exact cleanup requires startup recovery: ${errorMessage(cleanupFailure)}`,
      );
    }
    throw error;
  }
}

function streamDecryptOpenArchive(
  archive: OpenEncryptedBackupArchive,
  passphrase: string,
  onPlaintext: (bytes: Uint8Array) => void,
): void {
  const salt = decodeBase64Exact(archive.manifest.kdf.salt, saltByteLength);
  const iv = decodeBase64Exact(archive.manifest.cipher.iv, ivByteLength);
  const authenticationTag = readExactAt(
    archive.descriptor,
    archive.tagOffset,
    archiveTagByteLength,
    "backup authentication tag",
  );
  const ciphertext = Buffer.alloc(maximumControlPlaneBackupStreamingChunkByteLength);
  let encryptionKey: Uint8Array | null = null;
  let consumerFailure: unknown = null;
  try {
    encryptionKey = deriveEncryptionKey(passphrase, salt);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv, {
      authTagLength: archiveTagByteLength,
    });
    decipher.setAAD(archiveAdditionalAuthenticatedData(archive.manifestBytes));
    decipher.setAuthTag(authenticationTag);
    let offset = archive.ciphertextOffset;
    while (offset < archive.tagOffset) {
      const expected = Math.min(ciphertext.byteLength, archive.tagOffset - offset);
      const read = readSync(
        archive.descriptor,
        ciphertext,
        0,
        expected,
        offset,
      );
      if (read !== expected) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Backup ciphertext is truncated",
        );
      }
      const plaintext = decipher.update(ciphertext.subarray(0, read));
      if (consumerFailure === null) {
        try {
          onPlaintext(plaintext);
        } catch (error: unknown) {
          consumerFailure = error;
        }
      }
      plaintext.fill(0);
      offset += read;
    }
    let finalPlaintext: Buffer;
    try {
      finalPlaintext = decipher.final();
    } catch {
      throw new ControlPlaneBackupError(
        "authentication_failed",
        "The backup passphrase is wrong or the archive was modified",
      );
    }
    try {
      if (consumerFailure === null) {
        try {
          onPlaintext(finalPlaintext);
        } catch (error: unknown) {
          consumerFailure = error;
        }
      }
    } finally {
      finalPlaintext.fill(0);
    }
    assertOpenArchiveStable(
      archive.parent,
      archive.name,
      archive.descriptor,
      archive.identity,
    );
    if (consumerFailure !== null) {
      throwControlPlaneFailure(
        consumerFailure,
        "Authenticated backup plaintext could not be consumed safely",
      );
    }
  } finally {
    ciphertext.fill(0);
    encryptionKey?.fill(0);
    authenticationTag.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}

interface OpenEncryptedBackupArchive {
  readonly descriptor: number;
  readonly identity: Stats;
  readonly parent: BoundPublicationDirectory;
  readonly name: string;
  readonly manifest: ControlPlaneBackupManifest;
  readonly manifestBytes: Uint8Array;
  readonly ciphertextOffset: number;
  readonly tagOffset: number;
  close(): void;
}

function openEncryptedBackupArchive(path: string): OpenEncryptedBackupArchive {
  if (!isAbsolute(path)) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Backup archive path must be absolute",
    );
  }
  const parent = bindPublicationDirectory(dirname(path));
  const name = basename(path);
  let descriptor: number;
  try {
    descriptor = parent.openFile(name, protectedReadFlags, 0);
  } catch (error: unknown) {
    parent.close();
    throw error;
  }
  let closed = false;
  try {
    const identity = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    const minimumLength = archiveMagic.byteLength
      + archiveLengthPrefixByteLength
      + archiveTagByteLength
      + 1;
    if (
      !identity.isFile()
      || identity.nlink !== 1
      || identity.size < minimumLength
      || identity.size > maximumArchiveByteLength
      || (identity.mode & 0o777) !== 0o600
      || (currentUser !== undefined && identity.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Backup archive must be one bounded protected regular file",
      );
    }
    const prefixLength = archiveMagic.byteLength + archiveLengthPrefixByteLength;
    const prefix = readExactAt(descriptor, 0, prefixLength, "backup archive header");
    if (!timingSafeEqual(prefix.subarray(0, archiveMagic.byteLength), archiveMagic)) {
      throw new ControlPlaneBackupError("invalid_archive", "Backup archive magic is invalid");
    }
    const manifestLength = Buffer.from(prefix).readUInt32BE(archiveMagic.byteLength);
    if (manifestLength <= 0 || manifestLength > maximumManifestByteLength) {
      throw new ControlPlaneBackupError("invalid_archive", "Backup manifest length is invalid");
    }
    const manifestBytes = readExactAt(
      descriptor,
      prefixLength,
      manifestLength,
      "backup manifest",
    );
    let manifest: ControlPlaneBackupManifest;
    try {
      const decoded: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
      );
      manifest = parseBackupManifest(decoded);
    } catch (error: unknown) {
      if (error instanceof ControlPlaneBackupError) throw error;
      throw new ControlPlaneBackupError("invalid_archive", "Backup manifest is invalid");
    }
    decodeBase64Exact(manifest.kdf.salt, saltByteLength);
    decodeBase64Exact(manifest.cipher.iv, ivByteLength);
    const ciphertextOffset = prefixLength + manifestLength;
    const tagOffset = ciphertextOffset + manifest.payloadByteLength;
    const expectedLength = tagOffset + archiveTagByteLength;
    if (
      !Number.isSafeInteger(ciphertextOffset)
      || !Number.isSafeInteger(tagOffset)
      || expectedLength !== identity.size
    ) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Backup archive framing length is invalid",
      );
    }
    assertOpenArchiveStable(parent, name, descriptor, identity);
    return {
      descriptor,
      identity,
      parent,
      name,
      manifest,
      manifestBytes,
      ciphertextOffset,
      tagOffset,
      close() {
        if (closed) return;
        closed = true;
        try {
          closeSync(descriptor);
        } finally {
          parent.close();
        }
      },
    };
  } catch (error: unknown) {
    if (!closed) {
      try {
        closeSync(descriptor);
      } finally {
        parent.close();
      }
    }
    throw error;
  }
}

function readExactAt(
  descriptor: number,
  position: number,
  byteLength: number,
  label: string,
): Uint8Array {
  if (
    !Number.isSafeInteger(position)
    || position < 0
    || !Number.isSafeInteger(byteLength)
    || byteLength < 0
  ) {
    throw new ControlPlaneBackupError("invalid_archive", `${label} range is invalid`);
  }
  const bytes = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  try {
    while (offset < byteLength) {
      const read = readSync(
        descriptor,
        bytes,
        offset,
        byteLength - offset,
        position + offset,
      );
      if (read <= 0) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          `${label} is truncated`,
        );
      }
      offset += read;
    }
    return bytes;
  } catch (error: unknown) {
    bytes.fill(0);
    throw error;
  }
}

function assertOpenArchiveStable(
  parent: BoundPublicationDirectory,
  name: string,
  descriptor: number,
  identity: Stats,
): void {
  parent.assertStable();
  const descriptorMetadata = fstatSync(descriptor);
  const nameDescriptor = parent.openFile(name, protectedReadFlags, 0);
  let nameMetadata: Stats;
  try {
    nameMetadata = fstatSync(nameDescriptor);
  } finally {
    closeSync(nameDescriptor);
  }
  for (const metadata of [descriptorMetadata, nameMetadata]) {
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.dev !== identity.dev
      || metadata.ino !== identity.ino
      || metadata.nlink !== identity.nlink
      || metadata.size !== identity.size
      || metadata.mtimeMs !== identity.mtimeMs
      || metadata.ctimeMs !== identity.ctimeMs
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Backup archive identity changed during inspection",
      );
    }
  }
  parent.assertStable();
}

function hashOpenEncryptedBackupArchive(
  archive: OpenEncryptedBackupArchive,
): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(maximumControlPlaneBackupStreamingChunkByteLength);
  let offset = 0;
  try {
    while (offset < archive.identity.size) {
      const length = readSync(
        archive.descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, archive.identity.size - offset),
        offset,
      );
      if (length <= 0) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Backup archive is truncated",
        );
      }
      digest.update(buffer.subarray(0, length));
      offset += length;
    }
    assertOpenArchiveStable(
      archive.parent,
      archive.name,
      archive.descriptor,
      archive.identity,
    );
    return digest.digest("hex");
  } finally {
    buffer.fill(0);
  }
}

function parseBackupManifest(value: unknown): ControlPlaneBackupManifest {
  try {
    const parsed = backupManifestSchema.parse(value);
    return {
      ...parsed,
      sourceRelease: parseAppReleaseIdentity(parsed.sourceRelease),
    };
  } catch {
    throw new ControlPlaneBackupError("invalid_archive", "Backup manifest is invalid");
  }
}

function verifyDecryptedPayload(
  manifest: ControlPlaneBackupManifest,
  databaseBytes: Uint8Array,
  operationReceiptKey: Uint8Array,
  attachmentVaultManifest: AttachmentVaultPayloadManifest,
): void {
  if (sha256(databaseBytes) !== manifest.sourceHashes.projectedDatabaseSha256) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup database hash is invalid");
  }
  if (
    !safeHexEqual(
      attachmentVaultManifest.generationSha256,
      manifest.sourceHashes.attachmentVaultGenerationSha256,
    )
    || attachmentVaultManifest.blobs.length !== manifest.attachmentVault.blobCount
    || attachmentVaultManifest.totalBytes !== manifest.attachmentVault.totalBytes
  ) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Backup attachment-vault proof is invalid",
    );
  }
  const proof = inspectSnapshot(databaseBytes, manifest.sourceRelease);
  try {
    if (
      proof.migrationVersion !== manifest.sourceMigrationVersion
      || hashSchema(proof.database) !== manifest.sourceHashes.schemaSha256
      || hashMigrationHistory(proof.database)
        !== manifest.sourceHashes.migrationHistorySha256
    ) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Backup schema or migration proof is invalid",
      );
    }
    assertPortableProviderContextManifest(
      manifest,
      proof.database,
      operationReceiptKey,
    );
  } finally {
    proof.database.close();
  }
  const expectedBinding = hmacSha256(
    operationReceiptKey,
    sourceBindingPreimage({
      sourceDatabaseSha256: manifest.sourceHashes.sourceDatabaseSha256,
      projectedDatabaseSha256:
        manifest.sourceHashes.projectedDatabaseSha256,
      schemaSha256: manifest.sourceHashes.schemaSha256,
      migrationHistorySha256: manifest.sourceHashes.migrationHistorySha256,
      attachmentVaultGenerationSha256:
        manifest.sourceHashes.attachmentVaultGenerationSha256,
      migrationVersion: manifest.sourceMigrationVersion,
      sourceRelease: manifest.sourceRelease,
      portableProviderContext: manifest.portableProviderContext,
    }),
  );
  if (!safeHexEqual(expectedBinding, manifest.sourceHashes.receiptBindingHmacSha256)) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Backup source receipt-key binding is invalid",
    );
  }
}

function assertPortableProviderContextManifest(
  manifest: ControlPlaneBackupManifest,
  database: Database,
  operationReceiptKey: Uint8Array,
): void {
  const attestation = manifest.portableProviderContext;
  if (
    !safeHexEqual(
      attestation.sourceDatabaseSha256,
      manifest.sourceHashes.sourceDatabaseSha256,
    )
    || !safeHexEqual(
      attestation.attachmentVaultGenerationSha256,
      manifest.sourceHashes.attachmentVaultGenerationSha256,
    )
    || attestation.projectedAt !== new Date(manifest.createdAt).toISOString()
  ) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Backup portable provider-context attestation is inconsistent",
    );
  }
  try {
    inspectPortableProviderContext(
      database,
      operationReceiptKey,
      attestation,
    );
  } catch (error: unknown) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      `Backup portable provider context is invalid: ${errorMessage(error)}`,
    );
  }
}

function validateStreamedPayloadStage(
  manifest: ControlPlaneBackupManifest,
  stage: StreamedPayloadStage,
  releaseIdentity: AppReleaseIdentity,
): number {
  if (
    !safeHexEqual(
      stage.databaseSha256,
      manifest.sourceHashes.projectedDatabaseSha256,
    )
  ) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Backup database hash is invalid",
    );
  }
  if (
    stage.attachmentVaultManifest.blobs.length
      !== manifest.attachmentVault.blobCount
    || stage.attachmentVaultManifest.totalBytes
      !== manifest.attachmentVault.totalBytes
    || !safeHexEqual(
      stage.attachmentVaultManifest.generationSha256,
      manifest.sourceHashes.attachmentVaultGenerationSha256,
    )
  ) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Backup attachment-vault proof is invalid",
    );
  }
  const keyOnDisk = stage.readReceiptKeyBytes();
  try {
    if (
      keyOnDisk.byteLength !== stage.receiptKey.byteLength
      || !timingSafeEqual(keyOnDisk, stage.receiptKey)
    ) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Streamed operation-receipt key changed",
      );
    }
  } finally {
    keyOnDisk.fill(0);
  }
  const vaultProof = stage.inspectAttachmentVault();
  if (
    !safeHexEqual(
      vaultProof.generationSha256,
      manifest.sourceHashes.attachmentVaultGenerationSha256,
    )
    || vaultProof.totalBytes !== stage.attachmentVaultManifest.totalBytes
    || JSON.stringify(vaultProof.blobs)
      !== JSON.stringify(stage.attachmentVaultManifest.blobs)
  ) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Streamed attachment-vault generation changed",
    );
  }
  const databaseBytes = stage.readDatabaseBytes();
  if (!safeHexEqual(sha256(databaseBytes), stage.databaseSha256)) {
    databaseBytes.fill(0);
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Streamed database stage changed",
    );
  }
  const proof = inspectSnapshot(databaseBytes, releaseIdentity);
  try {
    if (
      proof.migrationVersion !== manifest.sourceMigrationVersion
      || hashSchema(proof.database) !== manifest.sourceHashes.schemaSha256
      || hashMigrationHistory(proof.database)
        !== manifest.sourceHashes.migrationHistorySha256
    ) {
      throw new ControlPlaneBackupError(
        "invalid_archive",
        "Backup schema or migration proof is invalid",
      );
    }
    assertAttachmentInventoryMatchesDatabase(proof.database, vaultProof.blobs);
    assertPortableProviderContextManifest(
      manifest,
      proof.database,
      stage.receiptKey,
    );
  } finally {
    proof.database.close();
    databaseBytes.fill(0);
  }
  const expectedBinding = hmacSha256(
    stage.receiptKey,
    sourceBindingPreimage({
      sourceDatabaseSha256: manifest.sourceHashes.sourceDatabaseSha256,
      projectedDatabaseSha256:
        manifest.sourceHashes.projectedDatabaseSha256,
      schemaSha256: manifest.sourceHashes.schemaSha256,
      migrationHistorySha256: manifest.sourceHashes.migrationHistorySha256,
      attachmentVaultGenerationSha256:
        manifest.sourceHashes.attachmentVaultGenerationSha256,
      migrationVersion: manifest.sourceMigrationVersion,
      sourceRelease: manifest.sourceRelease,
      portableProviderContext: manifest.portableProviderContext,
    }),
  );
  if (!safeHexEqual(expectedBinding, manifest.sourceHashes.receiptBindingHmacSha256)) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Backup source receipt-key binding is invalid",
    );
  }
  return proof.migrationVersion;
}

function validatePublishedRestore(
  paths: RestorePaths,
  releaseIdentity: AppReleaseIdentity,
  manifest: ControlPlaneBackupManifest,
  expectedReceiptKeySha256: string,
): void {
  assertPrivateRegularFile(paths.database, null);
  assertPrivateRegularFile(paths.receiptKey, operationReceiptKeyByteLength);
  const liveDatabaseBytes = readBoundedRegularFile(
    paths.database,
    maximumDatabaseByteLength,
    "restored control-plane database",
  );
  try {
    if (
      sha256(liveDatabaseBytes)
        !== manifest.sourceHashes.projectedDatabaseSha256
    ) {
      throw new ControlPlaneBackupError("invalid_archive", "Published database hash changed");
    }
    const proof = inspectSnapshot(liveDatabaseBytes, releaseIdentity);
    try {
      if (
        proof.migrationVersion !== manifest.sourceMigrationVersion
        || hashSchema(proof.database) !== manifest.sourceHashes.schemaSha256
        || hashMigrationHistory(proof.database)
          !== manifest.sourceHashes.migrationHistorySha256
      ) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Published database compatibility proof changed",
        );
      }
    } finally {
      proof.database.close();
    }
    const liveReceiptKey = readBoundedRegularFile(
      paths.receiptKey,
      operationReceiptKeyByteLength,
      "restored operation-receipt key",
    );
    try {
      if (sha256(liveReceiptKey) !== expectedReceiptKeySha256) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Published operation-receipt key hash changed",
        );
      }
      const expectedBinding = hmacSha256(
        liveReceiptKey,
        sourceBindingPreimage({
          sourceDatabaseSha256: manifest.sourceHashes.sourceDatabaseSha256,
          projectedDatabaseSha256:
            manifest.sourceHashes.projectedDatabaseSha256,
          schemaSha256: manifest.sourceHashes.schemaSha256,
          migrationHistorySha256: manifest.sourceHashes.migrationHistorySha256,
          attachmentVaultGenerationSha256:
            manifest.sourceHashes.attachmentVaultGenerationSha256,
          migrationVersion: manifest.sourceMigrationVersion,
          sourceRelease: manifest.sourceRelease,
          portableProviderContext: manifest.portableProviderContext,
        }),
      );
      if (
        !safeHexEqual(
          expectedBinding,
          manifest.sourceHashes.receiptBindingHmacSha256,
        )
      ) {
        throw new ControlPlaneBackupError(
          "invalid_archive",
          "Published database and receipt key are not a bound pair",
        );
      }
    } finally {
      liveReceiptKey.fill(0);
    }
    assertAttachmentVaultGeneration(
      paths.attachmentVault,
      manifest.sourceHashes.attachmentVaultGenerationSha256,
      "published attachment vault",
    );
  } finally {
    liveDatabaseBytes.fill(0);
  }
}

function assertAttachmentVaultGeneration(
  root: string,
  expectedSha256: string,
  label: string,
): void {
  let proof;
  try {
    proof = inspectControlPlaneAttachmentVault(root);
  } catch (error: unknown) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      `The ${label} is invalid: ${errorMessage(error)}`,
    );
  }
  if (!safeHexEqual(proof.generationSha256, expectedSha256)) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      `The ${label} does not match its journaled generation`,
    );
  }
}

function hashOptionalAttachmentVault(root: string): string | null {
  if (!pathExists(root)) return null;
  try {
    return inspectControlPlaneAttachmentVault(root).generationSha256;
  } catch (error: unknown) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      `The existing attachment vault is unsafe: ${errorMessage(error)}`,
    );
  }
}

function inspectCoherentRestoreTarget(
  paths: RestorePaths,
  releaseIdentity: AppReleaseIdentity,
): Readonly<{
  hadDatabase: boolean;
  hadReceiptKey: boolean;
  hadAttachmentVault: boolean;
  databaseSha256: string | null;
  receiptKeySha256: string | null;
  attachmentVaultGenerationSha256: string | null;
  attachmentVaultInventory: ControlPlaneRestoreAttachmentVaultInventory | null;
}> {
  const databasePresent = pathExists(paths.database);
  const receiptKeyPresent = pathExists(paths.receiptKey);
  const attachmentVaultPresent = pathExists(paths.attachmentVault);
  if (databasePresent !== receiptKeyPresent) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      "Restore requires a complete database and receipt-key target or an empty root",
    );
  }
  if (!databasePresent) {
    if (attachmentVaultPresent) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "Restore cannot adopt an attachment vault without its database and receipt key",
      );
    }
    return {
      hadDatabase: false,
      hadReceiptKey: false,
      hadAttachmentVault: false,
      databaseSha256: null,
      receiptKeySha256: null,
      attachmentVaultGenerationSha256: null,
      attachmentVaultInventory: null,
    };
  }
  const databaseBytes = readBoundedRegularFile(
    paths.database,
    maximumDatabaseByteLength,
    "original control-plane database",
  );
  const receiptKey = readBoundedRegularFile(
    paths.receiptKey,
    operationReceiptKeyByteLength,
    "original operation-receipt key",
  );
  let inspectionBytes: Uint8Array | null = null;
  try {
    inspectionBytes = Uint8Array.from(databaseBytes);
    normalizeSerializedSnapshot(inspectionBytes);
    const snapshot = inspectSnapshot(inspectionBytes, releaseIdentity);
    try {
      assertControlPlanePortableScheduleTransferReady(snapshot.database);
      const vault = attachmentVaultPresent
        ? inspectControlPlaneAttachmentVault(paths.attachmentVault)
        : null;
      assertAttachmentInventoryMatchesDatabase(
        snapshot.database,
        vault?.blobs ?? [],
      );
      return {
        hadDatabase: true,
        hadReceiptKey: true,
        hadAttachmentVault: attachmentVaultPresent,
        databaseSha256: sha256(databaseBytes),
        receiptKeySha256: sha256(receiptKey),
        attachmentVaultGenerationSha256: vault?.generationSha256 ?? null,
        attachmentVaultInventory: vault === null
          ? null
          : { version: 1, ...vault, blobs: [...vault.blobs] },
      };
    } finally {
      snapshot.database.close();
    }
  } finally {
    inspectionBytes?.fill(0);
    databaseBytes.fill(0);
    receiptKey.fill(0);
  }
}

function assertControlPlanePortableScheduleTransferReady(
  database: Database,
): void {
  try {
    assertPortableScheduledChatTransferReady(database);
  } catch (error: unknown) {
    if (!(error instanceof PortableProviderContextProjectionError)) throw error;
    throw new ControlPlaneBackupError("invalid_input", error.message);
  }
}

function removeVerifiedOptionalAttachmentVault(
  root: string,
  expectedInventory: ControlPlaneRestoreAttachmentVaultInventory | null,
  label: string,
  onFirstFileRemoved?: () => void,
): void {
  if (expectedInventory === null) {
    if (pathExists(root)) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        `Unexpected ${label} is present`,
      );
    }
    return;
  }
  removeAttachmentVaultGenerationIfPresent(
    root,
    expectedInventory,
    label,
    onFirstFileRemoved,
  );
}

function removeAttachmentVaultGenerationIfPresent(
  root: string,
  expectedInventory: ControlPlaneRestoreAttachmentVaultInventory,
  label: string,
  onFirstFileRemoved?: () => void,
): void {
  if (!pathExists(root)) return;
  const currentUser = process.getuid?.();
  const rootMetadata = lstatSync(root);
  if (
    rootMetadata.isSymbolicLink()
    || !rootMetadata.isDirectory()
    || (rootMetadata.mode & 0o777) !== 0o700
    || (currentUser !== undefined && rootMetadata.uid !== currentUser)
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      `The ${label} root is unsafe`,
    );
  }
  const expectedByPath = new Map(
    expectedInventory.blobs.map((blob) => [blob.relativePath, blob] as const),
  );
  const expectedAttachmentIds = new Set(
    expectedInventory.blobs.map(({ attachmentId }) => attachmentId),
  );
  const rootEntries = readdirSync(root).sort();
  if (rootEntries.some((entry) => entry !== "objects")) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      `The ${label} contains an unexpected root entry`,
    );
  }
  const objectsRoot = join(root, "objects");
  const objectsPresent = pathExists(objectsRoot);
  const objectDirectories: string[] = [];
  const normalizedDirectories: string[] = [];
  const files: string[] = [];
  if (objectsPresent) {
    assertOwnedAttachmentVaultDirectory(
      objectsRoot,
      rootMetadata.dev,
      `${label} objects directory`,
    );
  }
  for (const attachmentId of objectsPresent
    ? readdirSync(objectsRoot).sort()
    : []) {
    if (
      !attachmentIdSchema.safeParse(attachmentId).success
      || !expectedAttachmentIds.has(attachmentId)
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        `The ${label} contains an unexpected object identifier`,
      );
    }
    const objectRoot = join(objectsRoot, attachmentId);
    assertOwnedAttachmentVaultDirectory(
      objectRoot,
      rootMetadata.dev,
      `${label} object directory`,
    );
    objectDirectories.push(objectRoot);
    for (const entry of readdirSync(objectRoot).sort()) {
      if (entry === "normalized") {
        const normalizedRoot = join(objectRoot, entry);
        assertOwnedAttachmentVaultDirectory(
          normalizedRoot,
          rootMetadata.dev,
          `${label} normalized directory`,
        );
        normalizedDirectories.push(normalizedRoot);
        for (const child of readdirSync(normalizedRoot).sort()) {
          const relativePath = `${attachmentId}/normalized/${child}`;
          const expected = expectedByPath.get(relativePath);
          if (expected === undefined) {
            throw new ControlPlaneBackupError(
              "unsafe_path",
              `The ${label} contains an unexpected normalized entry`,
            );
          }
          assertAttachmentVaultBlobMatches(
            join(normalizedRoot, child),
            rootMetadata.dev,
            expected,
            label,
          );
          files.push(join(normalizedRoot, child));
        }
      } else if (
        entry === "source.upload"
        || /^blob\.[a-z0-9]{1,16}$/u.test(entry)
      ) {
        const relativePath = `${attachmentId}/${entry}`;
        const expected = expectedByPath.get(relativePath);
        if (expected === undefined) {
          throw new ControlPlaneBackupError(
            "unsafe_path",
            `The ${label} contains an unexpected object entry`,
          );
        }
        assertAttachmentVaultBlobMatches(
          join(objectRoot, entry),
          rootMetadata.dev,
          expected,
          label,
        );
        files.push(join(objectRoot, entry));
      } else {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          `The ${label} contains an unexpected object entry`,
        );
      }
    }
  }

  for (const [index, file] of files.entries()) {
    unlinkSync(file);
    if (index === 0) onFirstFileRemoved?.();
  }
  for (const directory of normalizedDirectories) {
    syncDirectory(directory);
    rmdirSync(directory);
  }
  for (const directory of objectDirectories) {
    syncDirectory(directory);
    rmdirSync(directory);
  }
  if (objectsPresent) {
    syncDirectory(objectsRoot);
    rmdirSync(objectsRoot);
  }
  syncDirectory(root);
  rmdirSync(root);
  syncDirectory(dirname(root));
}

function assertOwnedAttachmentVaultDirectory(
  path: string,
  expectedDevice: number,
  label: string,
): void {
  const metadata = lstatSync(path);
  const currentUser = process.getuid?.();
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || metadata.dev !== expectedDevice
    || (metadata.mode & 0o777) !== 0o700
    || (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new ControlPlaneBackupError("unsafe_path", `The ${label} is unsafe`);
  }
}

function assertAttachmentVaultBlobMatches(
  path: string,
  expectedDevice: number,
  expected: ControlPlaneRestoreAttachmentVaultInventory["blobs"][number],
  label: string,
): void {
  const metadata = lstatSync(path);
  const currentUser = process.getuid?.();
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || metadata.dev !== expectedDevice
    || metadata.size !== expected.bytes
    || (metadata.mode & 0o777) !== 0o600
    || (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      `The ${label} contains an unsafe attachment blob`,
    );
  }
  const bytes = readBoundedRegularFile(
    path,
    Math.max(1, expected.bytes),
    `${label} attachment blob`,
  );
  try {
    if (
      bytes.byteLength !== expected.bytes
      || !safeHexEqual(sha256(bytes), expected.sha256)
    ) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        `The ${label} attachment blob changed before cleanup`,
      );
    }
  } finally {
    bytes.fill(0);
  }
}

function prepareRestoreTargets(paths: RestorePaths): void {
  assertNoUnjournaledRestoreArtifacts(paths);
  assertOptionalPrivateRegularFile(paths.database, null);
  assertOptionalPrivateRegularFile(paths.receiptKey, operationReceiptKeyByteLength);
  hashOptionalAttachmentVault(paths.attachmentVault);
  try {
    inspectRestoreSqliteSidecars(paths);
  } catch (error: unknown) {
    if (!(error instanceof ControlPlaneBackupError)) throw error;
    throw new ControlPlaneBackupError(
      error.code,
      "The existing database must be closed and checkpointed before restore",
    );
  }
}

function inspectRestoreTargetsForStage(paths: RestorePaths): void {
  assertNoUnjournaledRestoreArtifacts(paths);
  assertOptionalPrivateRegularFileReadOnly(paths.database, null);
  assertOptionalPrivateRegularFileReadOnly(
    paths.receiptKey,
    operationReceiptKeyByteLength,
  );
  hashOptionalAttachmentVault(paths.attachmentVault);
  try {
    inspectRestoreSqliteSidecars(paths);
  } catch (error: unknown) {
    if (!(error instanceof ControlPlaneBackupError)) throw error;
    throw new ControlPlaneBackupError(
      error.code,
      "The existing database must be closed and checkpointed before restore staging",
    );
  }
}

function assertNoUnjournaledRestoreArtifacts(paths: RestorePaths): void {
  for (const path of [
    paths.journalCandidate,
    paths.databaseStage,
    paths.databaseRollback,
    paths.keyStage,
    paths.keyRollback,
    paths.attachmentVaultStage,
    paths.attachmentVaultRollback,
  ]) {
    if (pathExists(path)) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "Unjournaled control-plane restore state requires manual inspection",
      );
    }
  }
}

function restoreOriginalFile(input: {
  readonly hadOriginal: boolean;
  readonly livePath: string;
  readonly rollbackPath: string;
  readonly label: string;
  readonly originalSha256: string | null;
  readonly replacementSha256: string;
  readonly maximumBytes: number;
}): void {
  const rollbackExists = pathExists(input.rollbackPath);
  const liveExists = pathExists(input.livePath);
  if (rollbackExists) {
    assertPrivateRegularFile(input.rollbackPath, null);
    assertFileHash(
      input.rollbackPath,
      input.originalSha256,
      input.maximumBytes,
      `${input.label} rollback`,
    );
    if (liveExists) {
      assertPrivateRegularFile(input.livePath, null);
      assertFileHashOneOf(
        input.livePath,
        [input.originalSha256, input.replacementSha256],
        input.maximumBytes,
        `live ${input.label}`,
      );
      unlinkSync(input.livePath);
    }
    renameSync(input.rollbackPath, input.livePath);
    return;
  }
  if (!input.hadOriginal) {
    if (liveExists) {
      assertPrivateRegularFile(input.livePath, null);
      assertFileHash(
        input.livePath,
        input.replacementSha256,
        input.maximumBytes,
        input.label,
      );
      unlinkSync(input.livePath);
    }
    return;
  }
  if (!liveExists) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      `The original ${input.label} cannot be recovered`,
    );
  }
  assertPrivateRegularFile(input.livePath, null);
  assertFileHash(
    input.livePath,
    input.originalSha256,
    input.maximumBytes,
    input.label,
  );
}

function finishCommittedRestoreCleanup(
  paths: RestorePaths,
  journal: RestoreJournal,
): void {
  assertFileHash(
    paths.database,
    journal.databaseSha256,
    maximumDatabaseByteLength,
    "committed database",
  );
  assertFileHash(
    paths.receiptKey,
    journal.receiptKeySha256,
    operationReceiptKeyByteLength,
    "committed receipt key",
  );
  assertAttachmentVaultGeneration(
    paths.attachmentVault,
    journal.attachmentVaultGenerationSha256,
    "committed attachment vault",
  );
  removeVerifiedOptionalAttachmentVault(
    paths.attachmentVaultRollback,
    journal.originalAttachmentVaultInventory,
    "attachment-vault rollback",
  );
  removeVerifiedOptionalFile(
    paths.databaseRollback,
    journal.originalDatabaseSha256,
    maximumDatabaseByteLength,
    "database rollback",
  );
  removeVerifiedOptionalFile(
    paths.keyRollback,
    journal.originalReceiptKeySha256,
    operationReceiptKeyByteLength,
    "receipt-key rollback",
  );
  removeIfPresent(paths.databaseStage);
  removeIfPresent(paths.keyStage);
  removeAttachmentVaultGenerationIfPresent(
    paths.attachmentVaultStage,
    journal.attachmentVaultInventory,
    "attachment-vault stage",
  );
  removeIfPresent(paths.journalCandidate);
  removeIfPresent(paths.journal);
  syncDirectory(paths.parent);
}

function assertJournalOriginalShape(journal: RestoreJournal): void {
  if (
    journal.hadDatabase !== (journal.originalDatabaseSha256 !== null)
    || journal.hadReceiptKey !== (journal.originalReceiptKeySha256 !== null)
    || journal.hadAttachmentVault !==
      (journal.originalAttachmentVaultGenerationSha256 !== null)
    || journal.hadAttachmentVault !==
      (journal.originalAttachmentVaultInventory !== null)
    || (
      journal.originalAttachmentVaultInventory !== null
      && journal.originalAttachmentVaultInventory.generationSha256
        !== journal.originalAttachmentVaultGenerationSha256
    )
  ) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      "The restore journal original-state proof is inconsistent",
    );
  }
}

function assertFileHash(
  path: string,
  expectedSha256: string | null,
  maximumBytes: number,
  label: string,
): void {
  if (expectedSha256 === null) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      `The ${label} has no journaled hash`,
    );
  }
  if (!safeHexEqual(
    hashProtectedRegularFile(path, maximumBytes, label),
    expectedSha256,
  )) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      `The ${label} does not match its journaled hash`,
    );
  }
}

function assertFileHashOneOf(
  path: string,
  expectedValues: readonly (string | null)[],
  maximumBytes: number,
  label: string,
): void {
  const expected = expectedValues.filter(
    (value): value is string => value !== null,
  );
  const actual = hashProtectedRegularFile(path, maximumBytes, label);
  if (!expected.some((value) => safeHexEqual(actual, value))) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      `The ${label} does not match a journaled state`,
    );
  }
}

function hashProtectedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): string {
  assertNoSymlinkDirectory(dirname(path));
  const parent = lstatSync(dirname(path));
  const descriptor = openSync(path, protectedReadFlags);
  try {
    const identity = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    if (
      !identity.isFile()
      || identity.nlink !== 1
      || identity.dev !== parent.dev
      || identity.size <= 0
      || identity.size > maximumBytes
      || (identity.mode & 0o777) !== 0o600
      || (currentUser !== undefined && identity.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        `The ${label} must be one bounded protected regular file`,
      );
    }
    return hashOpenDescriptor(descriptor, identity.size, identity);
  } finally {
    closeSync(descriptor);
  }
}

function removeVerifiedOptionalFile(
  path: string,
  expectedSha256: string | null,
  maximumBytes: number,
  label: string,
): void {
  if (!pathExists(path)) return;
  assertPrivateRegularFile(path, null);
  assertFileHash(path, expectedSha256, maximumBytes, label);
  unlinkSync(path);
}

function writeRestoreJournal(
  paths: RestorePaths,
  journal: RestoreJournal,
  root: BoundPublicationDirectory,
): void {
  const bytes = Buffer.from(JSON.stringify(restoreJournalSchema.parse(journal)), "utf8");
  if (bytes.byteLength > maximumJournalByteLength) {
    throw new ControlPlaneBackupError("restore_interrupted", "Restore journal is too large");
  }
  const candidateName = basename(paths.journalCandidate);
  const journalName = basename(paths.journal);
  let created = false;
  let descriptor = root.tryOpenFile(
    candidateName,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
      | closeOnExecFlag,
    0,
  );
  if (descriptor === null) {
    descriptor = root.openFile(
      candidateName,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
        | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExecFlag,
      0o600,
    );
    created = true;
  }
  try {
    if (created) fchmodSync(descriptor, 0o600);
    const identity = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    if (
      !identity.isFile()
      || identity.nlink !== 1
      || identity.dev !== root.identity.dev
      || (identity.mode & 0o777) !== 0o600
      || (currentUser !== undefined && identity.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "Restore journal candidate is unsafe",
      );
    }
    ftruncateSync(descriptor, 0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (written <= 0) {
        throw new ControlPlaneBackupError(
          "restore_interrupted",
          "Restore journal candidate could not be written",
        );
      }
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    bytes.fill(0);
    closeSync(descriptor);
  }
  const currentJournal = root.tryOpenFile(
    journalName,
    protectedReadFlags,
    0,
  );
  if (currentJournal === null) {
    root.renameExclusive(candidateName, journalName, () => {});
  } else {
    let exchangedJournal: number | null = null;
    try {
      const previousIdentity = fstatSync(currentJournal);
      const currentUser = process.getuid?.();
      if (
        !previousIdentity.isFile()
        || previousIdentity.nlink !== 1
        || previousIdentity.dev !== root.identity.dev
        || (previousIdentity.mode & 0o777) !== 0o600
        || (currentUser !== undefined && previousIdentity.uid !== currentUser)
      ) {
        throw new ControlPlaneBackupError(
          "restore_interrupted",
          "Restore journal is unsafe to replace",
        );
      }
      root.renameExchange(candidateName, journalName);
      exchangedJournal = root.tryOpenRetainedFile(
        candidateName,
        protectedReadFlags,
        0,
      );
      if (exchangedJournal === null) {
        throw new ControlPlaneBackupError(
          "restore_interrupted",
          "Restore journal exchange lost its prior generation",
        );
      }
      const exchangedIdentity = fstatSync(exchangedJournal);
      if (
        exchangedIdentity.dev !== previousIdentity.dev
        || exchangedIdentity.ino !== previousIdentity.ino
        || exchangedIdentity.nlink !== 1
        || !exchangedIdentity.isFile()
      ) {
        throw new ControlPlaneBackupError(
          "restore_interrupted",
          "Restore journal exchange changed its prior generation",
        );
      }
      root.unlinkRetained(candidateName);
      root.syncRetained();
      if (fstatSync(currentJournal).nlink !== 0) {
        throw new ControlPlaneBackupError(
          "restore_interrupted",
          "Restore journal prior generation remains linked",
        );
      }
    } finally {
      if (exchangedJournal !== null) closeSync(exchangedJournal);
      closeSync(currentJournal);
    }
  }
  root.sync();
}

function renameRestoreEntryExclusive(
  root: BoundPublicationDirectory,
  paths: RestorePaths,
  from: string,
  to: string,
): void {
  if (dirname(from) !== paths.parent || dirname(to) !== paths.parent) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Restore swap names must remain inside the retained root",
    );
  }
  root.renameExclusive(basename(from), basename(to), () => {});
  root.sync();
}

function readRestoreJournal(paths: RestorePaths): RestoreJournal | null {
  if (!pathExists(paths.journal)) return null;
  assertPrivateRestoreArtifact(
    paths.journal,
    lstatSync(paths.parent),
    1,
    maximumJournalByteLength,
    "restore journal",
  );
  const bytes = readBoundedRegularFile(
    paths.journal,
    maximumJournalByteLength,
    "restore journal",
  );
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const journal = restoreJournalSchema.parse(value);
    assertJournalOriginalShape(journal);
    return journal;
  } catch {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      "The control-plane restore journal is invalid",
    );
  }
}

function readBoundRestoreJournal(
  paths: RestorePaths,
  parent: BoundPublicationDirectory,
): RestoreJournal {
  if (dirname(paths.journal) !== paths.parent) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Restore journal must be a fixed child of the retained restore root",
    );
  }
  parent.assertStable();
  const descriptor = parent.openFile(
    basename(paths.journal),
    protectedReadFlags,
    0,
  );
  let bytes: Uint8Array | null = null;
  try {
    const before = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== parent.identity.dev
      || before.size <= 0
      || before.size > maximumJournalByteLength
      || (before.mode & 0o777) !== 0o600
      || (currentUser !== undefined && before.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "The retained restore journal is unsafe",
      );
    }
    bytes = Uint8Array.from(readFileSync(descriptor));
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== before.nlink
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "The retained restore journal changed while it was read",
      );
    }
    parent.assertStable();
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      const journal = restoreJournalSchema.parse(value);
      assertJournalOriginalShape(journal);
      return journal;
    } catch (error: unknown) {
      if (error instanceof ControlPlaneBackupError) throw error;
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "The retained restore journal is invalid",
      );
    }
  } finally {
    bytes?.fill(0);
    closeSync(descriptor);
  }
}

function assertBoundRestoreJournal(
  journal: RestoreJournal,
  phase: RestoreJournal["phase"],
  expected: RestoreJournalBinding,
): void {
  if (
    journal.phase !== phase
    || !safeHexEqual(journal.archiveSha256, expected.archiveSha256)
    || !safeHexEqual(journal.databaseSha256, expected.databaseSha256)
    || !safeHexEqual(journal.receiptKeySha256, expected.receiptKeySha256)
    || !safeHexEqual(
      journal.attachmentVaultGenerationSha256,
      expected.attachmentVaultGenerationSha256,
    )
    || !safeHexEqual(journal.stageCustodyNonce, expected.stageCustodyNonce)
    || journal.restoreRootDevice !== expected.restoreRootDevice
    || journal.restoreRootInode !== expected.restoreRootInode
  ) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      "Restore journal does not authorize this authenticated stage",
    );
  }
}

function checkpoint(
  input: RestoreControlPlaneBackupInput,
  point: ControlPlaneRestoreFaultPoint,
): void {
  input.onCheckpoint?.(point);
}

function validateBackupDestination(path: string): void {
  if (!isAbsolute(path)) {
    throw new ControlPlaneBackupError("unsafe_path", "Backup destination must be absolute");
  }
  assertNoSymlinkDirectory(dirname(path));
  const metadata = readMetadata(path);
  if (
    metadata !== null
    && (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1
    )
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Backup destination must be one regular file",
    );
  }
}

function assertBackupArchiveOutsideControlPlaneRoot(
  archivePath: string,
  controlPlaneRoot: string,
): void {
  if (
    !isAbsolute(archivePath)
    || resolve(archivePath) !== archivePath
    || !isAbsolute(controlPlaneRoot)
    || resolve(controlPlaneRoot) !== controlPlaneRoot
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Backup archive paths must be normalized and absolute",
    );
  }
  assertNoSymlinkDirectory(controlPlaneRoot);
  assertNoSymlinkDirectory(dirname(archivePath));
  const canonicalControlPlaneRoot = realpathSync(controlPlaneRoot);
  const canonicalArchivePath = join(
    realpathSync(dirname(archivePath)),
    basename(archivePath),
  );
  const fromControlPlaneRoot = relative(
    canonicalControlPlaneRoot,
    canonicalArchivePath,
  );
  if (
    fromControlPlaneRoot === ""
    || (
      fromControlPlaneRoot !== ".."
      && !fromControlPlaneRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromControlPlaneRoot)
    )
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Backup archives must be stored outside the live control-plane root",
    );
  }
}

function assertPrivateRestoreRoot(path: string): void {
  inspectPrivateRestoreRoot(path);
  chmodSync(path, 0o700);
}

function inspectPrivateRestoreRoot(path: string): Stats {
  assertNoSymlinkDirectory(path);
  const metadata = lstatSync(path);
  const currentUser = process.getuid?.();
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Restore root must be one owned real directory",
    );
  }
  return metadata;
}

function assertNoSymlinkDirectory(path: string): void {
  const absolute = resolve(path);
  if (absolute !== path) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "State paths must be normalized absolute paths",
    );
  }
  const parsed = parse(absolute);
  let current = parsed.root;
  const suffix = absolute.slice(parsed.root.length);
  for (const segment of suffix.split(sep).filter((value) => value.length > 0)) {
    current = join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "State paths may not traverse links or non-directories",
      );
    }
  }
}

interface BoundPublicationDirectory {
  readonly descriptor: number;
  readonly identity: Stats;
  tryOpenFile(name: string, flags: number, mode: number): number | null;
  tryOpenRetainedFile(name: string, flags: number, mode: number): number | null;
  openFile(name: string, flags: number, mode: number): number;
  renameExclusive(oldName: string, newName: string, onRenamed: () => void): void;
  renameExchange(oldName: string, newName: string): void;
  makeDirectory(name: string, mode: number): void;
  unlink(name: string): void;
  unlinkRetained(name: string): void;
  removeDirectory(name: string): void;
  assertStable(): void;
  sync(): void;
  syncRetained(): void;
  close(): void;
}

function bindPublicationDirectory(path: string): BoundPublicationDirectory {
  const descriptor = openDirectoryPathByDescriptor(path);
  return bindPublicationDirectoryDescriptor(path, descriptor);
}

function openDirectoryPathByDescriptor(path: string): number {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Backup publication directories must use normalized absolute paths",
    );
  }
  const libraryPath = process.platform === "darwin"
    ? "/usr/lib/libSystem.B.dylib"
    : process.platform === "linux"
    ? "libc.so.6"
    : null;
  if (libraryPath === null) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Descriptor-relative backup publication is unsupported",
    );
  }
  const library = dlopen(libraryPath, {
    openat: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  const parsed = parse(path);
  let descriptor: number | null = null;
  let failure: unknown = null;
  try {
    descriptor = openSync(parsed.root, protectedDirectoryReadFlags);
    for (const component of path.slice(parsed.root.length).split(sep).filter(Boolean)) {
      const next: number = library.symbols.openat(
        descriptor,
        Buffer.from(`${component}\0`),
        protectedDirectoryReadFlags,
        0,
      );
      if (next < 0) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Backup publication path could not be bound without following links",
        );
      }
      let nextIsDirectory = false;
      try {
        nextIsDirectory = fstatSync(next).isDirectory();
      } finally {
        if (!nextIsDirectory) closeSync(next);
      }
      if (!nextIsDirectory) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Backup publication path contains a non-directory",
        );
      }
      const previousDescriptor: number = descriptor;
      try {
        closeSync(previousDescriptor);
      } catch (error: unknown) {
        try {
          closeSync(next);
        } catch {
          // Preserve the descriptor-walk close failure.
        }
        throw error;
      }
      descriptor = next;
    }
  } catch (error: unknown) {
    failure = error;
  }
  try {
    library.close();
  } catch (error: unknown) {
    if (failure === null) failure = error;
  }
  if (failure !== null || descriptor === null) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the descriptor-walk failure.
      }
    }
    if (failure !== null) {
      throwControlPlaneFailure(
        failure,
        "Backup publication path could not be bound safely",
      );
    }
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Backup publication path could not be bound",
    );
  }
  return descriptor;
}

function bindPublicationDirectoryAt(
  parent: BoundPublicationDirectory,
  name: string,
  path: string,
): BoundPublicationDirectory {
  const descriptor = parent.openFile(
    name,
    protectedDirectoryReadFlags,
    0,
  );
  return bindPublicationDirectoryDescriptor(
    path,
    descriptor,
    parent.identity.dev,
  );
}

function bindPublicationDirectoryDescriptor(
  path: string,
  descriptor: number,
  expectedDevice?: number,
): BoundPublicationDirectory {
  const libraryPath = process.platform === "darwin"
    ? "/usr/lib/libSystem.B.dylib"
    : process.platform === "linux"
    ? "libc.so.6"
    : null;
  if (libraryPath === null) {
    closeSync(descriptor);
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Descriptor-relative backup publication is unsupported",
    );
  }
  let library: ReturnType<typeof dlopen<{
    openat: {
      args: readonly [
        typeof FFIType.i32,
        typeof FFIType.cstring,
        typeof FFIType.i32,
        typeof FFIType.i32,
      ];
      returns: typeof FFIType.i32;
    };
    linkat: {
      args: readonly [
        typeof FFIType.i32,
        typeof FFIType.cstring,
        typeof FFIType.i32,
        typeof FFIType.cstring,
        typeof FFIType.i32,
      ];
      returns: typeof FFIType.i32;
    };
    mkdirat: {
      args: readonly [typeof FFIType.i32, typeof FFIType.cstring, typeof FFIType.i32];
      returns: typeof FFIType.i32;
    };
    unlinkat: {
      args: readonly [typeof FFIType.i32, typeof FFIType.cstring, typeof FFIType.i32];
      returns: typeof FFIType.i32;
    };
  }>>;
  try {
    library = dlopen(libraryPath, {
      openat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      linkat: {
        args: [
          FFIType.i32,
          FFIType.cstring,
          FFIType.i32,
          FFIType.cstring,
          FFIType.i32,
        ],
        returns: FFIType.i32,
      },
      mkdirat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32],
        returns: FFIType.i32,
      },
      unlinkat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32],
        returns: FFIType.i32,
      },
    });
  } catch (error: unknown) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the dynamic-library construction failure.
    }
    throw error;
  }
  let renameExclusiveNative: (oldName: Buffer, newName: Buffer) => number;
  let renameExchangeNative: (oldName: Buffer, newName: Buffer) => number;
  let closeRenameLibrary: () => void;
  try {
    if (process.platform === "darwin") {
      const renameLibrary = dlopen(libraryPath, {
        renameatx_np: {
          args: [
            FFIType.i32,
            FFIType.cstring,
            FFIType.i32,
            FFIType.cstring,
            FFIType.u32,
          ],
          returns: FFIType.i32,
        },
      });
      renameExclusiveNative = (oldName, newName) =>
        renameLibrary.symbols.renameatx_np(
          descriptor,
          oldName,
          descriptor,
          newName,
          0x00000004 | 0x00000010,
        );
      renameExchangeNative = (oldName, newName) =>
        renameLibrary.symbols.renameatx_np(
          descriptor,
          oldName,
          descriptor,
          newName,
          0x00000002 | 0x00000010,
        );
      closeRenameLibrary = () => renameLibrary.close();
    } else {
      const renameLibrary = dlopen(libraryPath, {
        renameat2: {
          args: [
            FFIType.i32,
            FFIType.cstring,
            FFIType.i32,
            FFIType.cstring,
            FFIType.u32,
          ],
          returns: FFIType.i32,
        },
      });
      renameExclusiveNative = (oldName, newName) =>
        renameLibrary.symbols.renameat2(
          descriptor,
          oldName,
          descriptor,
          newName,
          0x00000001,
        );
      renameExchangeNative = (oldName, newName) =>
        renameLibrary.symbols.renameat2(
          descriptor,
          oldName,
          descriptor,
          newName,
          0x00000002,
        );
      closeRenameLibrary = () => renameLibrary.close();
    }
  } catch (error: unknown) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the exclusive-rename binding failure.
    }
    try {
      library.close();
    } catch {
      // Preserve the exclusive-rename binding failure.
    }
    throw error;
  }
  let closed = false;
  let identity: Stats;
  try {
    identity = fstatSync(descriptor);
  } catch (error: unknown) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the descriptor inspection failure.
    }
    try {
      library.close();
    } catch {
      // Preserve the descriptor inspection failure.
    }
    try {
      closeRenameLibrary();
    } catch {
      // Preserve the descriptor inspection failure.
    }
    throw error;
  }
  const currentUser = process.getuid?.();
  if (
    !identity.isDirectory()
    || identity.nlink < 2
    || (expectedDevice !== undefined && identity.dev !== expectedDevice)
    || (identity.mode & 0o022) !== 0
    || (currentUser !== undefined && identity.uid !== currentUser)
  ) {
    try {
      closeSync(descriptor);
    } catch {
      // The unsafe-parent verdict remains authoritative.
    }
    try {
      library.close();
    } catch {
      // The unsafe-parent verdict remains authoritative.
    }
    try {
      closeRenameLibrary();
    } catch {
      // The unsafe-parent verdict remains authoritative.
    }
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Backup publication parent is unsafe",
    );
  }
  const cstring = (name: string): Buffer => {
    if (name.length === 0 || name.includes("/") || name.includes("\0")) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Backup publication name is unsafe",
      );
    }
    return Buffer.from(`${name}\0`);
  };
  const assertDescriptorStable = (): void => {
    const descriptorMetadata = fstatSync(descriptor);
    if (
      !descriptorMetadata.isDirectory()
      || descriptorMetadata.dev !== identity.dev
      || descriptorMetadata.ino !== identity.ino
      || descriptorMetadata.nlink < 2
      || (descriptorMetadata.mode & 0o777) !== (identity.mode & 0o777)
      || (descriptorMetadata.mode & 0o022) !== 0
      || (currentUser !== undefined && descriptorMetadata.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Backup publication parent descriptor changed",
      );
    }
  };
  const assertStable = (): void => {
    assertDescriptorStable();
    const pathMetadata = lstatSync(path);
    if (
      !pathMetadata.isDirectory()
      || pathMetadata.isSymbolicLink()
      || pathMetadata.dev !== identity.dev
      || pathMetadata.ino !== identity.ino
      || pathMetadata.nlink < 2
      || (pathMetadata.mode & 0o777) !== (identity.mode & 0o777)
      || (pathMetadata.mode & 0o022) !== 0
      || (currentUser !== undefined && pathMetadata.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Backup publication parent identity changed",
      );
    }
  };
  const tryOpenRetainedFile = (name: string, flags: number, mode: number): number | null => {
    assertDescriptorStable();
    const opened = library.symbols.openat(
      descriptor,
      cstring(name),
      flags,
      mode,
    );
    if (opened < 0) {
      assertDescriptorStable();
      return null;
    }
    try {
      assertDescriptorStable();
      return opened;
    } catch (error: unknown) {
      try {
        closeSync(opened);
      } catch {
        // Preserve the retained-parent identity failure.
      }
      throw error;
    }
  };
  const unlinkRetained = (name: string): void => {
    assertDescriptorStable();
    if (library.symbols.unlinkat(descriptor, cstring(name), 0) !== 0) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Backup staging name could not be removed safely",
      );
    }
    assertDescriptorStable();
  };
  return {
    descriptor,
    identity,
    tryOpenFile(name, flags, mode) {
      assertStable();
      const opened = tryOpenRetainedFile(name, flags, mode);
      assertStable();
      return opened;
    },
    tryOpenRetainedFile,
    openFile(name, flags, mode) {
      const opened = this.tryOpenFile(name, flags, mode);
      if (opened === null) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Backup staging name could not be opened safely",
        );
      }
      return opened;
    },
    renameExclusive(oldName, newName, onRenamed) {
      assertStable();
      if (renameExclusiveNative(cstring(oldName), cstring(newName)) !== 0) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Backup destination already exists or changed",
        );
      }
      onRenamed();
      assertStable();
    },
    renameExchange(oldName, newName) {
      assertStable();
      if (renameExchangeNative(cstring(oldName), cstring(newName)) !== 0) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Restore journal exchange could not be completed safely",
        );
      }
      assertStable();
    },
    makeDirectory(name, mode) {
      assertStable();
      if (library.symbols.mkdirat(descriptor, cstring(name), mode) !== 0) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Backup staging directory could not be created safely",
        );
      }
      assertStable();
    },
    unlink(name) {
      assertStable();
      unlinkRetained(name);
      assertStable();
    },
    unlinkRetained,
    removeDirectory(name) {
      assertStable();
      const atRemoveDirectory = process.platform === "darwin" ? 0x80 : 0x200;
      if (
        library.symbols.unlinkat(
          descriptor,
          cstring(name),
          atRemoveDirectory,
        ) !== 0
      ) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Backup staging directory could not be removed safely",
        );
      }
      assertStable();
    },
    assertStable,
    sync() {
      assertStable();
      fsyncSync(descriptor);
      assertStable();
    },
    syncRetained() {
      assertDescriptorStable();
      fsyncSync(descriptor);
      assertDescriptorStable();
    },
    close() {
      if (closed) return;
      let firstFailure: unknown = null;
      try {
        closeSync(descriptor);
      } catch (error: unknown) {
        firstFailure = error;
      }
      try {
        library.close();
      } catch (error: unknown) {
        if (firstFailure === null) firstFailure = error;
      }
      try {
        closeRenameLibrary();
      } catch (error: unknown) {
        if (firstFailure === null) firstFailure = error;
      }
      closed = true;
      if (firstFailure !== null) {
        throwControlPlaneFailure(
          firstFailure,
          "Backup publication authority could not be closed safely",
        );
      }
    },
  };
}

function writeEncryptedBackupAtomically(input: Readonly<{
  path: string;
  manifestBytes: Uint8Array;
  passphrase: string;
  salt: Uint8Array;
  iv: Uint8Array;
  operationReceiptKey: Uint8Array;
  databaseBytes: Uint8Array;
  attachmentVaultRoot: string;
  attachmentVaultManifest: AttachmentVaultPayloadManifest;
  publication: BoundPublicationDirectory;
  assertControlPlaneRootStable(): void;
  onPublicationCheckpoint?: (
    point: ControlPlaneBackupPublicationFaultPoint,
  ) => void;
}>): Readonly<{ byteLength: number; sha256: string }> {
  const path = input.path;
  const destinationName = basename(path);
  const candidateName = `.${destinationName}.hraness-backup-v2.tmp`;
  const vaultManifest = parseAttachmentVaultPayloadManifest(
    input.attachmentVaultManifest,
  );
  const vaultManifestBytes = Buffer.from(JSON.stringify(vaultManifest), "utf8");
  let budget: ReturnType<typeof estimateControlPlaneBackupMemoryBudget>;
  try {
    budget = estimateControlPlaneBackupMemoryBudget({
      databaseByteLength: input.databaseBytes.byteLength,
      vaultManifestByteLength: vaultManifestBytes.byteLength,
      vaultBlobByteLength: vaultManifest.totalBytes,
    });
  } catch (error: unknown) {
    vaultManifestBytes.fill(0);
    throw error;
  }
  const expectedArchiveByteLength = archiveMagic.byteLength
    + archiveLengthPrefixByteLength
    + input.manifestBytes.byteLength
    + budget.payloadByteLength
    + archiveTagByteLength;
  if (
    input.manifestBytes.byteLength <= 0
    || input.manifestBytes.byteLength > maximumManifestByteLength
    || expectedArchiveByteLength > maximumArchiveByteLength
  ) {
    vaultManifestBytes.fill(0);
    throw new ControlPlaneBackupError("invalid_input", "Encrypted backup is too large");
  }

  let encryptionKey: Uint8Array;
  try {
    encryptionKey = deriveEncryptionKey(input.passphrase, input.salt);
  } catch (error: unknown) {
    vaultManifestBytes.fill(0);
    throw error;
  }
  const publication = input.publication;
  publication.assertStable();
  input.assertControlPlaneRootStable();
  let descriptor: number;
  try {
    const staleDescriptor = publication.tryOpenFile(
      candidateName,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExecFlag,
      0,
    );
    if (staleDescriptor !== null) {
      try {
        const stale = fstatSync(staleDescriptor);
        const currentUser = process.getuid?.();
        if (
          !stale.isFile()
          || stale.nlink !== 1
          || stale.dev !== publication.identity.dev
          || stale.size > maximumArchiveByteLength
          || (stale.mode & 0o777) !== 0o600
          || (currentUser !== undefined && stale.uid !== currentUser)
        ) {
          throw new ControlPlaneBackupError(
            "unsafe_path",
            "Backup staging path is unsafe",
          );
        }
      } finally {
        closeSync(staleDescriptor);
      }
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "Backup staging path already exists and requires manual recovery",
      );
    }
    const openedDescriptor = publication.openFile(
      candidateName,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
        | constants.O_NONBLOCK | closeOnExecFlag,
      0o600,
    );
    try {
      const openedIdentity = fstatSync(openedDescriptor);
      if (openedIdentity.dev !== publication.identity.dev) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Backup staging file crossed its publication device",
        );
      }
    } catch (error: unknown) {
      try {
        closeSync(openedDescriptor);
      } catch {
        // Preserve the staging identity failure.
      }
      throw error;
    }
    descriptor = openedDescriptor;
  } catch (error: unknown) {
    encryptionKey.fill(0);
    vaultManifestBytes.fill(0);
    throw error;
  }
  const archiveDigest = createHash("sha256");
  let archiveSha256: string | null = null;
  let archiveByteLength = 0;
  let plaintextByteLength = 0;
  let ciphertextByteLength = 0;
  let destinationDescriptor: number | null = null;
  const writeArchiveBytes = (bytes: Uint8Array): void => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
      );
      if (written <= 0) {
        throw new ControlPlaneBackupError(
          "invalid_input",
          "Encrypted backup staging write was incomplete",
        );
      }
      offset += written;
    }
    archiveDigest.update(bytes);
    archiveByteLength += bytes.byteLength;
  };
  try {
    const archivePrefix = Buffer.alloc(
      archiveMagic.byteLength + archiveLengthPrefixByteLength,
    );
    archiveMagic.copy(archivePrefix, 0);
    archivePrefix.writeUInt32BE(
      input.manifestBytes.byteLength,
      archiveMagic.byteLength,
    );
    writeArchiveBytes(archivePrefix);
    writeArchiveBytes(input.manifestBytes);

    const cipher = createCipheriv("aes-256-gcm", encryptionKey, input.iv, {
      authTagLength: archiveTagByteLength,
    });
    cipher.setAAD(archiveAdditionalAuthenticatedData(input.manifestBytes));
    const writePlaintext = (bytes: Uint8Array): void => {
      if (bytes.byteLength === 0) return;
      plaintextByteLength += bytes.byteLength;
      if (plaintextByteLength > budget.payloadByteLength) {
        throw new ControlPlaneBackupError(
          "invalid_input",
          "Backup plaintext exceeded its authenticated length",
        );
      }
      const encrypted = cipher.update(bytes);
      ciphertextByteLength += encrypted.byteLength;
      writeArchiveBytes(encrypted);
    };
    const payloadPrefix = Buffer.alloc(
      payloadMagic.byteLength
      + payloadLengthPrefixByteLength
      + vaultManifestLengthPrefixByteLength,
    );
    payloadMagic.copy(payloadPrefix, 0);
    payloadPrefix.writeBigUInt64BE(
      BigInt(input.databaseBytes.byteLength),
      payloadMagic.byteLength,
    );
    payloadPrefix.writeUInt32BE(
      vaultManifestBytes.byteLength,
      payloadMagic.byteLength + payloadLengthPrefixByteLength,
    );
    writePlaintext(payloadPrefix);
    writePlaintext(input.operationReceiptKey);
    for (
      let offset = 0;
      offset < input.databaseBytes.byteLength;
      offset += maximumControlPlaneBackupStreamingChunkByteLength
    ) {
      writePlaintext(input.databaseBytes.subarray(
        offset,
        Math.min(
          input.databaseBytes.byteLength,
          offset + maximumControlPlaneBackupStreamingChunkByteLength,
        ),
      ));
    }
    writePlaintext(vaultManifestBytes);
    streamControlPlaneAttachmentVault({
      root: input.attachmentVaultRoot,
      expected: {
        generationSha256: vaultManifest.generationSha256,
        totalBytes: vaultManifest.totalBytes,
        blobs: vaultManifest.blobs,
      },
      onChunk: (_blob, chunk) => writePlaintext(chunk),
    });
    if (plaintextByteLength !== budget.payloadByteLength) {
      throw new ControlPlaneBackupError(
        "invalid_input",
        "Backup plaintext ended before its authenticated length",
      );
    }
    const finalCiphertext = cipher.final();
    ciphertextByteLength += finalCiphertext.byteLength;
    writeArchiveBytes(finalCiphertext);
    const authenticationTag = cipher.getAuthTag();
    try {
      if (
        ciphertextByteLength !== budget.payloadByteLength
        || authenticationTag.byteLength !== archiveTagByteLength
      ) {
        throw new ControlPlaneBackupError(
          "invalid_input",
          "Encrypted backup length is inconsistent",
        );
      }
      writeArchiveBytes(authenticationTag);
    } finally {
      authenticationTag.fill(0);
    }
    if (archiveByteLength !== expectedArchiveByteLength) {
      throw new ControlPlaneBackupError(
        "invalid_input",
        "Encrypted backup archive length is inconsistent",
      );
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const staged = fstatSync(descriptor);
    if (
      !staged.isFile()
      || staged.nlink !== 1
      || staged.size !== expectedArchiveByteLength
      || (staged.mode & 0o777) !== 0o600
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Encrypted backup staging identity changed",
      );
    }
    const intendedSha256 = archiveDigest.digest("hex");
    const stagedSha256 = hashOpenDescriptor(
      descriptor,
      expectedArchiveByteLength,
      staged,
    );
    if (!safeHexEqual(intendedSha256, stagedSha256)) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Encrypted backup staging content changed before publication",
      );
    }
    archiveSha256 = stagedSha256;
    publication.assertStable();
    input.assertControlPlaneRootStable();
    input.onPublicationCheckpoint?.("after_staged_hash_before_publish");
    publication.renameExclusive(candidateName, destinationName, () => {
      input.onPublicationCheckpoint?.("after_publish_before_parent_recheck");
    });
    input.assertControlPlaneRootStable();
    const publishedCandidate = fstatSync(descriptor);
    if (
      !publishedCandidate.isFile()
      || publishedCandidate.dev !== staged.dev
      || publishedCandidate.ino !== staged.ino
      || publishedCandidate.nlink !== 1
      || publishedCandidate.size !== staged.size
      || (publishedCandidate.mode & 0o777) !== 0o600
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Encrypted backup publication identity changed",
      );
    }
    destinationDescriptor = publication.openFile(
      destinationName,
      protectedReadFlags,
      0,
    );
    const publishedDestination = fstatSync(destinationDescriptor);
    if (
      publishedDestination.dev !== publishedCandidate.dev
      || publishedDestination.ino !== publishedCandidate.ino
      || publishedDestination.nlink !== 1
      || publishedDestination.size !== publishedCandidate.size
      || !safeHexEqual(
        hashOpenDescriptor(
          descriptor,
          expectedArchiveByteLength,
          publishedCandidate,
        ),
        archiveSha256,
      )
      || !safeHexEqual(
        hashOpenDescriptor(
          destinationDescriptor,
          expectedArchiveByteLength,
          publishedDestination,
        ),
        archiveSha256,
      )
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Published backup bytes do not match the retained staging inode",
      );
    }
    input.onPublicationCheckpoint?.("after_publish_verified_before_parent_fsync");
    publication.sync();
    input.assertControlPlaneRootStable();
    input.onPublicationCheckpoint?.("after_publish_parent_fsync");
    const durableCandidate = fstatSync(descriptor);
    const durableDestination = fstatSync(destinationDescriptor);
    if (
      durableCandidate.dev !== staged.dev
      || durableCandidate.ino !== staged.ino
      || durableCandidate.nlink !== 1
      || durableDestination.dev !== staged.dev
      || durableDestination.ino !== staged.ino
      || durableDestination.nlink !== 1
      || !safeHexEqual(
        hashOpenDescriptor(
          descriptor,
          expectedArchiveByteLength,
          durableCandidate,
        ),
        archiveSha256,
      )
      || !safeHexEqual(
        hashOpenDescriptor(
          destinationDescriptor,
          expectedArchiveByteLength,
          durableDestination,
        ),
        archiveSha256,
      )
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Published backup identity changed after durable cleanup",
      );
    }
    closeSync(destinationDescriptor);
    destinationDescriptor = null;
    closeSync(descriptor);
  } catch (error: unknown) {
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch {
        // Preserve the original create/publication failure. Fixed encrypted
        // residue is rejected untouched because no journal proves deletion.
      }
    };
    if (destinationDescriptor !== null) {
      attempt(() => closeSync(destinationDescriptor!));
      destinationDescriptor = null;
    }
    attempt(() => closeSync(descriptor));
    throw error;
  } finally {
    encryptionKey.fill(0);
    vaultManifestBytes.fill(0);
  }
  if (archiveSha256 === null) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "Encrypted backup digest was not finalized",
    );
  }
  return {
    byteLength: archiveByteLength,
    sha256: archiveSha256,
  };
}

function hashOpenDescriptor(
  descriptor: number,
  byteLength: number,
  identity: Stats,
): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(maximumControlPlaneBackupStreamingChunkByteLength);
  let offset = 0;
  try {
    while (offset < byteLength) {
      const expected = Math.min(buffer.byteLength, byteLength - offset);
      const read = readSync(descriptor, buffer, 0, expected, offset);
      if (read !== expected) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Encrypted backup staging readback was incomplete",
        );
      }
      digest.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== identity.dev
      || after.ino !== identity.ino
      || after.nlink !== identity.nlink
      || after.size !== identity.size
      || after.mtimeMs !== identity.mtimeMs
      || after.ctimeMs !== identity.ctimeMs
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Encrypted backup staging identity changed during readback",
      );
    }
    return digest.digest("hex");
  } finally {
    buffer.fill(0);
  }
}

export function recoverPublishedCreateOnlyBackup(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) return;
  const parent = dirname(path);
  const destinationName = basename(path);
  const candidateName = `.${destinationName}.hraness-backup-v2.tmp`;
  const currentUser = process.getuid?.();
  const publication = bindPublicationDirectory(parent);
  let candidateDescriptor: number | null = null;
  let destinationDescriptor: number | null = null;
  let operationFailure: unknown = null;
  try {
    candidateDescriptor = publication.tryOpenFile(
      candidateName,
      protectedReadFlags,
      0,
    );
    if (candidateDescriptor === null) return;
    const candidateMetadata = fstatSync(candidateDescriptor);
    if (candidateMetadata.nlink === 1) {
      if (
        !candidateMetadata.isFile()
        || candidateMetadata.dev !== publication.identity.dev
        || candidateMetadata.size > maximumArchiveByteLength
        || (candidateMetadata.mode & 0o777) !== 0o600
        || (currentUser !== undefined && candidateMetadata.uid !== currentUser)
      ) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Backup staging path is unsafe",
        );
      }
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "Backup staging path exists without deletion provenance",
      );
    }
    destinationDescriptor = publication.tryOpenFile(
      destinationName,
      protectedReadFlags,
      0,
    );
    const destinationMetadata = destinationDescriptor === null
      ? null
      : fstatSync(destinationDescriptor);
    const safeFile = (metadata: Stats | null): metadata is Stats =>
      metadata !== null
    && metadata.isFile()
    && metadata.nlink === 2
    && metadata.dev === publication.identity.dev
    && metadata.size > 0
    && metadata.size <= maximumArchiveByteLength
    && (metadata.mode & 0o777) === 0o600
    && (currentUser === undefined || metadata.uid === currentUser);
    if (
      !safeFile(candidateMetadata)
      || !safeFile(destinationMetadata)
      || candidateMetadata.dev !== destinationMetadata.dev
      || candidateMetadata.ino !== destinationMetadata.ino
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Backup staging path has an unexpected hard link",
      );
    }
    // Metadata cannot distinguish a writer crash from a hard link created
    // after a valid archive was published. Read/verify paths therefore reject
    // this ambiguous state without deleting or finalizing either name.
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      "Backup publication has an ambiguous retained staging link",
    );
  } catch (error: unknown) {
    operationFailure = error;
  } finally {
    let firstFailure: unknown = null;
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error: unknown) {
        if (firstFailure === null) firstFailure = error;
      }
    };
    if (candidateDescriptor !== null) attempt(() => closeSync(candidateDescriptor!));
    if (destinationDescriptor !== null) attempt(() => closeSync(destinationDescriptor!));
    attempt(() => publication.close());
    if (operationFailure === null && firstFailure !== null) {
      throwControlPlaneFailure(
        firstFailure,
        "Backup publication recovery authority could not be closed safely",
      );
    }
  }
  if (operationFailure !== null) {
    throwControlPlaneFailure(
      operationFailure,
      "Backup publication recovery failed",
    );
  }
}


function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Uint8Array {
  if (!isAbsolute(path)) {
    throw new ControlPlaneBackupError("unsafe_path", `${label} path must be absolute`);
  }
  assertNoSymlinkDirectory(dirname(path));
  const parent = lstatSync(dirname(path));
  const descriptor = openSync(path, protectedReadFlags);
  let result: Uint8Array | null = null;
  let failure: Error | null = null;
  try {
    const metadata = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.dev !== parent.dev
      || metadata.size <= 0
      || metadata.size > maximumBytes
      || (metadata.mode & 0o777) !== 0o600
      || (currentUser !== undefined && metadata.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        `${label} must be one bounded owned regular file`,
      );
    }
    result = Uint8Array.from(readFileSync(descriptor));
    const after = fstatSync(descriptor);
    if (
      result.byteLength !== metadata.size
      || after.dev !== metadata.dev
      || after.ino !== metadata.ino
      || after.nlink !== metadata.nlink
      || after.size !== metadata.size
      || after.mode !== metadata.mode
      || after.uid !== metadata.uid
      || after.mtimeMs !== metadata.mtimeMs
      || after.ctimeMs !== metadata.ctimeMs
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        `${label} changed while it was read`,
      );
    }
  } catch (error: unknown) {
    failure = error instanceof Error
      ? error
      : new ControlPlaneBackupError(
        "unsafe_path",
        `${label} could not be read safely`,
      );
  }
  try {
    closeSync(descriptor);
  } catch (error: unknown) {
    if (failure === null) {
      failure = error instanceof Error
        ? error
        : new ControlPlaneBackupError(
          "unsafe_path",
          `${label} descriptor could not be closed safely`,
        );
    }
  }
  if (failure !== null) {
    result?.fill(0);
    throw failure;
  }
  if (result === null) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      `${label} read did not produce bytes`,
    );
  }
  return result;
}

function assertPrivateRestoreArtifact(
  path: string,
  parentMetadata: Stats,
  minimumBytes: number,
  maximumBytes: number,
  label: string,
): void {
  const metadata = readMetadata(path);
  const currentUser = process.getuid?.();
  if (
    metadata === null
    || metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || metadata.dev !== parentMetadata.dev
    || metadata.size < minimumBytes
    || metadata.size > maximumBytes
    || (metadata.mode & 0o777) !== 0o600
    || (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      `The ${label} is not protected restore state`,
    );
  }
}

function assertOptionalPrivateRegularFile(path: string, size: number | null): void {
  if (readMetadata(path) !== null) assertPrivateRegularFile(path, size);
}

function assertOptionalPrivateRegularFileReadOnly(
  path: string,
  size: number | null,
): void {
  const metadata = readMetadata(path);
  if (metadata === null) return;
  const currentUser = process.getuid?.();
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
    || (size !== null && metadata.size !== size)
    || (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Protected control-plane restore state is not already private",
    );
  }
}

function assertPrivateRegularFile(path: string, size: number | null): void {
  const metadata = lstatSync(path);
  const currentUser = process.getuid?.();
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1
    || (size !== null && metadata.size !== size)
    || (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Protected control-plane restore state is unsafe",
    );
  }
  chmodSync(path, 0o600);
}

function inspectRestoreSqliteSidecars(
  paths: RestorePaths,
): readonly string[] {
  try {
    return inspectControlPlaneRestoreSqliteSidecars(paths);
  } catch {
    throw new ControlPlaneBackupError("unsafe_path", "SQLite sidecar is unsafe");
  }
}

function removeRestoreSqliteSidecars(paths: RestorePaths): void {
  const present = inspectRestoreSqliteSidecars(paths);
  if (present.length === 0) return;
  for (const path of present) unlinkSync(path);
  syncDirectory(paths.parent);
}

function removeIfPresent(path: string): void {
  const metadata = readMetadata(path);
  if (metadata === null) return;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new ControlPlaneBackupError("unsafe_path", "Restore artifact is unsafe");
  }
  unlinkSync(path);
}

function pathExists(path: string): boolean {
  return readMetadata(path) !== null;
}

function readMetadata(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, protectedReadFlags);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parsePassphrase(value: unknown): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < minimumPassphraseByteLength
    || Buffer.byteLength(value, "utf8") > maximumPassphraseByteLength
  ) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "Backup passphrase must contain 16 to 4096 UTF-8 bytes",
    );
  }
  return value;
}

function parseOperationReceiptKey(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== operationReceiptKeyByteLength) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "Operation-receipt key has an invalid length",
    );
  }
  return Uint8Array.from(value);
}

function deriveEncryptionKey(passphrase: string, salt: Uint8Array): Buffer {
  try {
    return scryptSync(passphrase, salt, encryptionKeyByteLength, {
      N: scryptCost,
      r: scryptBlockSize,
      p: scryptParallelization,
      maxmem: scryptMaximumMemory,
    });
  } catch {
    throw new ControlPlaneBackupError("invalid_input", "Backup key derivation failed");
  }
}

function archiveAdditionalAuthenticatedData(manifestBytes: Uint8Array): Buffer {
  return Buffer.concat([archiveMagic, Buffer.from(manifestBytes)]);
}

function decodeBase64Exact(value: string, expectedLength: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength !== expectedLength
    || bytes.toString("base64") !== value
  ) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Backup base64 metadata is invalid",
    );
  }
  return bytes;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key: Uint8Array, value: Uint8Array): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.byteLength === 32
    && rightBytes.byteLength === 32
    && timingSafeEqual(leftBytes, rightBytes)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function controlPlaneFailure(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error
    ? error
    : new ControlPlaneBackupError("restore_interrupted", fallbackMessage);
}

function throwControlPlaneFailure(error: unknown, fallbackMessage: string): never {
  throw controlPlaneFailure(error, fallbackMessage);
}

function hasCode(error: unknown, expected: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === expected;
}
