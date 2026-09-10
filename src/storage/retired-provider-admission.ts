import type { Database } from "bun:sqlite";

import { normalizeSchemaSql } from "./schema-cohort";

const failure = "RETIRED_PROVIDER_ADMISSION_REFUSED";
const retiredSession = (id: string): string => `EXISTS(
  SELECT 1 FROM sessions WHERE id=${id} AND provider_v39='devin')`;
const retiredMutation = (id: string): string => `EXISTS(
  SELECT 1 FROM mutation_provider_authorities WHERE attempt_id=${id} AND provider='devin')
  OR EXISTS(SELECT 1 FROM mutation_attempts m WHERE m.id=${id}
    AND (m.kind='account.devin-login' OR ${retiredSession("m.authority_id")}))`;
const retiredQueue = (id: string): string => `EXISTS(
  SELECT 1 FROM queue_provider_authorities WHERE queue_id=${id} AND provider='devin')
  OR EXISTS(SELECT 1 FROM queue_entries q WHERE q.id=${id} AND ${retiredSession("q.session_id")})`;
// These predicates only refuse a retired provider. They never interpret a
// document as positive authority or replace its original closed codec/digest.
const retiredJson = (json: string, path: string): string => `(CASE
  WHEN length(CAST(${json} AS BLOB))<=524288 AND json_valid(${json})
  THEN json_extract(${json},'${path}')='devin' ELSE 0 END)`;
const guard = (suffix: string, table: string, event: string, when: string) => Object.freeze({
  name: `retired_provider_${suffix}`,
  table,
  sql: `CREATE TRIGGER IF NOT EXISTS retired_provider_${suffix}
BEFORE ${event} ON ${table}
WHEN ${when}
BEGIN SELECT RAISE(ABORT,'${failure}'); END;`,
});

/**
 * Additive current-admission guards only; install after historical import and
 * exact cohort/evidence admission. No frozen table, trigger or historical row
 * is rewritten. This is not a migration/cohort recognizer by itself.
 *
 * Devin order positions and provider_account_states remain inert metadata:
 * profile bootstrap/removal can maintain the existing three-provider inverse
 * and ordering without inventing a timestamp-based transaction permit. Public
 * order/activation APIs separately refuse Devin. No ordering value grants
 * execution because the admission boundaries below independently refuse it.
 */
export const RETIRED_PROVIDER_ADMISSION_GUARDS = Object.freeze([
  guard("account_bootstrap", "provider_accounts", "INSERT", `NEW.provider='devin' AND NOT (
    NEW.readiness IS 'unverified' AND NEW.binding_generation IS 1 AND NEW.process_generation IS 0
    AND NEW.provider_email IS NULL AND NEW.provider_plan IS NULL AND NEW.readiness_observed_at IS NULL
    AND NEW.order_position IS NOT NULL
    AND EXISTS(SELECT 1 FROM profiles p WHERE p.id=NEW.profile_id
      AND p.state='signed_out' AND p.process_generation=0
      AND p.created_at=NEW.created_at AND p.updated_at=NEW.updated_at))`),
  guard("account_authority", "provider_accounts", "UPDATE", `(OLD.provider='devin' OR NEW.provider='devin') AND (
    NEW.id IS NOT OLD.id OR NEW.profile_id IS NOT OLD.profile_id OR NEW.provider IS NOT OLD.provider
    OR NEW.created_at IS NOT OLD.created_at
    OR ((NEW.readiness IS NOT OLD.readiness OR NEW.binding_generation IS NOT OLD.binding_generation
      OR NEW.process_generation IS NOT OLD.process_generation
      OR NEW.readiness_observed_at IS NOT OLD.readiness_observed_at
      OR NEW.provider_email IS NOT OLD.provider_email OR NEW.provider_plan IS NOT OLD.provider_plan)
      AND NOT (
        OLD.readiness!='removed' AND NEW.readiness IS 'removed'
        AND NEW.binding_generation=OLD.binding_generation+1
        AND NEW.process_generation IS OLD.process_generation AND NEW.order_position IS NULL
        AND NEW.provider_email IS NULL AND NEW.provider_plan IS NULL
        AND NEW.readiness_observed_at IS NOT NULL
        AND EXISTS(SELECT 1 FROM profiles p WHERE p.id=OLD.profile_id AND p.state='removed'
          AND NEW.readiness_observed_at=p.updated_at
          AND NEW.updated_at=MAX(OLD.updated_at,p.updated_at)))))`),
  ...["intents", "snapshots", "receipts", "consumptions", "anchors"].map((suffix) =>
    guard(`close_${suffix}`, `devin_joined_close_${suffix}`, "INSERT", "1")),
  guard("session_insert", "sessions", "INSERT", "NEW.provider_v39='devin'"),
  guard("session_rebind", "sessions", "UPDATE OF provider_v39,profile_id,provider_thread_id", `(OLD.provider_v39='devin' OR NEW.provider_v39='devin') AND (
    NEW.provider_v39 IS NOT OLD.provider_v39 OR NEW.profile_id IS NOT OLD.profile_id
    OR NEW.provider_thread_id IS NOT OLD.provider_thread_id)`),
  guard("session_authority_insert", "session_provider_authorities", "INSERT", "NEW.provider='devin'"),
  guard("session_authority_rebind", "session_provider_authorities", "UPDATE", "OLD.provider='devin' OR NEW.provider='devin'"),
  guard("session_binding_insert", "session_provider_account_authorities", "INSERT", "NEW.provider='devin'"),
  guard("session_binding_rebind", "session_provider_account_authorities", "UPDATE", "OLD.provider='devin' OR NEW.provider='devin'"),
  guard("session_successor", "session_provider_authority_successors", "INSERT", "NEW.from_provider='devin' OR NEW.to_provider='devin'"),
  guard("session_start", "session_start_attempts", "INSERT", retiredSession("NEW.session_id")),
  // A cancellation-only generic prepared tombstone is still allowed. Neither
  // it nor any retained prepared row may acquire new effect-start authority.
  guard("mutation_insert", "mutation_attempts", "INSERT", `NEW.kind='account.devin-login'
    OR (NEW.state IN ('effect_started','applied','ambiguous') AND ${retiredSession("NEW.authority_id")})`),
  guard("mutation_begin", "mutation_attempts", "UPDATE OF state", `NEW.state='effect_started' AND OLD.state!='effect_started'
    AND (${retiredMutation("OLD.id")})`),
  guard("mutation_evidence", "mutation_effect_evidence", "INSERT", `NEW.kind='account.devin-login'
    OR (${retiredMutation("NEW.attempt_id")})
    OR ${retiredJson("NEW.evidence_json", "$.sourceProvider")}
    OR ${retiredJson("NEW.evidence_json", "$.targetProvider")}`),
  guard("owner", "session_send_owners", "INSERT", `${retiredSession("NEW.session_id")}
    OR ${retiredJson("NEW.owner_json", "$.sourceAuthority.provider")}`),
  guard("owner_claim", "session_send_execution_claims", "INSERT", `(${retiredMutation("NEW.attempt_id")})
    OR ${retiredJson("NEW.claim_json", "$.executionAuthority.provider")}`),
  guard("custody_set", "attachment_custody_sets", "INSERT", `${retiredJson("NEW.origin_json", "$.input.authority.provider")}
    OR (CASE WHEN json_valid(NEW.origin_json) THEN ${retiredSession("json_extract(NEW.origin_json,'$.input.sessionId')")} ELSE 0 END)`),
  guard("custody_empty", "attachment_custody_anchors", "INSERT", `NEW.kind='empty_input_v1' AND (
    (${retiredMutation("NEW.attempt_id")}) OR ${retiredJson("NEW.proof_json", "$.authority.provider")})`),
  guard("custody_adoption", "attachment_custody_dispositions", "INSERT", `NEW.kind IN ('mutation_owned','queue_transferred') AND (
    (${retiredMutation("NEW.attempt_id")}) OR EXISTS(SELECT 1 FROM attachment_custody_sets custody WHERE custody.id=NEW.custody_id
      AND ${retiredJson("custody.origin_json", "$.input.authority.provider")}))`),
  guard("queue_insert", "queue_entries", "INSERT", retiredSession("NEW.session_id")),
  guard("queue_begin", "queue_entries", "UPDATE OF state", `NEW.state='dispatching' AND OLD.state!='dispatching'
    AND (${retiredQueue("OLD.id")})`),
  guard("queue_authority", "queue_provider_authorities", "INSERT", "NEW.provider='devin'"),
  guard("queue_identity", "queue_attachment_identities", "INSERT", `(${retiredQueue("NEW.queue_id")})
    OR ${retiredJson("NEW.identity_json", "$.authority.provider")}`),
  guard("queue_evidence", "queue_effect_evidence", "INSERT", retiredQueue("NEW.queue_id")),
  guard("switch_insert", "session_switch_attempts", "INSERT", "NEW.source_provider='devin' OR NEW.target_provider='devin'"),
  guard("switch_begin", "session_switch_attempts", "UPDATE OF phase", `(NEW.source_provider='devin' OR NEW.target_provider='devin')
    AND NEW.phase IN ('target_starting','source_releasing','rebound','seed_dispatching') AND NEW.phase IS NOT OLD.phase`),
  guard("interaction_authority", "interaction_provider_authorities", "INSERT", "NEW.provider='devin'"),
  guard("interaction_insert", "provider_interactions", "INSERT", `NEW.method='devin/session/request_permission'
    OR ${retiredSession("NEW.session_id")}`),
  guard("interaction_begin", "provider_interactions", "UPDATE OF state", `NEW.state IN ('response_prepared','response_written')
    AND NEW.state IS NOT OLD.state AND (OLD.method='devin/session/request_permission'
      OR ${retiredSession("OLD.session_id")}
      OR EXISTS(SELECT 1 FROM interaction_provider_authorities WHERE public_id=OLD.public_id AND provider='devin'))`),
]);

const schemaFailure = (): never => { throw new Error("RETIRED_PROVIDER_ADMISSION_SCHEMA_INVALID"); };

/** Exact definitions only. Retained rows need their original historical audit;
 * this audit deliberately does not reclassify them as current admissions. */
export const auditRetiredProviderAdmissionGuards = (database: Database): void => {
  const count = database.query("SELECT COUNT(*) AS total FROM sqlite_master WHERE lower(name) GLOB 'retired_provider_*'")
    .get() as { total: number };
  if (count.total !== RETIRED_PROVIDER_ADMISSION_GUARDS.length) schemaFailure();
  for (const guard of RETIRED_PROVIDER_ADMISSION_GUARDS) {
    const row = database.query(`SELECT type,tbl_name,
      CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql ELSE NULL END AS sql
      FROM sqlite_master WHERE name=?`).get(guard.name) as { type: string; tbl_name: string; sql: string | null } | null;
    if (row === null || row.type !== "trigger" || row.tbl_name !== guard.table || row.sql === null
      || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(guard.sql)) schemaFailure();
  }
};

export const applyRetiredProviderAdmissionGuards = (database: Database): void => {
  database.transaction(() => {
    for (const guard of RETIRED_PROVIDER_ADMISSION_GUARDS) database.exec(guard.sql);
    auditRetiredProviderAdmissionGuards(database);
  }).immediate();
};
