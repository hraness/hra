import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { canonicalAdoption40DatabaseBytes } from "../../scripts/fixtures/canonical-adoption40";
import { combined49DatabaseBytes } from "../../scripts/fixtures/combined49";
import { privateTask48DatabaseBytes } from "../../scripts/fixtures/private-task48";
import {
  assertCanonicalAdoption40SessionTaskSchema,
  assertCombined49SessionTaskSchema,
  assertPrivateTask48SessionTaskSchema,
} from "./session-task-schema-cohorts";

const roots: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const cohorts = [
  { name: "canonical40", bytes: canonicalAdoption40DatabaseBytes, assert: assertCanonicalAdoption40SessionTaskSchema },
  { name: "private48", bytes: privateTask48DatabaseBytes, assert: assertPrivateTask48SessionTaskSchema },
  { name: "combined49", bytes: combined49DatabaseBytes, assert: assertCombined49SessionTaskSchema },
] as const;
const openFixture = async (bytes: Uint8Array, readonly = false): Promise<Database> => {
  const root = await mkdtemp(join(tmpdir(), "hra-task-schema-cohort-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  await writeFile(path, bytes, { mode: 0o600 });
  // Prepare archived WAL sidecars before opening a genuinely read-only handle.
  if (readonly) {
    const initializer = new Database(path, { create: false, strict: true });
    databases.push(initializer);
    initializer.exec("PRAGMA query_only=ON");
    initializer.query("SELECT name FROM sqlite_master LIMIT 1").all();
  }
  const database = new Database(path, { create: false, strict: true, readonly });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
};
const snapshot = (database: Database) => {
  const tables = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/u) }).strict().array().parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
  );
  return {
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    version: database.query("PRAGMA user_version").get(),
    ledger: database.query("SELECT version,applied_at FROM migrations ORDER BY version").all(),
    changes: database.query("SELECT total_changes() AS count").get(),
    // Capture every historical user table, not just the component under test.
    // Fresh statements avoid cached column metadata after deliberate rebuilds.
    rows: Object.fromEntries(tables.map(({ name }) => {
      const statement = database.prepare(`SELECT * FROM "${name}"`);
      try {
        return [name, statement.all().map((row) => JSON.stringify(row)).sort()];
      } finally {
        statement.finalize();
      }
    })),
  };
};

describe("frozen scheduled-task cohort schema", () => {
  for (const cohort of cohorts) {
    for (const readonly of [false, true]) {
      test(`accepts authentic ${cohort.name} task SQL on ${readonly ? "readonly" : "writable"} connection without mutation`, async () => {
        const database = await openFixture(cohort.bytes(), readonly);
        const before = snapshot(database);
        expect(() => cohort.assert(database)).not.toThrow();
        expect(snapshot(database)).toEqual(before);
      });
    }

    test(`refuses disabled foreign keys in ${cohort.name} without changing rows or schema`, async () => {
      const database = await openFixture(cohort.bytes());
      database.exec("PRAGMA foreign_keys=OFF");
      const before = snapshot(database);
      expect(() => cohort.assert(database)).toThrow(`STATE_SESSION_TASK_SCHEMA_COHORT_INVALID:${cohort.name}`);
      expect(snapshot(database)).toEqual(before);
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
    });

    test(`refuses a missing ${cohort.name} task index rather than recreating it`, async () => {
      const database = await openFixture(cohort.bytes());
      expect(() => cohort.assert(database)).not.toThrow();
      database.exec("DROP INDEX session_tasks_due");
      const before = snapshot(database);
      expect(() => cohort.assert(database)).toThrow(`STATE_SESSION_TASK_SCHEMA_COHORT_INVALID:${cohort.name}`);
      expect(snapshot(database)).toEqual(before);
    });

    test(`refuses changed ${cohort.name} task authority trigger bytes`, async () => {
      const database = await openFixture(cohort.bytes());
      expect(() => cohort.assert(database)).not.toThrow();
      database.exec(`DROP TRIGGER session_task_occurrences_insert_guard;
        CREATE TRIGGER session_task_occurrences_insert_guard BEFORE INSERT ON session_task_occurrences
        BEGIN SELECT 1; END`);
      const before = snapshot(database);
      expect(() => cohort.assert(database)).toThrow(`STATE_SESSION_TASK_SCHEMA_COHORT_INVALID:${cohort.name}`);
      expect(snapshot(database)).toEqual(before);
    });

    test(`refuses removed ${cohort.name} task FK and CHECK constraints even when foreign_key_check is empty`, async () => {
      const database = await openFixture(cohort.bytes());
      expect(() => cohort.assert(database)).not.toThrow();
      const automationRows = database.query<{
        session_id: string; provider_thread_id: string; enabled_at: number;
      }, []>("SELECT session_id,provider_thread_id,enabled_at FROM session_conversation_automation ORDER BY session_id").all();
      // Preserve the actual archived rows and column names/types/STRICT while
      // removing real constraints. Canonical40 contains an enabled session.
      database.exec(`DROP TABLE session_conversation_automation;
        CREATE TABLE session_conversation_automation (
          session_id TEXT PRIMARY KEY,
          provider_thread_id TEXT NOT NULL,
          enabled_at INTEGER NOT NULL
        ) STRICT`);
      for (const row of automationRows) {
        database.query("INSERT INTO session_conversation_automation(session_id,provider_thread_id,enabled_at) VALUES(?,?,?)")
          .run(row.session_id, row.provider_thread_id, row.enabled_at);
      }
      expect(database.query("SELECT session_id,provider_thread_id,enabled_at FROM session_conversation_automation ORDER BY session_id").all()).toEqual(automationRows);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const before = snapshot(database);
      expect(() => cohort.assert(database)).toThrow(`STATE_SESSION_TASK_SCHEMA_COHORT_INVALID:${cohort.name}`);
      expect(snapshot(database)).toEqual(before);
    });

    test(`refuses an extra ${cohort.name} historical task column`, async () => {
      const database = await openFixture(cohort.bytes());
      expect(() => cohort.assert(database)).not.toThrow();
      database.exec("ALTER TABLE session_conversation_automation ADD COLUMN unrelated_history TEXT");
      const before = snapshot(database);
      expect(() => cohort.assert(database)).toThrow(`STATE_SESSION_TASK_SCHEMA_COHORT_INVALID:${cohort.name}`);
      expect(snapshot(database)).toEqual(before);
    });
  }
});
