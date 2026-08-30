import { createHash } from "node:crypto";
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
  type FactsMemoryStoreInspection,
  type FactsMemoryStoreReceipt,
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
const epochSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export type FactsMemoryCleanupReason = z.infer<typeof factsMemoryCleanupReasonSchema>;
export type FactsMemoryLifecycleState = z.infer<typeof lifecycleStateSchema>;
export type LegacyFactsMemoryHead = Readonly<{ digest: string; sequence: number }>;

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
  legacyHead: LegacyFactsMemoryHead | null;
  legacyParentHead: LegacyFactsMemoryHead | null;
  parent: FactsMemoryCheckpoint | null;
  priorPurgeChainDigest: string | null;
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
  epoch: epochSchema,
  expires_at: unixMillisecondsSchema,
  handle_hash: factsMemoryDigestSchema.nullable(),
  head_digest: factsMemoryDigestSchema.nullable(),
  head_operation_sha256: factsMemoryDigestSchema.nullable(),
  head_sequence: sequenceSchema.nullable(),
  legacy_head_digest: factsMemoryDigestSchema.nullable(),
  legacy_head_sequence: sequenceSchema.nullable(),
  legacy_parent_head_digest: factsMemoryDigestSchema.nullable(),
  legacy_parent_head_sequence: sequenceSchema.nullable(),
  owner_id: profileIdSchema,
  parent_binding_digest: factsMemoryDigestSchema.nullable(),
  parent_epoch: epochSchema.nullable(),
  parent_head_digest: factsMemoryDigestSchema.nullable(),
  parent_head_operation_sha256: factsMemoryDigestSchema.nullable(),
  parent_head_sequence: sequenceSchema.nullable(),
  parent_owner_id: profileIdSchema.nullable(),
  parent_session_id: sessionIdSchema.nullable(),
  prior_purge_chain_digest: factsMemoryDigestSchema.nullable(),
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
  "epoch",
  "owner_id",
  "binding_digest",
  "create_kind",
  "create_operation_key",
  "parent_session_id",
  "parent_epoch",
  "parent_owner_id",
  "parent_binding_digest",
  "parent_head_sequence",
  "parent_head_operation_sha256",
  "parent_head_digest",
  "legacy_parent_head_sequence",
  "legacy_parent_head_digest",
  "state",
  "handle_hash",
  "head_sequence",
  "head_operation_sha256",
  "head_digest",
  "legacy_head_sequence",
  "legacy_head_digest",
  "store_created_at",
  "create_receipt_digest",
  "expires_at",
  "cleanup_reason",
  "cleanup_operation_key",
  "cleanup_receipt_digest",
  "purged_at",
  "prior_purge_chain_digest",
  "revision",
  "created_at",
  "updated_at",
] as const;

const digestParts = (domain: string, parts: readonly string[]): string => {
  const digest = createHash("sha256");
  digest.update(domain);
  for (const part of parts) {
    digest.update("\0");
    digest.update(part);
  }
  return digest.digest("hex");
};

const headsEqual = (left: FactsMemoryHead, right: FactsMemoryHead): boolean =>
  left.sequence === right.sequence
  && left.operationSha256 === right.operationSha256
  && left.digest === right.digest;

const checkpointsEqual = (
  left: FactsMemoryCheckpoint | null,
  right: FactsMemoryCheckpoint | null,
): boolean => left === null || right === null
  ? left === right
  : left.bindingDigest === right.bindingDigest
    && left.epoch === right.epoch
    && left.ownerId === right.ownerId
    && left.sessionId === right.sessionId
    && headsEqual(left.head, right.head);

const schemaSql = `
CREATE TABLE IF NOT EXISTS facts_memory_lifecycles (
  session_id TEXT PRIMARY KEY CHECK(session_id GLOB 'sess_[0-9a-f]*' AND length(session_id)=37),
  epoch INTEGER NOT NULL CHECK(epoch>0),
  owner_id TEXT NOT NULL CHECK(owner_id GLOB 'acct_[0-9a-f]*' AND length(owner_id)=37),
  binding_digest TEXT NOT NULL UNIQUE CHECK(length(binding_digest)=64),
  create_kind TEXT NOT NULL CHECK(create_kind IN ('create','fork')),
  create_operation_key TEXT NOT NULL UNIQUE CHECK(length(create_operation_key) BETWEEN 1 AND 200),
  parent_session_id TEXT,
  parent_epoch INTEGER,
  parent_owner_id TEXT,
  parent_binding_digest TEXT,
  parent_head_sequence INTEGER,
  parent_head_operation_sha256 TEXT,
  parent_head_digest TEXT,
  legacy_parent_head_sequence INTEGER,
  legacy_parent_head_digest TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','creating','create_ambiguous','active','cleanup_pending','purged','recovery_required')),
  handle_hash TEXT,
  head_sequence INTEGER,
  head_operation_sha256 TEXT,
  head_digest TEXT,
  legacy_head_sequence INTEGER,
  legacy_head_digest TEXT,
  store_created_at INTEGER,
  create_receipt_digest TEXT,
  expires_at INTEGER NOT NULL CHECK(expires_at>=0),
  cleanup_reason TEXT CHECK(cleanup_reason IN ('abandon','archive','expired')),
  cleanup_operation_key TEXT UNIQUE,
  cleanup_receipt_digest TEXT,
  purged_at INTEGER,
  prior_purge_chain_digest TEXT,
  revision INTEGER NOT NULL CHECK(revision>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  CHECK(
    (create_kind='create' AND parent_session_id IS NULL AND parent_epoch IS NULL AND parent_owner_id IS NULL AND parent_binding_digest IS NULL AND parent_head_sequence IS NULL AND parent_head_operation_sha256 IS NULL AND parent_head_digest IS NULL AND legacy_parent_head_sequence IS NULL AND legacy_parent_head_digest IS NULL)
    OR
    (create_kind='fork' AND parent_session_id IS NOT NULL AND parent_session_id<>session_id AND parent_epoch>0 AND parent_owner_id=owner_id AND length(parent_binding_digest)=64 AND (
      (parent_head_sequence>=0 AND ((parent_head_sequence=0 AND parent_head_operation_sha256 IS NULL) OR (parent_head_sequence>0 AND length(parent_head_operation_sha256)=64)) AND length(parent_head_digest)=64 AND legacy_parent_head_sequence IS NULL AND legacy_parent_head_digest IS NULL)
      OR
      (parent_head_sequence IS NULL AND parent_head_operation_sha256 IS NULL AND parent_head_digest IS NULL AND legacy_parent_head_sequence>0 AND length(legacy_parent_head_digest)=64 AND state IN ('recovery_required','cleanup_pending','purged'))
    ))
  ),
  CHECK(
    (handle_hash IS NULL AND head_sequence IS NULL AND head_operation_sha256 IS NULL AND head_digest IS NULL AND legacy_head_sequence IS NULL AND legacy_head_digest IS NULL AND store_created_at IS NULL AND create_receipt_digest IS NULL)
    OR
    (length(handle_hash)=64 AND head_sequence>=0 AND ((head_sequence=0 AND head_operation_sha256 IS NULL) OR (head_sequence>0 AND length(head_operation_sha256)=64)) AND length(head_digest)=64 AND legacy_head_sequence IS NULL AND legacy_head_digest IS NULL AND store_created_at>=0 AND length(create_receipt_digest)=64)
    OR
    (length(handle_hash)=64 AND head_sequence IS NULL AND head_operation_sha256 IS NULL AND head_digest IS NULL AND legacy_head_sequence>0 AND length(legacy_head_digest)=64 AND store_created_at>=0 AND length(create_receipt_digest)=64 AND state IN ('recovery_required','cleanup_pending','purged'))
  ),
  CHECK(
    (cleanup_reason IS NULL AND cleanup_operation_key IS NULL AND cleanup_receipt_digest IS NULL AND purged_at IS NULL)
    OR
    (cleanup_reason IS NOT NULL AND cleanup_operation_key IS NOT NULL)
  ),
  CHECK(state!='active' OR handle_hash IS NOT NULL),
  CHECK(state!='purged' OR (cleanup_receipt_digest IS NOT NULL AND purged_at IS NOT NULL)),
  CHECK(prior_purge_chain_digest IS NULL OR length(prior_purge_chain_digest)=64)
) STRICT;
CREATE INDEX IF NOT EXISTS facts_memory_expiry
  ON facts_memory_lifecycles(expires_at,session_id)
  WHERE state IN ('reserved','creating','create_ambiguous','active','recovery_required');
CREATE TRIGGER IF NOT EXISTS facts_memory_identity_immutable
BEFORE UPDATE OF session_id,epoch,owner_id,binding_digest,create_kind,create_operation_key,
  parent_session_id,parent_epoch,parent_owner_id,parent_binding_digest,parent_head_sequence,
  parent_head_operation_sha256,parent_head_digest,legacy_parent_head_sequence,legacy_parent_head_digest
ON facts_memory_lifecycles
WHEN NOT (
  OLD.state='purged' AND OLD.cleanup_reason='expired'
  AND NEW.session_id=OLD.session_id AND NEW.owner_id=OLD.owner_id AND NEW.epoch=OLD.epoch+1
  AND NEW.create_kind='create' AND NEW.parent_session_id IS NULL AND NEW.parent_epoch IS NULL
  AND NEW.parent_owner_id IS NULL AND NEW.parent_binding_digest IS NULL
  AND NEW.parent_head_sequence IS NULL AND NEW.parent_head_operation_sha256 IS NULL
  AND NEW.parent_head_digest IS NULL AND NEW.legacy_parent_head_sequence IS NULL
  AND NEW.legacy_parent_head_digest IS NULL
)
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

const legacyHead = (sequence: number | null, digest: string | null): LegacyFactsMemoryHead | null => {
  if (sequence === null && digest === null) return null;
  return {
    sequence: sequenceSchema.positive().parse(sequence),
    digest: factsMemoryDigestSchema.parse(digest),
  };
};

const mapRow = (value: unknown): FactsMemoryControlRecord => {
  const row = rowSchema.parse(value);
  const binding = factsMemoryBindingSchema.parse({
    bindingDigest: row.binding_digest,
    epoch: row.epoch,
    ownerId: row.owner_id,
    sessionId: row.session_id,
  });
  const exactParentValues = [
    row.parent_head_sequence,
    row.parent_head_operation_sha256,
    row.parent_head_digest,
  ];
  const exactParentHead = exactParentValues.every((item) => item === null)
    ? null
    : factsMemoryHeadSchema.parse({
        sequence: row.parent_head_sequence,
        operationSha256: row.parent_head_operation_sha256,
        digest: row.parent_head_digest,
      });
  const parent = row.parent_session_id === null || exactParentHead === null
    ? null
    : factsMemoryCheckpointSchema.parse({
        sessionId: row.parent_session_id,
        epoch: row.parent_epoch,
        ownerId: row.parent_owner_id,
        bindingDigest: row.parent_binding_digest,
        head: exactParentHead,
      });
  const exactHeadValues = [row.head_sequence, row.head_operation_sha256, row.head_digest];
  const head = exactHeadValues.every((item) => item === null)
    ? null
    : factsMemoryHeadSchema.parse({
        sequence: row.head_sequence,
        operationSha256: row.head_operation_sha256,
        digest: row.head_digest,
      });
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
    head,
    legacyHead: legacyHead(row.legacy_head_sequence, row.legacy_head_digest),
    legacyParentHead: legacyHead(
      row.legacy_parent_head_sequence,
      row.legacy_parent_head_digest,
    ),
    parent,
    priorPurgeChainDigest: row.prior_purge_chain_digest,
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

const migrateV1 = (database: Database): void => {
  database.exec(`
    DROP TRIGGER IF EXISTS facts_memory_identity_immutable;
    DROP INDEX IF EXISTS facts_memory_expiry;
    ALTER TABLE facts_memory_lifecycles RENAME TO facts_memory_lifecycles_v1;
    ${schemaSql}
    INSERT INTO facts_memory_lifecycles(
      session_id,epoch,owner_id,binding_digest,create_kind,create_operation_key,
      parent_session_id,parent_epoch,parent_owner_id,parent_binding_digest,parent_head_sequence,
      parent_head_operation_sha256,parent_head_digest,legacy_parent_head_sequence,
      legacy_parent_head_digest,state,handle_hash,head_sequence,head_operation_sha256,head_digest,
      legacy_head_sequence,legacy_head_digest,store_created_at,create_receipt_digest,expires_at,
      cleanup_reason,cleanup_operation_key,cleanup_receipt_digest,purged_at,prior_purge_chain_digest,
      revision,created_at,updated_at
    )
    SELECT session_id,1,owner_id,binding_digest,create_kind,create_operation_key,
      parent_session_id,CASE WHEN parent_session_id IS NULL THEN NULL ELSE 1 END,parent_owner_id,
      parent_binding_digest,CASE WHEN parent_head_sequence=0 THEN 0 ELSE NULL END,NULL,
      CASE WHEN parent_head_sequence=0 THEN parent_head_digest ELSE NULL END,
      CASE WHEN parent_head_sequence>0 THEN parent_head_sequence ELSE NULL END,
      CASE WHEN parent_head_sequence>0 THEN parent_head_digest ELSE NULL END,
      CASE WHEN (COALESCE(head_sequence,0)>0 OR COALESCE(parent_head_sequence,0)>0)
        AND state NOT IN ('cleanup_pending','purged') THEN 'recovery_required' ELSE state END,
      handle_hash,CASE WHEN head_sequence=0 THEN 0 ELSE NULL END,NULL,
      CASE WHEN head_sequence=0 THEN head_digest ELSE NULL END,
      CASE WHEN head_sequence>0 THEN head_sequence ELSE NULL END,
      CASE WHEN head_sequence>0 THEN head_digest ELSE NULL END,
      store_created_at,create_receipt_digest,expires_at,cleanup_reason,cleanup_operation_key,
      cleanup_receipt_digest,purged_at,NULL,revision,created_at,updated_at
    FROM facts_memory_lifecycles_v1;
    DROP TABLE facts_memory_lifecycles_v1;
  `);
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
    ) throw new Error("FACTS_MEMORY_CONTROL_PATH_UNSAFE");
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
      const version = schemaVersionRowSchema.parse(this.#database.query("PRAGMA user_version").get()).user_version;
      if (version > 2) throw new Error("FACTS_MEMORY_CONTROL_VERSION_UNSUPPORTED");
      this.#database.transaction(() => {
        if (version === 1) migrateV1(this.#database);
        else this.#database.exec(schemaSql);
        assertControlSchema(this.#database);
        this.#database.exec("PRAGMA user_version=2");
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
    const parent = input.parent === undefined ? undefined : factsMemoryCheckpointSchema.parse(input.parent);
    if (parent !== undefined && parent.sessionId === binding.sessionId) throw new Error("FACTS_MEMORY_SELF_FORK");
    if (parent !== undefined && parent.ownerId !== binding.ownerId) {
      throw new Error("FACTS_MEMORY_PARENT_AUTHORITY_MISMATCH");
    }
    const now = unixMillisecondsSchema.parse(this.#now());
    const latest = this.get(binding.sessionId);
    if (latest !== null && latest.binding.epoch !== binding.epoch) {
      if (
        latest.binding.ownerId !== binding.ownerId
        || latest.state !== "purged"
        || latest.cleanupReason !== "expired"
        || binding.epoch !== latest.binding.epoch + 1
        || parent !== undefined
      ) throw new Error("FACTS_MEMORY_STORE_RETIRED");
      const priorChain = digestParts("hra-facts-memory-prior-purge-chain-v1", [
        latest.priorPurgeChainDigest ?? "first",
        latest.binding.bindingDigest,
        String(latest.binding.epoch),
        latest.cleanupReceiptDigest ?? "missing",
        String(latest.purgedAt ?? 0),
      ]);
      const reactivated = this.#database.query(
        `UPDATE facts_memory_lifecycles SET epoch=?,binding_digest=?,create_kind='create',create_operation_key=?,
         parent_session_id=NULL,parent_epoch=NULL,parent_owner_id=NULL,parent_binding_digest=NULL,
         parent_head_sequence=NULL,parent_head_operation_sha256=NULL,parent_head_digest=NULL,
         legacy_parent_head_sequence=NULL,legacy_parent_head_digest=NULL,state='reserved',handle_hash=NULL,
         head_sequence=NULL,head_operation_sha256=NULL,head_digest=NULL,legacy_head_sequence=NULL,
         legacy_head_digest=NULL,store_created_at=NULL,create_receipt_digest=NULL,expires_at=?,
         cleanup_reason=NULL,cleanup_operation_key=NULL,cleanup_receipt_digest=NULL,purged_at=NULL,
         prior_purge_chain_digest=?,revision=revision+1,created_at=?,updated_at=?
         WHERE session_id=? AND epoch=? AND revision=? AND state='purged' AND cleanup_reason='expired'`,
      ).run(
        binding.epoch,
        binding.bindingDigest,
        createOperationKey,
        expiresAt,
        priorChain,
        now,
        now,
        binding.sessionId,
        latest.binding.epoch,
        latest.revision,
      );
      if (reactivated.changes !== 1) throw new Error("FACTS_MEMORY_EPOCH_CAS_CONFLICT");
    } else if (latest === null) {
      if (binding.epoch !== 1) throw new Error("FACTS_MEMORY_EPOCH_INVALID");
      try {
        this.#database.query(
          `INSERT INTO facts_memory_lifecycles(
             session_id,epoch,owner_id,binding_digest,create_kind,create_operation_key,
             parent_session_id,parent_epoch,parent_owner_id,parent_binding_digest,parent_head_sequence,
             parent_head_operation_sha256,parent_head_digest,state,expires_at,revision,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,1,?,?)`,
        ).run(
          binding.sessionId,
          binding.epoch,
          binding.ownerId,
          binding.bindingDigest,
          parent === undefined ? "create" : "fork",
          createOperationKey,
          parent?.sessionId ?? null,
          parent?.epoch ?? null,
          parent?.ownerId ?? null,
          parent?.bindingDigest ?? null,
          parent?.head.sequence ?? null,
          parent?.head.operationSha256 ?? null,
          parent?.head.digest ?? null,
          expiresAt,
          now,
          now,
        );
      } catch (error: unknown) {
        if (!isSqliteUniqueConstraint(error)) throw error;
        const existingByKey = this.#database.query(
          "SELECT session_id FROM facts_memory_lifecycles WHERE create_operation_key=?",
        ).get(createOperationKey);
        if (existingByKey !== null) {
          const record = operationKeyOwnerRowSchema.parse(existingByKey);
          if (record.session_id !== binding.sessionId) {
            throw new Error("FACTS_MEMORY_OPERATION_KEY_REUSED", { cause: error });
          }
        } else if (this.get(binding.sessionId) === null) throw error;
      }
    }
    let record = this.requireExact(binding);
    const expectedParent = parent ?? null;
    if (
      record.createOperationKey !== createOperationKey
      || !checkpointsEqual(record.parent, expectedParent)
    ) throw new Error("FACTS_MEMORY_RESERVATION_MISMATCH");
    if (
      expiresAt > record.expiresAt
      && record.state !== "cleanup_pending"
      && record.state !== "purged"
    ) {
      const extended = this.#database.query(
        `UPDATE facts_memory_lifecycles SET expires_at=?,revision=revision+1,updated_at=?
         WHERE session_id=? AND epoch=? AND revision=? AND expires_at<? AND state NOT IN ('cleanup_pending','purged')`,
      ).run(expiresAt, this.#now(), binding.sessionId, binding.epoch, record.revision, expiresAt);
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
      record.binding.epoch !== parsed.epoch
      || record.binding.ownerId !== parsed.ownerId
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
    this.#changeState(current, "creating", current.state, "FACTS_MEMORY_CREATE_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  markCreateAmbiguous(binding: FactsMemoryBinding): FactsMemoryControlRecord {
    const current = this.requireExact(binding);
    if (current.state === "create_ambiguous") return current;
    if (current.state !== "creating") throw new Error("FACTS_MEMORY_CREATE_STATE_INVALID");
    this.#changeState(current, "create_ambiguous", "creating", "FACTS_MEMORY_CREATE_CAS_CONFLICT");
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
       WHERE session_id=? AND epoch=? AND revision=? AND state NOT IN ('cleanup_pending','purged')`,
    ).run(this.#now(), current.binding.sessionId, current.binding.epoch, current.revision);
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_RECOVERY_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  finalizeActive(binding: FactsMemoryBinding, receiptValue: FactsMemoryStoreReceipt): FactsMemoryControlRecord {
    const receipt = factsMemoryStoreReceiptSchema.parse(receiptValue);
    this.#assertReceipt(receipt);
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
    return this.#writeActive(current, receipt, current.state);
  }

  recoverCreated(
    binding: FactsMemoryBinding,
    receiptValue: FactsMemoryStoreReceipt,
  ): FactsMemoryControlRecord {
    const receipt = factsMemoryStoreReceiptSchema.parse(receiptValue);
    this.#assertReceipt(receipt);
    const current = this.requireExact(binding);
    if (
      current.state !== "recovery_required"
      || current.handleHash !== null
      || receipt.bindingDigest !== current.binding.bindingDigest
    ) throw new Error("FACTS_MEMORY_RECOVERY_AUTHORITY_MISMATCH");
    return this.#writeActive(current, receipt, "recovery_required");
  }

  refreshHead(binding: FactsMemoryBinding, inspectionValue: FactsMemoryStoreInspection): FactsMemoryControlRecord {
    return this.#applyInspection(binding, inspectionValue, "active");
  }

  recoverActive(binding: FactsMemoryBinding, inspectionValue: FactsMemoryStoreInspection): FactsMemoryControlRecord {
    return this.#applyInspection(binding, inspectionValue, "recovery_required");
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
       revision=revision+1,updated_at=? WHERE session_id=? AND epoch=? AND revision=? AND state!='purged'`,
    ).run(
      reason,
      operationKey,
      this.#now(),
      current.binding.sessionId,
      current.binding.epoch,
      current.revision,
    );
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
    if (current.state !== "cleanup_pending") throw new Error("FACTS_MEMORY_PURGE_RECEIPT_MISMATCH");
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state='purged',cleanup_receipt_digest=?,purged_at=?,
       revision=revision+1,updated_at=? WHERE session_id=? AND epoch=? AND revision=? AND state='cleanup_pending'`,
    ).run(
      receipt.purgeDigest,
      receipt.purgedAt,
      this.#now(),
      current.binding.sessionId,
      current.binding.epoch,
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

  #changeState(
    current: FactsMemoryControlRecord,
    next: FactsMemoryLifecycleState,
    expected: FactsMemoryLifecycleState,
    code: string,
  ): void {
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state=?,revision=revision+1,updated_at=?
       WHERE session_id=? AND epoch=? AND revision=? AND state=?`,
    ).run(
      next,
      this.#now(),
      current.binding.sessionId,
      current.binding.epoch,
      current.revision,
      expected,
    );
    if (changed.changes !== 1) throw new Error(code);
  }

  #assertReceipt(receipt: FactsMemoryStoreReceipt): void {
    if (digestFactsMemoryReceipt({
      version: receipt.version,
      bindingDigest: receipt.bindingDigest,
      createdAt: receipt.createdAt,
      handleHash: receipt.handleHash,
      head: receipt.head,
    }) !== receipt.receiptDigest) throw new Error("FACTS_MEMORY_RECEIPT_DIGEST_MISMATCH");
  }

  #writeActive(
    current: FactsMemoryControlRecord,
    receipt: FactsMemoryStoreReceipt,
    expectedState: FactsMemoryLifecycleState,
  ): FactsMemoryControlRecord {
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state='active',handle_hash=?,head_sequence=?,head_operation_sha256=?,head_digest=?,
       legacy_head_sequence=NULL,legacy_head_digest=NULL,store_created_at=?,create_receipt_digest=?,revision=revision+1,updated_at=?
       WHERE session_id=? AND epoch=? AND revision=? AND state=?`,
    ).run(
      receipt.handleHash,
      receipt.head.sequence,
      receipt.head.operationSha256,
      receipt.head.digest,
      receipt.createdAt,
      receipt.receiptDigest,
      this.#now(),
      current.binding.sessionId,
      current.binding.epoch,
      current.revision,
      expectedState,
    );
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_CREATE_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }

  #applyInspection(
    binding: FactsMemoryBinding,
    inspectionValue: FactsMemoryStoreInspection,
    expectedState: "active" | "recovery_required",
  ): FactsMemoryControlRecord {
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
      current.state !== expectedState
      || current.legacyParentHead !== null
      || inspection.bindingDigest !== current.binding.bindingDigest
      || inspection.handleHash !== current.handleHash
      || inspection.createdAt !== current.storeCreatedAt
      || inspection.receiptDigest !== current.createReceiptDigest
    ) throw new Error("FACTS_MEMORY_RESUME_AUTHORITY_MISMATCH");
    if (current.legacyHead !== null) {
      if (
        inspection.head.sequence !== current.legacyHead.sequence
        || inspection.head.digest !== current.legacyHead.digest
      ) throw new Error("FACTS_MEMORY_LEGACY_HEAD_UNPROVEN");
    } else if (current.head !== null) {
      if (current.head.sequence === inspection.head.sequence && !headsEqual(current.head, inspection.head)) {
        throw new Error("FACTS_MEMORY_HEAD_EQUIVOCATION");
      }
      if (inspection.head.sequence < current.head.sequence) throw new Error("FACTS_MEMORY_HEAD_REGRESSION");
    }
    if (
      expectedState === "active"
      && current.head !== null
      && headsEqual(current.head, inspection.head)
    ) return current;
    const changed = this.#database.query(
      `UPDATE facts_memory_lifecycles SET state='active',head_sequence=?,head_operation_sha256=?,head_digest=?,
       legacy_head_sequence=NULL,legacy_head_digest=NULL,revision=revision+1,updated_at=?
       WHERE session_id=? AND epoch=? AND revision=? AND state=?`,
    ).run(
      inspection.head.sequence,
      inspection.head.operationSha256,
      inspection.head.digest,
      this.#now(),
      current.binding.sessionId,
      current.binding.epoch,
      current.revision,
      expectedState,
    );
    if (changed.changes !== 1) throw new Error("FACTS_MEMORY_HEAD_CAS_CONFLICT");
    return this.requireExact(current.binding);
  }
}
