import { Database } from "bun:sqlite";
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
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { z } from "@hra-internal/schema";
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
  controlPlaneRestoreJournalSchema as restoreJournalSchema,
  controlPlaneRestorePaths,
  inspectControlPlaneRestoreSqliteSidecars,
  maximumControlPlaneRestoreJournalByteLength as maximumJournalByteLength,
  type ControlPlaneRestoreJournal,
  type ControlPlaneRestorePaths,
} from "./control-plane-restore-state";

const archiveMagic = Buffer.from("HKCPB001", "ascii");
const payloadMagic = Buffer.from("HKCPDB01", "ascii");
const archiveTagByteLength = 16;
const archiveLengthPrefixByteLength = 4;
const payloadLengthPrefixByteLength = 8;
const encryptionKeyByteLength = 32;
const saltByteLength = 16;
const ivByteLength = 12;
const maximumManifestByteLength = 16 * 1_024;
const maximumArchiveByteLength = 1_073_741_824;
const maximumDatabaseByteLength = maximumArchiveByteLength - 1_048_576;
const maximumPassphraseByteLength = 4_096;
const scryptCost = 131_072;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const scryptMaximumMemory = 256 * 1_024 * 1_024;

const hexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
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
  formatVersion: z.literal(1),
  kind: z.literal("hraness-kitchen-control-plane-backup"),
  createdAt: z.number().int().nonnegative(),
  sourceRelease: releaseIdentitySchema,
  sourceMigrationVersion: z.number().int().positive(),
  sourceHashes: z.object({
    databaseSha256: hexDigestSchema,
    schemaSha256: hexDigestSchema,
    migrationHistorySha256: hexDigestSchema,
    receiptBindingHmacSha256: hexDigestSchema,
  }).strict(),
  checkpointProof: checkpointProofSchema,
  payloadByteLength: z.number().int().positive().max(maximumArchiveByteLength),
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
  readonly formatVersion: 1;
  readonly kind: "hraness-kitchen-control-plane-backup";
  readonly createdAt: number;
  readonly sourceRelease: AppReleaseIdentity;
  readonly sourceMigrationVersion: number;
  readonly sourceHashes: Readonly<{
    databaseSha256: string;
    schemaSha256: string;
    migrationHistorySha256: string;
    receiptBindingHmacSha256: string;
  }>;
  readonly checkpointProof: Readonly<{
    busy: 0;
    log: number;
    checkpointed: number;
    sourceQuickCheck: "ok";
    snapshotQuickCheck: "ok";
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
  | "after_prepared"
  | "after_database_rollback_staged"
  | "after_database_replaced"
  | "after_key_rollback_staged"
  | "after_key_replaced"
  | "after_validation"
  | "after_database_rollback_removed"
  | "after_key_rollback_removed";

export interface CreateControlPlaneBackupInput {
  readonly database: Database;
  readonly destinationPath: string;
  readonly operationReceiptKey: Uint8Array;
  readonly passphrase: string;
  readonly releaseIdentity: AppReleaseIdentity;
  /** Defaults to true for the existing rolling-backup API. */
  readonly replaceExisting?: boolean;
  readonly now?: () => number;
}

export interface RestoreControlPlaneBackupInput {
  readonly archivePath: string;
  readonly databasePath: string;
  readonly passphrase: string;
  readonly releaseIdentity: AppReleaseIdentity;
  /**
   * When present, restore is authorized only for these exact archive bytes.
   * Operator-facing restore always supplies the digest returned by verify.
   */
  readonly confirmedArchiveSha256?: string;
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
}

export interface ControlPlaneRestoreResult {
  readonly archiveSha256: string;
  readonly manifest: ControlPlaneBackupManifest;
  readonly restoredMigrationVersion: number;
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
  const databaseBytes = normalizeSerializedSnapshot(input.database.serialize());
  if (
    databaseBytes.byteLength === 0
    || databaseBytes.byteLength > maximumDatabaseByteLength
  ) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "The control-plane database exceeds the portable backup bound",
    );
  }

  const snapshotProof = inspectSnapshot(databaseBytes, releaseIdentity);
  if (snapshotProof.migrationVersion !== compatibility.migrationVersion) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "The serialized control-plane migration changed during backup",
    );
  }
  const databaseSha256 = sha256(databaseBytes);
  const schemaSha256 = hashSchema(snapshotProof.database);
  const migrationHistorySha256 = hashMigrationHistory(snapshotProof.database);
  snapshotProof.database.close();

  const bindingPreimage = sourceBindingPreimage({
    databaseSha256,
    schemaSha256,
    migrationHistorySha256,
    migrationVersion: compatibility.migrationVersion,
    sourceRelease: releaseIdentity,
  });
  const receiptBindingHmacSha256 = hmacSha256(receiptKey, bindingPreimage);
  const salt = Uint8Array.from(randomBytes(saltByteLength));
  const iv = Uint8Array.from(randomBytes(ivByteLength));
  const payload = encodePayload(receiptKey, databaseBytes);
  const manifest: ControlPlaneBackupManifest = {
    formatVersion: 1,
    kind: "hraness-kitchen-control-plane-backup",
    createdAt: now,
    sourceRelease: releaseIdentity,
    sourceMigrationVersion: compatibility.migrationVersion,
    sourceHashes: {
      databaseSha256,
      schemaSha256,
      migrationHistorySha256,
      receiptBindingHmacSha256,
    },
    checkpointProof: {
      busy: 0,
      log: checkpoint.log,
      checkpointed: checkpoint.checkpointed,
      sourceQuickCheck: "ok",
      snapshotQuickCheck: "ok",
    },
    payloadByteLength: payload.byteLength,
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
  const encryptionKey = deriveEncryptionKey(passphrase, salt);
  let ciphertext: Buffer | null = null;
  let authenticationTag: Buffer | null = null;
  try {
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv, {
      authTagLength: archiveTagByteLength,
    });
    cipher.setAAD(archiveAdditionalAuthenticatedData(manifestBytes));
    ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    authenticationTag = cipher.getAuthTag();
    const archive = encodeArchive(manifestBytes, ciphertext, authenticationTag);
    writeBackupAtomically(
      input.destinationPath,
      archive,
      input.replaceExisting ?? true,
    );
    return {
      archiveByteLength: archive.byteLength,
      archiveSha256: sha256(archive),
      manifest,
    };
  } finally {
    encryptionKey.fill(0);
    payload.fill(0);
    databaseBytes.fill(0);
    receiptKey.fill(0);
    ciphertext?.fill(0);
    authenticationTag?.fill(0);
  }
}

export function inspectEncryptedControlPlaneBackup(
  archivePath: string,
): ControlPlaneBackupManifest {
  recoverPublishedCreateOnlyBackup(archivePath);
  const archive = readBoundedRegularFile(
    archivePath,
    maximumArchiveByteLength,
    "backup archive",
  );
  return decodeArchive(archive).manifest;
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
  const archive = readBoundedRegularFile(
    input.archivePath,
    maximumArchiveByteLength,
    "backup archive",
  );
  const archiveSha256 = sha256(archive);
  const decoded = decodeArchive(archive);
  const decrypted = decryptArchive(decoded, passphrase);
  let databaseBytes: Uint8Array | null = null;
  let receiptKey: Uint8Array | null = null;
  try {
    const payload = decodePayload(decrypted, decoded.manifest.payloadByteLength);
    databaseBytes = payload.databaseBytes;
    receiptKey = payload.operationReceiptKey;
    verifyDecryptedPayload(decoded.manifest, databaseBytes, receiptKey);
    const snapshotProof = inspectSnapshot(databaseBytes, releaseIdentity);
    const verifiedMigrationVersion = snapshotProof.migrationVersion;
    snapshotProof.database.close();
    return {
      archiveSha256,
      manifest: decoded.manifest,
      verifiedMigrationVersion,
    };
  } finally {
    decrypted.fill(0);
    databaseBytes?.fill(0);
    receiptKey?.fill(0);
  }
}

export function restoreEncryptedControlPlaneBackup(
  input: RestoreControlPlaneBackupInput,
): ControlPlaneRestoreResult {
  const releaseIdentity = parseAppReleaseIdentity(input.releaseIdentity);
  const passphrase = parsePassphrase(input.passphrase);
  const paths = restorePaths(input.databasePath);
  assertPrivateRestoreRoot(paths.parent);
  assertCompatibleReleaseFence(input.databasePath, releaseIdentity);
  recoverInterruptedControlPlaneRestore(input.databasePath);

  recoverPublishedCreateOnlyBackup(input.archivePath);
  const archive = readBoundedRegularFile(
    input.archivePath,
    maximumArchiveByteLength,
    "backup archive",
  );
  const archiveSha256 = sha256(archive);
  if (
    input.confirmedArchiveSha256 !== undefined
    && (
      !hexDigestSchema.safeParse(input.confirmedArchiveSha256).success
      || !safeHexEqual(archiveSha256, input.confirmedArchiveSha256)
    )
  ) {
    throw new ControlPlaneBackupError(
      "confirmation_failed",
      "The backup archive does not match the confirmed digest",
    );
  }
  const decoded = decodeArchive(archive);
  const decrypted = decryptArchive(decoded, passphrase);
  let databaseBytes: Uint8Array | null = null;
  let receiptKey: Uint8Array | null = null;
  try {
    const payload = decodePayload(decrypted, decoded.manifest.payloadByteLength);
    databaseBytes = payload.databaseBytes;
    receiptKey = payload.operationReceiptKey;
    verifyDecryptedPayload(decoded.manifest, databaseBytes, receiptKey);
    const snapshotProof = inspectSnapshot(databaseBytes, releaseIdentity);
    const restoredMigrationVersion = snapshotProof.migrationVersion;
    snapshotProof.database.close();

    prepareRestoreTargets(paths);
    try {
      writePrivateFileExclusive(paths.databaseStage, databaseBytes);
      writePrivateFileExclusive(paths.keyStage, receiptKey);
      validateStagedRestore(paths, releaseIdentity, decoded.manifest, receiptKey);
    } catch (error: unknown) {
      removeIfPresent(paths.databaseStage);
      removeIfPresent(paths.keyStage);
      syncDirectory(paths.parent);
      throw error;
    }

    let journal: RestoreJournal = {
      version: 1,
      kind: "hraness-kitchen-control-plane-restore",
      phase: "prepared",
      archiveSha256,
      databaseSha256: decoded.manifest.sourceHashes.databaseSha256,
      receiptKeySha256: sha256(receiptKey),
      hadDatabase: pathExists(paths.database),
      hadReceiptKey: pathExists(paths.receiptKey),
      originalDatabaseSha256: hashOptionalFile(
        paths.database,
        maximumArchiveByteLength,
        "original control-plane database",
      ),
      originalReceiptKeySha256: hashOptionalFile(
        paths.receiptKey,
        operationReceiptKeyByteLength,
        "original operation-receipt key",
      ),
    };
    assertJournalOriginalShape(journal);
    writeRestoreJournal(paths, journal);

    try {
      removeRestoreSqliteSidecars(paths);
      checkpoint(input, "after_prepared");
      if (journal.hadDatabase) {
        renameSync(paths.database, paths.databaseRollback);
        syncDirectory(paths.parent);
      }
      checkpoint(input, "after_database_rollback_staged");
      renameSync(paths.databaseStage, paths.database);
      syncDirectory(paths.parent);
      journal = { ...journal, phase: "database_replaced" };
      writeRestoreJournal(paths, journal);
      checkpoint(input, "after_database_replaced");

      if (journal.hadReceiptKey) {
        renameSync(paths.receiptKey, paths.keyRollback);
        syncDirectory(paths.parent);
      }
      checkpoint(input, "after_key_rollback_staged");
      renameSync(paths.keyStage, paths.receiptKey);
      syncDirectory(paths.parent);
      journal = { ...journal, phase: "key_replaced" };
      writeRestoreJournal(paths, journal);
      checkpoint(input, "after_key_replaced");

      validatePublishedRestore(
        paths,
        releaseIdentity,
        decoded.manifest,
        journal.receiptKeySha256,
      );
      journal = { ...journal, phase: "validated" };
      writeRestoreJournal(paths, journal);
      checkpoint(input, "after_validation");

      removeVerifiedOptionalFile(
        paths.databaseRollback,
        journal.originalDatabaseSha256,
        "database rollback",
      );
      syncDirectory(paths.parent);
      checkpoint(input, "after_database_rollback_removed");
      removeVerifiedOptionalFile(
        paths.keyRollback,
        journal.originalReceiptKeySha256,
        "receipt-key rollback",
      );
      syncDirectory(paths.parent);
      checkpoint(input, "after_key_rollback_removed");
      removeIfPresent(paths.journal);
      syncDirectory(paths.parent);
    } catch (error: unknown) {
      if (input.leaveInterruptedOnFault === true) throw error;
      try {
        recoverInterruptedControlPlaneRestore(input.databasePath);
      } catch (rollbackError: unknown) {
        throw new ControlPlaneBackupError(
          "restore_interrupted",
          `Restore failed and rollback could not complete: ${errorMessage(rollbackError)}`,
        );
      }
      throw error;
    }

    return {
      archiveSha256,
      manifest: decoded.manifest,
      restoredMigrationVersion,
    };
  } finally {
    decrypted.fill(0);
    databaseBytes?.fill(0);
    receiptKey?.fill(0);
  }
}

export function recoverInterruptedControlPlaneRestore(
  databasePath: string,
): InterruptedControlPlaneRestoreRecovery {
  const paths = restorePaths(databasePath);
  assertPrivateRestoreRoot(paths.parent);
  const journal = readRestoreJournal(paths);
  if (journal === null) {
    if (pathExists(paths.databaseRollback) || pathExists(paths.keyRollback)) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        "Unjournaled restore rollback state requires manual inspection",
      );
    }
    removeIfPresent(paths.journalCandidate);
    removeIfPresent(paths.databaseStage);
    removeIfPresent(paths.keyStage);
    syncDirectory(paths.parent);
    return { kind: "none" };
  }

  assertJournalOriginalShape(journal);
  if (journal.phase === "validated") {
    finishCommittedRestoreCleanup(paths, journal);
    return { kind: "completed", phase: journal.phase };
  }

  removeRestoreSqliteSidecars(paths);
  restoreOriginalFile({
    hadOriginal: journal.hadDatabase,
    livePath: paths.database,
    rollbackPath: paths.databaseRollback,
    label: "control-plane database",
    originalSha256: journal.originalDatabaseSha256,
    replacementSha256: journal.databaseSha256,
  });
  restoreOriginalFile({
    hadOriginal: journal.hadReceiptKey,
    livePath: paths.receiptKey,
    rollbackPath: paths.keyRollback,
    label: "operation-receipt key",
    originalSha256: journal.originalReceiptKeySha256,
    replacementSha256: journal.receiptKeySha256,
  });
  removeIfPresent(paths.databaseStage);
  removeIfPresent(paths.keyStage);
  removeIfPresent(paths.journalCandidate);
  removeIfPresent(paths.journal);
  syncDirectory(paths.parent);
  return { kind: "rolled_back", phase: journal.phase };
}

type RestorePaths = ControlPlaneRestorePaths;
type RestoreJournal = ControlPlaneRestoreJournal;

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
    database = Database.deserialize(databaseBytes.slice(), { strict: true });
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

function normalizeSerializedSnapshot(value: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(value);
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
  readonly databaseSha256: string;
  readonly schemaSha256: string;
  readonly migrationHistorySha256: string;
  readonly migrationVersion: number;
  readonly sourceRelease: AppReleaseIdentity;
}): Uint8Array {
  return Buffer.from(JSON.stringify({
    kind: "hraness-kitchen-control-plane-source-binding",
    version: 1,
    databaseSha256: input.databaseSha256,
    schemaSha256: input.schemaSha256,
    migrationHistorySha256: input.migrationHistorySha256,
    migrationVersion: input.migrationVersion,
    sourceRelease: input.sourceRelease,
  }), "utf8");
}

function encodePayload(
  operationReceiptKey: Uint8Array,
  databaseBytes: Uint8Array,
): Buffer {
  const length = payloadMagic.byteLength
    + payloadLengthPrefixByteLength
    + operationReceiptKeyByteLength
    + databaseBytes.byteLength;
  if (length > maximumArchiveByteLength) {
    throw new ControlPlaneBackupError("invalid_input", "Backup payload is too large");
  }
  const payload = Buffer.allocUnsafe(length);
  payloadMagic.copy(payload, 0);
  payload.writeBigUInt64BE(BigInt(databaseBytes.byteLength), payloadMagic.byteLength);
  Buffer.from(operationReceiptKey).copy(
    payload,
    payloadMagic.byteLength + payloadLengthPrefixByteLength,
  );
  Buffer.from(databaseBytes).copy(
    payload,
    payloadMagic.byteLength
      + payloadLengthPrefixByteLength
      + operationReceiptKeyByteLength,
  );
  return payload;
}

function decodePayload(
  decrypted: Uint8Array,
  expectedByteLength: number,
): Readonly<{
  operationReceiptKey: Uint8Array;
  databaseBytes: Uint8Array;
}> {
  if (
    decrypted.byteLength !== expectedByteLength
    || decrypted.byteLength
      < payloadMagic.byteLength
        + payloadLengthPrefixByteLength
        + operationReceiptKeyByteLength
  ) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup payload length is invalid");
  }
  const buffer = Buffer.from(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
  if (!timingSafeEqual(buffer.subarray(0, payloadMagic.byteLength), payloadMagic)) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup payload magic is invalid");
  }
  const databaseLength = Number(
    buffer.readBigUInt64BE(payloadMagic.byteLength),
  );
  const databaseOffset = payloadMagic.byteLength
    + payloadLengthPrefixByteLength
    + operationReceiptKeyByteLength;
  if (
    !Number.isSafeInteger(databaseLength)
    || databaseLength <= 0
    || databaseOffset + databaseLength !== buffer.byteLength
  ) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup database length is invalid");
  }
  return {
    operationReceiptKey: Uint8Array.from(buffer.subarray(
      payloadMagic.byteLength + payloadLengthPrefixByteLength,
      databaseOffset,
    )),
    databaseBytes: Uint8Array.from(buffer.subarray(databaseOffset)),
  };
}

function encodeArchive(
  manifestBytes: Uint8Array,
  ciphertext: Uint8Array,
  authenticationTag: Uint8Array,
): Buffer {
  const length = archiveMagic.byteLength
    + archiveLengthPrefixByteLength
    + manifestBytes.byteLength
    + ciphertext.byteLength
    + authenticationTag.byteLength;
  if (length > maximumArchiveByteLength) {
    throw new ControlPlaneBackupError("invalid_input", "Encrypted backup is too large");
  }
  const archive = Buffer.allocUnsafe(length);
  archiveMagic.copy(archive, 0);
  archive.writeUInt32BE(manifestBytes.byteLength, archiveMagic.byteLength);
  Buffer.from(manifestBytes).copy(
    archive,
    archiveMagic.byteLength + archiveLengthPrefixByteLength,
  );
  const ciphertextOffset = archiveMagic.byteLength
    + archiveLengthPrefixByteLength
    + manifestBytes.byteLength;
  Buffer.from(ciphertext).copy(archive, ciphertextOffset);
  Buffer.from(authenticationTag).copy(
    archive,
    ciphertextOffset + ciphertext.byteLength,
  );
  return archive;
}

function decodeArchive(archive: Uint8Array): Readonly<{
  manifest: ControlPlaneBackupManifest;
  manifestBytes: Uint8Array;
  ciphertext: Uint8Array;
  authenticationTag: Uint8Array;
}> {
  const minimumLength = archiveMagic.byteLength
    + archiveLengthPrefixByteLength
    + archiveTagByteLength
    + 1;
  if (archive.byteLength < minimumLength || archive.byteLength > maximumArchiveByteLength) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup archive length is invalid");
  }
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  if (!timingSafeEqual(buffer.subarray(0, archiveMagic.byteLength), archiveMagic)) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup archive magic is invalid");
  }
  const manifestLength = buffer.readUInt32BE(archiveMagic.byteLength);
  if (manifestLength <= 0 || manifestLength > maximumManifestByteLength) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup manifest length is invalid");
  }
  const manifestOffset = archiveMagic.byteLength + archiveLengthPrefixByteLength;
  const ciphertextOffset = manifestOffset + manifestLength;
  const tagOffset = buffer.byteLength - archiveTagByteLength;
  if (ciphertextOffset >= tagOffset) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup ciphertext is missing");
  }
  const manifestBytes = Uint8Array.from(buffer.subarray(manifestOffset, ciphertextOffset));
  let manifest: ControlPlaneBackupManifest;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      manifestBytes,
    ));
    manifest = parseBackupManifest(decoded);
  } catch (error: unknown) {
    if (error instanceof ControlPlaneBackupError) throw error;
    throw new ControlPlaneBackupError("invalid_archive", "Backup manifest is invalid");
  }
  if (
    decodeBase64Exact(manifest.kdf.salt, saltByteLength).byteLength !== saltByteLength
    || decodeBase64Exact(manifest.cipher.iv, ivByteLength).byteLength !== ivByteLength
  ) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup cryptographic metadata is invalid");
  }
  const ciphertext = Uint8Array.from(buffer.subarray(ciphertextOffset, tagOffset));
  if (ciphertext.byteLength !== manifest.payloadByteLength) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup ciphertext length is invalid");
  }
  return {
    manifest,
    manifestBytes,
    ciphertext,
    authenticationTag: Uint8Array.from(buffer.subarray(tagOffset)),
  };
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

function decryptArchive(
  decoded: Readonly<{
    manifest: ControlPlaneBackupManifest;
    manifestBytes: Uint8Array;
    ciphertext: Uint8Array;
    authenticationTag: Uint8Array;
  }>,
  passphrase: string,
): Buffer {
  const salt = decodeBase64Exact(decoded.manifest.kdf.salt, saltByteLength);
  const iv = decodeBase64Exact(decoded.manifest.cipher.iv, ivByteLength);
  const encryptionKey = deriveEncryptionKey(passphrase, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv, {
      authTagLength: archiveTagByteLength,
    });
    decipher.setAAD(archiveAdditionalAuthenticatedData(decoded.manifestBytes));
    decipher.setAuthTag(decoded.authenticationTag);
    return Buffer.concat([
      decipher.update(decoded.ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw new ControlPlaneBackupError(
      "authentication_failed",
      "The backup passphrase is wrong or the archive was modified",
    );
  } finally {
    encryptionKey.fill(0);
  }
}

function verifyDecryptedPayload(
  manifest: ControlPlaneBackupManifest,
  databaseBytes: Uint8Array,
  operationReceiptKey: Uint8Array,
): void {
  if (sha256(databaseBytes) !== manifest.sourceHashes.databaseSha256) {
    throw new ControlPlaneBackupError("invalid_archive", "Backup database hash is invalid");
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
  } finally {
    proof.database.close();
  }
  const expectedBinding = hmacSha256(
    operationReceiptKey,
    sourceBindingPreimage({
      databaseSha256: manifest.sourceHashes.databaseSha256,
      schemaSha256: manifest.sourceHashes.schemaSha256,
      migrationHistorySha256: manifest.sourceHashes.migrationHistorySha256,
      migrationVersion: manifest.sourceMigrationVersion,
      sourceRelease: manifest.sourceRelease,
    }),
  );
  if (!safeHexEqual(expectedBinding, manifest.sourceHashes.receiptBindingHmacSha256)) {
    throw new ControlPlaneBackupError(
      "invalid_archive",
      "Backup source receipt-key binding is invalid",
    );
  }
}

function validateStagedRestore(
  paths: RestorePaths,
  releaseIdentity: AppReleaseIdentity,
  manifest: ControlPlaneBackupManifest,
  receiptKey: Uint8Array,
): void {
  assertPrivateRegularFile(paths.databaseStage, null);
  assertPrivateRegularFile(paths.keyStage, operationReceiptKeyByteLength);
  const stagedBytes = readBoundedRegularFile(
    paths.databaseStage,
    maximumArchiveByteLength,
    "staged control-plane database",
  );
  if (sha256(stagedBytes) !== manifest.sourceHashes.databaseSha256) {
    throw new ControlPlaneBackupError("invalid_archive", "Staged database hash changed");
  }
  const proof = inspectSnapshot(stagedBytes, releaseIdentity);
  proof.database.close();
  const stagedKey = readBoundedRegularFile(
    paths.keyStage,
    operationReceiptKeyByteLength,
    "staged operation-receipt key",
  );
  if (
    stagedKey.byteLength !== receiptKey.byteLength
    || !timingSafeEqual(stagedKey, receiptKey)
  ) {
    throw new ControlPlaneBackupError("invalid_archive", "Staged receipt key changed");
  }
  stagedKey.fill(0);
  stagedBytes.fill(0);
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
    maximumArchiveByteLength,
    "restored control-plane database",
  );
  if (sha256(liveDatabaseBytes) !== manifest.sourceHashes.databaseSha256) {
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
        databaseSha256: manifest.sourceHashes.databaseSha256,
        schemaSha256: manifest.sourceHashes.schemaSha256,
        migrationHistorySha256: manifest.sourceHashes.migrationHistorySha256,
        migrationVersion: manifest.sourceMigrationVersion,
        sourceRelease: manifest.sourceRelease,
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
  liveDatabaseBytes.fill(0);
}

function prepareRestoreTargets(paths: RestorePaths): void {
  assertNoUnjournaledRestoreArtifacts(paths);
  assertOptionalPrivateRegularFile(paths.database, null);
  assertOptionalPrivateRegularFile(paths.receiptKey, operationReceiptKeyByteLength);
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

function assertNoUnjournaledRestoreArtifacts(paths: RestorePaths): void {
  for (const path of [
    paths.journalCandidate,
    paths.databaseStage,
    paths.databaseRollback,
    paths.keyStage,
    paths.keyRollback,
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
}): void {
  const rollbackExists = pathExists(input.rollbackPath);
  const liveExists = pathExists(input.livePath);
  if (rollbackExists) {
    assertPrivateRegularFile(input.rollbackPath, null);
    assertFileHash(
      input.rollbackPath,
      input.originalSha256,
      `${input.label} rollback`,
    );
    if (liveExists) {
      assertPrivateRegularFile(input.livePath, null);
      assertFileHashOneOf(
        input.livePath,
        [input.originalSha256, input.replacementSha256],
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
      assertFileHash(input.livePath, input.replacementSha256, input.label);
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
  assertFileHash(input.livePath, input.originalSha256, input.label);
}

function finishCommittedRestoreCleanup(
  paths: RestorePaths,
  journal: RestoreJournal,
): void {
  assertFileHash(paths.database, journal.databaseSha256, "committed database");
  assertFileHash(paths.receiptKey, journal.receiptKeySha256, "committed receipt key");
  removeVerifiedOptionalFile(
    paths.databaseRollback,
    journal.originalDatabaseSha256,
    "database rollback",
  );
  removeVerifiedOptionalFile(
    paths.keyRollback,
    journal.originalReceiptKeySha256,
    "receipt-key rollback",
  );
  removeIfPresent(paths.databaseStage);
  removeIfPresent(paths.keyStage);
  removeIfPresent(paths.journalCandidate);
  removeIfPresent(paths.journal);
  syncDirectory(paths.parent);
}

function assertJournalOriginalShape(journal: RestoreJournal): void {
  if (
    journal.hadDatabase !== (journal.originalDatabaseSha256 !== null)
    || journal.hadReceiptKey !== (journal.originalReceiptKeySha256 !== null)
  ) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      "The restore journal original-state proof is inconsistent",
    );
  }
}

function hashOptionalFile(
  path: string,
  maximumBytes: number,
  label: string,
): string | null {
  if (!pathExists(path)) return null;
  const bytes = readBoundedRegularFile(path, maximumBytes, label);
  try {
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

function assertFileHash(
  path: string,
  expectedSha256: string | null,
  label: string,
): void {
  if (expectedSha256 === null) {
    throw new ControlPlaneBackupError(
      "restore_interrupted",
      `The ${label} has no journaled hash`,
    );
  }
  const bytes = readBoundedRegularFile(path, maximumArchiveByteLength, label);
  try {
    if (!safeHexEqual(sha256(bytes), expectedSha256)) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        `The ${label} does not match its journaled hash`,
      );
    }
  } finally {
    bytes.fill(0);
  }
}

function assertFileHashOneOf(
  path: string,
  expectedValues: readonly (string | null)[],
  label: string,
): void {
  const expected = expectedValues.filter(
    (value): value is string => value !== null,
  );
  const bytes = readBoundedRegularFile(path, maximumArchiveByteLength, label);
  try {
    const actual = sha256(bytes);
    if (!expected.some((value) => safeHexEqual(actual, value))) {
      throw new ControlPlaneBackupError(
        "restore_interrupted",
        `The ${label} does not match a journaled state`,
      );
    }
  } finally {
    bytes.fill(0);
  }
}

function removeVerifiedOptionalFile(
  path: string,
  expectedSha256: string | null,
  label: string,
): void {
  if (!pathExists(path)) return;
  assertPrivateRegularFile(path, null);
  assertFileHash(path, expectedSha256, label);
  unlinkSync(path);
}

function writeRestoreJournal(paths: RestorePaths, journal: RestoreJournal): void {
  const bytes = Buffer.from(JSON.stringify(restoreJournalSchema.parse(journal)), "utf8");
  if (bytes.byteLength > maximumJournalByteLength) {
    throw new ControlPlaneBackupError("restore_interrupted", "Restore journal is too large");
  }
  removeIfPresent(paths.journalCandidate);
  writePrivateFileExclusive(paths.journalCandidate, bytes);
  renameSync(paths.journalCandidate, paths.journal);
  syncDirectory(paths.parent);
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

function writeBackupAtomically(
  path: string,
  bytes: Uint8Array,
  replaceExisting: boolean,
): void {
  const parent = dirname(path);
  const candidate = join(parent, `.${basename(path)}.hraness-backup-v1.tmp`);
  const candidateMetadata = readMetadata(candidate);
  if (candidateMetadata !== null) {
    const parentMetadata = lstatSync(parent);
    const currentUser = process.getuid?.();
    if (
      candidateMetadata.isSymbolicLink()
      || !candidateMetadata.isFile()
      || candidateMetadata.nlink !== 1
      || candidateMetadata.dev !== parentMetadata.dev
      || (candidateMetadata.mode & 0o777) !== 0o600
      || (currentUser !== undefined && candidateMetadata.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Backup staging path is unsafe",
      );
    }
    unlinkSync(candidate);
  }
  writePrivateFileExclusive(candidate, bytes);
  const destinationMetadata = readMetadata(path);
  if (
    destinationMetadata !== null
    && (
      destinationMetadata.isSymbolicLink()
      || !destinationMetadata.isFile()
      || destinationMetadata.nlink !== 1
    )
  ) {
    removeIfPresent(candidate);
    throw new ControlPlaneBackupError("unsafe_path", "Backup destination changed");
  }
  if (replaceExisting) {
    renameSync(candidate, path);
    chmodSync(path, 0o600);
  } else {
    if (destinationMetadata !== null) {
      removeIfPresent(candidate);
      throw new ControlPlaneBackupError(
        "unsafe_path",
        "Backup destination already exists",
      );
    }
    try {
      linkSync(candidate, path);
    } catch (error: unknown) {
      removeIfPresent(candidate);
      if (hasCode(error, "EEXIST")) {
        throw new ControlPlaneBackupError(
          "unsafe_path",
          "Backup destination already exists",
        );
      }
      throw error;
    }
    unlinkSync(candidate);
  }
  syncDirectory(parent);
}

export function recoverPublishedCreateOnlyBackup(path: string): void {
  if (!isAbsolute(path)) return;
  const parent = dirname(path);
  assertNoSymlinkDirectory(parent);
  const candidate = join(parent, `.${basename(path)}.hraness-backup-v1.tmp`);
  const candidateMetadata = readMetadata(candidate);
  if (candidateMetadata === null || candidateMetadata.nlink === 1) return;

  const destinationMetadata = readMetadata(path);
  const parentMetadata = lstatSync(parent);
  const currentUser = process.getuid?.();
  const safeFile = (metadata: Stats | null): metadata is Stats =>
    metadata !== null
    && !metadata.isSymbolicLink()
    && metadata.isFile()
    && metadata.nlink === 2
    && metadata.dev === parentMetadata.dev
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

  unlinkSync(candidate);
  syncDirectory(parent);
  const published = readMetadata(path);
  if (
    published === null
    || published.isSymbolicLink()
    || !published.isFile()
    || published.nlink !== 1
    || published.dev !== destinationMetadata.dev
    || published.ino !== destinationMetadata.ino
    || (published.mode & 0o777) !== 0o600
    || (currentUser !== undefined && published.uid !== currentUser)
  ) {
    throw new ControlPlaneBackupError(
      "unsafe_path",
      "Recovered backup publication identity changed",
    );
  }
}

function writePrivateFileExclusive(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
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
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size <= 0
      || metadata.size > maximumBytes
      || (currentUser !== undefined && metadata.uid !== currentUser)
    ) {
      throw new ControlPlaneBackupError(
        "unsafe_path",
        `${label} must be one bounded owned regular file`,
      );
    }
    return Uint8Array.from(readFileSync(descriptor));
  } finally {
    closeSync(descriptor);
  }
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
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parsePassphrase(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumPassphraseByteLength
  ) {
    throw new ControlPlaneBackupError(
      "invalid_input",
      "Backup passphrase must be non-empty and bounded",
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

function hasCode(error: unknown, expected: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === expected;
}
