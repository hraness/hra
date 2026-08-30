import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { Database, constants as sqliteConstants } from "bun:sqlite";
import { z } from "zod";

import {
  digestFactsMemoryInspection,
  digestFactsMemoryPurgeReceipt,
  digestFactsMemoryReceipt,
  factsMemoryBindingSchema,
  factsMemoryCheckpointSchema,
  factsMemoryDigestSchema,
  factsMemoryHeadSchema,
  factsMemoryPurgeReceiptSchema,
  factsMemoryStoreInspectionSchema,
  factsMemoryStoreReceiptSchema,
  type FactsMemoryBinding,
  type FactsMemoryCheckpoint,
  type FactsMemoryHead,
  type FactsMemoryPurgeReceipt,
  type FactsMemoryStoreReceipt,
  type FactsMemoryStoreInspection,
} from "../domain/facts-memory";
import { profileIdSchema, sessionIdSchema, unixMillisecondsSchema } from "../domain/values";

const lifecycleStateSchema = z.enum([
  "reserved",
  "creating",
  "create_ambiguous",
  "active",
  "cleanup_pending",
  "purged",
  "recovery_required",
]);
const createKindSchema = z.enum(["create", "fork"]);
export const factsMemoryCleanupReasonSchema = z.enum(["abandon", "archive", "expired"]);
const operationKeySchema = z.string().min(1).max(200);

export type FactsMemoryCleanupReason = z.infer<typeof factsMemoryCleanupReasonSchema>;
export type FactsMemoryLifecycleState = z.infer<typeof lifecycleStateSchema>;

export type FactsMemoryControlRecord = Readonly<{
  binding: FactsMemoryBinding;
  cleanupOperationKey: string | null;
  cleanupReason: FactsMemoryCleanupReason | null;
  cleanupReceiptDigest: string | null;
  createKind: "create" | "fork";
  createOperationKey: string;
  createReceiptDigest: string | null;
  createdAt: number;
  expiresAt: number;
  handleHash: string | null;
  head: FactsMemoryHead | null;
  parent: FactsMemoryCheckpoint | null;
  purgedAt: number | null;
  revision: number;
  state: FactsMemoryLifecycleState;
  storeCreatedAt: number | null;
  updatedAt: number;
}>;

const rowSchema = z.object({
  binding_digest: factsMemoryDigestSchema,
  cleanup_operation_key: z.string().min(1).max(200).nullable(),
  cleanup_reason: factsMemoryCleanupReasonSchema.nullable(),
  cleanup_receipt_digest: factsMemoryDigestSchema.nullable(),
  create_kind: createKindSchema,
  create_operation_key: z.string().min(1).max(200),
  create_receipt_digest: factsMemoryDigestSchema.nullable(),
  created_at: unixMillisecondsSchema,
  expires_at: unixMillisecondsSchema,
  handle_hash: factsMemoryDigestSchema.nullable(),
  head_digest: factsMemoryDigestSchema.nullable(),
  head_sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  owner_id: profileIdSchema,
  parent_binding_digest: factsMemoryDigestSchema.nullable(),
  parent_head_digest: factsMemoryDigestSchema.nullable(),
  parent_head_sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  parent_owner_id: profileIdSchema.nullable(),
  parent_session_id: sessionIdSchema.nullable(),
  purged_at: unixMillisecondsSchema.nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  session_id: sessionIdSchema,
  state: lifecycleStateSchema,
  store_created_at: unixMillisecondsSchema.nullable(),
  updated_at: unixMillisecondsSchema,
}).strict();
const operationKeyOwnerRowSchema = z.object({ session_id: sessionIdSchema }).passthrough();
const schemaNameRowSchema = z.object({ name: z.string() }).passthrough();
const schemaVersionRowSchema = z.object({ user_version: z.number().int().nonnegative() }).passthrough();
const lifecycleColumns = [
  "session_id",
  "owner_id",
  "binding_digest",
  "create_kind",
  "create_operation_key",
  "parent_session_id",
  "parent_owner_id",
  "parent_binding_digest",
  "parent_head_sequence",
  "parent_head_digest",
  "state",
  "handle_hash",
  "head_sequence",
  "head_digest",
  "store_created_at",
  "create_receipt_digest",
  "expires_at",
  "cleanup_reason",
  "cleanup_operation_key",
  "cleanup_receipt_digest",
  "purged_at",
  "revision",
  "created_at",
  "updated_at",
] as const;

const checkpointsEqual = (
  left: FactsMemoryCheckpoint | null,
  right: FactsMemoryCheckpoint | null,
): boolean => left === null || right === null
  ? left === right
  : left.bindingDigest === right.bindingDigest
    && left.ownerId === right.ownerId
    && left.sessionId === right.sessionId
    && left.head.sequence === right.head.sequence
    && left.head.digest === right.head.digest;

const schemaSql = `
CREATE TABLE IF NOT EXISTS facts_memory_lifecycles (
  session_id TEXT PRIMARY KEY CHECK(session_id GLOB 'sess_[0-9a-f]*' AND length(session_id)=37),
  owner_id TEXT NOT NULL CHECK(owner_id GLOB 'acct_[0-9a-f]*' AND length(owner_id)=37),
  binding_digest TEXT NOT NULL UNIQUE CHECK(length(binding_digest)=64),
  create_kind TEXT NOT NULL CHECK(create_kind IN ('create','fork')),
  create_operation_key TEXT NOT NULL UNIQUE CHECK(length(create_operation_key) BETWEEN 1 AND 200),
  parent_session_id TEXT,
  parent_owner_id TEXT,
  parent_binding_digest TEXT,
  parent_head_sequence INTEGER,
  parent_head_digest TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','creating','create_ambiguous','active','cleanup_pending','purged','recovery_required')),
  handle_hash TEXT,
  head_sequence INTEGER,
  head_digest TEXT,
  store_created_at INTEGER,
  create_receipt_digest TEXT,
  expires_at INTEGER NOT NULL CHECK(expires_at>=0),
  cleanup_reason TEXT CHECK(cleanup_reason IN ('abandon','archive','expired')),
  cleanup_operation_key TEXT UNIQUE,
  cleanup_receipt_digest TEXT,
  purged_at INTEGER,
  revision INTEGER NOT NULL CHECK(revision>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  CHECK(
    (create_kind='create' AND parent_session_id IS NULL AND parent_owner_id IS NULL AND parent_binding_digest IS NULL AND parent_head_sequence IS NULL AND parent_head_digest IS NULL)
    OR
    (create_kind='fork' AND parent_session_id IS NOT NULL AND parent_session_id<>session_id AND parent_owner_id=owner_id AND length(parent_binding_digest)=64 AND parent_head_sequence>=0 AND length(parent_head_digest)=64)
  ),
  CHECK(
    (handle_hash IS NULL AND head_sequence IS NULL AND head_digest IS NULL AND store_created_at IS NULL AND create_receipt_digest IS NULL)
    OR
    (length(handle_hash)=64 AND head_sequence>=0 AND length(head_digest)=64 AND store_created_at>=0 AND length(create_receipt_digest)=64)
  ),
  CHECK(
    (cleanup_reason IS NULL AND cleanup_operation_key IS NULL AND cleanup_receipt_digest IS NULL AND purged_at IS NULL)
    OR
    (cleanup_reason IS NOT NULL AND cleanup_operation_key IS NOT NULL)
  ),
  CHECK(state!='active' OR handle_hash IS NOT NULL),
  CHECK(state!='purged' OR (cleanup_receipt_digest IS NOT NULL AND purged_at IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS facts_memory_expiry
  ON facts_memory_lifecycles(expires_at,session_id)
  WHERE state IN ('reserved','creating','create_ambiguous','active','recovery_required');
CREATE TRIGGER IF NOT EXISTS facts_memory_identity_immutable
BEFORE UPDATE OF session_id,owner_id,binding_digest,create_kind,create_operation_key,
  parent_session_id,parent_owner_id,parent_binding_digest,parent_head_sequence,parent_head_digest
ON facts_memory_lifecycles
BEGIN SELECT RAISE(ABORT,'facts memory identity is immutable'); END;
`;

const isSqliteUniqueConstraint = (error: unknown): boolean =>
  error instanceof Error
  && "code" in error
  && (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "SQLITE_CONSTRAINT_PRIMARYKEY");

const readSchemaColumns = (database: Database): readonly string[] =>
  database.query("PRAGMA table_info(facts_memory_lifecycles)").all()
    .map((row) => schemaNameRowSchema.parse(row).name);

const assertControlSchema = (database: Database): void => {
  const tables = database.query(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => schemaNameRowSchema.parse(row).name);
  const columns = readSchemaColumns(database);
  if (
    tables.length !== 1
    || tables[0] !== "facts_memory_lifecycles"
    || columns.some((column, index) => lifecycleColumns[index] !== column)
    || columns.length !== lifecycleColumns.length
  ) throw new Error("FACTS_MEMORY_CONTROL_SCHEMA_UNEXPECTED");
};

const mapRow = (value: unknown): FactsMemoryControlRecord => {
  const row = rowSchema.parse(value);
  const binding = factsMemoryBindingSchema.parse({
    bindingDigest: row.binding_digest,
    ownerId: row.owner_id,
    sessionId: row.session_id,
  });
  const parentValues = [
    row.parent_session_id,
    row.parent_owner_id,
    row.parent_binding_digest,
    row.parent_head_sequence,
    row.parent_head_digest,
  ];
  const parent = parentValues.every((item) => item === null)
    ? null
    : factsMemoryBindingSchema.parse({
        sessionId: row.parent_session_id,
        ownerId: row.parent_owner_id,
        bindingDigest: row.parent_binding_digest,
      });
  if (parent === null && row.create_kind !== "create") throw new Error("FACTS_MEMORY_PARENT_INVALID");
  if (parent !== null && row.create_kind !== "fork") throw new Error("FACTS_MEMORY_PARENT_INVALID");
  if (parent !== null && (parent.ownerId !== binding.ownerId || parent.sessionId === binding.sessionId)) {
    throw new Error("FACTS_MEMORY_PARENT_AUTHORITY_MISMATCH");
  }
  if ((row.head_sequence === null) !== (row.head_digest === null)) throw new Error("FACTS_MEMORY_HEAD_INVALID");
  return {
    binding,
    cleanupOperationKey: row.cleanup_operation_key,
    cleanupReason: row.cleanup_reason,
    cleanupReceiptDigest: row.cleanup_receipt_digest,
    createKind: row.create_kind,
    createOperationKey: row.create_operation_key,
    createReceiptDigest: row.create_receipt_digest,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    handleHash: row.handle_hash,
    head: row.head_sequence === null || row.head_digest === null
      ? null
      : factsMemoryHeadSchema.parse({ sequence: row.head_sequence, digest: row.head_digest }),
    parent: parent === null
      ? null
      : {
          ...parent,
          head: factsMemoryHeadSchema.parse({
            sequence: row.parent_head_sequence,
            digest: row.parent_head_digest,
          }),
        },
    purgedAt: row.purged_at,
    revision: row.revision,
    state: row.state,
    storeCreatedAt: row.store_created_at,
    updatedAt: row.updated_at,
  };
};

const assertPrivateDatabaseFile = (path: string): void => {
  const stats = lstatSync(path);
  const owner = process.getuid?.();
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1
    || (owner !== undefined && stats.uid !== owner)
    || realpathSync(path) !== resolve(path)
  ) throw new Error("FACTS_MEMORY_CONTROL_FILE_UNSAFE");
  if ((stats.mode & 0o077) !== 0) {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
  }
};

export class FactsMemoryControlStore {
  readonly #database: Database;
  readonly #now: () => number;

  constructor(path: string, options: { now?: () => number } = {}) {
    const parent = dirname(path);
    const parentStats = lstatSync(parent);
    const owner = process.getuid?.();
    if (
      !isAbsolute(path)
      || path !== resolve(path)
      || !parentStats.isDirectory()
      || parentStats.isSymbolicLink()
      || parentStats.nlink < 1
      || (owner !== undefined && parentStats.uid !== owner)
      || (parentStats.mode & 0o077) !== 0
      || realpathSync(parent) !== resolve(parent)
    ) {
      throw new Error("FACTS_MEMORY_CONTROL_PATH_UNSAFE");
    }
    const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("FACTS_MEMORY_CONTROL_FILE_UNSAFE");
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    assertPrivateDatabaseFile(path);
    this.#database = new Database(
      path,
      sqliteConstants.SQLITE_OPEN_READWRITE
      | sqliteConstants.SQLITE_OPEN_CREATE
      | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    this.#now = options.now ?? Date.now;
    try {
      this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      const version = schemaVersionRowSchema.parse(
        this.#database.query("PRAGMA user_version").get(),
      ).user_version;
      if (version > 1) throw new Error("FACTS_MEMORY_CONTROL_VERSION_UNSUPPORTED");
      if (version === 1) assertControlSchema(this.#database);
      this.#database.transaction(() => {
        this.#database.exec(schemaSql);
        assertControlSchema(this.#database);
        this.#database.exec("PRAGMA user_version=1");
      }).immediate();
      assertPrivateDatabaseFile(path);
    } catch (error) {
      this.#database.close(false);
      throw error;
    }
  }

  close(): void {
    this.#database.close(false);
  }

  get(sessionId: string): FactsMemoryControlRecord | null {
    const parsed = sessionIdSchema.parse(sessionId);
    const row = this.#database.query(
      "SELECT * FROM facts_memory_lifecycles WHERE session_id=?",
    ).get(parsed);
    return row === null ? null : mapRow(row);
  }

  reserve(input: Readonly<{
    binding: FactsMemoryBinding;
    createOperationKey: string;
    expiresAt: number;
    parent?: FactsMemoryCheckpoint;
  }>): FactsMemoryControlRecord {
    const binding = factsMemoryBindingSchema.parse(input.binding);
    const createOperationKey = operationKeySchema.parse(input.createOperationKey);
    const expiresAt = unixMillisecondsSchema.parse(input.expiresAt);
    const parent = input.parent === undefined
      ? undefined
      : factsMemoryCheckpointSchema.parse(input.parent);
    if (parent !== undefined && parent.sessionId === binding.sessionId) {
      throw new Error("FACTS_MEMORY_SELF_FORK");
    }
    if (parent !== undefined && parent.ownerId !== binding.ownerId) {
      throw new Error("FACTS_MEMORY_PARENT_AUTHORITY_MISMATCH");
    }
    const now = unixMillisecondsSchema.parse(this.#now());
    try {
      this.#database.query(
        `INSERT INTO facts_memory_lifecycles(
           session_id,owner_id,binding_digest,create_kind,create_operation_key,
           parent_session_id,parent_owner_id,parent_binding_digest,parent_head_sequence,parent_head_digest,
           state,expires_at,revision,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,'reserved',?,1,?,?)`,
      ).run(
        binding.sessionId,
        binding.ownerId,
        binding.bindingDigest,
        parent === undefined ? "create" : "fork",
        createOperationKey,
        parent?.sessionId ?? null,
        parent?.ownerId ?? null,
        parent?.bindingDigest ?? null,
        parent?.head.sequence ?? null,
        parent?.head.digest ?? null,
        expiresAt,
        now,
        now,
      );
    } catch (error: unknown) {
      if (!isSqliteUniqueConstraint(error)) throw error;
      const existingByKey = this.#database.query(
        "SELECT * FROM facts_memory_lifecycles WHERE create_operation_key=?",
      ).get(createOperationKey);
      if (existingByKey !== null) {
        const record = mapRow(existingByKey);
        if (record.binding.sessionId !== binding.sessionId) {
          throw new Error("FACTS_MEMORY_OPERATION_KEY_REUSED", { cause: error });
        }
      } else if (this.get(binding.sessionId) === null) {
        throw error;
      }
    }
    let record = this.requireExact(binding);
    const expectedParent = parent ?? null;
    if (
      record.createOperationKey !== createOperationKey
      || !checkpointsEqual(record.parent, expectedParent)
    ) throw new Error("FACTS_MEMORY_RESERVATION_MISMATCH");
    if (expiresAt > record.expiresAt && record.state !== "purged") {
      const extended = this.#database.query(
        `UPDATE facts_memory_lifecycles SET expires_at=?,revision=revision+1,updated_at=?
         WHERE session_id=? AND revision=? AND expires_at<? AND state!='purged'`,
      ).run(expiresAt, this.#now(), binding.sessionId, record.revision, expiresAt);
      if (extended.changes !== 1) throw new Error("FACTS_MEMORY_EXPIRY_CAS_CONFLICT");
      record = this.requireExact(binding);
    }
    return record;
  }

  requireExact(binding: FactsMemoryBinding): FactsMemoryControlRecord {
    const parsed = factsMemoryBindingSchema.parse(binding);
    const record = this.get(parsed.sessionId);
    if (record === null) throw new Error("FACTS_MEMORY_NOT_FOUND");
    if (
      record.binding.ownerId !== parsed.ownerId
      || record.binding.bindingDigest !== parsed.bindingDigest
    ) throw new Error("FACTS_MEMORY_AUTHORITY_MISMATCH");
    return record;
  }

  markCreating(binding: FactsMemoryBinding): FactsMemoryControlRecord {
    const current = this.requireExact(binding);
    if (current.state === "active" || current.state === "creating") return current;
    if (current.state !== "reserved" && current.state !== "create_ambiguous") {
      throw new Error("FACTS_MEMORY_CREATE_STATE_INVALID");
    }
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state='creating',revision=revision+1,updated_at=?
       WHERE session_id=? AND revision=? AND state=?`,
    ).run(this.#now(), current.binding.sessionId, current.revision, current.state);
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_CREATE_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  markCreateAmbiguous(binding: FactsMemoryBinding): FactsMemoryControlRecord {
    const current = this.requireExact(binding);
    if (current.state === "create_ambiguous") return current;
    if (current.state !== "creating") throw new Error("FACTS_MEMORY_CREATE_STATE_INVALID");
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state='create_ambiguous',revision=revision+1,updated_at=?
       WHERE session_id=? AND revision=? AND state='creating'`,
    ).run(this.#now(), current.binding.sessionId, current.revision);
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_CREATE_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  markRecoveryRequired(binding: FactsMemoryBinding): FactsMemoryControlRecord {
    const current = this.requireExact(binding);
    if (current.state === "recovery_required") return current;
    if (current.state === "cleanup_pending" || current.state === "purged") {
      throw new Error("FACTS_MEMORY_RECOVERY_STATE_INVALID");
    }
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state='recovery_required',revision=revision+1,updated_at=?
       WHERE session_id=? AND revision=? AND state NOT IN ('cleanup_pending','purged')`,
    ).run(this.#now(), current.binding.sessionId, current.revision);
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_RECOVERY_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  finalizeActive(binding: FactsMemoryBinding, receiptValue: FactsMemoryStoreReceipt): FactsMemoryControlRecord {
    const receipt = factsMemoryStoreReceiptSchema.parse(receiptValue);
    if (digestFactsMemoryReceipt({
      version: receipt.version,
      bindingDigest: receipt.bindingDigest,
      createdAt: receipt.createdAt,
      handleHash: receipt.handleHash,
      head: receipt.head,
    }) !== receipt.receiptDigest) throw new Error("FACTS_MEMORY_RECEIPT_DIGEST_MISMATCH");
    const current = this.requireExact(binding);
    if (receipt.bindingDigest !== current.binding.bindingDigest) {
      throw new Error("FACTS_MEMORY_RECEIPT_BINDING_MISMATCH");
    }
    if (current.state === "active") {
      if (
        current.handleHash !== receipt.handleHash
        || current.createReceiptDigest !== receipt.receiptDigest
      ) throw new Error("FACTS_MEMORY_RECEIPT_REPLAY_MISMATCH");
      return current;
    }
    if (!new Set<FactsMemoryLifecycleState>(["reserved", "creating", "create_ambiguous"]).has(current.state)) {
      throw new Error("FACTS_MEMORY_CREATE_STATE_INVALID");
    }
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state='active',handle_hash=?,head_sequence=?,head_digest=?,
       store_created_at=?,create_receipt_digest=?,revision=revision+1,updated_at=?
       WHERE session_id=? AND revision=?`,
    ).run(
      receipt.handleHash,
      receipt.head.sequence,
      receipt.head.digest,
      receipt.createdAt,
      receipt.receiptDigest,
      this.#now(),
      current.binding.sessionId,
      current.revision,
    );
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_CREATE_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  refreshHead(binding: FactsMemoryBinding, inspectionValue: FactsMemoryStoreInspection): FactsMemoryControlRecord {
    const inspection = factsMemoryStoreInspectionSchema.parse(inspectionValue);
    const { inspectionDigest, ...inspectionBody } = inspection;
    if (
      digestFactsMemoryReceipt({
        version: inspection.version,
        bindingDigest: inspection.bindingDigest,
        createdAt: inspection.createdAt,
        handleHash: inspection.handleHash,
        head: inspection.initialHead,
      }) !== inspection.receiptDigest
      || digestFactsMemoryInspection(inspectionBody) !== inspectionDigest
    ) throw new Error("FACTS_MEMORY_INSPECTION_DIGEST_MISMATCH");
    const current = this.requireExact(binding);
    if (
      current.state !== "active"
      || inspection.bindingDigest !== current.binding.bindingDigest
      || inspection.handleHash !== current.handleHash
      || inspection.createdAt !== current.storeCreatedAt
      || inspection.receiptDigest !== current.createReceiptDigest
    ) throw new Error("FACTS_MEMORY_RESUME_AUTHORITY_MISMATCH");
    if (current.head?.sequence === inspection.head.sequence) {
      if (current.head.digest !== inspection.head.digest) throw new Error("FACTS_MEMORY_HEAD_EQUIVOCATION");
      return current;
    }
    if (current.head !== null && inspection.head.sequence < current.head.sequence) {
      throw new Error("FACTS_MEMORY_HEAD_REGRESSION");
    }
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET head_sequence=?,head_digest=?,revision=revision+1,updated_at=?
       WHERE session_id=? AND revision=? AND state='active'`,
    ).run(
      inspection.head.sequence,
      inspection.head.digest,
      this.#now(),
      current.binding.sessionId,
      current.revision,
    );
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_HEAD_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  beginCleanup(input: Readonly<{
    binding: FactsMemoryBinding;
    operationKey: string;
    reason: FactsMemoryCleanupReason;
  }>): FactsMemoryControlRecord {
    const current = this.requireExact(input.binding);
    const operationKey = operationKeySchema.parse(input.operationKey);
    const reason = factsMemoryCleanupReasonSchema.parse(input.reason);
    if (current.state === "purged" || current.state === "cleanup_pending") {
      if (current.cleanupOperationKey !== operationKey || current.cleanupReason !== reason) {
        throw new Error("FACTS_MEMORY_CLEANUP_REPLAY_MISMATCH");
      }
      return current;
    }
    const reusedValue = this.#database.query(
      "SELECT session_id FROM facts_memory_lifecycles WHERE cleanup_operation_key=?",
    ).get(operationKey);
    const reused = reusedValue === null ? null : operationKeyOwnerRowSchema.parse(reusedValue);
    if (reused !== null && reused.session_id !== current.binding.sessionId) {
      throw new Error("FACTS_MEMORY_OPERATION_KEY_REUSED");
    }
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state='cleanup_pending',cleanup_reason=?,cleanup_operation_key=?,
       revision=revision+1,updated_at=? WHERE session_id=? AND revision=? AND state!='purged'`,
    ).run(reason, operationKey, this.#now(), current.binding.sessionId, current.revision);
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_CLEANUP_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  finalizePurged(binding: FactsMemoryBinding, receiptValue: FactsMemoryPurgeReceipt): FactsMemoryControlRecord {
    const receipt = factsMemoryPurgeReceiptSchema.parse(receiptValue);
    if (digestFactsMemoryPurgeReceipt({
      version: receipt.version,
      bindingDigest: receipt.bindingDigest,
      handleHash: receipt.handleHash,
      purgedAt: receipt.purgedAt,
    }) !== receipt.purgeDigest) throw new Error("FACTS_MEMORY_PURGE_DIGEST_MISMATCH");
    const current = this.requireExact(binding);
    if (
      receipt.bindingDigest !== current.binding.bindingDigest
      || (current.handleHash !== null && receipt.handleHash !== current.handleHash)
    ) throw new Error("FACTS_MEMORY_PURGE_RECEIPT_MISMATCH");
    if (current.state === "purged") {
      if (current.cleanupReceiptDigest !== receipt.purgeDigest) {
        throw new Error("FACTS_MEMORY_PURGE_RECEIPT_REPLAY_MISMATCH");
      }
      return current;
    }
    if (
      current.state !== "cleanup_pending"
    ) throw new Error("FACTS_MEMORY_PURGE_RECEIPT_MISMATCH");
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state='purged',cleanup_receipt_digest=?,purged_at=?,
       revision=revision+1,updated_at=? WHERE session_id=? AND revision=? AND state='cleanup_pending'`,
    ).run(
      receipt.purgeDigest,
      receipt.purgedAt,
      this.#now(),
      current.binding.sessionId,
      current.revision,
    );
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_CLEANUP_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  listExpired(nowValue: number, limit = 16): readonly FactsMemoryControlRecord[] {
    const now = unixMillisecondsSchema.parse(nowValue);
    const bounded = z.number().int().min(1).max(64).parse(limit);
    return this.#database.query(
      `SELECT * FROM facts_memory_lifecycles
       WHERE state='cleanup_pending'
          OR (expires_at<=? AND state IN ('reserved','creating','create_ambiguous','active','recovery_required'))
       ORDER BY CASE WHEN state='cleanup_pending' THEN 0 ELSE 1 END,expires_at,session_id LIMIT ?`,
    ).all(now, bounded).map(mapRow);
  }

  /** Test/operator proof that the control plane contains authority metadata, never facts. */
  schemaColumns(): readonly string[] {
    return readSchemaColumns(this.#database);
  }
}
