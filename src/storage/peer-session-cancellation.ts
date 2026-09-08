import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { z } from "zod";

import { normalizeSchemaSql } from "./schema-cohort";

export const PEER_SESSION_CANCELLATION_KIND = "peer.session.cancel";
const fail = (): never => { throw new Error("PEER_SESSION_CANCELLATION_UNPROVEN"); };
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const session = z.string().regex(/^sess_[a-f0-9]{32}$/u);
const time = z.number().int().nonnegative().safe();
const receiptSchema = z.object({
  version: z.literal(1),
  peerActionId: z.string().regex(/^peer_[a-f0-9]{32}$/u),
  idempotencyKey: z.string().uuid(),
  actorSessionId: session,
  actorTurnDigest: digest,
  projectId: z.string().regex(/^proj_[a-f0-9]{32}$/u),
  targetSessionId: session,
  targetExpectedRevision: z.number().int().positive().safe(),
  delivery: z.enum(["send", "steer"]),
  requestDigest: digest,
  messageDigest: digest,
  reasonDigest: digest,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u),
  providerEffectStarted: z.literal(false),
}).strict().refine((value) => value.actorSessionId !== value.targetSessionId);
export type PeerSessionCancellationReceipt = Readonly<z.infer<typeof receiptSchema>>;
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function parsePeerSessionCancellationReceipt(input: unknown): PeerSessionCancellationReceipt {
  const parsed = receiptSchema.safeParse(input);
  if (!parsed.success) return fail();
  return Object.freeze(parsed.data);
}

const fields = [
  ["peerActionId", "id", "action_id"],
  ["idempotencyKey", "idempotency_key", "idempotency_key"],
  ["actorSessionId", "actor_session_id", "actor_session_id"],
  ["actorTurnDigest", "actor_turn_digest", "actor_turn_digest"],
  ["projectId", "project_id", "project_id"],
  ["targetSessionId", "target_session_id", "target_session_id"],
  ["targetExpectedRevision", "target_expected_revision", "target_expected_revision"],
  ["delivery", "delivery", "delivery"],
  ["requestDigest", "request_digest", "request_digest"],
  ["messageDigest", "message_digest", "message_digest"],
  ["reasonDigest", "reason_digest", "reason_digest"],
] as const;
const matches = (json: string, alias: string, kind: "action" | "source"): string => fields.map(
  ([key, action, source]) => `json_extract(${json},'$.${key}') IS ${alias}.${kind === "action" ? action : source}`,
).join(" AND ");

// All correspondence is against retained control-plane identities. Generation
// zero is a constant for this kind, never a provider or admission-time tuple.
const validRow = (row: string): string => `(
  ${row}.kind='${PEER_SESSION_CANCELLATION_KIND}' AND ${row}.state='cancelled'
  AND ${row}.authority_generation=0 AND ${row}.created_at=${row}.updated_at
  AND ${row}.created_at BETWEEN 0 AND 9007199254740991
  AND ${row}.request_format IS NULL AND ${row}.attachment_input_format IS NULL
  AND ${row}.attachment_input_digest IS NULL AND ${row}.attachment_custody_id IS NULL
  AND ${row}.attachment_cleanup_terminal_digest IS NULL
  AND ${row}.transcript_status='none' AND ${row}.transcript_finalized=0 AND ${row}.transcript_intent_json IS NULL
  AND CASE WHEN length(CAST(${row}.result_json AS BLOB))<=4096 AND json_valid(${row}.result_json) THEN
    json_type(${row}.result_json)='object' AND json_extract(${row}.result_json,'$.version')=1
    AND json_type(${row}.result_json,'$.version')='integer'
    AND json_type(${row}.result_json,'$.providerEffectStarted')='false'
    AND json_extract(${row}.result_json,'$.idempotencyKey')=${row}.idempotency_key
    AND json_extract(${row}.result_json,'$.targetSessionId')=${row}.authority_id
    AND json_type(${row}.result_json,'$.code')='text'
    AND length(json_extract(${row}.result_json,'$.code')) BETWEEN 1 AND 80
    AND json_extract(${row}.result_json,'$.code') GLOB '[A-Z]*'
    AND json_extract(${row}.result_json,'$.code') NOT GLOB '*[^A-Z0-9_]*'
    AND ${row}.result_json=json_object('version',1,
      ${fields.map(([key]) => `'${key}',json_extract(${row}.result_json,'$.${key}')`).join(",")},
      'code',json_extract(${row}.result_json,'$.code'),'providerEffectStarted',json('false'))
  ELSE 0 END
)`;

const artifacts = [
  ["mutation_effect_evidence", "attempt_id", null],
  ["mutation_resolutions", "attempt_id", null],
  ["mutation_provider_authorities", "attempt_id", null],
  ["session_send_owners", "attempt_id", "original_key"],
  ["session_send_execution_claims", "attempt_id", "original_key"],
  ["session_send_owner_outcomes", "attempt_id", "original_key"],
  ["session_send_owner_anchors", "attempt_id", "original_key"],
  ["attachment_custody_sets", null, "original_key"],
  ["attachment_custody_anchors", "attempt_id", "original_key"],
  ["attachment_custody_dispositions", "attempt_id", "original_key"],
  ["attachment_legacy_cleanup_blockers", "attempt_id", "original_key"],
  ["queue_attachment_identities", "attempt_id", "original_key"],
  ["queue_attachment_identity_anchors", "attempt_id", "original_key"],
] as const;
const artifactMatch = (row: string, alias: string, id: string | null, key: string | null): string =>
  `(${[id === null ? null : `${alias}.${id}=${row}.id`, key === null ? null : `${alias}.${key}=${row}.idempotency_key`]
    .filter((value) => value !== null).join(" OR ")})`;
const absent = (row: string): string => artifacts.map(([table, id, key]) =>
  `NOT EXISTS(SELECT 1 FROM ${table} artifact WHERE ${artifactMatch(row, "artifact", id, key)})`).join(" AND ");

const guards = [
  { name: "peer_session_cancellation_insert", table: "mutation_attempts", sql: `CREATE TRIGGER peer_session_cancellation_insert
    BEFORE INSERT ON mutation_attempts WHEN NEW.kind='${PEER_SESSION_CANCELLATION_KIND}' AND (
      ${validRow("NEW")} AND ${absent("NEW")}
      AND EXISTS(SELECT 1 FROM peer_session_actions action JOIN peer_session_direct_message_sources source
        ON source.action_id=action.id WHERE action.state IN ('prepared','effect_started','ambiguous')
        AND action.target_turn_digest IS NULL AND action.result_digest IS NULL
        AND NEW.created_at>=action.updated_at AND ${matches("NEW.result_json", "action", "action")}
        AND ${matches("NEW.result_json", "source", "source")})
    ) IS NOT 1 BEGIN SELECT RAISE(ABORT,'PEER_SESSION_CANCELLATION_UNPROVEN'); END;` },
  { name: "peer_session_cancellation_update", table: "mutation_attempts", sql: `CREATE TRIGGER peer_session_cancellation_update
    BEFORE UPDATE ON mutation_attempts WHEN OLD.kind='${PEER_SESSION_CANCELLATION_KIND}' OR NEW.kind='${PEER_SESSION_CANCELLATION_KIND}'
    BEGIN SELECT RAISE(ABORT,'PEER_SESSION_CANCELLATION_IMMUTABLE'); END;` },
  { name: "peer_session_cancellation_delete", table: "mutation_attempts", sql: `CREATE TRIGGER peer_session_cancellation_delete
    BEFORE DELETE ON mutation_attempts WHEN OLD.kind='${PEER_SESSION_CANCELLATION_KIND}'
    BEGIN SELECT RAISE(ABORT,'PEER_SESSION_CANCELLATION_IMMUTABLE'); END;` },
  ...artifacts.map(([table, id, key]) => ({ name: `peer_session_cancellation_${table}`, table,
    sql: `CREATE TRIGGER peer_session_cancellation_${table} BEFORE INSERT ON ${table}
      WHEN EXISTS(SELECT 1 FROM mutation_attempts cancellation WHERE cancellation.kind='${PEER_SESSION_CANCELLATION_KIND}'
        AND ${artifactMatch("cancellation", "NEW", id, key)})
      BEGIN SELECT RAISE(ABORT,'PEER_SESSION_CANCELLATION_NO_EFFECT'); END;` })),
] as const;

/** Preserve the entire frozen delete predicate as one alternative. The new
 * alternative requires this distinct terminal kind, never a made-up send. */
export const peerSessionCancellationSourceDeleteSql = (source: "OLD"): string => `EXISTS(
  SELECT 1 FROM mutation_attempts cancellation WHERE ${validRow("cancellation")}
    AND ${matches("cancellation.result_json", source, "source")} AND ${absent("cancellation")})`;

export function joinedPeerSessionSourceDeleteGuardSql(predecessor: string): string {
  const marker = "\nBEGIN SELECT RAISE(ABORT, 'peer session direct message source is required'); END;";
  if (predecessor.split(marker).length !== 2) return fail();
  return predecessor.replace(marker, ` AND NOT ${peerSessionCancellationSourceDeleteSql("OLD")}${marker}`);
}

const sourceGuardName = "peer_session_direct_message_source_delete_guard";
const schemaObjects = (predecessor: string) => [...guards, { name: sourceGuardName,
  table: "peer_session_direct_message_sources", sql: joinedPeerSessionSourceDeleteGuardSql(predecessor) }];
const observed = (db: Database, name: string) => {
  const count = z.object({ n: z.number().int().min(0).max(1) }).strict().safeParse(db.query(`
    SELECT count(*) AS n FROM (SELECT 1 FROM sqlite_master WHERE name=? COLLATE NOCASE
      UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE)`).get(name, name));
  if (!count.success) return fail();
  return z.object({ type: z.literal("trigger"), name: z.literal(name),
    tbl_name: z.string().max(128), sql: z.string().max(65_536) }).strict().array().parse(db.query(`
    SELECT type,name,CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name ELSE NULL END AS tbl_name,
      CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql ELSE NULL END AS sql
    FROM sqlite_master WHERE name=? COLLATE NOCASE UNION ALL
    SELECT type,name,CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name ELSE NULL END AS tbl_name,
      CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql ELSE NULL END AS sql
    FROM sqlite_temp_master WHERE name=? COLLATE NOCASE LIMIT 2`).all(name, name));
};

export function assertPeerSessionCancellationSchema(db: Database, predecessor: string): void {
  for (const object of schemaObjects(predecessor)) {
    const rows = observed(db, object.name);
    if (rows.length !== 1 || rows[0]?.tbl_name !== object.table
      || normalizeSchemaSql(rows[0].sql) !== normalizeSchemaSql(object.sql)) fail();
  }
}

export function applyPeerSessionCancellationSchema(db: Database, predecessor: string): void {
  if (!db.inTransaction) fail();
  for (const object of schemaObjects(predecessor)) {
    const rows = observed(db, object.name);
    if (rows.length === 1 && rows[0]?.tbl_name === object.table
      && normalizeSchemaSql(rows[0].sql) === normalizeSchemaSql(object.sql)) continue;
    if (object.name === sourceGuardName) {
      if (rows.length !== 1 || rows[0]?.tbl_name !== object.table
        || normalizeSchemaSql(rows[0].sql) !== normalizeSchemaSql(predecessor)) fail();
      db.exec(`DROP TRIGGER ${sourceGuardName}`);
    } else if (rows.length !== 0) fail();
    db.exec(object.sql);
  }
  assertPeerSessionCancellationSchema(db, predecessor);
}

export function insertPeerSessionCancellation(db: Database, input: Readonly<{
  attemptId: string; receipt: PeerSessionCancellationReceipt; recordedAt: number;
}>): void {
  if (!db.inTransaction) fail();
  const id = z.string().regex(/^attempt_[a-f0-9]{32}$/u).parse(input.attemptId);
  const receipt = parsePeerSessionCancellationReceipt(input.receipt);
  const json = JSON.stringify(receipt);
  const now = time.parse(input.recordedAt);
  db.query(`INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,
    request_digest,state,result_json,created_at,updated_at) VALUES(?,?,?, ?,0,?,'cancelled',?,?,?)`)
    .run(id, receipt.idempotencyKey, PEER_SESSION_CANCELLATION_KIND, receipt.targetSessionId, hash(json), json, now, now);
}

/** Works after the causal action is compacted: immutable canonical receipt and
 * global key remain. Present action/source rows must still agree exactly. */
export function readPeerSessionCancellation(db: Database, key: string): PeerSessionCancellationReceipt | null {
  const read = () => {
    const row = z.object({ id: z.string().regex(/^attempt_[a-f0-9]{32}$/u), kind: z.literal(PEER_SESSION_CANCELLATION_KIND), request_digest: digest,
      result_json: z.string().max(4096), valid: z.literal(1), absent: z.literal(1),
    }).strict().nullable().safeParse(db.query(`SELECT CASE WHEN length(CAST(id AS BLOB))=40 THEN id ELSE NULL END AS id,
      kind,CASE WHEN length(CAST(request_digest AS BLOB))=64 THEN request_digest ELSE NULL END AS request_digest,
      CASE WHEN length(CAST(result_json AS BLOB))<=4096 THEN result_json ELSE NULL END AS result_json,
      ${validRow("mutation_attempts")} AS valid,(${absent("mutation_attempts")}) AS absent
      FROM mutation_attempts WHERE idempotency_key=? AND kind=?`).get(z.string().uuid().parse(key), PEER_SESSION_CANCELLATION_KIND));
    if (!row.success) return fail();
    if (row.data === null) return null;
    let receipt: PeerSessionCancellationReceipt;
    try { receipt = parsePeerSessionCancellationReceipt(JSON.parse(row.data.result_json) as unknown); }
    catch { return fail(); }
    if (JSON.stringify(receipt) !== row.data.result_json || hash(row.data.result_json) !== row.data.request_digest) fail();
    const json = row.data.result_json;
    const action = db.query(`SELECT 1 FROM peer_session_actions action WHERE action.idempotency_key=? AND (
      ${matches("?", "action", "action")} AND action.state='cancelled' AND action.result_digest=?
      AND action.target_turn_digest IS NULL) IS NOT 1`).get(key, ...fields.map(() => json), row.data.request_digest);
    if (action !== null) fail();
    const source = db.query(`SELECT 1 FROM peer_session_direct_message_sources source WHERE source.idempotency_key=? AND (
      ${matches("?", "source", "source")}) IS NOT 1`).get(key, ...fields.map(() => json));
    if (source !== null) fail();
    return receipt;
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}
