import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { providerAccountAuthoritySchema } from "../domain/provider-accounts";
import { attemptIdSchema, sessionIdSchema, unixMillisecondsSchema } from "../domain/values";
import { effectEvidenceProvenanceFormatSchema, readMutationEffectEvidenceProvenance } from "./effect-evidence-provenance";
import { normalizeSchemaSql, schemaCohortObjects } from "./schema-cohort";

const failure = (): never => { throw new Error("ATTACHMENT_TERMINAL_ACKNOWLEDGMENT_INVALID"); };
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const safe = z.number().int().nonnegative().safe();
const sourceSchema = z.enum(["provider_thread_deleted", "provider_transport_lost"]);
const resolutionSchema = z.object({ source: sourceSchema }).strict();
const recordSchema = z.object({
  version: z.literal(1), action: z.literal("user_abandon_local_attachment_custody"),
  attemptId: attemptIdSchema, sessionId: sessionIdSchema, sessionRevision: safe.positive(),
  providerAuthority: providerAccountAuthoritySchema, requestDigest: sha256,
  effectFormat: effectEvidenceProvenanceFormatSchema, effectDigest: sha256, effectRecordedAt: safe,
  resolutionJson: z.string().max(80), resolutionDigest: sha256, resolutionCreatedAt: safe,
  custodyId: z.string().regex(/^custody_[0-9a-f]{32}$/u), custodyDigest: sha256,
  providerEffectRetried: z.literal(false), providerStateDeleted: z.literal(false), providerOutcomeKnown: z.literal(false),
  createdAt: unixMillisecondsSchema,
}).strict();
export type TerminalAttachmentAcknowledgment = z.infer<typeof recordSchema>;
const digestOf = (record: TerminalAttachmentAcknowledgment): string =>
  hash(`oompa:attachment-terminal-acknowledgment:v1\0${JSON.stringify(record)}`);
const table = "attachment_terminal_acknowledgments";
const anchor = "attachment_terminal_acknowledgment_anchors";
const json = (alias: string, field: string): string => `json_extract(${alias}.acknowledgment_json,'$.${field}')`;
const shape = (alias: string): string => {
  const value = `${alias}.acknowledgment_json`;
  const stringFields = ["action", "attemptId", "sessionId", "requestDigest", "effectFormat", "effectDigest", "resolutionJson", "resolutionDigest", "custodyId", "custodyDigest"];
  return `json_type(${value})='object' AND (SELECT count(*) FROM json_each(${value}))=19
    AND NOT EXISTS(SELECT 1 FROM json_each(${value}) WHERE key NOT IN (${Object.keys(recordSchema.shape).map((key) => `'${key}'`).join(",")}))
    AND json_type(${value},'$.version')='integer' AND ${json(alias, "version")}=1
    AND ${json(alias, "action")}='user_abandon_local_attachment_custody'
    AND ${stringFields.map((field) => `json_type(${value},'$.${field}')='text'`).join(" AND ")}
    AND ${["sessionRevision", "effectRecordedAt", "resolutionCreatedAt", "createdAt"].map((field) =>
      `(json_type(${value},'$.${field}')='integer' AND ${json(alias, field)} BETWEEN ${field === "sessionRevision" ? 1 : 0} AND 9007199254740991)`).join(" AND ")}
    AND ${["providerEffectRetried", "providerStateDeleted", "providerOutcomeKnown"].map((field) => `json_type(${value},'$.${field}')='false'`).join(" AND ")}
    AND json_type(${value},'$.providerAuthority')='object' AND (SELECT count(*) FROM json_each(${value},'$.providerAuthority'))=5
    AND NOT EXISTS(SELECT 1 FROM json_each(${value},'$.providerAuthority') WHERE key NOT IN ('providerAccountId','profileId','provider','bindingGeneration','processGeneration'))
    AND ${["providerAccountId", "profileId", "provider"].map((field) => `json_type(${value},'$.providerAuthority.${field}')='text'`).join(" AND ")}
    AND ${["bindingGeneration", "processGeneration"].map((field) => `(json_type(${value},'$.providerAuthority.${field}')='integer'
      AND ${json(alias, `providerAuthority.${field}`)} BETWEEN ${field === "bindingGeneration" ? 1 : 0} AND 9007199254740991)`).join(" AND ")}`;
};

// SQL proves immutable correspondence, never a user gesture or a SHA preimage.
// Typed readers recompute hashes; only the explicit session.abandon service
// branch may request this local acknowledgment. No provider action is licensed.
const correspondence = (alias: string, inserting: boolean): string => {
  const j = (field: string) => json(alias, field);
  return `(${shape(alias)}) AND EXISTS(SELECT 1 FROM mutation_attempts m
    JOIN sessions session ON session.id=m.authority_id
    JOIN mutation_provider_authorities primary_authority ON primary_authority.attempt_id=m.id AND primary_authority.role='primary'
    JOIN mutation_effect_evidence effect ON effect.attempt_id=m.id
    JOIN mutation_effect_evidence_provenance proof ON proof.attempt_id=m.id
    JOIN mutation_effect_evidence_provenance_anchors proof_anchor ON proof_anchor.attempt_id=m.id AND proof_anchor.provenance_digest=proof.provenance_digest
    JOIN mutation_resolutions resolution ON resolution.attempt_id=m.id
    JOIN attachment_custody_sets custody ON custody.id=m.attachment_custody_id
    JOIN attachment_custody_anchors custody_anchor ON custody_anchor.id=custody.id
    JOIN attachment_custody_dispositions owned ON owned.custody_id=custody.id AND owned.ordinal=1
    WHERE m.id=${alias}.attempt_id AND m.id=${j("attemptId")} AND m.authority_id=${j("sessionId")}
      AND m.kind IN ('session.send','session.steer') AND m.request_format IS NULL
      AND m.attachment_input_format='retained_v1' AND m.state IN ('effect_started','ambiguous')
      AND m.request_digest=${j("requestDigest")} AND session.state='terminal'
      AND session.revision${inserting ? "=" : ">="}${j("sessionRevision")}
      AND (SELECT count(*) FROM mutation_provider_authorities p WHERE p.attempt_id=m.id)=1
      AND primary_authority.provider_account_id=${j("providerAuthority.providerAccountId")}
      AND primary_authority.profile_id=${j("providerAuthority.profileId")}
      AND primary_authority.provider=${j("providerAuthority.provider")}
      AND primary_authority.binding_generation=${j("providerAuthority.bindingGeneration")}
      AND primary_authority.process_generation=${j("providerAuthority.processGeneration")}
      AND primary_authority.process_generation=m.authority_generation
      AND effect.kind=m.kind AND effect.evidence_digest=${j("effectDigest")} AND effect.recorded_at=${j("effectRecordedAt")}
      AND ${j("createdAt")}>=effect.recorded_at AND ${j("createdAt")}>=resolution.created_at
      AND proof.format=${j("effectFormat")} AND proof.opaque_reason IS NULL AND proof.projection_json IS NOT NULL
      AND CAST(proof.projection_json AS BLOB) IS CAST(effect.evidence_json AS BLOB)
      AND proof.parent_kind=m.kind AND proof.parent_authority_id=m.authority_id
      AND proof.parent_authority_generation_decimal=CAST(m.authority_generation AS TEXT)
      AND proof.evidence_kind=effect.kind AND proof.stored_digest=effect.evidence_digest
      AND proof.raw_sha256=effect.evidence_digest AND proof.raw_byte_length=length(CAST(effect.evidence_json AS BLOB))
      AND proof.recorded_at_decimal=CAST(effect.recorded_at AS TEXT)
      AND json_extract(proof.projection_json,'$.kind')=m.kind
      AND json_extract(proof.projection_json,'$.clientMessageId')=m.id
      AND resolution.resolution_kind='abandoned' AND resolution.receipt_json IS NULL
      AND CAST(resolution.evidence_json AS BLOB) IS CAST(${j("resolutionJson")} AS BLOB)
      AND resolution.created_at=${j("resolutionCreatedAt")}
      AND resolution.evidence_json IN ('{"source":"provider_thread_deleted"}','{"source":"provider_transport_lost"}')
      AND custody.id=${j("custodyId")} AND custody.digest=${j("custodyDigest")}
      AND m.attachment_input_digest=custody.digest AND custody.original_key=m.idempotency_key
      AND custody_anchor.kind='custody' AND custody_anchor.digest=custody.digest
      AND custody_anchor.original_key=m.idempotency_key AND CAST(custody_anchor.proof_json AS BLOB) IS CAST(custody.origin_json AS BLOB)
      AND owned.kind='mutation_owned' AND owned.attempt_id=m.id AND owned.original_key=m.idempotency_key
      AND json_extract(custody.origin_json,'$.input.kind')=m.kind
      AND json_extract(custody.origin_json,'$.input.sessionId')=m.authority_id
      AND json_extract(custody.origin_json,'$.input.idempotencyKey')=m.idempotency_key
      AND json_extract(custody.origin_json,'$.input.requestDigest')=m.request_digest
      AND json_extract(custody.origin_json,'$.input.referenceCount') BETWEEN 1 AND 8
      AND json_extract(custody.origin_json,'$.input.authority.providerAccountId')=primary_authority.provider_account_id
      AND json_extract(custody.origin_json,'$.input.authority.profileId')=primary_authority.profile_id
      AND json_extract(custody.origin_json,'$.input.authority.provider')=primary_authority.provider
      AND json_extract(custody.origin_json,'$.input.authority.bindingGeneration')=primary_authority.binding_generation
      AND json_extract(custody.origin_json,'$.input.authority.processGeneration')=primary_authority.process_generation
      ${inserting ? `AND m.attachment_cleanup_terminal_digest IS NULL AND custody.released_by IS NULL AND custody_anchor.released_by IS NULL
        AND EXISTS(SELECT 1 FROM attachment_custody_slots slot WHERE slot.custody_id=custody.id AND slot.digest=custody.digest)` : ""})`;
};
export const TERMINAL_ATTACHMENT_ACKNOWLEDGMENT_SCHEMA_SQL = `
CREATE TABLE attachment_terminal_acknowledgments(
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  acknowledgment_json TEXT NOT NULL CHECK(json_valid(acknowledgment_json) AND length(CAST(acknowledgment_json AS BLOB)) BETWEEN 2 AND 4096),
  acknowledgment_digest TEXT NOT NULL CHECK(length(acknowledgment_digest)=64 AND acknowledgment_digest NOT GLOB '*[^a-f0-9]*'),
  UNIQUE(attempt_id,acknowledgment_digest),
  FOREIGN KEY(attempt_id,acknowledgment_digest) REFERENCES attachment_terminal_acknowledgment_anchors(attempt_id,acknowledgment_digest) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE attachment_terminal_acknowledgment_anchors(
  attempt_id TEXT PRIMARY KEY REFERENCES mutation_attempts(id),
  acknowledgment_json TEXT NOT NULL CHECK(json_valid(acknowledgment_json) AND length(CAST(acknowledgment_json AS BLOB)) BETWEEN 2 AND 4096),
  acknowledgment_digest TEXT NOT NULL CHECK(length(acknowledgment_digest)=64 AND acknowledgment_digest NOT GLOB '*[^a-f0-9]*'),
  UNIQUE(attempt_id,acknowledgment_digest),
  FOREIGN KEY(attempt_id,acknowledgment_digest) REFERENCES attachment_terminal_acknowledgments(attempt_id,acknowledgment_digest) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX attachment_terminal_acknowledgments_session ON attachment_terminal_acknowledgments(json_extract(acknowledgment_json,'$.sessionId'),attempt_id);
CREATE INDEX attachment_terminal_acknowledgment_anchors_session ON attachment_terminal_acknowledgment_anchors(json_extract(acknowledgment_json,'$.sessionId'),attempt_id);
CREATE INDEX attachment_terminal_acknowledgments_unknown_session ON mutation_attempts(authority_id,id)
  WHERE kind IN ('session.send','session.steer') AND attachment_input_format IS NULL AND attachment_cleanup_terminal_digest IS NULL;
${[table, anchor].map((name) => `CREATE TRIGGER ${name}_immutable BEFORE UPDATE ON ${name} BEGIN SELECT RAISE(ABORT,'ATTACHMENT_TERMINAL_ACKNOWLEDGMENT_INVALID'); END;
CREATE TRIGGER ${name}_permanent BEFORE DELETE ON ${name} BEGIN SELECT RAISE(ABORT,'ATTACHMENT_TERMINAL_ACKNOWLEDGMENT_INVALID'); END;`).join("\n")}
CREATE TRIGGER attachment_terminal_acknowledgments_insert_guard BEFORE INSERT ON attachment_terminal_acknowledgments
WHEN (${correspondence("NEW", true)}) IS NOT 1
BEGIN SELECT RAISE(ABORT,'ATTACHMENT_TERMINAL_ACKNOWLEDGMENT_INVALID'); END;
CREATE TRIGGER attachment_terminal_acknowledgment_anchors_insert_guard BEFORE INSERT ON attachment_terminal_acknowledgment_anchors
WHEN NOT EXISTS(SELECT 1 FROM attachment_terminal_acknowledgments acknowledgment WHERE acknowledgment.attempt_id=NEW.attempt_id
  AND acknowledgment.acknowledgment_digest=NEW.acknowledgment_digest AND acknowledgment.acknowledgment_json=NEW.acknowledgment_json)
BEGIN SELECT RAISE(ABORT,'ATTACHMENT_TERMINAL_ACKNOWLEDGMENT_INVALID'); END;
`;
const objects = schemaCohortObjects(TERMINAL_ATTACHMENT_ACKNOWLEDGMENT_SCHEMA_SQL);
const boundary = <T>(read: () => T): T => { try { return read(); } catch { return failure(); } };
export function assertTerminalAttachmentAcknowledgmentSchema(db: Database): void {
  boundary(() => {
    for (const object of objects) {
      const count = db.query<{ n: number }, [string, string]>(`SELECT count(*) AS n FROM (
        SELECT 1 FROM sqlite_master WHERE name=? COLLATE NOCASE UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE)`).get(object.name, object.name);
      if (count?.n !== 1) return failure();
      const actual = z.object({ type: z.string().max(16), name: z.string().max(128), tbl_name: z.string().max(128), sql: z.string().max(131072) }).strict().parse(
        db.query(`SELECT type,name,CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name END AS tbl_name,
          CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql FROM sqlite_master WHERE name=? COLLATE NOCASE`).get(object.name));
      if (actual.type !== object.type || actual.name !== object.name || actual.tbl_name !== object.tbl_name
        || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(object.sql)) failure();
    }
  });
}
export function applyTerminalAttachmentAcknowledgments(db: Database): void {
  boundary(() => {
    if (!db.inTransaction) return failure();
    for (const object of objects) if (db.query(`SELECT 1 FROM sqlite_master WHERE name=? COLLATE NOCASE
      UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE LIMIT 1`).get(object.name, object.name) !== null) failure();
    db.exec(TERMINAL_ATTACHMENT_ACKNOWLEDGMENT_SCHEMA_SQL);
    assertTerminalAttachmentAcknowledgmentSchema(db);
  });
}

// The caller separately validates the full custody graph. This leaf binds its
// immutable origin bytes and original selected effect, not provider liveness.
const boundedText = (column: string, maximum: number, alias: string): string =>
  `CASE WHEN length(CAST(${column} AS BLOB))<=${maximum} THEN ${column} END AS ${alias}`;
function facts(db: Database, attemptId: string) {
  const row = z.object({ id: attemptIdSchema, kind: z.enum(["session.send", "session.steer"]), authority_id: sessionIdSchema,
    authority_generation: safe, request_digest: sha256, state: z.enum(["effect_started", "ambiguous"]),
    request_format_is_null: z.literal(1), attachment_input_format: z.literal("retained_v1"),
    attachment_custody_id: recordSchema.shape.custodyId, attachment_input_digest: sha256,
    session_state: z.literal("terminal"), session_revision: safe.positive(),
    provider_account_id: z.string(), profile_id: z.string(), provider: z.string(), binding_generation: safe, process_generation: safe,
    resolution_kind: z.literal("abandoned"), receipt_is_null: z.literal(1), resolution_bytes: z.instanceof(Uint8Array), resolution_created_at: safe,
    origin_bytes: z.instanceof(Uint8Array),
  }).strict().parse(db.query(`SELECT ${boundedText("m.id", 64, "id")},${boundedText("m.kind", 80, "kind")},
    ${boundedText("m.authority_id", 64, "authority_id")},m.authority_generation,${boundedText("m.request_digest", 64, "request_digest")},
    ${boundedText("m.state", 32, "state")},m.request_format IS NULL AS request_format_is_null,${boundedText("m.attachment_input_format", 32, "attachment_input_format")},
    ${boundedText("m.attachment_custody_id", 64, "attachment_custody_id")},${boundedText("m.attachment_input_digest", 64, "attachment_input_digest")},
    ${boundedText("s.state", 32, "session_state")},s.revision AS session_revision,
    ${boundedText("p.provider_account_id", 64, "provider_account_id")},${boundedText("p.profile_id", 64, "profile_id")},
    ${boundedText("p.provider", 16, "provider")},p.binding_generation,p.process_generation,
    ${boundedText("r.resolution_kind", 32, "resolution_kind")},r.receipt_json IS NULL AS receipt_is_null,r.created_at AS resolution_created_at,
    CASE WHEN length(CAST(r.evidence_json AS BLOB))<=80 THEN CAST(r.evidence_json AS BLOB) END AS resolution_bytes,
    CASE WHEN length(CAST(c.origin_json AS BLOB))<=16384 THEN CAST(c.origin_json AS BLOB) END AS origin_bytes
    FROM mutation_attempts m JOIN sessions s ON s.id=m.authority_id
    JOIN mutation_provider_authorities p ON p.attempt_id=m.id AND p.role='primary'
    JOIN mutation_resolutions r ON r.attempt_id=m.id JOIN attachment_custody_sets c ON c.id=m.attachment_custody_id WHERE m.id=?`).get(attemptId));
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const resolutionJson = decoder.decode(row.resolution_bytes);
  const resolution = resolutionSchema.parse(JSON.parse(resolutionJson) as unknown);
  if (JSON.stringify(resolution) !== resolutionJson) return failure();
  const originJson = decoder.decode(row.origin_bytes);
  const origin = JSON.parse(originJson) as unknown;
  if (JSON.stringify(origin) !== originJson || hash(JSON.stringify({ domain: "oompa:attachment-custody:v1", value: origin })) !== row.attachment_input_digest) return failure();
  const effect = readMutationEffectEvidenceProvenance(db, attemptId);
  if (effect.kind !== "parsed" || effect.evidence.kind !== row.kind || effect.evidence.clientMessageId !== row.id
    || hash(effect.canonicalJson) !== effect.digest) return failure();
  const providerAuthority = providerAccountAuthoritySchema.parse({ providerAccountId: row.provider_account_id,
    profileId: row.profile_id, provider: row.provider, bindingGeneration: row.binding_generation, processGeneration: row.process_generation });
  if (providerAuthority.processGeneration !== row.authority_generation) return failure();
  return { attemptId: row.id, sessionId: row.authority_id, sessionRevision: row.session_revision, providerAuthority,
    requestDigest: row.request_digest, effectFormat: effect.format, effectDigest: effect.digest, effectRecordedAt: effect.recordedAt,
    resolutionJson, resolutionDigest: hash(resolutionJson), resolutionCreatedAt: row.resolution_created_at,
    custodyId: row.attachment_custody_id, custodyDigest: row.attachment_input_digest };
}
export function readTerminalAttachmentAcknowledgment(db: Database, input: string): Readonly<{ record: TerminalAttachmentAcknowledgment; digest: string }> | null {
  return boundary(() => {
    const attemptId = attemptIdSchema.parse(input);
    const rows = [table, anchor].map((name) => db.query(`SELECT ${boundedText("acknowledgment_digest", 64, "acknowledgment_digest")},
      CASE WHEN length(CAST(acknowledgment_json AS BLOB))<=4096 THEN CAST(acknowledgment_json AS BLOB) END AS bytes
      FROM ${name} WHERE attempt_id=?`).get(attemptId));
    if (rows[0] === null && rows[1] === null) return null;
    const parsed = rows.map((row) => z.object({ acknowledgment_digest: sha256, bytes: z.instanceof(Uint8Array) }).strict().parse(row));
    const value = parsed[0];
    const proof = parsed[1];
    if (value === undefined || proof === undefined || value.acknowledgment_digest !== proof.acknowledgment_digest
      || !Buffer.from(value.bytes).equals(proof.bytes)) return failure();
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value.bytes);
    const record = recordSchema.parse(JSON.parse(raw) as unknown);
    if (record.attemptId !== attemptId || JSON.stringify(record) !== raw || digestOf(record) !== value.acknowledgment_digest
      || record.createdAt < record.effectRecordedAt || record.createdAt < record.resolutionCreatedAt) return failure();
    const actual = facts(db, attemptId);
    if (actual.sessionRevision < record.sessionRevision || JSON.stringify({ ...actual, sessionRevision: record.sessionRevision }) !== JSON.stringify({
      attemptId: record.attemptId, sessionId: record.sessionId, sessionRevision: record.sessionRevision,
      providerAuthority: record.providerAuthority, requestDigest: record.requestDigest, effectFormat: record.effectFormat,
      effectDigest: record.effectDigest, effectRecordedAt: record.effectRecordedAt, resolutionJson: record.resolutionJson,
      resolutionDigest: record.resolutionDigest, resolutionCreatedAt: record.resolutionCreatedAt,
      custodyId: record.custodyId, custodyDigest: record.custodyDigest })) return failure();
    if (db.query(`SELECT 1 FROM ${table} acknowledgment WHERE acknowledgment.attempt_id=? AND ${correspondence("acknowledgment", false)}`).get(attemptId) === null) return failure();
    Object.freeze(record.providerAuthority);
    return Object.freeze({ record: Object.freeze(record), digest: value.acknowledgment_digest });
  });
}
export function insertTerminalAttachmentAcknowledgment(db: Database, input: Readonly<{
  attemptId: string; sessionId: string; expectedRevision: number; createdAt: number;
}>): Readonly<{ record: TerminalAttachmentAcknowledgment; digest: string }> {
  return boundary(() => {
    if (!db.inTransaction) return failure();
    const parsed = z.object({ attemptId: attemptIdSchema, sessionId: sessionIdSchema, expectedRevision: safe.positive(), createdAt: unixMillisecondsSchema }).strict().parse(input);
    if (readTerminalAttachmentAcknowledgment(db, parsed.attemptId) !== null) return failure();
    const actual = facts(db, parsed.attemptId);
    if (actual.sessionId !== parsed.sessionId || actual.sessionRevision !== parsed.expectedRevision) return failure();
    if (parsed.createdAt < actual.effectRecordedAt || parsed.createdAt < actual.resolutionCreatedAt) return failure();
    const record = recordSchema.parse({ version: 1, action: "user_abandon_local_attachment_custody", ...actual,
      providerEffectRetried: false, providerStateDeleted: false, providerOutcomeKnown: false, createdAt: parsed.createdAt });
    const raw = JSON.stringify(record), digest = digestOf(record);
    for (const name of [table, anchor]) db.query(`INSERT INTO ${name}(attempt_id,acknowledgment_json,acknowledgment_digest) VALUES(?,?,?)`).run(record.attemptId, raw, digest);
    return readTerminalAttachmentAcknowledgment(db, record.attemptId) ?? failure();
  });
}
export function auditTerminalAttachmentAcknowledgments(db: Database): void {
  boundary(() => {
    if (!db.inTransaction) return failure();
    assertTerminalAttachmentAcknowledgmentSchema(db);
    const union = `SELECT attempt_id FROM ${table} UNION SELECT attempt_id FROM ${anchor}`;
    const count = z.object({ n: safe }).strict().parse(db.query(`SELECT count(*) AS n FROM (${union})`).get()).n;
    let cursor = "", visited = 0;
    while (visited < count) {
      const rows = z.object({ attempt_id: attemptIdSchema }).strict().array().parse(db.query(
        `SELECT CASE WHEN length(CAST(attempt_id AS BLOB))<=64 THEN attempt_id END AS attempt_id FROM (${union}) WHERE attempt_id>? ORDER BY attempt_id LIMIT 100`).all(cursor));
      if (rows.length === 0) return failure();
      for (const row of rows) {
        if (row.attempt_id <= cursor || readTerminalAttachmentAcknowledgment(db, row.attempt_id) === null) return failure();
        cursor = row.attempt_id;
        visited++;
      }
    }
    if (visited !== count) failure();
  });
}

/** One terminal session can acknowledge only the at-most64 pins live at its
 * terminal boundary; it cannot admit another effect afterward. Include both
 * indexed sides so a missing primary or anchor cannot disappear on replay. */
export function readTerminalAttachmentAcknowledgmentsForSession(db: Database, input: string): readonly Readonly<{ record: TerminalAttachmentAcknowledgment; digest: string }>[] {
  return boundary(() => {
    const sessionId = sessionIdSchema.parse(input);
    const ids = new Set<string>();
    for (const name of [table, anchor]) {
      const rows = z.object({ attempt_id: attemptIdSchema }).strict().array().parse(db.query(
        `SELECT CASE WHEN length(CAST(attempt_id AS BLOB))<=64 THEN attempt_id END AS attempt_id
         FROM ${name} WHERE json_extract(acknowledgment_json,'$.sessionId')=? ORDER BY attempt_id LIMIT 65`).all(sessionId));
      for (const row of rows) ids.add(row.attempt_id);
    }
    if (ids.size > 64) return failure();
    return [...ids].sort().map((id) => {
      const record = readTerminalAttachmentAcknowledgment(db, id);
      if (record === null || record.record.sessionId !== sessionId) return failure();
      return record;
    });
  });
}

export function terminalAttachmentAcknowledgmentSql(parent: string): string {
  return `EXISTS(SELECT 1 FROM ${table} acknowledgment JOIN ${anchor} acknowledgment_anchor
    ON acknowledgment_anchor.attempt_id=acknowledgment.attempt_id
      AND acknowledgment_anchor.acknowledgment_digest=acknowledgment.acknowledgment_digest
      AND acknowledgment_anchor.acknowledgment_json=acknowledgment.acknowledgment_json
    WHERE acknowledgment.attempt_id=${parent}.id AND ${correspondence("acknowledgment", false)})`;
}
