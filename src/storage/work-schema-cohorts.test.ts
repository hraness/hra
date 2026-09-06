import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalAdoption40DatabaseBytes } from "../../scripts/fixtures/canonical-adoption40";
import { combined49DatabaseBytes } from "../../scripts/fixtures/combined49";
import { combined49RetiredDatabaseBytes, combined49RetiredFixture } from "../../scripts/fixtures/combined49-retired";
import { privateTask48DatabaseBytes } from "../../scripts/fixtures/private-task48";
import {
  assertCanonicalAdoption40WorkSchema,
  assertCombined49WorkSchema,
  assertPrivateTask48WorkSchema,
} from "./work-schema-cohorts";

const roots: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const cohorts = [
  { name: "canonical40", bytes: canonicalAdoption40DatabaseBytes, assert: assertCanonicalAdoption40WorkSchema },
  { name: "private48", bytes: privateTask48DatabaseBytes, assert: assertPrivateTask48WorkSchema },
  { name: "combined49", bytes: combined49DatabaseBytes, assert: assertCombined49WorkSchema },
] as const;

const openFixture = async (bytes: Uint8Array, readonly = false): Promise<Database> => {
  const root = await mkdtemp(join(tmpdir(), "hra-work-cohort-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  await writeFile(path, bytes, { mode: 0o600 });
  if (readonly) {
    // Keep archived WAL sidecars alive for the genuinely read-only reader.
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
const snapshot = (database: Database) => ({
  schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
  version: database.query("PRAGMA user_version").get(),
  changes: database.query("SELECT total_changes() AS count").get(),
  rows: Object.fromEntries(database.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map(({ name }) => {
    if (!/^[a-zA-Z0-9_]+$/u.test(name)) throw new Error("Unexpected fixture table name.");
    return [name, database.query(`SELECT * FROM "${name}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))];
  })),
});

describe("frozen Work cohort admission", () => {
  for (const cohort of cohorts) {
    for (const readonly of [false, true]) {
      test(`accepts authentic ${cohort.name} table ALTER history on ${readonly ? "readonly" : "writable"} connection without rewriting it`, async () => {
        const database = await openFixture(cohort.bytes(), readonly);
        const before = snapshot(database);
        expect(() => cohort.assert(database)).not.toThrow();
        expect(snapshot(database)).toEqual(before);
      });
    }

    test(`refuses a constraint-stripped ${cohort.name} Work table before any repair`, async () => {
      const database = await openFixture(cohort.bytes());
      expect(() => cohort.assert(database)).not.toThrow();
      const clock = database.query<{ singleton: number; logical_time: number }, []>(
        "SELECT singleton,logical_time FROM work_clock",
      ).get();
      if (clock === null) throw new Error("Expected the authentic Work clock.");
      // A real table rebuild keeps the names, STRICT type, data, and columns
      // that the old recognizer inspected, but removes its CHECK constraints.
      database.exec("DROP TABLE work_clock");
      database.exec("CREATE TABLE work_clock(singleton INTEGER PRIMARY KEY,logical_time INTEGER NOT NULL) STRICT");
      database.query("INSERT INTO work_clock(singleton,logical_time) VALUES(?,?)")
        .run(clock.singleton, clock.logical_time);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const schemaBefore = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
      const versionBefore = database.query("PRAGMA user_version").get();
      const changesBefore = database.query("SELECT total_changes() AS count").get();
      expect(() => cohort.assert(database)).toThrow(`WORK_SCHEMA_COHORT_INVALID:${cohort.name}`);
      expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schemaBefore);
      expect(database.query("PRAGMA user_version").get()).toEqual(versionBefore);
      expect(database.query("SELECT total_changes() AS count").get()).toEqual(changesBefore);
    });

    test(`refuses a same-named ${cohort.name} Work guard with changed literal bytes`, async () => {
      const database = await openFixture(cohort.bytes());
      const guard = database.query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE name='work_release_tombstones_no_update'",
      ).get();
      if (guard === null) throw new Error("Expected the archived immutable guard.");
      const altered = guard.sql.replace(/'([^']+)'/u, "'$1 '");
      expect(altered).not.toBe(guard.sql);
      database.exec("DROP TRIGGER work_release_tombstones_no_update");
      database.exec(altered);
      const before = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
      const changes = database.query("SELECT total_changes() AS count").get();
      expect(() => cohort.assert(database)).toThrow(`WORK_SCHEMA_COHORT_INVALID:${cohort.name}`);
      expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
      expect(database.query("SELECT total_changes() AS count").get()).toEqual(changes);
    });

    test(`refuses ${cohort.name} recognition with foreign-key enforcement disabled`, async () => {
      const database = await openFixture(cohort.bytes());
      database.exec("PRAGMA foreign_keys=OFF");
      const before = database.query("SELECT total_changes() AS count").get();
      expect(() => cohort.assert(database)).toThrow("WORK_SCHEMA_FOREIGN_KEYS_DISABLED");
      expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
    });
  }

  test("refuses a corrupted combined49 Devin coordinator contract with the authentic guards restored", async () => {
    const database = await openFixture(combined49RetiredDatabaseBytes());
    expect(() => assertCombined49WorkSchema(database)).not.toThrow();
    const originalSchema = snapshot(database).schema;
    const guards = ["work_devin_preset_contract_guard", "work_coordinator_account_authority_guard"].map((name) => {
      const row = database.query<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
      ).get(name);
      if (row === null) throw new Error("Expected the authentic Work admission guard.");
      return { name, sql: row.sql };
    });
    // Deliberately corrupt one disposable copy. The archived image stays exact;
    // restoring the original guards isolates the historical row invariant.
    for (const { name } of guards) database.exec(`DROP TRIGGER ${name}`);
    database.query(`INSERT INTO works (
      id,client_ref,coordinator_session_id,objective,preset_contract,state,revision,
      stream_epoch,next_sequence,head_hash,created_at,updated_at
    ) VALUES (?,?,?,?,1,'active',0,?,1,NULL,0,0)`).run(
      "work_combined49_bad_contract", "combined49-bad-contract",
      combined49RetiredFixture.owner.session.id, "Deliberately corrupt historical contract.",
      "49000000-0000-4000-8000-000000000201",
    );
    for (const { sql } of guards) database.exec(sql);
    expect(snapshot(database).schema).toEqual(originalSchema);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const before = snapshot(database);
    expect(() => assertCombined49WorkSchema(database)).toThrow("WORK_SCHEMA_DEVIN_PRESET_CONTRACT_INVALID");
    expect(snapshot(database)).toEqual(before);
  });
});
