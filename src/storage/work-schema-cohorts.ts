import type { Database } from "bun:sqlite";
import { z } from "zod";

import { schemaCohortDigest } from "./schema-cohort";

// Frozen from 3f6ac73 (private task48), 6f056dc (canonical adoption40),
// and 0ae3177 (combined49). Never derive these historical fingerprints from
// the current WORK_SCHEMA_SQL or current preset contract.
// Every named index and trigger is checked, including its owning table.
// Tables retain their released ALTER history. Their fingerprint below comes
// from the actual archived SQLite images, never fresh CREATE statements.
const privateObjectNames = [
  "work_active_limit_guard",
  "work_attempt_authority_immutable",
  "work_attempt_dispatch_binding_guard",
  "work_attempt_fence_monotonic",
  "work_attempt_no_delete",
  "work_attempt_reports_attempt",
  "work_attempt_reports_no_delete",
  "work_attempt_reports_no_update",
  "work_attempt_revision_guard",
  "work_attempt_route_guard",
  "work_attempt_state_guard",
  "work_attempt_submission_guard",
  "work_attempts_actor",
  "work_attempts_lease",
  "work_attempts_one_live",
  "work_dependencies_no_delete",
  "work_dependencies_no_update",
  "work_devin_preset_contract_guard",
  "work_effect_capacity_guard",
  "work_effect_identity_immutable",
  "work_effect_no_delete",
  "work_effect_outcome_guard",
  "work_effect_resolutions_insert_guard",
  "work_effect_resolutions_no_delete",
  "work_effect_resolutions_no_update",
  "work_effect_state_guard",
  "work_effect_subject_unique",
  "work_event_capacity_guard",
  "work_event_chain_guard",
  "work_events_no_delete",
  "work_events_no_update",
  "work_events_revision",
  "work_idempotency_work",
  "work_intents_no_delete",
  "work_intents_no_update",
  "work_member_limit_guard",
  "work_members_no_delete",
  "work_members_no_update",
  "work_nested_effect_settlements_insert_guard",
  "work_nested_effect_settlements_no_delete",
  "work_nested_effect_settlements_no_update",
  "work_prepared_effects_pending",
  "work_profile_attempt_authority_guard",
  "work_receipt_chain_guard",
  "work_receipts_no_delete",
  "work_receipts_no_update",
  "work_release_tombstones_no_update",
  "work_release_tombstones_retention",
  "work_retained_limit_guard",
  "work_review_member_guard",
  "work_reviews_no_delete",
  "work_reviews_no_update",
  "work_reviews_submission",
  "work_route_authority_guard",
  "work_route_limit_guard",
  "work_routes_no_delete",
  "work_routes_no_update",
  "work_session_attempt_authority_guard",
  "work_session_devin_contract_guard",
  "work_session_switch_attempt_authority_guard",
  "work_signal_ack_guard",
  "work_signal_member_guard",
  "work_signal_receipts_kind",
  "work_signals_no_delete",
  "work_signals_no_update",
  "work_signals_recipient",
  "work_submissions_no_delete",
  "work_submissions_no_update",
  "work_submissions_task",
  "work_task_dependencies_reverse",
  "work_task_history_index_attempt",
  "work_task_history_index_attempt_report",
  "work_task_history_index_no_delete",
  "work_task_history_index_no_update",
  "work_task_history_index_page",
  "work_task_history_index_review",
  "work_task_history_index_signal",
  "work_task_history_index_submission",
  "work_task_history_versions_capacity",
  "work_task_history_versions_cut",
  "work_task_history_versions_no_delete",
  "work_task_history_versions_no_update",
  "work_task_history_versions_work",
  "work_task_state_identity_immutable",
  "work_task_state_revision_guard",
  "work_task_states_ready",
  "work_tasks_no_delete",
  "work_tasks_no_update",
  "work_tasks_order",
  "work_tasks_parent",
  "work_terminal_requests_no_delete",
  "work_terminal_requests_no_update",
  "works_identity_immutable",
  "works_no_delete",
  "works_state_guard",
  "works_stream_advance_guard",
] as const;
const adoptionAddedObjectNames = [
  "work_attempt_account_authority_guard",
  "work_coordinator_account_authority_guard",
  "work_member_account_authority_guard",
  "work_profile_attempt_identity_guard",
  "work_review_account_authority_guard",
  "work_signal_account_authority_guard",
  "work_signal_ack_account_authority_guard",
] as const;
const tableNames = [
  "work_attempt_reports",
  "work_attempts",
  "work_clock",
  "work_effect_resolutions",
  "work_events",
  "work_idempotency_intents",
  "work_members",
  "work_nested_effect_settlements",
  "work_prepared_effects",
  "work_purge_authority",
  "work_release_tombstones",
  "work_reviews",
  "work_routes",
  "work_signal_receipts",
  "work_signals",
  "work_submissions",
  "work_task_dependencies",
  "work_task_history_index",
  "work_task_history_versions",
  "work_task_states",
  "work_tasks",
  "work_terminal_requests",
  "works",
] as const;
const objectSchema = z.object({
  type: z.enum(["table", "index", "trigger"]),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string(),
}).strict();

const assertFrozenWorkSchema = (
  database: Database,
  cohort: "canonical40" | "private48" | "combined49",
): void => {
  if (!z.object({ foreign_keys: z.literal(1) }).safeParse(
    database.query("PRAGMA foreign_keys").get(),
  ).success) throw new Error("WORK_SCHEMA_FOREIGN_KEYS_DISABLED");
  const rows = z.object({ name: z.string(), type: z.string(), strict: z.number() })
    .array().parse(database.query("PRAGMA table_list").all());
  for (const name of tableNames) {
    if (!rows.some((row) => row.name === name && row.type === "table" && row.strict === 1)) {
      throw new Error(`WORK_SCHEMA_COHORT_MISSING_TABLE:${cohort}:${name}`);
    }
  }
  const tables = tableNames.map((name) => objectSchema.parse(database.query(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name)));
  // These authentic cohorts have identical Work table SQL, including the
  // historical preset_contract ALTER and every CHECK/UNIQUE/FK declaration.
  // Reproduce from scripts/fixtures/{canonical-adoption40,private-task48}.ts.
  if (schemaCohortDigest(tables)
    !== "ff5fea682951978d5e7f4a925369741cb21dbc72382abe0f73b6e0c6a6830836") {
    throw new Error(`WORK_SCHEMA_COHORT_INVALID:${cohort}`);
  }
  const names: readonly string[] = cohort !== "private48"
    ? [...privateObjectNames, ...adoptionAddedObjectNames].sort((a, b) => a.localeCompare(b))
    : privateObjectNames;
  const objects = names.map((name) => objectSchema.parse(database.query(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?",
  ).get(name)));
  const expected = {
    canonical40: "5d912fbe1aa5f68b9bcc7a0962bcd179c1c54f5133c29d52d1d4e0290c9f9b8f",
    private48: "95b50cf876fb6356f7d3d099e2e9323f4e989761d4a3f27f74c2b8976d8c7d33",
    combined49: "4680776382ec6c47b7302596548923cbec516104dea46cea8a7a3dc9da83a819",
  }[cohort];
  if (schemaCohortDigest(objects) !== expected) {
    throw new Error(`WORK_SCHEMA_COHORT_INVALID:${cohort}`);
  }
  if (cohort === "private48") {
    for (const name of adoptionAddedObjectNames) {
      if (database.query("SELECT 1 FROM sqlite_master WHERE name=?").get(name) !== null) {
        throw new Error(`WORK_SCHEMA_COHORT_UNEXPECTED:${cohort}:${name}`);
      }
    }
  }
  const requiredColumns: Readonly<Record<string, readonly string[]>> = {
    profiles: ["state", "process_generation", "provider_email",
      ...(cohort === "combined49" ? ["codex_account_key"] : [])],
    sessions: ["provider_v39", "provider_thread_id", "preset_contract"],
    works: ["preset_contract"],
    ...(cohort !== "private48" ? {
      session_account_authorities: ["session_id", "profile_id", "account_key"],
      session_provider_account_authorities: ["session_id", "provider", "runtime_scope", "account_key"],
      session_personal_runtime_bindings: ["session_id", "provider", "provider_thread_id", "state"],
      provider_runtime_account_revocations: [
        "profile_id", "profile_generation", "provider", "runtime_scope", "current_account_key", "state",
      ],
    } : {}),
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const present = z.object({ name: z.string() }).array()
      .parse(database.query(`PRAGMA table_info(${table})`).all()).map((row) => row.name);
    if (columns.some((name) => !present.includes(name))) {
      throw new Error(`WORK_SCHEMA_COHORT_MISSING_COLUMN:${cohort}:${table}`);
    }
  }
  if (!z.object({ logical_time: z.number().int().nonnegative().safe() }).strict()
    .safeParse(database.query("SELECT logical_time FROM work_clock WHERE singleton=1").get()).success) {
    throw new Error("WORK_SCHEMA_CLOCK_MISSING");
  }
  // Preserve the combined49 row invariant without importing a future live
  // provider discriminator or preset contract. This is historical evidence.
  if (cohort === "combined49" && database.query(`SELECT 1 FROM works w
    JOIN sessions s ON s.id=w.coordinator_session_id
    WHERE s.provider_v39='devin' AND w.preset_contract!=2 LIMIT 1`).get() !== null) {
    throw new Error("WORK_SCHEMA_DEVIN_PRESET_CONTRACT_INVALID");
  }
};

export const assertCanonicalAdoption40WorkSchema = (database: Database): void =>
  assertFrozenWorkSchema(database, "canonical40");
export const assertPrivateTask48WorkSchema = (database: Database): void =>
  assertFrozenWorkSchema(database, "private48");
export const assertCombined49WorkSchema = (database: Database): void =>
  assertFrozenWorkSchema(database, "combined49");
