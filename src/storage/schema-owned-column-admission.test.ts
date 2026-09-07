import { afterEach, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalAdoption40DatabaseBytes } from "../../scripts/fixtures/canonical-adoption40";
import { combined49DatabaseBytes } from "../../scripts/fixtures/combined49";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { normalizeSchemaSql } from "./schema-cohort";
import { StateStore } from "./state-store";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

const fixture = async (cohort: "current49" | "canonical40" | "combined49") => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-owned-column-ddl-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  cleanup.push(async () => { await rm(home, { recursive: true, force: true }); });
  if (cohort !== "current49") {
    await writeFile(paths.database, cohort === "canonical40"
      ? canonicalAdoption40DatabaseBytes() : combined49DatabaseBytes());
    await chmod(paths.database, 0o600);
  } else {
    const store = new StateStore(paths);
    store.close();
  }
  const database = new Database(paths.database, { strict: true });
  cleanup.push(async () => { database.close(); });
  return { paths, database };
};

const accountColumn = `codex_account_key TEXT CHECK(
  codex_account_key IS NULL OR (
    length(codex_account_key)=73
    AND substr(codex_account_key,1,9)='v1:codex:'
    AND substr(codex_account_key,10) NOT GLOB '*[^0-9a-f]*'
  )
)`;
const providerColumn = `provider_v39 TEXT NOT NULL DEFAULT 'codex'
CHECK(provider_v39 IN ('codex','claude','devin')
  AND (provider_v39!='devin' OR preset_contract=2))`;

const snapshot = (database: Database) => ({
  schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all(),
  version: database.query("PRAGMA user_version").get(),
  migrations: database.query("SELECT * FROM migrations ORDER BY version").all(),
  profiles: database.query("SELECT * FROM profiles ORDER BY id").all(),
  sessions: database.query("SELECT * FROM sessions ORDER BY id").all(),
});

// Rebuild only the disposable host table, retaining every row and dependent
// trigger/index verbatim. No writable_schema bypass or missing-object confound.
const replaceTable = (database: Database, table: string, change: (sql: string) => string): void => {
  const original = database.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string };
  const dependencies = database.query(
    "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('trigger','index') AND sql IS NOT NULL ORDER BY name",
  ).all(table) as { sql: string }[];
  const rows = database.query(`SELECT * FROM ${table}`).all() as Record<string, SQLQueryBindings>[];
  const columns = database.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const changed = change(original.sql);
  expect(changed).not.toBe(original.sql);
  database.exec("PRAGMA foreign_keys=OFF");
  database.transaction(() => {
    database.exec(`DROP TABLE ${table}`);
    database.exec(changed);
    const insert = database.query(`INSERT INTO ${table} (${columns.map(({ name }) => `"${name}"`).join(",")})
      VALUES (${columns.map(() => "?").join(",")})`);
    for (const row of rows) insert.run(...columns.map(({ name }) => row[name] ?? null));
    for (const dependency of dependencies) database.exec(dependency.sql);
  }).immediate();
  database.exec("PRAGMA foreign_keys=ON");
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(database.query(`SELECT * FROM ${table}`).all()).toEqual(rows);
};

for (const cohort of ["current49", "canonical40", "combined49"] as const) {
  test(`full ${cohort} admission rejects a weakened account key CHECK camouflaged by quoted text`, async () => {
    const { paths, database } = await fixture(cohort);
    const trusted = normalizeSchemaSql(accountColumn);
    const replacement = `codex_account_key TEXT CHECK(1) CHECK(length("${trusted}") > 0)`;
    const probe = new Database(":memory:");
    try {
      probe.exec(`CREATE TABLE original (${accountColumn}) STRICT`);
      probe.exec(`CREATE TABLE changed (${replacement}) STRICT`);
      expect(() => probe.query("INSERT INTO original VALUES (?)").run("invalid")).toThrow();
      expect(() => probe.query("INSERT INTO changed VALUES (?)").run("invalid")).not.toThrow();
    } finally { probe.close(); }
    replaceTable(database, "profiles", (sql) => normalizeSchemaSql(sql).replace(trusted, replacement));
    const before = snapshot(database);
    let opened: StateStore | undefined;
    try {
      expect(() => { opened = new StateStore(paths); }).toThrow("STATE_SCHEMA_V39_PROFILE_CODEX_ACCOUNT_KEY_INVALID");
    } finally { opened?.close(); }
    expect(snapshot(database)).toEqual(before);
  });

  const comments = cohort !== "canonical40" ? ["block", "line", "header"] as const : ["block"] as const;
  for (const comment of comments) test(`full ${cohort} admission rejects a weakened provider CHECK camouflaged by a ${comment} comment`, async () => {
    const { paths, database } = await fixture(cohort);
    const trusted = normalizeSchemaSql(providerColumn);
    const replacement = `"provider_v39" TEXT NOT NULL DEFAULT 'codex' CHECK(1)`
      + (comment === "block" ? ` /*, ${trusted}, */` : comment === "line" ? ` -- , ${trusted},\n` : "");
    const probe = new Database(":memory:");
    try {
      probe.exec(`CREATE TABLE original (preset_contract INTEGER, ${providerColumn}) STRICT`);
      probe.exec(`CREATE TABLE changed (preset_contract INTEGER, ${replacement}) STRICT`);
      expect(() => probe.query("INSERT INTO original VALUES (2,?)").run("unknown")).toThrow();
      expect(() => probe.query("INSERT INTO changed VALUES (2,?)").run("unknown")).not.toThrow();
    } finally { probe.close(); }
    replaceTable(database, "sessions", (sql) => {
      const changed = normalizeSchemaSql(sql).replace(trusted, replacement);
      if (comment !== "header") return changed;
      expect(changed).toStartWith("CREATE TABLE sessions (");
      return changed.replace("CREATE TABLE sessions (", `CREATE TABLE sessions /*( ${trusted} )*/ (`);
    });
    const before = snapshot(database);
    let opened: StateStore | undefined;
    try {
      expect(() => { opened = new StateStore(paths); }).toThrow("STATE_SCHEMA_V39_OBJECT_INVALID:sessions.provider_v39");
    } finally { opened?.close(); }
    expect(snapshot(database)).toEqual(before);
  });
}
