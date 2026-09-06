import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { attachmentReferenceListSchema, attachmentReferenceSchema } from "../domain/attachment-schemas";
import { isAttachmentImageMediaType, type AttachmentReference } from "../domain/attachments";
import { providerAccountAuthoritySchema } from "../domain/provider-accounts";
import { attemptIdSchema, queueIdSchema, sessionIdSchema, unixMillisecondsSchema, utf8Bytes } from "../domain/values";
import { normalizeSchemaSql } from "./schema-cohort";

export const QUEUE_ATTACHMENT_FORMAT = "atomic_attachments_v1";
export const QUEUE_ATTACHMENT_PENDING_SOURCE_CAP = 200;
export class QueueAttachmentIdentityError extends Error {
  constructor(readonly code: "QUEUE_ATTACHMENT_REQUEST_CONFLICT" | "QUEUE_ATTACHMENT_IDENTITY_UNPROVED" | "QUEUE_ATTACHMENT_IDENTITY_CORRUPT" | "QUEUE_ATTACHMENT_LIMIT") {
    super(code); this.name = "QueueAttachmentIdentityError";
  }
}
const corrupt = (): never => { throw new QueueAttachmentIdentityError("QUEUE_ATTACHMENT_IDENTITY_CORRUPT"); };
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export function parseQueueAttachmentReferences(value: unknown): AttachmentReference[] {
  return Array.isArray(value) && value.length === 0 ? [] : attachmentReferenceListSchema.parse(value);
}
export const queueAttachmentManifestDigest = (value: unknown): string => hash(JSON.stringify({
  domain: "hra:queue-attachment-manifest:v1",
  references: parseQueueAttachmentReferences(value).map((entry) => [entry.byteLength, entry.digest, entry.mediaType, entry.name]),
}));
export function queueAttachmentRequestDigest(input: Readonly<{ sessionId: string; authorityGeneration: number; message: string; attachments: readonly AttachmentReference[] }>): string {
  const attachments = parseQueueAttachmentReferences(input.attachments);
  // The empty branch is exactly the released generic queue preimage.
  const request = attachments.length === 0 ? { message: input.message } : { version: 2, message: input.message, attachments };
  return hash(JSON.stringify({ kind: "session.queue", authorityId: input.sessionId, authorityGeneration: input.authorityGeneration, request }));
}
export const queueAttachmentIdentitySchema = z.object({
  version: z.literal(1), queueId: queueIdSchema, attemptId: attemptIdSchema, idempotencyKey: z.string().uuid(), sessionId: sessionIdSchema,
  authority: providerAccountAuthoritySchema, requestDigest: digestSchema, messageDigest: digestSchema,
  messageUtf8Bytes: z.number().int().min(1).max(262144), manifestDigest: digestSchema,
  attachmentCount: z.number().int().min(0).max(8), createdAt: unixMillisecondsSchema,
}).strict();
export type QueueAttachmentIdentity = z.infer<typeof queueAttachmentIdentitySchema>;
export const queueAttachmentIdentityDigest = (value: QueueAttachmentIdentity): string => hash(JSON.stringify({ domain: "hra:queue-attachment-identity:v1", value }));
export const queueAttachmentsProtectedSql = (alias: string): string => `(${alias}.state IN ('pending','dispatching') OR (${alias}.state='ambiguous'
  AND NOT EXISTS(SELECT 1 FROM queue_effect_resolutions resolution WHERE resolution.queue_id=${alias}.id)))`;
const tables = [
  { name: "queue_attachment_identities", sql: `CREATE TABLE IF NOT EXISTS queue_attachment_identities(
    queue_id TEXT PRIMARY KEY REFERENCES queue_entries(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES mutation_attempts(id),
    original_key TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id),
    identity_json TEXT NOT NULL CHECK(json_valid(identity_json) AND length(CAST(identity_json AS BLOB))<=16384),
    identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64)
  ) STRICT;` },
  { name: "queue_attachment_identity_anchors", sql: `CREATE TABLE IF NOT EXISTS queue_attachment_identity_anchors(
    queue_id TEXT PRIMARY KEY REFERENCES queue_attachment_identities(queue_id), attempt_id TEXT NOT NULL UNIQUE,
    original_key TEXT NOT NULL UNIQUE, identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64)
  ) STRICT;` },
  { name: "queue_attachment_quarantines", sql: `CREATE TABLE IF NOT EXISTS queue_attachment_quarantines(
    queue_id TEXT NOT NULL REFERENCES queue_entries(id), ordinal INTEGER NOT NULL CHECK(ordinal IN (1,2)),
    session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL CHECK(kind IN ('quarantined','abandoned')),
    predecessor INTEGER, expected_session_revision INTEGER,
    reason TEXT NOT NULL CHECK(reason IN ('legacy_identity_unproved','identity_corrupt')),
    recorded_at INTEGER NOT NULL CHECK(recorded_at>=0), PRIMARY KEY(queue_id,ordinal),
    FOREIGN KEY(queue_id,predecessor) REFERENCES queue_attachment_quarantines(queue_id,ordinal),
    CHECK((ordinal=1 AND kind='quarantined' AND predecessor IS NULL AND expected_session_revision IS NULL)
      OR (ordinal=2 AND kind='abandoned' AND predecessor IS 1 AND expected_session_revision IS NOT NULL AND expected_session_revision>0))
  ) STRICT;` },
] as const;
const attached = (id: string, key: string) => `(EXISTS(SELECT 1 FROM queue_attachment_identities identity WHERE identity.attempt_id=${id} OR identity.original_key=${key})
  OR EXISTS(SELECT 1 FROM queue_attachment_identity_anchors anchor WHERE anchor.attempt_id=${id} OR anchor.original_key=${key}))`;
const guards = [
  { name: "queue_attachment_quarantine_insert_guard", table: "queue_attachment_quarantines", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_quarantine_insert_guard
    BEFORE INSERT ON queue_attachment_quarantines WHEN NOT EXISTS(SELECT 1 FROM queue_entries queue WHERE queue.id=NEW.queue_id AND queue.session_id=NEW.session_id)
      OR (NEW.kind='abandoned' AND NOT EXISTS(SELECT 1 FROM queue_attachment_quarantines original JOIN queue_entries queue ON queue.id=original.queue_id
        JOIN sessions session ON session.id=queue.session_id WHERE original.queue_id=NEW.queue_id AND original.ordinal=1
        AND original.session_id=NEW.session_id AND original.reason=NEW.reason AND original.recorded_at<=NEW.recorded_at
        AND queue.state='pending' AND session.revision=NEW.expected_session_revision AND session.state='recovery_required' AND session.active_turn_id IS NULL))
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_CORRUPT'); END;` },
  { name: "queue_attachment_quarantine_state_guard", table: "queue_entries", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_quarantine_state_guard
    BEFORE UPDATE OF state ON queue_entries WHEN OLD.state='pending' AND NEW.state!='pending'
      AND EXISTS(SELECT 1 FROM queue_attachment_quarantines quarantine WHERE quarantine.queue_id=OLD.id AND quarantine.ordinal=1)
      AND NOT (NEW.state='cancelled' AND EXISTS(SELECT 1 FROM queue_attachment_quarantines abandoned WHERE abandoned.queue_id=OLD.id AND abandoned.ordinal=2))
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_UNPROVED'); END;` },
  { name: "queue_attachment_identity_insert_guard", table: "queue_attachment_identities", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_identity_insert_guard
    BEFORE INSERT ON queue_attachment_identities WHEN NOT EXISTS(
      SELECT 1 FROM queue_entries queue JOIN mutation_attempts mutation ON mutation.id=NEW.attempt_id
      JOIN queue_provider_authorities authority ON authority.queue_id=queue.id
      JOIN mutation_provider_authorities primary_authority ON primary_authority.attempt_id=mutation.id AND primary_authority.role='primary'
      WHERE queue.id=NEW.queue_id AND queue.session_id=NEW.session_id AND queue.enqueue_identity_format='${QUEUE_ATTACHMENT_FORMAT}'
        AND queue.state='pending' AND mutation.kind='session.queue' AND mutation.authority_id=queue.session_id
        AND mutation.idempotency_key=NEW.original_key AND mutation.request_format IS NULL
        AND mutation.state='applied' AND json_extract(mutation.result_json,'$.queueId')=queue.id
        AND mutation.request_digest=json_extract(NEW.identity_json,'$.requestDigest')
        AND mutation.authority_generation=json_extract(NEW.identity_json,'$.authority.processGeneration')
        AND json_extract(NEW.identity_json,'$.queueId')=queue.id AND json_extract(NEW.identity_json,'$.attemptId')=mutation.id
        AND json_extract(NEW.identity_json,'$.sessionId')=queue.session_id AND json_extract(NEW.identity_json,'$.idempotencyKey')=mutation.idempotency_key
        AND authority.provider_account_id=json_extract(NEW.identity_json,'$.authority.providerAccountId')
        AND authority.profile_id=json_extract(NEW.identity_json,'$.authority.profileId') AND authority.provider=json_extract(NEW.identity_json,'$.authority.provider')
        AND authority.binding_generation=json_extract(NEW.identity_json,'$.authority.bindingGeneration')
        AND authority.process_generation=json_extract(NEW.identity_json,'$.authority.processGeneration')
        AND primary_authority.provider_account_id=authority.provider_account_id AND primary_authority.profile_id=authority.profile_id
        AND primary_authority.provider=authority.provider AND primary_authority.binding_generation=authority.binding_generation
        AND primary_authority.process_generation=authority.process_generation
        AND (SELECT COUNT(*) FROM message_attachments link WHERE link.session_id=queue.session_id AND link.source_id=queue.id)=json_extract(NEW.identity_json,'$.attachmentCount'))
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_CORRUPT'); END;` },
  { name: "queue_attachment_anchor_insert_guard", table: "queue_attachment_identity_anchors", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_anchor_insert_guard
    BEFORE INSERT ON queue_attachment_identity_anchors WHEN NOT EXISTS(SELECT 1 FROM queue_attachment_identities identity
      WHERE identity.queue_id=NEW.queue_id AND identity.attempt_id=NEW.attempt_id AND identity.original_key=NEW.original_key AND identity.identity_digest=NEW.identity_digest)
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_CORRUPT'); END;` },
  { name: "queue_attachment_mutation_insert_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_mutation_insert_guard
    BEFORE INSERT ON mutation_attempts WHEN ${attached("NEW.id", "NEW.idempotency_key")}
      OR EXISTS(SELECT 1 FROM queue_attachment_identities identity WHERE identity.queue_id=json_extract(NEW.result_json,'$.queueId') AND identity.attempt_id!=NEW.id)
      OR (NEW.kind='session.queue' AND NEW.state='applied')
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_CORRUPT'); END;` },
  { name: "queue_attachment_mutation_update_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_mutation_update_guard
    BEFORE UPDATE ON mutation_attempts WHEN ${attached("OLD.id", "OLD.idempotency_key")} OR ${attached("NEW.id", "NEW.idempotency_key")}
      OR EXISTS(SELECT 1 FROM queue_attachment_identities identity WHERE identity.queue_id=json_extract(NEW.result_json,'$.queueId') AND identity.attempt_id!=NEW.id)
      OR (NEW.kind='session.queue' AND NEW.state='applied' AND OLD.state!='applied' AND NOT EXISTS(SELECT 1 FROM queue_entries queue
        WHERE queue.id=json_extract(NEW.result_json,'$.queueId') AND queue.enqueue_identity_format='${QUEUE_ATTACHMENT_FORMAT}'
          AND queue.enqueue_identity_attempt_id=NEW.id AND queue.session_id=NEW.authority_id))
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_CORRUPT'); END;` },
  { name: "queue_attachment_mutation_delete_guard", table: "mutation_attempts", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_mutation_delete_guard
    BEFORE DELETE ON mutation_attempts WHEN ${attached("OLD.id", "OLD.idempotency_key")}
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_CORRUPT'); END;` },
  { name: "queue_attachment_format_guard", table: "queue_entries", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_format_guard
    BEFORE UPDATE ON queue_entries WHEN NEW.enqueue_identity_format IS NOT OLD.enqueue_identity_format
      OR NEW.enqueue_identity_attempt_id IS NOT OLD.enqueue_identity_attempt_id
      OR (OLD.enqueue_identity_format IS NOT NULL AND (NEW.id!=OLD.id OR NEW.session_id!=OLD.session_id
        OR NEW.created_at!=OLD.created_at OR NEW.enqueue_sequence!=OLD.enqueue_sequence
        OR (NEW.message!=OLD.message AND ${queueAttachmentsProtectedSql("OLD")} AND ${queueAttachmentsProtectedSql("NEW")})))
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_CORRUPT'); END;` },
  { name: "queue_attachment_manifest_insert_guard", table: "message_attachments", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_manifest_insert_guard
    BEFORE INSERT ON message_attachments WHEN EXISTS(SELECT 1 FROM queue_attachment_identities identity
      WHERE identity.queue_id=NEW.source_id AND identity.session_id=NEW.session_id)
      OR EXISTS(SELECT 1 FROM queue_attachment_identity_anchors anchor WHERE anchor.queue_id=NEW.source_id)
      OR EXISTS(SELECT 1 FROM queue_entries queue WHERE queue.id=NEW.source_id AND queue.enqueue_identity_format IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM mutation_attempts mutation WHERE mutation.id=queue.enqueue_identity_attempt_id
          AND mutation.kind='session.queue' AND mutation.authority_id=NEW.session_id AND mutation.state='prepared'))
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_REQUEST_CONFLICT'); END;` },
  { name: "queue_attachment_manifest_delete_guard", table: "message_attachments", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_manifest_delete_guard
    BEFORE DELETE ON message_attachments WHEN EXISTS(SELECT 1 FROM queue_entries queue WHERE queue.id=OLD.source_id
      AND queue.session_id=OLD.session_id AND ${queueAttachmentsProtectedSql("queue")})
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_CORRUPT'); END;` },
  { name: "queue_attachment_dispatch_guard", table: "queue_entries", sql: `CREATE TRIGGER IF NOT EXISTS queue_attachment_dispatch_guard
    BEFORE UPDATE OF state ON queue_entries WHEN OLD.state='pending' AND NEW.state='dispatching' AND (
      OLD.enqueue_identity_format IS NOT '${QUEUE_ATTACHMENT_FORMAT}'
      OR NOT EXISTS(SELECT 1 FROM queue_attachment_identities identity JOIN queue_attachment_identity_anchors anchor ON anchor.queue_id=identity.queue_id
        WHERE identity.queue_id=OLD.id AND anchor.identity_digest=identity.identity_digest AND anchor.original_key=identity.original_key
          AND (SELECT COUNT(*) FROM message_attachments link WHERE link.session_id=OLD.session_id AND link.source_id=OLD.id)=json_extract(identity.identity_json,'$.attachmentCount'))
      OR EXISTS(SELECT 1 FROM queue_attachment_quarantines quarantine WHERE quarantine.queue_id=OLD.id))
    BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_UNPROVED'); END;` },
  ...tables.flatMap((table) => ["UPDATE", "DELETE"].map((event) => ({ name: `${table.name}_immutable_${event.toLowerCase()}`, table: table.name,
    sql: `CREATE TRIGGER IF NOT EXISTS ${table.name}_immutable_${event.toLowerCase()} BEFORE ${event} ON ${table.name}
      BEGIN SELECT RAISE(ABORT,'QUEUE_ATTACHMENT_IDENTITY_CORRUPT'); END;` }))),
];
export const QUEUE_ATTACHMENT_SCHEMA_OBJECTS = [
  ...tables.map((table) => ({ ...table, table: table.name, type: "table" as const })),
  { name: "queue_attachment_identity_session", table: "queue_attachment_identities", type: "index" as const,
    sql: "CREATE INDEX IF NOT EXISTS queue_attachment_identity_session ON queue_attachment_identities(session_id,queue_id);" },
  { name: "queue_attachment_receipt_lookup", table: "mutation_attempts", type: "index" as const,
    sql: "CREATE INDEX IF NOT EXISTS queue_attachment_receipt_lookup ON mutation_attempts(json_extract(result_json,'$.queueId')) WHERE kind='session.queue';" },
  { name: "queue_attachment_quarantine_session", table: "queue_attachment_quarantines", type: "index" as const,
    sql: "CREATE INDEX IF NOT EXISTS queue_attachment_quarantine_session ON queue_attachment_quarantines(session_id,queue_id,ordinal);" },
  ...guards.map((guard) => ({ ...guard, type: "trigger" as const })),
];
export function applyQueueAttachmentSchema(database: Database): void {
  if (database.query("SELECT 1 FROM pragma_table_info('queue_entries') WHERE name='enqueue_identity_format'").get() === null) {
    database.exec(`ALTER TABLE queue_entries ADD COLUMN enqueue_identity_format TEXT CHECK(enqueue_identity_format IS NULL OR enqueue_identity_format='${QUEUE_ATTACHMENT_FORMAT}')`);
  }
  for (const table of tables) database.exec(table.sql);
  if (database.query("SELECT 1 FROM pragma_table_info('queue_entries') WHERE name='enqueue_identity_attempt_id'").get() === null) {
    database.exec(`ALTER TABLE queue_entries ADD COLUMN enqueue_identity_attempt_id TEXT REFERENCES queue_attachment_identities(attempt_id) DEFERRABLE INITIALLY DEFERRED
      CHECK((enqueue_identity_format IS NULL AND enqueue_identity_attempt_id IS NULL) OR (enqueue_identity_format IS '${QUEUE_ATTACHMENT_FORMAT}' AND enqueue_identity_attempt_id IS NOT NULL))`);
  }
  for (const object of QUEUE_ATTACHMENT_SCHEMA_OBJECTS) database.exec(object.sql);
}
export function assertQueueAttachmentSchema(database: Database): void {
  const column = database.query("SELECT type,\"notnull\" AS required,dflt_value FROM pragma_table_info('queue_entries') WHERE name='enqueue_identity_format'").get() as
    { type: string; required: number; dflt_value: string | null } | null;
  if (column?.type !== "TEXT" || column.required !== 0 || column.dflt_value !== null) return corrupt();
  const identityColumn = database.query("SELECT type,\"notnull\" AS required,dflt_value FROM pragma_table_info('queue_entries') WHERE name='enqueue_identity_attempt_id'").get() as { type: string; required: number; dflt_value: string | null } | null;
  if (identityColumn?.type !== "TEXT" || identityColumn.required !== 0 || identityColumn.dflt_value !== null) return corrupt();
  const parent = database.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_entries'").get() as { sql: string } | null;
  if (parent === null || /\/\*|--/u.test(parent.sql)) return corrupt();
  const parentSql = normalizeSchemaSql(parent.sql);
  // These owned columns are the complete appended tail in the admitted schema.
  // A future queue-column migration must extend this exact audit, not match
  // declaration text that could occur within an unrelated quoted identifier.
  const suffix = normalizeSchemaSql(`, enqueue_identity_format TEXT CHECK(enqueue_identity_format IS NULL OR enqueue_identity_format='${QUEUE_ATTACHMENT_FORMAT}'),
    enqueue_identity_attempt_id TEXT REFERENCES queue_attachment_identities(attempt_id) DEFERRABLE INITIALLY DEFERRED
    CHECK((enqueue_identity_format IS NULL AND enqueue_identity_attempt_id IS NULL) OR (enqueue_identity_format IS '${QUEUE_ATTACHMENT_FORMAT}' AND enqueue_identity_attempt_id IS NOT NULL))) STRICT`);
  if (!parentSql.endsWith(suffix)) return corrupt();
  for (const object of QUEUE_ATTACHMENT_SCHEMA_OBJECTS) {
    const row = database.query("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").get(object.name) as { type: string; tbl_name: string; sql: string } | null;
    if (row === null || row.type !== object.type || row.tbl_name !== object.table || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(object.sql)) return corrupt();
  }
}
export function readQueueAttachmentIdentity(database: Database, queueIdInput: string): QueueAttachmentIdentity | null {
  assertQueueAttachmentSchema(database);
  const queueId = queueIdSchema.parse(queueIdInput);
  const row = database.query("SELECT * FROM queue_attachment_identities WHERE queue_id=?").get(queueId) as Record<string, unknown> | null;
  const anchor = database.query("SELECT * FROM queue_attachment_identity_anchors WHERE queue_id=?").get(queueId) as Record<string, unknown> | null;
  const queue = database.query("SELECT *,EXISTS(SELECT 1 FROM queue_effect_resolutions resolution WHERE resolution.queue_id=queue_entries.id) AS resolved FROM queue_entries WHERE id=?").get(queueId) as
    { id: string; session_id: string; enqueue_identity_format: string | null; enqueue_identity_attempt_id: string | null; message: string; state: string; created_at: number; resolved: number } | null;
  if (row === null && anchor === null && queue?.enqueue_identity_format === null && queue.enqueue_identity_attempt_id === null) return null;
  if (row === null || anchor === null || queue === null) return corrupt();
  try {
    const json = z.string().max(16384).parse(row.identity_json);
    const identity = queueAttachmentIdentitySchema.parse(JSON.parse(json) as unknown);
    const digest = queueAttachmentIdentityDigest(identity);
    if (JSON.stringify(identity) !== json || row.identity_digest !== digest || row.queue_id !== identity.queueId || row.attempt_id !== identity.attemptId
      || row.original_key !== identity.idempotencyKey || row.session_id !== identity.sessionId || identity.queueId !== queueId
      || queue.session_id !== identity.sessionId || queue.enqueue_identity_format !== QUEUE_ATTACHMENT_FORMAT || queue.created_at !== identity.createdAt
      || queue.enqueue_identity_attempt_id !== identity.attemptId
      || anchor.queue_id !== queueId || anchor.attempt_id !== identity.attemptId || anchor.original_key !== identity.idempotencyKey || anchor.identity_digest !== digest) return corrupt();
    const mutation = database.query("SELECT * FROM mutation_attempts WHERE id=?").get(identity.attemptId) as Record<string, unknown> | null;
    if (mutation === null || mutation.kind !== "session.queue" || mutation.idempotency_key !== identity.idempotencyKey || mutation.authority_id !== identity.sessionId
      || mutation.authority_generation !== identity.authority.processGeneration || mutation.request_digest !== identity.requestDigest
      || mutation.request_format !== null || mutation.state !== "applied" || mutation.result_json !== JSON.stringify({ queueId })
      || typeof mutation.created_at !== "number" || mutation.created_at > identity.createdAt) return corrupt();
    const primary = database.query("SELECT * FROM mutation_provider_authorities WHERE attempt_id=? ORDER BY role LIMIT 2").all(identity.attemptId) as Array<Record<string, unknown>>;
    const queued = database.query("SELECT * FROM queue_provider_authorities WHERE queue_id=?").get(queueId) as Record<string, unknown> | null;
    for (const source of [primary.length === 1 ? primary[0] : undefined, queued]) {
      if (source === null || source === undefined || source.provider_account_id !== identity.authority.providerAccountId
        || source.profile_id !== identity.authority.profileId || source.provider !== identity.authority.provider
        || source.binding_generation !== identity.authority.bindingGeneration || source.process_generation !== identity.authority.processGeneration) return corrupt();
    }
    if (primary[0]?.role !== "primary" || primary[0].provenance !== "session_queue" || queued?.provenance !== "queue_prepare") return corrupt();
    const protectedBody = ["pending", "dispatching"].includes(queue.state) || (queue.state === "ambiguous" && queue.resolved === 0);
    if ((protectedBody || queue.message !== "[queue message removed after settlement]")
      && (utf8Bytes(queue.message) !== identity.messageUtf8Bytes || hash(queue.message) !== identity.messageDigest)) return corrupt();
    if (database.query("SELECT 1 FROM mutation_attempts WHERE kind='session.queue' AND id!=? AND json_extract(result_json,'$.queueId')=? LIMIT 1").get(identity.attemptId, queueId) !== null) return corrupt();
    return identity;
  } catch (error: unknown) { if (error instanceof Error && error.name === "SQLiteError") throw error; return corrupt(); }
}

/** Audit, but preserve valid session.queue as a normal Work nested receipt. */
export function assertQueueAttachmentMutationIntegrity(database: Database, lookup: { idempotencyKey: string } | { attemptId: string }): void {
  const version = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version < 47
    && database.query("SELECT 1 FROM sqlite_master WHERE name LIKE 'queue_attachment_%' LIMIT 1").get() === null
    && database.query("SELECT 1 FROM pragma_table_info('queue_entries') WHERE name IN ('enqueue_identity_format','enqueue_identity_attempt_id')").get() === null) return;
  assertQueueAttachmentSchema(database);
  const byKey = "idempotencyKey" in lookup;
  const value = byKey ? lookup.idempotencyKey : lookup.attemptId;
  const rows = database.query(`SELECT queue_id FROM queue_attachment_identities WHERE ${byKey ? "original_key" : "attempt_id"}=?
    UNION SELECT queue_id FROM queue_attachment_identity_anchors WHERE ${byKey ? "original_key" : "attempt_id"}=?
    UNION SELECT json_extract(result_json,'$.queueId') AS queue_id FROM mutation_attempts
      WHERE ${byKey ? "idempotency_key" : "id"}=? AND kind='session.queue' AND state IN ('applied','reconciled') LIMIT 2`).all(value, value, value) as Array<{ queue_id: unknown }>;
  if (rows.length > 1) return corrupt();
  const row = rows[0];
  if (row === undefined) return;
  const queueId = queueIdSchema.safeParse(row.queue_id);
  if (!queueId.success) return corrupt();
  const identity = readQueueAttachmentIdentity(database, queueId.data);
  if (identity !== null && (byKey ? identity.idempotencyKey : identity.attemptId) !== value) return corrupt();
}

export function readVerifiedQueueAttachmentManifest(database: Database, queueId: string): readonly AttachmentReference[] {
  const identity = readQueueAttachmentIdentity(database, queueId);
  if (identity === null) throw new QueueAttachmentIdentityError("QUEUE_ATTACHMENT_IDENTITY_UNPROVED");
  if (database.query("SELECT 1 FROM queue_attachment_quarantines WHERE queue_id=?").get(queueId) !== null) throw new QueueAttachmentIdentityError("QUEUE_ATTACHMENT_IDENTITY_UNPROVED");
  const rows = database.query(`SELECT link.position,link.digest,link.name,link.media_type,link.byte_length,
    accounting.media_type AS canonical_media_type,accounting.byte_length AS canonical_byte_length
    FROM message_attachments link LEFT JOIN attachments accounting ON accounting.digest=link.digest
    WHERE link.session_id=? AND link.source_id=? ORDER BY link.position LIMIT 9`).all(identity.sessionId, queueId) as Array<Record<string, unknown>>;
  if (rows.length !== identity.attachmentCount) return corrupt();
  try {
  const refs = rows.map((row, index) => {
    const ref = attachmentReferenceSchema.parse({ digest: row.digest, name: row.name, mediaType: row.media_type, byteLength: row.byte_length });
    if (row.position !== index || row.canonical_byte_length !== ref.byteLength
      || row.canonical_media_type !== (isAttachmentImageMediaType(ref.mediaType) ? ref.mediaType : "text/plain")) return corrupt();
    return ref;
  });
  parseQueueAttachmentReferences(refs);
  if (queueAttachmentManifestDigest(refs) !== identity.manifestDigest) return corrupt();
  return refs;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "SQLiteError") throw error;
    return corrupt();
  }
}

export function queueAttachmentQuarantineUnsettled(database: Database, queueId: string): boolean {
  const rows = database.query("SELECT * FROM queue_attachment_quarantines WHERE queue_id=? ORDER BY ordinal LIMIT 3").all(queueId) as Array<Record<string, unknown>>;
  if (rows.length === 0) return false;
  const original = rows[0]; const abandoned = rows[1];
  const queue = database.query("SELECT session_id,state FROM queue_entries WHERE id=?").get(queueId) as { session_id: string; state: string } | null;
  if (rows.length > 2 || original === undefined || queue === null || original.ordinal !== 1 || original.kind !== "quarantined"
    || original.session_id !== queue.session_id || original.predecessor !== null || original.expected_session_revision !== null
    || !["legacy_identity_unproved", "identity_corrupt"].includes(String(original.reason))
    || typeof original.recorded_at !== "number" || !Number.isSafeInteger(original.recorded_at) || original.recorded_at < 0) return corrupt();
  if (abandoned !== undefined) {
    if (abandoned.ordinal !== 2 || abandoned.kind !== "abandoned" || abandoned.session_id !== original.session_id || abandoned.reason !== original.reason
      || abandoned.predecessor !== 1 || typeof abandoned.expected_session_revision !== "number" || !Number.isSafeInteger(abandoned.expected_session_revision)
      || abandoned.expected_session_revision <= 0 || typeof abandoned.recorded_at !== "number" || !Number.isSafeInteger(abandoned.recorded_at)
      || abandoned.recorded_at < original.recorded_at || queue.state !== "cancelled") return corrupt();
    return false;
  }
  if (database.query("SELECT 1 FROM queue_effect_resolutions WHERE queue_id=?").get(queueId) !== null) return false;
  if (!["pending", "dispatching", "ambiguous"].includes(queue.state)) return corrupt();
  return true;
}

export function insertQueueAttachmentIdentity(database: Database, input: QueueAttachmentIdentity): void {
  const identity = queueAttachmentIdentitySchema.parse(input);
  const digest = queueAttachmentIdentityDigest(identity);
  database.query("INSERT INTO queue_attachment_identities(queue_id,attempt_id,original_key,session_id,identity_json,identity_digest) VALUES(?,?,?,?,?,?)")
    .run(identity.queueId, identity.attemptId, identity.idempotencyKey, identity.sessionId, JSON.stringify(identity), digest);
  database.query("INSERT INTO queue_attachment_identity_anchors(queue_id,attempt_id,original_key,identity_digest) VALUES(?,?,?,?)")
    .run(identity.queueId, identity.attemptId, identity.idempotencyKey, digest);
  readVerifiedQueueAttachmentManifest(database, identity.queueId);
}

export function auditQueueAttachmentIdentities(database: Database): void {
  assertQueueAttachmentSchema(database);
  if (database.query(`SELECT 1 FROM queue_attachment_quarantines event LEFT JOIN queue_entries queue ON queue.id=event.queue_id
    LEFT JOIN queue_attachment_quarantines original ON original.queue_id=event.queue_id AND original.ordinal=1
    WHERE queue.id IS NULL OR queue.session_id!=event.session_id OR original.queue_id IS NULL
      OR original.session_id!=event.session_id OR original.reason!=event.reason OR original.recorded_at>event.recorded_at
      OR (event.ordinal=2 AND queue.state!='cancelled')
      OR (queue.state!='pending' AND NOT EXISTS(SELECT 1 FROM queue_attachment_quarantines abandoned WHERE abandoned.queue_id=queue.id AND abandoned.ordinal=2)
        AND queue.state NOT IN ('dispatching','ambiguous')) LIMIT 1`).get() !== null) return corrupt();
  let after = "";
  for (;;) {
    const rows = database.query(`SELECT id AS queue_id FROM queue_entries WHERE (enqueue_identity_format IS NOT NULL OR enqueue_identity_attempt_id IS NOT NULL) AND id>?
      UNION SELECT queue_id FROM queue_attachment_identities WHERE queue_id>?
      UNION SELECT queue_id FROM queue_attachment_identity_anchors WHERE queue_id>?
      UNION SELECT queue_id FROM queue_attachment_quarantines WHERE queue_id>?
      ORDER BY queue_id LIMIT 100`).all(after, after, after, after) as Array<{ queue_id: string }>;
    if (rows.length === 0) return;
    for (const row of rows) {
      readQueueAttachmentIdentity(database, row.queue_id);
      queueAttachmentQuarantineUnsettled(database, row.queue_id);
      if (database.query(`SELECT 1 FROM queue_entries queue WHERE id=? AND ${queueAttachmentsProtectedSql("queue")}
        AND NOT EXISTS(SELECT 1 FROM queue_attachment_quarantines quarantine WHERE quarantine.queue_id=queue.id)`).get(row.queue_id) !== null) {
        readVerifiedQueueAttachmentManifest(database, row.queue_id);
      }
      after = row.queue_id;
    }
  }
}
