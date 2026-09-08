import type { Database } from "bun:sqlite";

import { z } from "zod";

import { normalizeSchemaSql } from "./schema-cohort";

const name = "attachment_terminal_projection_guard";
const invalid = (): never => { throw new Error("ATTACHMENT_CUSTODY_TERMINAL_GUARD_INVALID"); };
const replaceOnce = (source: string, before: string, after: string): string => {
  if (source.split(before).length !== 2) return invalid();
  return source.replace(before, after);
};

/** The caller supplies its frozen predecessor literal. Only the generic effect
 * branch changes; original-owner outcomes and effect-free cancellation retain
 * their exact independent proof alternatives. SQL checks correspondence here;
 * source-selected readers still recompute codecs, hashes and terminal digests. */
export function joinedAttachmentTerminalGuardSql(predecessor: string): string {
  let sql = replaceOnce(predecessor,
    "mutation_effect_evidence effect JOIN mutation_provider_authorities primary_authority",
    `mutation_effect_evidence effect
      JOIN mutation_effect_evidence_provenance proof ON proof.attempt_id=effect.attempt_id
      JOIN mutation_effect_evidence_provenance_anchors proof_anchor
        ON proof_anchor.attempt_id=proof.attempt_id AND proof_anchor.provenance_digest=proof.provenance_digest
      JOIN mutation_provider_authorities primary_authority`);
  sql = replaceOnce(sql,
    "('kind','providerThreadId','baseline','clientMessageId','messageDigest','runtimeProfile')",
    "('kind','providerThreadId','baseline','clientMessageId','messageDigest','runtimeProfile','messageActor')");
  sql = replaceOnce(sql,
    "('kind','providerThreadId','baseline','clientMessageId','messageDigest','activeTurnId')",
    "('kind','providerThreadId','baseline','clientMessageId','messageDigest','activeTurnId','messageActor')");
  // The old generic predicate must interpret only the selected projection.
  sql = sql.replaceAll("effect.evidence_json", "proof.projection_json");
  return replaceOnce(sql, "WHERE effect.attempt_id=NEW.id AND effect.kind=NEW.kind",
    `WHERE effect.attempt_id=NEW.id AND effect.kind=NEW.kind
        AND proof.opaque_reason IS NULL AND proof.projection_json IS NOT NULL
        AND CAST(proof.projection_json AS BLOB) IS CAST(effect.evidence_json AS BLOB)
        AND proof.parent_kind=NEW.kind AND proof.parent_authority_id=NEW.authority_id
        AND proof.parent_authority_generation_decimal=CAST(NEW.authority_generation AS TEXT)
        AND proof.evidence_kind=effect.kind AND proof.stored_digest=effect.evidence_digest
        AND proof.raw_sha256=effect.evidence_digest
        AND proof.raw_byte_length=length(CAST(effect.evidence_json AS BLOB))
        AND proof.raw_byte_length BETWEEN 2 AND 524288
        AND proof.recorded_at_decimal=CAST(effect.recorded_at AS TEXT)
        AND (
          (proof.format IN ('canonical40_v1','canonical41_v1','canonical_sol43_v1','private_task48_v1','combined49_v1')
            AND json_type(proof.projection_json,'$.messageActor') IS NULL)
          OR (proof.format='canonical43_v1' AND (json_type(proof.projection_json,'$.messageActor') IS NULL
            OR json_extract(proof.projection_json,'$.messageActor') IN ('human','autorespond','peer_session','provider_switch')))
          OR (proof.format IN ('canonical49_v1','joined_v1') AND (json_type(proof.projection_json,'$.messageActor') IS NULL
            OR json_extract(proof.projection_json,'$.messageActor') IN ('human','autorespond','automation','peer_session','provider_switch')))
        )
        AND (proof.format!='joined_v1' OR CASE WHEN json_valid(NEW.transcript_intent_json) THEN
          json_type(proof.projection_json,'$.messageActor')='text'
          AND json_extract(proof.projection_json,'$.messageActor')=json_extract(NEW.transcript_intent_json,'$.actor')
          ELSE 0 END IS 1)`);
}

const observed = (database: Database) => {
  const count = z.object({ n: z.literal(1) }).strict().safeParse(database.query(`SELECT count(*) AS n FROM (
    SELECT 1 FROM sqlite_master WHERE name=? COLLATE NOCASE
    UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE)`).get(name, name));
  if (!count.success) return invalid();
  const row = z.object({ type: z.string().max(16), name: z.literal(name),
    tbl_name: z.literal("mutation_attempts"), sql: z.string().max(131_072),
  }).strict().safeParse(database.query(`SELECT type,name,
    CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name ELSE NULL END AS tbl_name,
    CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql ELSE NULL END AS sql
    FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=? COLLATE NOCASE
      UNION ALL SELECT type,name,tbl_name,sql FROM sqlite_temp_master WHERE name=? COLLATE NOCASE) LIMIT 1`).get(name, name));
  if (!row.success) return invalid();
  return [row.data];
};

export function assertJoinedAttachmentTerminalGuard(database: Database, predecessor: string): void {
  const rows = observed(database);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.type !== "trigger"
    || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(joinedAttachmentTerminalGuardSql(predecessor))) invalid();
}

export function installJoinedAttachmentTerminalGuard(database: Database, predecessor: string): void {
  if (!database.inTransaction) invalid();
  const rows = observed(database);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.type !== "trigger") return invalid();
  const joined = joinedAttachmentTerminalGuardSql(predecessor);
  if (normalizeSchemaSql(row.sql) === normalizeSchemaSql(joined)) return assertJoinedAttachmentTerminalGuard(database, predecessor);
  if (normalizeSchemaSql(row.sql) !== normalizeSchemaSql(predecessor)) invalid();
  database.exec(`DROP TRIGGER ${name}`);
  database.exec(joined);
  assertJoinedAttachmentTerminalGuard(database, predecessor);
}
