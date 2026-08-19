import { createHash } from "node:crypto";
import {
  CString,
  dlopen,
  FFIType,
  toBuffer,
  type Pointer,
} from "bun:ffi";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { z } from "@hra-internal/schema";
import {
  CHAT_ATTACHMENT_VAULT_DIRECTORY_NAME,
  chatAttachmentVaultRoot,
} from "../attachments/root";
import {
  operationReceiptKeyByteLength,
  operationReceiptKeyPath,
} from "./operation-receipt-key";

export const controlPlaneRestoreJournalFileName =
  ".control-plane-restore-v2.json";
export const controlPlaneRestoreJournalCandidateFileName =
  ".control-plane-restore-v2.json.tmp";
export const controlPlaneRestoreDatabaseStageFileName =
  ".control-plane-restore-v2.stage.sqlite";
export const controlPlaneRestoreDatabaseRollbackFileName =
  ".control-plane-restore-v2.rollback.sqlite";
export const controlPlaneRestoreKeyStageFileName =
  ".control-plane-restore-v2.stage.hmac.key";
export const controlPlaneRestoreKeyRollbackFileName =
  ".control-plane-restore-v2.rollback.hmac.key";
export const controlPlaneRestoreVaultDirectoryName =
  CHAT_ATTACHMENT_VAULT_DIRECTORY_NAME;
export const controlPlaneRestoreVaultStageDirectoryName =
  ".control-plane-restore-v2.stage.attachments";
export const controlPlaneRestoreVaultRollbackDirectoryName =
  ".control-plane-restore-v2.rollback.attachments";
/**
 * Exact previously shipped restore artifacts. They are never resumed by the
 * v2 reader, but privacy deletion must continue to inventory them explicitly.
 */
export const legacyControlPlaneRestoreV1JournalFileName =
  ".control-plane-restore-v1.json";
export const legacyControlPlaneRestoreV1JournalCandidateFileName =
  ".control-plane-restore-v1.json.tmp";
export const legacyControlPlaneRestoreV1DatabaseStageFileName =
  ".control-plane-restore-v1.stage.sqlite";
export const legacyControlPlaneRestoreV1DatabaseRollbackFileName =
  ".control-plane-restore-v1.rollback.sqlite";
export const legacyControlPlaneRestoreV1KeyStageFileName =
  ".control-plane-restore-v1.stage.hmac.key";
export const legacyControlPlaneRestoreV1KeyRollbackFileName =
  ".control-plane-restore-v1.rollback.hmac.key";
export const legacyControlPlaneRestoreV1FileNames = [
  legacyControlPlaneRestoreV1JournalFileName,
  legacyControlPlaneRestoreV1JournalCandidateFileName,
  legacyControlPlaneRestoreV1DatabaseStageFileName,
  legacyControlPlaneRestoreV1DatabaseRollbackFileName,
  legacyControlPlaneRestoreV1KeyStageFileName,
  legacyControlPlaneRestoreV1KeyRollbackFileName,
] as const;
export const maximumControlPlaneRestoreDatabaseByteLength =
  1_073_741_824 - 1_048_576;
export const maximumControlPlaneSqliteSharedMemoryByteLength =
  32 * 1_024 * 1_024;
export const maximumControlPlaneAttachmentVaultByteLength = 768 * 1_024 * 1_024;
export const maximumControlPlaneAttachmentVaultFileCount = 20_000;
const closeOnExecFlag = Number(Reflect.get(constants, "O_CLOEXEC") ?? 0);
const protectedReadFlags = constants.O_RDONLY
  | constants.O_NOFOLLOW
  | constants.O_NONBLOCK
  | closeOnExecFlag;
const protectedDirectoryReadFlags = protectedReadFlags | constants.O_DIRECTORY;

const hexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const restoreAttachmentIdSchema = z.string().min(18).max(96).regex(
  /^attachment_[A-Za-z0-9_-]+$/u,
);
const restoreAttachmentVaultBlobSchema = z.object({
  attachmentId: restoreAttachmentIdSchema,
  relativePath: z.string().min(20).max(256).regex(
    /^attachment_[A-Za-z0-9_-]+\/(?:source\.upload|blob\.[a-z0-9]{1,16}|normalized\/(?:canonical|preview)\.png)$/u,
  ),
  bytes: z.number().int().nonnegative().max(64 * 1_024 * 1_024),
  sha256: hexDigestSchema,
}).strict().superRefine((blob, context) => {
  if (!blob.relativePath.startsWith(`${blob.attachmentId}/`)) {
    context.addIssue({
      code: "custom",
      message: "Restore attachment path does not match its attachment",
      path: ["relativePath"],
    });
  }
});
const maximumRestoreAttachmentInventoryEntryJsonByteLength = Buffer.byteLength(
  JSON.stringify({
    attachmentId: "a".repeat(96),
    relativePath: "a".repeat(256),
    bytes: 64 * 1_024 * 1_024,
    sha256: "a".repeat(64),
  }),
  "utf8",
);
const maximumRestoreAttachmentInventoryFixedJsonByteLength = Buffer.byteLength(
  JSON.stringify({
    version: 1,
    generationSha256: "a".repeat(64),
    totalBytes: maximumControlPlaneAttachmentVaultByteLength,
    blobs: [],
  }),
  "utf8",
) - 2;
export const maximumControlPlaneRestoreAttachmentInventoryJsonByteLength =
  maximumRestoreAttachmentInventoryFixedJsonByteLength
  + maximumControlPlaneAttachmentVaultFileCount
    * maximumRestoreAttachmentInventoryEntryJsonByteLength
  + maximumControlPlaneAttachmentVaultFileCount - 1;
/** Two full inventories plus every bounded scalar journal field and JSON framing. */
export const maximumControlPlaneRestoreJournalByteLength =
  2 * maximumControlPlaneRestoreAttachmentInventoryJsonByteLength
  + 64 * 1_024;
export const controlPlaneRestoreAttachmentVaultInventorySchema = z.object({
  version: z.literal(1),
  generationSha256: hexDigestSchema,
  totalBytes: z.number().int().nonnegative()
    .max(maximumControlPlaneAttachmentVaultByteLength),
  blobs: z.array(restoreAttachmentVaultBlobSchema)
    .max(maximumControlPlaneAttachmentVaultFileCount),
}).strict().superRefine((inventory, context) => {
  const paths = inventory.blobs.map(({ relativePath }) => relativePath);
  const sorted = [...paths].sort();
  const totalBytes = inventory.blobs.reduce(
    (total, blob) => total + blob.bytes,
    0,
  );
  const generationSha256 = sha256(Buffer.from(JSON.stringify({
    version: 1,
    blobs: inventory.blobs,
    totalBytes: inventory.totalBytes,
  }), "utf8"));
  if (
    new Set(paths).size !== paths.length
    || paths.some((path, index) => path !== sorted[index])
    || totalBytes !== inventory.totalBytes
    || generationSha256 !== inventory.generationSha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Restore attachment inventory is not canonical",
    });
  }
});
export type ControlPlaneRestoreAttachmentVaultInventory = z.infer<
  typeof controlPlaneRestoreAttachmentVaultInventorySchema
>;

export const controlPlaneRestorePhaseSchema = z.enum([
  "materializing",
  "prepared",
  "database_replaced",
  "key_replaced",
  "vault_replaced",
  "validated",
]);

export const controlPlaneRestoreJournalSchema = z.object({
  version: z.literal(2),
  kind: z.literal("hraness-kitchen-control-plane-restore"),
  phase: controlPlaneRestorePhaseSchema,
  archiveSha256: hexDigestSchema,
  databaseSha256: hexDigestSchema,
  receiptKeySha256: hexDigestSchema,
  attachmentVaultGenerationSha256: hexDigestSchema,
  attachmentVaultInventory: controlPlaneRestoreAttachmentVaultInventorySchema,
  stageCustodyNonce: hexDigestSchema,
  restoreRootDevice: z.number().int().nonnegative(),
  restoreRootInode: z.number().int().positive(),
  hadDatabase: z.boolean(),
  hadReceiptKey: z.boolean(),
  hadAttachmentVault: z.boolean(),
  originalDatabaseSha256: hexDigestSchema.nullable(),
  originalReceiptKeySha256: hexDigestSchema.nullable(),
  originalAttachmentVaultGenerationSha256: hexDigestSchema.nullable(),
  originalAttachmentVaultInventory:
    controlPlaneRestoreAttachmentVaultInventorySchema.nullable(),
}).strict().superRefine((journal, context) => {
  if (
    journal.attachmentVaultInventory.generationSha256
      !== journal.attachmentVaultGenerationSha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Restore attachment inventory does not match its generation",
      path: ["attachmentVaultInventory"],
    });
  }
  if (
    journal.originalAttachmentVaultInventory !== null
    && journal.originalAttachmentVaultInventory.generationSha256
      !== journal.originalAttachmentVaultGenerationSha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Original restore attachment inventory does not match its generation",
      path: ["originalAttachmentVaultInventory"],
    });
  }
  if (
    journal.hadAttachmentVault
      !== (journal.originalAttachmentVaultInventory !== null)
    || journal.hadAttachmentVault
      !== (journal.originalAttachmentVaultGenerationSha256 !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "Original restore attachment inventory presence is inconsistent",
      path: ["originalAttachmentVaultInventory"],
    });
  }
});

export type ControlPlaneRestoreJournal = z.infer<
  typeof controlPlaneRestoreJournalSchema
>;

export interface ControlPlaneRestoreStageCustody {
  seal(descriptor: number, nonce: string): void;
  assert(descriptor: number, nonce: string): void;
  close(): void;
}

/** Binds the platform xattr primitive used as durable stage-inode provenance. */
export function bindControlPlaneRestoreStageCustody(): ControlPlaneRestoreStageCustody {
  const libraryPath = process.platform === "darwin"
    ? "/usr/lib/libSystem.B.dylib"
    : process.platform === "linux"
    ? "libc.so.6"
    : null;
  if (libraryPath === null) {
    throw new ControlPlaneRestoreStateError(
      "Restore-stage custody markers are unsupported",
    );
  }
  const attributeName = Buffer.from(`${
    process.platform === "darwin"
      ? "com.hraness.hra.restore-v2-custody"
      : "user.hraness.hra.restore-v2-custody"
  }\0`);
  let closed = false;
  if (process.platform === "darwin") {
    const library = dlopen(libraryPath, {
      fsetxattr: {
        args: [
          FFIType.i32,
          FFIType.cstring,
          FFIType.ptr,
          FFIType.u64,
          FFIType.u32,
          FFIType.i32,
        ],
        returns: FFIType.i32,
      },
      fgetxattr: {
        args: [
          FFIType.i32,
          FFIType.cstring,
          FFIType.ptr,
          FFIType.u64,
          FFIType.u32,
          FFIType.i32,
        ],
        returns: FFIType.i64,
      },
    });
    const read = (descriptor: number): Buffer => {
      const value = Buffer.alloc(64);
      const length = Number(library.symbols.fgetxattr(
        descriptor,
        attributeName,
        value,
        value.byteLength,
        0,
        0,
      ));
      if (length !== value.byteLength) {
        value.fill(0);
        throw new ControlPlaneRestoreStateError(
          "Restore-stage custody marker is missing",
        );
      }
      return value;
    };
    return {
      seal(descriptor, nonce) {
        const value = parseCustodyNonce(nonce);
        try {
          if (
            library.symbols.fsetxattr(
              descriptor,
              attributeName,
              value,
              value.byteLength,
              0,
              0x0002,
            ) !== 0
          ) {
            throw new ControlPlaneRestoreStateError(
              "Restore-stage custody marker could not be created",
            );
          }
          fsyncSync(descriptor);
        } finally {
          value.fill(0);
        }
        this.assert(descriptor, nonce);
      },
      assert(descriptor, nonce) {
        const expected = parseCustodyNonce(nonce);
        const actual = read(descriptor);
        try {
          if (!actual.equals(expected)) {
            throw new ControlPlaneRestoreStateError(
              "Restore-stage custody marker does not match its journal",
            );
          }
        } finally {
          actual.fill(0);
          expected.fill(0);
        }
      },
      close() {
        if (closed) return;
        closed = true;
        library.close();
      },
    };
  }
  const library = dlopen(libraryPath, {
    fsetxattr: {
      args: [
        FFIType.i32,
        FFIType.cstring,
        FFIType.ptr,
        FFIType.u64,
        FFIType.i32,
      ],
      returns: FFIType.i32,
    },
    fgetxattr: {
      args: [FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
  });
  const read = (descriptor: number): Buffer => {
    const value = Buffer.alloc(64);
    const length = Number(library.symbols.fgetxattr(
      descriptor,
      attributeName,
      value,
      value.byteLength,
    ));
    if (length !== value.byteLength) {
      value.fill(0);
      throw new ControlPlaneRestoreStateError(
        "Restore-stage custody marker is missing",
      );
    }
    return value;
  };
  return {
    seal(descriptor, nonce) {
      const value = parseCustodyNonce(nonce);
      try {
        if (
          library.symbols.fsetxattr(
            descriptor,
            attributeName,
            value,
            value.byteLength,
            1,
          ) !== 0
        ) {
          throw new ControlPlaneRestoreStateError(
            "Restore-stage custody marker could not be created",
          );
        }
        fsyncSync(descriptor);
      } finally {
        value.fill(0);
      }
      this.assert(descriptor, nonce);
    },
    assert(descriptor, nonce) {
      const expected = parseCustodyNonce(nonce);
      const actual = read(descriptor);
      try {
        if (!actual.equals(expected)) {
          throw new ControlPlaneRestoreStateError(
            "Restore-stage custody marker does not match its journal",
          );
        }
      } finally {
        actual.fill(0);
        expected.fill(0);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      library.close();
    },
  };
}

function parseCustodyNonce(nonce: string): Buffer {
  if (!hexDigestSchema.safeParse(nonce).success) {
    throw new ControlPlaneRestoreStateError(
      "Restore-stage custody nonce is invalid",
    );
  }
  return Buffer.from(nonce, "ascii");
}

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
  readonly attachmentVault: string;
  readonly attachmentVaultStage: string;
  readonly attachmentVaultRollback: string;
}

export interface ControlPlaneAttachmentVaultBlobProof {
  readonly attachmentId: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ControlPlaneAttachmentVaultProof {
  readonly generationSha256: string;
  readonly totalBytes: number;
  readonly blobs: readonly ControlPlaneAttachmentVaultBlobProof[];
}

export interface ControlPlaneAttachmentVaultCapture
  extends ControlPlaneAttachmentVaultProof {
  readonly blobBytes: readonly Uint8Array[];
  fill(): void;
}

export interface StreamControlPlaneAttachmentVaultInput {
  readonly root: string;
  readonly expected: ControlPlaneAttachmentVaultProof;
  readonly onChunk: (
    blob: ControlPlaneAttachmentVaultBlobProof,
    chunk: Uint8Array,
  ) => void;
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
    attachmentVault: chatAttachmentVaultRoot(databasePath),
    attachmentVaultStage: join(
      parent,
      controlPlaneRestoreVaultStageDirectoryName,
    ),
    attachmentVaultRollback: join(
      parent,
      controlPlaneRestoreVaultRollbackDirectoryName,
    ),
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
  assertProtectedAttachmentVaultHash(
    paths.attachmentVaultStage,
    journal.attachmentVaultGenerationSha256,
    "attachment-vault stage",
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

  if (journal.hadAttachmentVault) {
    if (
      journal.originalAttachmentVaultGenerationSha256 === null
      || journal.originalAttachmentVaultInventory === null
      || journal.originalAttachmentVaultInventory.generationSha256
        !== journal.originalAttachmentVaultGenerationSha256
    ) {
      throw new ControlPlaneRestoreStateError(
        "The restore journal omits the original attachment-vault proof",
      );
    }
    assertProtectedAttachmentVaultHash(
      paths.attachmentVault,
      journal.originalAttachmentVaultGenerationSha256,
      "original attachment vault",
    );
  } else if (
    journal.originalAttachmentVaultGenerationSha256 !== null
    || journal.originalAttachmentVaultInventory !== null
    || readMetadata(paths.attachmentVault) !== null
  ) {
    throw new ControlPlaneRestoreStateError(
      "The restore state contains an unjournaled attachment vault",
    );
  }
  if (readMetadata(paths.attachmentVaultRollback) !== null) {
    throw new ControlPlaneRestoreStateError(
      "The restore state contains an unexpected attachment-vault rollback",
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
      || journal.hadAttachmentVault !==
        (journal.originalAttachmentVaultGenerationSha256 !== null)
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

export function inspectControlPlaneAttachmentVault(
  root: string,
  expectedRootIdentity?: Readonly<{ dev: number; ino: number }>,
): ControlPlaneAttachmentVaultProof {
  const capture = readControlPlaneAttachmentVault(root, {
    retainBlobBytes: false,
    maximumTotalBytes: maximumControlPlaneAttachmentVaultByteLength,
    ...(expectedRootIdentity === undefined ? {} : { expectedRootIdentity }),
  });
  return {
    generationSha256: capture.generationSha256,
    totalBytes: capture.totalBytes,
    blobs: capture.blobs,
  };
}

/**
 * Captures bytes through the same no-follow descriptor tree that authenticates
 * the generation. Callers must invoke fill() after archive construction.
 */
export function captureControlPlaneAttachmentVault(
  root: string,
  maximumTotalBytes = maximumControlPlaneAttachmentVaultByteLength,
): ControlPlaneAttachmentVaultCapture {
  if (
    !Number.isSafeInteger(maximumTotalBytes)
    || maximumTotalBytes < 0
    || maximumTotalBytes > maximumControlPlaneAttachmentVaultByteLength
  ) {
    throw new ControlPlaneRestoreStateError(
      "The attachment-vault capture byte ceiling is invalid",
    );
  }
  return readControlPlaneAttachmentVault(root, {
    retainBlobBytes: true,
    maximumTotalBytes,
  });
}

/** Streams one already-inspected generation through the same bound directory
 * authority. Any identity, size, order, or digest drift aborts the stream. */
export function streamControlPlaneAttachmentVault(
  input: StreamControlPlaneAttachmentVaultInput,
): void {
  const capture = readControlPlaneAttachmentVault(input.root, {
    retainBlobBytes: false,
    maximumTotalBytes: input.expected.totalBytes,
    expected: input.expected,
    onChunk: input.onChunk,
  });
  capture.fill();
}

/**
 * Erases only the bounded, journal-authorized subset of an interrupted fixed
 * attachment stage. The authenticated relative inventory is the deletion
 * authority; absent not-yet-written entries are allowed, extras fail closed.
 */
export function erasePartialControlPlaneAttachmentVaultStage(input: Readonly<{
  root: string;
  expectedParentIdentity: Readonly<{ dev: number; ino: number }>;
  inventory: ControlPlaneRestoreAttachmentVaultInventory;
  stageCustodyNonce: string;
}>): void {
  const inventory = controlPlaneRestoreAttachmentVaultInventorySchema.parse(
    input.inventory,
  );
  const parentPath = dirname(input.root);
  const parent = bindVaultDirectory(parentPath, "restore-stage parent");
  if (
    parent.identity.dev !== input.expectedParentIdentity.dev
    || parent.identity.ino !== input.expectedParentIdentity.ino
  ) {
    closeSync(parent.descriptor);
    throw new ControlPlaneRestoreStateError(
      "The restore-stage parent is not the journaled root",
    );
  }
  const libraryPath = process.platform === "darwin"
    ? "/usr/lib/libSystem.B.dylib"
    : process.platform === "linux"
    ? "libc.so.6"
    : null;
  if (libraryPath === null) {
    closeSync(parent.descriptor);
    throw new ControlPlaneRestoreStateError(
      "Descriptor-relative attachment cleanup is unsupported",
    );
  }
  const library = dlopen(libraryPath, {
    openat: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32],
      returns: FFIType.i32,
    },
    unlinkat: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32],
      returns: FFIType.i32,
    },
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  let errnoAccess: NativeErrnoAccess;
  try {
    errnoAccess = bindNativeErrno(libraryPath);
  } catch (error: unknown) {
    try {
      library.close();
    } finally {
      closeSync(parent.descriptor);
    }
    throw error;
  }
  const cstring = (name: string): Buffer => {
    if (name.length === 0 || name.includes("/") || name.includes("\0")) {
      throw new ControlPlaneRestoreStateError(
        "The restore-stage cleanup name is invalid",
      );
    }
    return Buffer.from(`${name}\0`);
  };
  const tryOpenAt = (
    parentDescriptor: number,
    name: string,
    flags: number,
  ): number | null => {
    const descriptor = library.symbols.openat(
      parentDescriptor,
      cstring(name),
      flags,
    );
    return descriptor < 0 ? null : descriptor;
  };
  const openAt = (
    parentDescriptor: number,
    name: string,
    flags: number,
  ): number => {
    const descriptor = tryOpenAt(parentDescriptor, name, flags);
    if (descriptor === null) {
      throw new ControlPlaneRestoreStateError(
        "The restore-stage inventory changed during cleanup",
      );
    }
    return descriptor;
  };
  const native: NativeDirectoryEnumerator = {
    dup: library.symbols.dup,
    fdopendir: library.symbols.fdopendir,
    readdir: library.symbols.readdir,
    closedir: library.symbols.closedir,
    errno: errnoAccess,
  };
  const expectedByPath = new Map(
    inventory.blobs.map((blob) => [blob.relativePath, blob] as const),
  );
  const expectedAttachmentIds = new Set(
    inventory.blobs.map(({ attachmentId }) => attachmentId),
  );
  type DirectoryRecord = Readonly<{
    directory: BoundVaultDirectory;
    parent: BoundVaultDirectory;
    name: string;
    depth: number;
  }>;
  type FileRecord = Readonly<{
    descriptor: number;
    identity: Stats;
    parent: BoundVaultDirectory;
    name: string;
  }>;
  const directories: DirectoryRecord[] = [];
  const files: FileRecord[] = [];
  let stageCustody: ControlPlaneRestoreStageCustody | null = null;
  let rootDirectory: BoundVaultDirectory | null = null;
  let firstFailure: unknown = null;
  const attempt = (operation: () => void): void => {
    try {
      operation();
    } catch (error: unknown) {
      if (firstFailure === null) firstFailure = error;
    }
  };
  const throwFirstFailure = (): void => {
    if (firstFailure === null) return;
    if (firstFailure instanceof Error) throw firstFailure;
    throw new ControlPlaneRestoreStateError(
      "Restore-stage cleanup failed with a non-error value",
    );
  };
  const list = (
    directory: BoundVaultDirectory,
    maximumEntries: number,
  ): readonly string[] => listBoundVaultDirectory(directory, native, maximumEntries);
  const assertStageCustody = (descriptor: number): void => {
    if (stageCustody === null) {
      throw new ControlPlaneRestoreStateError(
        "Restore-stage custody authority is unavailable",
      );
    }
    stageCustody.assert(descriptor, input.stageCustodyNonce);
  };
  const bindChild = (
    parentDirectory: BoundVaultDirectory,
    name: string,
    path: string,
    label: string,
    depth: number,
  ): BoundVaultDirectory => {
    const child = bindVaultDirectoryAt(
      parentDirectory,
      name,
      path,
      label,
      (descriptor, childName, flags) =>
        openAt(descriptor, childName, flags),
    );
    try {
      assertStageCustody(child.descriptor);
      directories.push({
        directory: child,
        parent: parentDirectory,
        name,
        depth,
      });
      return child;
    } catch (error: unknown) {
      closeSync(child.descriptor);
      throw error;
    }
  };
  const retainFile = (
    parentDirectory: BoundVaultDirectory,
    name: string,
    relativePath: string,
  ): void => {
    const expected = expectedByPath.get(relativePath);
    if (expected === undefined) {
      throw new ControlPlaneRestoreStateError(
        "The partial attachment stage contains an unjournaled file",
      );
    }
    const descriptor = openAt(
      parentDirectory.descriptor,
      name,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | closeOnExecFlag,
    );
    try {
      const identity = fstatSync(descriptor);
      const currentUser = process.getuid?.();
      if (
        !identity.isFile()
        || identity.dev !== parent.identity.dev
        || (currentUser !== undefined && identity.uid !== currentUser)
      ) {
        throw new ControlPlaneRestoreStateError(
          "The partial attachment stage file is unsafe",
        );
      }
      assertStageCustody(descriptor);
      if (
        identity.nlink !== 1
        || identity.size < 0
        || identity.size > expected.bytes
        || (identity.mode & 0o777) !== 0o600
      ) {
        throw new ControlPlaneRestoreStateError(
          "The partial attachment stage file is unsafe",
        );
      }
      files.push({ descriptor, identity, parent: parentDirectory, name });
    } catch (error: unknown) {
      closeSync(descriptor);
      throw error;
    }
  };
  try {
    stageCustody = bindControlPlaneRestoreStageCustody();
    const rootName = basename(input.root);
    const rootDescriptor = tryOpenAt(
      parent.descriptor,
      rootName,
      protectedDirectoryReadFlags,
    );
    if (rootDescriptor === null) {
      if (readMetadata(input.root) !== null) {
        throw new ControlPlaneRestoreStateError(
          "The partial attachment stage root is unsafe",
        );
      }
      return;
    }
    rootDirectory = bindVaultDirectoryDescriptor(
      input.root,
      "partial attachment stage root",
      rootDescriptor,
      parent.identity.dev,
    );
    assertStageCustody(rootDirectory.descriptor);
    directories.push({
      directory: rootDirectory,
      parent,
      name: rootName,
      depth: 0,
    });
    const rootEntries = list(rootDirectory, 1);
    if (rootEntries.some((entry) => entry !== "objects")) {
      throw new ControlPlaneRestoreStateError(
        "The partial attachment stage root has an unexpected entry",
      );
    }
    if (rootEntries.includes("objects")) {
      const objects = bindChild(
        rootDirectory,
        "objects",
        join(input.root, "objects"),
        "partial attachment object root",
        1,
      );
      const attachmentIds = list(
        objects,
        maximumControlPlaneAttachmentVaultFileCount,
      );
      for (const attachmentId of attachmentIds) {
        if (!expectedAttachmentIds.has(attachmentId)) {
          throw new ControlPlaneRestoreStateError(
            "The partial attachment stage has an unjournaled object",
          );
        }
        const object = bindChild(
          objects,
          attachmentId,
          join(input.root, "objects", attachmentId),
          "partial attachment object",
          2,
        );
        const objectEntries = list(object, 3);
        for (const entry of objectEntries) {
          if (entry === "normalized") {
            if (![...expectedByPath.keys()].some((path) =>
              path.startsWith(`${attachmentId}/normalized/`)
            )) {
              throw new ControlPlaneRestoreStateError(
                "The partial attachment stage has an unjournaled normalization",
              );
            }
            const normalized = bindChild(
              object,
              entry,
              join(input.root, "objects", attachmentId, entry),
              "partial attachment normalization",
              3,
            );
            const entries = list(normalized, 2);
            for (const generationEntry of entries) {
              if (
                generationEntry !== "canonical.png"
                && generationEntry !== "preview.png"
              ) {
                throw new ControlPlaneRestoreStateError(
                  "The partial attachment normalization has an unexpected entry",
                );
              }
              retainFile(
                normalized,
                generationEntry,
                `${attachmentId}/normalized/${generationEntry}`,
              );
            }
          } else if (
            entry === "source.upload"
            || /^blob\.[a-z0-9]{1,16}$/u.test(entry)
          ) {
            retainFile(object, entry, `${attachmentId}/${entry}`);
          } else {
            throw new ControlPlaneRestoreStateError(
              "The partial attachment object has an unexpected entry",
            );
          }
        }
      }
    }
    for (const file of files) {
      ftruncateSync(file.descriptor, 0);
      fsyncSync(file.descriptor);
      const after = fstatSync(file.descriptor);
      if (
        after.dev !== file.identity.dev
        || after.ino !== file.identity.ino
        || after.size !== 0
        || after.nlink !== 1
      ) {
        throw new ControlPlaneRestoreStateError(
          "The partial attachment stage file could not be erased safely",
        );
      }
    }
    for (const file of files) {
      if (
        library.symbols.unlinkat(
          file.parent.descriptor,
          cstring(file.name),
          0,
        ) !== 0
      ) {
        throw new ControlPlaneRestoreStateError(
          "The partial attachment stage file could not be removed safely",
        );
      }
      fsyncSync(file.parent.descriptor);
      if (fstatSync(file.descriptor).nlink !== 0) {
        throw new ControlPlaneRestoreStateError(
          "The partial attachment stage file name changed during cleanup",
        );
      }
    }
    const removeDirectoryFlag = process.platform === "darwin" ? 0x80 : 0x200;
    for (const record of [...directories].sort((left, right) =>
      right.depth - left.depth
    )) {
      if (
        library.symbols.unlinkat(
          record.parent.descriptor,
          cstring(record.name),
          removeDirectoryFlag,
        ) !== 0
      ) {
        throw new ControlPlaneRestoreStateError(
          "The partial attachment stage directory could not be removed safely",
        );
      }
      fsyncSync(record.parent.descriptor);
    }
  } finally {
    for (const file of files) attempt(() => closeSync(file.descriptor));
    for (const record of [...directories].reverse()) {
      attempt(() => closeSync(record.directory.descriptor));
    }
    attempt(() => errnoAccess.close());
    attempt(() => library.close());
    attempt(() => stageCustody?.close());
    attempt(() => closeSync(parent.descriptor));
    throwFirstFailure();
  }
}

interface ReadControlPlaneAttachmentVaultOptions {
  readonly retainBlobBytes: boolean;
  readonly maximumTotalBytes: number;
  readonly expected?: ControlPlaneAttachmentVaultProof;
  readonly onChunk?: StreamControlPlaneAttachmentVaultInput["onChunk"];
  readonly expectedRootIdentity?: Readonly<{ dev: number; ino: number }>;
}

function readControlPlaneAttachmentVault(
  root: string,
  options: ReadControlPlaneAttachmentVaultOptions,
): ControlPlaneAttachmentVaultCapture {
  const libraryPath = process.platform === "darwin"
    ? "/usr/lib/libSystem.B.dylib"
    : process.platform === "linux"
    ? "libc.so.6"
    : null;
  if (libraryPath === null) {
    throw new ControlPlaneRestoreStateError(
      "Descriptor-relative attachment inspection is unsupported",
    );
  }
  const library = dlopen(libraryPath, {
    openat: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32],
      returns: FFIType.i32,
    },
    dup: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
    fdopendir: {
      args: [FFIType.i32],
      returns: FFIType.ptr,
    },
    readdir: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    closedir: {
      args: [FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  let errnoAccess: NativeErrnoAccess;
  try {
    errnoAccess = bindNativeErrno(libraryPath);
  } catch (error: unknown) {
    library.close();
    throw error;
  }
  const openAt = (parent: number, name: string, flags: number): number => {
    const descriptor = library.symbols.openat(
      parent,
      Buffer.from(`${name}\0`),
      flags,
    );
    if (descriptor < 0) {
      throw new ControlPlaneRestoreStateError(
        "The attachment-vault inventory changed during inspection",
      );
    }
    return descriptor;
  };
  let rootDirectory: BoundVaultDirectory | null = null;
  let objectsDirectory: BoundVaultDirectory | null = null;
  const retainedBlobBytes: Uint8Array[] = [];
  let completed = false;
  try {
    rootDirectory = bindVaultDirectory(root, "attachment-vault root");
    if (
      options.expectedRootIdentity !== undefined
      && (
        rootDirectory.identity.dev !== options.expectedRootIdentity.dev
        || rootDirectory.identity.ino !== options.expectedRootIdentity.ino
      )
    ) {
      throw new ControlPlaneRestoreStateError(
        "The attachment-vault root is not the expected generation directory",
      );
    }
    const listDirectory = (
      directory: BoundVaultDirectory,
      maximumEntries: number,
    ): readonly string[] =>
      listBoundVaultDirectory(directory, {
        dup: library.symbols.dup,
        fdopendir: library.symbols.fdopendir,
        readdir: library.symbols.readdir,
        closedir: library.symbols.closedir,
        errno: errnoAccess,
      }, maximumEntries);
    const rootEntries = listDirectory(rootDirectory, 1);
    if (rootEntries.length !== 1 || rootEntries[0] !== "objects") {
      throw new ControlPlaneRestoreStateError(
        "The attachment-vault root has an unexpected inventory",
      );
    }
    const objectsRoot = join(root, "objects");
    objectsDirectory = bindVaultDirectoryAt(
      rootDirectory,
      "objects",
      objectsRoot,
      "attachment-vault object root",
      openAt,
    );
    const blobs: ControlPlaneAttachmentVaultBlobProof[] = [];
    let totalBytes = 0;
    const attachmentIds = listDirectory(
      objectsDirectory,
      maximumControlPlaneAttachmentVaultFileCount,
    );
    const appendBlob = (read: ControlPlaneAttachmentVaultBlobRead): void => {
      const blob = read.proof;
      if (blobs.length >= maximumControlPlaneAttachmentVaultFileCount) {
        read.bytes?.fill(0);
        throw new ControlPlaneRestoreStateError(
          "The attachment-vault file count exceeds its backup bound",
        );
      }
      const nextTotalBytes = totalBytes + blob.bytes;
      if (
        !Number.isSafeInteger(nextTotalBytes)
        || nextTotalBytes > options.maximumTotalBytes
      ) {
        read.bytes?.fill(0);
        throw new ControlPlaneRestoreStateError(
          "The attachment-vault bytes exceed their backup bound",
        );
      }
      blobs.push(blob);
      if (read.bytes !== null) retainedBlobBytes.push(read.bytes);
      totalBytes = nextTotalBytes;
    };
    for (const attachmentId of attachmentIds) {
      if (
        !/^attachment_[A-Za-z0-9_-]{7,85}$/u.test(attachmentId)
        || attachmentId.length < 18
        || attachmentId.length > 96
      ) {
        throw new ControlPlaneRestoreStateError(
          "The attachment-vault object identifier is invalid",
        );
      }
      const objectRoot = join(objectsRoot, attachmentId);
      const objectDirectory = bindVaultDirectoryAt(
        objectsDirectory,
        attachmentId,
        objectRoot,
        "attachment-vault object",
        openAt,
      );
      try {
        const objectEntries = listDirectory(objectDirectory, 3);
        if (objectEntries.length === 0) {
          throw new ControlPlaneRestoreStateError(
            "The attachment-vault object is empty",
          );
        }
        for (const entry of objectEntries) {
          if (entry === "normalized") {
            const normalizedDirectory = bindVaultDirectoryAt(
              objectDirectory,
              entry,
              join(objectRoot, entry),
              "attachment-vault image generation",
              openAt,
            );
            try {
              const generationEntries = listDirectory(normalizedDirectory, 2);
              if (
                generationEntries.length !== 2
                || generationEntries[0] !== "canonical.png"
                || generationEntries[1] !== "preview.png"
              ) {
                throw new ControlPlaneRestoreStateError(
                  "The attachment-vault image generation is incomplete",
                );
              }
              for (const generationEntry of generationEntries) {
                const expected = options.expected?.blobs[blobs.length];
                appendBlob(readVaultBlobAt(
                  normalizedDirectory,
                  generationEntry,
                  attachmentId,
                  `${attachmentId}/normalized/${generationEntry}`,
                  openAt,
                  options.retainBlobBytes,
                  expected,
                  options.onChunk,
                ));
              }
              assertBoundVaultDirectory(normalizedDirectory);
            } finally {
              closeSync(normalizedDirectory.descriptor);
            }
          } else if (
            entry === "source.upload"
            || /^blob\.[a-z0-9]{1,16}$/u.test(entry)
          ) {
            const expected = options.expected?.blobs[blobs.length];
            appendBlob(readVaultBlobAt(
              objectDirectory,
              entry,
              attachmentId,
              `${attachmentId}/${entry}`,
              openAt,
              options.retainBlobBytes,
              expected,
              options.onChunk,
            ));
          } else {
            throw new ControlPlaneRestoreStateError(
              "The attachment-vault object has an unexpected entry",
            );
          }
        }
        assertBoundVaultDirectory(objectDirectory);
      } finally {
        closeSync(objectDirectory.descriptor);
      }
    }
    assertBoundVaultDirectory(objectsDirectory);
    assertBoundVaultDirectory(rootDirectory);
    const generationSha256 = sha256(Buffer.from(JSON.stringify({
      version: 1,
      blobs,
      totalBytes,
    }), "utf8"));
    if (
      options.expected !== undefined
      && (
        blobs.length !== options.expected.blobs.length
        || totalBytes !== options.expected.totalBytes
        || generationSha256 !== options.expected.generationSha256
      )
    ) {
      throw new ControlPlaneRestoreStateError(
        "The attachment-vault generation changed during streaming",
      );
    }
    const result: ControlPlaneAttachmentVaultCapture = {
      generationSha256,
      totalBytes,
      blobs,
      blobBytes: retainedBlobBytes,
      fill() {
        for (const bytes of retainedBlobBytes) bytes.fill(0);
      },
    };
    completed = true;
    return result;
  } finally {
    if (!completed) {
      for (const bytes of retainedBlobBytes) bytes.fill(0);
    }
    if (objectsDirectory !== null) closeSync(objectsDirectory.descriptor);
    if (rootDirectory !== null) closeSync(rootDirectory.descriptor);
    try {
      errnoAccess.close();
    } finally {
      library.close();
    }
  }
}

interface ControlPlaneAttachmentVaultBlobRead {
  readonly proof: ControlPlaneAttachmentVaultBlobProof;
  readonly bytes: Uint8Array | null;
}

function assertProtectedAttachmentVaultHash(
  root: string,
  expectedSha256: string,
  label: string,
): void {
  const proof = inspectControlPlaneAttachmentVault(root);
  if (proof.generationSha256 !== expectedSha256) {
    throw new ControlPlaneRestoreStateError(
      `The ${label} does not match its journaled hash`,
    );
  }
}

interface BoundVaultDirectory {
  readonly path: string;
  readonly label: string;
  readonly descriptor: number;
  readonly identity: Stats;
}

function bindVaultDirectory(
  path: string,
  label: string,
  expectedDevice?: number,
): BoundVaultDirectory {
  const descriptor = openSync(
    path,
    protectedDirectoryReadFlags,
  );
  try {
    return bindVaultDirectoryDescriptor(
      path,
      label,
      descriptor,
      expectedDevice,
    );
  } catch (error: unknown) {
    closeSync(descriptor);
    throw error;
  }
}

function bindVaultDirectoryAt(
  parent: BoundVaultDirectory,
  name: string,
  path: string,
  label: string,
  openAt: (parent: number, name: string, flags: number) => number,
): BoundVaultDirectory {
  assertBoundVaultDirectory(parent);
  const descriptor = openAt(
    parent.descriptor,
    name,
    protectedDirectoryReadFlags,
  );
  try {
    return bindVaultDirectoryDescriptor(
      path,
      label,
      descriptor,
      parent.identity.dev,
    );
  } catch (error: unknown) {
    closeSync(descriptor);
    throw error;
  }
}

function bindVaultDirectoryDescriptor(
  path: string,
  label: string,
  descriptor: number,
  expectedDevice?: number,
): BoundVaultDirectory {
  const metadata = fstatSync(descriptor);
  const currentUser = process.getuid?.();
  if (
    !metadata.isDirectory()
    || metadata.nlink < 2
    || (metadata.mode & 0o777) !== 0o700
    || (expectedDevice !== undefined && metadata.dev !== expectedDevice)
    || (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new ControlPlaneRestoreStateError(
      `The ${label} is not protected restore state`,
    );
  }
  const bound = { path, label, descriptor, identity: metadata };
  assertBoundVaultDirectory(bound);
  return bound;
}

function listBoundVaultDirectory(
  directory: BoundVaultDirectory,
  native: NativeDirectoryEnumerator,
  maximumEntries: number,
): readonly string[] {
  assertBoundVaultDirectory(directory);
  const nameOffset = process.platform === "darwin"
    ? 21
    : process.platform === "linux"
    ? 19
    : null;
  if (nameOffset === null) {
    throw new ControlPlaneRestoreStateError(
      "Descriptor-relative attachment enumeration is unsupported",
    );
  }
  const duplicate = native.dup(directory.descriptor);
  if (duplicate < 0) {
    throw new ControlPlaneRestoreStateError(
      "The attachment-vault directory could not be enumerated safely",
    );
  }
  const stream = native.fdopendir(duplicate);
  if (stream === null) {
    closeSync(duplicate);
    throw new ControlPlaneRestoreStateError(
      "The attachment-vault directory could not be enumerated safely",
    );
  }
  const entries: string[] = [];
  const seen = new Set<string>();
  let failure: unknown = null;
  try {
    native.errno.clear();
    while (true) {
      const entry = native.readdir(stream);
      if (entry === null) break;
      const name = String(new CString(entry, nameOffset));
      if (name === "." || name === "..") continue;
      if (
        name.length === 0
        || name.includes("\0")
        || name.includes("\uFFFD")
        || Buffer.byteLength(name, "utf8") > 255
        || seen.has(name)
        || entries.length >= maximumEntries
      ) {
        throw new ControlPlaneRestoreStateError(
          "The attachment-vault directory inventory is invalid",
        );
      }
      seen.add(name);
      entries.push(name);
    }
    if (native.errno.read() !== 0) {
      throw new ControlPlaneRestoreStateError(
        "The attachment-vault directory enumeration was incomplete",
      );
    }
  } catch (error: unknown) {
    failure = error;
  } finally {
    if (native.closedir(stream) !== 0 && failure === null) {
      failure = new ControlPlaneRestoreStateError(
        "The attachment-vault directory could not be closed safely",
      );
    }
  }
  if (failure !== null) {
    if (failure instanceof Error) throw failure;
    throw new ControlPlaneRestoreStateError(
      "Attachment-vault enumeration failed with a non-error value",
    );
  }
  entries.sort();
  assertBoundVaultDirectory(directory);
  return entries;
}

interface NativeErrnoAccess {
  clear(): void;
  read(): number;
  close(): void;
}

interface NativeDirectoryEnumerator {
  readonly dup: (descriptor: number) => number;
  readonly fdopendir: (descriptor: number) => Pointer | null;
  readonly readdir: (stream: Pointer) => Pointer | null;
  readonly closedir: (stream: Pointer) => number;
  readonly errno: NativeErrnoAccess;
}

function bindNativeErrno(libraryPath: string): NativeErrnoAccess {
  const bind = (
    library: Readonly<{ close(): void }>,
    location: () => Pointer | null,
  ): NativeErrnoAccess => {
    const pointer = location();
    if (pointer === null) {
      library.close();
      throw new ControlPlaneRestoreStateError(
        "Native directory-enumeration status is unavailable",
      );
    }
    const bytes = toBuffer(pointer, 0, 4);
    return {
      clear() {
        bytes.writeInt32LE(0, 0);
      },
      read() {
        return bytes.readInt32LE(0);
      },
      close() {
        library.close();
      },
    };
  };
  if (process.platform === "darwin") {
    const library = dlopen(libraryPath, {
      __error: { args: [], returns: FFIType.ptr },
    });
    return bind(library, library.symbols.__error);
  }
  if (process.platform === "linux") {
    const library = dlopen(libraryPath, {
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    return bind(library, library.symbols.__errno_location);
  }
  throw new ControlPlaneRestoreStateError(
    "Native directory-enumeration status is unavailable",
  );
}

function assertBoundVaultDirectory(directory: BoundVaultDirectory): void {
  const descriptorMetadata = fstatSync(directory.descriptor);
  const pathMetadata = lstatSync(directory.path);
  for (const metadata of [descriptorMetadata, pathMetadata]) {
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.dev !== directory.identity.dev
      || metadata.ino !== directory.identity.ino
      || metadata.nlink !== directory.identity.nlink
      || metadata.mtimeMs !== directory.identity.mtimeMs
      || metadata.ctimeMs !== directory.identity.ctimeMs
    ) {
      throw new ControlPlaneRestoreStateError(
        `The ${directory.label} changed during inspection`,
      );
    }
  }
}

function readVaultBlobAt(
  parent: BoundVaultDirectory,
  name: string,
  attachmentId: string,
  relativePath: string,
  openAt: (parent: number, name: string, flags: number) => number,
  retainBytes: boolean,
  expected: ControlPlaneAttachmentVaultBlobProof | undefined,
  onChunk: StreamControlPlaneAttachmentVaultInput["onChunk"] | undefined,
): ControlPlaneAttachmentVaultBlobRead {
  assertBoundVaultDirectory(parent);
  const descriptor = openAt(
    parent.descriptor,
    name,
    protectedReadFlags,
  );
  let bytes: Uint8Array | null = null;
  try {
    const before = fstatSync(descriptor);
    const currentUser = process.getuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== parent.identity.dev
      || before.size < 0
      || before.size > 64 * 1_024 * 1_024
      || (before.mode & 0o777) !== 0o600
      || (currentUser !== undefined && before.uid !== currentUser)
    ) {
      throw new ControlPlaneRestoreStateError(
        "The attachment-vault blob is not protected restore state",
      );
    }
    if (
      expected !== undefined
      && (
        expected.attachmentId !== attachmentId
        || expected.relativePath !== relativePath
        || expected.bytes !== before.size
      )
    ) {
      throw new ControlPlaneRestoreStateError(
        "The attachment-vault blob metadata changed during streaming",
      );
    }
    const digest = createHash("sha256");
    const retainedChunks: Uint8Array[] = [];
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(before.size, 1_024 * 1_024)));
    let totalRead = 0;
    try {
      while (totalRead < before.size) {
        const length = readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.byteLength, before.size - totalRead),
          null,
        );
        if (length <= 0) {
          throw new ControlPlaneRestoreStateError(
            "The attachment-vault blob was truncated during inspection",
          );
        }
        const chunk = buffer.subarray(0, length);
        digest.update(chunk);
        onChunk?.({ attachmentId, relativePath, bytes: before.size, sha256: expected?.sha256 ?? "" }, chunk);
        if (retainBytes) retainedChunks.push(Uint8Array.from(chunk));
        totalRead += length;
      }
      bytes = retainBytes
        ? Uint8Array.from(Buffer.concat(retainedChunks.map((chunk) => Buffer.from(chunk))))
        : new Uint8Array(0);
    } finally {
      buffer.fill(0);
      for (const chunk of retainedChunks) chunk.fill(0);
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== before.nlink
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || totalRead !== before.size
    ) {
      throw new ControlPlaneRestoreStateError(
        "The attachment-vault blob changed during inspection",
      );
    }
    const proof = {
      attachmentId,
      relativePath,
      bytes: before.size,
      sha256: digest.digest("hex"),
    };
    if (expected !== undefined && proof.sha256 !== expected.sha256) {
      throw new ControlPlaneRestoreStateError(
        "The attachment-vault blob digest changed during streaming",
      );
    }
    if (!retainBytes) return { proof, bytes: null };
    const retained = bytes;
    bytes = null;
    return { proof, bytes: retained };
  } finally {
    bytes?.fill(0);
    closeSync(descriptor);
    assertBoundVaultDirectory(parent);
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
  const descriptor = openSync(path, protectedReadFlags);
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
