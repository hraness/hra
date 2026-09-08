import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  canonical49WorkDatabaseBytes,
  canonical49WorkFixture,
  canonical49WorkGeneratorSource,
} from "../../scripts/fixtures/canonical49-work";
import { assertCanonical49Schema } from "./canonical49-schema";
import { combined49DatabaseBytes } from "../../scripts/fixtures/combined49";

const roots: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close(false);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const open = async (readonly = false, bytes = canonical49WorkDatabaseBytes()) => {
  const root = await mkdtemp(join(tmpdir(), "hra-canonical49-schema-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  await writeFile(path, bytes, { mode: 0o600 });
  if (readonly) {
    const holder = new Database(path, { strict: true, create: false });
    databases.push(holder);
    holder.exec("PRAGMA query_only=ON");
    holder.query("SELECT name FROM sqlite_schema LIMIT 1").all();
  }
  const database = new Database(path, { strict: true, create: false, readonly });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  return { database, path };
};
const snapshot = (database: Database) => {
  const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = z.object({ name: z.string().regex(/^[a-zA-Z0-9_]+$/u) }).strict().array().parse(
    database.query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
  );
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    rows[name] = database.query(`SELECT * FROM "${name}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  const foundationColumns = ["sessions", "work_routes", "work_tasks", "work_attempts"].map((table) => ({
    table, columns: database.query(`PRAGMA table_info(${table})`).all(),
  }));
  return { userVersion: database.query("PRAGMA user_version").get(), schema, rows,
    foreignKeyCheck: database.query("PRAGMA foreign_key_check").all(), foundationColumns,
    inspectionChanges: database.query("SELECT total_changes() AS count").get() };
};
const expectRefusal = (database: Database, error: string) => {
  const before = snapshot(database);
  expect(() => assertCanonical49Schema(database)).toThrow(error);
  expect(snapshot(database)).toEqual(before);
};

describe("actual archived canonical49 schema", () => {
  test("retains the exact producer image and recipe rather than relabeling private combined49", () => {
    expect(hash(canonical49WorkDatabaseBytes())).toBe(canonical49WorkFixture.databaseSha256);
    expect(hash(canonical49WorkGeneratorSource)).toBe(canonical49WorkFixture.generatorSha256);
    expect(canonical49WorkFixture.sourceCommit).toBe("7ab347813f8d7e4f31e9584752c801dd1ca0cda0");
    expect(canonical49WorkFixture.schemaObjectCounts).toEqual({ table: 114, index: 98, trigger: 327 });
    expect(canonical49WorkFixture.provenance.canonicalProfileFoundationInstalled).toBe(false);
  });

  for (const readonly of [false, true]) {
    test(`proves all539 schema objects on ${readonly ? "readonly" : "writable"} SQLite with every populated row unchanged`, async () => {
      const { database, path } = await open(readonly);
      const bytesBefore = await readFile(path);
      const before = snapshot(database);
      expect(hash(JSON.stringify(before))).toBe(canonical49WorkFixture.allTableSnapshotSha256);
      expect(hash(JSON.stringify(before.schema))).toBe(canonical49WorkFixture.schemaSha256);
      expect(before.rows.works).toHaveLength(1);
      expect(before.rows.work_tasks).toHaveLength(1);
      expect(before.rows.work_attempts).toHaveLength(1);
      expect(before.rows.sessions).toHaveLength(2);
      expect(before.rows.migrations).toHaveLength(49);
      expect(() => assertCanonical49Schema(database)).not.toThrow();
      expect(snapshot(database)).toEqual(before);
      expect(await readFile(path)).toEqual(bytesBefore);
    });
  }

  test("rejects the private combined49 image despite the same numeric version without mutation", async () => {
    const { database } = await open(false, combined49DatabaseBytes());
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 49 });
    expectRefusal(database, "STATE_CANONICAL49_SCHEMA_UNEXPECTED");
  });

  test("refuses a missing released index without repairing it", async () => {
    const { database } = await open();
    database.exec("DROP INDEX work_attempts_one_live");
    expectRefusal(database, "STATE_CANONICAL49_SCHEMA_MISSING:work_attempts_one_live");
  });

  test("refuses an altered nullable-project companion without changing populated history", async () => {
    const { database } = await open();
    database.exec(`DROP TRIGGER work_session_project_authority_guard;
      CREATE TRIGGER work_session_project_authority_guard BEFORE UPDATE OF project_id ON sessions
      WHEN 0 BEGIN SELECT RAISE(ABORT,'WORK_SESSION_ATTEMPT_AUTHORITY'); END;`);
    expectRefusal(database, "STATE_CANONICAL49_SCHEMA_INVALID:work_session_project_authority_guard");
  });

  test("refuses a silently installed canonical-profile column", async () => {
    const { database } = await open();
    database.exec("ALTER TABLE sessions ADD COLUMN canonical_profile_key TEXT");
    expectRefusal(database, "STATE_CANONICAL49_SCHEMA_INVALID:sessions");
  });

  test("refuses an added relevant usage footprint rather than accepting a partial manifest", async () => {
    const { database } = await open();
    database.exec("CREATE TABLE session_switch_adoption_anchors (id TEXT PRIMARY KEY) STRICT");
    expectRefusal(database, "STATE_CANONICAL49_SCHEMA_UNEXPECTED");
  });

  test("refuses oversized foreign declaration text through the bounded SQL projection", async () => {
    const { database } = await open();
    database.exec(`DROP TRIGGER work_session_project_authority_guard;
      CREATE TRIGGER work_session_project_authority_guard BEFORE UPDATE OF project_id ON sessions
      WHEN 0 BEGIN SELECT '${"x".repeat(16385)}'; END;`);
    expectRefusal(database, "STATE_CANONICAL49_SCHEMA_INVALID:work_session_project_authority_guard");
  });
});
