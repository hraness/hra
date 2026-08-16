import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { z } from "@hra-internal/schema";
import {
  operationReceiptKeyByteLength,
  operationReceiptKeyPath,
} from "./operation-receipt-key";

export const controlPlaneRestoreJournalFileName =
  ".control-plane-restore-v1.json";
export const controlPlaneRestoreJournalCandidateFileName =
  ".control-plane-restore-v1.json.tmp";
export const controlPlaneRestoreDatabaseStageFileName =
  ".control-plane-restore-v1.stage.sqlite";
export const controlPlaneRestoreDatabaseRollbackFileName =
  ".control-plane-restore-v1.rollback.sqlite";
export const controlPlaneRestoreKeyStageFileName =
  ".control-plane-restore-v1.stage.hmac.key";
export const controlPlaneRestoreKeyRollbackFileName =
  ".control-plane-restore-v1.rollback.hmac.key";
export const maximumControlPlaneRestoreJournalByteLength = 4_096;
export const maximumControlPlaneRestoreDatabaseByteLength =
  1_073_741_824 - 1_048_576;
export const maximumControlPlaneSqliteSharedMemoryByteLength =
  32 * 1_024 * 1_024;

const hexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const controlPlaneRestorePhaseSchema = z.enum([
  "prepared",
  "database_replaced",
  "key_replaced",
  "validated",
]);

export const controlPlaneRestoreJournalSchema = z.object({
  version: z.literal(1),
  kind: z.literal("hraness-kitchen-control-plane-restore"),
  phase: controlPlaneRestorePhaseSchema,
  archiveSha256: hexDigestSchema,
  databaseSha256: hexDigestSchema,
  receiptKeySha256: hexDigestSchema,
  hadDatabase: z.boolean(),
  hadReceiptKey: z.boolean(),
  originalDatabaseSha256: hexDigestSchema.nullable(),
  originalReceiptKeySha256: hexDigestSchema.nullable(),
}).strict();

export type ControlPlaneRestoreJournal = z.infer<
  typeof controlPlaneRestoreJournalSchema
>;

export interface ControlPlaneRestorePaths {
  readonly parent: string;
  readonly database: string;
  readonly receiptKey: string;
  readonly journal: string;
  readonly journalCandidate: string;
  readonly databaseStage: string;
  readonly databaseRollback: string;
  readonly keyStage: string;
  readonly keyRollback: string;
}

export class ControlPlaneRestoreStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneRestoreStateError";
  }
}

export function controlPlaneRestorePaths(
  databasePath: string,
): ControlPlaneRestorePaths {
  if (!isAbsolute(databasePath) || basename(databasePath) !== "control-plane.sqlite") {
    throw new ControlPlaneRestoreStateError(
      "Restore requires the canonical absolute control-plane database path",
    );
  }
  const parent = dirname(databasePath);
  return {
    parent,
    database: databasePath,
    receiptKey: operationReceiptKeyPath(databasePath),
    journal: join(parent, controlPlaneRestoreJournalFileName),
    journalCandidate: join(
      parent,
      controlPlaneRestoreJournalCandidateFileName,
    ),
    databaseStage: join(parent, controlPlaneRestoreDatabaseStageFileName),
    databaseRollback: join(
      parent,
      controlPlaneRestoreDatabaseRollbackFileName,
    ),
    keyStage: join(parent, controlPlaneRestoreKeyStageFileName),
    keyRollback: join(parent, controlPlaneRestoreKeyRollbackFileName),
  };
}

/**
 * Proves the sole no-live-database restore shape that Application Support may
 * admit before the lifetime-locked recovery pass. This is strictly read-only.
 */
export function assertRecoverableMissingControlPlaneRestore(
  databasePath: string,
): void {
  const paths = controlPlaneRestorePaths(databasePath);
  const parentMetadata = inspectPrivateRoot(paths.parent);
  const journal = readProtectedRestoreJournal(paths, parentMetadata);
  if (
    journal === null
    || journal.phase !== "prepared"
    || readMetadata(paths.database) !== null
    || readMetadata(paths.journalCandidate) !== null
    || readMetadata(paths.keyRollback) !== null
  ) {
    throw new ControlPlaneRestoreStateError(
      "The missing database is not an exact recoverable restore state",
    );
  }

  if (journal.hadDatabase) {
    if (journal.originalDatabaseSha256 === null) {
      throw new ControlPlaneRestoreStateError(
        "The restore journal omits the original database proof",
      );
    }
    assertProtectedFileHash(
      paths.databaseRollback,
      parentMetadata,
      1,
      maximumControlPlaneRestoreDatabaseByteLength,
      journal.originalDatabaseSha256,
      "database rollback",
    );
  } else if (
    journal.originalDatabaseSha256 !== null
    || readMetadata(paths.databaseRollback) !== null
  ) {
    throw new ControlPlaneRestoreStateError(
      "The restore state contains an unjournaled database rollback",
    );
  }
  assertProtectedFileHash(
    paths.databaseStage,
    parentMetadata,
    1,
    maximumControlPlaneRestoreDatabaseByteLength,
    journal.databaseSha256,
    "database stage",
  );
  assertProtectedFileHash(
    paths.keyStage,
    parentMetadata,
    operationReceiptKeyByteLength,
    operationReceiptKeyByteLength,
    journal.receiptKeySha256,
    "receipt-key stage",
  );

  if (journal.hadReceiptKey) {
    if (journal.originalReceiptKeySha256 === null) {
      throw new ControlPlaneRestoreStateError(
        "The restore journal omits the original receipt-key proof",
      );
    }
    assertProtectedFileHash(
      paths.receiptKey,
      parentMetadata,
      operationReceiptKeyByteLength,
      operationReceiptKeyByteLength,
      journal.originalReceiptKeySha256,
      "original receipt key",
    );
  } else if (
    journal.originalReceiptKeySha256 !== null
    || readMetadata(paths.receiptKey) !== null
  ) {
    throw new ControlPlaneRestoreStateError(
      "The restore state contains an unjournaled receipt key",
    );
  }

  inspectControlPlaneRestoreSqliteSidecars(paths, parentMetadata);
}

export function inspectControlPlaneRestoreSqliteSidecars(
  paths: ControlPlaneRestorePaths,
  parentMetadata = inspectPrivateRoot(paths.parent),
): readonly string[] {
  const present: string[] = [];
  for (const [path, maximumBytes] of [
    [`${paths.database}-wal`, 0],
    [
      `${paths.database}-shm`,
      maximumControlPlaneSqliteSharedMemoryByteLength,
    ],
  ] as const) {
    const metadata = readMetadata(path);
    if (metadata === null) continue;
    const currentUser = process.getuid?.();
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.dev !== parentMetadata.dev
      || metadata.size < 0
      || metadata.size > maximumBytes
      || (currentUser !== undefined && metadata.uid !== currentUser)
    ) {
      throw new ControlPlaneRestoreStateError("SQLite sidecar is unsafe");
    }
    present.push(path);
  }
  return present;
}

function readProtectedRestoreJournal(
  paths: ControlPlaneRestorePaths,
  parentMetadata: Stats,
): ControlPlaneRestoreJournal | null {
  if (readMetadata(paths.journal) === null) return null;
  const bytes = readProtectedFile(
    paths.journal,
    parentMetadata,
    1,
    maximumControlPlaneRestoreJournalByteLength,
    "restore journal",
  );
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const journal = controlPlaneRestoreJournalSchema.parse(value);
    if (
      journal.hadDatabase !== (journal.originalDatabaseSha256 !== null)
      || journal.hadReceiptKey !== (journal.originalReceiptKeySha256 !== null)
    ) {
      throw new ControlPlaneRestoreStateError(
        "The restore journal original-state proof is inconsistent",
      );
    }
    return journal;
  } catch (error: unknown) {
    if (error instanceof ControlPlaneRestoreStateError) throw error;
    throw new ControlPlaneRestoreStateError("The restore journal is invalid");
  } finally {
    bytes.fill(0);
  }
}

function assertProtectedFileHash(
  path: string,
  parentMetadata: Stats,
  minimumBytes: number,
  maximumBytes: number,
  expectedSha256: string,
  label: string,
): void {
  const bytes = readProtectedFile(
    path,
    parentMetadata,
    minimumBytes,
    maximumBytes,
    label,
  );
  try {
    if (sha256(bytes) !== expectedSha256) {
      throw new ControlPlaneRestoreStateError(
        `The ${label} does not match its journaled hash`,
      );
    }
  } finally {
    bytes.fill(0);
  }
}

function readProtectedFile(
  path: string,
  parentMetadata: Stats,
  minimumBytes: number,
  maximumBytes: number,
  label: string,
): Uint8Array {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== parentMetadata.dev
      || before.size < minimumBytes
      || before.size > maximumBytes
      || (before.mode & 0o777) !== 0o600
      || (currentUser !== undefined && before.uid !== currentUser)
    ) {
      throw new ControlPlaneRestoreStateError(
        `The ${label} is not protected restore state`,
      );
    }
    const bytes = Uint8Array.from(readFileSync(descriptor));
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== before.nlink
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || bytes.byteLength !== before.size
    ) {
      bytes.fill(0);
      throw new ControlPlaneRestoreStateError(
        `The ${label} changed during inspection`,
      );
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function inspectPrivateRoot(path: string): Stats {
  assertNoSymlinkDirectory(path);
  const metadata = lstatSync(path);
  const currentUser = process.getuid?.();
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new ControlPlaneRestoreStateError(
      "Restore root must be one owned real directory",
    );
  }
  return metadata;
}

function assertNoSymlinkDirectory(path: string): void {
  const absolute = resolve(path);
  if (absolute !== path) {
    throw new ControlPlaneRestoreStateError(
      "Restore paths must be normalized absolute paths",
    );
  }
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const segment of absolute
    .slice(parsed.root.length)
    .split(sep)
    .filter((value) => value.length > 0)) {
    current = join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ControlPlaneRestoreStateError(
        "Restore paths may not traverse links or non-directories",
      );
    }
  }
}

function readMetadata(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
