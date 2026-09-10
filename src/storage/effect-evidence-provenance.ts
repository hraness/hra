import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { z } from "zod";

import { snapshotForeignJson } from "../domain/guards";
import { attemptIdSchema, queueIdSchema, sessionIdSchema } from "../domain/values";
import {
  decodeMutationEvidence, decodeQueueEvidence, historicalEffectEvidenceFormatSchema,
  type HistoricalEffectEvidenceFormat, type HistoricalMutationEvidence, type HistoricalQueueEvidence,
} from "./effect-evidence-reader";
import {
  joinedMutationEffectEvidenceSchema, joinedQueueEffectEvidenceSchema,
  type JoinedMutationEffectEvidence, type JoinedQueueEffectEvidence,
} from "./joined-effect-evidence-codecs";
import { normalizeSchemaSql, schemaCohortObjects } from "./schema-cohort";

export const EFFECT_EVIDENCE_PROVENANCE_MAX_RAW_BYTES = 262_144;
// This physical sidecar's admitted formats are frozen, even if the standalone
// historical reader later learns another dialect. Extensions need new DDL.
export const effectEvidenceProvenanceFormatSchema = z.enum([
  "canonical40_v1", "canonical41_v1", "canonical43_v1", "canonical49_v1",
  "canonical_sol43_v1",
  "private_task48_v1", "combined49_v1", "joined_v1",
]);
export type EffectEvidenceProvenanceFormat = z.infer<typeof effectEvidenceProvenanceFormatSchema>;
const reasonSchema = z.enum([
  "invalid_utf8", "invalid_json", "invalid_shape", "invalid_digest", "digest_mismatch",
  "kind_mismatch", "parent_mismatch", "noncanonical_json", "invalid_parent_metadata",
]);
export type EffectEvidenceOpaqueReason = z.infer<typeof reasonSchema>;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const safeInteger = z.number().int().nonnegative().safe();
const decimalSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const fail = (): never => { throw new Error("EFFECT_EVIDENCE_PROVENANCE_CORRUPT"); };
const limit = (): never => { throw new Error("EFFECT_EVIDENCE_PROVENANCE_LIMIT"); };
const protect = <Value>(operation: () => Value): Value => {
  try { return operation(); }
  catch (cause) {
    if (cause instanceof Error && cause.message === "EFFECT_EVIDENCE_PROVENANCE_LIMIT") return limit();
    return fail();
  }
};
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type Scope = "mutation" | "queue";
export const EFFECT_EVIDENCE_PROVENANCE_TABLES_BY_SCOPE = Object.freeze({
  mutation: Object.freeze({ evidence: "mutation_effect_evidence", provenance: "mutation_effect_evidence_provenance", anchor: "mutation_effect_evidence_provenance_anchors", id: "attempt_id" }),
  queue: Object.freeze({ evidence: "queue_effect_evidence", provenance: "queue_effect_evidence_provenance", anchor: "queue_effect_evidence_provenance_anchors", id: "queue_id" }),
});
const tables = EFFECT_EVIDENCE_PROVENANCE_TABLES_BY_SCOPE;
const scopes = ["mutation", "queue"] as const;
const metadataSchema = z.object({
  row_id: z.string().min(1).max(160),
  parent_kind: z.string().min(1).max(320),
  parent_authority_id: z.string().min(1).max(800),
  parent_authority_generation_decimal: decimalSchema.nullable(),
  evidence_kind: z.string().min(1).max(320),
  stored_digest: z.string().max(256),
  recorded_at_decimal: decimalSchema,
  raw_sha256: sha256Schema,
  raw_byte_length: safeInteger.max(EFFECT_EVIDENCE_PROVENANCE_MAX_RAW_BYTES),
}).strict();
type Metadata = z.infer<typeof metadataSchema>;
const provenanceSchema = metadataSchema.extend({
  format: effectEvidenceProvenanceFormatSchema,
  projection_json: z.string().max(EFFECT_EVIDENCE_PROVENANCE_MAX_RAW_BYTES).nullable(),
  opaque_reason: reasonSchema.nullable(),
  provenance_digest: sha256Schema,
}).strict();
type Provenance = z.infer<typeof provenanceSchema>;
type EvidenceValue = HistoricalMutationEvidence | HistoricalQueueEvidence | JoinedMutationEffectEvidence | JoinedQueueEffectEvidence;
export type EffectEvidenceProvenanceResult<Value> =
  | Readonly<{ kind: "opaque"; format: EffectEvidenceProvenanceFormat; reason: EffectEvidenceOpaqueReason }>
  | Readonly<{ kind: "parsed"; format: EffectEvidenceProvenanceFormat; evidence: Value; canonicalJson: string; digest: string; recordedAt: number }>;
type Classification<Value> = { projection: string | null; reason: EffectEvidenceOpaqueReason | null; value: Value | null };
const opaque = <Value>(reason: EffectEvidenceOpaqueReason): Classification<Value> => ({ projection: null, reason, value: null });

function freeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}
const metadataIsSafe = (scope: Scope, meta: Metadata): boolean =>
  BigInt(meta.recorded_at_decimal) <= BigInt(Number.MAX_SAFE_INTEGER)
  && (scope === "mutation"
    ? attemptIdSchema.safeParse(meta.row_id).success && meta.parent_authority_generation_decimal !== null
      && BigInt(meta.parent_authority_generation_decimal) <= BigInt(Number.MAX_SAFE_INTEGER)
      && meta.parent_authority_id.length <= 200 && meta.parent_kind.length <= 80 && meta.evidence_kind.length <= 80
    : queueIdSchema.safeParse(meta.row_id).success && sessionIdSchema.safeParse(meta.parent_authority_id).success
      && meta.parent_authority_generation_decimal === null && meta.parent_kind === "queue.dispatch");

function classify(scope: Scope, format: EffectEvidenceProvenanceFormat, meta: Metadata,
  bytes: Uint8Array): Classification<EvidenceValue> {
  if (!metadataIsSafe(scope, meta)) return opaque("invalid_parent_metadata");
  let json: string;
  try { json = utf8.decode(bytes); } catch { return opaque("invalid_utf8"); }
  let value: EvidenceValue;
  let canonicalJson: string;
  if (format === "joined_v1") {
    let foreign: unknown;
    try { foreign = JSON.parse(json) as unknown; } catch { return opaque("invalid_json"); }
    const parsed = scope === "mutation" ? joinedMutationEffectEvidenceSchema.safeParse(foreign)
      : joinedQueueEffectEvidenceSchema.safeParse(foreign);
    if (!parsed.success) return opaque("invalid_shape");
    value = parsed.data;
    canonicalJson = JSON.stringify(value);
  } else {
    const decoded = scope === "mutation" ? decodeMutationEvidence({ format, json }) : decodeQueueEvidence({ format, json });
    if (decoded.kind === "opaque") {
      if (decoded.reason === "invalid_json" || decoded.reason === "invalid_shape") return opaque(decoded.reason);
      return fail(); // format and the stricter raw byte ceiling were proved above.
    }
    value = decoded.value;
    canonicalJson = decoded.canonicalJson;
  }
  if (!sha256Schema.safeParse(meta.stored_digest).success) return opaque("invalid_digest");
  if (hash(canonicalJson) !== meta.stored_digest) return opaque("digest_mismatch");
  if (meta.evidence_kind !== value.kind || meta.parent_kind !== value.kind) return opaque("kind_mismatch");
  if (scope === "queue" && (value.kind !== "queue.dispatch" || value.queueId !== meta.row_id
    || value.sessionId !== meta.parent_authority_id)) return opaque("parent_mismatch");
  // No whitespace, duplicate keys, BOM, normalized field order or decoder
  // defaults become SQL authority. The original BLOB must be the canonical JSON.
  if (canonicalJson !== json || Buffer.byteLength(canonicalJson) !== meta.raw_byte_length
    || hash(canonicalJson) !== meta.raw_sha256) return opaque("noncanonical_json");
  return { projection: canonicalJson, reason: null, value: freeze(value) };
}

const provenanceDigest = (scope: Scope, meta: Metadata, format: EffectEvidenceProvenanceFormat,
  projection: string | null, reason: EffectEvidenceOpaqueReason | null): string => hash(JSON.stringify({
  domain: "oompa:effect-evidence-provenance:v1", scope, ...meta, format,
  projection_json: projection, opaque_reason: reason,
}));
const makeProvenance = (scope: Scope, meta: Metadata, format: EffectEvidenceProvenanceFormat,
  result: Classification<EvidenceValue>): Provenance => ({
  ...meta, format, projection_json: result.projection, opaque_reason: result.reason,
  provenance_digest: provenanceDigest(scope, meta, format, result.projection, result.reason),
});

const bounded = (expression: string, alias: string, maximum: number, blob = false): string =>
  `CASE WHEN length(CAST(${expression} AS BLOB))<=${maximum} THEN ${blob ? `CAST(${expression} AS BLOB)` : expression} ELSE NULL END AS ${alias}`;
const text = (value: unknown): string => {
  if (value === null) return limit();
  if (!(value instanceof Uint8Array)) return fail();
  try { return utf8.decode(value); } catch { return fail(); }
};
const parentFields = (scope: Scope): string => scope === "mutation"
  ? `${bounded("p.kind", "parent_kind", 320, true)},${bounded("p.authority_id", "parent_authority_id", 800, true)},
     CAST(p.authority_generation AS TEXT) AS parent_authority_generation_decimal`
  : `${bounded("'queue.dispatch'", "parent_kind", 320, true)},${bounded("p.session_id", "parent_authority_id", 800, true)},
     NULL AS parent_authority_generation_decimal`;
const parentTable = (scope: Scope): string => scope === "mutation" ? "mutation_attempts" : "queue_entries";
const readParent = (database: Database, scope: Scope, rowId: string) => {
  const raw = z.record(z.string(), z.unknown()).nullable().parse(database.query(
    `SELECT ${parentFields(scope)} FROM ${parentTable(scope)} p WHERE p.id=?`).get(rowId));
  if (raw === null) return fail();
  return {
    parent_kind: text(raw.parent_kind), parent_authority_id: text(raw.parent_authority_id),
    parent_authority_generation_decimal: decimalSchema.nullable().parse(raw.parent_authority_generation_decimal),
  };
};
const readSource = (database: Database, scope: Scope, rowId: string): { meta: Metadata; bytes: Uint8Array } => {
  const t = tables[scope];
  const raw = z.record(z.string(), z.unknown()).nullable().parse(database.query(`SELECT
    ${bounded(`e.${t.id}`, "row_id", 160, true)}, ${parentFields(scope)},
    p.id IS NOT NULL AS parent_present,
    ${bounded(scope === "mutation" ? "e.kind" : "'queue.dispatch'", "evidence_kind", 320, true)},
    ${bounded("e.evidence_digest", "stored_digest", 256, true)}, CAST(e.recorded_at AS TEXT) AS recorded_at_decimal,
    ${bounded("e.evidence_json", "raw_bytes", EFFECT_EVIDENCE_PROVENANCE_MAX_RAW_BYTES, true)}
    FROM ${t.evidence} e LEFT JOIN ${parentTable(scope)} p ON p.id=e.${t.id} WHERE e.${t.id}=?`).get(rowId));
  if (raw === null || raw.parent_present !== 1) return fail();
  if (raw.raw_bytes === null) return limit();
  if (!(raw.raw_bytes instanceof Uint8Array)) return fail();
  const bytes = raw.raw_bytes;
  const meta = metadataSchema.parse({
    row_id: text(raw.row_id), parent_kind: text(raw.parent_kind), parent_authority_id: text(raw.parent_authority_id),
    parent_authority_generation_decimal: raw.parent_authority_generation_decimal,
    evidence_kind: text(raw.evidence_kind), stored_digest: text(raw.stored_digest), recorded_at_decimal: raw.recorded_at_decimal,
    raw_sha256: hash(bytes), raw_byte_length: bytes.byteLength,
  });
  return { meta, bytes };
};

const decimalCheck = (column: string): string => `(${column}='0' OR (length(${column}) BETWEEN 1 AND 19
  AND substr(${column},1,1) BETWEEN '1' AND '9' AND ${column} NOT GLOB '*[^0-9]*'
  AND (length(${column})<19 OR ${column}<='9223372036854775807')))`;
export const EFFECT_EVIDENCE_PROVENANCE_TABLES = scopes.map((scope) => {
  const t = tables[scope];
  return `
CREATE TABLE ${t.provenance} (
  ${t.id} TEXT PRIMARY KEY REFERENCES ${t.evidence}(${t.id}) DEFERRABLE INITIALLY DEFERRED
    CHECK(length(CAST(${t.id} AS BLOB)) BETWEEN 1 AND 160),
  parent_kind TEXT NOT NULL CHECK(length(CAST(parent_kind AS BLOB)) BETWEEN 1 AND 320),
  parent_authority_id TEXT NOT NULL CHECK(length(CAST(parent_authority_id AS BLOB)) BETWEEN 1 AND 800),
  parent_authority_generation_decimal TEXT ${scope === "mutation" ? `NOT NULL CHECK(${decimalCheck("parent_authority_generation_decimal")})` : "CHECK(parent_authority_generation_decimal IS NULL)"},
  evidence_kind TEXT NOT NULL CHECK(length(CAST(evidence_kind AS BLOB)) BETWEEN 1 AND 320),
  stored_digest TEXT NOT NULL CHECK(length(CAST(stored_digest AS BLOB))<=256),
  recorded_at_decimal TEXT NOT NULL CHECK(${decimalCheck("recorded_at_decimal")}),
  raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'),
  raw_byte_length INTEGER NOT NULL CHECK(raw_byte_length BETWEEN 0 AND 262144),
  format TEXT NOT NULL CHECK(format IN (${effectEvidenceProvenanceFormatSchema.options.map((v) => `'${v}'`).join(",")})),
  projection_json TEXT CHECK(projection_json IS NULL OR (length(CAST(projection_json AS BLOB)) BETWEEN 2 AND 262144 AND json_valid(projection_json))),
  opaque_reason TEXT CHECK(opaque_reason IS NULL OR opaque_reason IN (${reasonSchema.options.map((v) => `'${v}'`).join(",")})),
  provenance_digest TEXT NOT NULL CHECK(length(provenance_digest)=64 AND provenance_digest NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(${t.id},provenance_digest),
  FOREIGN KEY(${t.id},provenance_digest) REFERENCES ${t.anchor}(${t.id},provenance_digest) DEFERRABLE INITIALLY DEFERRED,
  CHECK((projection_json IS NULL)=(opaque_reason IS NOT NULL))
) STRICT;
CREATE TABLE ${t.anchor} (
  ${t.id} TEXT PRIMARY KEY,
  provenance_digest TEXT NOT NULL,
  UNIQUE(${t.id},provenance_digest),
  FOREIGN KEY(${t.id},provenance_digest) REFERENCES ${t.provenance}(${t.id},provenance_digest) DEFERRABLE INITIALLY DEFERRED
) STRICT;
`;
}).join("\n");
const parentJoin = (scope: Scope, proof: string, parent: string): string => scope === "mutation"
  ? `${proof}.parent_kind IS ${parent}.kind AND ${proof}.parent_authority_id IS ${parent}.authority_id
     AND ${proof}.parent_authority_generation_decimal IS CAST(${parent}.authority_generation AS TEXT)`
  : `${proof}.parent_kind='queue.dispatch' AND ${proof}.parent_authority_id IS ${parent}.session_id
     AND ${proof}.parent_authority_generation_decimal IS NULL`;
export const EFFECT_EVIDENCE_PROVENANCE_GUARDS = scopes.map((scope) => {
  const t = tables[scope];
  return `
${[t.provenance, t.anchor].flatMap((table) => ["UPDATE", "DELETE"].map((verb) => `
CREATE TRIGGER ${table}_${verb.toLowerCase()}
BEFORE ${verb} ON ${table}
BEGIN SELECT RAISE(ABORT,'EFFECT_EVIDENCE_PROVENANCE_CORRUPT'); END;
`)).join("\n")}
CREATE TRIGGER ${t.provenance}_insert
BEFORE INSERT ON ${t.provenance}
WHEN NEW.format!='joined_v1' OR NEW.projection_json IS NULL OR NEW.opaque_reason IS NOT NULL
  OR EXISTS(SELECT 1 FROM ${t.evidence} WHERE ${t.id}=NEW.${t.id})
  OR NOT EXISTS(SELECT 1 FROM ${parentTable(scope)} p WHERE p.id=NEW.${t.id} AND ${parentJoin(scope, "NEW", "p")})
BEGIN SELECT RAISE(ABORT,'EFFECT_EVIDENCE_PROVENANCE_CORRUPT'); END;
CREATE TRIGGER ${t.provenance}_evidence_insert
BEFORE INSERT ON ${t.evidence}
WHEN NOT EXISTS(SELECT 1 FROM ${t.provenance} proof
  JOIN ${t.anchor} anchor ON anchor.${t.id}=proof.${t.id} AND anchor.provenance_digest=proof.provenance_digest
  JOIN ${parentTable(scope)} p ON p.id=proof.${t.id}
  WHERE proof.${t.id}=NEW.${t.id} AND proof.format='joined_v1'
    AND proof.opaque_reason IS NULL AND proof.projection_json IS NOT NULL
    AND CAST(proof.projection_json AS BLOB) IS CAST(NEW.evidence_json AS BLOB)
    AND proof.raw_byte_length=length(CAST(NEW.evidence_json AS BLOB))
    AND proof.stored_digest IS NEW.evidence_digest AND proof.recorded_at_decimal IS CAST(NEW.recorded_at AS TEXT)
    AND proof.evidence_kind IS ${scope === "mutation" ? "NEW.kind" : "'queue.dispatch'"}
    AND ${parentJoin(scope, "proof", "p")})
BEGIN SELECT RAISE(ABORT,'EFFECT_EVIDENCE_PROVENANCE_CORRUPT'); END;
`;
}).join("\n");
export const EFFECT_EVIDENCE_PROVENANCE_DDL = EFFECT_EVIDENCE_PROVENANCE_TABLES + EFFECT_EVIDENCE_PROVENANCE_GUARDS;

const insertProof = (database: Database, scope: Scope, proof: Provenance): void => {
  const t = tables[scope];
  database.query(`INSERT INTO ${t.provenance} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    proof.row_id, proof.parent_kind, proof.parent_authority_id, proof.parent_authority_generation_decimal,
    proof.evidence_kind, proof.stored_digest, proof.recorded_at_decimal, proof.raw_sha256, proof.raw_byte_length,
    proof.format, proof.projection_json, proof.opaque_reason, proof.provenance_digest,
  );
  database.query(`INSERT INTO ${t.anchor} VALUES(?,?)`).run(proof.row_id, proof.provenance_digest);
};

function read<Value extends EvidenceValue>(database: Database, scope: Scope, rowId: string): EffectEvidenceProvenanceResult<Value> {
  const operation = (): EffectEvidenceProvenanceResult<Value> => {
    const t = tables[scope];
    const columns = Object.keys(provenanceSchema.shape).map((key) => bounded(
      `proof.${key === "row_id" ? t.id : key}`, key,
      key === "projection_json" ? EFFECT_EVIDENCE_PROVENANCE_MAX_RAW_BYTES : key === "parent_authority_id" ? 800 : 320,
    )).join(",");
    const proof = provenanceSchema.safeParse(database.query(`SELECT ${columns} FROM ${t.provenance} proof
      JOIN ${t.anchor} a ON a.${t.id}=proof.${t.id} AND a.provenance_digest=proof.provenance_digest
      WHERE proof.${t.id}=?`).get(rowId));
    if (!proof.success) return fail();
    const source = readSource(database, scope, rowId);
    const classified = classify(scope, proof.data.format, source.meta, source.bytes);
    const expected = makeProvenance(scope, source.meta, proof.data.format, classified);
    if (JSON.stringify(proof.data) !== JSON.stringify(expected)) return fail();
    if (classified.reason !== null) return Object.freeze({ kind: "opaque", format: proof.data.format, reason: classified.reason });
    if (classified.value === null || classified.projection === null) return fail();
    // The two exported readers fix scope; classification selects that same codec.
    return Object.freeze({ kind: "parsed", format: proof.data.format, evidence: classified.value as Value,
      canonicalJson: classified.projection, digest: source.meta.stored_digest, recordedAt: Number(source.meta.recorded_at_decimal) });
  };
  if (typeof rowId !== "string" || Buffer.byteLength(rowId) > 160) return limit();
  return database.inTransaction ? operation() : database.transaction(operation).deferred();
}
export const readMutationEffectEvidenceProvenance = (database: Database, attemptId: string):
  EffectEvidenceProvenanceResult<HistoricalMutationEvidence | JoinedMutationEffectEvidence> => protect(() => read(database, "mutation", attemptId));
export const readQueueEffectEvidenceProvenance = (database: Database, queueId: string):
  EffectEvidenceProvenanceResult<HistoricalQueueEvidence | JoinedQueueEffectEvidence> => protect(() => read(database, "queue", queueId));

const requireTransaction = (database: Database): void => { if (!database.inTransaction) fail(); };
const walk = (database: Database, scope: Scope, visit: (rowId: string) => void): void => {
  const t = tables[scope];
  const total = z.object({ count: safeInteger }).strict().parse(database.query(`SELECT COUNT(*) AS count FROM ${t.evidence}`).get()).count;
  let after = "";
  let seen = 0;
  while (seen < total) {
    const page = database.query(`SELECT ${bounded(t.id, "row_id", 160, true)} FROM ${t.evidence}
      WHERE ${t.id}>? ORDER BY ${t.id} LIMIT 100`).all(after);
    if (page.length === 0 || seen + page.length > total) fail();
    for (const candidate of page) {
      const rowId = text(z.object({ row_id: z.unknown() }).strict().parse(candidate).row_id);
      if (Buffer.compare(Buffer.from(rowId), Buffer.from(after)) <= 0) fail();
      after = rowId;
      seen++;
      visit(rowId);
    }
  }
  if (database.query(`SELECT 1 FROM ${t.evidence} WHERE ${t.id}>? LIMIT 1`).get(after) !== null) fail();
};

/** Caller has already admitted one exact historical cohort and holds IMMEDIATE. */
export const applyEffectEvidenceProvenance = (database: Database, input: HistoricalEffectEvidenceFormat): void => protect(() => {
  requireTransaction(database);
  const format = historicalEffectEvidenceFormatSchema.parse(input);
  if (database.query("SELECT 1 FROM sqlite_master WHERE name GLOB '*effect_evidence_provenance*' LIMIT 1").get() !== null) fail();
  database.exec(EFFECT_EVIDENCE_PROVENANCE_TABLES);
  for (const scope of scopes) walk(database, scope, (rowId) => {
    const source = readSource(database, scope, rowId);
    insertProof(database, scope, makeProvenance(scope, source.meta, format, classify(scope, format, source.meta, source.bytes)));
  });
  database.exec(EFFECT_EVIDENCE_PROVENANCE_GUARDS);
});

export const assertEffectEvidenceProvenanceSchema = (database: Database): void => protect(() => {
  const objects = schemaCohortObjects(EFFECT_EVIDENCE_PROVENANCE_TABLES, EFFECT_EVIDENCE_PROVENANCE_GUARDS);
  const objectSchema = z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string() }).strict();
  for (const expected of objects) {
    const parsed = objectSchema.safeParse(database.query(`SELECT ${bounded("type", "type", 16)},
      ${bounded("name", "name", 256)},${bounded("tbl_name", "tbl_name", 256)},${bounded("sql", "sql", 65536)}
      FROM sqlite_master WHERE name=?`).get(expected.name));
    if (!parsed.success || parsed.data.type !== expected.type || parsed.data.tbl_name !== expected.tbl_name
      || normalizeSchemaSql(parsed.data.sql) !== normalizeSchemaSql(expected.sql)) fail();
  }
  const owned = Object.values(tables).flatMap((t) => [t.provenance, t.anchor]);
  const count = z.object({ count: safeInteger }).strict().parse(database.query(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE sql IS NOT NULL AND (name GLOB '*effect_evidence_provenance*' OR tbl_name IN (${owned.map((v) => `'${v}'`).join(",")}))`).get()).count;
  if (count !== objects.length) fail();
});
/** Fixed pages and initial counts; no durable-lifetime count limit or accumulated rows. */
export const auditEffectEvidenceProvenance = (database: Database): void => protect(() => {
  requireTransaction(database);
  assertEffectEvidenceProvenanceSchema(database);
  for (const scope of scopes) {
    walk(database, scope, (rowId) => { read(database, scope, rowId); });
    const t = tables[scope];
    for (const [table, other] of [[t.provenance, t.anchor], [t.anchor, t.provenance]]) {
      if (database.query(`SELECT 1 FROM ${table} p LEFT JOIN ${other} a ON a.${t.id}=p.${t.id} AND a.provenance_digest=p.provenance_digest
        LEFT JOIN ${t.evidence} e ON e.${t.id}=p.${t.id} WHERE a.${t.id} IS NULL OR e.${t.id} IS NULL LIMIT 1`).get() !== null) fail();
    }
  }
});

export type JoinedEffectEvidenceWriteResult<Value> = Readonly<{
  evidence: Value; canonicalJson: string; digest: string; recordedAt: number;
}>;
function write<Value extends JoinedMutationEffectEvidence | JoinedQueueEffectEvidence>(database: Database, scope: Scope,
  input: unknown, codec: z.ZodType<Value>): JoinedEffectEvidenceWriteResult<Value> {
  requireTransaction(database);
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return fail();
  const inputSchema = scope === "mutation"
    ? z.object({ attemptId: attemptIdSchema, evidence: z.unknown(), recordedAt: safeInteger }).strict()
    : z.object({ queueId: queueIdSchema, evidence: z.unknown(), recordedAt: safeInteger }).strict();
  const parsed = inputSchema.safeParse(snapshot.value);
  if (!parsed.success) return fail();
  const rowId = "attemptId" in parsed.data ? parsed.data.attemptId : parsed.data.queueId;
  const evidence = codec.safeParse(parsed.data.evidence);
  if (!evidence.success) return fail();
  const canonicalJson = JSON.stringify(evidence.data);
  const bytes = Buffer.from(canonicalJson);
  if (bytes.byteLength > EFFECT_EVIDENCE_PROVENANCE_MAX_RAW_BYTES) return limit();
  const digest = hash(bytes);
  const meta = metadataSchema.parse({ row_id: rowId, ...readParent(database, scope, rowId),
    evidence_kind: evidence.data.kind, stored_digest: digest, recorded_at_decimal: String(parsed.data.recordedAt),
    raw_sha256: digest, raw_byte_length: bytes.byteLength });
  const classified = classify(scope, "joined_v1", meta, bytes);
  if (classified.reason !== null || classified.projection !== canonicalJson) return fail();
  insertProof(database, scope, makeProvenance(scope, meta, "joined_v1", classified));
  const t = tables[scope];
  if (scope === "mutation") database.query(`INSERT INTO ${t.evidence}(${t.id},kind,evidence_json,evidence_digest,recorded_at) VALUES(?,?,?,?,?)`)
    .run(rowId, evidence.data.kind, canonicalJson, digest, parsed.data.recordedAt);
  else database.query(`INSERT INTO ${t.evidence}(${t.id},evidence_json,evidence_digest,recorded_at) VALUES(?,?,?,?)`)
    .run(rowId, canonicalJson, digest, parsed.data.recordedAt);
  return Object.freeze({ evidence: freeze(evidence.data), canonicalJson, digest, recordedAt: parsed.data.recordedAt });
}
export const insertJoinedMutationEffectEvidence = (database: Database, input: unknown):
  JoinedEffectEvidenceWriteResult<JoinedMutationEffectEvidence> => protect(() => write(database, "mutation", input, joinedMutationEffectEvidenceSchema));
export const insertJoinedQueueEffectEvidence = (database: Database, input: unknown):
  JoinedEffectEvidenceWriteResult<JoinedQueueEffectEvidence> => protect(() => write(database, "queue", input, joinedQueueEffectEvidenceSchema));
