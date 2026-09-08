import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  assertLegacyCanonicalProfileRows,
  assertLegacyCanonicalProfileStorageAbsent,
  assertLegacyCanonicalProfileStorageSchema,
  deriveLegacySessionProfileKey,
  deriveLegacyWorkProfileKey,
  LEGACY_CANONICAL_PROFILE_BACKFILL_SQL,
  LEGACY_CANONICAL_PROFILE_COLUMNS_SQL,
  LEGACY_CANONICAL_PROFILE_GUARDS_SQL,
} from "./canonical-profile-storage";

// Deliberately reduced STRICT unit fixture, NOT the production StateStore
// schema, an upgrade proof, or a replacement for Work authority tests.
const UNIT_FIXTURE_SQL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  provider_v39 TEXT NOT NULL,
  preset TEXT NOT NULL,
  preset_contract INTEGER NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE works (
  id TEXT PRIMARY KEY,
  coordinator_session_id TEXT NOT NULL REFERENCES sessions(id),
  preset_contract INTEGER NOT NULL
) STRICT;
CREATE TABLE work_routes (
  work_id TEXT NOT NULL REFERENCES works(id),
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  preset TEXT NOT NULL,
  fast INTEGER NOT NULL,
  PRIMARY KEY(work_id,account_id,project_id,preset,fast)
) STRICT;
CREATE TABLE work_tasks (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  preset TEXT NOT NULL,
  fast INTEGER NOT NULL,
  UNIQUE(work_id,id),
  FOREIGN KEY(work_id,account_id,project_id,preset,fast)
    REFERENCES work_routes(work_id,account_id,project_id,preset,fast)
) STRICT;
CREATE TABLE work_attempts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  worker_session_id TEXT NOT NULL REFERENCES sessions(id),
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  preset TEXT NOT NULL,
  fast INTEGER NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id)
) STRICT;
-- These frozen blanket guards remain authoritative after additive columns.
-- Their presence here models the companion's dependency, not full Work DDL.
CREATE TRIGGER work_routes_no_update
BEFORE UPDATE ON work_routes BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_IMMUTABLE'); END;
CREATE TRIGGER work_tasks_no_update
BEFORE UPDATE ON work_tasks BEGIN SELECT RAISE(ABORT,'WORK_TASK_IMMUTABLE'); END;
CREATE TRIGGER work_attempt_revision_guard
BEFORE UPDATE ON work_attempts WHEN NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_REVISION'); END;
`;

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const unitDatabase = (options: Readonly<{
  fixtureSql?: string;
  columnsSql?: string;
  guardsSql?: string;
}> = {}): Database => {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  database.exec(options.fixtureSql ?? UNIT_FIXTURE_SQL);
  const columnsSql = options.columnsSql ?? LEGACY_CANONICAL_PROFILE_COLUMNS_SQL;
  if (columnsSql.length > 0) database.exec(columnsSql);
  const guardsSql = options.guardsSql ?? LEGACY_CANONICAL_PROFILE_GUARDS_SQL;
  if (guardsSql.length > 0) database.exec(guardsSql);
  return database;
};

const LUNA = "codex:gpt-5.6-luna:max";
const SOL = "codex:gpt-5.6-sol:max";
const SOL_ULTRA = "codex:gpt-5.6-sol:ultra";
const ASTRA = "codex:gpt-6-astra:max";
const ASTRA_ULTRA = "codex:gpt-6-astra:ultra";
const FABLE = "claude:claude-fable-5-1:max";
const DEVIN = "devin:gpt-6-astra:provider-default";

// An independent, closed oracle, not generated from the current catalog or SQL.
const SESSION_CASES = [
  ["codex", "low", 1, LUNA],
  ["codex", "low", 2, LUNA],
  ["codex", "high", 1, SOL],
  ["codex", "high", 2, ASTRA],
  ["codex", "ultra", 1, SOL_ULTRA],
  ["codex", "ultra", 2, ASTRA_ULTRA],
  ["claude", "ultra", 1, FABLE],
  ["claude", "ultra", 2, FABLE],
  ["devin", "ultra", 2, DEVIN],
] as const;
const WORK_CASES = SESSION_CASES.filter(([provider]) => provider === "codex");
const LIVE_STATES = ["claimed", "dispatching", "running", "recovery_required"] as const;
const NON_FENCED_STATES = [
  "submitted", "blocked", "completed", "failed", "released", "expired", "cancelled",
] as const;
const COMPANION_NAMES = [
  "canonical_profile_session_insert_guard",
  "canonical_profile_session_update_guard",
  "canonical_profile_work_route_insert_guard",
  "canonical_profile_work_task_insert_guard",
  "canonical_profile_work_attempt_insert_guard",
  "canonical_profile_work_attempt_immutable_guard",
  "canonical_profile_session_live_attempt_guard",
] as const;

describe("canonical predecessor absence and key-only backfill unit boundary", () => {
  test("proves absent authority without changing an empty or populated predecessor", () => {
    const database = unitDatabase({ columnsSql: "", guardsSql: "" });
    database.exec("INSERT INTO sessions(id,provider_v39,preset,preset_contract) VALUES ('legacy','codex','high',2)");
    database.exec("PRAGMA query_only=ON");
    const before = database.serialize();
    expect(() => assertLegacyCanonicalProfileStorageAbsent(database)).not.toThrow();
    expect(database.serialize()).toEqual(before);
  });

  test.each(["sessions", "work_routes", "work_tasks", "work_attempts"])(
    "refuses a hidden case-variant key on predecessor %s without writes", (table) => {
      const database = unitDatabase({ columnsSql: "", guardsSql: "" });
      database.exec(`ALTER TABLE ${table} ADD COLUMN Canonical_Profile_Key TEXT GENERATED ALWAYS AS ('foreign') VIRTUAL`);
      database.exec("PRAGMA query_only=ON");
      const before = database.serialize();
      expect(() => assertLegacyCanonicalProfileStorageAbsent(database))
        .toThrow("CANONICAL_PROFILE_PREDECESSOR_COLUMN_COLLISION");
      expect(database.serialize()).toEqual(before);
    },
  );

  test.each([...COMPANION_NAMES])("refuses a non-trigger collision for %s without writes", (name) => {
    const database = unitDatabase({ columnsSql: "", guardsSql: "" });
    database.exec(`CREATE VIEW ${name.toUpperCase()} AS SELECT 1`);
    database.exec("PRAGMA query_only=ON");
    const before = database.serialize();
    expect(() => assertLegacyCanonicalProfileStorageAbsent(database))
      .toThrow("CANONICAL_PROFILE_PREDECESSOR_OBJECT_COLLISION");
    expect(database.serialize()).toEqual(before);
  });

  test.each(SESSION_CASES)("backfills only the frozen %s/%s contract %i key", (provider, preset, contract, key) => {
    const database = unitDatabase({ guardsSql: "" });
    insertSession(database, "worker", provider, preset, contract, null);
    const before = database.query("SELECT id,provider_v39,preset,preset_contract,project_id,title FROM sessions").get();
    database.exec(LEGACY_CANONICAL_PROFILE_BACKFILL_SQL);
    expect(database.query("SELECT canonical_profile_key FROM sessions").get()).toEqual({ canonical_profile_key: key });
    expect(database.query("SELECT id,provider_v39,preset,preset_contract,project_id,title FROM sessions").get()).toEqual(before);
    expect(() => assertLegacyCanonicalProfileRows(database)).not.toThrow();
  });

  test.each(WORK_CASES)("backfills Work from its own %s/%s contract %i after worker reselection", (_provider, preset, contract, key) => {
    const database = unitDatabase({ guardsSql: "" });
    insertSession(database, "worker", "claude", "ultra", 1, null);
    insertWork(database, contract);
    insertRoute(database, preset, null);
    insertTask(database, preset, null);
    insertAttempt(database, "released", preset, null);
    const before = database.query("SELECT id,state,revision FROM work_attempts").get();
    // Unit-only removal of the three modeled guards. The real migration must
    // prove and restore exact production bodies under its owned transaction.
    database.exec("DROP TRIGGER work_routes_no_update; DROP TRIGGER work_tasks_no_update; DROP TRIGGER work_attempt_revision_guard");
    database.exec(LEGACY_CANONICAL_PROFILE_BACKFILL_SQL);
    for (const table of ["work_routes", "work_tasks", "work_attempts"]) {
      expect(database.query(`SELECT canonical_profile_key FROM ${table}`).get()).toEqual({ canonical_profile_key: key });
    }
    expect(database.query("SELECT canonical_profile_key FROM sessions").get()).toEqual({ canonical_profile_key: FABLE });
    expect(database.query("SELECT id,state,revision FROM work_attempts").get()).toEqual(before);
    expect(() => assertLegacyCanonicalProfileRows(database)).not.toThrow();
  });
});

const insertSession = (
  database: Database,
  id = "worker",
  provider = "codex",
  preset = "high",
  contract = 1,
  key: string | null = SOL,
): void => {
  database.query(`
    INSERT INTO sessions(id,provider_v39,preset,preset_contract,project_id,canonical_profile_key)
    VALUES (?,?,?,?,'project',?)
  `).run(id, provider, preset, contract, key);
};

const insertWork = (database: Database, contract = 1, id = "work"): void => {
  database.query(`
    INSERT INTO works(id,coordinator_session_id,preset_contract) VALUES (?,'worker',?)
  `).run(id, contract);
};

const insertRoute = (database: Database, preset = "high", key: string | null = SOL): void => {
  database.query(`
    INSERT INTO work_routes(work_id,account_id,project_id,preset,fast,canonical_profile_key)
    VALUES ('work','account','project',?,0,?)
  `).run(preset, key);
};

const insertTask = (database: Database, preset = "high", key: string | null = SOL): void => {
  database.query(`
    INSERT INTO work_tasks(id,work_id,account_id,project_id,preset,fast,canonical_profile_key)
    VALUES ('task','work','account','project',?,0,?)
  `).run(preset, key);
};

const insertAttempt = (
  database: Database,
  state = "claimed",
  preset = "high",
  key: string | null = SOL,
): void => {
  database.query(`
    INSERT INTO work_attempts(id,work_id,task_id,worker_session_id,account_id,project_id,preset,fast,state,canonical_profile_key)
    VALUES ('attempt','work','task','worker','account','project',?,0,?,?)
  `).run(preset, state, key);
};

const seedAttempt = (database: Database, state = "claimed", preset = "high", key = SOL): void => {
  insertSession(database, "worker", "codex", preset, 1, key);
  insertWork(database);
  insertRoute(database, preset, key);
  insertTask(database, preset, key);
  insertAttempt(database, state, preset, key);
};

describe("legacy canonical profile storage unit fixture", () => {
  test("rejects a forged historical session key through raw SQL", () => {
    const database = unitDatabase();
    expect(() => database.query(`
      INSERT INTO sessions(id,provider_v39,preset,preset_contract,canonical_profile_key)
      VALUES ('worker','codex','high',1,'codex:gpt-6-astra:max')
    `).run()).toThrow("CANONICAL_PROFILE_SESSION_COHERENCE");
  });

  test.each(SESSION_CASES)("decodes and persists frozen %s/%s contract %i", (provider, preset, contract, key) => {
    const database = unitDatabase();
    expect(deriveLegacySessionProfileKey(provider, preset, contract)).toBe(key);
    insertSession(database, "worker", provider, preset, contract, key);
    expect(database.query("SELECT canonical_profile_key FROM sessions").get()).toEqual({
      canonical_profile_key: key,
    });
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).not.toThrow();
  });

  test.each([
    ["codex", "high", 3], ["codex", "high", "1"], ["codex", "fable-max", 1],
    ["codex", "astra", 2], ["claude", "low", 1], ["claude", "high", 2],
    ["claude", "fable-max", 1], ["devin", "ultra", 1], ["devin", "low", 2],
    ["devin", "high", 2], ["foreign", "ultra", 2], ["CODEX", "high", 1],
    [null, "high", 1], ["codex", undefined, 1], ["codex", "high", {}],
  ])("refuses nonhistorical session inputs %s/%s/%s", (provider, preset, contract) => {
    expect(deriveLegacySessionProfileKey(provider, preset, contract)).toBeNull();
  });

  test("derivation never evaluates object accessors or coercion hooks", () => {
    let observed = 0;
    const hostile = Object.defineProperty({}, "toString", { get: () => { observed++; throw new Error("private"); } });
    for (const value of [hostile, [], Symbol("private"), () => "codex", true, 1n]) {
      expect(deriveLegacySessionProfileKey(value, "high", 1)).toBeNull();
      expect(deriveLegacySessionProfileKey("codex", value, 1)).toBeNull();
      expect(deriveLegacySessionProfileKey("codex", "high", value)).toBeNull();
      expect(deriveLegacyWorkProfileKey(value, 1)).toBeNull();
      expect(deriveLegacyWorkProfileKey("high", value)).toBeNull();
    }
    expect(observed).toBe(0);
  });

  test.each([null, "", "foreign:key", SOL.toUpperCase(), FABLE, ASTRA])(
    "rejects missing, foreign, case-variant or incoherent session key %s",
    (key) => {
      const database = unitDatabase();
      expect(() => insertSession(database, "worker", "codex", "high", 1, key))
        .toThrow("CANONICAL_PROFILE_SESSION_COHERENCE");
      expect(database.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    },
  );

  test("rejects omitted keys and invalid legacy tuples even with NULL expected keys", () => {
    const database = unitDatabase();
    expect(() => database.exec(`
      INSERT INTO sessions(id,provider_v39,preset,preset_contract)
      VALUES ('worker','codex','high',1)
    `)).toThrow("CANONICAL_PROFILE_SESSION_COHERENCE");
    for (const [provider, preset, contract] of [
      ["claude", "low", 1], ["devin", "ultra", 1], ["codex", "high", 3],
    ] as const) {
      for (const key of [null, SOL, DEVIN]) {
        expect(() => insertSession(database, "worker", provider, preset, contract, key))
          .toThrow("CANONICAL_PROFILE_SESSION_COHERENCE");
      }
    }
  });

  test("session coherence rejects one-sided changes and admits an atomic valid pair", () => {
    const database = unitDatabase();
    insertSession(database);
    for (const assignment of [
      "canonical_profile_key=NULL", `canonical_profile_key='${ASTRA}'`,
      "preset_contract=2", "provider_v39='claude'", "preset='ultra'",
    ]) {
      expect(() => database.exec(`UPDATE sessions SET ${assignment},title='changed'`))
        .toThrow("CANONICAL_PROFILE_SESSION_COHERENCE");
      expect(database.query("SELECT title,canonical_profile_key FROM sessions").get())
        .toEqual({ title: "", canonical_profile_key: SOL });
    }
    database.query("UPDATE sessions SET preset_contract=2,canonical_profile_key=?,title='changed'").run(ASTRA);
    expect(database.query("SELECT title,canonical_profile_key FROM sessions").get())
      .toEqual({ title: "changed", canonical_profile_key: ASTRA });
  });

  test.each(WORK_CASES)("persists the owning Work contract for %s/%s/%i", (_provider, preset, contract, key) => {
    const database = unitDatabase();
    // A non-Codex coordinator cannot redefine the explicit Codex Work route.
    insertSession(database, "worker", "claude", "ultra", 1, FABLE);
    insertWork(database, contract);
    insertRoute(database, preset, key);
    insertTask(database, preset, key);
    expect(deriveLegacyWorkProfileKey(preset, contract)).toBe(key);
    expect(database.query("SELECT canonical_profile_key FROM work_routes").get())
      .toEqual({ canonical_profile_key: key });
    expect(database.query("SELECT canonical_profile_key FROM work_tasks").get())
      .toEqual({ canonical_profile_key: key });
  });

  test("a historical Devin coordinator does not supply Work identity", () => {
    const database = unitDatabase();
    insertSession(database, "worker", "devin", "ultra", 2, DEVIN);
    insertWork(database, 1);
    insertRoute(database, "ultra", SOL_ULTRA);
    expect(database.query("SELECT canonical_profile_key FROM work_routes").get())
      .toEqual({ canonical_profile_key: SOL_ULTRA });
    expect(deriveLegacyWorkProfileKey("astra", 2)).toBeNull();
    expect(deriveLegacyWorkProfileKey("fable-max", 1)).toBeNull();
    expect(deriveLegacyWorkProfileKey("high", 3)).toBeNull();
  });

  test.each([null, "foreign:key", SOL.toUpperCase(), FABLE, ASTRA])(
    "rejects invalid Work route/task/attempt keys %s", (key) => {
      const database = unitDatabase();
      insertSession(database);
      insertWork(database);
      expect(() => insertRoute(database, "high", key)).toThrow("CANONICAL_PROFILE_WORK_ROUTE_COHERENCE");
      insertRoute(database);
      expect(() => insertTask(database, "high", key)).toThrow("CANONICAL_PROFILE_WORK_TASK_COHERENCE");
      insertTask(database);
      expect(() => insertAttempt(database, "claimed", "high", key)).toThrow("CANONICAL_PROFILE_WORK_ATTEMPT_COHERENCE");
    },
  );

  test("requires parent Work, route, task and worker instead of accepting missing-parent NULL", () => {
    const database = unitDatabase();
    for (const key of [null, SOL]) {
      expect(() => insertRoute(database, "high", key)).toThrow("CANONICAL_PROFILE_WORK_ROUTE_COHERENCE");
      expect(() => insertTask(database, "high", key)).toThrow("CANONICAL_PROFILE_WORK_TASK_COHERENCE");
      expect(() => insertAttempt(database, "claimed", "high", key)).toThrow("CANONICAL_PROFILE_WORK_ATTEMPT_COHERENCE");
    }
    insertSession(database);
    insertWork(database);
    insertRoute(database);
    insertTask(database);
    expect(() => database.query(`
      INSERT INTO work_attempts(id,work_id,task_id,worker_session_id,account_id,project_id,preset,fast,state,canonical_profile_key)
      VALUES ('attempt','work','task','missing','account','project','high',0,'claimed',?)
    `).run(SOL)).toThrow("CANONICAL_PROFILE_WORK_ATTEMPT_COHERENCE");
  });

  test.each(["work_id", "account_id", "project_id", "preset", "fast"] as const)(
    "a matching key does not excuse a wrong parent route/task %s", (column) => {
      const database = unitDatabase();
      insertSession(database);
      insertWork(database);
      insertWork(database, 1, "other-work");
      insertRoute(database);
      const tuple = ["work", "account", "project", "high", 0];
      const index = ["work_id", "account_id", "project_id", "preset", "fast"].indexOf(column);
      tuple[index] = column === "fast" ? 1 : column === "work_id" ? "other-work" : "other";
      expect(() => database.query(`
        INSERT INTO work_tasks(id,work_id,account_id,project_id,preset,fast,canonical_profile_key)
        VALUES ('task',?,?,?,?,?,?)
      `).run(...tuple, SOL)).toThrow("CANONICAL_PROFILE_WORK_TASK_COHERENCE");
      insertTask(database);
      expect(() => database.query(`
        INSERT INTO work_attempts(id,task_id,worker_session_id,work_id,account_id,project_id,preset,fast,state,canonical_profile_key)
        VALUES ('attempt','task','worker',?,?,?,?,?,'claimed',?)
      `).run(...tuple, SOL)).toThrow("CANONICAL_PROFILE_WORK_ATTEMPT_COHERENCE");
    },
  );

  test("new attempts require the exact worker key even for a terminal insert", () => {
    const database = unitDatabase();
    insertSession(database, "worker", "codex", "high", 2, ASTRA);
    insertWork(database, 1);
    insertRoute(database);
    insertTask(database);
    for (const state of [...LIVE_STATES, ...NON_FENCED_STATES]) {
      expect(() => insertAttempt(database, state)).toThrow("CANONICAL_PROFILE_WORK_ATTEMPT_COHERENCE");
    }
  });

  test.each([...LIVE_STATES])("fences a coherent session identity change during %s", (state) => {
    const database = unitDatabase();
    seedAttempt(database, state);
    const before = database.query("SELECT * FROM sessions").get();
    expect(() => database.query(`
      UPDATE sessions SET preset_contract=2,canonical_profile_key=?,title='changed'
    `).run(ASTRA)).toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
    expect(database.query("SELECT * FROM sessions").get()).toEqual(before);
    database.exec("UPDATE sessions SET title='allowed'");
    database.query("UPDATE sessions SET canonical_profile_key=?").run(SOL);
    expect(database.query("SELECT title,canonical_profile_key FROM sessions").get())
      .toEqual({ title: "allowed", canonical_profile_key: SOL });
  });

  test.each([...NON_FENCED_STATES])("preserves %s attempt history after a legitimate session switch", (state) => {
    const database = unitDatabase();
    seedAttempt(database, state);
    database.query("UPDATE sessions SET preset_contract=2,canonical_profile_key=?").run(ASTRA);
    database.exec("UPDATE work_attempts SET revision=revision+1");
    expect(database.query("SELECT canonical_profile_key FROM work_attempts").get())
      .toEqual({ canonical_profile_key: SOL });
    expect(database.query("SELECT canonical_profile_key FROM sessions").get())
      .toEqual({ canonical_profile_key: ASTRA });
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).not.toThrow();
  });

  test("the equal Luna key preserves cross-contract Work admission and live no-ops", () => {
    const database = unitDatabase();
    seedAttempt(database, "claimed", "low", LUNA);
    database.query("UPDATE sessions SET preset_contract=2,canonical_profile_key=?").run(LUNA);
    database.exec("DELETE FROM work_attempts");
    insertAttempt(database, "claimed", "low", LUNA);
    expect(database.query("SELECT canonical_profile_key FROM work_attempts").get())
      .toEqual({ canonical_profile_key: LUNA });
  });

  test.each([...LIVE_STATES, ...NON_FENCED_STATES])("keeps attempt identity immutable in %s", (state) => {
    const database = unitDatabase();
    seedAttempt(database, state);
    const before = database.query("SELECT * FROM work_attempts").get();
    for (const key of [null, "foreign:key", SOL.toUpperCase(), ASTRA, FABLE]) {
      expect(() => database.query(`
        UPDATE work_attempts SET canonical_profile_key=?,revision=revision+1
      `).run(key)).toThrow("WORK_ATTEMPT_AUTHORITY_IMMUTABLE");
      expect(database.query("SELECT * FROM work_attempts").get()).toEqual(before);
    }
    database.query("UPDATE work_attempts SET canonical_profile_key=?,revision=revision+1").run(SOL);
    expect(database.query("SELECT revision FROM work_attempts").get()).toEqual({ revision: 2 });
  });

  test("composes with the frozen blanket route/task update guards", () => {
    const database = unitDatabase();
    seedAttempt(database);
    for (const [table, error] of [["work_routes", "WORK_ROUTE_IMMUTABLE"], ["work_tasks", "WORK_TASK_IMMUTABLE"]]) {
      expect(() => database.query(`UPDATE ${table} SET canonical_profile_key=?`).run(ASTRA)).toThrow(error);
      expect(() => database.query(`UPDATE ${table} SET canonical_profile_key=?`).run(SOL)).toThrow(error);
    }
    expect(() => database.query("UPDATE work_attempts SET canonical_profile_key=?").run(SOL))
      .toThrow("WORK_ATTEMPT_REVISION");
  });

  test("BINARY key guards do not inherit a weakened column collation", () => {
    const database = unitDatabase({
      columnsSql: LEGACY_CANONICAL_PROFILE_COLUMNS_SQL.replaceAll("key TEXT", "key TEXT COLLATE NOCASE"),
    });
    // The assertion proves nullable TEXT shape, not an entire legacy table DDL.
    // Explicit comparisons must remain exact even with altered key collation.
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).not.toThrow();
    expect(() => insertSession(database, "worker", "codex", "high", 1, SOL.toUpperCase()))
      .toThrow("CANONICAL_PROFILE_SESSION_COHERENCE");
    seedAttempt(database);
    expect(() => insertRoute(database, "high", SOL.toUpperCase()))
      .toThrow("CANONICAL_PROFILE_WORK_ROUTE_COHERENCE");
    expect(() => insertTask(database, "high", SOL.toUpperCase()))
      .toThrow("CANONICAL_PROFILE_WORK_TASK_COHERENCE");
    expect(() => insertAttempt(database, "claimed", "high", SOL.toUpperCase()))
      .toThrow("CANONICAL_PROFILE_WORK_ATTEMPT_COHERENCE");
    expect(() => database.query("UPDATE sessions SET canonical_profile_key=?").run(SOL.toUpperCase()))
      .toThrow();
    expect(() => database.query("UPDATE work_attempts SET canonical_profile_key=?,revision=revision+1").run(SOL.toUpperCase()))
      .toThrow("WORK_ATTEMPT_AUTHORITY_IMMUTABLE");
  });
});

describe("legacy canonical profile companion metadata (not migration admission)", () => {
  test("all columns are physically nullable without an invented default; guards enforce new writes", () => {
    const database = unitDatabase();
    for (const table of ["sessions", "work_routes", "work_tasks", "work_attempts"]) {
      expect(database.query(`
        SELECT name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?)
        WHERE name='canonical_profile_key'
      `).get(table)).toEqual({ name: "canonical_profile_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 });
    }
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).not.toThrow();
    expect(() => database.exec(LEGACY_CANONICAL_PROFILE_COLUMNS_SQL)).toThrow();
    expect(() => database.exec(LEGACY_CANONICAL_PROFILE_GUARDS_SQL)).toThrow();
    expect(LEGACY_CANONICAL_PROFILE_GUARDS_SQL).not.toContain("IF NOT EXISTS");
    expect(LEGACY_CANONICAL_PROFILE_GUARDS_SQL).not.toContain("codex_account_key");
    expect(LEGACY_CANONICAL_PROFILE_GUARDS_SQL).not.toContain("session_provider_account_authorities");
  });

  test.each(["sessions", "work_routes", "work_tasks", "work_attempts"])("refuses a missing %s key column", (table) => {
    const database = unitDatabase({
      columnsSql: LEGACY_CANONICAL_PROFILE_COLUMNS_SQL.replace(`ALTER TABLE ${table} ADD COLUMN canonical_profile_key TEXT;`, ""),
    });
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).toThrow(`CANONICAL_PROFILE_SCHEMA_COLUMN:${table}`);
  });

  test.each([
    "Canonical_Profile_Key TEXT",
    "canonical_profile_key INTEGER",
    "canonical_profile_key TEXT NOT NULL",
    "canonical_profile_key TEXT DEFAULT 'invented'",
    "canonical_profile_key TEXT GENERATED ALWAYS AS ('invented') VIRTUAL",
    "canonical_profile_key TEXT GENERATED ALWAYS AS ('invented') STORED",
  ])("refuses altered column metadata %s", (declaration) => {
    const database = unitDatabase({
      columnsSql: LEGACY_CANONICAL_PROFILE_COLUMNS_SQL.replace(
        "ALTER TABLE sessions ADD COLUMN canonical_profile_key TEXT;",
        `ALTER TABLE sessions ADD COLUMN ${declaration};`,
      ),
    });
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).toThrow("CANONICAL_PROFILE_SCHEMA_COLUMN:sessions");
  });

  test("refuses a canonical key repurposed as a primary key", () => {
    const database = unitDatabase({
      fixtureSql: UNIT_FIXTURE_SQL.replace("id TEXT PRIMARY KEY,", "id TEXT UNIQUE, canonical_profile_key TEXT PRIMARY KEY,"),
      columnsSql: LEGACY_CANONICAL_PROFILE_COLUMNS_SQL.replace("ALTER TABLE sessions ADD COLUMN canonical_profile_key TEXT;", ""),
    });
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).toThrow("CANONICAL_PROFILE_SCHEMA_COLUMN:sessions");
  });

  test("refuses a non-STRICT table or disabled foreign keys", () => {
    const database = unitDatabase({ fixtureSql: UNIT_FIXTURE_SQL.replace(") STRICT;", ");") });
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).toThrow("CANONICAL_PROFILE_SCHEMA_TABLE:sessions");
    const strictDatabase = unitDatabase();
    strictDatabase.exec("PRAGMA foreign_keys=OFF");
    expect(() => assertLegacyCanonicalProfileStorageSchema(strictDatabase)).toThrow("CANONICAL_PROFILE_SCHEMA_FOREIGN_KEYS");
  });

  test.each([...COMPANION_NAMES])("refuses missing or weakened %s", (name) => {
    const database = unitDatabase();
    const trigger = database.query("SELECT tbl_name FROM sqlite_master WHERE name=?").get(name) as { tbl_name: string };
    database.exec(`DROP TRIGGER ${name}`);
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).toThrow(`CANONICAL_PROFILE_SCHEMA_TRIGGER:${name}`);
    database.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON ${trigger.tbl_name} BEGIN SELECT 1; END;`);
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).toThrow(`CANONICAL_PROFILE_SCHEMA_TRIGGER:${name}`);
  });

  test.each(["table", "view", "index", "case-variant trigger", "moved trigger"])("refuses a companion object collision: %s", (kind) => {
    const database = unitDatabase();
    const name = "canonical_profile_session_insert_guard";
    database.exec(`DROP TRIGGER ${name}`);
    if (kind === "table") database.exec(`CREATE TABLE ${name.toUpperCase()} (id TEXT) STRICT`);
    else if (kind === "view") database.exec(`CREATE VIEW ${name.toUpperCase()} AS SELECT 1 AS id`);
    else if (kind === "index") database.exec(`CREATE INDEX ${name.toUpperCase()} ON sessions(title)`);
    else if (kind === "case-variant trigger") database.exec(`CREATE TRIGGER ${name.toUpperCase()} BEFORE INSERT ON sessions BEGIN SELECT 1; END;`);
    else database.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON works BEGIN SELECT 1; END;`);
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).toThrow(`CANONICAL_PROFILE_SCHEMA_TRIGGER:${name}`);
  });

  test("refuses cross-namespace collisions even beside an exact trigger", () => {
    const database = unitDatabase();
    database.exec("CREATE TABLE CANONICAL_PROFILE_SESSION_INSERT_GUARD (id TEXT) STRICT");
    expect(() => assertLegacyCanonicalProfileStorageSchema(database))
      .toThrow("CANONICAL_PROFILE_SCHEMA_TRIGGER:canonical_profile_session_insert_guard");
  });

  test("metadata assertions never bless row debt or perform a backfill", () => {
    const database = unitDatabase({ guardsSql: "" });
    database.exec("INSERT INTO sessions(id,provider_v39,preset,preset_contract) VALUES ('legacy','codex','high',1)");
    database.exec(LEGACY_CANONICAL_PROFILE_GUARDS_SQL);
    const before = database.serialize();
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).not.toThrow();
    expect(database.serialize()).toEqual(before);
    expect(database.query("SELECT canonical_profile_key FROM sessions").get()).toEqual({ canonical_profile_key: null });
  });
});

const ROW_TABLES = ["sessions", "work_routes", "work_tasks", "work_attempts"] as const;
const rowProofDatabase = (
  fixtureSql = UNIT_FIXTURE_SQL,
  columnsSql = LEGACY_CANONICAL_PROFILE_COLUMNS_SQL,
): Database => {
  const database = unitDatabase({ fixtureSql, columnsSql, guardsSql: "" });
  // A unit-only mutation sentinel, not the production migration ledger.
  database.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY) STRICT;
    INSERT INTO schema_migrations(version) VALUES (49);
    PRAGMA user_version=49;
  `);
  return database;
};

const seedRowsForProof = (
  database: Database,
  keys: Partial<Record<typeof ROW_TABLES[number], string | null>> = {},
): void => {
  const { sessions = SOL, work_routes = SOL, work_tasks = SOL, work_attempts = SOL } = keys;
  insertSession(database, "worker", "codex", "high", 1, sessions);
  insertWork(database);
  insertRoute(database, "high", work_routes);
  insertTask(database, "high", work_tasks);
  insertAttempt(database, "claimed", "high", work_attempts);
};

const expectReadOnlyRowProof = (database: Database, error?: string): void => {
  database.exec("PRAGMA query_only=ON");
  const before = database.serialize();
  const changes = database.query("SELECT total_changes() AS changes").get();
  const schemaVersion = database.query("PRAGMA schema_version").get();
  database.transaction(() => {
    expect(database.inTransaction).toBe(true);
    if (error === undefined) expect(() => assertLegacyCanonicalProfileRows(database)).not.toThrow();
    else {
      let failure: unknown;
      try { assertLegacyCanonicalProfileRows(database); } catch (caught) { failure = caught; }
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.message : null).toBe(error);
    }
    expect(database.inTransaction).toBe(true);
  })();
  expect(database.serialize()).toEqual(before);
  expect(database.query("SELECT total_changes() AS changes").get()).toEqual(changes);
  expect(database.query("PRAGMA schema_version").get()).toEqual(schemaVersion);
  expect(database.query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
};

describe("legacy canonical populated rows (not migration admission)", () => {
  test("refuses an existing NULL key even when exact companion metadata passes", () => {
    const database = unitDatabase({ guardsSql: "" });
    insertSession(database, "legacy", "codex", "high", 1, null);
    database.exec(LEGACY_CANONICAL_PROFILE_GUARDS_SQL);
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).not.toThrow();
    const before = database.serialize();
    expect(() => assertLegacyCanonicalProfileRows(database))
      .toThrow("CANONICAL_PROFILE_ROWS_SESSIONS");
    expect(database.serialize()).toEqual(before);
  });

  test("accepts empty rows without installing guards, filling keys or stamping a ledger", () => {
    expectReadOnlyRowProof(rowProofDatabase());
  });

  test.each([...ROW_TABLES])("returns a fixed error when the populated %s query cannot be read", (table) => {
    const database = rowProofDatabase(UNIT_FIXTURE_SQL, LEGACY_CANONICAL_PROFILE_COLUMNS_SQL.replace(
      `ALTER TABLE ${table} ADD COLUMN canonical_profile_key TEXT;`, "",
    ));
    expectReadOnlyRowProof(database, `CANONICAL_PROFILE_ROWS_${table.toUpperCase()}`);
  });

  test.each([
    ["absent", undefined], ["null", null], ["empty", {}], ["string", { invalid: "0" }],
    ["foreign integer", { invalid: 2 }], ["extra field", { invalid: 0, private: "not row evidence" }],
  ] as const)("refuses a malformed bounded scalar: %s", (_name, value) => {
    const database = rowProofDatabase();
    const before = database.serialize();
    const statement = database.query("SELECT 0 AS invalid");
    const query = spyOn(database, "query").mockReturnValue(statement);
    const read = spyOn(statement, "get").mockReturnValue(value);
    try {
      expect(() => assertLegacyCanonicalProfileRows(database)).toThrow("CANONICAL_PROFILE_ROWS_SESSIONS");
    } finally {
      read.mockRestore();
      query.mockRestore();
    }
    expect(database.serialize()).toEqual(before);
  });

  test("never includes a foreign SQLite read error in the fixed refusal", () => {
    const database = rowProofDatabase();
    const before = database.serialize();
    const statement = database.query("SELECT 0 AS invalid");
    const query = spyOn(database, "query").mockReturnValue(statement);
    const read = spyOn(statement, "get").mockImplementation(() => { throw new Error("private payload"); });
    let failure: unknown;
    try {
      assertLegacyCanonicalProfileRows(database);
    } catch (error) {
      failure = error;
    } finally {
      read.mockRestore();
      query.mockRestore();
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : null).toBe("CANONICAL_PROFILE_ROWS_SESSIONS");
    expect(database.serialize()).toEqual(before);
  });

  test("checks main rows even when an empty temporary table shadows sessions", () => {
    const database = rowProofDatabase();
    insertSession(database, "legacy", "codex", "high", 1, null);
    database.exec("CREATE TEMP TABLE sessions AS SELECT * FROM main.sessions WHERE 0");
    expectReadOnlyRowProof(database, "CANONICAL_PROFILE_ROWS_SESSIONS");
  });

  test.each(SESSION_CASES)("recognizes populated frozen %s/%s contract %i", (provider, preset, contract, key) => {
    const database = rowProofDatabase();
    insertSession(database, "historical", provider, preset, contract, key);
    expectReadOnlyRowProof(database);
  });

  test.each(WORK_CASES)("proves populated Work's own %s/%s contract %i after worker reselection", (_provider, preset, contract, key) => {
    const database = rowProofDatabase();
    insertSession(database, "worker", "codex", preset, contract, key);
    insertSession(database, "coordinator", "claude", "ultra", contract, FABLE);
    insertWork(database, contract);
    database.exec("UPDATE works SET coordinator_session_id='coordinator'");
    insertRoute(database, preset, key);
    insertTask(database, preset, key);
    insertAttempt(database, "completed", preset, key);
    database.query("UPDATE sessions SET preset='low',preset_contract=2,canonical_profile_key=? WHERE id='worker'").run(LUNA);
    expect(database.query("SELECT canonical_profile_key FROM work_attempts").get())
      .toEqual({ canonical_profile_key: key });
    expectReadOnlyRowProof(database);
  });

  test("recognizes a Devin coordinator without deriving a Devin Work route", () => {
    const database = rowProofDatabase();
    insertSession(database, "worker", "devin", "ultra", 2, DEVIN);
    insertWork(database, 2);
    insertRoute(database, "ultra", ASTRA_ULTRA);
    insertTask(database, "ultra", ASTRA_ULTRA);
    expectReadOnlyRowProof(database);
  });

  test("accepts equal Luna keys across the worker and Work contracts while live", () => {
    const database = rowProofDatabase();
    seedAttempt(database, "claimed", "low", LUNA);
    database.exec("UPDATE sessions SET preset_contract=2");
    expectReadOnlyRowProof(database);
  });

  for (const table of ROW_TABLES) {
    test.each([null, "", "foreign:private-key", SOL.toUpperCase(), FABLE, ASTRA])(
      `refuses populated ${table} key debt %s without mutations`, (key) => {
        const database = rowProofDatabase();
        seedRowsForProof(database, { [table]: key });
        expectReadOnlyRowProof(database, `CANONICAL_PROFILE_ROWS_${table.toUpperCase()}`);
      },
    );

    test(`does not overlook a later invalid ${table} row beside valid rows`, () => {
      const database = rowProofDatabase();
      seedRowsForProof(database);
      if (table === "sessions") insertSession(database, "later", "codex", "high", 1, null);
      else if (table === "work_routes") insertRoute(database, "low", null);
      else if (table === "work_tasks") database.exec(`
        INSERT INTO work_tasks(id,work_id,account_id,project_id,preset,fast,canonical_profile_key)
        VALUES ('later','work','account','project','high',0,NULL)
      `);
      else database.exec(`
        INSERT INTO work_attempts(id,work_id,task_id,worker_session_id,account_id,project_id,preset,fast,state,canonical_profile_key)
        VALUES ('later','work','task','worker','account','project','high',0,'submitted',NULL)
      `);
      expect(database.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 2 });
      expectReadOnlyRowProof(database, `CANONICAL_PROFILE_ROWS_${table.toUpperCase()}`);
    });

    test(`does not inherit NOCASE collation for populated ${table} keys`, () => {
      const database = rowProofDatabase(
        UNIT_FIXTURE_SQL.replaceAll("TEXT", "TEXT COLLATE NOCASE"),
        LEGACY_CANONICAL_PROFILE_COLUMNS_SQL.replaceAll("TEXT", "TEXT COLLATE NOCASE"),
      );
      seedRowsForProof(database, { [table]: SOL.toUpperCase() });
      expectReadOnlyRowProof(database, `CANONICAL_PROFILE_ROWS_${table.toUpperCase()}`);
    });
  }

  test.each([["CODEX", "high"], ["codex", "HIGH"]] as const)(
    "does not inherit NOCASE collation for session alias %s/%s", (provider, preset) => {
      const database = rowProofDatabase(UNIT_FIXTURE_SQL.replaceAll("TEXT", "TEXT COLLATE NOCASE"));
      insertSession(database, "worker", provider, preset, 1, SOL);
      expectReadOnlyRowProof(database, "CANONICAL_PROFILE_ROWS_SESSIONS");
    },
  );

  test("does not inherit NOCASE collation for a Work route's own preset", () => {
    const database = rowProofDatabase(UNIT_FIXTURE_SQL.replaceAll("TEXT", "TEXT COLLATE NOCASE"));
    insertSession(database);
    insertWork(database);
    insertRoute(database, "HIGH", SOL);
    expectReadOnlyRowProof(database, "CANONICAL_PROFILE_ROWS_WORK_ROUTES");
  });

  test.each([
    ["work_routes", "work_id"],
    ["work_tasks", "work_id"], ["work_tasks", "account_id"],
    ["work_tasks", "project_id"], ["work_tasks", "preset"],
    ["work_attempts", "work_id"], ["work_attempts", "task_id"],
    ["work_attempts", "worker_session_id"], ["work_attempts", "account_id"],
    ["work_attempts", "project_id"], ["work_attempts", "preset"],
  ] as const)("does not inherit NOCASE parent equality for %s.%s", (table, column) => {
    const database = rowProofDatabase(UNIT_FIXTURE_SQL.replaceAll("TEXT", "TEXT COLLATE NOCASE"));
    seedRowsForProof(database);
    // A second row has an existing case-insensitive FK parent but no exact
    // identity parent. No disabled FK enforcement is needed for this damage.
    const columns = table === "work_routes"
      ? ["work_id", "account_id", "project_id", "preset", "fast", "canonical_profile_key"]
      : table === "work_tasks"
        ? ["id", "work_id", "account_id", "project_id", "preset", "fast", "canonical_profile_key"]
        : ["id", "work_id", "task_id", "worker_session_id", "account_id", "project_id", "preset", "fast", "state", "canonical_profile_key"];
    const values = columns.map((name) => name === "id" ? "'later'"
      : name === column ? `upper(${name})`
        : table === "work_routes" && name === "fast" ? "1" : name);
    database.exec(`INSERT INTO ${table}(${columns.join(",")}) SELECT ${values.join(",")} FROM ${table}`);
    expect(database.query("SELECT EXISTS (SELECT 1 FROM pragma_foreign_key_check) AS damaged").get())
      .toEqual({ damaged: 0 });
    expectReadOnlyRowProof(database, `CANONICAL_PROFILE_ROWS_${table.toUpperCase()}`);
  });

  test.each([
    ["codex", "high", 3, SOL], ["codex", "fable-max", 1, FABLE],
    ["codex", "astra", 2, DEVIN], ["claude", "low", 1, FABLE],
    ["claude", "fable-max", 1, FABLE], ["devin", "ultra", 1, DEVIN],
    ["devin", "high", 2, DEVIN], ["foreign", "ultra", 2, SOL],
  ] as const)("refuses a populated nonhistorical session %s/%s/%i", (provider, preset, contract, key) => {
    const database = rowProofDatabase();
    insertSession(database, "private-session", provider, preset, contract, key);
    expectReadOnlyRowProof(database, "CANONICAL_PROFILE_ROWS_SESSIONS");
  });

  test.each([["high", 3, SOL], ["astra", 2, DEVIN], ["fable-max", 1, FABLE]] as const)(
    "refuses a populated nonhistorical Work route %s/%i", (preset, contract, key) => {
      const database = rowProofDatabase();
      insertSession(database);
      insertWork(database, contract);
      insertRoute(database, preset, key);
      expectReadOnlyRowProof(database, "CANONICAL_PROFILE_ROWS_WORK_ROUTES");
    },
  );

  test.each([...LIVE_STATES])("refuses historical worker-key divergence for populated %s", (state) => {
    const database = rowProofDatabase();
    seedAttempt(database, state);
    database.query("UPDATE sessions SET preset_contract=2,canonical_profile_key=?").run(ASTRA);
    expectReadOnlyRowProof(database, "CANONICAL_PROFILE_ROWS_WORK_ATTEMPTS");
  });

  test.each([...NON_FENCED_STATES])("accepts populated %s history after a guarded worker reselection", (state) => {
    const database = rowProofDatabase();
    database.exec(LEGACY_CANONICAL_PROFILE_GUARDS_SQL);
    seedAttempt(database, state);
    database.query("UPDATE sessions SET preset_contract=2,canonical_profile_key=?").run(ASTRA);
    expect(() => assertLegacyCanonicalProfileStorageSchema(database)).not.toThrow();
    expectReadOnlyRowProof(database);
  });

  test.each([...LIVE_STATES])("accepts matching worker keys for populated %s", (state) => {
    const database = rowProofDatabase();
    seedAttempt(database, state);
    expectReadOnlyRowProof(database);
  });

  test.each(["CLAIMED", "foreign", ""])('refuses an unknown attempt state "%s" instead of treating it as settled', (state) => {
    const database = rowProofDatabase(UNIT_FIXTURE_SQL.replace("state TEXT NOT NULL,", "state TEXT COLLATE NOCASE NOT NULL,"));
    seedAttempt(database, state);
    database.query("UPDATE sessions SET preset_contract=2,canonical_profile_key=?").run(ASTRA);
    expectReadOnlyRowProof(database, "CANONICAL_PROFILE_ROWS_WORK_ATTEMPTS");
  });

  test.each([
    ["works", "WORK_ROUTES"], ["work_routes", "WORK_TASKS"],
    ["work_tasks", "WORK_ATTEMPTS"], ["sessions", "WORK_ATTEMPTS"],
  ] as const)("refuses orphaned populated rows after deleting %s", (parent, error) => {
    const database = rowProofDatabase();
    seedRowsForProof(database);
    // Deliberate preexisting damage only; the proof runs with FK enforcement on.
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec(`DELETE FROM ${parent}`);
    database.exec("PRAGMA foreign_keys=ON");
    expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.query("SELECT EXISTS (SELECT 1 FROM pragma_foreign_key_check) AS damaged").get())
      .toEqual({ damaged: 1 });
    expectReadOnlyRowProof(database, `CANONICAL_PROFILE_ROWS_${error}`);
  });

  test.each([...NON_FENCED_STATES])("requires an existing worker even for populated %s history", (state) => {
    const database = rowProofDatabase();
    seedAttempt(database, state);
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec("DELETE FROM sessions");
    database.exec("PRAGMA foreign_keys=ON");
    expectReadOnlyRowProof(database, "CANONICAL_PROFILE_ROWS_WORK_ATTEMPTS");
  });

  for (const table of ["work_tasks", "work_attempts"] as const) {
    test.each(["work_id", "account_id", "project_id", "preset", "fast"] as const)(
      `refuses populated ${table} same-key wrong-parent %s`, (column) => {
        const database = rowProofDatabase();
        insertSession(database);
        insertWork(database);
        insertWork(database, 1, "other-work");
        insertRoute(database);
        if (table === "work_attempts") insertTask(database);
        const tuple = ["work", "account", "project", "high", 0];
        const index = ["work_id", "account_id", "project_id", "preset", "fast"].indexOf(column);
        tuple[index] = column === "fast" ? 1 : column === "work_id" ? "other-work" : "other";
        database.exec("PRAGMA foreign_keys=OFF");
        if (table === "work_tasks") database.query(`
          INSERT INTO work_tasks(id,work_id,account_id,project_id,preset,fast,canonical_profile_key)
          VALUES ('task',?,?,?,?,?,?)
        `).run(...tuple, SOL);
        else database.query(`
          INSERT INTO work_attempts(id,task_id,worker_session_id,work_id,account_id,project_id,preset,fast,state,canonical_profile_key)
          VALUES ('attempt','task','worker',?,?,?,?,?,'submitted',?)
        `).run(...tuple, SOL);
        database.exec("PRAGMA foreign_keys=ON");
        expectReadOnlyRowProof(database, `CANONICAL_PROFILE_ROWS_${table.toUpperCase()}`);
      },
    );
  }
});
