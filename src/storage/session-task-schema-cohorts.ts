import type { Database } from "bun:sqlite";
import { z } from "zod";

import { schemaCohortDigest } from "./schema-cohort";

// Frozen scheduled-task authority shared by canonical adoption40 (6f056dc),
// private task48 (3f6ac73), and combined49 (0ae3177). Neither this object set
// nor its expected digest is derived from the evolving SessionTaskStore DDL.
const objectNames = [
  "session_conversation_automation",
  "session_task_occurrences",
  "session_task_occurrences_by_session",
  "session_task_occurrences_insert_guard",
  "session_task_occurrences_no_update",
  "session_task_receipts",
  "session_task_receipts_by_task",
  "session_task_receipts_capacity_guard",
  "session_task_receipts_no_update",
  "session_tasks",
  "session_tasks_by_session",
  "session_tasks_due",
  "session_tasks_due_advance_guard",
  "session_tasks_limit_guard",
  "session_tasks_update_guard",
] as const;
const tableNames = [
  "session_conversation_automation",
  "session_task_occurrences",
  "session_task_receipts",
  "session_tasks",
] as const;

// Static inspection of the archived combined49 DDL yields these 15 objects.
// Authentic fixture tests independently check the actual SQLite table SQL,
// including CHECK/UNIQUE/FK declarations and historical ALTER layout.
const expectedObjectsDigest = "bfca789acaa19ae367421d09755b480b1cdd6895a231e8d9b55926b312909e4d";
const objectSchema = z.object({
  type: z.enum(["table", "index", "trigger"]),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string(),
}).strict();
const tableSchema = z.object({
  schema: z.string(),
  name: z.string(),
  type: z.string(),
  strict: z.number().int().min(0).max(1),
}).passthrough();
const foreignKeySchema = z.object({
  id: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  table: z.string(),
  from: z.string(),
  to: z.string(),
  on_update: z.string(),
  on_delete: z.string(),
  match: z.string(),
}).strict();
const foreignKey = (id: number, seq: number, table: string, from: string, to: string) => ({
  id, seq, table, from, to, on_update: "NO ACTION", on_delete: "CASCADE", match: "NONE",
});
const expectedForeignKeys = {
  session_conversation_automation: [foreignKey(0, 0, "sessions", "session_id", "id")],
  session_task_occurrences: [
    foreignKey(0, 0, "session_tasks", "task_id", "id"),
    foreignKey(0, 1, "session_tasks", "session_id", "session_id"),
    foreignKey(1, 0, "queue_entries", "queue_id", "id"),
  ],
  session_task_receipts: [
    foreignKey(0, 0, "session_tasks", "task_id", "id"),
    foreignKey(0, 1, "session_tasks", "session_id", "session_id"),
    foreignKey(1, 0, "sessions", "session_id", "id"),
  ],
  session_tasks: [foreignKey(0, 0, "sessions", "session_id", "id")],
} as const;

type SessionTaskSchemaCohort = "canonical40" | "private48" | "combined49";

/** Component schema proof only; the caller owns cohort ledger and row audits. */
const assertFrozenSessionTaskSchema = (database: Database, cohort: SessionTaskSchemaCohort): void => {
  const fail = (): never => { throw new Error(`STATE_SESSION_TASK_SCHEMA_COHORT_INVALID:${cohort}`); };
  try {
    if (!z.object({ foreign_keys: z.literal(1) }).strict().safeParse(
      database.query("PRAGMA foreign_keys").get(),
    ).success) fail();
    const objects = [...objectNames].sort((left, right) => left.localeCompare(right)).map((name) =>
      objectSchema.parse(database.query(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?",
      ).get(name)));
    if (schemaCohortDigest(objects) !== expectedObjectsDigest) fail();
    const tables = tableSchema.array().parse(database.query("PRAGMA table_list").all());
    for (const name of tableNames) {
      const matches = tables.filter((table) => table.schema === "main" && table.name === name);
      if (matches.length !== 1 || matches[0]?.type !== "table" || matches[0].strict !== 1) fail();
      const keys = foreignKeySchema.array().parse(database.query(`PRAGMA main.foreign_key_list('${name}')`).all())
        .sort((left, right) => left.id - right.id || left.seq - right.seq);
      if (JSON.stringify(keys) !== JSON.stringify(expectedForeignKeys[name])) fail();
    }
  } catch {
    fail();
  }
};

export const assertCanonicalAdoption40SessionTaskSchema = (database: Database): void =>
  assertFrozenSessionTaskSchema(database, "canonical40");
export const assertPrivateTask48SessionTaskSchema = (database: Database): void =>
  assertFrozenSessionTaskSchema(database, "private48");
export const assertCombined49SessionTaskSchema = (database: Database): void =>
  assertFrozenSessionTaskSchema(database, "combined49");
