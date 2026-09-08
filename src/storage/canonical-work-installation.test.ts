import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { canonical40QueuesDatabaseBytes } from "../../scripts/fixtures/canonical40-queues";
import { canonical49WorkDatabaseBytes } from "../../scripts/fixtures/canonical49-work";
import { CANONICAL_WORK_CORE_DEFINITIONS } from "./canonical-work-core-schema";
import { normalizeSchemaSql } from "./schema-cohort";
import {
  assertLegacyVersion42WorkSchema,
  assertProviderVersion40WorkSchema,
  installCanonicalVersion40WorkSchema,
  installCanonicalVersion42WorkSchema,
} from "./work-store";

const databases: Database[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close(false);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const memory = () => {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
};
const archive = async (bytes: Uint8Array) => {
  const root = await mkdtemp(join(tmpdir(), "hra-canonical-work-install-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  await writeFile(path, bytes, { mode: 0o600 });
  const database = new Database(path, { create: false, strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
};
const snapshot = (database: Database) => {
  const schema = z.array(z.object({ type: z.string(), name: z.string(), tbl_name: z.string(),
    sql: z.string().nullable() }).strict()).parse(database.query(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
  ).all());
  return {
    version: database.query("PRAGMA user_version").get(),
    schema: schema.map((row) => ({ ...row, sql: row.sql === null ? null : normalizeSchemaSql(row.sql) })),
    rows: schema.filter((row) => row.type === "table").map(({ name }) => {
      if (!/^[a-z_0-9]+$/u.test(name)) throw new Error("Unexpected SQLite fixture identifier.");
      return { name, rows: database.query(`SELECT * FROM "${name}"`).all() };
    }),
  };
};
// Empty parent stubs prove SQL installation only. They are expressly not an
// authentic database, parent-authority admission, or populated Work fixture.
const parents = (database: Database, omitCodexKey = false) => database.exec(`
  CREATE TABLE profiles (id TEXT PRIMARY KEY,state TEXT,process_generation INTEGER,
    provider_email TEXT${omitCodexKey ? "" : ",codex_account_key TEXT"}) STRICT;
  CREATE TABLE projects (id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE mutation_attempts (id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE sessions (id TEXT PRIMARY KEY,provider TEXT,provider_v39 TEXT,provider_thread_id TEXT,
    preset_contract INTEGER) STRICT;
  CREATE TABLE session_account_authorities (session_id TEXT,profile_id TEXT,account_key TEXT) STRICT;
  CREATE TABLE session_provider_account_authorities (session_id TEXT,provider TEXT,runtime_scope TEXT,account_key TEXT) STRICT;
  CREATE TABLE session_personal_runtime_bindings (session_id TEXT,provider TEXT,provider_thread_id TEXT,state TEXT) STRICT;
  CREATE TABLE provider_runtime_account_revocations (profile_id TEXT,profile_generation INTEGER,
    provider TEXT,runtime_scope TEXT,current_account_key TEXT,state TEXT) STRICT;
`);

describe("source-selected canonical Work installation", () => {
  test("pins the frozen core independently of evolving runtime schemas", () => {
    expect(CANONICAL_WORK_CORE_DEFINITIONS).toHaveLength(43);
    expect(CANONICAL_WORK_CORE_DEFINITIONS.filter(([type]) => type === "table")).toHaveLength(23);
    expect(CANONICAL_WORK_CORE_DEFINITIONS.filter(([type]) => type === "index")).toHaveLength(20);
    expect(createHash("sha256").update(JSON.stringify(CANONICAL_WORK_CORE_DEFINITIONS
      .map(([type, name, sql]) => [type, name, normalizeSchemaSql(sql)]))).digest("hex"))
      .toBe("afdf473c7a8d5012c0fb3f87d19337f2a2378d1152149aa479d582f673135635");
    expect(Object.isFrozen(CANONICAL_WORK_CORE_DEFINITIONS)).toBe(true);
    for (const definition of CANONICAL_WORK_CORE_DEFINITIONS) expect(Object.isFrozen(definition)).toBe(true);
  });

  test.each([40, 42] as const)("installs canonical%i with no usage registry or canonical-profile dependency", (version) => {
    const database = memory();
    parents(database);
    const install = version === 40 ? installCanonicalVersion40WorkSchema : installCanonicalVersion42WorkSchema;
    install(database);
    expect(database.query("SELECT name FROM sqlite_schema WHERE name='provider_accounts'").get()).toBeNull();
    expect(database.query("SELECT name FROM sqlite_schema WHERE name='work_signal_provider_authorities'").get()).toBeNull();
    expect(database.query("SELECT name FROM pragma_table_info('works') WHERE name='canonical_profile_key'").get()).toBeNull();
    expect(database.query("SELECT name FROM sqlite_schema WHERE type='trigger'").all()).toHaveLength(83);
    expect(database.query("SELECT * FROM work_clock").all()).toEqual([{ singleton: 1, logical_time: 0 }]);
    const beforeReplay = snapshot(database);
    install(database);
    expect(snapshot(database)).toEqual(beforeReplay);
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  });

  test("preserves all authentic canonical40 rows and schema on its own installation replay", async () => {
    const database = await archive(canonical40QueuesDatabaseBytes());
    const before = snapshot(database);
    installCanonicalVersion40WorkSchema(database);
    assertProviderVersion40WorkSchema(database);
    expect(snapshot(database)).toEqual(before);
  });

  test("preserves populated canonical49 Work/project and all other rows on canonical42–49 replay", async () => {
    const database = await archive(canonical49WorkDatabaseBytes());
    const before = snapshot(database);
    expect(database.query("SELECT id FROM work_attempts").all()).toHaveLength(1);
    installCanonicalVersion42WorkSchema(database);
    assertLegacyVersion42WorkSchema(database);
    expect(snapshot(database)).toEqual(before);
  });

  test("preserves an existing synthetic ALTER placement without rebuilding its table", () => {
    const database = memory();
    parents(database);
    const definition = CANONICAL_WORK_CORE_DEFINITIONS.find(([, name]) => name === "works");
    if (definition === undefined) throw new Error("Missing frozen works table.");
    const withoutContract = definition[2].replace(
      "  preset_contract INTEGER NOT NULL DEFAULT 1 CHECK(preset_contract IN (1,2)),\n", "",
    );
    expect(withoutContract).not.toBe(definition[2]);
    database.exec(withoutContract);
    database.exec("ALTER TABLE works ADD COLUMN preset_contract INTEGER NOT NULL DEFAULT 1 CHECK(preset_contract IN (1,2))");
    const before = database.query("SELECT sql FROM sqlite_schema WHERE name='works'").get();
    installCanonicalVersion40WorkSchema(database);
    installCanonicalVersion42WorkSchema(database);
    expect(database.query("SELECT sql FROM sqlite_schema WHERE name='works'").get()).toEqual(before);
    expect(database.query("SELECT * FROM works").all()).toEqual([]);
  });

  test("rolls back additive objects and seed rows when a parent prerequisite is absent", () => {
    const database = memory();
    parents(database, true);
    const before = snapshot(database);
    expect(() => installCanonicalVersion40WorkSchema(database)).toThrow("WORK_SCHEMA_STALE:profiles.codex_account_key");
    expect(snapshot(database)).toEqual(before);
  });
});
