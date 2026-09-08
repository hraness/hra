import type { Database } from "bun:sqlite";
import { z } from "zod";

import {
  decodeHistoricalPresetProfile,
  type CanonicalProfileKey,
} from "../domain/canonical-profile";

/** Decode the stored provider/tier/contract, never current selector defaults. */
export const deriveLegacySessionProfileKey = (
  provider: unknown,
  tier: unknown,
  contract: unknown,
): CanonicalProfileKey | null => {
  const preset = provider === "codex"
    ? tier
    : tier === "ultra" && provider === "claude"
      ? "fable-max"
      : tier === "ultra" && provider === "devin"
        ? "astra"
        : null;
  return decodeHistoricalPresetProfile({ provider, preset, contract })?.key ?? null;
};

/** Work uses its own frozen contract and explicit Codex route, not its coordinator. */
export const deriveLegacyWorkProfileKey = (
  preset: unknown,
  contract: unknown,
): CanonicalProfileKey | null =>
  decodeHistoricalPresetProfile({ provider: "codex", preset, contract })?.key ?? null;

/**
 * Building blocks only: no installer, migration number, backfill or admission.
 * A future migration must prove an unmodified predecessor and absence of these
 * columns before applying them in its own transaction. Nullable declarations
 * permit that transaction's backfill; the guards below enforce requiredness.
 */
export const LEGACY_CANONICAL_PROFILE_COLUMNS_SQL = `
ALTER TABLE sessions ADD COLUMN canonical_profile_key TEXT;
ALTER TABLE work_routes ADD COLUMN canonical_profile_key TEXT;
ALTER TABLE work_tasks ADD COLUMN canonical_profile_key TEXT;
ALTER TABLE work_attempts ADD COLUMN canonical_profile_key TEXT;
`;

// This is frozen historical SQL, intentionally NOT generated from the profile
// catalog. Adding a selector or capability must never expand an installed guard.
const legacyCodexKeySql = (preset: string, contract: string): string => `CASE
  WHEN ${contract}=1 AND ${preset}='low' THEN 'codex:gpt-5.6-luna:max'
  WHEN ${contract}=2 AND ${preset}='low' THEN 'codex:gpt-5.6-luna:max'
  WHEN ${contract}=1 AND ${preset}='high' THEN 'codex:gpt-5.6-sol:max'
  WHEN ${contract}=1 AND ${preset}='ultra' THEN 'codex:gpt-5.6-sol:ultra'
  WHEN ${contract}=2 AND ${preset}='high' THEN 'codex:gpt-6-astra:max'
  WHEN ${contract}=2 AND ${preset}='ultra' THEN 'codex:gpt-6-astra:ultra'
  ELSE NULL END`;

const legacySessionKeySql = `CASE
  WHEN NEW.provider_v39='codex' THEN ${legacyCodexKeySql("NEW.preset", "NEW.preset_contract")}
  WHEN NEW.provider_v39='claude' AND NEW.preset='ultra'
    AND NEW.preset_contract IN (1,2) THEN 'claude:claude-fable-5-1:max'
  WHEN NEW.provider_v39='devin' AND NEW.preset='ultra'
    AND NEW.preset_contract=2 THEN 'devin:gpt-6-astra:provider-default'
  ELSE NULL END`;

const companionDefinitions = [
  {
    name: "canonical_profile_session_insert_guard",
    table: "sessions",
    sql: `CREATE TRIGGER canonical_profile_session_insert_guard
BEFORE INSERT ON sessions
WHEN NEW.canonical_profile_key IS NULL
  OR NEW.canonical_profile_key COLLATE BINARY IS NOT (${legacySessionKeySql})
BEGIN SELECT RAISE(ABORT,'CANONICAL_PROFILE_SESSION_COHERENCE'); END;`,
  },
  {
    name: "canonical_profile_session_update_guard",
    table: "sessions",
    sql: `CREATE TRIGGER canonical_profile_session_update_guard
BEFORE UPDATE OF provider_v39,preset,preset_contract,canonical_profile_key ON sessions
WHEN NEW.canonical_profile_key IS NULL
  OR NEW.canonical_profile_key COLLATE BINARY IS NOT (${legacySessionKeySql})
BEGIN SELECT RAISE(ABORT,'CANONICAL_PROFILE_SESSION_COHERENCE'); END;`,
  },
  {
    name: "canonical_profile_work_route_insert_guard",
    table: "work_routes",
    sql: `CREATE TRIGGER canonical_profile_work_route_insert_guard
BEFORE INSERT ON work_routes
WHEN NEW.canonical_profile_key IS NULL OR NOT EXISTS (
  SELECT 1 FROM works AS w
  WHERE w.id=NEW.work_id
    AND NEW.canonical_profile_key COLLATE BINARY = (${legacyCodexKeySql("NEW.preset", "w.preset_contract")})
)
BEGIN SELECT RAISE(ABORT,'CANONICAL_PROFILE_WORK_ROUTE_COHERENCE'); END;`,
  },
  {
    name: "canonical_profile_work_task_insert_guard",
    table: "work_tasks",
    sql: `CREATE TRIGGER canonical_profile_work_task_insert_guard
BEFORE INSERT ON work_tasks
WHEN NEW.canonical_profile_key IS NULL OR NOT EXISTS (
  SELECT 1 FROM work_routes AS r
  WHERE r.work_id=NEW.work_id AND r.account_id=NEW.account_id
    AND r.project_id=NEW.project_id AND r.preset=NEW.preset AND r.fast=NEW.fast
    AND r.canonical_profile_key COLLATE BINARY = NEW.canonical_profile_key
)
BEGIN SELECT RAISE(ABORT,'CANONICAL_PROFILE_WORK_TASK_COHERENCE'); END;`,
  },
  {
    name: "canonical_profile_work_attempt_insert_guard",
    table: "work_attempts",
    sql: `CREATE TRIGGER canonical_profile_work_attempt_insert_guard
BEFORE INSERT ON work_attempts
WHEN NEW.canonical_profile_key IS NULL OR NOT EXISTS (
  SELECT 1 FROM work_tasks AS t
  JOIN sessions AS s ON s.id=NEW.worker_session_id
  WHERE t.id=NEW.task_id AND t.work_id=NEW.work_id
    AND t.account_id=NEW.account_id AND t.project_id=NEW.project_id
    AND t.preset=NEW.preset AND t.fast=NEW.fast
    AND t.canonical_profile_key COLLATE BINARY = NEW.canonical_profile_key
    AND s.canonical_profile_key COLLATE BINARY = NEW.canonical_profile_key
)
BEGIN SELECT RAISE(ABORT,'CANONICAL_PROFILE_WORK_ATTEMPT_COHERENCE'); END;`,
  },
  {
    name: "canonical_profile_work_attempt_immutable_guard",
    table: "work_attempts",
    sql: `CREATE TRIGGER canonical_profile_work_attempt_immutable_guard
BEFORE UPDATE OF canonical_profile_key ON work_attempts
WHEN NEW.canonical_profile_key COLLATE BINARY IS NOT OLD.canonical_profile_key
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_AUTHORITY_IMMUTABLE'); END;`,
  },
  {
    name: "canonical_profile_session_live_attempt_guard",
    table: "sessions",
    sql: `CREATE TRIGGER canonical_profile_session_live_attempt_guard
BEFORE UPDATE OF canonical_profile_key ON sessions
WHEN NEW.canonical_profile_key COLLATE BINARY IS NOT OLD.canonical_profile_key
  AND EXISTS (
    SELECT 1 FROM work_attempts AS a
    WHERE a.worker_session_id=OLD.id
      AND a.state IN ('claimed','dispatching','running','recovery_required')
      AND NEW.canonical_profile_key COLLATE BINARY IS NOT a.canonical_profile_key
  )
BEGIN SELECT RAISE(ABORT,'WORK_SESSION_ATTEMPT_AUTHORITY'); END;`,
  },
] as const;

/**
 * Install only after transactional derivation/coherence checks and backfill.
 * These companions compose with, never replace, exact legacy Work guards:
 * routes/tasks remain wholly immutable, attempt legacy fields remain immutable,
 * and membership/account/project/Fast/generation/state/fence authority stays in
 * its existing owner. No account-authority SQL belongs in these definitions.
 */
export const LEGACY_CANONICAL_PROFILE_GUARDS_SQL = companionDefinitions
  .map(({ sql }) => sql).join("\n");

const tableMetadataSchema = z.object({
  schema: z.literal("main"),
  name: z.string(),
  type: z.literal("table"),
  strict: z.literal(1),
}).strict();
const columnMetadataSchema = z.object({
  cid: z.number().int().nonnegative(),
  name: z.literal("canonical_profile_key"),
  type: z.literal("TEXT"),
  notnull: z.literal(0),
  dflt_value: z.null(),
  pk: z.literal(0),
  hidden: z.literal(0),
}).strict();
const triggerMetadataSchema = z.object({
  name: z.string(),
  type: z.literal("trigger"),
  tbl_name: z.string(),
  sql: z.string(),
}).strict();
const normalizeSql = (sql: string): string =>
  sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "");

/**
 * Read-only metadata proof, not a row-debt scan or a predecessor classifier.
 * Callers must separately prove the exact legacy schema/guards and all data
 * before installing/stamping. This proves the physical nullable column shape;
 * exact companion bodies (with BINARY comparisons) prove key requiredness and
 * coherence independently of a parent table's declared column collations.
 */
export function assertLegacyCanonicalProfileStorageSchema(database: Database): void {
  const foreignKeys = z.object({ foreign_keys: z.literal(1) }).strict()
    .safeParse(database.query("PRAGMA foreign_keys").get());
  if (!foreignKeys.success) throw new Error("CANONICAL_PROFILE_SCHEMA_FOREIGN_KEYS");
  for (const table of ["sessions", "work_routes", "work_tasks", "work_attempts"] as const) {
    const tables = database.query(`
      SELECT schema,name,type,strict FROM pragma_table_list
      WHERE schema='main' AND name=? COLLATE NOCASE
    `).all(table);
    const metadata = tableMetadataSchema.safeParse(tables[0]);
    if (tables.length !== 1 || !metadata.success || metadata.data.name !== table) {
      throw new Error(`CANONICAL_PROFILE_SCHEMA_TABLE:${table}`);
    }
    const columns = database.query(`
      SELECT cid,name,type,"notnull",dflt_value,pk,hidden
      FROM pragma_table_xinfo(?, 'main')
      WHERE name='canonical_profile_key' COLLATE NOCASE
    `).all(table);
    if (columns.length !== 1 || !columnMetadataSchema.safeParse(columns[0]).success) {
      throw new Error(`CANONICAL_PROFILE_SCHEMA_COLUMN:${table}`);
    }
  }
  for (const { name, table, sql } of companionDefinitions) {
    // All object types and case variants matter: SQLite namespaces can overlap.
    const rows = database.query(`
      SELECT name,type,tbl_name,sql FROM main.sqlite_master WHERE name=? COLLATE NOCASE
    `).all(name);
    const metadata = triggerMetadataSchema.safeParse(rows[0]);
    if (
      rows.length !== 1
      || !metadata.success
      || metadata.data.name !== name
      || metadata.data.tbl_name !== table
      || normalizeSql(metadata.data.sql) !== normalizeSql(sql)
    ) throw new Error(`CANONICAL_PROFILE_SCHEMA_TRIGGER:${name}`);
  }
}
