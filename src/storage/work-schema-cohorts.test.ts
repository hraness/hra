import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalAdoption40DatabaseBytes } from "../../scripts/fixtures/canonical-adoption40";
import { privateTask48DatabaseBytes } from "../../scripts/fixtures/private-task48";
import {
  assertCanonicalAdoption40WorkSchema,
  assertPrivateTask48WorkSchema,
} from "./work-schema-cohorts";

const roots: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const cohorts = [
  { name: "canonical40", bytes: canonicalAdoption40DatabaseBytes, assert: assertCanonicalAdoption40WorkSchema },
  { name: "private48", bytes: privateTask48DatabaseBytes, assert: assertPrivateTask48WorkSchema },
] as const;

const openFixture = async (bytes: Uint8Array): Promise<Database> => {
  const root = await mkdtemp(join(tmpdir(), "hra-work-cohort-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  await writeFile(path, bytes, { mode: 0o600 });
  const database = new Database(path, { create: false, strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
};

describe("frozen Work cohort admission", () => {
  for (const cohort of cohorts) {
    test(`accepts authentic ${cohort.name} table ALTER history without rewriting it`, async () => {
      const database = await openFixture(cohort.bytes());
      const before = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
      const changes = database.query("SELECT total_changes() AS count").get();
      expect(() => cohort.assert(database)).not.toThrow();
      expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
      expect(database.query("SELECT total_changes() AS count").get()).toEqual(changes);
    });

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
  }
});
